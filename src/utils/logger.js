const FORBIDDEN_LOG_KEYS = ["apikey", "authorization", "api_key", "secret", "password", "token", "credential", "credentials"];

function redactValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_LOG_KEYS.includes(String(key).toLowerCase())) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactValue(item);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
      .replace(/(api[_-]?key\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
  }
  return value;
}

function safeStringify(value) {
  try {
    return JSON.stringify(redactValue(value));
  } catch (error) {
    return String(value);
  }
}

const formatMessage = (level, ...args) => {
  const timestamp = new Date().toISOString();
  const message = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.message;
    return safeStringify(arg);
  }).join(" ");

  return JSON.stringify({ timestamp, level, message });
};

const logger = {
  info: (...args) => console.log(formatMessage("info", ...args)),
  warn: (...args) => console.warn(formatMessage("warn", ...args)),
  error: (...args) => console.error(formatMessage("error", ...args)),
};

module.exports = logger;
module.exports.redactValue = redactValue;
