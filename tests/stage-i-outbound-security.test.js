const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-i-outbound-sec-access";
process.env.JWT_REFRESH_SECRET = "stage-i-outbound-sec-refresh";

let mongo;
let app;
let tokenA;
let tokenB;
let a;
let b;

const Company = require("../src/models/Company");
const User = require("../src/models/User");
const Role = require("../src/models/Role");
const Channel = require("../src/models/Channel");
const Customer = require("../src/models/Customer");
const Conversation = require("../src/models/Conversation");
const Message = require("../src/models/Message");
const Workflow = require("../src/models/Workflow");
const WorkflowExecution = require("../src/models/WorkflowExecution");
const AuditLog = require("../src/models/AuditLog");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_outbound_sec");
  app = require("../app");

  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Outbound Sec A", slug: "outbound-sec-a" },
    { name: "Outbound Sec B", slug: "outbound-sec-b" },
  ]);

  const permissions = [
    "channels:read", "channels:create", "channels:update", "channels:delete",
    "conversations:read", "conversations:create", "conversations:update", "conversations:delete",
    "conversations:messages:read", "conversations:send", "messages:send",
    "customers:read", "customers:create", "customers:update", "customers:delete",
    "workflows:read", "workflows:create", "workflows:update", "workflows:delete",
  ];

  const [roleA, roleB] = await Role.create([
    { companyId: companyA._id, name: "A Role", slug: "outbound-sec-a", permissions },
    { companyId: companyB._id, name: "B Role", slug: "outbound-sec-b", permissions },
  ]);

  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB] = await User.create([
    { companyId: companyA._id, name: "User A", email: "outbound-sec-a@test.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "User B", email: "outbound-sec-b@test.com", passwordHash, roleId: roleB._id, status: "active" },
  ]);

  a = { company: companyA, user: userA };
  b = { company: companyB, user: userB };

  tokenA = (await request(app).post("/api/v1/auth/login").send({ email: userA.email, password: "Password123!" })).body.data.accessToken;
  tokenB = (await request(app).post("/api/v1/auth/login").send({ email: userB.email, password: "Password123!" })).body.data.accessToken;
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(async () => {
  await Channel.deleteMany({});
  await Customer.deleteMany({});
  await Conversation.deleteMany({});
  await Message.deleteMany({});
  await Workflow.deleteMany({});
  await WorkflowExecution.deleteMany({});
  await AuditLog.deleteMany({});
});

test("Outbound API - unauthenticated request rejected", async () => {
  const response = await request(app)
    .post("/api/v1/outbound/send")
    .send({ conversationId: new mongoose.Types.ObjectId(), body: "test" })
    .expect(401);

  assert.equal(response.body.success, false);
});

test("Outbound API - User from Company A cannot send using Company B conversation", async () => {
  const [customerB] = await Customer.create([{ companyId: b.company._id, name: "B Customer" }]);
  const [conversationB] = await Conversation.create([{ companyId: b.company._id, customerId: customerB._id, channelType: "webchat" }]);
  const [channelB] = await Channel.create([{ companyId: b.company._id, name: "B Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationB._id), channelType: "webchat", body: "hack" })
    .expect(404);

  assert.equal(response.body.success, false);
});

test("Outbound API - User from Company A cannot send using Company B channel", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelB] = await Channel.create([{ companyId: b.company._id, name: "B Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "hack" })
    .expect(404);

  assert.equal(response.body.success, false);
});

test("Outbound API - User cannot use a Company B customer with Company A conversation", async () => {
  const [customerB] = await Customer.create([{ companyId: b.company._id, name: "B Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerB._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "hack" })
    .expect(403);

  assert.equal(response.body.success, false);
});

test("Outbound API - Client cannot override companyId", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "test", companyId: String(b.company._id) })
    .expect(201);

  assert.equal(response.body.success, true);
  assert.equal(String(response.body.data.message.companyId), String(a.company._id));
});

test("Outbound API - Client cannot supply or override channel credentials", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([
    {
      companyId: a.company._id,
      name: "A Channel",
      type: "webchat",
      status: "active",
      externalConfig: { apiToken: "server-secret", webhookSecret: "server-webhook-secret", otherField: "visible" },
    },
  ]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({
      conversationId: String(conversationA._id),
      channelType: "webchat",
      body: "test",
      externalConfig: { apiToken: "client-supplied-token", webhookSecret: "client-supplied-secret" },
    })
    .expect(201);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.message.externalConfig, undefined);
  assert.equal(response.body.data.adapterResult.apiToken, undefined);
  assert.equal(response.body.data.adapterResult.webhookSecret, undefined);
});

test("Outbound API - response does not expose apiToken", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([
    {
      companyId: a.company._id,
      name: "A Channel",
      type: "webchat",
      status: "active",
      externalConfig: { apiToken: "super-secret-token" },
    },
  ]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "test" })
    .expect(201);

  const body = JSON.stringify(response.body);
  assert.equal(body.includes("super-secret-token"), false);
  assert.equal(body.includes("apiToken"), false);
});

test("Outbound API - response does not expose webhookSecret", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([
    {
      companyId: a.company._id,
      name: "A Channel",
      type: "webchat",
      status: "active",
      externalConfig: { webhookSecret: "super-secret-webhook" },
    },
  ]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "test" })
    .expect(201);

  const body = JSON.stringify(response.body);
  assert.equal(body.includes("super-secret-webhook"), false);
  assert.equal(body.includes("webhookSecret"), false);
});

test("Outbound API - nested externalConfig credentials remain hidden", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([
    {
      companyId: a.company._id,
      name: "A Channel",
      type: "webchat",
      status: "active",
      externalConfig: {
        nested: { apiToken: "nested-secret", webhookSecret: "nested-webhook" },
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
    },
  ]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "test" })
    .expect(201);

  const body = JSON.stringify(response.body);
  assert.equal(body.includes("nested-secret"), false);
  assert.equal(body.includes("nested-webhook"), false);
  assert.equal(body.includes("access-token"), false);
  assert.equal(body.includes("refresh-token"), false);
  assert.equal(body.includes("apiToken"), false);
  assert.equal(body.includes("webhookSecret"), false);
  assert.equal(body.includes("accessToken"), false);
  assert.equal(body.includes("refreshToken"), false);
});

test("Outbound API - adapter uses server-side channel config, not client-supplied credentials", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([
    {
      companyId: a.company._id,
      name: "A Channel",
      type: "webchat",
      status: "active",
      externalConfig: { apiToken: "server-token" },
      metadata: {},
    },
  ]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({
      conversationId: String(conversationA._id),
      channelType: "webchat",
      body: "test",
      metadata: { apiToken: "client-token" },
    })
    .expect(201);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.message.metadata?.apiToken, undefined);
  assert.equal(response.body.data.message.metadata?.webhookSecret, undefined);
});

test("Outbound API - mock adapter respects tenant isolation on channel lookup", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelB] = await Channel.create([{ companyId: b.company._id, name: "B Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "test" })
    .expect(404);

  assert.equal(response.body.success, false);
});

test("Outbound API - controlled adapter failure produces failed delivery state", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "fail-test", simulateFailure: true })
    .expect(201);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.message.deliveryStatus, "failed");
  assert.ok(response.body.data.message.deliveryError);
});

test("Outbound API - successful delivery produces sent delivery state", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "success-test" })
    .expect(201);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.message.deliveryStatus, "sent");
  assert.ok(response.body.data.message.externalMessageId);
});

test("Outbound API - duplicate idempotent request does not create duplicate delivery", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);
  const externalMessageId = "idempotent-msg-1";

  const response1 = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "idem-test", externalMessageId })
    .expect(201);

  assert.equal(response1.body.success, true);
  assert.equal(response1.body.data.duplicate, false);

  const response2 = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "idem-test", externalMessageId })
    .expect(200);

  assert.equal(response2.body.success, true);
  assert.equal(response2.body.data.duplicate, true);
  assert.equal(String(response2.body.data.message._id), String(response1.body.data.message._id));

  const count = await Message.countDocuments({ companyId: a.company._id, externalMessageId, isDeleted: false });
  assert.equal(count, 1);
});

test("Outbound API - error responses do not leak secrets or sensitive configuration", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([
    {
      companyId: a.company._id,
      name: "A Channel",
      type: "webchat",
      status: "inactive",
      externalConfig: { apiToken: "secret-token", webhookSecret: "secret-webhook" },
    },
  ]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "test" })
    .expect(404);

  const body = JSON.stringify(response.body);
  assert.equal(body.includes("secret-token"), false);
  assert.equal(body.includes("secret-webhook"), false);
  assert.equal(body.includes("apiToken"), false);
  assert.equal(body.includes("webhookSecret"), false);
});
