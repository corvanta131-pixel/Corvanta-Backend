const asyncHandler = require("../utils/asyncHandler");
const { validateObjectId } = require("../validators/commonValidator");
const { validateChannelInput } = require("../validators/domainValidator");
const { logAudit } = require("../services/auditService");
const {
  listChannels,
  getChannelById,
  createChannel,
  updateChannel,
  deleteChannel,
  connectChannel,
  disconnectChannel,
  getConnectionStatus,
  retryChannelConnection,
} = require("../services/channelService");

const CREDENTIAL_KEY_FRAGMENTS = [
  "secret",
  "password",
  "privatekey",
  "credential",
  "credentials",
  "authorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "authtoken",
  "authkey",
  "webhookpath",
];

function isCredentialKey(key) {
  const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return CREDENTIAL_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment)) ||
    normalizedKey === "token" ||
    normalizedKey.endsWith("token");
}

function sanitizeObject(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const sanitized = {};
  Object.entries(value).forEach(([key, nestedValue]) => {
    if (!isCredentialKey(key)) {
      sanitized[key] = sanitizeObject(nestedValue);
    }
  });
  return sanitized;
}

function sanitizeChannelResponse(channel) {
  const result = JSON.parse(JSON.stringify(channel));
  result.externalConfig = sanitizeObject(result.externalConfig || {});
  if (result.configuration) {
    result.configuration = sanitizeObject(result.configuration);
  }
  if (result.metadata) {
    result.metadata = sanitizeObject(result.metadata);
  }
  return result;
}

exports.listChannels = asyncHandler(async (req, res) => {
  const filters = req.query || {};
  const channels = await listChannels(req.user.companyId, filters);
  const sanitizedChannels = channels.map(sanitizeChannelResponse);

  res.status(200).json({
    success: true,
    data: sanitizedChannels,
  });
});

exports.getChannel = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "channelId");
  const channel = await getChannelById(req.user.companyId, req.params.id);
  const sanitizedChannel = sanitizeChannelResponse(channel);

  res.status(200).json({
    success: true,
    data: sanitizedChannel,
  });
});

exports.createChannel = asyncHandler(async (req, res) => {
  validateChannelInput(req.body);
  const channel = await createChannel(req.user.companyId, req.body);
  const sanitizedChannel = sanitizeChannelResponse(channel);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.created",
    entityType: "Channel",
    entityId: String(channel._id),
    metadata: { channelName: channel.name, channelType: channel.type },
  });

  res.status(201).json({
    success: true,
    message: "Channel created successfully.",
    data: sanitizedChannel,
  });
});

exports.updateChannel = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "channelId");
  validateChannelInput(req.body, { isUpdate: true });
  const channel = await updateChannel(req.user.companyId, req.params.id, req.body);
  const sanitizedChannel = sanitizeChannelResponse(channel);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.updated",
    entityType: "Channel",
    entityId: String(channel._id),
    metadata: { channelName: channel.name, channelType: channel.type },
  });

  res.status(200).json({
    success: true,
    message: "Channel updated successfully.",
    data: sanitizedChannel,
  });
});

exports.deleteChannel = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "channelId");
  const channel = await deleteChannel(req.user.companyId, req.params.id);
  const sanitizedChannel = sanitizeChannelResponse(channel);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.deleted",
    entityType: "Channel",
    entityId: String(channel._id),
  });

  res.status(200).json({
    success: true,
    message: "Channel deleted successfully.",
    data: sanitizedChannel,
  });
});

exports.connectChannel = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "channelId");
  const options = { simulateFailure: req.body?.simulateFailure === true };
  const { channel, adapterResult } = await connectChannel(req.user.companyId, req.params.id, options);
  const sanitizedChannel = sanitizeChannelResponse(channel);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: channel.status === "active" ? "channel.connected" : "channel.connection.failed",
    entityType: "Channel",
    entityId: String(channel._id),
    metadata: {
      channelType: channel.type,
      channelStatus: channel.status,
      success: adapterResult.success,
    },
  });

  res.status(channel.status === "active" ? 200 : 202).json({
    success: true,
    message: channel.status === "active" ? "Channel connected successfully." : "Channel connection failed; status set to error.",
    data: sanitizedChannel,
    connection: { success: adapterResult.success, adapter: adapterResult.adapter, error: adapterResult.error || null },
  });
});

exports.disconnectChannel = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "channelId");
  const { channel, alreadyDisconnected } = await disconnectChannel(req.user.companyId, req.params.id);
  const sanitizedChannel = sanitizeChannelResponse(channel);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "channel.disconnected",
    entityType: "Channel",
    entityId: String(channel._id),
    metadata: { channelType: channel.type, alreadyDisconnected },
  });

  res.status(200).json({
    success: true,
    message: alreadyDisconnected ? "Channel was already disconnected." : "Channel disconnected successfully.",
    data: sanitizedChannel,
  });
});

exports.getConnectionStatus = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "channelId");
  const status = await getConnectionStatus(req.user.companyId, req.params.id);

  res.status(200).json({
    success: true,
    data: status,
  });
});

exports.retryChannelConnection = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "channelId");
  const options = { simulateFailure: req.body?.simulateFailure === true };
  const { channel, adapterResult } = await retryChannelConnection(req.user.companyId, req.params.id, options);
  const sanitizedChannel = sanitizeChannelResponse(channel);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: channel.status === "active" ? "channel.reconnected" : "channel.reconnection.failed",
    entityType: "Channel",
    entityId: String(channel._id),
    metadata: {
      channelType: channel.type,
      channelStatus: channel.status,
      success: adapterResult.success,
    },
  });

  res.status(channel.status === "active" ? 200 : 202).json({
    success: true,
    message: channel.status === "active" ? "Channel reconnected successfully." : "Channel reconnection failed; status set to error.",
    data: sanitizedChannel,
    connection: { success: adapterResult.success, adapter: adapterResult.adapter, error: adapterResult.error || null },
  });
});