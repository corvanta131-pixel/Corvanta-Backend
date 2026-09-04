const AIAgent = require("../models/AIAgent");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const User = require("../models/User");
const KnowledgeBase = require("../models/KnowledgeBase");

function getCompanyScope(companyId) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  return { companyId };
}

async function listAgents(companyId, filters = {}) {
  const query = { ...getCompanyScope(companyId), isDeleted: false };
  if (filters.status) query.status = filters.status;
  return AIAgent.find(query).sort({ createdAt: -1 }).lean();
}

async function getAgentById(companyId, agentId) {
  validateObjectId(agentId, "agentId");
  const agent = await AIAgent.findOne({ _id: agentId, ...getCompanyScope(companyId), isDeleted: false });
  if (!agent) throw new AppError(404, "AI agent not found.");
  return agent;
}

async function createAgent(companyId, payload) {
  const slug = String(payload.slug || payload.name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const existing = await AIAgent.findOne({ companyId, slug, isDeleted: false });
  if (existing) throw new AppError(409, "An AI agent with this slug already exists in this company.");

  // Validate ownerId belongs to same company
  if (payload.ownerId) {
    validateObjectId(payload.ownerId, "ownerId");
    const owner = await User.findOne({ _id: payload.ownerId, companyId, isDeleted: false });
    if (!owner) {
      throw new AppError(403, "Owner not found or does not belong to your company.");
    }
  }

  // Validate each knowledgeBaseId belongs to same company
  if (payload.knowledgeBaseIds && Array.isArray(payload.knowledgeBaseIds) && payload.knowledgeBaseIds.length > 0) {
    for (const kbId of payload.knowledgeBaseIds) {
      validateObjectId(kbId, "knowledgeBaseId");
      const kb = await KnowledgeBase.findOne({ _id: kbId, companyId, isDeleted: false });
      if (!kb) {
        throw new AppError(403, "One or more knowledge bases do not belong to your company.");
      }
    }
  }

  const agent = await AIAgent.create({
    name: payload.name,
    description: payload.description,
    status: payload.status,
    model: payload.model,
    promptTemplate: payload.promptTemplate,
    ownerId: payload.ownerId || null,
    knowledgeBaseIds: payload.knowledgeBaseIds || [],
    metadata: payload.metadata || {},
    companyId,
    slug: slug || `agent-${Date.now()}`,
    isDeleted: false,
    deletedAt: null,
  });
  return agent;
}

async function updateAgent(companyId, agentId, payload) {
  const agent = await getAgentById(companyId, agentId);
  if (payload.name || payload.slug) {
    const slug = String(payload.slug || payload.name || agent.slug).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const duplicate = await AIAgent.findOne({ _id: { $ne: agentId }, companyId, slug, isDeleted: false });
    if (duplicate) throw new AppError(409, "An AI agent with this slug already exists in this company.");
    agent.slug = slug;
  }

  // Validate ownerId belongs to same company
  if (payload.ownerId) {
    validateObjectId(payload.ownerId, "ownerId");
    const owner = await User.findOne({ _id: payload.ownerId, companyId, isDeleted: false });
    if (!owner) {
      throw new AppError(403, "Owner not found or does not belong to your company.");
    }
  }

  // Validate each knowledgeBaseId belongs to same company
  if (payload.knowledgeBaseIds && Array.isArray(payload.knowledgeBaseIds) && payload.knowledgeBaseIds.length > 0) {
    for (const kbId of payload.knowledgeBaseIds) {
      validateObjectId(kbId, "knowledgeBaseId");
      const kb = await KnowledgeBase.findOne({ _id: kbId, companyId, isDeleted: false });
      if (!kb) {
        throw new AppError(403, "One or more knowledge bases do not belong to your company.");
      }
    }
  }

  const allowedFields = ["name", "description", "status", "model", "promptTemplate", "ownerId", "knowledgeBaseIds", "metadata"];
  for (const field of allowedFields) {
    if (payload[field] !== undefined) agent[field] = payload[field];
  }
  await agent.save();
  return agent;
}

async function deleteAgent(companyId, agentId) {
  const agent = await getAgentById(companyId, agentId);
  agent.isDeleted = true;
  agent.deletedAt = new Date();
  await agent.save();
  return agent;
}

module.exports = { listAgents, getAgentById, createAgent, updateAgent, deleteAgent };
