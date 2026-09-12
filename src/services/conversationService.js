const Conversation = require("../models/Conversation");
const Customer = require("../models/Customer");
const AIAgent = require("../models/AIAgent");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const { runEventWorkflows } = require("./workflow/engine");
const logger = require("../utils/logger");

function getCompanyScope(companyId) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  return { companyId };
}

async function validateParticipants(companyId, participantIds) {
  if (participantIds === undefined) return;
  if (!Array.isArray(participantIds)) throw new AppError(400, "participantIds must be an array.");
  for (const participantId of participantIds) {
    validateObjectId(participantId, "participantId");
  }
  const count = await User.countDocuments({ _id: { $in: participantIds }, companyId, isDeleted: false });
  if (count !== participantIds.length) throw new AppError(403, "One or more participants do not belong to your company.");
}

async function listConversations(companyId, filters = {}) {
  const query = { ...getCompanyScope(companyId), isDeleted: false };
  if (filters.status) query.status = filters.status;
  if (filters.customerId) {
    validateObjectId(filters.customerId, "customerId");
    query.customerId = filters.customerId;
  }
  if (filters.agentId) {
    validateObjectId(filters.agentId, "agentId");
    query.agentId = filters.agentId;
  }
  return Conversation.find(query).sort({ updatedAt: -1 }).lean();
}

async function getConversationById(companyId, conversationId) {
  validateObjectId(conversationId, "conversationId");
  const conversation = await Conversation.findOne({ _id: conversationId, ...getCompanyScope(companyId), isDeleted: false });
  if (!conversation) throw new AppError(404, "Conversation not found.");
  return conversation;
}

async function createConversation(companyId, payload) {
  await validateParticipants(companyId, payload.participantIds);
  if (payload.customerId) {
    validateObjectId(payload.customerId, "customerId");
    // Verify customer belongs to this company
    const customer = await Customer.findOne({ _id: payload.customerId, companyId, isDeleted: false });
    if (!customer) {
      throw new AppError(403, "Customer not found or does not belong to your company.");
    }
  }
  
  if (payload.agentId) {
    validateObjectId(payload.agentId, "agentId");
    // Verify agent belongs to this company
    const agent = await AIAgent.findOne({ _id: payload.agentId, companyId, isDeleted: false });
    if (!agent) {
      throw new AppError(403, "AI agent not found or does not belong to your company.");
    }
  }

  const conversation = await Conversation.create({
    customerId: payload.customerId || null,
    agentId: payload.agentId || null,
    participantIds: payload.participantIds || [],
    title: payload.title,
    status: payload.status,
    lastMessageAt: payload.lastMessageAt || null,
    metadata: payload.metadata || {},
    companyId,
    isDeleted: false,
    deletedAt: null,
  });

  try {
    await runEventWorkflows({
      companyId,
      eventType: "conversation.created",
      eventContext: {
        conversation: { _id: String(conversation._id), status: conversation.status, channelType: conversation.channelType, customerId: conversation.customerId ? String(conversation.customerId) : null },
      },
      options: { idempotencyKey: `conv-created:${conversation._id}` },
    });
  } catch (error) {
    logger.error("Workflow execution for conversation.created failed:", error.message);
  }

  return conversation;
}

async function updateConversation(companyId, conversationId, payload) {
  const conversation = await getConversationById(companyId, conversationId);
  await validateParticipants(companyId, payload.participantIds);
  
  if (payload.customerId) {
    validateObjectId(payload.customerId, "customerId");
    // Verify customer belongs to this company
    const customer = await Customer.findOne({ _id: payload.customerId, companyId, isDeleted: false });
    if (!customer) {
      throw new AppError(403, "Customer not found or does not belong to your company.");
    }
  }
  
  if (payload.agentId) {
    validateObjectId(payload.agentId, "agentId");
    // Verify agent belongs to this company
    const agent = await AIAgent.findOne({ _id: payload.agentId, companyId, isDeleted: false });
    if (!agent) {
      throw new AppError(403, "AI agent not found or does not belong to your company.");
    }
  }
  
  const allowedFields = ["customerId", "agentId", "participantIds", "title", "status", "lastMessageAt", "metadata"];
  for (const field of allowedFields) {
    if (payload[field] !== undefined) conversation[field] = payload[field];
  }
  await conversation.save();

  try {
    await runEventWorkflows({
      companyId,
      eventType: "conversation.updated",
      eventContext: {
        conversation: { _id: String(conversation._id), status: conversation.status, channelType: conversation.channelType, customerId: conversation.customerId ? String(conversation.customerId) : null },
      },
      options: { idempotencyKey: `conv-updated:${conversation._id}:${Date.now()}` },
    });
  } catch (error) {
    logger.error("Workflow execution for conversation.updated failed:", error.message);
  }

  return conversation;
}

async function deleteConversation(companyId, conversationId) {
  const conversation = await getConversationById(companyId, conversationId);
  conversation.isDeleted = true;
  conversation.deletedAt = new Date();
  await conversation.save();
  return conversation;
}

module.exports = { listConversations, getConversationById, createConversation, updateConversation, deleteConversation };
