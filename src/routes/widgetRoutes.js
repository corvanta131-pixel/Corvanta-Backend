const express = require("express");
const controller = require("../controllers/widgetController");
const { resolveWidgetChannel, widgetCors } = require("../middleware/widgetCors");
const widgetAuth = require("../middleware/widgetAuth");
const AppError = require("../utils/AppError");
const { createMemoryRateLimiter } = require("../utils/memoryRateLimit");

const router = express.Router();

const sessionLimiter = createMemoryRateLimiter({ windowMs: 60000, max: Number(process.env.WIDGET_SESSION_LIMIT || 10) });
const sendLimiter = createMemoryRateLimiter({ windowMs: 60000, max: Number(process.env.WIDGET_SEND_LIMIT || 12) });
const pollLimiter = createMemoryRateLimiter({ windowMs: 60000, max: Number(process.env.WIDGET_POLL_LIMIT || 40) });

function limit(limiter, keyOf, message) {
  return (req, res, next) => {
    const result = limiter.check(keyOf(req));
    if (result.allowed) return next();
    res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    return next(new AppError(429, message));
  };
}

// Must be declared before the /:widgetKey routes.
router.get("/embed.js", controller.serveEmbed);

router.use("/:widgetKey", resolveWidgetChannel, widgetCors);

router.get("/:widgetKey/config", controller.getConfig);
router.post(
  "/:widgetKey/session",
  limit(sessionLimiter, (req) => `${req.widgetChannel._id}:${req.ip}`, "Too many chats started. Please try again shortly."),
  controller.startOrResumeSession
);
router.get(
  "/:widgetKey/messages",
  widgetAuth,
  limit(pollLimiter, (req) => req.widgetToken.slice(-24), "Too many requests. Please slow down."),
  controller.listMessages
);
router.post(
  "/:widgetKey/messages",
  widgetAuth,
  limit(sendLimiter, (req) => req.widgetToken.slice(-24), "You are sending messages too quickly. Please wait a moment."),
  controller.sendMessage
);

module.exports = router;
