const KnowledgeDocument = require("../models/KnowledgeDocument");
const KnowledgeBase = require("../models/KnowledgeBase");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");

function getCompanyScope(companyId) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  return { companyId };
}

async function listKnowledgeDocuments(companyId, filters = {}) {
  const query = { ...getCompanyScope(companyId), isDeleted: false };
  if (filters.status) query.status = filters.status;
  if (filters.knowledgeBaseId) query.knowledgeBaseId = filters.knowledgeBaseId;
  return KnowledgeDocument.find(query).sort({ createdAt: -1 }).lean();
}

async function getKnowledgeDocumentById(companyId, documentId) {
  validateObjectId(documentId, "documentId");
  const document = await KnowledgeDocument.findOne({ _id: documentId, ...getCompanyScope(companyId), isDeleted: false });
  if (!document) throw new AppError(404, "Knowledge document not found.");
  return document;
}

async function createKnowledgeDocument(companyId, payload) {
  if (!payload.knowledgeBaseId) throw new AppError(400, "Knowledge base reference is required.");
  validateObjectId(payload.knowledgeBaseId, "knowledgeBaseId");
  
  // Verify knowledge base belongs to this company
  const knowledgeBase = await KnowledgeBase.findOne({ _id: payload.knowledgeBaseId, companyId, isDeleted: false });
  if (!knowledgeBase) {
    throw new AppError(403, "Knowledge base not found or does not belong to your company.");
  }

  // Validate createdBy belongs to same company
  if (payload.createdBy) {
    validateObjectId(payload.createdBy, "createdBy");
    const creator = await User.findOne({ _id: payload.createdBy, companyId, isDeleted: false });
    if (!creator) {
      throw new AppError(403, "Creator not found or does not belong to your company.");
    }
  }
  
  const document = await KnowledgeDocument.create({
    knowledgeBaseId: payload.knowledgeBaseId,
    title: payload.title,
    content: payload.content,
    summary: payload.summary,
    status: payload.status,
    tags: payload.tags || [],
    source: payload.source || "manual",
    fileName: payload.fileName || "",
    mimeType: payload.mimeType || "text/plain",
    createdBy: payload.createdBy || null,
    metadata: payload.metadata || {},
    companyId,
    isDeleted: false,
    deletedAt: null,
  });
  return document;
}

async function updateKnowledgeDocument(companyId, documentId, payload) {
  const document = await getKnowledgeDocumentById(companyId, documentId);
  if (payload.knowledgeBaseId) {
    validateObjectId(payload.knowledgeBaseId, "knowledgeBaseId");
    // Verify new knowledge base belongs to this company
    const knowledgeBase = await KnowledgeBase.findOne({ _id: payload.knowledgeBaseId, companyId, isDeleted: false });
    if (!knowledgeBase) {
      throw new AppError(403, "Knowledge base not found or does not belong to your company.");
    }
  }

  // Validate createdBy belongs to same company
  if (payload.createdBy) {
    validateObjectId(payload.createdBy, "createdBy");
    const creator = await User.findOne({ _id: payload.createdBy, companyId, isDeleted: false });
    if (!creator) {
      throw new AppError(403, "Creator not found or does not belong to your company.");
    }
  }

  const allowedFields = ["knowledgeBaseId", "title", "content", "summary", "status", "tags", "source", "fileName", "mimeType", "createdBy", "metadata"];
  for (const field of allowedFields) {
    if (payload[field] !== undefined) document[field] = payload[field];
  }
  await document.save();
  return document;
}

async function deleteKnowledgeDocument(companyId, documentId) {
  const document = await getKnowledgeDocumentById(companyId, documentId);
  document.isDeleted = true;
  document.deletedAt = new Date();
  await document.save();
  return document;
}

module.exports = { listKnowledgeDocuments, getKnowledgeDocumentById, createKnowledgeDocument, updateKnowledgeDocument, deleteKnowledgeDocument };
