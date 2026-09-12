const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-h-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-h-refresh-secret";
process.env.AI_MAX_RETRIES = "1";
process.env.AI_RETRY_BASE_DELAY_MS = "1";

let mongo;
let app;
let tokenA;
let tokenB;
let readonlyToken;
let a;
let b;

const Company = require("../src/models/Company");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Conversation = require("../src/models/Conversation");
const AIAgent = require("../src/models/AIAgent");
const Role = require("../src/models/Role");
const Workflow = require("../src/models/Workflow");
const WorkflowExecution = require("../src/models/WorkflowExecution");
const AuditLog = require("../src/models/AuditLog");
const KnowledgeBase = require("../src/models/KnowledgeBase");

const { runEventWorkflows, resetEngineState } = require("../src/services/workflow/engine");
const { validateWorkflowInput } = require("../src/validators/workflowValidator");
const { setVectorStoreForTests, setEmbeddingProviderForTests } = require("../src/services/ragRuntime");
const { InMemoryVectorStore } = require("../src/services/vectorStore");
const { MockEmbeddingProvider } = require("../src/services/ai/embeddingProvider");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_h");
  app = require("../app");

  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Stage H A", slug: "stage-h-a" },
    { name: "Stage H B", slug: "stage-h-b" },
  ]);
  const permissions = [
    "workflows:read", "workflows:create", "workflows:update", "workflows:delete",
    "conversations:read", "conversations:create", "conversations:update", "conversations:delete",
    "conversations:send", "conversations:messages:read",
    "customers:read", "customers:create", "customers:update", "customers:delete",
    "agents:read", "agents:create",
  ];
  const [roleA, roleB, readonlyRole] = await Role.create([
    { companyId: companyA._id, name: "A", slug: "stage-h-a", permissions },
    { companyId: companyB._id, name: "B", slug: "stage-h-b", permissions },
    { companyId: companyA._id, name: "Readonly", slug: "stage-h-readonly", permissions: [] },
  ]);
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB, readonly] = await User.create([
    { companyId: companyA._id, name: "A User", email: "stage-h-a@example.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "B User", email: "stage-h-b@example.com", passwordHash, roleId: roleB._id, status: "active" },
    { companyId: companyA._id, name: "Readonly", email: "stage-h-readonly@example.com", passwordHash, roleId: readonlyRole._id, status: "active" },
  ]);
  const [customerA, customerB] = await Customer.create([
    { companyId: companyA._id, name: "A Customer", email: "stage-h-a-cust@example.com" },
    { companyId: companyB._id, name: "B Customer", email: "stage-h-b-cust@example.com" },
  ]);
  const [kbA] = await KnowledgeBase.create([{ companyId: companyA._id, name: "A KB" }]);
  const [agentA] = await AIAgent.create([{ companyId: companyA._id, name: "A Agent", slug: "stage-h-a-agent", status: "active", knowledgeBaseIds: [kbA._id], promptTemplate: "Follow system." }]);
  const [conversationA] = await Conversation.create([{ companyId: companyA._id, customerId: customerA._id, agentId: agentA._id }]);

  a = { company: companyA, user: userA, customer: customerA, kb: kbA, agent: agentA, conversation: conversationA };
  b = { company: companyB, user: userB, customer: customerB };

  tokenA = (await request(app).post("/api/v1/auth/login").send({ email: userA.email, password: "Password123!" })).body.data.accessToken;
  tokenB = (await request(app).post("/api/v1/auth/login").send({ email: userB.email, password: "Password123!" })).body.data.accessToken;
  readonlyToken = (await request(app).post("/api/v1/auth/login").send({ email: readonly.email, password: "Password123!" })).body.data.accessToken;

  setVectorStoreForTests(new InMemoryVectorStore());
  setEmbeddingProviderForTests(new MockEmbeddingProvider({ model: "mock-embedding-model", dimensions: 16 }));
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(() => {
  resetEngineState();
});

// === CRUD ===

test("Stage H #1: Create workflow via API succeeds", async () => {
  const payload = {
    name: "Assign to AI on message",
    description: "Auto-assign AI agent on inbound message",
    trigger: { type: "message.received" },
    conditions: [{ field: "channel.type", operator: "eq", value: "email" }],
    actions: [{ type: "assign.conversation.agent", params: { agentId: String(a.agent._id) } }],
    priority: 50,
  };
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send(payload);
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.name, payload.name);
  assert.equal(response.body.data.status, "draft");
  assert.equal(String(response.body.data.companyId), String(a.company._id));
  assert.equal(response.body.data.actions.length, 1);
});

test("Stage H #2: List workflows returns only own company's workflows", async () => {
  await Workflow.create([
    { companyId: a.company._id, name: "A Workflow", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "wf.test" } }] },
    { companyId: b.company._id, name: "B Workflow", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "wf.test" } }] },
  ]);
  const response = await request(app)
    .get("/api/v1/workflows")
    .set(auth(tokenA));
  assert.equal(response.status, 200);
  assert.ok(response.body.data.length >= 1);
  for (const wf of response.body.data) {
    assert.equal(String(wf.companyId), String(a.company._id));
  }
});

test("Stage H #3: Get workflow returns the workflow", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Get Test", trigger: { type: "customer.created" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "wf.get" } }] });
  const response = await request(app)
    .get(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA));
  assert.equal(response.status, 200);
  assert.equal(response.body.data.name, "Get Test");
});

test("Stage H #4: Update workflow applies changes", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Update Test", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "wf.update" } }] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ name: "Updated Name", priority: 200 });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.name, "Updated Name");
  assert.equal(response.body.data.priority, 200);
});

test("Stage H #5: Activate and deactivate workflow", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Activate Test", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "wf.activate" } }] });
  const activate = await request(app)
    .post(`/api/v1/workflows/${wf._id}/activate`)
    .set(auth(tokenA));
  assert.equal(activate.status, 200);
  assert.equal(activate.body.data.status, "active");

  const deactivate = await request(app)
    .post(`/api/v1/workflows/${wf._id}/deactivate`)
    .set(auth(tokenA));
  assert.equal(deactivate.status, 200);
  assert.equal(deactivate.body.data.status, "inactive");
});

test("Stage H #6: Soft delete workflow marks isDeleted true", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Delete Test", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "wf.delete" } }] });
  const response = await request(app)
    .delete(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA));
  assert.equal(response.status, 200);
  const fresh = await Workflow.findById(wf._id).lean();
  assert.equal(fresh.isDeleted, true);
  assert.ok(fresh.deletedAt);
});

test("Stage H #7: Soft-deleted workflow is excluded from list", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Soft Delete List", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "wf.softdelete" } }] });
  await request(app).delete(`/api/v1/workflows/${wf._id}`).set(auth(tokenA));
  const response = await request(app).get("/api/v1/workflows").set(auth(tokenA));
  const ids = response.body.data.map((w) => String(w._id));
  assert.ok(!ids.includes(String(wf._id)));
});

test("Stage H #8: Readonly user cannot create workflows", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(readonlyToken))
    .send({ name: "Should Fail", trigger: { type: "message.received" }, conditions: [], actions: [] });
  assert.equal(response.status, 403);
});

test("Stage H #9: Readonly user cannot list workflows", async () => {
  const response = await request(app)
    .get("/api/v1/workflows")
    .set(auth(readonlyToken));
  assert.equal(response.status, 403);
});

test("Stage H #10: Unauthenticated request is rejected", async () => {
  const response = await request(app).get("/api/v1/workflows");
  assert.equal(response.status, 401);
});
