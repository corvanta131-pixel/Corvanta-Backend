process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/corvanta-test";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "test-access-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";
process.env.CHANNEL_CREDENTIAL_KEY = "a-test-credential-key-that-is-long-enough-123";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const src = path.join(__dirname, "..", "src");
const COMPANY = "64d3a8f2c54f4020a959c9aa";
const CHANNEL_ID = "64d3a8f2c54f4020a959c9c1";
const AGENT = "64d3a8f2c54f4020a959c9d1";

function stub(rel, exports) {
  const resolved = require.resolve(path.join(src, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function query(result) {
  const q = {
    select: () => q,
    lean: () => q,
    then: (resolve, reject) => Promise.resolve(typeof result === "function" ? result() : result).then(resolve, reject),
  };
  return q;
}

// ---- fake persistence ------------------------------------------------------------------------
const db = { messages: [], customers: [], identities: [], conversations: [], updates: [], aiCalls: [], channelDoc: null, agent: { _id: AGENT } };
const state = { aiThrows: false, aiAllowed: true, aiReply: "We open at 9am." };

stub("models/Message.js", {
  findOne: (filter) => query(() => db.messages.find((m) => Object.entries(filter).every(([k, v]) => (v && v.$gte ? m[k] >= v.$gte : m[k] === v))) || null),
  create: async (doc) => {
    if (doc.externalMessageId && db.messages.some((m) => m.channelType === doc.channelType && m.externalMessageId === doc.externalMessageId)) {
      throw Object.assign(new Error("dup"), { code: 11000 });
    }
    const created = { _id: `m${db.messages.length + 1}`, createdAt: new Date(), ...doc };
    db.messages.push(created);
    return created;
  },
  updateOne: async (filter, update) => {
    db.updates.push({ filter, update });
    const target = db.messages.find((m) => (filter._id ? m._id === filter._id : m.externalMessageId === filter.externalMessageId));
    if (target) Object.assign(target, update.$set);
    return { modifiedCount: target ? 1 : 0 };
  },
});
stub("models/Customer.js", {
  findOne: (filter) => query(() => db.customers.find((c) => (filter._id ? c._id === filter._id : c.email === filter.email)) || null),
  create: async (doc) => {
    const c = { _id: `cust${db.customers.length + 1}`, ...doc };
    db.customers.push(c);
    return c;
  },
});
stub("models/CustomerIdentity.js", {
  findOne: (filter) => query(() => db.identities.find((i) => i.channelType === filter.channelType && i.externalId === filter.externalId) || null),
  create: async (doc) => {
    db.identities.push(doc);
    return doc;
  },
});
stub("models/Conversation.js", {
  findOne: async (filter) => db.conversations.find((c) => c.externalConversationId === filter.externalConversationId) || null,
  create: async (doc) => {
    const c = { _id: `conv${db.conversations.length + 1}`, ...doc, async save() {} };
    db.conversations.push(c);
    return c;
  },
});
stub("models/AIAgent.js", { findOne: () => query(() => db.agent) });
stub("models/Channel.js", {
  findOne: () => {
    const q = query(() => db.channelDoc);
    return q;
  },
});
stub("services/aiConversationService.js", {
  sendConversationMessage: async (companyId, conversationId, payload) => {
    db.aiCalls.push({ companyId, conversationId, payload });
    if (state.aiThrows) throw new Error("provider down");
    const user = { _id: `m${db.messages.length + 1}`, createdAt: new Date(), companyId, conversationId, senderType: "customer", body: payload.body };
    db.messages.push(user);
    const reply = { _id: `m${db.messages.length + 1}`, createdAt: new Date(), companyId, conversationId, senderType: "agent", body: state.aiReply };
    db.messages.push(reply);
    return { userMessage: user, assistantMessage: reply };
  },
});
stub("middleware/aiRateLimit.js", { checkAIRateLimit: () => ({ allowed: state.aiAllowed }) });
stub("validators/commonValidator.js", {
  validateObjectId: (value, name = "id") => {
    if (!/^[a-f0-9]{24}$/i.test(String(value))) {
      const AppError = require(path.join(src, "utils", "AppError.js"));
      throw new AppError(400, `Valid ${name} is required.`);
    }
  },
});

const { encryptJson, decryptJson, isConfigured } = require(path.join(src, "utils", "credentialCrypto.js"));
const { getProvider, twilioSignature } = require(path.join(src, "services", "connectors", "providers.js"));
const { ConnectorError } = require(path.join(src, "services", "connectors", "core.js"));
const inbound = require(path.join(src, "services", "connectors", "inboundService.js"));
const connectorService = require(path.join(src, "services", "connectors", "connectorService.js"));

const hmac = (algo, secret, data) => crypto.createHmac(algo, secret).update(data).digest("hex");

function channelDoc(type, creds, over = {}) {
  const provider = getProvider(type);
  const doc = {
    _id: CHANNEL_ID,
    companyId: COMPANY,
    type,
    status: "active",
    connector: { webhookKey: "ck_" + "a".repeat(36), verifyToken: "verify-me", credentials: encryptJson(creds), display: connectorService.buildDisplay(provider, creds), agentId: AGENT, aiReplies: true },
    toObject() {
      return JSON.parse(JSON.stringify({ ...this, toObject: undefined, save: undefined, markModified: undefined }));
    },
    markModified() {},
    saved: 0,
    async save() {
      this.saved += 1;
    },
    ...over,
  };
  return doc;
}

function resetDb() {
  db.messages.length = 0;
  db.customers.length = 0;
  db.identities.length = 0;
  db.conversations.length = 0;
  db.updates.length = 0;
  db.aiCalls.length = 0;
  db.agent = { _id: AGENT };
  state.aiThrows = false;
  state.aiAllowed = true;
}

function stubFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, json = {} } = handler(String(url), init) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { calls, restore: () => (global.fetch = original) };
}

const WA = { phoneNumberId: "1234567890", accessToken: "EAAG" + "x".repeat(30), appSecret: "appsecret-0123456789" };
const PAGE = { pageAccessToken: "EAAG" + "y".repeat(30), appSecret: "appsecret-0123456789" };
const TW = { accountSid: "AC" + "a".repeat(32), authToken: "twilio-auth-token-123456", fromNumber: "+14155550123" };
const EM = { apiKey: "re_" + "k".repeat(20), fromAddress: "Support <support@shop.com>", inboundSecret: "inbound-secret-abcdef" };

// ---- credential storage ----------------------------------------------------------------------

test("credentials are encrypted, never stored in plain text, and tampering is detected", () => {
  assert.equal(isConfigured(), true);
  const stored = encryptJson(WA);
  assert.equal(stored.includes(WA.accessToken), false);
  assert.match(stored, /^v1:/);
  assert.deepEqual(decryptJson(stored), WA);
  assert.notEqual(encryptJson(WA), stored, "a fresh random IV every time");
  const parts = stored.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptJson(parts.join(":")));
  assert.throws(() => decryptJson("garbage"));
});

test("without CHANNEL_CREDENTIAL_KEY nothing can be encrypted", () => {
  const saved = process.env.CHANNEL_CREDENTIAL_KEY;
  process.env.CHANNEL_CREDENTIAL_KEY = "too-short";
  try {
    assert.equal(isConfigured(), false);
    assert.throws(() => encryptJson({ a: 1 }), /CHANNEL_CREDENTIAL_KEY/);
  } finally {
    process.env.CHANNEL_CREDENTIAL_KEY = saved;
  }
});

test("the admin view shows hints for secrets and values for non-secrets, never the secret itself", () => {
  const display = connectorService.buildDisplay(getProvider("sms"), TW);
  assert.equal(display.authToken, "••••3456");
  assert.equal(display.accountSid, TW.accountSid);
  assert.equal(JSON.stringify(display).includes(TW.authToken), false);
});

// ---- webhook authenticity ----------------------------------------------------------------------

test("Meta webhooks: the signature must match the exact raw body and app secret", () => {
  for (const type of ["whatsapp", "messenger", "instagram"]) {
    const provider = getProvider(type);
    const creds = type === "whatsapp" ? WA : PAGE;
    const raw = JSON.stringify({ object: "x", entry: [] });
    const good = `sha256=${hmac("sha256", creds.appSecret, raw)}`;
    assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: { "x-hub-signature-256": good }, creds }), true, type);
    assert.equal(provider.verifyWebhookPost({ rawBody: raw + " ", headers: { "x-hub-signature-256": good }, creds }), false, "altered body");
    assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: { "x-hub-signature-256": "sha256=00" }, creds }), false);
    assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: {}, creds }), false, "missing header");
  }
});

test("Meta subscription check answers only for the right token", () => {
  const provider = getProvider("whatsapp");
  assert.deepEqual(provider.verifyWebhookGet({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" }, { verifyToken: "verify-me" }), { ok: true, challenge: "12345" });
  assert.equal(provider.verifyWebhookGet({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }, { verifyToken: "verify-me" }).ok, false);
  assert.equal(provider.verifyWebhookGet({ "hub.mode": "subscribe", "hub.challenge": "1" }, { verifyToken: "verify-me" }).ok, false);
});

test("Twilio webhooks: signature covers the URL and every parameter", () => {
  const provider = getProvider("sms");
  const url = "https://api.example.com/api/v1/webhooks/c/ck_abc";
  const raw = "Body=Hi+there&From=%2B2348012345678&MessageSid=SM123&To=%2B14155550123";
  const params = { Body: "Hi there", From: "+2348012345678", MessageSid: "SM123", To: "+14155550123" };
  const signature = twilioSignature(TW.authToken, url, params);
  assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: { "x-twilio-signature": signature }, creds: TW, url }), true);
  assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: { "x-twilio-signature": signature }, creds: TW, url: url + "x" }), false, "different URL");
  assert.equal(provider.verifyWebhookPost({ rawBody: raw.replace("Hi+there", "Hacked"), headers: { "x-twilio-signature": signature }, creds: TW, url }), false);
  assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: {}, creds: TW, url }), false);
});

test("Email webhooks: HMAC of the raw body with the channel's signing secret", () => {
  const provider = getProvider("email");
  const raw = JSON.stringify({ from: "a@b.com", text: "hi", messageId: "1" });
  const good = `sha256=${hmac("sha256", EM.inboundSecret, raw)}`;
  assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: { "x-corvanta-signature": good }, creds: EM }), true);
  assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: { "x-corvanta-signature": "sha256=bad" }, creds: EM }), false);
  assert.equal(provider.verifyWebhookPost({ rawBody: raw, headers: {}, creds: { ...EM, inboundSecret: undefined } }), false);
});

// ---- parsing inbound payloads ---------------------------------------------------------------

test("WhatsApp: text messages, unsupported types and delivery statuses are parsed", () => {
  const body = {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: "2348012345678", profile: { name: "Ada" } }],
      messages: [
        { from: "2348012345678", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: "Hello" } },
        { from: "2348012345678", id: "wamid.2", timestamp: "1700000001", type: "image" },
      ],
      statuses: [{ id: "wamid.out", status: "delivered" }, { id: "wamid.bad", status: "failed", errors: [{ title: "Re-engagement message" }] }],
    } }] }],
  };
  const { messages, statuses } = getProvider("whatsapp").parseInbound(body);
  assert.equal(messages.length, 2);
  assert.deepEqual([messages[0].externalId, messages[0].name, messages[0].text, messages[0].messageId], ["2348012345678", "Ada", "Hello", "wamid.1"]);
  assert.equal(messages[1].unsupported, true);
  assert.match(messages[1].text, /image/);
  assert.deepEqual(statuses.map((s) => [s.messageId, s.status]), [["wamid.out", "delivered"], ["wamid.bad", "failed"]]);
  assert.equal(statuses[1].error, "Re-engagement message");
  assert.deepEqual(getProvider("whatsapp").parseInbound({ object: "page" }), { messages: [], statuses: [] });
});

test("Messenger and Instagram: ignore echoes and other objects, flag attachments", () => {
  const body = (object) => ({
    object,
    entry: [{ messaging: [
      { sender: { id: "psid1" }, timestamp: 1700000000000, message: { mid: "m.1", text: "Hi" } },
      { sender: { id: "page" }, timestamp: 1700000000001, message: { mid: "m.2", text: "echo", is_echo: true } },
      { sender: { id: "psid1" }, timestamp: 1700000000002, message: { mid: "m.3", attachments: [{}] } },
    ] }],
  });
  const messenger = getProvider("messenger").parseInbound(body("page")).messages;
  assert.deepEqual(messenger.map((m) => m.messageId), ["m.1", "m.3"]);
  assert.equal(messenger[1].unsupported, true);
  assert.equal(getProvider("messenger").parseInbound(body("instagram")).messages.length, 0, "wrong object type");
  assert.equal(getProvider("instagram").parseInbound(body("instagram")).messages.length, 2);
});

test("SMS and email payloads become messages; junk becomes nothing", () => {
  const sms = getProvider("sms").parseInbound({}, "From=%2B2348012345678&Body=Is+it+open%3F&MessageSid=SM9&NumMedia=0");
  assert.equal(sms.messages[0].text, "Is it open?");
  assert.equal(getProvider("sms").parseInbound({}, "Body=x").messages.length, 0);

  const mail = getProvider("email").parseInbound({ from: "Ada Obi <ada@shop.com>", subject: "Order", text: "Where is it?", messageId: "<id1@x>" });
  assert.equal(mail.messages[0].externalId, "ada@shop.com");
  assert.equal(mail.messages[0].name, "Ada Obi");
  assert.match(mail.messages[0].text, /^Subject: Order\n\nWhere is it\?$/);
  assert.equal(getProvider("email").parseInbound({ from: "not-an-email", text: "x", messageId: "1" }).messages.length, 0);
  assert.equal(getProvider("email").parseInbound({ from: "a@b.com", text: "x" }).messages.length, 0, "no message id");
});

// ---- sending ------------------------------------------------------------------------------------

test("WhatsApp sends the documented request and reports the provider's message id", async () => {
  const net = stubFetch(() => ({ json: { messages: [{ id: "wamid.sent" }] } }));
  try {
    const result = await getProvider("whatsapp").send({ creds: WA, to: "2348012345678", text: "Hi" });
    assert.deepEqual(result, { providerMessageId: "wamid.sent", status: "sent" });
    const call = net.calls[0];
    assert.match(call.url, /graph\.facebook\.com\/.+\/1234567890\/messages$/);
    assert.equal(call.init.headers.Authorization, `Bearer ${WA.accessToken}`);
    assert.deepEqual(JSON.parse(call.init.body), { messaging_product: "whatsapp", to: "2348012345678", type: "text", text: { body: "Hi", preview_url: false } });
  } finally {
    net.restore();
  }
});

test("WhatsApp explains the 24-hour rule and expired tokens in plain language", async () => {
  let net = stubFetch(() => ({ status: 400, json: { error: { code: 131047, message: "Re-engagement message" } } }));
  try {
    await assert.rejects(() => getProvider("whatsapp").send({ creds: WA, to: "1", text: "Hi" }), (e) => e instanceof ConnectorError && /24 hours/.test(e.message));
  } finally {
    net.restore();
  }
  net = stubFetch(() => ({ status: 401, json: { error: { code: 190, message: "Invalid OAuth access token." } } }));
  try {
    await assert.rejects(() => getProvider("whatsapp").send({ creds: WA, to: "1", text: "Hi" }), (e) => /expired|invalid/i.test(e.message) && e.message.includes("save it again"));
  } finally {
    net.restore();
  }
});

test("Messenger, SMS and email send in each provider's documented shape", async () => {
  let net = stubFetch(() => ({ json: { message_id: "mid.1" } }));
  try {
    const r = await getProvider("messenger").send({ creds: PAGE, to: "psid1", text: "Hello" });
    assert.equal(r.providerMessageId, "mid.1");
    assert.match(net.calls[0].url, /\/me\/messages$/);
    assert.deepEqual(JSON.parse(net.calls[0].init.body), { recipient: { id: "psid1" }, messaging_type: "RESPONSE", message: { text: "Hello" } });
  } finally {
    net.restore();
  }

  net = stubFetch(() => ({ status: 201, json: { sid: "SM1", status: "queued" } }));
  try {
    const r = await getProvider("sms").send({ creds: TW, to: "+2348012345678", text: "Hello" });
    assert.deepEqual(r, { providerMessageId: "SM1", status: "sent" });
    assert.match(net.calls[0].url, new RegExp(`/Accounts/${TW.accountSid}/Messages.json$`));
    assert.equal(net.calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${TW.accountSid}:${TW.authToken}`).toString("base64")}`);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(net.calls[0].init.body)), { To: "+2348012345678", From: TW.fromNumber, Body: "Hello" });
  } finally {
    net.restore();
  }

  net = stubFetch(() => ({ json: { id: "email-1" } }));
  try {
    const r = await getProvider("email").send({ creds: EM, to: "ada@shop.com", text: "Hi Ada", subject: "Re: Order" });
    assert.equal(r.providerMessageId, "email-1");
    assert.equal(net.calls[0].url, "https://api.resend.com/emails");
    assert.deepEqual(JSON.parse(net.calls[0].init.body), { from: EM.fromAddress, to: ["ada@shop.com"], subject: "Re: Order", text: "Hi Ada" });
  } finally {
    net.restore();
  }
});

test("provider failures never count as sent, and network failures are retryable errors", async () => {
  let net = stubFetch(() => ({ status: 400, json: { code: 21211, message: "Invalid 'To' Phone Number" } }));
  try {
    await assert.rejects(() => getProvider("sms").send({ creds: TW, to: "+1", text: "x" }), (e) => e instanceof ConnectorError && /Invalid/.test(e.message));
  } finally {
    net.restore();
  }
  const original = global.fetch;
  global.fetch = async () => {
    throw new Error("ECONNRESET");
  };
  try {
    await assert.rejects(() => getProvider("email").send({ creds: EM, to: "a@b.com", text: "x" }), (e) => e instanceof ConnectorError && e.retryable === true);
  } finally {
    global.fetch = original;
  }
});

test("connection tests report the provider's verdict honestly", async () => {
  let net = stubFetch(() => ({ json: { id: "1", display_phone_number: "+234 801 234 5678" } }));
  try {
    assert.match((await getProvider("whatsapp").testConnection(WA)).detail, /\+234 801 234 5678/);
  } finally {
    net.restore();
  }
  net = stubFetch(() => ({ status: 401, json: { message: "Authenticate" } }));
  try {
    await assert.rejects(() => getProvider("sms").testConnection(TW), /rejected/i);
  } finally {
    net.restore();
  }
  net = stubFetch(() => ({ status: 401, json: { name: "restricted_api_key", message: "restricted" } }));
  try {
    assert.equal((await getProvider("email").testConnection(EM)).ok, true, "sending-only keys are valid");
  } finally {
    net.restore();
  }
  net = stubFetch(() => ({ status: 401, json: { name: "invalid_api_key" } }));
  try {
    await assert.rejects(() => getProvider("email").testConnection(EM), /rejected/i);
  } finally {
    net.restore();
  }
});

test("credential validation rejects malformed values with clear messages", () => {
  assert.throws(() => getProvider("sms").validateCredentials({ ...TW, accountSid: "nope" }), (e) => e.statusCode === 400);
  assert.throws(() => getProvider("sms").validateCredentials({ ...TW, fromNumber: "0801" }), /international format/);
  assert.throws(() => getProvider("whatsapp").validateCredentials({ ...WA, accessToken: "short" }), (e) => e.statusCode === 400);
  assert.throws(() => getProvider("email").validateCredentials({ ...EM, fromAddress: "nonsense" }), /valid email/);
  assert.equal(getProvider("sms").validateCredentials(TW).fromNumber, "+14155550123");
  assert.equal(getProvider("unknown"), null);
});

// ---- inbound processing and AI replies over the channel ----------------------------------------

test("an inbound WhatsApp message creates the customer and conversation, gets an AI answer, and sends it back", async () => {
  resetDb();
  const provider = getProvider("whatsapp");
  const channel = channelDoc("whatsapp", WA);
  const net = stubFetch(() => ({ json: { messages: [{ id: "wamid.reply" }] } }));
  try {
    const parsed = { messages: [{ externalId: "2348012345678", name: "Ada", text: "When do you open?", messageId: "wamid.in1", timestamp: 1 }], statuses: [] };
    const summary = await inbound.processInbound({ channel, creds: WA, provider, parsed });
    assert.deepEqual(summary, { stored: 0, answered: 1, duplicate: 0, failed: 0 });

    assert.equal(db.customers[0].name, "Ada");
    assert.equal(db.customers[0].phone, "+2348012345678");
    assert.equal(db.identities[0].channelType, "whatsapp");
    assert.equal(db.conversations[0].externalConversationId, "whatsapp:2348012345678");
    assert.equal(db.conversations[0].handlingMode, "AI");
    assert.equal(db.aiCalls.length, 1);
    assert.deepEqual(db.aiCalls[0].payload, { body: "When do you open?", senderType: "customer" });

    const customerMsg = db.messages.find((m) => m.senderType === "customer");
    assert.equal(customerMsg.externalMessageId, "wamid.in1");
    assert.equal(customerMsg.direction, "inbound");
    const reply = db.messages.find((m) => m.senderType === "agent");
    assert.equal(reply.deliveryStatus, "sent");
    assert.equal(reply.externalMessageId, "wamid.reply");
    assert.equal(reply.direction, "outbound");
    assert.equal(JSON.parse(net.calls[0].init.body).text.body, "We open at 9am.");
    assert.equal(JSON.parse(net.calls[0].init.body).to, "2348012345678");
  } finally {
    net.restore();
  }
});

test("a message delivered twice is processed once", async () => {
  resetDb();
  const provider = getProvider("sms");
  const channel = channelDoc("sms", TW);
  const net = stubFetch(() => ({ status: 201, json: { sid: "SM-out" } }));
  try {
    const parsed = { messages: [{ externalId: "+2348012345678", name: "", text: "Hi", messageId: "SM-in", timestamp: 1 }], statuses: [] };
    await inbound.processInbound({ channel, creds: TW, provider, parsed });
    const second = await inbound.processInbound({ channel, creds: TW, provider, parsed });
    assert.equal(second.duplicate, 1);
    assert.equal(db.aiCalls.length, 1, "the AI was only asked once");
    assert.equal(net.calls.length, 1, "only one reply was sent");
  } finally {
    net.restore();
  }
});

test("when the AI fails the customer's message is still kept for a person to answer", async () => {
  resetDb();
  state.aiThrows = true;
  const provider = getProvider("messenger");
  const channel = channelDoc("messenger", PAGE);
  const net = stubFetch(() => ({ json: { message_id: "x" } }));
  try {
    const parsed = { messages: [{ externalId: "psid1", name: "", text: "Help", messageId: "m.9", timestamp: 1 }], statuses: [] };
    const summary = await inbound.processInbound({ channel, creds: PAGE, provider, parsed });
    assert.equal(summary.stored, 1);
    assert.equal(db.messages.filter((m) => m.senderType === "customer").length, 1);
    assert.equal(net.calls.length, 0, "nothing is sent when there is no answer");
  } finally {
    net.restore();
  }
});

test("with AI replies off, or no active agent, a person handles the conversation and nothing is auto-sent", async () => {
  resetDb();
  const provider = getProvider("email");
  const channel = channelDoc("email", EM, {});
  channel.connector.aiReplies = false;
  const net = stubFetch(() => ({ json: { id: "e1" } }));
  try {
    const parsed = { messages: [{ externalId: "ada@shop.com", name: "Ada", text: "Subject: Order\n\nWhere is it?", messageId: "<1@x>", timestamp: 1 }], statuses: [] };
    const summary = await inbound.processInbound({ channel, creds: EM, provider, parsed });
    assert.equal(summary.stored, 1);
    assert.equal(db.conversations[0].handlingMode, "HUMAN");
    assert.equal(db.conversations[0].title, "Order");
    assert.equal(db.customers[0].email, "ada@shop.com");
    assert.equal(db.aiCalls.length, 0);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test("delivery receipts only move a message forward, and failures are recorded", async () => {
  resetDb();
  db.messages.push({ _id: "out1", companyId: COMPANY, channelType: "whatsapp", externalMessageId: "wamid.out", direction: "outbound", deliveryStatus: "sent" });
  const channel = channelDoc("whatsapp", WA);
  await inbound.applyStatuses(channel, [{ messageId: "wamid.out", status: "delivered" }, { messageId: "wamid.out", status: "bogus" }]);
  assert.equal(db.messages[0].deliveryStatus, "delivered");
  const update = db.updates[0];
  assert.deepEqual(update.filter.deliveryStatus, { $in: ["pending", "sent"] }, "never moves backwards");
  await inbound.applyStatuses(channel, [{ messageId: "wamid.out", status: "failed", error: "Number not on WhatsApp" }]);
  assert.equal(db.messages[0].deliveryStatus, "failed");
  assert.equal(db.messages[0].deliveryError, "Number not on WhatsApp");
});

// ---- staff replies on external channels ------------------------------------------------------------

test("a staff reply is sent through the channel and marked sent, or marked failed with the reason", async () => {
  resetDb();
  const conversation = { _id: "conv1", channelType: "sms", externalConversationId: "sms:+2348012345678", title: "SMS" };
  db.messages.push({ _id: "staff1", companyId: COMPANY, body: "On our way", senderType: "user" });

  db.channelDoc = channelDoc("sms", TW);
  let net = stubFetch(() => ({ status: 201, json: { sid: "SM-staff" } }));
  try {
    const result = await inbound.deliverStaffReply(COMPANY, conversation, { _id: "staff1", body: "On our way" });
    assert.equal(result.deliveryStatus, "sent");
    assert.equal(db.messages[0].deliveryStatus, "sent");
    assert.equal(db.messages[0].direction, "outbound");
  } finally {
    net.restore();
  }

  net = stubFetch(() => ({ status: 400, json: { message: "The 'To' number is not a valid phone number" } }));
  try {
    const result = await inbound.deliverStaffReply(COMPANY, conversation, { _id: "staff1", body: "again" });
    assert.equal(result.deliveryStatus, "failed");
    assert.match(db.messages[0].deliveryError, /not a valid phone number/);
  } finally {
    net.restore();
  }

  db.channelDoc = channelDoc("sms", TW, { status: "inactive" });
  const off = await inbound.deliverStaffReply(COMPANY, conversation, { _id: "staff1", body: "x" });
  assert.equal(off.deliveryStatus, "failed");
  assert.match(off.deliveryError, /switched off/);

  assert.equal(await inbound.deliverStaffReply(COMPANY, { channelType: "webchat" }, { _id: "w", body: "x" }), null, "website chat has its own delivery");
});
