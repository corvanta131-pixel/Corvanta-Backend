const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const logger = require("../utils/logger");
const { logAudit } = require("../services/auditService");
const { publicBaseUrl } = require("../utils/publicUrl");
const { createMemoryRateLimiter } = require("../utils/memoryRateLimit");
const connectorService = require("../services/connectors/connectorService");
const { getProvider } = require("../services/connectors/providers");
const { processInbound } = require("../services/connectors/inboundService");

const webhookLimiter = createMemoryRateLimiter({ windowMs: 60000, max: Number(process.env.WEBHOOK_LIMIT_PER_MINUTE || 600) });

// ---- Dashboard (JWT-protected) -------------------------------------------------------------

exports.getConnector = asyncHandler(async (req, res) => {
  const view = await connectorService.getConnectorView(req.user.companyId, req.params.id, publicBaseUrl(req));
  res.status(200).json({ success: true, data: view });
});

exports.saveConnector = asyncHandler(async (req, res) => {
  const { view, revealed, credentialsChanged } = await connectorService.saveConnector(
    req.user.companyId,
    req.params.id,
    req.body || {},
    publicBaseUrl(req)
  );
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.connector.updated",
    entityType: "Channel",
    entityId: String(req.params.id),
    metadata: { credentialsChanged, enabled: view.enabled },
  });
  res.status(200).json({ success: true, data: { ...view, revealed } });
});

exports.testConnector = asyncHandler(async (req, res) => {
  const { view, ok } = await connectorService.testConnector(req.user.companyId, req.params.id, publicBaseUrl(req));
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.connector.tested",
    entityType: "Channel",
    entityId: String(req.params.id),
    metadata: { ok },
  });
  res.status(200).json({ success: true, data: view });
});

exports.rotateSigningSecret = asyncHandler(async (req, res) => {
  const { view, signingSecret } = await connectorService.rotateSigningSecret(req.user.companyId, req.params.id, publicBaseUrl(req));
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.connector.secret_rotated",
    entityType: "Channel",
    entityId: String(req.params.id),
    metadata: {},
  });
  res.status(200).json({ success: true, data: { ...view, revealed: { signingSecret } } });
});

exports.clearConnector = asyncHandler(async (req, res) => {
  const view = await connectorService.clearConnector(req.user.companyId, req.params.id, publicBaseUrl(req));
  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.connector.cleared",
    entityType: "Channel",
    entityId: String(req.params.id),
    metadata: {},
  });
  res.status(200).json({ success: true, data: view });
});

// ---- Public provider webhooks (no JWT; authenticated by the provider's own signature) -------

exports.verifyChallenge = asyncHandler(async (req, res) => {
  const channel = await connectorService.findChannelByWebhookKey(req.params.webhookKey);
  const provider = channel && getProvider(channel.type);
  if (!channel || !provider) throw new AppError(404, "Not found.");
  const result = provider.verifyWebhookGet(req.query || {}, { verifyToken: channel.connector.verifyToken });
  if (!result.ok) throw new AppError(403, "Verification failed.");
  res.status(200).type("text/plain").send(result.challenge);
});

exports.receive = asyncHandler(async (req, res) => {
  const channel = await connectorService.findChannelByWebhookKey(req.params.webhookKey);
  const provider = channel && getProvider(channel.type);
  if (!channel || !provider) throw new AppError(404, "Not found.");

  if (!webhookLimiter.check(String(req.params.webhookKey)).allowed) throw new AppError(429, "Too many requests.");

  let creds;
  try {
    creds = connectorService.decryptCredentials(channel);
  } catch (error) {
    throw new AppError(503, "Channel credentials are unavailable.");
  }
  if (!creds) throw new AppError(403, "This channel is not configured.");

  const url = `${publicBaseUrl(req)}${String(req.originalUrl).split("?")[0]}`;
  const authentic = provider.verifyWebhookPost({ rawBody: req.rawBody, headers: req.headers, creds, url, body: req.body });
  if (!authentic) throw new AppError(403, "Invalid signature.");

  const parsed = provider.parseInbound(req.body, req.rawBody);

  // Acknowledge first: providers retry (and eventually disable) webhooks that answer slowly.
  if (provider.replyBody) res.status(200).type(provider.replyContentType || "text/plain").send(provider.replyBody);
  else res.status(200).json({ success: true });

  if (channel.status !== "active") return;
  setImmediate(() => {
    processInbound({ channel, creds, provider, parsed }).catch((error) => {
      logger.error(`Inbound ${channel.type} processing failed:`, error && error.message);
    });
  });
});
