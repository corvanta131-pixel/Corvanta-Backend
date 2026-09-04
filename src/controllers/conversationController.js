const asyncHandler = require("../utils/asyncHandler");
const { validateConversationInput } = require("../validators/domainValidator");
const { validateObjectId } = require("../validators/commonValidator");
const { logAudit } = require("../services/auditService");
const { listConversations, getConversationById, createConversation, updateConversation, deleteConversation } = require("../services/conversationService");

exports.listConversations = asyncHandler(async (req, res) => {
  const conversations = await listConversations(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: conversations });
});

exports.getConversation = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "conversationId");
  const conversation = await getConversationById(req.user.companyId, req.params.id);
  res.status(200).json({ success: true, data: conversation });
});

exports.createConversation = asyncHandler(async (req, res) => {
  validateConversationInput(req.body);
  const conversation = await createConversation(req.user.companyId, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "conversation.created", entityType: "Conversation", entityId: String(conversation._id), metadata: { title: conversation.title || "Conversation" } });
  res.status(201).json({ success: true, message: "Conversation created successfully.", data: conversation });
});

exports.updateConversation = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "conversationId");
  validateConversationInput(req.body, { isUpdate: true });
  const conversation = await updateConversation(req.user.companyId, req.params.id, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "conversation.updated", entityType: "Conversation", entityId: String(conversation._id), metadata: { title: conversation.title || "Conversation" } });
  res.status(200).json({ success: true, message: "Conversation updated successfully.", data: conversation });
});

exports.deleteConversation = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "conversationId");
  const conversation = await deleteConversation(req.user.companyId, req.params.id);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "conversation.deleted", entityType: "Conversation", entityId: String(conversation._id) });
  res.status(200).json({ success: true, message: "Conversation deleted successfully.", data: conversation });
});
