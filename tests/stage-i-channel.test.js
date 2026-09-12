const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-i-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-i-refresh-secret";

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
const CustomerIdentity = require("../src/models/CustomerIdentity");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_i_channel");
  app = require("../app");

  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Test Company A", slug: "test-company-a" },
    { name: "Test Company B", slug: "test-company-b" },
  ]);
  
  const permissions = [
    "channels:read", "channels:create", "channels:update", "channels:delete",
  ];
  const [roleA, roleB] = await Role.create([
    { companyId: companyA._id, name: "A Role", slug: "test-a", permissions },
    { companyId: companyB._id, name: "B Role", slug: "test-b", permissions },
  ]);
  
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB] = await User.create([
    { companyId: companyA._id, name: "User A", email: "a@test.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "User B", email: "b@test.com", passwordHash, roleId: roleB._id, status: "active" },
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
  await CustomerIdentity.deleteMany({});
});

test("Channel API - authenticated access required", async () => {
  const response = await request(app).get("/api/v1/channels");
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("Channel API - list channels", async () => {
  await Channel.create([
    { name: "Channel 1", type: "email", status: "active", companyId: a.company._id },
    { name: "Channel 2", type: "sms", status: "active", companyId: a.company._id },
  ]);
  
  const response = await request(app)
    .get("/api/v1/channels")
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.length, 2);
  response.body.data.forEach(channel => {
    assert.equal(String(channel.companyId), String(a.company._id));
    assert.ok(!channel.externalConfig.webhookSecret);
    assert.ok(!channel.externalConfig.webhookPath);
  });
});

test("Channel API - create channel", async () => {
  const channelData = {
    name: "New Email Channel",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "test-path", webhookSecret: "secret123", otherField: "value" },
    metadata: { source: "api" }
  };
  
  const response = await request(app)
    .post("/api/v1/channels")
    .set(auth(tokenA))
    .send(channelData)
    .expect(201);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.name, "New Email Channel");
  assert.equal(response.body.data.type, "email");
  assert.equal(String(response.body.data.companyId), String(a.company._id));
  assert.equal(response.body.data.metadata.source, "api");
  assert.ok(!response.body.data.externalConfig.webhookSecret);
  assert.ok(!response.body.data.externalConfig.webhookPath);
  assert.equal(response.body.data.externalConfig.otherField, "value");
  
  const createdChannel = await Channel.findById(response.body.data._id);
  assert.ok(createdChannel);
  assert.equal(String(createdChannel.companyId), String(a.company._id));
});

test("Channel API - get channel", async () => {
  const channel = await Channel.create({
    name: "Test Channel",
    type: "whatsapp",
    status: "active",
    companyId: a.company._id,
    externalConfig: { webhookPath: "test-path-2", webhookSecret: "secret456" }
  });
  
  const response = await request(app)
    .get(`/api/v1/channels/${channel._id}`)
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.name, "Test Channel");
  assert.equal(response.body.data.type, "whatsapp");
  assert.equal(String(response.body.data.companyId), String(a.company._id));
  assert.ok(!response.body.data.externalConfig.webhookSecret);
  assert.ok(!response.body.data.externalConfig.webhookPath);
});

test("Channel API - update channel", async () => {
  const channel = await Channel.create({
    name: "Original Name",
    type: "instagram",
    status: "inactive",
    companyId: a.company._id,
    externalConfig: { webhookSecret: "old-secret", webhookPath: "old-path" }
  });
  
  const updateData = {
    name: "Updated Name",
    status: "active",
    externalConfig: { webhookSecret: "new-secret", webhookPath: "new-path" },
    metadata: { updated: true }
  };
  
  const response = await request(app)
    .patch(`/api/v1/channels/${channel._id}`)
    .set(auth(tokenA))
    .send(updateData)
    .expect(200);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.name, "Updated Name");
  assert.equal(response.body.data.status, "active");
  assert.equal(response.body.data.metadata.updated, true);
  assert.ok(!response.body.data.externalConfig.webhookSecret);
  assert.ok(!response.body.data.externalConfig.webhookPath);
});

test("Channel API - delete channel", async () => {
  const channel = await Channel.create({
    name: "To Delete",
    type: "messenger",
    status: "active",
    companyId: a.company._id
  });
  
  const deleteResponse = await request(app)
    .delete(`/api/v1/channels/${channel._id}`)
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(deleteResponse.body.success, true);
  const deletedChannel = await Channel.findById(channel._id);
  assert.ok(deletedChannel.isDeleted);
  
  const getResponse = await request(app)
    .get(`/api/v1/channels/${channel._id}`)
    .set(auth(tokenA))
    .expect(404);
  
  assert.equal(getResponse.body.success, false);
});

test("Channel API - tenant isolation - cannot list other company channels", async () => {
  await Channel.create({ name: "B Channel", type: "email", status: "active", companyId: b.company._id });
  
  const response = await request(app)
    .get("/api/v1/channels")
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(response.body.success, true);
  response.body.data.forEach(channel => {
    assert.equal(String(channel.companyId), String(a.company._id));
  });
});

test("Channel API - cross-tenant IDOR - cannot get other company channel", async () => {
  const bChannel = await Channel.create({
    name: "B Channel",
    type: "email",
    status: "active",
    companyId: b.company._id
  });
  
  const response = await request(app)
    .get(`/api/v1/channels/${bChannel._id}`)
    .set(auth(tokenA))
    .expect(404);
  
  assert.equal(response.body.success, false);
});

test("Channel API - companyId mass-assignment protection", async () => {
  const otherCompanyId = new mongoose.Types.ObjectId();
  
  const response = await request(app)
    .post("/api/v1/channels")
    .set(auth(tokenA))
    .send({ name: "Hack Attempt", type: "email", status: "active", companyId: otherCompanyId.toString() })
    .expect(400);
  
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /company/i);
  
  const created = await Channel.findOne({ name: "Hack Attempt" });
  assert.ok(!created);
});

test("Channel API - sensitive webhook configuration not exposed", async () => {
  const channel = await Channel.create({
    name: "Secret Channel",
    type: "webchat",
    status: "active",
    companyId: a.company._id,
    externalConfig: {
      webhookPath: "super-secret-path",
      webhookSecret: "super-secret-key",
      apiToken: "another-secret",
      regularField: "visible"
    }
  });
  
  const response = await request(app)
    .get(`/api/v1/channels/${channel._id}`)
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.externalConfig.regularField, "visible");
  assert.equal(response.body.data.externalConfig.webhookPath, undefined);
  assert.equal(response.body.data.externalConfig.webhookSecret, undefined);
  assert.equal(response.body.data.externalConfig.apiToken, undefined);
});