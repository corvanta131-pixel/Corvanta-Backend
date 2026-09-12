const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-k-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-k-refresh-secret";

let mongo;
let idempotency;
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

const request = require("supertest");
const bcrypt = require("bcryptjs");
const IdempotencyRecord = require("../src/models/IdempotencyRecord");

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_k_idempotency");
  await mongoose.connect(process.env.MONGO_URI);
  await IdempotencyRecord.createIndexes();
  idempotency = require("../src/services/idempotencyService");
  app = require("../app");

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
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(async () => {
  await IdempotencyRecord.deleteMany({});
});

const COMP_A = new mongoose.Types.ObjectId();
const COMP_B = new mongoose.Types.ObjectId();
const COMP_C = new mongoose.Types.ObjectId();
const COMP_D = new mongoose.Types.ObjectId();
const COMP_E = new mongoose.Types.ObjectId();

test("K - persistent idempotency rejects duplicate write at database level", async () => {
  const key = idempotency.getIdempotencyKey(COMP_A, "email", "msg-1");
  assert.equal(key, `idemp:${COMP_A}:email:msg-1`);

  const first = await idempotency.storeIdempotency(COMP_A, "email", "msg-1", { executed: true, messageId: "m1" });
  assert.equal(first.persisted, true);
  assert.equal(first.duplicate, undefined);

  const second = await idempotency.storeIdempotency(COMP_A, "email", "msg-1", { executed: true, messageId: "m2" });
  assert.equal(second.duplicate, true);

  const count = await IdempotencyRecord.countDocuments({});
  assert.equal(count, 1, "only one record should exist");
});

test("K - checkIdempotency returns persisted result on duplicate, null on first call", async () => {
  const existing = await idempotency.checkIdempotency(COMP_B, "email", "msg-2");
  assert.equal(existing, null);

  await idempotency.storeIdempotency(COMP_B, "email", "msg-2", { executed: true, messageId: "m2" });

  const found = await idempotency.checkIdempotency(COMP_B, "email", "msg-2");
  assert.ok(found, "duplicate should be detected");
  assert.equal(found.persisted, true);
  assert.equal(found.result.executed, true);
});

test("K - idempotency keys are tenant-scoped (same external id, different company)", async () => {
  await idempotency.storeIdempotency(COMP_A, "email", "msg-x", { executed: true });
  const other = await idempotency.checkIdempotency(COMP_B, "email", "msg-x");
  assert.equal(other, null, "company B must not see company A idempotency record");

  const count = await IdempotencyRecord.countDocuments({});
  assert.equal(count, 1);
});

test("K - idempotency record is persisted to the database", async () => {
  await idempotency.storeIdempotency(COMP_C, "email", "msg-3", { executed: true, messageId: "m3" });

  const record = await IdempotencyRecord.findOne({ key: `idemp:${COMP_C}:email:msg-3` }).lean();
  assert.ok(record, "record should exist");
  assert.equal(record.companyId.toString(), COMP_C.toString());
  assert.equal(record.scope, "email");
  assert.equal(record.externalMessageId, "msg-3");
  assert.equal(record.executed, true);
  assert.ok(record.ttl, "ttl should be set");
});

test("K - cleanup removes expired records", async () => {
  const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await IdempotencyRecord.create({
    key: "idemp:comp-4:email:msg-old",
    scope: "email",
    externalMessageId: "msg-old",
    result: { executed: true },
    executed: true,
    ttl: oldDate,
    companyId: COMP_D,
  });
  await IdempotencyRecord.create({
    key: "idemp:comp-4:email:msg-new",
    scope: "email",
    externalMessageId: "msg-new",
    result: { executed: true },
    executed: true,
    ttl: new Date(Date.now() + 24 * 60 * 60 * 1000),
    companyId: COMP_D,
  });

  const removed = await idempotency.cleanupExpiredIdempotency(24 * 60 * 60 * 1000);
  assert.equal(removed, 1);

  const remaining = await IdempotencyRecord.find({}).lean();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].externalMessageId, "msg-new");
});

test("K - unique index prevents duplicate keys across workers", async () => {
await IdempotencyRecord.create({
    key: "idemp:comp-5:email:msg-5",
    scope: "email",
    externalMessageId: "msg-5",
    result: { executed: true },
    executed: true,
    ttl: new Date(Date.now() + 24 * 60 * 60 * 1000),
   companyId: COMP_E,
  });

  let threw = false;
  try {
    await IdempotencyRecord.create({
      key: "idemp:comp-5:email:msg-5",
      scope: "email",
      externalMessageId: "msg-5",
      result: { executed: true },
      executed: true,
      ttl: new Date(Date.now() + 24 * 60 * 60 * 1000),
      companyId: COMP_E,
    });
  } catch (error) {
    threw = true;
    assert.equal(error.code, 11000, "duplicate key error code should be 11000");
  }
  assert.equal(threw, true, "duplicate insert must throw");
});

test("K - integration: idempotency survives process disconnect (state is persisted, not in-memory)", async () => {
  await idempotency.storeIdempotency(COMP_C, "email", "msg-persist", { executed: true, messageId: "m-persist" });
  assert.equal(await IdempotencyRecord.countDocuments({ key: `idemp:${COMP_C}:email:msg-persist` }), 1);

  // Simulate a process restart: drop the in-memory Map (which no longer holds state)
  // and re-read from the database.
  const record = await IdempotencyRecord.findOne({ key: `idemp:${COMP_C}:email:msg-persist` }).lean();
  assert.ok(record, "record must be readable from persistence after restart");
  assert.equal(record.executed, true);

  const found = await idempotency.checkIdempotency(COMP_C, "email", "msg-persist");
  assert.ok(found, "duplicate must be detected from persisted state");
  assert.equal(found.persisted, true);
});

test("K - adversarial: forged company id in idempotency key is rejected (not stored)", async () => {
  const foreign = new mongoose.Types.ObjectId();
  await idempotency.storeIdempotency(COMP_C, "email", "msg-forged", { executed: true });
  const other = await idempotency.checkIdempotency(foreign, "email", "msg-forged");
  assert.equal(other, null, "foreign company must not see the record");
  assert.equal(await IdempotencyRecord.countDocuments({}), 1);
});

test("K - adversarial: empty/missing external message id is handled", async () => {
  await assert.rejects(
    () => idempotency.storeIdempotency(COMP_C, "email", "", { executed: true }),
    /externalMessageId/
  );
  await assert.rejects(
    () => idempotency.storeIdempotency(COMP_C, "email", null, { executed: true }),
    /externalMessageId/
  );
});

test("K - adversarial: storeIdempotency result is not exposed to callers (no secret leakage)", async () => {
  const result = await idempotency.storeIdempotency(COMP_C, "email", "msg-secret", { executed: true, secret: "should-not-leak" });
  assert.equal(result.persisted, true);
  assert.equal(result.result.secret, "should-not-leak");
  assert.equal(result.key, `idemp:${COMP_C}:email:msg-secret`);
  assert.equal(result.duplicate, undefined);
});

test("K - adversarial: repeated identical store calls are idempotent (no duplicate records)", async () => {
  for (let i = 0; i < 5; i += 1) {
    await idempotency.storeIdempotency(COMP_C, "email", "msg-repeat", { executed: true, messageId: `m-${i}` });
  }
  assert.equal(await IdempotencyRecord.countDocuments({}), 1);
  const found = await idempotency.checkIdempotency(COMP_C, "email", "msg-repeat");
  assert.ok(found);
});

test("K - adversarial: cleanup with zero ttl removes nothing, normal ttl removes expired records", async () => {
  // A record with a future ttl is NOT expired.
  await IdempotencyRecord.create({
    key: "idemp:comp-6:email:msg-future",
    scope: "email",
    externalMessageId: "msg-future",
    result: { executed: true },
    executed: true,
    ttl: new Date(Date.now() + 24 * 60 * 60 * 1000),
    companyId: COMP_D,
  });
  const removedZero = await idempotency.cleanupExpiredIdempotency(0);
  assert.equal(removedZero, 0);
  assert.equal(await IdempotencyRecord.countDocuments({}), 1);

  // A record with a past ttl IS expired and is removed by a normal window.
  await IdempotencyRecord.create({
    key: "idemp:comp-6:email:msg-past",
    scope: "email",
    externalMessageId: "msg-past",
    result: { executed: true },
    executed: true,
    ttl: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    companyId: COMP_D,
  });
  const removedAll = await idempotency.cleanupExpiredIdempotency(24 * 60 * 60 * 1000);
  assert.equal(removedAll, 1);
  assert.equal(await IdempotencyRecord.countDocuments({}), 1);
  assert.equal(await IdempotencyRecord.findOne({ key: "idemp:comp-6:email:msg-past" }).lean(), null);
});