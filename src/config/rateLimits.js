const rateLimit = require("express-rate-limit");
const config = require("./config");

function createAuthLimiter() {
  return rateLimit({
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    max: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many authentication attempts. Please try again later.",
    },
    skipSuccessfulRequests: false,
  });
}

function createApiLimiter() {
  return rateLimit({
    windowMs: config.API_RATE_LIMIT_WINDOW_MS,
    max: config.API_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests. Please slow down.",
    },
  });
}

module.exports = { createAuthLimiter, createApiLimiter };
