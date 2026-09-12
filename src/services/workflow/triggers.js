const AppError = require("../../utils/AppError");
const Workflow = require("../../models/Workflow");
const { TRIGGER_TYPES } = require("../../models/Workflow");

const VALID_EVENT_TYPES = new Set(TRIGGER_TYPES);

function assertValidEventType(eventType) {
  if (typeof eventType !== "string" || !VALID_EVENT_TYPES.has(eventType)) {
    throw new AppError(400, `Unsupported workflow event type: ${eventType}`);
  }
}

function matchesTrigger(workflow, eventType) {
  if (!workflow || !workflow.trigger) return false;
  return workflow.trigger.type === eventType;
}

async function findMatchingWorkflows(companyId, eventType, options = {}) {
  assertValidEventType(eventType);

  if (!companyId) {
    throw new AppError(403, "Company context is required to evaluate workflow triggers.");
  }

  const query = {
    companyId,
    isDeleted: false,
    status: "active",
    "trigger.type": eventType,
  };

  if (options.workflowId) {
    query._id = options.workflowId;
  }

  const workflows = await Workflow.find(query)
    .sort({ priority: -1, createdAt: 1 })
    .lean();

  return workflows;
}

module.exports = {
  assertValidEventType,
  matchesTrigger,
  findMatchingWorkflows,
  VALID_EVENT_TYPES: Array.from(VALID_EVENT_TYPES),
};
