const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-j-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-j-refresh-secret";

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
const AuditLog = require("../src/models/AuditLog");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(email, password) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password });
  return response.body.data.accessToken;
}

function buildChannel(ownerCompanyId, overrides = {}) {
  return Channel.create({
    name: "Test Channel",
    type: "webchat",
    status: "inactive",
    companyId: ownerCompanyId,
    externalConfig: {
      webhookPath: "test-webhook-path",
      webhookSecret: "test-secret-value",
    },
    ...overrides,
  });
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_j_connect");
  app = require("../app");
  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Test Company A", slug: "test-company-a" },
    { name: "Test Company B", slug: "test-company-b" },
  ]);

  const fullPermissions = [
    "channels:read",
    "channels:create",
    "channels:update",
    "channels:delete",
  ];
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

  a = { company: companyA, user: userA };
  b = { company: companyB, user: userB };

  tokenA = await login(userA.email, "Password123!");
  tokenALimited = await login(userALimited.email, "Password123!");
  tokenB = await login(userB.email, "Password123!");
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(async () => {
  await Channel.deleteMany({});
  await AuditLog.deleteMany({});
});

test("Stage J - connect channel requires authentication", async () => {
  const channel = await buildChannel(a.company._id, { name: "No Auth Channel", externalConfig: { webhookPath: "p", webhookSecret: "s" } });
  const response = await request(app).post(`/api/v1/channels/${channel._id}/connect`);
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("Stage J - connect channel transitions inactive to active", async () => {
  const channel = await buildChannel(a.company._id);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({})
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "active");
  assert.equal(response.body.data.companyId, a.company._id.toString());
  assert.equal(response.body.data.externalConfig.webhookSecret, undefined);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "active");
  assert.ok(inDb.externalConfig.connectedAt, "connectedAt should be persisted");
  assert.ok(inDb.externalConfig.externalId, "externalId should be persisted");
  assert.equal(inDb.externalConfig.connectionError, undefined);

  const audit = await AuditLog.findOne({ companyId: a.company._id, action: "channel.connected" }).lean();
  assert.ok(audit);
  assert.equal(audit.entityId, String(channel._id));
});

test("Stage J - connect already-active channel returns 409", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app).post(`/api/v1/channels/${channel._id}/connect`).set(auth(tokenA)).send({}).expect(200);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({})
    .expect(409);

  assert.equal(response.body.success, false);
  assert.match(response.body.message, /already connected/i);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "active");
});

test("Stage J - connect channel missing connection config sets status to error", async () => {
  const channel = await Channel.create({
    name: "No Config Channel",
    type: "webchat",
    status: "inactive",
    companyId: a.company._id,
    externalConfig: {},
  });

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({})
    .expect(202);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "error");
  assert.equal(response.body.connection.success, false);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "error");
  assert.ok(inDb.externalConfig.connectionError);

  const audit = await AuditLog.findOne({ companyId: a.company._id, action: "channel.connection.failed" }).lean();
  assert.ok(audit);
});

test("Stage J - connect channel with simulated failure sets status to error", async () => {
  const channel = await buildChannel(a.company._id);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ simulateFailure: true })
    .expect(202);

  assert.equal(response.body.data.status, "error");
  assert.equal(response.body.connection.success, false);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "error");
  assert.ok(inDb.externalConfig.connectionError);
});

test("Stage J - disconnect active channel transitions to inactive", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app).post(`/api/v1/channels/${channel._id}/connect`).set(auth(tokenA)).send({}).expect(200);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/disconnect`)
    .set(auth(tokenA))
    .send({})
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "inactive");

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "inactive");

  const audit = await AuditLog.findOne({ companyId: a.company._id, action: "channel.disconnected" }).lean();
  assert.ok(audit);
});

test("Stage J - disconnect already-inactive channel is idempotent", async () => {
  const channel = await buildChannel(a.company._id);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/disconnect`)
    .set(auth(tokenA))
    .send({})
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "inactive");
  assert.equal(response.body.message, "Channel was already disconnected.");
});

test("Stage J - cannot connect another company's channel (tenant isolation)", async () => {
  const channel = await buildChannel(b.company._id);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({})
    .expect(404);

  assert.equal(response.body.success, false);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "inactive");
});

test("Stage J - cannot disconnect another company's channel (cross-tenant IDOR)", async () => {
  const channel = await buildChannel(b.company._id);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/disconnect`)
    .set(auth(tokenA))
    .send({})
    .expect(404);

  assert.equal(response.body.success, false);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "inactive");
});

test("Stage J - connect requires channels:update permission", async () => {
  const channel = await buildChannel(a.company._id);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenALimited))
    .send({})
    .expect(403);

  assert.equal(response.body.success, false);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "inactive");
});

test("Stage J - connect endpoint does not honor client-supplied companyId (mass-assignment)", async () => {
  const channel = await buildChannel(a.company._id);
  const foreignCompanyId = b.company._id.toString();

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ companyId: foreignCompanyId })
    .expect(200);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "active");
  assert.equal(String(inDb.companyId), a.company._id.toString());
});

test("Stage J - connect unknown channel id returns 404", async () => {
  const fakeId = new mongoose.Types.ObjectId().toString();

  const response = await request(app)
    .post(`/api/v1/channels/${fakeId}/connect`)
    .set(auth(tokenA))
    .send({})
    .expect(404);

  assert.equal(response.body.success, false);
});

test("Stage J - connect invalid channel id returns 400", async () => {
  const response = await request(app)
    .post(`/api/v1/channels/not-a-valid-id/connect`)
    .set(auth(tokenA))
    .send({})
    .expect(400);

  assert.equal(response.body.success, false);
});

test("Stage J - connection status requires authentication", async () => {
  const channel = await buildChannel(a.company._id);
  const response = await request(app).get(`/api/v1/channels/${channel._id}/connection`);
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("Stage J - connection status for active channel (post-connect)", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app).post(`/api/v1/channels/${channel._id}/connect`).set(auth(tokenA)).send({}).expect(200);

  const response = await request(app)
    .get(`/api/v1/channels/${channel._id}/connection`)
    .set(auth(tokenA))
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "active");
  assert.ok(response.body.data.connectedAt, "connectedAt should be reported");
  assert.equal(response.body.data.lastError, null);
  assert.equal(response.body.data.adapter, "webchat");

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.externalConfig.connectedAt, response.body.data.connectedAt);
});

test("Stage J - connection status reflects errored channel lastError", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ simulateFailure: true })
    .expect(202);

  const response = await request(app)
    .get(`/api/v1/channels/${channel._id}/connection`)
    .set(auth(tokenA))
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "error");
  assert.ok(response.body.data.lastError, "lastError should be reported for errored channel");
});

test("Stage J - connection status for inactive channel", async () => {
  const channel = await buildChannel(a.company._id);

  const response = await request(app)
    .get(`/api/v1/channels/${channel._id}/connection`)
    .set(auth(tokenA))
    .expect(200);

  assert.equal(response.body.data.status, "inactive");
  assert.equal(response.body.data.lastError, null);
  assert.equal(response.body.data.connectedAt, null);
});

test("Stage J - connection status unknown channel returns 404", async () => {
  const fakeId = new mongoose.Types.ObjectId().toString();
  const response = await request(app)
    .get(`/api/v1/channels/${fakeId}/connection`)
    .set(auth(tokenA))
    .expect(404);

  assert.equal(response.body.success, false);
});

test("Stage J - connection status invalid channel id returns 400", async () => {
  const response = await request(app)
    .get(`/api/v1/channels/not-a-valid-id/connection`)
    .set(auth(tokenA))
    .expect(400);

  assert.equal(response.body.success, false);
});

test("Stage J - connection status tenant isolation (cannot view other company channel)", async () => {
  const channel = await buildChannel(b.company._id);
  const response = await request(app)
    .get(`/api/v1/channels/${channel._id}/connection`)
    .set(auth(tokenA))
    .expect(404);

  assert.equal(response.body.success, false);
});

test("Stage J - retry requires channels:update permission", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ simulateFailure: true })
    .expect(202);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/retry`)
    .set(auth(tokenALimited))
    .send({})
    .expect(403);

  assert.equal(response.body.success, false);
});

test("Stage J - retry errored channel succeeds (interacts with Mission 2 connect)", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ simulateFailure: true })
    .expect(202);

  const failedDb = await Channel.findById(channel._id).lean();
  assert.equal(failedDb.status, "error");

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/retry`)
    .set(auth(tokenA))
    .send({})
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "active");
  assert.equal(response.body.connection.success, true);

  const recoveredDb = await Channel.findById(channel._id).lean();
  assert.equal(recoveredDb.status, "active");
  assert.equal(recoveredDb.externalConfig.connectionError, undefined);

  const audit = await AuditLog.findOne({ companyId: a.company._id, action: "channel.reconnected" }).lean();
  assert.ok(audit);
  assert.equal(audit.entityId, String(channel._id));
});

test("Stage J - retry already-active channel returns 409", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app).post(`/api/v1/channels/${channel._id}/connect`).set(auth(tokenA)).send({}).expect(200);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/retry`)
    .set(auth(tokenA))
    .send({})
    .expect(409);

  assert.equal(response.body.success, false);
  assert.match(response.body.message, /error/i);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "active");
});

test("Stage J - retry errored channel with simulated failure stays error", async () => {
  const channel = await buildChannel(a.company._id);
  await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenA))
    .send({ simulateFailure: true })
    .expect(202);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/retry`)
    .set(auth(tokenA))
    .send({ simulateFailure: true })
    .expect(202);

  assert.equal(response.body.data.status, "error");
  assert.equal(response.body.connection.success, false);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "error");
});

test("Stage J - retry other company's channel returns 404 (cross-tenant)", async () => {
  const channel = await buildChannel(b.company._id);
  await request(app)
    .post(`/api/v1/channels/${channel._id}/connect`)
    .set(auth(tokenB))
    .send({ simulateFailure: true })
    .expect(202);

  const response = await request(app)
    .post(`/api/v1/channels/${channel._id}/retry`)
    .set(auth(tokenA))
    .send({})
    .expect(404);

  assert.equal(response.body.success, false);

  const inDb = await Channel.findById(channel._id).lean();
  assert.equal(inDb.status, "error");
});

test("Stage J - retry unknown channel returns 404", async () => {
  const fakeId = new mongoose.Types.ObjectId().toString();
  const response = await request(app)
    .post(`/api/v1/channels/${fakeId}/retry`)
    .set(auth(tokenA))
    .send({})
    .expect(404);

  assert.equal(response.body.success, false);
});

test("Stage J - retry invalid channel id returns 400", async () => {
  const response = await request(app)
    .post(`/api/v1/channels/not-a-valid-id/retry`)
    .set(auth(tokenA))
    .send({})
    .expect(400);

  assert.equal(response.body.success, false);
});
