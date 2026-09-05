const asyncHandler = require("../utils/asyncHandler");
const { validateObjectId, rejectProtectedFieldOverrides } = require("../validators/commonValidator");
const { logAudit } = require("../services/auditService");
const KnowledgeDocument = require("../models/KnowledgeDocument");
const AppError = require("../utils/AppError");
const { ingestKnowledgeDocument, removeDocumentFromIndex } = require("../services/ingestionService");

exports.indexKnowledgeDocument = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "documentId");
  rejectProtectedFieldOverrides(req.body || {});
  const result = await ingestKnowledgeDocument({
    companyId: req.user.companyId,
    documentId: req.params.id,
    options: {},
  });
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "knowledge_document.indexed",
    entityType: "KnowledgeDocument",
    entityId: String(result.document._id),
    metadata: { chunks: result.chunks, vectors: result.vectorIds.length },
  });
  res.status(200).json({
    success: true,
    message: "Knowledge document indexed.",
    data: {
      documentId: String(result.document._id),
      chunkCount: result.chunks,
      vectorCount: result.vectorIds.length,
      indexingState: result.document.indexingState,
      lastIndexedAt: result.document.lastIndexedAt,
    },
  });
});

exports.getKnowledgeDocumentIndexStatus = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "documentId");
  const document = await KnowledgeDocument.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
    isDeleted: false,
  }).select("knowledgeBaseId indexingState indexingError lastIndexedAt chunkCount");
  if (!document) throw new AppError(404, "Knowledge document not found.");
  res.status(200).json({
    success: true,
    data: {
      documentId: String(document._id),
      knowledgeBaseId: String(document.knowledgeBaseId),
      indexingState: document.indexingState,
      indexingError: document.indexingError,
      lastIndexedAt: document.lastIndexedAt,
      chunkCount: document.chunkCount,
    },
  });
});

exports.removeKnowledgeDocumentIndex = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "documentId");
  rejectProtectedFieldOverrides(req.body || {});
  const result = await removeDocumentFromIndex({
    companyId: req.user.companyId,
    documentId: req.params.id,
  });
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "knowledge_document.unindexed",
    entityType: "KnowledgeDocument",
    entityId: String(result._id),
  });
  res.status(200).json({
    success: true,
    message: "Knowledge document removed from index.",
    data: {
      documentId: String(result._id),
      indexingState: result.indexingState,
      lastIndexedAt: result.lastIndexedAt,
    },
  });
});
