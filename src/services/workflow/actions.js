const AppError = require("../../utils/AppError");
const Conversation = require("../../models/Conversation");
const Customer = require("../../models/Customer");
const User = require("../../models/User");
const AIAgent = require("../../models/AIAgent");
const { ALLOWED_CUSTOMER_UPDATE_FIELDS } = require("../../models/Workflow");
const { validateObjectId } = require("../../validators/commonValidator");
const { logAudit } = require("../auditService");
const { sendOutboundMessage } = require("../outboundPipeline");

const VALIDATION_ALLOWED_VALUE_FIELDS = new Set([
  "status",
  "value",
  "agentId",
  "employeeId",
  "userId",
  "customerId",
  "conversationId",
  "title",
  "notes",
  "phone",
  "email",
  "name",
  "key",
  "data",
  "metadata",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeMetadataValue(value) {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.every(isSafeMetadataValue);
  }
  if (isPlainObject(value)) {
    return Object.keys(value).every((key) => {
      if (typeof key !== "string" || key.startsWith("__") || key === "constructor" || key === "prototype") {
        return false;
      }
      return isSafeMetadataValue(value[key]);
    });
  }
  return false;
}

function validateParamsShape(params, allowedKeys) {
  if (params === undefined || params === null) {
    return {};
  }
  if (!isPlainObject(params)) {
    throw new AppError(400, "Action params must be an object.");
  }

  for (const key of Object.keys(params)) {
    if (key.startsWith("__") || key === "constructor" || key === "prototype") {
      throw new AppError(400, `Action params contain forbidden key: ${key}`);
    }
    if (allowedKeys && !allowedKeys.includes(key) && !VALIDATION_ALLOWED_VALUE_FIELDS.has(key)) {
      throw new AppError(400, `Action parameter '${key}' is not allowed for this action type.`);
    }
  }

  return params;
}

async function assignConversationEmployee({ companyId, params, context }) {
  const safeParams = validateParamsShape(params, ["employeeId", "userId"]);
  const employeeId = safeParams.employeeId || safeParams.userId;
  if (!employeeId) {
    throw new AppError(400, "assign.conversation.employee requires 'employeeId' parameter.");
  }
  validateObjectId(employeeId, "employeeId");

  const employee = await User.findOne({ _id: employeeId, companyId, isDeleted: false, status: "active" }).select("_id").lean();
  if (!employee) {
    throw new AppError(403, "Target employee not found in this company.");
  }

  const conversationId = context.conversation?._id || context.conversation?.id;
  if (!conversationId) {
    throw new AppError(400, "Conversation context required for assignment.");
  }
  validateObjectId(conversationId, "conversationId");

  const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false });
  if (!conversation) {
    throw new AppError(404, "Conversation not found for assignment.");
  }

  const participantIds = (conversation.participantIds || []).map(String);
  if (!participantIds.includes(String(employee._id))) {
    participantIds.push(String(employee._id));
  }
  conversation.participantIds = participantIds;
  await conversation.save();

  return { conversationId: String(conversation._id), assignedEmployeeId: String(employee._id) };
}

async function assignConversationAgent({ companyId, params, context }) {
  const safeParams = validateParamsShape(params, ["agentId", "value"]);
  const agentId = safeParams.agentId || safeParams.value;
  if (!agentId) {
    throw new AppError(400, "assign.conversation.agent requires 'agentId' parameter.");
  }
  validateObjectId(agentId, "agentId");

  const agent = await AIAgent.findOne({ _id: agentId, companyId, isDeleted: false }).select("_id").lean();
  if (!agent) {
    throw new AppError(403, "Target AI agent not found in this company.");
  }

  const conversationId = context.conversation?._id || context.conversation?.id;
  if (!conversationId) {
    throw new AppError(400, "Conversation context required for assignment.");
  }
  validateObjectId(conversationId, "conversationId");

  const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false });
  if (!conversation) {
    throw new AppError(404, "Conversation not found for assignment.");
  }
  conversation.agentId = agent._id;
  await conversation.save();

  return { conversationId: String(conversation._id), assignedAgentId: String(agent._id) };
}

async function updateConversationStatus({ companyId, params, context }) {
  const safeParams = validateParamsShape(params, ["status", "value"]);
  const status = safeParams.status || safeParams.value;
  const allowedStatuses = ["open", "waiting", "resolved", "archived"];
  if (!status || !allowedStatuses.includes(status)) {
    throw new AppError(400, `update.conversation.status requires a valid 'status' value (one of: ${allowedStatuses.join(", ")}).`);
  }

  const conversationId = context.conversation?._id || context.conversation?.id;
  if (!conversationId) {
    throw new AppError(400, "Conversation context required for status update.");
  }
  validateObjectId(conversationId, "conversationId");

  const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false });
  if (!conversation) {
    throw new AppError(404, "Conversation not found for status update.");
  }
  conversation.status = status;
  await conversation.save();

  return { conversationId: String(conversation._id), newStatus: status };
}

async function updateConversationMetadata({ companyId, params, context }) {
  const safeParams = validateParamsShape(params, ["key", "value", "data", "merge"]);
  const conversationId = context.conversation?._id || context.conversation?.id;
  if (!conversationId) {
    throw new AppError(400, "Conversation context required for metadata update.");
  }
  validateObjectId(conversationId, "conversationId");

  const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false });
  if (!conversation) {
    throw new AppError(404, "Conversation not found for metadata update.");
  }

  const metadata = isPlainObject(conversation.metadata) ? { ...conversation.metadata } : {};

  if (safeParams.data && isPlainObject(safeParams.data)) {
    if (!isSafeMetadataValue(safeParams.data)) {
      throw new AppError(400, "metadata 'data' contains unsafe values.");
    }
    Object.assign(metadata, safeParams.data);
  } else if (safeParams.key) {
    if (!isSafeMetadataValue(safeParams.value)) {
      throw new AppError(400, "metadata 'value' contains unsafe values.");
    }
    metadata[String(safeParams.key)] = safeParams.value;
  } else {
    throw new AppError(400, "update.conversation.metadata requires 'key'/'value' or 'data' parameter.");
  }

  conversation.metadata = metadata;
  await conversation.save();

  return { conversationId: String(conversation._id), metadata: conversation.metadata };
}

async function updateCustomerInfo({ companyId, params, context }) {
  const safeParams = validateParamsShape(params, ["customerId", "data", "name", "email", "phone", "notes", "status", "value"]);
  const customerId = safeParams.customerId || context.customer?._id || context.customer?.id;

  if (!customerId) {
    throw new AppError(400, "Customer context or 'customerId' parameter is required for customer update.");
  }
  validateObjectId(String(customerId), "customerId");

  const customer = await Customer.findOne({ _id: customerId, companyId, isDeleted: false });
  if (!customer) {
    throw new AppError(404, "Customer not found in this company.");
  }

  const updateData = isPlainObject(safeParams.data) ? safeParams.data : safeParams;
  for (const key of Object.keys(updateData)) {
    if (!ALLOWED_CUSTOMER_UPDATE_FIELDS.includes(key)) {
      throw new AppError(400, `Customer field '${key}' cannot be modified by workflows.`);
    }
  }

  for (const key of ALLOWED_CUSTOMER_UPDATE_FIELDS) {
    if (updateData[key] !== undefined) {
      if (key === "metadata" && !isSafeMetadataValue(updateData[key])) {
        throw new AppError(400, "Customer metadata contains unsafe values.");
      }
      customer[key] = updateData[key];
    }
  }

  await customer.save();
  return { customerId: String(customer._id), updatedFields: Object.keys(updateData).filter((k) => ALLOWED_CUSTOMER_UPDATE_FIELDS.includes(k)) };
}

async function createAuditEventAction({ companyId, params, context }) {
  const safeParams = validateParamsShape(params, ["action", "entityType", "entityId", "metadata"]);

  const action = safeParams.action;
  if (!action || typeof action !== "string") {
    throw new AppError(400, "create.audit.event requires an 'action' parameter.");
  }

  if (action.length > 200) {
    throw new AppError(400, "Audit action name exceeds maximum length.");
  }

  const entityType = safeParams.entityType || "Workflow";
  const entityId = safeParams.entityId || (context.conversation?._id || context.conversation?.id) || (context.message?._id || context.message?.id) || (context.customer?._id || context.customer?.id) || "";

  const auditMetadata = isPlainObject(safeParams.metadata) ? safeParams.metadata : {};
  if (!isSafeMetadataValue(auditMetadata)) {
    throw new AppError(400, "Audit metadata contains unsafe values.");
  }

  const entry = await logAudit({
    user: null,
    companyId,
    action,
    entityType,
    entityId: String(entityId),
    metadata: auditMetadata,
  });

  return { auditId: entry ? String(entry._id) : null, action };
}

async function sendMessageAction({ companyId, params, context }) {
  const safeParams = validateParamsShape(params, [
    "conversationId",
    "body",
    "channelType",
    "senderType",
    "senderId",
    "senderIdentity",
    "attachments",
    "externalMessageId",
    "metadata",
    "simulateFailure",
  ]);

  const conversationId = safeParams.conversationId || context.conversation?._id || context.conversation?.id;
  if (!conversationId) {
    throw new AppError(400, "send.message requires 'conversationId' parameter or conversation context.");
  }
  validateObjectId(conversationId, "conversationId");

  const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false });
  if (!conversation) {
    throw new AppError(404, "Conversation not found for outbound message.");
  }

  const body = safeParams.body || context.message?.body;
  if (!body || typeof body !== "string" || !body.trim()) {
    throw new AppError(400, "send.message requires a non-empty 'body' parameter.");
  }

  const channelType = safeParams.channelType || conversation.channelType || "webchat";
  if (conversation.channelType && conversation.channelType !== channelType) {
    throw new AppError(400, "Channel type does not match conversation channel type.");
  }

  const result = await sendOutboundMessage(
    {
      conversationId: String(conversation._id),
      body,
      channelType,
      customerId: safeParams.customerId || conversation.customerId || null,
      senderType: safeParams.senderType || "agent",
      senderId: safeParams.senderId || null,
      senderIdentity: safeParams.senderIdentity || "",
      attachments: safeParams.attachments || [],
      externalMessageId: safeParams.externalMessageId || null,
      metadata: isPlainObject(safeParams.metadata) ? safeParams.metadata : {},
    },
    { simulateFailure: safeParams.simulateFailure || false },
    { companyId, user: null }
  );

  return {
    messageId: String(result.message._id),
    deliveryStatus: result.message.deliveryStatus,
    externalMessageId: result.message.externalMessageId,
    adapterSuccess: result.adapterResult?.success || false,
  };
}

const ACTION_HANDLERS = {
  "assign.conversation.employee": assignConversationEmployee,
  "assign.conversation.agent": assignConversationAgent,
  "update.conversation.status": updateConversationStatus,
  "update.conversation.metadata": updateConversationMetadata,
  "update.customer.info": updateCustomerInfo,
  "create.audit.event": createAuditEventAction,
  "send.message": sendMessageAction,
};

const MAX_ACTIONS_PER_WORKFLOW = 20;

function validateActionsArray(actions) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) {
    throw new AppError(400, "Workflow actions must be an array.");
  }
  if (actions.length > MAX_ACTIONS_PER_WORKFLOW) {
    throw new AppError(400, `A workflow may have at most ${MAX_ACTIONS_PER_WORKFLOW} actions.`);
  }
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (!isPlainObject(action)) {
      throw new AppError(400, `Action at index ${i} must be an object.`);
    }
    if (!action.type || typeof action.type !== "string" || !ACTION_HANDLERS[action.type]) {
      throw new AppError(400, `Action at index ${i} has unsupported type: ${action.type}`);
    }
    if (action.params !== undefined && !isPlainObject(action.params)) {
      throw new AppError(400, `Action at index ${i} params must be an object.`);
    }
    if (action.params && typeof action.params === "object") {
      const paramKeys = Object.getOwnPropertyNames(action.params);
      for (const key of paramKeys) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new AppError(400, `Action at index ${i} params contain forbidden key: ${key}`);
        }
      }
    }
  }
  return actions;
}

async function executeAction({ companyId, action, context }) {
  if (!companyId) {
    throw new AppError(403, "Company context is required for action execution.");
  }
  if (!action || !action.type) {
    throw new AppError(400, "Action must include a type.");
  }
  const handler = ACTION_HANDLERS[action.type];
  if (!handler) {
    throw new AppError(400, `Unsupported action type: ${action.type}`);
  }

  const result = await handler({
    companyId,
    params: action.params || {},
    context: context || {},
  });

  return result;
}

module.exports = {
  executeAction,
  validateActionsArray,
  ACTION_HANDLERS,
  MAX_ACTIONS_PER_WORKFLOW,
};
