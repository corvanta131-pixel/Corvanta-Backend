const crypto = require("crypto");
const Channel = require("../../models/Channel");
const AIAgent = require("../../models/AIAgent");
const AppError = require("../../utils/AppError");
const { validateObjectId } = require("../../validators/commonValidator");
const { isConfigured, encryptJson, decryptJson } = require("../../utils/credentialCrypto");
const { getProvider } = require("./providers");
const { ConnectorError } = require("./core");

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function lastFour(value) {
  const text = String(value || "");
  return text.length <= 4 ? "••••" : `••••${text.slice(-4)}`;
}

/** What the dashboard may show about the saved values: plain values for non-secrets, a hint for secrets. */
function buildDisplay(provider, creds) {
  const display = {};
  for (const field of provider.fields) {
    if (!creds[field.name]) continue;
    display[field.name] = field.secret ? lastFour(creds[field.name]) : creds[field.name];
  }
  return display;
}

function decryptCredentials(channel) {
  const stored = channel.connector && channel.connector.credentials;
  if (!stored) return null;
  try {
    return decryptJson(stored);
  } catch (error) {
    throw new AppError(503, "The saved credentials cannot be read. Check CHANNEL_CREDENTIAL_KEY or save the credentials again.");
  }
}

async function loadChannel(companyId, channelId, { withCredentials = false } = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  validateObjectId(channelId, "channelId");
  let query = Channel.findOne({ _id: channelId, companyId, isDeleted: false });
  if (withCredentials) query = query.select("+connector.credentials");
  const channel = await query;
  if (!channel) throw new AppError(404, "Channel not found.");
  const provider = getProvider(channel.type);
  if (!provider) {
    throw new AppError(400, channel.type === "webchat" ? "Website chat is configured on its own page." : "This channel type has no messaging connector.");
  }
  return { channel, provider };
}

async function adminView(channel, provider, baseUrl) {
  const connector = channel.connector || {};
  const display = connector.display || {};
  const agent = connector.agentId
    ? await AIAgent.findOne({ _id: connector.agentId, companyId: channel.companyId, isDeleted: false }).select("_id name status").lean()
    : null;
  const credentialsSaved = provider.fields.filter((f) => f.required).every((f) => display[f.name]);
  const enabled = channel.status === "active";
  const lastTest = connector.lastTest || null;
  const aiReplies = connector.aiReplies !== false;

  const problems = [];
  if (!isConfigured()) problems.push("Credential storage is not configured on the server (CHANNEL_CREDENTIAL_KEY), so credentials cannot be saved.");
  if (!credentialsSaved) problems.push(`Enter and save your ${provider.label} credentials.`);
  else if (!lastTest || !lastTest.ok) problems.push(lastTest ? `The last connection test failed: ${lastTest.message}` : "Press Test connection to confirm the credentials work.");
  if (aiReplies && !agent) problems.push("Choose an AI agent, or turn AI replies off so your team answers.");
  else if (aiReplies && agent && agent.status !== "active") problems.push(`The selected agent is "${agent.status}". Activate it so it can reply.`);
  if (!enabled) problems.push("The channel is switched off.");

  return {
    channelId: String(channel._id),
    type: channel.type,
    label: provider.label,
    status: channel.status,
    enabled,
    storageReady: isConfigured(),
    credentialsSaved,
    verified: Boolean(lastTest && lastTest.ok),
    ready: problems.length === 0,
    problems,
    fields: provider.fields.map((f) => ({
      name: f.name,
      label: f.label,
      secret: f.secret,
      required: f.required,
      help: f.help,
      configured: Boolean(display[f.name]),
      display: display[f.name] || null,
    })),
    webhook: {
      url: connector.webhookKey ? `${baseUrl}/api/v1/webhooks/c/${connector.webhookKey}` : null,
      verifyToken: provider.usesVerifyToken && connector.verifyToken ? connector.verifyToken : null,
      needsSigningSecret: Boolean(provider.usesSigningSecret),
    },
    settings: {
      agentId: connector.agentId ? String(connector.agentId) : null,
      agentName: agent ? agent.name : null,
      agentStatus: agent ? agent.status : null,
      aiReplies,
    },
    lastTest: lastTest ? { ok: Boolean(lastTest.ok), at: lastTest.at, message: lastTest.message } : null,
  };
}

async function getConnectorView(companyId, channelId, baseUrl) {
  const { channel, provider } = await loadChannel(companyId, channelId);
  return adminView(channel, provider, baseUrl);
}

/**
 * Saves credentials (blank fields keep their current value), the AI settings and the on/off switch.
 * The only time a generated secret is returned is `revealed.signingSecret`, once, when it is created.
 */
async function saveConnector(companyId, channelId, payload = {}, baseUrl) {
  const { channel, provider } = await loadChannel(companyId, channelId, { withCredentials: true });
  const connector = channel.toObject().connector || {};
  const revealed = {};
  let credentialsChanged = false;

  if (payload.credentials !== undefined) {
    if (typeof payload.credentials !== "object" || payload.credentials === null || Array.isArray(payload.credentials)) {
      throw new AppError(400, "credentials must be an object.");
    }
    if (!isConfigured()) {
      throw new AppError(503, "Credential storage is not configured on the server (CHANNEL_CREDENTIAL_KEY), so credentials cannot be saved.");
    }
    const existing = decryptCredentials(channel) || {};
    const merged = { ...existing };
    for (const field of provider.fields) {
      const value = payload.credentials[field.name];
      if (typeof value === "string" && value.trim() !== "") merged[field.name] = value.trim();
    }
    const valid = provider.validateCredentials(merged);
    const next = { ...valid };
    if (provider.usesSigningSecret) {
      next.inboundSecret = existing.inboundSecret || randomToken(32);
      if (!existing.inboundSecret) revealed.signingSecret = next.inboundSecret;
    }
    connector.credentials = encryptJson(next);
    connector.display = buildDisplay(provider, next);
    connector.lastTest = undefined;
    credentialsChanged = true;
  }

  if (payload.agentId !== undefined) {
    if (payload.agentId === null || payload.agentId === "") {
      connector.agentId = undefined;
    } else {
      validateObjectId(payload.agentId, "agentId");
      const agent = await AIAgent.findOne({ _id: payload.agentId, companyId, isDeleted: false }).select("_id").lean();
      if (!agent) throw new AppError(403, "Agent not found or does not belong to your company.");
      connector.agentId = String(payload.agentId);
    }
  }

  if (payload.aiReplies !== undefined) {
    if (typeof payload.aiReplies !== "boolean") throw new AppError(400, "aiReplies must be true or false.");
    connector.aiReplies = payload.aiReplies;
  }

  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== "boolean") throw new AppError(400, "enabled must be true or false.");
    if (payload.enabled && !connector.credentials && !(channel.connector && channel.connector.credentials)) {
      throw new AppError(400, "Save your credentials before switching this channel on.");
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!connector.webhookKey || attempt > 0) connector.webhookKey = `ck_${randomToken(18)}`;
    if (!connector.verifyToken) connector.verifyToken = randomToken(24);
    channel.connector = connector;
    channel.markModified("connector");
    if (payload.enabled !== undefined) channel.status = payload.enabled ? "active" : "inactive";
    try {
      await channel.save();
      break;
    } catch (error) {
      if (error && error.code === 11000 && attempt < 2) continue;
      throw error;
    }
  }

  const view = await adminView(channel, provider, baseUrl);
  return { view, revealed, credentialsChanged };
}

/** Calls the provider with the saved credentials and records the honest outcome. */
async function testConnector(companyId, channelId, baseUrl) {
  const { channel, provider } = await loadChannel(companyId, channelId, { withCredentials: true });
  const creds = decryptCredentials(channel);
  if (!creds) throw new AppError(400, "Save your credentials before testing the connection.");

  let outcome;
  try {
    const result = await provider.testConnection(creds);
    outcome = { ok: true, message: result.detail };
  } catch (error) {
    const message = error instanceof ConnectorError ? error.message : "The connection test could not be completed.";
    outcome = { ok: false, message };
  }

  const connector = channel.toObject().connector || {};
  connector.lastTest = { ok: outcome.ok, at: new Date().toISOString(), message: outcome.message };
  channel.connector = connector;
  channel.markModified("connector");
  if (!outcome.ok && channel.status === "active") channel.status = "error";
  if (outcome.ok && channel.status === "error") channel.status = "inactive";
  await channel.save();
  return { view: await adminView(channel, provider, baseUrl), ok: outcome.ok };
}

async function rotateSigningSecret(companyId, channelId, baseUrl) {
  const { channel, provider } = await loadChannel(companyId, channelId, { withCredentials: true });
  if (!provider.usesSigningSecret) throw new AppError(400, "This channel does not use a signing secret.");
  const creds = decryptCredentials(channel);
  if (!creds) throw new AppError(400, "Save your credentials first.");
  creds.inboundSecret = randomToken(32);
  const connector = channel.toObject().connector || {};
  connector.credentials = encryptJson(creds);
  channel.connector = connector;
  channel.markModified("connector");
  await channel.save();
  return { view: await adminView(channel, provider, baseUrl), signingSecret: creds.inboundSecret };
}

/** Removes saved credentials and switches the channel off. The webhook address stays the same. */
async function clearConnector(companyId, channelId, baseUrl) {
  const { channel, provider } = await loadChannel(companyId, channelId, { withCredentials: true });
  const connector = channel.toObject().connector || {};
  connector.credentials = undefined;
  connector.display = undefined;
  connector.lastTest = undefined;
  channel.connector = connector;
  channel.markModified("connector");
  channel.status = "inactive";
  await channel.save();
  return adminView(channel, provider, baseUrl);
}

async function findChannelByWebhookKey(webhookKey) {
  if (typeof webhookKey !== "string" || !/^ck_[0-9a-f]{20,64}$/.test(webhookKey)) return null;
  return Channel.findOne({ "connector.webhookKey": webhookKey, isDeleted: false }).select("+connector.credentials");
}

module.exports = {
  getConnectorView,
  saveConnector,
  testConnector,
  rotateSigningSecret,
  clearConnector,
  findChannelByWebhookKey,
  decryptCredentials,
  buildDisplay,
};
