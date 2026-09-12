const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-i-cid-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-i-cid-refresh-secret";

let mongo;
let app;
let tokenA;
let tokenB;
let a;
let b;

const Company = require("../src/models/Company");
const User = require("../src/models/User");
const Role = require("../src/models/Role");
const Customer = require("../src/models/Customer");
const Channel = require("../src/models/Channel");
const CustomerIdentity = require("../src/models/CustomerIdentity");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_i_customer_identity");
  app = require("../app");

  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Test Company A", slug: "test-company-a-cid" },
    { name: "Test Company B", slug: "test-company-b-cid" },
  ]);
  
  const permissions = [
    "customer-identities:read", "customer-identities:create", "customer-identities:update", "customer-identities:delete",
  ];
  const [roleA, roleB] = await Role.create([
    { companyId: companyA._id, name: "A Role", slug: "test-a-cid", permissions },
    { companyId: companyB._id, name: "B Role", slug: "test-b-cid", permissions },
  ]);
  
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB] = await User.create([
    { companyId: companyA._id, name: "User A", email: "a@cidtest.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "User B", email: "b@cidtest.com", passwordHash, roleId: roleB._id, status: "active" },
  ]);
  
  const [customerA, customerB] = await Customer.create([
    { companyId: companyA._id, name: "Customer A", email: "customer-a@example.com" },
    { companyId: companyB._id, name: "Customer B", email: "customer-b@example.com" },
  ]);
  
  const [channelA, channelB] = await Channel.create([
    { name: "Company A Email", type: "email", status: "active", companyId: companyA._id },
    { name: "Company B Email", type: "email", status: "active", companyId: companyB._id },
  ]);
  
  a = { company: companyA, user: userA, customer: customerA, channel: channelA };
  b = { company: companyB, user: userB, customer: customerB, channel: channelB };

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

test("CustomerIdentity API - authenticated access required", async () => {
  const response = await request(app).get("/api/v1/customer-identities");
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("CustomerIdentity API - list identities", async () => {
  await CustomerIdentity.create([
    { companyId: a.company._id, customerId: a.customer._id, channelType: "email", externalId: "ext-id-1" },
    { companyId: a.company._id, customerId: a.customer._id, channelType: "whatsapp", externalId: "ext-id-2" },
  ]);
  
  const response = await request(app)
    .get("/api/v1/customer-identities")
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.length, 2);
  response.body.data.forEach(identity => {
    assert.equal(String(identity.companyId), String(a.company._id));
  });
});

test("CustomerIdentity API - create identity", async () => {
  const identityData = {
    customerId: a.customer._id.toString(),
    channelType: "email",
    externalId: "new-external-id",
  };
  
  const response = await request(app)
    .post("/api/v1/customer-identities")
    .set(auth(tokenA))
    .send(identityData)
    .expect(201);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.channelType, "email");
  assert.equal(response.body.data.externalId, "new-external-id");
  assert.equal(String(response.body.data.companyId), String(a.company._id));
  assert.equal(String(response.body.data.customerId), String(a.customer._id));
  
  const created = await CustomerIdentity.findById(response.body.data._id);
  assert.ok(created);
});

test("CustomerIdentity API - get identity", async () => {
  const identity = await CustomerIdentity.create({
    companyId: a.company._id,
    customerId: a.customer._id,
    channelType: "instagram",
    externalId: "ig-external-id",
  });
  
  const response = await request(app)
    .get(`/api/v1/customer-identities/${identity._id}`)
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.channelType, "instagram");
  assert.equal(response.body.data.externalId, "ig-external-id");
  assert.equal(String(response.body.data.companyId), String(a.company._id));
});

test("CustomerIdentity API - update identity", async () => {
  const identity = await CustomerIdentity.create({
    companyId: a.company._id,
    customerId: a.customer._id,
    channelType: "sms",
    externalId: "sms-external-id",
  });
  
  const updateData = { externalId: "updated-external-id" };
  
  const response = await request(app)
    .patch(`/api/v1/customer-identities/${identity._id}`)
    .set(auth(tokenA))
    .send(updateData)
    .expect(200);
  
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.externalId, "updated-external-id");
});

test("CustomerIdentity API - delete identity", async () => {
  const identity = await CustomerIdentity.create({
    companyId: a.company._id,
    customerId: a.customer._id,
    channelType: "messenger",
    externalId: "msg-external-id",
  });
  
  const deleteResponse = await request(app)
    .delete(`/api/v1/customer-identities/${identity._id}`)
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(deleteResponse.body.success, true);
  
  const getResponse = await request(app)
    .get(`/api/v1/customer-identities/${identity._id}`)
    .set(auth(tokenA))
    .expect(404);
  
  assert.equal(getResponse.body.success, false);
});

test("CustomerIdentity API - tenant isolation - cannot list other company identities", async () => {
  await CustomerIdentity.create({
    companyId: b.company._id,
    customerId: b.customer._id,
    channelType: "email",
    externalId: "b-external-id",
  });
  
  const response = await request(app)
    .get("/api/v1/customer-identities")
    .set(auth(tokenA))
    .expect(200);
  
  assert.equal(response.body.success, true);
  response.body.data.forEach(identity => {
    assert.equal(String(identity.companyId), String(a.company._id));
  });
});

test("CustomerIdentity API - cross-tenant IDOR - cannot get other company identity", async () => {
  const bIdentity = await CustomerIdentity.create({
    companyId: b.company._id,
    customerId: b.customer._id,
    channelType: "email",
    externalId: "b-cross-id",
  });
  
  const response = await request(app)
    .get(`/api/v1/customer-identities/${bIdentity._id}`)
    .set(auth(tokenA))
    .expect(404);
  
  assert.equal(response.body.success, false);
});

test("CustomerIdentity API - customer/channel company mismatch rejection", async () => {
  const identityData = {
    customerId: b.customer._id.toString(),
    channelType: "email",
    externalId: "mismatch-test-id",
  };
  
  const response = await request(app)
    .post("/api/v1/customer-identities")
    .set(auth(tokenA))
    .send(identityData)
    .expect(403);
  
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /customer/i);
});

test("CustomerIdentity API - companyId mass-assignment protection", async () => {
  const otherCompanyId = new mongoose.Types.ObjectId();
  
  const response = await request(app)
    .post("/api/v1/customer-identities")
    .set(auth(tokenA))
    .send({
      customerId: a.customer._id.toString(),
      channelType: "email",
      externalId: "hack-id",
      companyId: otherCompanyId.toString()
    })
    .expect(400);
  
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /company/i);
  
  const created = await CustomerIdentity.findOne({ externalId: "hack-id" });
  assert.ok(!created);
});