const asyncHandler = require("../utils/asyncHandler");
const { validateKnowledgeBaseInput } = require("../validators/domainValidator");
const { validateObjectId } = require("../validators/commonValidator");
const { logAudit } = require("../services/auditService");
const { listKnowledgeBases, getKnowledgeBaseById, createKnowledgeBase, updateKnowledgeBase, deleteKnowledgeBase } = require("../services/knowledgeBaseService");

exports.listKnowledgeBases = asyncHandler(async (req, res) => {
  const knowledgeBases = await listKnowledgeBases(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: knowledgeBases });
});

exports.getKnowledgeBase = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "knowledgeBaseId");
  const knowledgeBase = await getKnowledgeBaseById(req.user.companyId, req.params.id);
  res.status(200).json({ success: true, data: knowledgeBase });
});

exports.createKnowledgeBase = asyncHandler(async (req, res) => {
  validateKnowledgeBaseInput(req.body);
  const knowledgeBase = await createKnowledgeBase(req.user.companyId, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "knowledge_base.created", entityType: "KnowledgeBase", entityId: String(knowledgeBase._id), metadata: { name: knowledgeBase.name } });
  res.status(201).json({ success: true, message: "Knowledge base created successfully.", data: knowledgeBase });
});

exports.updateKnowledgeBase = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "knowledgeBaseId");
  validateKnowledgeBaseInput(req.body, { isUpdate: true });
  const knowledgeBase = await updateKnowledgeBase(req.user.companyId, req.params.id, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "knowledge_base.updated", entityType: "KnowledgeBase", entityId: String(knowledgeBase._id), metadata: { name: knowledgeBase.name } });
  res.status(200).json({ success: true, message: "Knowledge base updated successfully.", data: knowledgeBase });
});

exports.deleteKnowledgeBase = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "knowledgeBaseId");
  const knowledgeBase = await deleteKnowledgeBase(req.user.companyId, req.params.id);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "knowledge_base.deleted", entityType: "KnowledgeBase", entityId: String(knowledgeBase._id) });
  res.status(200).json({ success: true, message: "Knowledge base deleted successfully.", data: knowledgeBase });
});
