const AppError = require("../../utils/AppError");
const Workflow = require("../../models/Workflow");
const WorkflowExecution = require("../../models/WorkflowExecution");
const { findMatchingWorkflows, assertValidEventType } = require("./triggers");
const { evaluateConditions } = require("./conditionEvaluator");
const { executeAction } = require("./actions");
const { checkIdempotency } = require("../idempotencyService");

const MAX_TOTAL_ACTIONS_PER_EVENT = 50;
const MAX_EXECUTION_DEPTH = 5;
const EXECUTION_TIMEOUT_MS = 10000;

const activeExecutions = new Map();
const recentExecutionLog = new Map();

function makeEventId(eventType, context) {
  const conversationId = context.conversation?._id || context.conversation?.id;
  const messageId = context.message?._id || context.message?.id;
  const customerId = context.customer?._id || context.customer?.id;

  if (eventType === "message.received" && conversationId && messageId) {
    return `${eventType}:${conversationId}:${messageId}`;
  }
  if (eventType === "conversation.created" || eventType === "conversation.updated") {
    if (conversationId) return `${eventType}:${conversationId}:${Date.now()}`;
  }
  if (eventType === "customer.created" && customerId) {
    return `${eventType}:${customerId}`;
  }
  return `${eventType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function generateExecutionToken(workflowId, depth) {
  return `${workflowId}:${depth}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function isWorkflowAlreadyRunning(workflowId, eventId) {
  const key = `${workflowId}:${eventId}`;
  return activeExecutions.has(key);
}

function markExecutionStart(workflowId, eventId) {
  const key = `${workflowId}:${eventId}`;
  activeExecutions.set(key, Date.now());
  setTimeout(() => activeExecutions.delete(key), 60000).unref();
}

function clearExecution(workflowId, eventId) {
  const key = `${workflowId}:${eventId}`;
  activeExecutions.delete(key);
}

function checkRecursionBudget(workflowId) {
  const now = Date.now();
  const recent = recentExecutionLog.get(workflowId) || [];
  const withinWindow = recent.filter((timestamp) => now - timestamp < 1000);
  recentExecutionLog.set(workflowId, withinWindow);

  if (withinWindow.length >= MAX_EXECUTION_DEPTH) {
    throw new AppError(429, `Workflow recursion limit exceeded for workflow ${workflowId}.`);
  }
  withinWindow.push(now);
}

function buildContextPayload(workflow, eventType, eventContext) {
  return {
    event: {
      type: eventType,
      companyId: String(workflow.companyId),
      occurredAt: new Date().toISOString(),
    },
    ...(eventContext || {}),
  };
}

async function executeWorkflow({ workflow, eventType, eventContext, depth = 0, totalActionsRun = { count: 0 } }) {
  if (!workflow) {
    throw new AppError(400, "Workflow is required for execution.");
  }
  if (String(workflow.companyId) !== String(eventContext?.event?.companyId || workflow.companyId)) {
    throw new AppError(403, "Workflow company mismatch.");
  }

  const eventId = makeEventId(eventType, eventContext);

  if (isWorkflowAlreadyRunning(workflow._id, eventId)) {
    return { skipped: true, reason: "concurrent_execution" };
  }

  checkRecursionBudget(workflow._id);

  if (totalActionsRun.count >= MAX_TOTAL_ACTIONS_PER_EVENT) {
    return { skipped: true, reason: "action_budget_exceeded" };
  }

  markExecutionStart(workflow._id, eventId);
  const startedAt = Date.now();
  const execution = await WorkflowExecution.create({
    companyId: workflow.companyId,
    workflowId: workflow._id,
    eventId,
    eventType,
    status: "running",
    triggerMatch: true,
    conditionResults: [],
    actionsExecuted: [],
  });

  try {
    const context = buildContextPayload(workflow, eventType, eventContext);
    const conditionEvaluation = evaluateConditions(workflow.conditions || [], context);

    if (!conditionEvaluation.passed) {
      execution.conditionResults = conditionEvaluation.results;
      execution.status = "skipped";
      execution.result = { reason: "conditions_not_matched" };
      execution.executionTimeMs = Date.now() - startedAt;
      await execution.save();
      return { workflowId: String(workflow._id), status: "skipped", conditions: conditionEvaluation.results };
    }

    execution.conditionResults = conditionEvaluation.results;
    const actionsExecuted = [];
    let allSuccess = true;
    let lastResult = null;

    for (const action of workflow.actions || []) {
      if (totalActionsRun.count >= MAX_TOTAL_ACTIONS_PER_EVENT) {
        actionsExecuted.push({
          actionType: action.type,
          params: action.params,
          status: "failed",
          result: null,
          error: "Action budget exceeded",
        });
        allSuccess = false;
        break;
      }

      try {
        const result = await withTimeout(
          executeAction({
            companyId: workflow.companyId,
            action,
            context: { ...context, workflow },
          }),
          EXECUTION_TIMEOUT_MS,
          `Action ${action.type} timed out`
        );
        actionsExecuted.push({
          actionType: action.type,
          params: action.params,
          status: "success",
          result,
          error: null,
        });
        totalActionsRun.count += 1;
        lastResult = result;
      } catch (error) {
        actionsExecuted.push({
          actionType: action.type,
          params: action.params,
          status: "failed",
          result: null,
          error: error.message || String(error),
        });
        allSuccess = false;
        break;
      }
    }

    execution.actionsExecuted = actionsExecuted;
    execution.status = allSuccess ? "completed" : "failed";
    execution.result = lastResult;
    execution.executionTimeMs = Date.now() - startedAt;
    let failureError = null;
    if (!allSuccess) {
      const failed = actionsExecuted.find((a) => a.status === "failed");
      execution.error = failed ? failed.error : "One or more actions failed.";
      failureError = execution.error;
    }
    await execution.save();

    return {
      workflowId: String(workflow._id),
      status: execution.status,
      actionsExecuted: actionsExecuted.length,
      executionId: String(execution._id),
      error: failureError,
    };
  } catch (error) {
    execution.status = "failed";
    execution.error = error.message || String(error);
    execution.executionTimeMs = Date.now() - startedAt;
    await execution.save().catch(() => {});
    throw error;
  } finally {
    clearExecution(workflow._id, eventId);
  }
}

function withTimeout(promise, timeoutMs, errorMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage || "Operation timed out")), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function runEventWorkflows({ companyId, eventType, eventContext = {}, options = {} }) {
  assertValidEventType(eventType);

  if (!companyId) {
    throw new AppError(403, "Company context is required to run workflows.");
  }

  const idempotencyKey = options.idempotencyKey || makeEventId(eventType, eventContext);
  const existing = await checkIdempotency(companyId, `workflow:${eventType}`, idempotencyKey);
  if (existing && existing.result && existing.result.executed) {
    return { deduplicated: true, executions: existing.result.executions || [] };
  }

  const workflows = await findMatchingWorkflows(companyId, eventType);
  const totalActionsRun = { count: 0 };
  const executions = [];

  for (const workflow of workflows) {
    if (totalActionsRun.count >= MAX_TOTAL_ACTIONS_PER_EVENT) break;
    try {
      const result = await executeWorkflow({
        workflow,
        eventType,
        eventContext: { ...eventContext, event: { ...(eventContext.event || {}), type: eventType, companyId: String(companyId) } },
        totalActionsRun,
      });
      executions.push(result);
    } catch (error) {
      executions.push({
        workflowId: String(workflow._id),
        status: "failed",
        error: error.message || String(error),
      });
    }
  }

  return { deduplicated: false, executions };
}

function getEngineStats() {
  return {
    activeExecutions: activeExecutions.size,
    trackedWorkflows: recentExecutionLog.size,
  };
}

function resetEngineState() {
  activeExecutions.clear();
  recentExecutionLog.clear();
}

module.exports = {
  runEventWorkflows,
  executeWorkflow,
  makeEventId,
  getEngineStats,
  resetEngineState,
  MAX_TOTAL_ACTIONS_PER_EVENT,
  MAX_EXECUTION_DEPTH,
};
