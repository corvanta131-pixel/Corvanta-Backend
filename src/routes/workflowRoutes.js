const express = require("express");
const {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  activateWorkflow,
  deactivateWorkflow,
  deleteWorkflow,
  previewWorkflow,
  listExecutions,
} = require("../controllers/workflowController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("workflows:read"), listWorkflows);
router.post("/", requiresPermission("workflows:create"), createWorkflow);
router.get("/executions", requiresPermission("workflows:read"), listExecutions);
router.get("/:id", requiresPermission("workflows:read"), getWorkflow);
router.patch("/:id", requiresPermission("workflows:update"), updateWorkflow);
router.post("/:id/activate", requiresPermission("workflows:update"), activateWorkflow);
router.post("/:id/deactivate", requiresPermission("workflows:update"), deactivateWorkflow);
router.post("/:id/preview", requiresPermission("workflows:read"), previewWorkflow);
router.delete("/:id", requiresPermission("workflows:delete"), deleteWorkflow);

module.exports = router;
