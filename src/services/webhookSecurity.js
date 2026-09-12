const crypto = require("crypto");
const AppError = require("../utils/AppError");

function verifySignature(provider, signature, timestamp, body, secret) {
  if (!signature) throw new AppError(401, "Missing signature header.");
  if (!timestamp) throw new AppError(401, "Missing timestamp header.");
  if (!secret) throw new AppError(503, "Channel signing secret is not configured.");

  const currentTime = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);
  if (Number.isNaN(requestTime) || Math.abs(currentTime - requestTime) > 300) {
    throw new AppError(401, "Webhook timestamp is outside the allowed window.");
  }

  const expectedSignature = `sha256=${crypto.createHmac("sha256", secret).update(timestamp + body).digest("hex")}`;
  const providedSig = signature.startsWith("sha256=") ? signature : `sha256=${signature}`;

  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSignature));
  } catch {
    match = false;
  }
  if (!match) throw new AppError(401, "Webhook signature verification failed.");

  return true;
}

async function isReplayAttack(companyId, channelType, externalConversationId, externalMessageId, idempotency) {
  const existing = await idempotency.checkIdempotency(companyId, channelType, externalMessageId);
  if (existing) return true;
  return false;
}

function createWebhookValidator(options = {}) {
  const { secret, provider } = options;
  return {
    provider,
    verify: (signature, timestamp, body) => verifySignature(provider, signature, timestamp, body, secret),
    isReplay: (companyId, channelType, externalMessageId) => {
      const idempotency = require("./idempotencyService");
      return isReplayAttack(companyId, channelType, externalMessageId, idempotency);
    },
  };
}

module.exports = {
  verifySignature,
  isReplayAttack,
  createWebhookValidator,
};