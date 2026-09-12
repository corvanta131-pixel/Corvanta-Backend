const config = require("../config/config");

const AI_RATE_LIMIT_WINDOW_MS = Number(process.env.AI_CONVERSATION_RATE_LIMIT_WINDOW_MS || 60000);
const AI_CONVERSATION_RATE_LIMIT_MAX = Number(process.env.AI_CONVERSATION_RATE_LIMIT_MAX || 30);

const companyRequestCounts = new Map();

function resetRateLimiter() {
  companyRequestCounts.clear();
}

function checkAIRateLimit(companyId) {
  const now = Date.now();
  const key = String(companyId);
  const record = companyRequestCounts.get(key);

  if (!record || now - record.windowStart >= AI_RATE_LIMIT_WINDOW_MS) {
    companyRequestCounts.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: AI_CONVERSATION_RATE_LIMIT_MAX - 1, resetMs: AI_RATE_LIMIT_WINDOW_MS };
  }

  if (record.count >= AI_CONVERSATION_RATE_LIMIT_MAX) {
    const resetMs = AI_RATE_LIMIT_WINDOW_MS - (now - record.windowStart);
    return { allowed: false, remaining: 0, resetMs };
  }

  record.count += 1;
  return {
    allowed: true,
    remaining: AI_CONVERSATION_RATE_LIMIT_MAX - record.count,
    resetMs: AI_RATE_LIMIT_WINDOW_MS - (now - record.windowStart),
  };
}

function aiRateLimitMiddleware(req, res, next) {
  const companyId = req.user && req.user.companyId;
  if (!companyId) return res.status(403).json({ success: false, message: "Forbidden." });

  const result = checkAIRateLimit(companyId);
  res.setHeader("X-AI-RateLimit-Limit", AI_CONVERSATION_RATE_LIMIT_MAX);
  res.setHeader("X-AI-RateLimit-Remaining", result.remaining);
  res.setHeader("X-AI-RateLimit-Reset-Ms", result.resetMs);

  if (!result.allowed) {
    return res.status(429).json({
      success: false,
      message: "AI request rate limit exceeded. Please wait before sending more messages.",
      retryAfterMs: result.resetMs,
    });
  }
  return next();
}

module.exports = {
  aiRateLimitMiddleware,
  checkAIRateLimit,
  resetRateLimiter,
  AI_RATE_LIMIT_WINDOW_MS,
  AI_CONVERSATION_RATE_LIMIT_MAX,
};