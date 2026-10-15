const AppError = require("../utils/AppError");
const { getChannelByWidgetKey } = require("../services/widgetService");

/**
 * Resolves the widget channel from the public key in the URL (the ONLY way a visitor selects a
 * tenant) and attaches it to the request.
 */
async function resolveWidgetChannel(req, res, next) {
  try {
    const channel = await getChannelByWidgetKey(req.params.widgetKey);
    if (!channel) return next(new AppError(404, "Chat not found."));
    req.widgetChannel = channel;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Per-channel CORS: a browser on a website that is not in the channel's allowed list gets no CORS
 * headers (and an explicit 403), so it cannot read responses. Requests with no Origin header
 * (non-browser clients) are still protected by tokens and rate limits.
 */
function widgetCors(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();

  const allowed = (req.widgetChannel && req.widgetChannel.widget && req.widgetChannel.widget.allowedOrigins) || [];
  if (!allowed.includes(origin)) {
    return next(new AppError(403, "This website is not allowed to use this chat."));
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}

module.exports = { resolveWidgetChannel, widgetCors };
