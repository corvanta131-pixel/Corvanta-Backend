const { AIProviderError } = require("../services/ai/aiService");
const AppError = require("../utils/AppError");

const CHANNEL_ADAPTERS = {
  email: { inbound: true, outbound: true },
  whatsapp: { inbound: true, outbound: true },
  instagram: { inbound: true, outbound: true },
  messenger: { inbound: true, outbound: true },
  webchat: { inbound: true, outbound: true },
  sms: { inbound: true, outbound: true },
};

const SUPPORTED_CHANNEL_TYPES = Object.keys(CHANNEL_ADAPTERS);

function isSupportedChannelType(channelType) {
  return SUPPORTED_CHANNEL_TYPES.includes(String(channelType).toLowerCase());
}

function hasConnectionConfig(channel) {
  const config = (channel && channel.externalConfig) || {};
  if (!config.webhookPath || !String(config.webhookPath).trim()) return false;
  if (!config.webhookSecret || !String(config.webhookSecret).trim()) return false;
  return true;
}

function normalizeInboundMessage(payload = {}) {
  const body = String(payload.body || payload.text || payload.message || "").trim();
  const externalId = String(payload.externalMessageId || payload.id || "").trim();
  const externalConversationId = String(payload.externalConversationId || payload.conversationId || payload.threadId || "").trim();
  const senderIdentity = String(payload.senderIdentity || payload.from || payload.phone || payload.email || "").trim();
  const channelType = String(payload.channelType || payload.type || "webchat").toLowerCase();

  if (!body && !externalId) {
    throw new AIProviderError("Inbound message requires body or external message ID.", "INVALID_INBOUND_MESSAGE", 400);
  }

  return {
    companyId: payload.companyId || null,
    conversationId: payload.conversationId || null,
    customerId: payload.customerId || null,
    channelType,
    externalMessageId: externalId || null,
    externalConversationId: externalConversationId || null,
    direction: "inbound",
    senderType: payload.senderType || "customer",
    senderId: payload.senderId || null,
    senderIdentity,
    body,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    metadata: payload.metadata || {},
  };
}

function normalizeOutboundMessage(payload = {}) {
  const body = String(payload.body || payload.text || "").trim();
  if (!body) {
    throw new AIProviderError("Outbound message requires body text.", "EMPTY_OUTBOUND_MESSAGE", 400);
  }

  return {
    companyId: payload.companyId || null,
    conversationId: payload.conversationId || null,
    customerId: payload.customerId || null,
    channelType: String(payload.channelType || "webchat").toLowerCase(),
    externalMessageId: payload.externalMessageId || null,
    direction: "outbound",
    senderType: payload.senderType || "agent",
    body,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    deliveryStatus: "pending",
    metadata: payload.metadata || {},
  };
}

async function mockAdapterSend({ channel, conversation, message, customer, options = {} }) {
  if (options.simulateFailure || channel.metadata?.simulateFailure) {
    return {
      success: false,
      externalMessageId: null,
      error: "Simulated adapter failure",
      processedAt: new Date().toISOString(),
    };
  }

  return {
    success: true,
    externalMessageId: `mock-${channel.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    processedAt: new Date().toISOString(),
  };
}

const ADAPTER_SEND_HANDLERS = {
  email: mockAdapterSend,
  whatsapp: mockAdapterSend,
  instagram: mockAdapterSend,
  messenger: mockAdapterSend,
  webchat: mockAdapterSend,
  sms: mockAdapterSend,
};

async function executeChannelAdapter(adapterName, operation, payload) {
  const adapter = CHANNEL_ADAPTERS[adapterName];
  if (!adapter) {
    throw new AIProviderError(`Unsupported channel adapter: ${adapterName}`, "CHANNEL_NOT_SUPPORTED", 400);
  }

  if (operation === "send" && !adapter.outbound) {
    throw new AIProviderError(`Channel ${adapterName} does not support outbound messages.`, "CHANNEL_OUTBOUND_NOT_SUPPORTED", 400);
  }

  if (operation === "receive" && !adapter.inbound) {
    throw new AIProviderError(`Channel ${adapterName} does not support inbound messages.`, "CHANNEL_INBOUND_NOT_SUPPORTED", 400);
  }

  return {
    adapter: adapterName,
    operation,
    success: true,
    processedAt: new Date().toISOString(),
  };
}

async function sendMessage({ channel, conversation, message, customer, options = {} }) {
  const adapterName = channel.type;
  const adapter = CHANNEL_ADAPTERS[adapterName];
  if (!adapter || !adapter.outbound) {
    throw new AppError(400, `Channel type ${adapterName} does not support outbound messages.`);
  }

  const handler = ADAPTER_SEND_HANDLERS[adapterName];
  if (!handler) {
    throw new AppError(500, `No send handler registered for adapter: ${adapterName}`);
  }

  const result = await handler({
    channel,
    conversation,
    message,
    customer,
    options,
  });

  return result;
}

async function mockChannelConnect({ channel, options = {} }) {
  if (options.simulateFailure || channel.metadata?.simulateFailure) {
    return {
      success: false,
      externalId: null,
      error: "Simulated connection failure",
      processedAt: new Date().toISOString(),
    };
  }

  if (!hasConnectionConfig(channel)) {
    return {
      success: false,
      externalId: null,
      error: "Channel is missing required connection configuration (webhookPath/webhookSecret).",
      processedAt: new Date().toISOString(),
    };
  }

  return {
    success: true,
    externalId: `mock-${channel.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    processedAt: new Date().toISOString(),
  };
}

const CHANNEL_CONNECT_HANDLERS = {
  email: mockChannelConnect,
  whatsapp: mockChannelConnect,
  instagram: mockChannelConnect,
  messenger: mockChannelConnect,
  webchat: mockChannelConnect,
  sms: mockChannelConnect,
};

async function connectChannelAdapter({ channel, options = {} }) {
  const adapterName = channel.type;
  if (!isSupportedChannelType(adapterName)) {
    throw new AppError(400, `Unsupported channel type for connection: ${adapterName}`);
  }

  const handler = CHANNEL_CONNECT_HANDLERS[adapterName];
  if (!handler) {
    throw new AppError(500, `No connect handler registered for adapter: ${adapterName}`);
  }

  const result = await handler({ channel, options });

  return {
    adapter: adapterName,
    operation: "connect",
    ...result,
  };
}

module.exports = {
  CHANNEL_ADAPTERS,
  CHANNEL_CONNECT_HANDLERS,
  SUPPORTED_CHANNEL_TYPES,
  isSupportedChannelType,
  hasConnectionConfig,
  mockChannelConnect,
  normalizeInboundMessage,
  normalizeOutboundMessage,
  executeChannelAdapter,
  sendMessage,
  connectChannelAdapter,
  ADAPTER_SEND_HANDLERS,
};
