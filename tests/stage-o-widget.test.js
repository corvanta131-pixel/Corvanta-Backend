// Safe defaults so this file runs with or without a local .env (never overrides real values).
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/corvanta-test";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "test-access-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const src = path.join(__dirname, "..", "src");
const COMPANY = "64d3a8f2c54f4020a959c9aa";
const OTHER_COMPANY = "64d3a8f2c54f4020a959c9bb";
const CHANNEL_ID = "64d3a8f2c54f4020a959c9c1";
const OTHER_CHANNEL_ID = "64d3a8f2c54f4020a959c9c2";
const AGENT_ID = "64d3a8f2c54f4020a959c9d1";

function stub(rel, exports) {
  const resolved = require.resolve(path.join(src, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/** Chainable, awaitable stand-in for a Mongoose query. */
function query(result) {
  const q = {
    select: () => q,
    lean: () => q,
    sort: () => q,
    limit: () => q,
    then: (resolve, reject) => Promise.resolve(typeof result === "function" ? result() : result).then(resolve, reject),
  };
  return q;
}

// ---- shared mutable stubs (modules are cached, so tests change behaviour through these) ----
const calls = { aiSend: [], createMessage: [], customerCreate: [], identityCreate: [], conversationCreate: [], audit: [] };
const behaviour = {
  agent: { _id: AGENT_ID, name: "Support bot", status: "active" },
  conversation: null,
  messageRows: [],
  storedCustomerMessage: null,
  aiAllowed: true,
  aiThrows: false,
  customerCreateError: null,
  lastMessageFind: null,
};

stub("models/AIAgent.js", { findOne: () => query(() => behaviour.agent) });
stub("models/Customer.js", {
  create: async (doc) => {
    if (behaviour.customerCreateError) throw behaviour.customerCreateError;
    calls.customerCreate.push(doc);
    return { _id: "64d3a8f2c54f4020a959c9e1", ...doc };
  },
});
stub("models/CustomerIdentity.js", {
  create: async (doc) => {
    calls.identityCreate.push(doc);
    return { _id: "identity-1", ...doc };
  },
});
stub("models/Conversation.js", {
  create: async (doc) => {
    calls.conversationCreate.push(doc);
    return { _id: "64d3a8f2c54f4020a959c9f1", ...doc };
  },
  findOne: async () => behaviour.conversation,
});
stub("models/Message.js", {
  find: (filter) => {
    behaviour.lastMessageFind = filter;
    return query(() => behaviour.messageRows.slice());
  },
  findOne: () => query(() => behaviour.storedCustomerMessage),
});
stub("models/Channel.js", { findOne: () => query(null) });
stub("validators/commonValidator.js", {
  validateObjectId: (value, name = "id") => {
    if (!/^[a-f0-9]{24}$/i.test(String(value))) {
      const AppError = require(path.join(src, "utils", "AppError.js"));
      throw new AppError(400, `Valid ${name} is required.`);
    }
  },
});
stub("services/aiConversationService.js", {
  sendConversationMessage: async (...args) => {
    calls.aiSend.push(args);
    if (behaviour.aiThrows) throw new Error("provider down");
    return { response: { text: "ok" } };
  },
});
stub("services/messageService.js", {
  createMessage: async (...args) => {
    calls.createMessage.push(args);
    return { _id: "m-new" };
  },
});
stub("services/auditService.js", {
  logAudit: async (entry) => {
    calls.audit.push(entry);
  },
});
stub("middleware/aiRateLimit.js", { checkAIRateLimit: () => ({ allowed: behaviour.aiAllowed }) });

const widget = require(path.join(src, "services", "widgetService.js"));
const { signWidgetToken, verifyWidgetToken } = require(path.join(src, "services", "widgetTokenService.js"));
const { widgetCors } = require(path.join(src, "middleware", "widgetCors.js"));
const widgetAuth = require(path.join(src, "middleware", "widgetAuth.js"));
const { createMemoryRateLimiter } = require(path.join(src, "utils", "memoryRateLimit.js"));

const channel = (over = {}) => ({
  _id: CHANNEL_ID,
  companyId: COMPANY,
  type: "webchat",
  status: "active",
  widget: { key: "wk_abcdefghijklmnop", allowedOrigins: ["https://shop.example.com"], agentId: AGENT_ID, title: "Help" },
  ...over,
});

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key].length = 0;
  behaviour.agent = { _id: AGENT_ID, name: "Support bot", status: "active" };
  behaviour.conversation = null;
  behaviour.messageRows = [];
  behaviour.storedCustomerMessage = null;
  behaviour.aiAllowed = true;
  behaviour.aiThrows = false;
  behaviour.customerCreateError = null;
}

function conversationDoc(over = {}) {
  const doc = {
    _id: "64d3a8f2c54f4020a959c9f1",
    companyId: COMPANY,
    channelId: CHANNEL_ID,
    customerId: "64d3a8f2c54f4020a959c9e1",
    status: "open",
    handlingMode: "AI",
    saved: 0,
    async save() {
      this.saved += 1;
    },
    ...over,
  };
  return doc;
}

function tokenFor(over = {}) {
  return signWidgetToken({
    channelId: CHANNEL_ID,
    companyId: COMPANY,
    customerId: "64d3a8f2c54f4020a959c9e1",
    conversationId: "64d3a8f2c54f4020a959c9f1",
    visitorId: "visitor-1",
    ...over,
  });
}

// ------------------------------------------------------------------------------------------

test("normalizeOrigin accepts bare origins and rejects paths, schemes and junk", () => {
  assert.equal(widget.normalizeOrigin("https://Shop.example.com/"), "https://shop.example.com");
  assert.equal(widget.normalizeOrigin("http://localhost:8080"), "http://localhost:8080");
  for (const bad of ["https://shop.example.com/page", "ftp://x.com", "not a url", "javascript:alert(1)", 42]) {
    assert.throws(() => widget.normalizeOrigin(bad), (e) => e.statusCode === 400, String(bad));
  }
});

test("validateWidgetSettings normalises valid input and ignores unknown fields", () => {
  const s = widget.validateWidgetSettings({
    allowedOrigins: ["https://a.com/", "https://a.com"],
    title: "  Hello  ",
    welcomeMessage: "Hi",
    color: "#ABCDEF",
    agentId: AGENT_ID,
    enabled: true,
    rotateKey: true,
    status: "hacked",
    key: "wk_chosen_by_attacker",
  });
  assert.deepEqual(s.allowedOrigins, ["https://a.com"]);
  assert.equal(s.title, "Hello");
  assert.equal(s.color, "#abcdef");
  assert.equal(s.enabled, true);
  assert.equal(s.rotateKey, true);
  assert.equal("key" in s, false, "clients can never choose their own widget key");
  assert.equal("status" in s, false);
});

test("validateWidgetSettings rejects bad values", () => {
  const bad = [
    { allowedOrigins: "https://a.com" },
    { allowedOrigins: Array.from({ length: 11 }, (_, i) => `https://s${i}.com`) },
    { title: "" },
    { title: "x".repeat(61) },
    { welcomeMessage: "x".repeat(301) },
    { color: "red" },
    { agentId: "nope" },
    { enabled: "yes" },
  ];
  for (const payload of bad) {
    assert.throws(() => widget.validateWidgetSettings(payload), (e) => e.statusCode === 400, JSON.stringify(payload));
  }
  assert.equal(widget.validateWidgetSettings({ agentId: null }).agentId, null);
});

test("widget keys are unguessable and only well-formed keys reach the database", async () => {
  const a = widget.generateWidgetKey();
  const b = widget.generateWidgetKey();
  assert.match(a, /^wk_[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(a, b);
  assert.equal(await widget.getChannelByWidgetKey("not-a-key"), null);
  assert.equal(await widget.getChannelByWidgetKey("../../etc/passwd"), null);
  assert.equal(await widget.getChannelByWidgetKey(undefined), null);
});

test("embed snippet points at the API embed script with the key", () => {
  assert.equal(
    widget.embedSnippet("https://api.example.com", "wk_abc"),
    '<script src="https://api.example.com/api/v1/widget/embed.js" data-key="wk_abc" async></script>'
  );
});

test("widget tokens round-trip, reject tampering, and are not dashboard tokens", () => {
  const claims = verifyWidgetToken(tokenFor());
  assert.deepEqual(claims, {
    channelId: CHANNEL_ID,
    companyId: COMPANY,
    customerId: "64d3a8f2c54f4020a959c9e1",
    conversationId: "64d3a8f2c54f4020a959c9f1",
    visitorId: "visitor-1",
  });
  const token = tokenFor();
  const tampered = `${token.slice(0, -3)}${token.endsWith("aaa") ? "bbb" : "aaa"}`;
  assert.throws(() => verifyWidgetToken(tampered), (e) => e.statusCode === 401);
  assert.throws(() => verifyWidgetToken("garbage"), (e) => e.statusCode === 401);

  const jwt = require("jsonwebtoken");
  const config = require(path.join(src, "config", "config.js"));
  const dashboardStyle = jwt.sign({ typ: "widget", cid: CHANNEL_ID }, config.JWT_ACCESS_SECRET);
  assert.throws(() => verifyWidgetToken(dashboardStyle), (e) => e.statusCode === 401, "different signing key");
});

test("memory rate limiter blocks after max and recovers after the window", async () => {
  const limiter = createMemoryRateLimiter({ windowMs: 60, max: 2 });
  assert.equal(limiter.check("k").allowed, true);
  assert.equal(limiter.check("k").allowed, true);
  const blocked = limiter.check("k");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.check("other").allowed, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(limiter.check("k").allowed, true);
});

test("widgetCors allows only the channel's own websites", () => {
  const run = (origin, method = "GET") => {
    const headers = {};
    let ended = null;
    const res = {
      setHeader: (k, v) => {
        headers[k] = v;
      },
      status(code) {
        ended = code;
        return this;
      },
      end() {},
    };
    let error = null;
    let passed = false;
    widgetCors({ headers: origin ? { origin } : {}, method, widgetChannel: channel() }, res, (err) => {
      if (err) error = err;
      else passed = true;
    });
    return { headers, ended, error, passed };
  };

  const ok = run("https://shop.example.com");
  assert.equal(ok.passed, true);
  assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://shop.example.com");
  assert.equal(ok.headers.Vary, "Origin");
  assert.equal("Access-Control-Allow-Credentials" in ok.headers, false);

  const evil = run("https://evil.example.net");
  assert.equal(evil.error.statusCode, 403);
  assert.equal("Access-Control-Allow-Origin" in evil.headers, false);

  const preflight = run("https://shop.example.com", "OPTIONS");
  assert.equal(preflight.ended, 204);

  assert.equal(run(undefined).passed, true, "non-browser clients carry no Origin header");
  assert.equal(
    run("https://shop.example.com").headers["Access-Control-Allow-Origin"],
    "https://shop.example.com"
  );
});

test("widgetAuth requires a bearer token", () => {
  let err = null;
  widgetAuth({ headers: {} }, {}, (e) => {
    err = e;
  });
  assert.equal(err.statusCode, 401);
  const req = { headers: { authorization: "Bearer abc.def.ghi" } };
  widgetAuth(req, {}, () => {});
  assert.equal(req.widgetToken, "abc.def.ghi");
});

test("createSession builds an isolated visitor customer, identity and AI conversation", async () => {
  resetCalls();
  const { token, messages } = await widget.createSession(channel(), { name: "  Ada\u0007  " });
  assert.deepEqual(messages, []);
  assert.equal(calls.customerCreate[0].companyId, COMPANY);
  assert.equal(calls.customerCreate[0].name, "Ada");
  assert.equal(calls.customerCreate[0].status, "prospect");
  assert.equal(calls.identityCreate[0].channelType, "webchat");
  assert.equal(calls.identityCreate[0].companyId, COMPANY);
  const conv = calls.conversationCreate[0];
  assert.equal(conv.companyId, COMPANY);
  assert.equal(conv.channelId, CHANNEL_ID);
  assert.equal(conv.handlingMode, "AI");
  assert.equal(String(conv.agentId), AGENT_ID);
  assert.match(conv.externalConversationId, /^widget:/);
  const claims = verifyWidgetToken(token);
  assert.equal(claims.companyId, COMPANY);
  assert.equal(claims.channelId, CHANNEL_ID);
  assert.equal(calls.audit[0].action, "widget.session.started");
});

test("createSession falls back to a generic visitor name", async () => {
  resetCalls();
  await widget.createSession(channel(), {});
  assert.match(calls.customerCreate[0].name, /^Website visitor [0-9a-f]{4}$/);
});

test("createSession refuses when the widget is off or has no active agent", async () => {
  resetCalls();
  await assert.rejects(() => widget.createSession(channel({ status: "inactive" })), (e) => e.statusCode === 503);
  behaviour.agent = null;
  await assert.rejects(() => widget.createSession(channel()), (e) => e.statusCode === 503);
  assert.equal(calls.customerCreate.length, 0, "no records are created for an unavailable widget");
});

test("createSession reports the missing migration instead of crashing on the old email index", async () => {
  resetCalls();
  behaviour.customerCreateError = Object.assign(new Error("E11000"), { code: 11000 });
  await assert.rejects(() => widget.createSession(channel()), (e) => e.statusCode === 503);
});

test("a token from one channel or company cannot be used on another", async () => {
  resetCalls();
  behaviour.conversation = conversationDoc();
  await assert.rejects(
    () => widget.listVisitorMessages(channel({ _id: OTHER_CHANNEL_ID }), tokenFor()),
    (e) => e.statusCode === 401
  );
  await assert.rejects(
    () => widget.listVisitorMessages(channel({ companyId: OTHER_COMPANY }), tokenFor()),
    (e) => e.statusCode === 401
  );
  behaviour.conversation = null;
  await assert.rejects(() => widget.listVisitorMessages(channel(), tokenFor()), (e) => e.statusCode === 401);
});

test("visitor message lists expose only public fields and never internal senders", async () => {
  resetCalls();
  behaviour.conversation = conversationDoc();
  behaviour.messageRows = [
    { _id: "m1", senderType: "customer", body: "hello", createdAt: "2025-01-01T00:00:00.000Z", metadata: { secret: 1 }, companyId: COMPANY },
    { _id: "m2", senderType: "agent", body: "hi!", createdAt: "2025-01-01T00:00:01.000Z", metadata: { sources: ["internal doc"] } },
    { _id: "m3", senderType: "user", body: "agent here", createdAt: "2025-01-01T00:00:02.000Z" },
  ];
  const { messages } = await widget.listVisitorMessages(channel(), tokenFor(), "2025-01-01T00:00:00.000Z");
  assert.deepEqual(messages.map((m) => m.role), ["visitor", "assistant", "team"]);
  assert.deepEqual(Object.keys(messages[0]).sort(), ["body", "createdAt", "id", "role"]);
  assert.equal(behaviour.lastMessageFind.companyId, COMPANY);
  assert.equal(behaviour.lastMessageFind.senderType.$in.includes("system"), false);
  assert.ok(behaviour.lastMessageFind.createdAt.$gt instanceof Date);
});

test("sending in AI mode goes through the AI service with a customer actor", async () => {
  resetCalls();
  behaviour.conversation = conversationDoc();
  behaviour.messageRows = [{ _id: "m9", senderType: "customer", body: "Where is my order?", createdAt: "2025-01-01T00:00:00.000Z" }];
  const result = await widget.sendVisitorMessage(channel(), tokenFor(), "  Where is my order?  ");
  assert.equal(calls.aiSend.length, 1);
  const [companyId, conversationId, payload, actor, options] = calls.aiSend[0];
  assert.equal(companyId, COMPANY);
  assert.equal(conversationId, "64d3a8f2c54f4020a959c9f1");
  assert.deepEqual(payload, { body: "Where is my order?", senderType: "customer" });
  assert.equal(actor.role.slug, "customer");
  assert.equal(actor.companyId, COMPANY);
  assert.deepEqual(options, { useSemantic: false });
  assert.equal(result.replyStatus, "answered");
  assert.equal(result.messages.length, 1);
});

test("sending validates the message and respects conversation state", async () => {
  resetCalls();
  behaviour.conversation = conversationDoc();
  await assert.rejects(() => widget.sendVisitorMessage(channel(), tokenFor(), "   "), (e) => e.statusCode === 400);
  await assert.rejects(() => widget.sendVisitorMessage(channel(), tokenFor(), 123), (e) => e.statusCode === 400);
  await assert.rejects(
    () => widget.sendVisitorMessage(channel(), tokenFor(), "x".repeat(widget.MAX_MESSAGE_CHARS + 1)),
    (e) => e.statusCode === 400
  );
  assert.equal(calls.aiSend.length, 0);

  behaviour.conversation = conversationDoc({ status: "archived" });
  await assert.rejects(() => widget.sendVisitorMessage(channel(), tokenFor(), "hi"), (e) => e.statusCode === 409);

  const resolved = conversationDoc({ status: "resolved" });
  behaviour.conversation = resolved;
  await widget.sendVisitorMessage(channel(), tokenFor(), "one more thing");
  assert.equal(resolved.status, "open");
  assert.equal(resolved.saved, 1);

  await assert.rejects(
    () => widget.sendVisitorMessage(channel({ status: "inactive" }), tokenFor(), "hi"),
    (e) => e.statusCode === 503
  );
});

test("if the AI fails the customer message is still saved and the visitor is told honestly", async () => {
  resetCalls();
  behaviour.conversation = conversationDoc();
  behaviour.aiThrows = true;
  const result = await widget.sendVisitorMessage(channel(), tokenFor(), "hello");
  assert.equal(result.replyStatus, "unavailable");
  assert.equal(calls.createMessage.length, 1, "customer message saved by fallback");

  resetCalls();
  behaviour.conversation = conversationDoc();
  behaviour.aiThrows = true;
  behaviour.storedCustomerMessage = { _id: "already" };
  await widget.sendVisitorMessage(channel(), tokenFor(), "hello");
  assert.equal(calls.createMessage.length, 0, "no duplicate when the AI service had already stored it");
});

test("when the company hits the AI rate limit the message is saved without an AI call", async () => {
  resetCalls();
  behaviour.conversation = conversationDoc();
  behaviour.aiAllowed = false;
  const result = await widget.sendVisitorMessage(channel(), tokenFor(), "hello");
  assert.equal(result.replyStatus, "busy");
  assert.equal(calls.aiSend.length, 0);
  assert.equal(calls.createMessage.length, 1);
});

test("human-handled conversations store the message and wait for the team", async () => {
  resetCalls();
  behaviour.conversation = conversationDoc({ handlingMode: "HUMAN" });
  const result = await widget.sendVisitorMessage(channel(), tokenFor(), "hello");
  assert.equal(result.replyStatus, "waiting_for_team");
  assert.equal(calls.aiSend.length, 0);
  assert.equal(calls.createMessage.length, 1);
  assert.deepEqual(calls.createMessage[0][2], { body: "hello", senderType: "customer" });
});

test("the embed script is served as JavaScript and never injects HTML", () => {
  const controller = require(path.join(src, "controllers", "widgetController.js"));
  const headers = {};
  let body = "";
  controller.serveEmbed(
    {},
    {
      setHeader: (k, v) => {
        headers[k] = v;
      },
      status() {
        return this;
      },
      send: (text) => {
        body = text;
      },
    }
  );
  assert.match(headers["Content-Type"], /javascript/);
  assert.equal(headers["Access-Control-Allow-Origin"], "*");
  assert.ok(body.includes("attachShadow"));
  const code = fs.readFileSync(path.join(src, "widget", "embed.js"), "utf8");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(code), false);
});
