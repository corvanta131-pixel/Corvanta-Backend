const formatMessage = (level, ...args) => {
  const timestamp = new Date().toISOString();
  const message = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.message;
    try {
      return JSON.stringify(arg);
    } catch (error) {
      return String(arg);
    }
  }).join(" ");

  return JSON.stringify({ timestamp, level, message });
};

const logger = {
  info: (...args) => console.log(formatMessage("info", ...args)),
  warn: (...args) => console.warn(formatMessage("warn", ...args)),
  error: (...args) => console.error(formatMessage("error", ...args)),
};

module.exports = logger;
