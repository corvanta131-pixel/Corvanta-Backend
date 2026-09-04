const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-d-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-d-refresh-secret";

let mongo;
let app;
let tokenA;
let tokenB;
let readonlyToken;
let a;
let b;

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_d");
  app = require("../app");
  const Company = require("../src/models/Company");
  const Role = require("../src/models/Role");
  const User = require("../src/models/User");
  const Customer = require("../src/models/Customer");
  const KnowledgeBase = require("../src/models/KnowledgeBase");
  const KnowledgeDocument = require("../src/models/KnowledgeDocument");
  const AIAgent = require("../src/models/AIAgent");
  const Conversation = require("../src/models/Conversation");
  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Stage D A", slug: "stage-d-a" },
    { name: "Stage D B", slug: "stage-d-b" },
  ]);
  const permissions = ["conversations:messages:read", "conversations:send"];
  const [roleA, roleB, readonlyRole] = await Role.create([
    { companyId: companyA._id, name: "A", slug: "stage-d-a", permissions },
    { companyId: companyB._id, name: "B", slug: "stage-d-b", permissions },
    { companyId: companyA._id, name: "Read only", slug: "stage-d-readonly", permissions: [] },
  ]);
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB, readonly] = await User.create([
    { companyId: companyA._id, name: "A User", email: "stage-d-a@example.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "B User", email: "stage-d-b@example.com", passwordHash, roleId: roleB._id, status: "active" },
    { companyId: companyA._id, name: "Read only", email: "stage-d-readonly@example.com", passwordHash, roleId: readonlyRole._id, status: "active" },
  ]);
  const [customerA, customerB] = await Customer.create([
    { companyId: companyA._id, name: "A Customer" },
    { companyId: companyB._id, name: "B Customer" },
  ]);
  const [kbA, kbB] = await KnowledgeBase.create([
    { companyId: companyA._id, name: "A KB" },
    { companyId: companyB._id, name: "B KB" },
  ]);
  const [agentA, agentB] = await AIAgent.create([
    { companyId: companyA._id, name: "A Agent", slug: "stage-d-a-agent", status: "active", knowledgeBaseIds: [kbA._id], promptTemplate: "Answer from the supplied context." },
    { companyId: companyB._id, name: "B Agent", slug: "stage-d-b-agent", status: "active", knowledgeBaseIds: [kbB._id] },
  ]);
  await KnowledgeDocument.create([
    { companyId: companyA._id, knowledgeBaseId: kbA._id, title: "Published A", content: "A tenant secret refund policy", status: "published" },
    { companyId: companyA._id, knowledgeBaseId: kbA._id, title: "Draft A", content: "draft-only secret", status: "draft" },
    { companyId: companyA._id, knowledgeBaseId: kbA._id, title: "Deleted A", content: "deleted secret", status: "published", isDeleted: true, deletedAt: new Date() },
    { companyId: companyB._id, knowledgeBaseId: kbB._id, title: "Published B", content: "B tenant secret", status: "published" },
  ]);
  const [conversationA, conversationB] = await Conversation.create([
    { companyId: companyA._id, customerId: customerA._id, agentId: agentA._id },
    { companyId: companyB._id, customerId: customerB._id, agentId: agentB._id },
  ]);
  a = { company: companyA, user: userA, customer: customerA, kb: kbA, agent: agentA, conversation: conversationA };
  b = { company: companyB, user: userB, customer: customerB, kb: kbB, agent: agentB, conversation: conversationB };

  tokenA = (await request(app).post("/api/v1/auth/login").send({ email: userA.email, password: "Password123!" })).body.data.accessToken;
  tokenB = (await request(app).post("/api/v1/auth/login").send({ email: userB.email, password: "Password123!" })).body.data.accessToken;
  readonlyToken = (await request(app).post("/api/v1/auth/login").send({ email: readonly.email, password: "Password123!" })).body.data.accessToken;
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test("Stage D message endpoints require authentication and separate permissions", async () => {
  const unauthenticated = await request(app).get(`/api/v1/conversations/${a.conversation._id}/messages`);
  assert.equal(unauthenticated.status, 401);
  const readonly = await request(app).post(`/api/v1/conversations/${a.conversation._id}/messages`).set(auth(readonlyToken)).send({ body: "hello" });
  assert.equal(readonly.status, 403);
});

test("Stage D workflow persists mock user/assistant messages and safe usage metadata", async () => {
  const response = await request(app)
    .post(`/api/v1/conversations/${a.conversation._id}/messages`)
    .set(auth(tokenA))
    .send({ body: "What is the refund policy?" });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.response.provider, "mock");
  assert.ok(response.body.data.response.usage.totalTokens > 0);
  assert.equal(response.body.data.assistantMessage.senderType, "agent");
  assert.equal(response.body.data.assistantMessage.metadata.provider, "mock");
  assert.equal(Object.prototype.hasOwnProperty.call(response.body.data.assistantMessage.metadata, "providerRequestId"), false);

  const listed = await request(app).get(`/api/v1/conversations/${a.conversation._id}/messages`).set(auth(tokenA));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(listed.body.data[0], "isDeleted"), false);
});

test("Stage D rejects tenant, role, and protected-field message attacks", async () => {
  const crossTenant = await request(app)
    .post(`/api/v1/conversations/${b.conversation._id}/messages`)
    .set(auth(tokenA))
    .send({ body: "cross tenant" });
  assert.ok([403, 404].includes(crossTenant.status));

  for (const senderType of ["agent", "system"]) {
    const impersonation = await request(app)
      .post(`/api/v1/conversations/${a.conversation._id}/messages`)
      .set(auth(tokenA))
      .send({ body: "impersonated", senderType });
    assert.equal(impersonation.status, 400);
  }
  const protectedFields = await request(app)
    .post(`/api/v1/conversations/${a.conversation._id}/messages`)
    .set(auth(tokenA))
    .send({ body: "tampered", companyId: b.company._id, senderId: b.user._id, isDeleted: true });
  assert.equal(protectedFields.status, 400);
});

test("Stage D retrieval is tenant-scoped and excludes draft/deleted documents", async () => {
  const { retrieveKnowledge } = require("../src/services/knowledgeRetriever");
  const results = await retrieveKnowledge({ companyId: a.company._id, knowledgeBaseIds: [a.kb._id], query: "secret", limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Published A");
  await assert.rejects(
    () => retrieveKnowledge({ companyId: a.company._id, knowledgeBaseIds: [b.kb._id], query: "secret" }),
    (error) => error.statusCode === 403
  );
  const KnowledgeBase = require("../src/models/KnowledgeBase");
  await KnowledgeBase.updateOne({ _id: a.kb._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
  await assert.rejects(
    () => retrieveKnowledge({ companyId: a.company._id, knowledgeBaseIds: [a.kb._id], query: "secret" }),
    (error) => error.statusCode === 403
  );
  await KnowledgeBase.updateOne({ _id: a.kb._id }, { $set: { isDeleted: false, deletedAt: null } });
});

test("Stage D provider failures are controlled and do not create assistant messages", async () => {
  const Message = require("../src/models/Message");
  const before = await Message.countDocuments({ companyId: a.company._id, conversationId: a.conversation._id });
  const response = await request(app)
    .post(`/api/v1/conversations/${a.conversation._id}/messages`)
    .set(auth(tokenA))
    .send({ body: "__AI_PROVIDER_FAILURE__" });
  assert.equal(response.status, 502);
  assert.equal(response.body.message, "Internal server error");
  const after = await Message.countDocuments({ companyId: a.company._id, conversationId: a.conversation._id });
  assert.equal(after, before + 1);

  const rateLimited = await request(app)
    .post(`/api/v1/conversations/${a.conversation._id}/messages`)
    .set(auth(tokenA))
    .send({ body: "__AI_PROVIDER_RATE_LIMIT__" });
  assert.equal(rateLimited.status, 429);
  const timedOut = await request(app)
    .post(`/api/v1/conversations/${a.conversation._id}/messages`)
    .set(auth(tokenA))
    .send({ body: "__AI_PROVIDER_TIMEOUT__" });
  assert.equal(timedOut.status, 504);

  const AIAgent = require("../src/models/AIAgent");
  await AIAgent.updateOne({ _id: a.agent._id, companyId: a.company._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
  const deletedAgentResponse = await request(app)
    .post(`/api/v1/conversations/${a.conversation._id}/messages`)
    .set(auth(tokenA))
    .send({ body: "deleted agent" });
  assert.equal(deletedAgentResponse.status, 409);
});

test("Stage D context builder bounds history and keeps current content separate", () => {
  const { buildContext } = require("../src/services/contextBuilder");
  const context = buildContext({
    agent: { promptTemplate: "system instructions" },
    history: [{ senderType: "user", body: "one" }, { senderType: "agent", body: "two" }, { senderType: "user", body: "three" }],
    retrievedKnowledge: [{ title: "doc", content: "knowledge" }],
    currentUserContent: "current",
    options: { historyLimit: 2, contextLimit: 1 },
  });
  assert.equal(context.systemPrompt, "system instructions");
  assert.equal(context.conversationHistory.length, 2);
  assert.equal(context.retrievedKnowledge.length, 1);
  assert.equal(context.currentUserContent, "current");
  assert.equal(context.messages.at(-1).content, "current");
});
