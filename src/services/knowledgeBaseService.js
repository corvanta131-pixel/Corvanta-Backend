const KnowledgeBase = require("../models/KnowledgeBase");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");

function getCompanyScope(companyId) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  return { companyId };
}

async function listKnowledgeBases(companyId, filters = {}) {
  const query = { ...getCompanyScope(companyId), isDeleted: false };
  if (filters.status) query.status = filters.status;
  return KnowledgeBase.find(query).sort({ createdAt: -1 }).lean();
}

async function getKnowledgeBaseById(companyId, knowledgeBaseId) {
  validateObjectId(knowledgeBaseId, "knowledgeBaseId");
  const knowledgeBase = await KnowledgeBase.findOne({ _id: knowledgeBaseId, ...getCompanyScope(companyId), isDeleted: false });
  if (!knowledgeBase) throw new AppError(404, "Knowledge base not found.");
  return knowledgeBase;
}

async function createKnowledgeBase(companyId, payload) {
  const existing = await KnowledgeBase.findOne({ companyId, name: String(payload.name || "").trim(), isDeleted: false });
  if (existing) throw new AppError(409, "A knowledge base with this name already exists in this company.");

  // Validate ownerId belongs to same company
  if (payload.ownerId) {
    validateObjectId(payload.ownerId, "ownerId");
    const owner = await User.findOne({ _id: payload.ownerId, companyId, isDeleted: false });
    if (!owner) {
      throw new AppError(403, "Owner not found or does not belong to your company.");
    }
  }

  const knowledgeBase = await KnowledgeBase.create({
    name: payload.name,
    description: payload.description,
    status: payload.status,
    ownerId: payload.ownerId || null,
    metadata: payload.metadata || {},
    companyId,
    isDeleted: false,
    deletedAt: null,
  });
  return knowledgeBase;
}

async function updateKnowledgeBase(companyId, knowledgeBaseId, payload) {
  const knowledgeBase = await getKnowledgeBaseById(companyId, knowledgeBaseId);
  if (payload.name) {
    const duplicate = await KnowledgeBase.findOne({ _id: { $ne: knowledgeBaseId }, companyId, name: String(payload.name).trim(), isDeleted: false });
    if (duplicate) throw new AppError(409, "A knowledge base with this name already exists in this company.");
  }

  // Validate ownerId belongs to same company
  if (payload.ownerId) {
    validateObjectId(payload.ownerId, "ownerId");
    const owner = await User.findOne({ _id: payload.ownerId, companyId, isDeleted: false });
    if (!owner) {
      throw new AppError(403, "Owner not found or does not belong to your company.");
    }
  }

  const allowedFields = ["name", "description", "status", "ownerId", "metadata"];
  for (const field of allowedFields) {
    if (payload[field] !== undefined) knowledgeBase[field] = payload[field];
  }
  await knowledgeBase.save();
  return knowledgeBase;
}

async function deleteKnowledgeBase(companyId, knowledgeBaseId) {
  const knowledgeBase = await getKnowledgeBaseById(companyId, knowledgeBaseId);
  knowledgeBase.isDeleted = true;
  knowledgeBase.deletedAt = new Date();
  await knowledgeBase.save();
  return knowledgeBase;
}

module.exports = { listKnowledgeBases, getKnowledgeBaseById, createKnowledgeBase, updateKnowledgeBase, deleteKnowledgeBase };
