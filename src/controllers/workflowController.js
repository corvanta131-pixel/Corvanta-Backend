const asyncHandler = require("../utils/asyncHandler");
const { validateObjectId } = require("../validators/commonValidator");
const { validateWorkflowInput } = require("../validators/workflowValidator");
const { logAudit } = require("../services/auditService");
const {
  listWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  setWorkflowStatus,
  deleteWorkflow,
  previewWorkflow,
  listExecutions,
  rejectProtectedFields,
} = require("../services/workflow/workflowService");

exports.listWorkflows = asyncHandler(async (req, res) => {
  const workflows = await listWorkflows(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: workflows });
});

exports.getWorkflow = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "workflowId");
  const workflow = await getWorkflowById(req.user.companyId, req.params.id);
  res.status(200).json({ success: true, data: workflow });
});

exports.createWorkflow = asyncHandler(async (req, res) => {
  rejectProtectedFields(req.body || {});
  validateWorkflowInput(req.body || {});
  const workflow = await createWorkflow(req.user.companyId, req.body, req.user);
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "workflow.created",
    entityType: "Workflow",
    entityId: String(workflow._id),
    metadata: { name: workflow.name, trigger: workflow.trigger.type },
  });
  res.status(201).json({ success: true, message: "Workflow created successfully.", data: workflow });
});

exports.updateWorkflow = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "workflowId");
  rejectProtectedFields(req.body || {});
  validateWorkflowInput(req.body || {}, { isUpdate: true });
  const workflow = await updateWorkflow(req.user.companyId, req.params.id, req.body, req.user);
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "workflow.updated",
    entityType: "Workflow",
    entityId: String(workflow._id),
    metadata: { name: workflow.name, status: workflow.status },
  });
  res.status(200).json({ success: true, message: "Workflow updated successfully.", data: workflow });
});

exports.activateWorkflow = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "workflowId");
  const workflow = await setWorkflowStatus(req.user.companyId, req.params.id, "active", req.user);
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "workflow.activated",
    entityType: "Workflow",
    entityId: String(workflow._id),
  });
  res.status(200).json({ success: true, message: "Workflow activated.", data: workflow });
});

exports.deactivateWorkflow = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "workflowId");
  const workflow = await setWorkflowStatus(req.user.companyId, req.params.id, "inactive", req.user);
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "workflow.deactivated",
    entityType: "Workflow",
    entityId: String(workflow._id),
  });
  res.status(200).json({ success: true, message: "Workflow deactivated.", data: workflow });
});

exports.deleteWorkflow = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "workflowId");
  const workflow = await deleteWorkflow(req.user.companyId, req.params.id, req.user);
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "workflow.deleted",
    entityType: "Workflow",
    entityId: String(workflow._id),
  });
  res.status(200).json({ success: true, message: "Workflow deleted.", data: workflow });
});

exports.previewWorkflow = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "workflowId");
  rejectProtectedFields(req.body || {});
  const result = await previewWorkflow({
    companyId: req.user.companyId,
    workflowId: req.params.id,
    eventContext: req.body?.eventContext || {},
  });
  res.status(200).json({ success: true, data: result });
});

exports.listExecutions = asyncHandler(async (req, res) => {
  const executions = await listExecutions(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: executions });
});
