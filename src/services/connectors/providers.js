const crypto = require("crypto");
const AppError = require("../../utils/AppError");
const { ConnectorError, safeEqual, verifyMetaSignature, httpJson, cleanProviderText } = require("./core");

const GRAPH_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v21.0"}`;
const MAX_TEXT = 4000;

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

function requireText(value, label, min, max = 500) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min || text.length > max) throw new AppError(400, `${label} must be ${min}-${max} characters.`);
  return text;
}

/** Extracts the address from `Name <a@b.com>` or `a@b.com`. */
function extractAddress(value) {
  const match = /<([^>]+)>/.exec(String(value || ""));
  return (match ? match[1] : String(value || "")).trim();
}

// ------------------------------------------------------------------------------------------
// Meta Graph API helpers shared by WhatsApp, Messenger and Instagram
// ------------------------------------------------------------------------------------------

function metaVerifyGet(query, verifyToken) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && typeof token === "string" && safeEqual(token, verifyToken) && challenge !== undefined) {
    return { ok: true, challenge: String(challenge) };
  }
  return { ok: false };
}

function metaError(response, fallback) {
  const error = response.json && response.json.error;
  const code = error && error.code;
  let message = cleanProviderText(error && error.message, fallback);
  if (code === 190) message = "The access token is invalid or has expired. Create a new one and save it again.";
  if (code === 131047 || code === 131026) message = "WhatsApp only allows free-form replies within 24 hours of the customer's last message. Use an approved template message instead.";
  if (code === 10 || code === 200 || code === 230) message = "Meta did not allow this message. The customer may not have messaged you in the last 24 hours, or the app lacks permission.";
  return new ConnectorError(message, { code, status: response.status, retryable: response.status >= 500 || response.status === 429 });
}

// ------------------------------------------------------------------------------------------
// WhatsApp Cloud API
// ------------------------------------------------------------------------------------------

const whatsapp = {
  type: "whatsapp",
  label: "WhatsApp",
  usesVerifyToken: true,
  fields: [
    { name: "phoneNumberId", label: "Phone number ID", secret: false, required: true, help: "From WhatsApp > API Setup in your Meta app." },
    { name: "accessToken", label: "Access token", secret: true, required: true, help: "A permanent system-user token with whatsapp_business_messaging." },
    { name: "appSecret", label: "App secret", secret: true, required: true, help: "Meta app > Settings > Basic. Used to check that webhooks really come from Meta." },
  ],
  validateCredentials(c) {
    return {
      phoneNumberId: requireText(c.phoneNumberId, "Phone number ID", 5, 30),
      accessToken: requireText(c.accessToken, "Access token", 20, 1000),
      appSecret: requireText(c.appSecret, "App secret", 16, 200),
    };
  },
  verifyWebhookGet: (query, ctx) => metaVerifyGet(query, ctx.verifyToken),
  verifyWebhookPost: ({ rawBody, headers, creds }) => verifyMetaSignature(rawBody, headers["x-hub-signature-256"], creds.appSecret),
  parseInbound(body) {
    const messages = [];
    const statuses = [];
    if (!body || body.object !== "whatsapp_business_account") return { messages, statuses };
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const names = {};
        for (const contact of value.contacts || []) names[contact.wa_id] = contact.profile && contact.profile.name;
        for (const m of value.messages || []) {
          const isText = m.type === "text" && m.text && typeof m.text.body === "string";
          messages.push({
            externalId: String(m.from),
            name: names[m.from] || "",
            text: isText ? m.text.body : `[The customer sent a ${m.type || "message"} that Corvanta cannot show yet]`,
            messageId: String(m.id),
            timestamp: Number(m.timestamp) * 1000 || Date.now(),
            unsupported: !isText,
          });
        }
        for (const s of value.statuses || []) {
          statuses.push({
            messageId: String(s.id),
            status: s.status,
            error: s.errors && s.errors[0] ? cleanProviderText(s.errors[0].title || s.errors[0].message, "Delivery failed") : null,
          });
        }
      }
    }
    return { messages, statuses };
  },
  async send({ creds, to, text }) {
    const response = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(creds.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, MAX_TEXT), preview_url: false } }),
    });
    const id = response.json && response.json.messages && response.json.messages[0] && response.json.messages[0].id;
    if (!response.ok || !id) throw metaError(response, "WhatsApp did not accept the message.");
    return { providerMessageId: String(id), status: "sent" };
  },
  async testConnection(creds) {
    const response = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(creds.phoneNumberId)}?fields=id,display_phone_number`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (!response.ok) throw metaError(response, "WhatsApp rejected these credentials.");
    const number = response.json && response.json.display_phone_number;
    return { ok: true, detail: number ? `Connected to ${number}.` : "Credentials accepted." };
  },
};

// ------------------------------------------------------------------------------------------
// Messenger and Instagram (same Graph API messaging format)
// ------------------------------------------------------------------------------------------

function createMetaPageProvider({ type, label, object }) {
  return {
    type,
    label,
    usesVerifyToken: true,
    fields: [
      { name: "pageAccessToken", label: "Page access token", secret: true, required: true, help: `The token of the Facebook Page${type === "instagram" ? " linked to your Instagram account" : ""}.` },
      { name: "appSecret", label: "App secret", secret: true, required: true, help: "Meta app > Settings > Basic. Used to check that webhooks really come from Meta." },
    ],
    validateCredentials(c) {
      return {
        pageAccessToken: requireText(c.pageAccessToken, "Page access token", 20, 1000),
        appSecret: requireText(c.appSecret, "App secret", 16, 200),
      };
    },
    verifyWebhookGet: (query, ctx) => metaVerifyGet(query, ctx.verifyToken),
    verifyWebhookPost: ({ rawBody, headers, creds }) => verifyMetaSignature(rawBody, headers["x-hub-signature-256"], creds.appSecret),
    parseInbound(body) {
      const messages = [];
      if (!body || body.object !== object) return { messages, statuses: [] };
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const message = event.message;
          if (!message || message.is_echo || !event.sender || !event.sender.id) continue;
          const isText = typeof message.text === "string" && message.text.length > 0;
          messages.push({
            externalId: String(event.sender.id),
            name: "",
            text: isText ? message.text : "[The customer sent an attachment that Corvanta cannot show yet]",
            messageId: String(message.mid),
            timestamp: Number(event.timestamp) || Date.now(),
            unsupported: !isText,
          });
        }
      }
      return { messages, statuses: [] };
    },
    async send({ creds, to, text }) {
      const response = await httpJson(`${GRAPH_BASE}/me/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.pageAccessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: to }, messaging_type: "RESPONSE", message: { text: text.slice(0, 2000) } }),
      });
      const id = response.json && response.json.message_id;
      if (!response.ok || !id) throw metaError(response, `${label} did not accept the message.`);
      return { providerMessageId: String(id), status: "sent" };
    },
    async testConnection(creds) {
      const response = await httpJson(`${GRAPH_BASE}/me?fields=id,name`, { headers: { Authorization: `Bearer ${creds.pageAccessToken}` } });
      if (!response.ok) throw metaError(response, `${label} rejected these credentials.`);
      const name = response.json && response.json.name;
      return { ok: true, detail: name ? `Connected to ${name}.` : "Credentials accepted." };
    },
  };
}

const messenger = createMetaPageProvider({ type: "messenger", label: "Facebook Messenger", object: "page" });
const instagram = createMetaPageProvider({ type: "instagram", label: "Instagram", object: "instagram" });

// ------------------------------------------------------------------------------------------
// SMS through Twilio
// ------------------------------------------------------------------------------------------

function parseForm(raw) {
  const out = {};
  for (const [key, value] of new URLSearchParams(String(raw || ""))) out[key] = value;
  return out;
}

/** Twilio: base64(HMAC-SHA1(authToken, url + each POST parameter name+value sorted by name)). */
function twilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

const sms = {
  type: "sms",
  label: "SMS (Twilio)",
  usesVerifyToken: false,
  replyBody: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  replyContentType: "text/xml",
  fields: [
    { name: "accountSid", label: "Account SID", secret: false, required: true, help: "Starts with AC. From the Twilio console." },
    { name: "authToken", label: "Auth token", secret: true, required: true, help: "From the Twilio console. Also used to check that webhooks come from Twilio." },
    { name: "fromNumber", label: "Twilio phone number", secret: false, required: true, help: "In international format, for example +14155550123." },
  ],
  validateCredentials(c) {
    const accountSid = requireText(c.accountSid, "Account SID", 34, 34);
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) throw new AppError(400, "Account SID must start with AC followed by 32 letters or digits.");
    const fromNumber = typeof c.fromNumber === "string" ? c.fromNumber.trim() : "";
    if (!E164.test(fromNumber)) throw new AppError(400, "Twilio phone number must be in international format, for example +14155550123.");
    return { accountSid, authToken: requireText(c.authToken, "Auth token", 16, 200), fromNumber };
  },
  verifyWebhookGet: () => ({ ok: false }),
  verifyWebhookPost({ rawBody, headers, creds, url }) {
    const header = headers["x-twilio-signature"];
    if (!header || !creds.authToken || !url) return false;
    return safeEqual(twilioSignature(creds.authToken, url, parseForm(rawBody)), header);
  },
  parseInbound(body, rawBody) {
    const form = parseForm(rawBody);
    if (!form.From || !form.MessageSid) return { messages: [], statuses: [] };
    const text = form.Body || "";
    const hasMedia = Number(form.NumMedia || 0) > 0;
    return {
      messages: [
        {
          externalId: form.From,
          name: "",
          text: text || (hasMedia ? "[The customer sent a picture or file that Corvanta cannot show yet]" : ""),
          messageId: form.MessageSid,
          timestamp: Date.now(),
          unsupported: !text,
        },
      ].filter((m) => m.text),
      statuses: [],
    };
  },
  async send({ creds, to, text }) {
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
    const response = await httpJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: creds.fromNumber, Body: text.slice(0, 1500) }).toString(),
    });
    const json = response.json || {};
    if (!response.ok || !json.sid) {
      throw new ConnectorError(cleanProviderText(json.message, "Twilio did not accept the message."), {
        code: json.code || null,
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    // "queued" means Twilio accepted it; it is not proof the phone received it.
    return { providerMessageId: String(json.sid), status: "sent" };
  },
  async testConnection(creds) {
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
    const response = await httpJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok) {
      throw new ConnectorError(response.status === 401 ? "Twilio rejected the Account SID or auth token." : cleanProviderText(response.json && response.json.message, "Twilio rejected these credentials."), { status: response.status });
    }
    return { ok: true, detail: "Twilio accepted these credentials." };
  },
};

// ------------------------------------------------------------------------------------------
// Email: sending through Resend, receiving through a signed webhook (any forwarder can post to it)
// ------------------------------------------------------------------------------------------

const email = {
  type: "email",
  label: "Email",
  usesVerifyToken: false,
  usesSigningSecret: true,
  fields: [
    { name: "apiKey", label: "Resend API key", secret: true, required: true, help: "From resend.com > API Keys. Sending access is enough." },
    { name: "fromAddress", label: "Send replies from", secret: false, required: true, help: "A verified sender, for example Support <support@yourshop.com>." },
  ],
  validateCredentials(c) {
    const fromAddress = requireText(c.fromAddress, "Send replies from", 5, 200);
    if (!EMAIL.test(extractAddress(fromAddress))) throw new AppError(400, "Send replies from must contain a valid email address.");
    return { apiKey: requireText(c.apiKey, "Resend API key", 10, 300), fromAddress };
  },
  verifyWebhookGet: () => ({ ok: false }),
  /** Inbound email arrives as JSON signed with HMAC-SHA256 of the raw body using the channel's signing secret. */
  verifyWebhookPost({ rawBody, headers, creds }) {
    const header = headers["x-corvanta-signature"];
    if (typeof rawBody !== "string" || !header || !creds.inboundSecret) return false;
    const expected = `sha256=${crypto.createHmac("sha256", creds.inboundSecret).update(rawBody, "utf8").digest("hex")}`;
    return safeEqual(expected, header);
  },
  parseInbound(body) {
    if (!body || typeof body.from !== "string") return { messages: [], statuses: [] };
    const address = extractAddress(body.from).toLowerCase();
    if (!EMAIL.test(address)) return { messages: [], statuses: [] };
    const text = [body.subject ? `Subject: ${String(body.subject).slice(0, 200)}` : "", typeof body.text === "string" ? body.text : ""]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!text || !body.messageId) return { messages: [], statuses: [] };
    const named = /^(.*?)\s*<[^>]+>$/.exec(body.from);
    return {
      messages: [
        {
          externalId: address,
          name: (named && named[1].replace(/^"|"$/g, "").trim()) || String(body.name || ""),
          text: text.slice(0, MAX_TEXT),
          messageId: String(body.messageId).slice(0, 300),
          timestamp: Date.now(),
          unsupported: false,
        },
      ],
      statuses: [],
    };
  },
  async send({ creds, to, text, subject }) {
    const response = await httpJson("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: creds.fromAddress, to: [to], subject: String(subject || "Re: your message").slice(0, 200), text: text.slice(0, 20000) }),
    });
    const json = response.json || {};
    if (!response.ok || !json.id) {
      throw new ConnectorError(cleanProviderText(json.message, "The email was not accepted by Resend."), {
        code: json.name || null,
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    return { providerMessageId: String(json.id), status: "sent" };
  },
  async testConnection(creds) {
    const response = await httpJson("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${creds.apiKey}` } });
    // A sending-only key is valid but is not allowed to list domains.
    if (response.ok || (response.status === 401 && response.json && response.json.name === "restricted_api_key")) {
      return { ok: true, detail: response.ok ? "Resend accepted this key." : "Resend accepted this sending-only key." };
    }
    throw new ConnectorError(response.status === 401 ? "Resend rejected this API key." : cleanProviderText(response.json && response.json.message, "Resend rejected this key."), { status: response.status });
  },
};

const PROVIDERS = { whatsapp, messenger, instagram, sms, email };

function getProvider(type) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, type) ? PROVIDERS[type] : null;
}

module.exports = { PROVIDERS, getProvider, twilioSignature, parseForm, extractAddress };
