const AppError = require("../utils/AppError");

/** Extracts the visitor's bearer token. Verification against the channel happens in widgetService. */
function widgetAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return next(new AppError(401, "Chat session required."));
  req.widgetToken = match[1];
  return next();
}

module.exports = widgetAuth;
