const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Customer = require("../models/Customer");
const Channel = require("../models/Channel");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const { sendMessage } = require("./channelAdapter");
const { logAudit } = require("./auditService");
const { checkIdempotency, storeIdempotency } = require("./idempotencyService");
const { sanitizeChannelResponse } = require("../controllers/channelController");

function buildSafeMetadata(metadata = {}) {
  const safe = { ...metadata };
  delete safe.user;
  delete safe.secret;
  delete safe.password;
  delete safe.token;
  delete safe.apiToken;
  delete safe.webhookSecret;
  delete safe.accessToken;
  delete safe.refreshToken;
  delete safe.clientSecret;
  delete safe.privateKey;
  delete safe.authorization;
  delete safe.credentials;
  return safe;
}

async function sendOutboundMessage(payload = {}, options = {}, context = {}) {
  const companyId = context.companyId || payload.companyId;
  if (!companyId) {
    throw new AppError(403, "Company context is required.");
  }

  const body = String(payload.body || payload.text || "").trim();
  if (!body) {
    throw new AppError(400, "Outbound message body is required.");
  }

  const conversationId = payload.conversationId || context.conversationId;
  if (!conversationId) {
    throw new AppError(400, "conversationId is required.");
  }
  validateObjectId(conversationId, "conversationId");

  const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false });
  if (!conversation) {
    throw new AppError(404, "Conversation not found.");
  }

  const channelType = String(payload.channelType || conversation.channelType || "webchat").toLowerCase();
  if (conversation.channelType && conversation.channelType !== channelType) {
    throw new AppError(400, "Channel type does not match conversation channel type.");
  }

  const channel = await Channel.findOne({ companyId, type: channelType, isDeleted: false, status: "active" }).lean();
  if (!channel) {
    throw new AppError(404, `No active channel found for type: ${channelType}`);
  }

  let customer = null;
  const providedCustomerId = payload.customerId || context.customerId;
  if (providedCustomerId) {
    validateObjectId(providedCustomerId, "customerId");
    customer = await Customer.findOne({ _id: providedCustomerId, companyId, isDeleted: false }).lean();
    if (!customer) {
      throw new AppError(403, "Provided customer not found or unavailable.");
    }
    if (conversation.customerId && String(conversation.customerId) !== String(customer._id)) {
      throw new AppError(403, "Customer does not match conversation.");
    }
  } else if (conversation.customerId) {
    const conversationCustomer = await Customer.findOne({ _id: conversation.customerId, companyId, isDeleted: false }).lean();
    if (!conversationCustomer) {
      throw new AppError(403, "Conversation references a customer outside this company.");
    }
    customer = conversationCustomer;
  }

  const externalMessageId = payload.externalMessageId || null;
  if (externalMessageId) {
    const existing = await checkIdempotency(companyId, channelType, externalMessageId);
    if (existing) {
      const existingMessage = await Message.findOne({ companyId, channelType, externalMessageId, isDeleted: false }).lean();
      if (existingMessage) {
        return {
          message: existingMessage,
          conversation,
          adapterResult: existing.result || { duplicate: true },
          duplicate: true,
        };
      }
    }
  }

  const adapterOptions = {
    simulateFailure: options.simulateFailure || payload.simulateFailure || false,
  };

  const adapterResult = await sendMessage({
    channel,
    conversation,
    message: { body },
    customer,
    options: adapterOptions,
  });

  const messageExternalMessageId = externalMessageId || adapterResult.externalMessageId || `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const deliveryStatus = adapterResult.success ? "sent" : "failed";
  const deliveredAt = adapterResult.success ? new Date() : null;

  const message = await Message.create({
    companyId,
    conversationId: conversation._id,
    customerId: customer ? customer._id : (conversation.customerId || null),
    channelType,
    channelId: channel._id,
    direction: "outbound",
    senderType: payload.senderType || "agent",
    senderId: payload.senderId || null,
    senderIdentity: payload.senderIdentity || "",
    body,
    externalMessageId: messageExternalMessageId,
    externalConversationId: conversation.externalConversationId,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    deliveryStatus,
    deliveryError: adapterResult.error || null,
    deliveredAt,
    metadata: buildSafeMetadata(payload.metadata || {}),
    isDeleted: false,
    deletedAt: null,
  });

  if (messageExternalMessageId) {
    await storeIdempotency(companyId, channelType, messageExternalMessageId, { executed: true, messageId: String(message._id), adapterResult });
  }

  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  await logAudit({
    user: context.user || null,
    companyId,
    action: "channel.outbound.sent",
    entityType: "Message",
    entityId: String(message._id),
    metadata: {
      channelType,
      conversationId: String(conversation._id),
      deliveryStatus,
      adapter: channel.type,
    },
  });

  return {
    message,
    conversation,
    adapterResult: {
      ...adapterResult,
      channel: { type: channel.type, name: channel.name },
    },
    duplicate: false,
  };
}

module.exports = { sendOutboundMessage, buildSafeMetadata };
