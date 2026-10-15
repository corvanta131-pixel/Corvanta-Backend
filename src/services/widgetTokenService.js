const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const AppError = require("../utils/AppError");

const TOKEN_TTL_SECONDS = Number(process.env.WIDGET_TOKEN_TTL_SECONDS || 24 * 60 * 60);

/**
 * Widget tokens are signed with a key derived from (and different to) the dashboard JWT secret,
 * so a widget token can never be accepted as a dashboard access token or the other way around.
 * Set WIDGET_TOKEN_SECRET in production to use an independent secret.
 */
function signingKey() {
  const base = process.env.WIDGET_TOKEN_SECRET || config.JWT_ACCESS_SECRET;
  return crypto.createHmac("sha256", String(base)).update("corvanta-widget-token-v1").digest("hex");
}

function signWidgetToken({ channelId, companyId, customerId, conversationId, visitorId }) {
  return jwt.sign(
    {
      typ: "widget",
      cid: String(channelId),
      co: String(companyId),
      cu: String(customerId),
      cv: String(conversationId),
      vid: String(visitorId),
    },
    signingKey(),
    { algorithm: "HS256", expiresIn: TOKEN_TTL_SECONDS }
  );
}

function verifyWidgetToken(token) {
  try {
    const payload = jwt.verify(token, signingKey(), { algorithms: ["HS256"] });
    if (!payload || payload.typ !== "widget") throw new Error("wrong token type");
    return {
      channelId: payload.cid,
      companyId: payload.co,
      customerId: payload.cu,
      conversationId: payload.cv,
      visitorId: payload.vid,
    };
  } catch (error) {
    throw new AppError(401, "Your chat session has expired. Please start a new chat.");
  }
}

module.exports = { signWidgetToken, verifyWidgetToken, TOKEN_TTL_SECONDS };
