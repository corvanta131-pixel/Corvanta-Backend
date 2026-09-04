const asyncHandler = require("../utils/asyncHandler");
const { validateKnowledgeDocumentInput } = require("../validators/domainValidator");
const { validateObjectId } = require("../validators/commonValidator");
const { logAudit } = require("../services/auditService");
const { listKnowledgeDocuments, getKnowledgeDocumentById, createKnowledgeDocument, updateKnowledgeDocument, deleteKnowledgeDocument } = require("../services/knowledgeDocumentService");

exports.listKnowledgeDocuments = asyncHandler(async (req, res) => {
  const documents = await listKnowledgeDocuments(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: documents });
});

exports.getKnowledgeDocument = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "documentId");
  const document = await getKnowledgeDocumentById(req.user.companyId, req.params.id);
  res.status(200).json({ success: true, data: document });
});

exports.createKnowledgeDocument = asyncHandler(async (req, res) => {
  validateKnowledgeDocumentInput(req.body);
  const document = await createKnowledgeDocument(req.user.companyId, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "knowledge_document.created", entityType: "KnowledgeDocument", entityId: String(document._id), metadata: { title: document.title } });
  res.status(201).json({ success: true, message: "Knowledge document created successfully.", data: document });
});

exports.updateKnowledgeDocument = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "documentId");
  validateKnowledgeDocumentInput(req.body, { isUpdate: true });
  const document = await updateKnowledgeDocument(req.user.companyId, req.params.id, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "knowledge_document.updated", entityType: "KnowledgeDocument", entityId: String(document._id), metadata: { title: document.title } });
  res.status(200).json({ success: true, message: "Knowledge document updated successfully.", data: document });
});

exports.deleteKnowledgeDocument = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "documentId");
  const document = await deleteKnowledgeDocument(req.user.companyId, req.params.id);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "knowledge_document.deleted", entityType: "KnowledgeDocument", entityId: String(document._id) });
  res.status(200).json({ success: true, message: "Knowledge document deleted successfully.", data: document });
});
