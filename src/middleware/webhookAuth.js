const AppError = require("../utils/AppError");
const { verifySignature, isReplayAttack } = require("../services/webhookSecurity");
const { getChannelByWebhookPath } = require("../services/channelService");

/**
 * Webhook authentication middleware.
 *
 * Authenticates an inbound webhook request using HMAC-SHA256 signature
 * verification, timestamp freshness validation, and replay-attack protection.
 * It does NOT rely on a client-supplied JWT and never trusts an arbitrary
 * `companyId` from the request body.
 *
 * Company/channel context is resolved from the webhook path (a server-assigned
 * channel identifier stored in `channel.externalConfig.webhookPath`), which
 * cannot be used to select another company's channel.
 *
 * On success it attaches:
 *   - req.webhookChannel  — the resolved, tenant-scoped Channel document
 *   - req.webhookSecret   — the channel signing secret used for verification
 */
async function webhookAuth(req, res, next) {
  try {
    const signature = req.headers["x-corvanta-signature"];
    const timestamp = req.headers["x-corvanta-timestamp"];
    const webhookPath = req.params.webhookPath;

    if (!signature) {
      return next(new AppError(401, "Missing webhook signature header."));
    }
    if (!timestamp) {
      return next(new AppError(401, "Missing webhook timestamp header."));
    }
    if (!webhookPath) {
      return next(new AppError(400, "Missing webhook path."));
    }

    const rawBody =
      typeof req.rawBody === "string"
        ? req.rawBody
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body);

    // Resolve the channel from the webhook path. This is the ONLY
    // tenant-scoped lookup performed; the client cannot select a channel.
    const channel = await getChannelByWebhookPath(webhookPath);
    if (!channel) {
      return next(new AppError(404, "Channel not found for webhook path."));
    }

    const secret = channel.externalConfig && channel.externalConfig.webhookSecret;
    if (!secret) {
      return next(new AppError(503, "Channel signing secret is not configured."));
    }

    verifySignature(webhookPath, signature, timestamp, rawBody, secret);

    const idempotency = require("../services/idempotencyService");
    const externalMessageId =
      req.body && (req.body.externalMessageId || req.body.id)
        ? String(req.body.externalMessageId || req.body.id)
        : null;

    // Replay protection: check the in-memory idempotency store BEFORE
    // processing. If the same externalMessageId has already been seen,
    // reject the request.
    if (externalMessageId) {
      const replay = await isReplayAttack(
        channel.companyId,
        channel.type,
        null,
        externalMessageId,
        idempotency
      );
      if (replay) {
        return next(new AppError(409, "Replay attack detected: duplicate webhook request."));
      }
      // Mark this message as seen so any future duplicate is rejected.
      await idempotency.storeIdempotency(
        channel.companyId,
        channel.type,
        externalMessageId,
        { received: true, webhookPath }
      );
    }

    req.webhookChannel = channel;
    req.webhookSecret = secret;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = webhookAuth;