const express = require("express");
const { listConversations, getConversation, createConversation, updateConversation, deleteConversation, listConversationMessages, sendConversationMessage, replyToConversation } = require("../controllers/conversationController");
const { protect, requiresPermission } = require("../middleware/auth");
const { aiRateLimitMiddleware } = require("../middleware/aiRateLimit");
const AppError = require("../utils/AppError");
const { createMemoryRateLimiter } = require("../utils/memoryRateLimit");

const replyLimiter = createMemoryRateLimiter({ windowMs: 60000, max: Number(process.env.STAFF_REPLY_LIMIT || 60) });

function limitReplies(req, res, next) {
  const result = replyLimiter.check(String(req.user._id));
  if (result.allowed) return next();
  res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
  return next(new AppError(429, "You are sending replies too quickly. Please wait a moment."));
}

const router = express.Router();

router.use(protect);
router.get("/", requiresPermission("conversations:read"), listConversations);
router.post("/", requiresPermission("conversations:create"), createConversation);
router.get("/:id", requiresPermission("conversations:read"), getConversation);
router.patch("/:id", requiresPermission("conversations:update"), updateConversation);
router.delete("/:id", requiresPermission("conversations:delete"), deleteConversation);
router.get("/:conversationId/messages", requiresPermission("conversations:messages:read"), listConversationMessages);
router.post("/:conversationId/messages", requiresPermission("conversations:send"), aiRateLimitMiddleware, sendConversationMessage);
// A team member's reply to the customer (no AI involved). Requires the conversation to be in HUMAN mode.
router.post("/:conversationId/replies", requiresPermission("conversations:send"), limitReplies, replyToConversation);

module.exports = router;
