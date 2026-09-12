const express = require("express");
const { listConversations, getConversation, createConversation, updateConversation, deleteConversation, listConversationMessages, sendConversationMessage } = require("../controllers/conversationController");
const { protect, requiresPermission } = require("../middleware/auth");
const { aiRateLimitMiddleware } = require("../middleware/aiRateLimit");

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("conversations:read"), listConversations);
router.post("/", requiresPermission("conversations:create"), createConversation);
router.get("/:id", requiresPermission("conversations:read"), getConversation);
router.patch("/:id", requiresPermission("conversations:update"), updateConversation);
router.delete("/:id", requiresPermission("conversations:delete"), deleteConversation);
router.get("/:conversationId/messages", requiresPermission("conversations:messages:read"), listConversationMessages);
router.post("/:conversationId/messages", requiresPermission("conversations:send"), aiRateLimitMiddleware, sendConversationMessage);

module.exports = router;
