const express = require("express");
const { listConversations, getConversation, createConversation, updateConversation, deleteConversation } = require("../controllers/conversationController");
const { protect, requiresPermission } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("conversations:read"), listConversations);
router.post("/", requiresPermission("conversations:create"), createConversation);
router.get("/:id", requiresPermission("conversations:read"), getConversation);
router.patch("/:id", requiresPermission("conversations:update"), updateConversation);
router.delete("/:id", requiresPermission("conversations:delete"), deleteConversation);

module.exports = router;
