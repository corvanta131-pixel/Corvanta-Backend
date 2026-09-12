const AppError = require("../../utils/AppError");
const Workflow = require("../../models/Workflow");
const WorkflowExecution = require("../../models/WorkflowExecution");
const AIAgent = require("../../models/AIAgent");
const User = require("../../models/User");
const Customer = require("../../models/Customer");
const Conversation = require("../../models/Conversation");
const mongoose = require("mongoose");
const {
  TRIGGER_TYPES,
  ACTION_TYPES,
  CONDITION_OPERATORS,
  PROTECTED_WORKFLOW_FIELDS,
  ALLOWED_CUSTOMER_UPDATE_FIELDS,
} = require("../../models/Workflow");
const { validateObjectId } = require("../../validators/commonValidator");
const { validateActionsArray } = require("./actions");
const { evaluateConditions } = require("./conditionEvaluator");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectProtectedFields(payload) {
  if (!isPlainObject(payload)) return;
  for (const field of PROTECTED_WORKFLOW_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      if (field === "companyId") {
        throw new AppError(400, "Company context is determined by the authenticated user and cannot be overridden.");
      }
      throw new AppError(400, `${field} cannot be modified by the client.`);
    }
  }
}

function validateTrigger(trigger) {
  if (!isPlainObject(trigger)) {
    throw new AppError(400, "Workflow trigger must be an object with 'type'.");
  }
  if (!TRIGGER_TYPES.includes(trigger.type)) {
    throw new AppError(400, `Invalid trigger type. Allowed values: ${TRIGGER_TYPES.join(", ")}`);
  }
  if (trigger.config !== undefined && !isPlainObject(trigger.config)) {
    throw new AppError(400, "Workflow trigger config must be an object.");
  }
  return { type: trigger.type, config: trigger.config || {} };
}

function validateConditionsInput(conditions) {
  if (conditions === undefined || conditions === null) return [];
  if (!Array.isArray(conditions)) {
    throw new AppError(400, "Workflow conditions must be an array.");
  }
  for (let i = 0; i < conditions.length; i += 1) {
    const condition = conditions[i];
    if (!isPlainObject(condition)) {
      throw new AppError(400, `Condition at index ${i} must be an object.`);
    }
    if (!condition.field || typeof condition.field !== "string") {
      throw new AppError(400, `Condition at index ${i} must have a 'field' string.`);
    }
    if (!CONDITION_OPERATORS.includes(condition.operator)) {
      throw new AppError(400, `Condition at index ${i} has unsupported operator. Allowed: ${CONDITION_OPERATORS.join(", ")}`);
    }
  }
  return conditions;
}

function validatePriority(priority) {
  if (priority === undefined || priority === null) return 100;
  if (typeof priority !== "number" || !Number.isFinite(priority) || priority < 0 || priority > 10000) {
    throw new AppError(400, "Workflow priority must be a number between 0 and 10000.");
  }
  return Math.floor(priority);
}

function validateStatus(status) {
  const allowed = ["draft", "active", "inactive"];
  if (status === undefined || status === null) return undefined;
  if (!allowed.includes(status)) {
    throw new AppError(400, `Invalid workflow status. Allowed: ${allowed.join(", ")}`);
  }
  return status;
}

async function listWorkflows(companyId, filters = {}) {
  if (!companyId) {
    throw new AppError(403, "Missing company context.");
  }
  const query = { companyId, isDeleted: false };
  if (filters.status) query.status = filters.status;
  if (filters.triggerType) {
    if (!TRIGGER_TYPES.includes(filters.triggerType)) {
      throw new AppError(400, "Invalid triggerType filter.");
    }
    query["trigger.type"] = filters.triggerType;
  }
  return Workflow.find(query).sort({ priority: -1, createdAt: -1 }).lean();
}

async function getWorkflowById(companyId, workflowId) {
  if (!companyId) {
    throw new AppError(403, "Missing company context.");
  }
  validateObjectId(workflowId, "workflowId");
  const workflow = await Workflow.findOne({ _id: workflowId, companyId, isDeleted: false });
  if (!workflow) {
    throw new AppError(404, "Workflow not found.");
  }
  return workflow;
}

async function validateCrossTenantReferences(actions, companyId) {
  if (!actions || !Array.isArray(actions)) return;
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    
    // Validate agent references
    if (action.type === "assign.conversation.agent") {
      const params = action.params || {};
      const agentId = params.agentId || params.value;
      if (agentId) {
        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(agentId)) {
          throw new AppError(400, `Invalid agent ID format`);
        }
        // Validate agent exists and belongs to company
        const agent = await AIAgent.findOne({ _id: agentId, companyId, isDeleted: false }).select("_id").lean();
        if (!agent) {
          throw new AppError(403, `Target AI agent not found in this company`);
        }
      }
    }
    
    // Validate employee references
    if (action.type === "assign.conversation.employee") {
      const params = action.params || {};
      const employeeId = params.employeeId || params.userId;
      if (employeeId) {
        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(employeeId)) {
          throw new AppError(400, `Invalid employee ID format`);
        }
        // Validate employee exists and belongs to company
        const employee = await User.findOne({ _id: employeeId, companyId, isDeleted: false, status: "active" }).select("_id").lean();
        if (!employee) {
          throw new AppError(403, `Target employee not found in this company`);
        }
      }
    }
    
    // Validate customer references
    if (action.type === "update.customer.info") {
      const params = action.params || {};
      const customerId = params.customerId;
      if (customerId) {
        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(customerId)) {
          throw new AppError(400, `Invalid customer ID format`);
        }
        // Validate customer exists and belongs to company
        const customer = await Customer.findOne({ _id: customerId, companyId, isDeleted: false }).select("_id").lean();
        if (!customer) {
          throw new AppError(404, `Customer not found in this company`);
        }
      }
    }
    
    // Check for cross-tenant references in metadata/data
    if (action.type === "update.conversation.metadata" || action.type === "update.customer.info") {
      const params = action.params || {};
      if (params.data && typeof params.data === "object") {
        // Check for cross-tenant references in metadata/data
        const keys = Object.keys(params.data || {});
        for (const key of keys) {
          if (key.includes("companyId") || key.includes("company")) {
            throw new AppError(400, `Cannot reference company fields in workflow action parameters.`);
          }
        }
      }
    }
    
    // Validate conversation references in metadata/data for relevant actions
    if (action.type === "update.conversation.metadata") {
      const params = action.params || {};
      if (params.data && typeof params.data === "object") {
        const conversationId = params.data.conversationId || params.data.conversation;
        if (conversationId) {
          // Validate ObjectId format
          if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            throw new AppError(400, `Invalid conversation ID format`);
          }
          // Validate conversation exists and belongs to company
          const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false }).select("_id").lean();
          if (!conversation) {
            throw new AppError(404, `Conversation not found in this company`);
          }
        }
      }
    }
  }
}

async function createWorkflow(companyId, payload, actor) {
  if (!companyId) {
    throw new AppError(403, "Missing company context.");
  }
  rejectProtectedFields(payload);

  if (!payload.name || typeof payload.name !== "string" || payload.name.trim().length < 2) {
    throw new AppError(400, "Workflow name is required and must be at least 2 characters.");
  }

  await validateCrossTenantReferences(payload.actions, companyId);

  const trigger = validateTrigger(payload.trigger);
  const conditions = validateConditionsInput(payload.conditions);
  const actions = validateActionsArray(payload.actions);
  const priority = validatePriority(payload.priority);
  const status = validateStatus(payload.status);

  const workflow = await Workflow.create({
    companyId,
    name: payload.name.trim(),
    description: typeof payload.description === "string" ? payload.description.slice(0, 2000) : "",
    status: status || "draft",
    trigger,
    priority,
    conditions,
    actions,
    createdBy: actor && actor._id ? actor._id : null,
    updatedBy: actor && actor._id ? actor._id : null,
    isDeleted: false,
    deletedAt: null,
  });
  return workflow;
}

async function updateWorkflow(companyId, workflowId, payload, actor) {
  const workflow = await getWorkflowById(companyId, workflowId);
  rejectProtectedFields(payload);

  if (payload.name !== undefined) {
    if (typeof payload.name !== "string" || payload.name.trim().length < 2) {
      throw new AppError(400, "Workflow name must be at least 2 characters.");
    }
    workflow.name = payload.name.trim();
  }
  if (payload.description !== undefined) {
    workflow.description = String(payload.description || "").slice(0, 2000);
  }
  if (payload.trigger !== undefined) {
    workflow.trigger = validateTrigger(payload.trigger);
  }
  if (payload.conditions !== undefined) {
    workflow.conditions = validateConditionsInput(payload.conditions);
  }
  if (payload.actions !== undefined) {
    await validateCrossTenantReferences(payload.actions, companyId);
    workflow.actions = validateActionsArray(payload.actions);
  }
  if (payload.priority !== undefined) {
    workflow.priority = validatePriority(payload.priority);
  }
  if (payload.status !== undefined) {
    const status = validateStatus(payload.status);
    if (status) workflow.status = status;
  }
  workflow.updatedBy = actor && actor._id ? actor._id : null;
  await workflow.save();
  return workflow;
}

async function setWorkflowStatus(companyId, workflowId, status, actor) {
  const workflow = await getWorkflowById(companyId, workflowId);
  const validated = validateStatus(status);
  if (!validated) {
    throw new AppError(400, "Workflow status is required.");
  }
  workflow.status = validated;
  workflow.updatedBy = actor && actor._id ? actor._id : null;
  await workflow.save();
  return workflow;
}

async function deleteWorkflow(companyId, workflowId, actor) {
  const workflow = await getWorkflowById(companyId, workflowId);
  workflow.isDeleted = true;
  workflow.deletedAt = new Date();
  workflow.status = "inactive";
  workflow.updatedBy = actor && actor._id ? actor._id : null;
  await workflow.save();
  return workflow;
}

async function previewWorkflow({ companyId, workflowId, eventContext }) {
  const workflow = await getWorkflowById(companyId, workflowId);

  const contextPayload = {
    event: {
      type: workflow.trigger.type,
      companyId: String(companyId),
      occurredAt: new Date().toISOString(),
    },
    ...(eventContext || {}),
  };

  const conditionEvaluation = evaluateConditions(workflow.conditions || [], contextPayload);
  const actions = [];

  for (const action of workflow.actions || []) {
    actions.push({
      actionType: action.type,
      params: action.params || {},
      wouldExecute: conditionEvaluation.passed,
    });
  }

  return {
    workflowId: String(workflow._id),
    triggerMatched: true,
    conditionsPassed: conditionEvaluation.passed,
    conditionResults: conditionEvaluation.results,
    actions,
    contextProvided: eventContext || {},
  };
}

async function listExecutions(companyId, filters = {}) {
  if (!companyId) {
    throw new AppError(403, "Missing company context.");
  }
  const query = { companyId };
  if (filters.workflowId) {
    validateObjectId(filters.workflowId, "workflowId");
    query.workflowId = filters.workflowId;
  }
  if (filters.status) query.status = filters.status;
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  return WorkflowExecution.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

module.exports = {
  listWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  setWorkflowStatus,
  deleteWorkflow,
  previewWorkflow,
  listExecutions,
  rejectProtectedFields,
  validateTrigger,
  validateConditionsInput,
  validateActionsArray,
  validatePriority,
  validateStatus,
  ALLOWED_CUSTOMER_UPDATE_FIELDS,
  TRIGGER_TYPES,
  ACTION_TYPES,
  CONDITION_OPERATORS,
};
