const asyncHandler = require("../utils/asyncHandler");
const { validateAIAgentInput } = require("../validators/domainValidator");
const { validateObjectId } = require("../validators/commonValidator");
const { logAudit } = require("../services/auditService");
const { listAgents, getAgentById, createAgent, updateAgent, deleteAgent } = require("../services/agentService");

exports.listAgents = asyncHandler(async (req, res) => {
  const agents = await listAgents(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: agents });
});

exports.getAgent = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "agentId");
  const agent = await getAgentById(req.user.companyId, req.params.id);
  res.status(200).json({ success: true, data: agent });
});

exports.createAgent = asyncHandler(async (req, res) => {
  validateAIAgentInput(req.body);
  const agent = await createAgent(req.user.companyId, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "agent.created", entityType: "AIAgent", entityId: String(agent._id), metadata: { name: agent.name } });
  res.status(201).json({ success: true, message: "AI agent created successfully.", data: agent });
});

exports.updateAgent = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "agentId");
  validateAIAgentInput(req.body, { isUpdate: true });
  const agent = await updateAgent(req.user.companyId, req.params.id, req.body);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "agent.updated", entityType: "AIAgent", entityId: String(agent._id), metadata: { name: agent.name } });
  res.status(200).json({ success: true, message: "AI agent updated successfully.", data: agent });
});

exports.deleteAgent = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "agentId");
  const agent = await deleteAgent(req.user.companyId, req.params.id);
  await logAudit({ user: req.user, companyId: req.user.companyId, action: "agent.deleted", entityType: "AIAgent", entityId: String(agent._id) });
  res.status(200).json({ success: true, message: "AI agent deleted successfully.", data: agent });
});
