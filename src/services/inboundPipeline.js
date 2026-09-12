const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Customer = require("../models/Customer");
const CustomerIdentity = require("../models/CustomerIdentity");
const Channel = require("../models/Channel");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const { sendConversationMessage } = require("./aiConversationService");
const { resolveCustomerFromIdentity } = require("./customerIdentityService");
const { normalizeInboundMessage } = require("./channelAdapter");
const config = require("../config/config");
const { runEventWorkflows } = require("./workflow/engine");
const { storeIdempotency } = require("./idempotencyService");
const logger = require("../utils/logger");

async function resolveOrCreateConversation({ companyId, channelType, channelId, externalConversationId, customerId, agentId, handlingMode, metadata = {} }) {
  if (externalConversationId) {
    const existing = await Conversation.findOne({
      companyId,
      channelType,
      externalConversationId,
      isDeleted: false,
    }).lean();
    if (existing) return existing;
  }

  const conversation = await Conversation.create({
    companyId,
    customerId: customerId || null,
    agentId: agentId || null,
    participantIds: [],
    channelType,
    channelId: channelId || null,
    externalConversationId: externalConversationId || null,
    handlingMode: handlingMode || "AI",
    title: metadata.title || "",
    status: "open",
    metadata,
    isDeleted: false,
    deletedAt: null,
  });

  return conversation;
}

async function checkIdempotency({ companyId, channelType, externalMessageId }) {
  if (!externalMessageId) return { duplicate: false };
  
  const existing = await Message.findOne({
    companyId,
    channelType,
    externalMessageId,
    isDeleted: false,
  }).lean();
  
  if (existing) {
    return { duplicate: true, message: existing };
  }
  
  return { duplicate: false };
}

async function processInboundMessage(payload, options = {}) {
  const normalized = normalizeInboundMessage(payload);
  
  const companyId = normalized.companyId;
  if (!companyId) throw new AppError(403, "Company context is required for inbound message processing.");

  const { channelType, externalMessageId, externalConversationId, senderIdentity, body, senderType, customerId: providedCustomerId, metadata } = normalized;

  const channel = await Channel.findOne({ companyId, type: channelType, isDeleted: false, status: "active" }).lean();
  if (!channel) throw new AppError(404, `No active channel found for type: ${channelType}`);

  const idempotency = await checkIdempotency({ companyId, channelType, externalMessageId });
  if (idempotency.duplicate) {
    return { duplicate: true, message: idempotency.message, conversation: null, customer: null };
  }

  let customer = null;
  if (providedCustomerId) {
    customer = await Customer.findOne({ _id: providedCustomerId, companyId, isDeleted: false }).lean();
    if (!customer) throw new AppError(403, "Provided customer not found or unavailable.");
  } else {
    customer = await resolveCustomerFromIdentity(companyId, channelType, senderIdentity);
    if (!customer) {
      throw new AppError(404, "Customer identity not found. Unable to resolve customer from external identifier.");
    }
  }

  let agentId = null;
  if (options.defaultAgentId) {
    validateObjectId(options.defaultAgentId, "agentId");
  }

  const isNewConversation = !!(!externalConversationId || !(await Conversation.findOne({ companyId, channelType, externalConversationId, isDeleted: false }).lean()));
  const conversation = await resolveOrCreateConversation({
    companyId,
    channelType,
    channelId: channel._id,
    externalConversationId,
    customerId: customer._id,
    agentId: options.defaultAgentId,
    handlingMode: options.handlingMode || "AI",
    metadata,
  });

  const message = await Message.create({
    companyId,
    conversationId: conversation._id,
    customerId: customer._id,
    channelType,
    channelId: channel._id,
    direction: "inbound",
    senderType,
    senderId: customer._id,
    senderIdentity,
    body,
    externalMessageId,
    externalConversationId,
    attachments: normalized.attachments,
    deliveryStatus: "delivered",
    deliveredAt: new Date(),
    metadata,
    isDeleted: false,
    deletedAt: null,
  });

  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  let aiResponse = null;
  if (conversation.handlingMode === "AI" && conversation.agentId) {
    try {
      aiResponse = await sendConversationMessage(
        companyId,
        conversation._id,
        { body, senderType: "customer" },
        { _id: customer._id, companyId, role: { slug: "customer" } },
        { useSemantic: false }
      );
    } catch (error) {
      logger.error("AI response generation failed:", error.message);
    }
  }

  let workflowResult = null;
  try {
    const eventContext = {
      message: { _id: String(message._id), body, direction: message.direction, senderType, senderIdentity, channelType },
      conversation: { _id: String(conversation._id), status: conversation.status, channelType, customerId: String(customer._id) },
      customer: { _id: String(customer._id), name: customer.name, status: customer.status },
      channel: { type: channelType, _id: String(channel._id) },
    };
    workflowResult = await runEventWorkflows({
      companyId,
      eventType: "message.received",
      eventContext,
      options: { idempotencyKey: externalMessageId ? `msg:${externalMessageId}` : `msg:${message._id}` },
    });
    if (workflowResult && !workflowResult.deduplicated) {
      await storeIdempotency(companyId, `workflow:message.received`, externalMessageId || `msg:${message._id}`, { executed: true, executions: workflowResult.executions });
    }
  } catch (error) {
    logger.error("Workflow execution for message.received failed:", error.message);
  }

  if (isNewConversation) {
    try {
      const convEventContext = {
        conversation: { _id: String(conversation._id), status: conversation.status, channelType, customerId: String(customer._id) },
        customer: { _id: String(customer._id), name: customer.name, status: customer.status },
        channel: { type: channelType, _id: String(channel._id) },
      };
      await runEventWorkflows({
        companyId,
        eventType: "conversation.created",
        eventContext: convEventContext,
        options: { idempotencyKey: `conv-created:${conversation._id}` },
      });
    } catch (error) {
      logger.error("Workflow execution for conversation.created failed:", error.message);
    }
  }

  return {
    duplicate: false,
    message,
    conversation,
    customer,
    aiResponse,
    workflowResult,
  };
}

module.exports = {
  processInboundMessage,
  resolveOrCreateConversation,
  checkIdempotency,
  resolveCustomerFromIdentity,
};