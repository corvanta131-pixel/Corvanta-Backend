const express = require("express");
const { listAgents, getAgent, createAgent, updateAgent, deleteAgent } = require("../controllers/agentController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("agents:read"), listAgents);
router.post("/", requiresPermission("agents:create"), createAgent);
router.get("/:id", requiresPermission("agents:read"), getAgent);
router.patch("/:id", requiresPermission("agents:update"), updateAgent);
router.delete("/:id", requiresPermission("agents:delete"), deleteAgent);

module.exports = router;
