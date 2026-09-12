const Channel = require("../models/Channel");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const config = require("../config/config");
const { connectChannelAdapter } = require("./channelAdapter");
const logger = require("../utils/logger");

function getCompanyScope(companyId) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  return { companyId };
}

async function listChannels(companyId, filters = {}) {
  const query = { ...getCompanyScope(companyId), isDeleted: false };
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;
  return Channel.find(query).sort({ createdAt: -1 }).lean();
}

async function getChannelById(companyId, channelId) {
  validateObjectId(channelId, "channelId");
  const channel = await Channel.findOne({ _id: channelId, ...getCompanyScope(companyId), isDeleted: false });
  if (!channel) throw new AppError(404, "Channel not found.");
  return channel;
}

async function getChannelByType(companyId, type) {
  const channel = await Channel.findOne({ ...getCompanyScope(companyId), type, isDeleted: false, status: "active" }).lean();
  if (!channel) throw new AppError(404, `No active channel found for type: ${type}`);
  return channel;
}

/**
 * Resolve an active channel by its webhook path identifier.
 *
 * The webhook path is a server-assigned, channel-specific identifier stored in
 * `channel.externalConfig.webhookPath`. It is effectively a shared secret:
 * only the channel owner knows it, and it cannot be used to select another
 * company's channel. No client-supplied `companyId` is trusted.
 *
 * @param {string} webhookPath
 * @returns {object} lean Channel document with populated `companyId`
 */
async function getChannelByWebhookPath(webhookPath) {
  if (!webhookPath || typeof webhookPath !== "string") {
    throw new AppError(400, "Invalid webhook path.");
  }
  const channel = await Channel.findOne({
    "externalConfig.webhookPath": webhookPath,
    isDeleted: false,
    status: "active",
  }).lean();
  if (!channel) {
    throw new AppError(404, "Channel not found for webhook path.");
  }
  return channel;
}

async function createChannel(companyId, payload) {
  const existing = await Channel.findOne({ companyId, type: payload.type, isDeleted: false });
  if (existing) throw new AppError(409, `A channel of type '${payload.type}' already exists for this company.`);

  const channel = await Channel.create({
    name: payload.name,
    type: payload.type,
    status: payload.status || "inactive",
    externalConfig: payload.externalConfig || {},
    metadata: payload.metadata || {},
    companyId,
    isDeleted: false,
    deletedAt: null,
  });
  return channel;
}

async function updateChannel(companyId, channelId, payload) {
  const channel = await getChannelById(companyId, channelId);
  
  const allowedFields = ["name", "status", "externalConfig", "metadata"];
  for (const field of allowedFields) {
    if (payload[field] !== undefined) channel[field] = payload[field];
  }
  
  await channel.save();
  return channel;
}

async function deleteChannel(companyId, channelId) {
  const channel = await getChannelById(companyId, channelId);
  channel.isDeleted = true;
  channel.deletedAt = new Date();
  await channel.save();
  return channel;
}

async function connectChannel(companyId, channelId, options = {}) {
  validateObjectId(channelId, "channelId");
  const channel = await getChannelById(companyId, channelId);

  if (channel.status === "active") {
    throw new AppError(409, "Channel is already connected.");
  }
  if (channel.status === "connecting") {
    throw new AppError(409, "Channel connection is already in progress.");
  }

  channel.status = "connecting";
  await channel.save();

  try {
    const result = await connectChannelAdapter({ channel, options });
    if (result.success) {
      channel.status = "active";
      channel.externalConfig = {
        ...(channel.externalConfig || {}),
        externalId: result.externalId,
        connectedAt: result.processedAt || new Date().toISOString(),
      };
      delete channel.externalConfig.connectionError;
      channel.markModified("externalConfig");
      await channel.save();
      return { channel, adapterResult: result };
    }

    channel.status = "error";
    channel.externalConfig = {
      ...(channel.externalConfig || {}),
      connectionError: result.error || "Connection failed.",
    };
    delete channel.externalConfig.connectedAt;
    delete channel.externalConfig.externalId;
    channel.markModified("externalConfig");
    await channel.save();
    return { channel, adapterResult: result };
  } catch (error) {
    channel.status = "error";
    channel.externalConfig = {
      ...(channel.externalConfig || {}),
      connectionError: error.message || "Connection error.",
    };
    channel.markModified("externalConfig");
    await channel.save();
    logger.error("Channel connection failed:", error.message);
    return { channel, adapterResult: { success: false, error: error.message || "Connection error.", processedAt: new Date().toISOString() } };
  }
}

async function disconnectChannel(companyId, channelId) {
  validateObjectId(channelId, "channelId");
  const channel = await getChannelById(companyId, channelId);

  if (channel.status === "inactive") {
    return { channel, alreadyDisconnected: true };
  }

  channel.status = "inactive";
  await channel.save();
  return { channel, alreadyDisconnected: false };
}

async function getConnectionStatus(companyId, channelId) {
  validateObjectId(channelId, "channelId");
  const channel = await getChannelById(companyId, channelId);
  const externalConfig = channel.externalConfig || {};
  return {
    channelId: String(channel._id),
    name: channel.name,
    type: channel.type,
    status: channel.status,
    connectedAt: externalConfig.connectedAt || null,
    externalId: externalConfig.externalId || null,
    lastError: externalConfig.connectionError || null,
    adapter: channel.type,
  };
}

async function retryChannelConnection(companyId, channelId, options = {}) {
  validateObjectId(channelId, "channelId");
  const channel = await getChannelById(companyId, channelId);

  if (channel.status !== "error") {
    throw new AppError(409, "Only a channel in 'error' status can be retried.");
  }

  return connectChannel(companyId, channelId, options);
}

module.exports = {
  listChannels,
  getChannelById,
  getChannelByType,
  getChannelByWebhookPath,
  createChannel,
  updateChannel,
  deleteChannel,
  connectChannel,
  disconnectChannel,
  getConnectionStatus,
  retryChannelConnection,
};