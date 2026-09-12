const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-j-int-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-j-int-refresh-secret";

let mongo;
let app;
let tokenA;
let tokenALimited;
let tokenB;
let a;
let b;

const Company = require("../src/models/Company");
const User = require("../src/models/User");
const Role = require("../src/models/Role");
const Channel = require("../src/models/Channel");
const Customer = require("../src/models/Customer");
const CustomerIdentity = require("../src/models/CustomerIdentity");
const Conversation = require("../src/models/Conversation");
const Message = require("../src/models/Message");
const AuditLog = require("../src/models/AuditLog");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(email, password) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password });
  return response.body.data.accessToken;
}

function makeSignature(secret, timestamp, body) {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const sig = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("hex");
  return `sha256=${sig}`;
}

function nowTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

function webhookHeaders(webhookPath, secret, timestamp, body) {
  return {
    "x-corvanta-signature": makeSignature(secret, timestamp, body),
    "x-corvanta-timestamp": timestamp,
  };
}

async function setupCompaniesAndUsers() {
  const [companyA, companyB] = await Company.create([
    { name: "Test Company A", slug: "test-company-a" },
    { name: "Test Company B", slug: "test-company-b" },
  ]);

  const fullPermissions = ["channels:read", "channels:create", "channels:update", "channels:delete"];
  const limitedPermissions = ["channels:read"];

  const [roleA, roleALimited, roleB] = await Role.create([
    { companyId: companyA._id, name: "A Full", slug: "test-a-full", permissions: fullPermissions },
    { companyId: companyA._id, name: "A Limited", slug: "test-a-limited", permissions: limitedPermissions },
    { companyId: companyB._id, name: "B Full", slug: "test-b-full", permissions: fullPermissions },
  ]);

  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userALimited, userB] = await User.create([
    { companyId: companyA._id, name: "User A", email: "a@test.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyA._id, name: "User A Limited", email: "al@test.com", passwordHash, roleId: roleALimited._id, status: "active" },
    { companyId: companyB._id, name: "User B", email: "b@test.com", passwordHash, roleId: roleB._id, status: "active" },
  ]);

  a = { company: companyA };
  b = { company: companyB };

  tokenA = await login(userA.email, "Password123!");
  tokenALimited = await login(userALimited.email, "Password123!");
  tokenB = await login(userB.email, "Password123!");
}

async function makeChannel(companyId, overrides = {}) {
  return Channel.create({
    name: "Email Channel",
    type: "email",
    status: "inactive",
    externalConfig: { webhookPath: "wh_e2e_test_path", webhookSecret: "test_webhook_secret_123" },
    companyId,
    ...overrides,
  });
}

async function makeCustomerAndIdentity(companyId, channelType = "email", externalId = "e2e-customer-identity") {
  const customer = await Customer.create({ companyId, name: "E2E Customer", email: "e2e@example.com" });
  const identity = await CustomerIdentity.create({
    companyId, customerId: customer._id, channelType, externalId,
  });
  return { customer, identity };
}

function sendInbound(channel, body) {
  const timestamp = nowTimestamp();
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;
  return request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, channel.externalConfig.webhookSecret, timestamp, body))
    .send(body);
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_j_integration");
  app = require("../app");
  await mongoose.connect(process.env.MONGO_URI);
  await setupCompaniesAndUsers();
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(async () => {
  await Channel.deleteMany({});
  await Customer.deleteMany({});
  await CustomerIdentity.deleteMany({});
  await Conversation.deleteMany({});
  await Message.deleteMany({});
  await AuditLog.deleteMany({});
});

test("E2E - connect channel then inbound webhook succeeds, disconnect then inbound rejected", async () => {
  const channel = await makeChannel(a.company._id);
  await makeCustomerAndIdentity(a.company._id);

  const connectRes = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({})
    .expect(200);
  assert.equal(connectRes.body.data.status, "active");

  let inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "active");

  const inboundBody = { channelType: "email", body: "Hello from connected channel", senderIdentity: "e2e-customer-identity", externalMessageId: "msg-e2e-1" };
  const inboundRes = await sendInbound(channel, inboundBody).expect(200);
  assert.equal(inboundRes.body.success, true);
  assert.equal(String(inboundRes.body.data.conversation.companyId), a.company._id.toString());

  const convInDb = await Conversation.findOne({ companyId: a.company._id }).lean();
  assert.ok(convInDb);
  assert.equal(convInDb.channelId.toString(), channel._id.toString());

  const disconnectRes = await request(app)
    .post(`/api/v1/channels/${channel._id}/disconnect`)
    .set(auth(tokenA))
    .send({})
    .expect(200);
  assert.equal(disconnectRes.body.data.status, "inactive");

  inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "inactive");

  const rejectedInbound = await sendInbound(channel, { channelType: "email", body: "Hello after disconnect", senderIdentity: "e2e-customer-identity", externalMessageId: "msg-e2e-2" }).expect(404);
  assert.equal(rejectedInbound.body.success, false);
});

test("E2E - retry error channel then inbound succeeds (interaction with Mission 2)", async () => {
  const channel = await makeChannel(a.company._id);
  await makeCustomerAndIdentity(a.company._id);

  await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ simulateFailure: true })
    .expect(202);

  let statusRes = await request(app).get(`/api/v1/channels/${channel._id}/connection`).set(auth(tokenA)).expect(200);
  assert.equal(statusRes.body.data.status, "error");
  assert.ok(statusRes.body.data.lastError);

  await sendInbound(channel, { channelType: "email", body: "Hello while errored", senderIdentity: "e2e-customer-identity", externalMessageId: "msg-errored-1" }).expect(404);

  const retryRes = await request(app)
    .post(`/api/v1/channels/${channel._id}/retry`)
    .set(auth(tokenA))
    .send({})
    .expect(200);
  assert.equal(retryRes.body.data.status, "active");

  const inboundRes = await sendInbound(channel, { channelType: "email", body: "Hello after retry", senderIdentity: "e2e-customer-identity", externalMessageId: "msg-retry-1" }).expect(200);
  assert.equal(inboundRes.body.success, true);

  const audit = await AuditLog.findOne({ companyId: a.company._id, action: "channel.reconnected" }).lean();
  assert.ok(audit);
  assert.equal(audit.entityId, channel._id.toString());
});

test("E2E - connected channel status exposes externalId but never the webhook secret", async () => {
  const channel = await makeChannel(a.company._id);
  await request(app).post(`/api/v1/channels/${channel._id}/connect`).set(auth(tokenA)).send({}).expect(200);

  const statusRes = await request(app).get(`/api/v1/channels/${channel._id}/connection`).set(auth(tokenA)).expect(200);
  assert.equal(statusRes.body.data.status, "active");
  assert.ok(statusRes.body.data.externalId);
  assert.ok(statusRes.body.data.connectedAt);
  assert.equal(statusRes.body.data.lastError, null);
  assert.equal(statusRes.body.data.webhookSecret, undefined);

  const rawJson = JSON.stringify(statusRes.body);
  assert.equal(rawJson.includes("test_webhook_secret_123"), false);
});

test("ADV - cross-tenant: company A cannot connect, inspect, or retry company B channel", async () => {
  const channelB = await makeChannel(b.company._id);

  await request(app).post(`/api/v1/channels/${channelB._id}/connect`).set(auth(tokenA)).send({}).expect(404);
  await request(app).get(`/api/v1/channels/${channelB._id}/connection`).set(auth(tokenA)).expect(404);
  await request(app).post(`/api/v1/channels/${channelB._id}/retry`).set(auth(tokenA)).send({}).expect(404);
  await request(app).post(`/api/v1/channels/${channelB._id}/disconnect`).set(auth(tokenA)).send({}).expect(404);

  const inDb = await Channel.findById(channelB._id).lean();
  assert.equal(inDb.status, "inactive");
});

test("ADV - forged companyId in connect/retry body is ignored", async () => {
  const channel = await makeChannel(a.company._id);
  const foreignCompanyId = b.company._id.toString();

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ companyId: foreignCompanyId })
    .expect(200);

  assert.equal(response.body.data.status, "active");
  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(String(inDb.companyId), a.company._id.toString());
});

test("ADV - unauthorized user (no channels:update) cannot connect or retry; can read status", async () => {
  const channel = await makeChannel(a.company._id);

  await request(app).post(`/api/v1/channels/${channel._id}/connect`).set(auth(tokenALimited)).send({}).expect(403);
  await request(app).post(`/api/v1/channels/${channel._id}/retry`).set(auth(tokenALimited)).send({}).expect(403);
  await request(app).post(`/api/v1/channels/${channel._id}/disconnect`).set(auth(tokenALimited)).send({}).expect(403);

  const statusRes = await request(app).get(`/api/v1/channels/${channel._id}/connection`).set(auth(tokenALimited)).expect(200);
  assert.equal(statusRes.body.data.status, "inactive");
  assert.equal(String(statusRes.body.data.companyId || a.company._id), a.company._id.toString());
});

test("ADV - invalid identifiers are rejected", async () => {
  const fakeId = new mongoose.Types.ObjectId().toString();
  await request(app).post(`/api/v1/channels/${fakeId}/connect`).set(auth(tokenA)).send({}).expect(404);
  await request(app).post(`/api/v1/channels/${fakeId}/retry`).set(auth(tokenA)).send({}).expect(404);
  await request(app).get(`/api/v1/channels/${fakeId}/connection`).set(auth(tokenA)).expect(404);
  await request(app)
    .post("/api/v1/channels/not-a-valid-id/connect")
    .set(auth(tokenA))
    .send({})
    .expect(400);
  await request(app)
    .post("/api/v1/channels/not-a-valid-id/retry")
    .set(auth(tokenA))
    .send({})
    .expect(400);
  await request(app)
    .get("/api/v1/channels/not-a-valid-id/connection")
    .set(auth(tokenA))
    .expect(400);
});

test("ADV - connect body cannot mass-assign protected fields (type/companyId/status ignored)", async () => {
  const channel = await makeChannel(a.company._id);
  const foreignCompanyId = b.company._id.toString();

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ companyId: foreignCompanyId, type: "whatsapp", status: "inactive" })
    .expect(200);

  assert.equal(response.body.data.status, "active");
  assert.equal(response.body.data.type, "email");
  assert.equal(String(response.body.data.companyId), a.company._id.toString());

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "active");
  assert.equal(inDb.type, "email");
  assert.equal(String(inDb.companyId), a.company._id.toString());
});

test("ADV - limited user cannot read another company's channel connection status", async () => {
  const channelB = await makeChannel(b.company._id);

  await request(app).get(`/api/v1/channels/${channelB._id}/connection`).set(auth(tokenALimited)).expect(404);

  const ownChannel = await makeChannel(a.company._id);
  const ownRes = await request(app).get(`/api/v1/channels/${ownChannel._id}/connection`).set(auth(tokenALimited)).expect(200);
  assert.equal(ownRes.body.data.status, "inactive");
});
