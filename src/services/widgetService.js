const crypto = require("crypto");
const Channel = require("../models/Channel");
const Conversation = require("../models/Conversation");
const Customer = require("../models/Customer");
const CustomerIdentity = require("../models/CustomerIdentity");
const AIAgent = require("../models/AIAgent");
const Message = require("../models/Message");
const AppError = require("../utils/AppError");
const logger = require("../utils/logger");
const { validateObjectId } = require("../validators/commonValidator");
const { sendConversationMessage } = require("./aiConversationService");
const { createMessage } = require("./messageService");
const { checkAIRateLimit } = require("../middleware/aiRateLimit");
const { logAudit } = require("./auditService");
const { signWidgetToken, verifyWidgetToken } = require("./widgetTokenService");

const MAX_ORIGINS = 10;
const MAX_MESSAGE_CHARS = 2000;
const MESSAGE_PAGE = 50;
const DEFAULTS = {
  title: "Chat with us",
  welcomeMessage: "Hi! How can we help you today?",
  color: "#4f46e5",
};
const WIDGET_KEY_PATTERN = /^wk_[A-Za-z0-9_-]{10,64}$/;
const ROLE_BY_SENDER = { customer: "visitor", agent: "assistant", user: "team" };

function generateWidgetKey() {
  return `wk_${crypto.randomBytes(18).toString("base64url")}`;
}

function normalizeOrigin(value) {
  if (typeof value !== "string") throw new AppError(400, "Each allowed website must be text.");
  const trimmed = value.trim().replace(/\/$/, "");
  let url;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new AppError(400, `"${value}" is not a valid website address.`);
  }
  const hasExtras = (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password;
  if (!["http:", "https:"].includes(url.protocol) || hasExtras) {
    throw new AppError(400, `Use only the scheme and host, for example https://example.com (got "${value}").`);
  }
  return url.origin;
}

/** Validates and normalises the widget settings payload. Unknown fields are ignored. */
function validateWidgetSettings(payload = {}) {
  const settings = {};

  if (payload.allowedOrigins !== undefined) {
    if (!Array.isArray(payload.allowedOrigins) || payload.allowedOrigins.length > MAX_ORIGINS) {
      throw new AppError(400, `allowedOrigins must be a list of at most ${MAX_ORIGINS} websites.`);
    }
    settings.allowedOrigins = Array.from(new Set(payload.allowedOrigins.map(normalizeOrigin)));
  }

  if (payload.title !== undefined) {
    const title = String(payload.title).trim();
    if (title.length < 1 || title.length > 60) throw new AppError(400, "Title must be 1-60 characters.");
    settings.title = title;
  }

  if (payload.welcomeMessage !== undefined) {
    const welcome = String(payload.welcomeMessage).trim();
    if (welcome.length > 300) throw new AppError(400, "Welcome message must be at most 300 characters.");
    settings.welcomeMessage = welcome;
  }

  if (payload.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(payload.color))) {
      throw new AppError(400, "Color must be a hex value like #4f46e5.");
    }
    settings.color = String(payload.color).toLowerCase();
  }

  if (payload.agentId !== undefined && payload.agentId !== null && payload.agentId !== "") {
    validateObjectId(payload.agentId, "agentId");
    settings.agentId = String(payload.agentId);
  } else if (payload.agentId === null || payload.agentId === "") {
    settings.agentId = null;
  }

  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== "boolean") throw new AppError(400, "enabled must be true or false.");
    settings.enabled = payload.enabled;
  }

  settings.rotateKey = payload.rotateKey === true;
  return settings;
}

function embedSnippet(baseUrl, key) {
  return `<script src="${baseUrl}/api/v1/widget/embed.js" data-key="${key}" async></script>`;
}

async function getActiveAgentFor(channel) {
  const agentId = channel.widget && channel.widget.agentId;
  if (!agentId) return null;
  return AIAgent.findOne({ _id: agentId, companyId: channel.companyId, status: "active", isDeleted: false })
    .select("_id")
    .lean();
}

async function adminView(channel, baseUrl) {
  const widget = channel.widget || {};
  const agent = widget.agentId
    ? await AIAgent.findOne({ _id: widget.agentId, companyId: channel.companyId, isDeleted: false })
        .select("_id name status")
        .lean()
    : null;
  const origins = Array.isArray(widget.allowedOrigins) ? Array.from(widget.allowedOrigins) : [];
  const enabled = channel.status === "active";
  const agentReady = Boolean(agent && agent.status === "active");

  const problems = [];
  if (!widget.key) problems.push("The widget has not been set up yet.");
  if (!agent) problems.push("Choose an AI agent to answer visitors.");
  else if (!agentReady) problems.push(`The selected agent is "${agent.status}". Set it to active so it can reply.`);
  if (origins.length === 0) problems.push("Add the website address where the chat will appear.");
  if (!enabled) problems.push("The widget is switched off.");

  return {
    channelId: String(channel._id),
    enabled,
    ready: widget.key ? problems.length === 0 : false,
    problems,
    widget: {
      key: widget.key || null,
      allowedOrigins: origins,
      agentId: widget.agentId ? String(widget.agentId) : null,
      agentName: agent ? agent.name : null,
      agentStatus: agent ? agent.status : null,
      title: widget.title || DEFAULTS.title,
      welcomeMessage: widget.welcomeMessage === undefined ? DEFAULTS.welcomeMessage : widget.welcomeMessage,
      color: widget.color || DEFAULTS.color,
    },
    embedSnippet: widget.key ? embedSnippet(baseUrl, widget.key) : null,
  };
}

async function loadWebchatChannel(companyId, channelId) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  validateObjectId(channelId, "channelId");
  const channel = await Channel.findOne({ _id: channelId, companyId, isDeleted: false });
  if (!channel) throw new AppError(404, "Channel not found.");
  if (channel.type !== "webchat") throw new AppError(400, "Widget settings only apply to web chat channels.");
  return channel;
}

async function getWidgetSettings(companyId, channelId, baseUrl) {
  const channel = await loadWebchatChannel(companyId, channelId);
  return adminView(channel, baseUrl);
}

async function saveWidgetSettings(companyId, channelId, payload, baseUrl) {
  const channel = await loadWebchatChannel(companyId, channelId);
  const settings = validateWidgetSettings(payload);

  if (settings.agentId) {
    const agent = await AIAgent.findOne({ _id: settings.agentId, companyId, isDeleted: false }).select("_id").lean();
    if (!agent) throw new AppError(403, "Agent not found or does not belong to your company.");
  }

  const current = channel.toObject().widget || {};
  const next = {
    key: current.key,
    allowedOrigins: settings.allowedOrigins !== undefined ? settings.allowedOrigins : current.allowedOrigins || [],
    agentId: settings.agentId !== undefined ? settings.agentId || undefined : current.agentId,
    title: settings.title !== undefined ? settings.title : current.title,
    welcomeMessage: settings.welcomeMessage !== undefined ? settings.welcomeMessage : current.welcomeMessage,
    color: settings.color !== undefined ? settings.color : current.color,
  };

  const rotated = Boolean(next.key) && settings.rotateKey;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!next.key || settings.rotateKey || attempt > 0) next.key = generateWidgetKey();
    channel.widget = next;
    channel.markModified("widget");
    if (settings.enabled !== undefined) channel.status = settings.enabled ? "active" : "inactive";
    try {
      await channel.save();
      break;
    } catch (error) {
      if (error && error.code === 11000 && attempt < 2) continue;
      throw error;
    }
  }

  return { view: await adminView(channel, baseUrl), rotated };
}

async function getChannelByWidgetKey(key) {
  if (typeof key !== "string" || !WIDGET_KEY_PATTERN.test(key)) return null;
  return Channel.findOne({ type: "webchat", "widget.key": key, isDeleted: false }).lean();
}

function assertActive(channel) {
  if (channel.status !== "active") throw new AppError(503, "Chat is not available right now.");
}

async function getPublicConfig(channel) {
  const widget = channel.widget || {};
  const agent = channel.status === "active" ? await getActiveAgentFor(channel) : null;
  return {
    available: Boolean(agent),
    title: widget.title || DEFAULTS.title,
    welcomeMessage: widget.welcomeMessage === undefined ? DEFAULTS.welcomeMessage : widget.welcomeMessage,
    color: widget.color || DEFAULTS.color,
  };
}

function toWidgetMessage(message) {
  return {
    id: String(message._id),
    role: ROLE_BY_SENDER[message.senderType],
    body: message.body,
    createdAt: message.createdAt,
  };
}

function cleanVisitorName(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
}

async function recentMessages(companyId, conversationId, extra = {}) {
  const rows = await Message.find({
    companyId,
    conversationId,
    isDeleted: false,
    senderType: { $in: Object.keys(ROLE_BY_SENDER) },
    ...extra,
  })
    .sort({ createdAt: extra.createdAt ? 1 : -1 })
    .limit(MESSAGE_PAGE)
    .lean();
  if (!extra.createdAt) rows.reverse();
  return rows.map(toWidgetMessage);
}

/** Starts a brand-new visitor conversation. */
async function createSession(channel, { name } = {}) {
  assertActive(channel);
  const agent = await getActiveAgentFor(channel);
  if (!agent) throw new AppError(503, "Chat is not available right now.");

  const visitorId = crypto.randomUUID();
  const companyId = channel.companyId;
  let customer;
  try {
    customer = await Customer.create({
      companyId,
      name: cleanVisitorName(name) || `Website visitor ${visitorId.slice(0, 4)}`,
      status: "prospect",
      metadata: { source: "webchat" },
      isDeleted: false,
      deletedAt: null,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      logger.error(
        "Widget could not create a visitor customer (duplicate empty email). " +
          "Run scripts/migrate-owner-role-and-customer-index.js to replace the old customer email index."
      );
      throw new AppError(503, "Chat is temporarily unavailable.");
    }
    throw error;
  }

  await CustomerIdentity.create({
    companyId,
    customerId: customer._id,
    channelType: "webchat",
    externalId: visitorId,
    isDeleted: false,
    deletedAt: null,
  });

  const conversation = await Conversation.create({
    companyId,
    customerId: customer._id,
    agentId: agent._id,
    participantIds: [],
    channelType: "webchat",
    channelId: channel._id,
    externalConversationId: `widget:${visitorId}`,
    handlingMode: "AI",
    title: "Website chat",
    status: "open",
    metadata: { source: "widget" },
    isDeleted: false,
    deletedAt: null,
  });

  await logAudit({
    user: null,
    companyId,
    action: "widget.session.started",
    entityType: "Conversation",
    entityId: String(conversation._id),
    metadata: { channelId: String(channel._id) },
  });

  const token = signWidgetToken({
    channelId: channel._id,
    companyId,
    customerId: customer._id,
    conversationId: conversation._id,
    visitorId,
  });
  return { token, messages: [] };
}

/** Validates a token against this channel and returns the visitor's own conversation. */
async function authorizeVisitor(channel, token) {
  const claims = verifyWidgetToken(token);
  if (claims.channelId !== String(channel._id) || claims.companyId !== String(channel.companyId)) {
    throw new AppError(401, "Your chat session has expired. Please start a new chat.");
  }
  const conversation = await Conversation.findOne({
    _id: claims.conversationId,
    companyId: claims.companyId,
    channelId: channel._id,
    isDeleted: false,
  });
  if (!conversation) throw new AppError(401, "Your chat session has expired. Please start a new chat.");
  return { claims, conversation };
}

async function resumeSession(channel, token) {
  const { claims, conversation } = await authorizeVisitor(channel, token);
  assertActive(channel);
  return { token, messages: await recentMessages(claims.companyId, conversation._id) };
}

async function listVisitorMessages(channel, token, after) {
  const { claims, conversation } = await authorizeVisitor(channel, token);
  const parsed = after ? new Date(after) : null;
  const extra = parsed && !Number.isNaN(parsed.getTime()) ? { createdAt: { $gt: parsed } } : {};
  return { messages: await recentMessages(claims.companyId, conversation._id, extra) };
}

async function sendVisitorMessage(channel, token, rawBody) {
  const { claims, conversation } = await authorizeVisitor(channel, token);
  assertActive(channel);

  const body = typeof rawBody === "string" ? rawBody.trim() : "";
  if (!body) throw new AppError(400, "Message cannot be empty.");
  if (body.length > MAX_MESSAGE_CHARS) {
    throw new AppError(400, `Message must be at most ${MAX_MESSAGE_CHARS} characters.`);
  }
  if (conversation.status === "archived") {
    throw new AppError(409, "This chat has ended. Please start a new chat.");
  }
  if (conversation.status !== "open") {
    conversation.status = "open";
    await conversation.save();
  }

  const companyId = claims.companyId;
  const marker = new Date();
  const actor = { _id: claims.customerId, companyId, role: { slug: "customer" } };
  const payload = { body, senderType: "customer" };
  let replyStatus = "answered";

  const storeCustomerMessage = async () => {
    const existing = await Message.findOne({
      companyId,
      conversationId: conversation._id,
      senderType: "customer",
      createdAt: { $gte: marker },
    }).lean();
    if (!existing) await createMessage(companyId, conversation._id, payload, actor);
  };

  if (conversation.handlingMode === "AI") {
    if (!checkAIRateLimit(companyId).allowed) {
      await storeCustomerMessage();
      replyStatus = "busy";
    } else {
      try {
        await sendConversationMessage(companyId, conversation._id, payload, actor, { useSemantic: false });
      } catch (error) {
        logger.error("Widget AI reply failed:", error && error.message);
        await storeCustomerMessage();
        replyStatus = "unavailable";
      }
    }
  } else {
    await createMessage(companyId, conversation._id, payload, actor);
    replyStatus = "waiting_for_team";
  }

  const messages = await recentMessages(companyId, conversation._id, { createdAt: { $gte: marker } });
  return { messages, replyStatus };
}

module.exports = {
  DEFAULTS,
  MAX_MESSAGE_CHARS,
  generateWidgetKey,
  normalizeOrigin,
  validateWidgetSettings,
  embedSnippet,
  getWidgetSettings,
  saveWidgetSettings,
  getChannelByWidgetKey,
  getPublicConfig,
  createSession,
  resumeSession,
  listVisitorMessages,
  sendVisitorMessage,
  toWidgetMessage,
};
