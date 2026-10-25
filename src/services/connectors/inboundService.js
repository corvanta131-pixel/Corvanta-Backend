const Channel = require("../../models/Channel");
const Conversation = require("../../models/Conversation");
const Customer = require("../../models/Customer");
const CustomerIdentity = require("../../models/CustomerIdentity");
const AIAgent = require("../../models/AIAgent");
const Message = require("../../models/Message");
const logger = require("../../utils/logger");
const { sendConversationMessage } = require("../aiConversationService");
const { checkAIRateLimit } = require("../../middleware/aiRateLimit");
const { getProvider } = require("./providers");
const { ConnectorError } = require("./core");
const { decryptCredentials } = require("./connectorService");

const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };
const inFlight = new Set();

function contactFromConversation(conversation) {
  const prefix = `${conversation.channelType}:`;
  const key = String(conversation.externalConversationId || "");
  return key.startsWith(prefix) ? key.slice(prefix.length) : "";
}

function subjectFrom(text) {
  const match = /^Subject: (.+)/.exec(text);
  return match ? match[1].trim().slice(0, 150) : "";
}

async function resolveCustomer(channel, provider, msg) {
  const companyId = channel.companyId;
  const identity = await CustomerIdentity.findOne({ companyId, channelType: channel.type, externalId: msg.externalId, isDeleted: false }).lean();
  if (identity) {
    const existing = await Customer.findOne({ _id: identity.customerId, companyId, isDeleted: false }).lean();
    if (existing) return existing;
  }

  let customer = null;
  if (channel.type === "email") {
    customer = await Customer.findOne({ companyId, email: msg.externalId, isDeleted: false }).lean();
  }
  if (!customer) {
    const phoneLike = channel.type === "sms" || channel.type === "whatsapp";
    customer = await Customer.create({
      companyId,
      name: msg.name || `${provider.label} contact ${String(msg.externalId).slice(-4)}`,
      status: "prospect",
      ...(channel.type === "email" ? { email: msg.externalId } : {}),
      ...(phoneLike ? { phone: msg.externalId.startsWith("+") ? msg.externalId : `+${msg.externalId}` } : {}),
      metadata: { source: channel.type },
      isDeleted: false,
      deletedAt: null,
    });
  }

  try {
    await CustomerIdentity.create({ companyId, customerId: customer._id, channelType: channel.type, externalId: msg.externalId, isDeleted: false, deletedAt: null });
  } catch (error) {
    if (!(error && error.code === 11000)) throw error;
  }
  return customer;
}

async function resolveConversation(channel, provider, customer, msg) {
  const companyId = channel.companyId;
  const key = `${channel.type}:${msg.externalId}`;
  let conversation = await Conversation.findOne({ companyId, channelType: channel.type, externalConversationId: key, isDeleted: false });
  if (conversation) {
    if (conversation.status !== "open") {
      conversation.status = "open";
      await conversation.save();
    }
    return conversation;
  }

  const connector = channel.connector || {};
  const wantsAI = connector.aiReplies !== false;
  const agent = wantsAI && connector.agentId
    ? await AIAgent.findOne({ _id: connector.agentId, companyId, status: "active", isDeleted: false }).select("_id").lean()
    : null;

  return Conversation.create({
    companyId,
    customerId: customer._id,
    agentId: agent ? agent._id : undefined,
    participantIds: [],
    channelType: channel.type,
    channelId: channel._id,
    externalConversationId: key,
    handlingMode: agent ? "AI" : "HUMAN",
    title: subjectFrom(msg.text) || provider.label,
    status: "open",
    metadata: { source: "connector" },
    isDeleted: false,
    deletedAt: null,
  });
}

/** Sends text through the provider and records what actually happened on the stored message. */
async function deliverText({ channel, creds, provider, conversation, text, messageId }) {
  const to = contactFromConversation(conversation);
  let outcome;
  try {
    if (!to) throw new ConnectorError("This conversation has no address to reply to.");
    const sent = await provider.send({ creds, to, text, subject: conversation.title ? `Re: ${conversation.title}` : undefined });
    outcome = { deliveryStatus: sent.status, externalMessageId: sent.providerMessageId, deliveryError: "" };
  } catch (error) {
    if (!(error instanceof ConnectorError)) logger.error(`Connector send failed unexpectedly (${channel.type}):`, error && error.message);
    outcome = { deliveryStatus: "failed", deliveryError: error instanceof ConnectorError ? error.message : "The message could not be sent." };
  }

  if (messageId) {
    try {
      await Message.updateOne(
        { _id: messageId, companyId: channel.companyId },
        { $set: { channelType: channel.type, channelId: channel._id, direction: "outbound", ...outcome } }
      );
    } catch (error) {
      if (!(error && error.code === 11000)) throw error;
      await Message.updateOne(
        { _id: messageId, companyId: channel.companyId },
        { $set: { channelType: channel.type, channelId: channel._id, direction: "outbound", deliveryStatus: outcome.deliveryStatus, deliveryError: outcome.deliveryError } }
      );
    }
  }
  return outcome;
}

async function markInbound(companyId, channel, messageId, msg) {
  try {
    await Message.updateOne(
      { _id: messageId, companyId },
      { $set: { channelType: channel.type, channelId: channel._id, direction: "inbound", externalMessageId: msg.messageId, senderIdentity: msg.externalId, deliveryStatus: "delivered" } }
    );
  } catch (error) {
    if (!(error && error.code === 11000)) throw error; // another copy of this message won the race
  }
}

async function processOne({ channel, creds, provider, msg }) {
  const companyId = channel.companyId;
  if (await Message.findOne({ companyId, channelType: channel.type, externalMessageId: msg.messageId }).select("_id").lean()) {
    return "duplicate";
  }

  const customer = await resolveCustomer(channel, provider, msg);
  const conversation = await resolveConversation(channel, provider, customer, msg);
  const actor = { _id: customer._id, companyId, role: { slug: "customer" } };
  const payload = { body: msg.text, senderType: "customer" };
  const marker = new Date();

  if (conversation.handlingMode === "AI" && conversation.agentId && checkAIRateLimit(companyId).allowed) {
    try {
      const result = await sendConversationMessage(companyId, conversation._id, payload, actor, { useSemantic: false });
      await markInbound(companyId, channel, result.userMessage._id, msg);
      if (result.assistantMessage && result.assistantMessage.body) {
        await deliverText({ channel, creds, provider, conversation, text: result.assistantMessage.body, messageId: result.assistantMessage._id });
      }
      return "answered";
    } catch (error) {
      logger.error(`AI reply failed for ${channel.type} message:`, error && error.message);
      // fall through: make sure the customer's message is stored so a person can answer it
    }
  }

  const stored = await Message.findOne({ companyId, conversationId: conversation._id, senderType: "customer", createdAt: { $gte: marker } }).select("_id").lean();
  if (stored) {
    await markInbound(companyId, channel, stored._id, msg);
  } else {
    try {
      const created = await Message.create({
        companyId,
        conversationId: conversation._id,
        customerId: customer._id,
        channelType: channel.type,
        channelId: channel._id,
        direction: "inbound",
        senderType: "customer",
        senderIdentity: msg.externalId,
        externalMessageId: msg.messageId,
        externalConversationId: conversation.externalConversationId,
        body: msg.text,
        deliveryStatus: "delivered",
        isDeleted: false,
        deletedAt: null,
      });
      conversation.lastMessageAt = created.createdAt || new Date();
      await conversation.save();
    } catch (error) {
      if (error && error.code === 11000) return "duplicate";
      throw error;
    }
  }
  return "stored";
}

/** Applies delivery receipts (WhatsApp sends sent / delivered / read / failed) to our outbound messages. */
async function applyStatuses(channel, statuses) {
  for (const s of statuses) {
    const status = ["sent", "delivered", "read", "failed"].includes(s.status) ? s.status : null;
    if (!status) continue;
    const filter = { companyId: channel.companyId, channelType: channel.type, externalMessageId: s.messageId, direction: "outbound" };
    if (status === "failed") {
      await Message.updateOne(filter, { $set: { deliveryStatus: "failed", deliveryError: s.error || "Delivery failed." } });
    } else {
      const lower = Object.keys(STATUS_RANK).filter((key) => STATUS_RANK[key] < STATUS_RANK[status]);
      await Message.updateOne({ ...filter, deliveryStatus: { $in: lower } }, { $set: { deliveryStatus: status, ...(status !== "sent" ? { deliveredAt: new Date() } : {}) } });
    }
  }
}

/** Handles everything a provider webhook delivered. Never throws: failures are logged per message. */
async function processInbound({ channel, creds, provider, parsed }) {
  const summary = { stored: 0, answered: 0, duplicate: 0, failed: 0 };
  for (const msg of parsed.messages || []) {
    const key = `${channel._id}:${msg.messageId}`;
    if (inFlight.has(key)) {
      summary.duplicate += 1;
      continue;
    }
    inFlight.add(key);
    try {
      const result = await processOne({ channel, creds, provider, msg });
      summary[result] += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error(`Could not process an inbound ${channel.type} message:`, error && error.message);
    } finally {
      inFlight.delete(key);
    }
  }
  try {
    await applyStatuses(channel, parsed.statuses || []);
  } catch (error) {
    logger.error(`Could not apply ${channel.type} delivery statuses:`, error && error.message);
  }
  return summary;
}

/** Delivers a team member's reply on the customer's own channel. Returns null for channels with no connector. */
async function deliverStaffReply(companyId, conversation, message) {
  const provider = getProvider(conversation.channelType);
  if (!provider) return null;

  const channel = await Channel.findOne({ companyId, type: conversation.channelType, isDeleted: false }).select("+connector.credentials");
  const fail = async (reason) => {
    await Message.updateOne(
      { _id: message._id, companyId },
      { $set: { channelType: conversation.channelType, direction: "outbound", deliveryStatus: "failed", deliveryError: reason } }
    );
    return { deliveryStatus: "failed", deliveryError: reason };
  };

  if (!channel || channel.status !== "active") return fail("This channel is switched off, so the reply was saved but not sent.");
  let creds;
  try {
    creds = decryptCredentials(channel);
  } catch (error) {
    return fail("The channel credentials cannot be read, so the reply was saved but not sent.");
  }
  if (!creds) return fail("This channel has no saved credentials, so the reply was saved but not sent.");
  return deliverText({ channel, creds, provider, conversation, text: message.body, messageId: message._id });
}

module.exports = { processInbound, deliverStaffReply, deliverText, applyStatuses, contactFromConversation };
