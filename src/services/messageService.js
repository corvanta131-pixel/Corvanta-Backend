const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const config = require("../config/config");

async function getOwnedConversation(companyId, conversationId) {
  validateObjectId(conversationId, "conversationId");
  const conversation = await Conversation.findOne({ _id: conversationId, companyId, isDeleted: false });
  if (!conversation) throw new AppError(404, "Conversation not found.");
  return conversation;
}

const ALLOWED_USAGE_KEYS = ["promptTokens", "completionTokens", "totalTokens", "inputTokens", "outputTokens"];
const FORBIDDEN_METADATA_KEYS = ["apiKey", "authorization", "api_key", "secret", "password", "token", "credential", "credentials"];

function sanitizeUsage(usage) {
  if (!usage || typeof usage !== "object") return usage;
  const out = {};
  for (const key of ALLOWED_USAGE_KEYS) {
    if (usage[key] !== undefined) out[key] = Number(usage[key]);
  }
  return Object.keys(out).length ? out : undefined;
}

function publicMessage(message) {
  const value = message.toObject ? message.toObject() : { ...message };
  const metadata = value.metadata || {};
  for (const key of FORBIDDEN_METADATA_KEYS) delete metadata[key];
  const safeMetadata = {
    usage: sanitizeUsage(metadata.usage),
    provider: metadata.provider,
    model: metadata.model,
    latencyMs: metadata.latencyMs,
    finishReason: metadata.finishReason,
    retrievalMode: metadata.retrievalMode,
    sourceCount: metadata.sourceCount,
  };
  Object.keys(safeMetadata).forEach((key) => safeMetadata[key] === undefined && delete safeMetadata[key]);
  return {
    _id: value._id,
    companyId: value.companyId,
    conversationId: value.conversationId,
    senderType: value.senderType,
    senderId: value.senderId,
    body: value.body,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    metadata: safeMetadata,
  };
}

async function createMessage(companyId, conversationId, payload = {}, actor = {}) {
  const conversation = await getOwnedConversation(companyId, conversationId);
  const senderType = payload.senderType || "user";
  if (!["user", "customer"].includes(senderType)) {
    throw new AppError(400, "Only user or customer messages can be submitted.");
  }

  let senderId;
  if (senderType === "user") {
    if (!actor._id || String(actor.companyId) !== String(companyId)) throw new AppError(403, "Authenticated user is not a member of this company.");
    senderId = actor._id;
  } else {
    if (!conversation.customerId) throw new AppError(400, "This conversation has no customer participant.");
    const customer = await Customer.findOne({ _id: conversation.customerId, companyId, isDeleted: false }).select("_id").lean();
    if (!customer) throw new AppError(403, "Conversation customer is unavailable.");
    senderId = customer._id;
  }

  const message = await Message.create({
    companyId,
    conversationId: conversation._id,
    senderType,
    senderId,
    body: String(payload.body).trim(),
    metadata: {},
    isDeleted: false,
    deletedAt: null,
  });
  conversation.lastMessageAt = message.createdAt || new Date();
  await conversation.save();
  return message;
}

async function listMessages(companyId, conversationId, options = {}) {
  const conversation = await getOwnedConversation(companyId, conversationId);
  const limit = Math.max(1, Math.min(Number(options.limit) || config.AI_MESSAGE_LIST_LIMIT, 100));
  const messages = await Message.find({ companyId, conversationId: conversation._id, isDeleted: false })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return messages.reverse().map(publicMessage);
}

async function getMessage(companyId, conversationId, messageId) {
  const conversation = await getOwnedConversation(companyId, conversationId);
  validateObjectId(messageId, "messageId");
  const message = await Message.findOne({ _id: messageId, companyId, conversationId: conversation._id, isDeleted: false }).lean();
  if (!message) throw new AppError(404, "Message not found.");
  return publicMessage(message);
}

module.exports = {
  createMessage,
  listMessages,
  getMessage,
  getMessageById: getMessage,
  getOwnedConversation,
  publicMessage,
};
