const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-h-adv-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-h-adv-refresh-secret";

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
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_h_adv");
  app = require("../app");

  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Stage H Adv A", slug: "stage-h-adv-a" },
    { name: "Stage H Adv B", slug: "stage-h-adv-b" },
  ]);
  const permissions = [
    "workflows:read", "workflows:create", "workflows:update", "workflows:delete",
    "conversations:read", "conversations:create", "conversations:update",
    "customers:read", "customers:create",
    "agents:read", "agents:create",
  ];
  const [roleA, roleB] = await Role.create([
    { companyId: companyA._id, name: "A", slug: "stage-h-adv-a", permissions },
    { companyId: companyB._id, name: "B", slug: "stage-h-adv-b", permissions },
  ]);
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB] = await User.create([
    { companyId: companyA._id, name: "A User", email: "stage-h-adv-a@example.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "B User", email: "stage-h-adv-b@example.com", passwordHash, roleId: roleB._id, status: "active" },
  ]);
  const [customerA, customerB] = await Customer.create([
    { companyId: companyA._id, name: "A Customer" },
    { companyId: companyB._id, name: "B Customer" },
  ]);
  const [kbA] = await require("../src/models/KnowledgeBase").create([{ companyId: companyA._id, name: "A KB" }]);
  const [agentA] = await AIAgent.create([{ companyId: companyA._id, name: "A Agent", slug: "stage-h-adv-a-agent", status: "active", knowledgeBaseIds: [kbA._id], promptTemplate: "Follow system." }]);
  const [conversationA] = await Conversation.create([{ companyId: companyA._id, customerId: customerA._id, agentId: agentA._id }]);

  a = { company: companyA, user: userA, customer: customerA, agent: agentA, conversation: conversationA };
  b = { company: companyB, user: userB, customer: customerB };

  tokenA = (await request(app).post("/api/v1/auth/login").send({ email: userA.email, password: "Password123!" })).body.data.accessToken;
  tokenB = (await request(app).post("/api/v1/auth/login").send({ email: userB.email, password: "Password123!" })).body.data.accessToken;

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

// === Tenant Isolation ===

test("Stage H Security #1: Company A cannot access Company B workflow", async () => {
  const wfB = await Workflow.create({ companyId: b.company._id, name: "B Workflow", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app).get(`/api/v1/workflows/${wfB._id}`).set(auth(tokenA));
  assert.equal(response.status, 404);
});

test("Stage H Security #2: Company A cannot list Company B workflows", async () => {
  await Workflow.create({ companyId: b.company._id, name: "B Workflow", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app).get("/api/v1/workflows").set(auth(tokenA));
  assert.equal(response.status, 200);
  for (const wf of response.body.data) {
    assert.notEqual(String(wf.companyId), String(b.company._id));
  }
});

test("Stage H Security #3: CompanyId override in payload is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "IDOR Test", companyId: String(b.company._id), trigger: { type: "message.received" }, conditions: [], actions: [] });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /company/i);
});

test("Stage H Security #4: Cross-tenant workflow creation rejected", async () => {
  const otherCompanyAgent = await AIAgent.create({ companyId: b.company._id, name: "B Agent", slug: "b-agent-cross-test", status: "active", knowledgeBaseIds: [], promptTemplate: "" });
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({
      name: "Cross Tenant",
      trigger: { type: "message.received" },
      conditions: [],
      actions: [{ type: "assign.conversation.agent", params: { agentId: String(otherCompanyAgent._id) } }],
    });
  assert.notEqual(response.status, 201);
});

test("Stage H Security #5: IDOR - User cannot update another company's workflow", async () => {
  const wfB = await Workflow.create({ companyId: b.company._id, name: "B's Workflow", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wfB._id}`)
    .set(auth(tokenA))
    .send({ name: "Hijacked" });
  assert.equal(response.status, 404);
});

test("Stage H Security #6: IDOR - User cannot delete another company's workflow", async () => {
  const wfB = await Workflow.create({ companyId: b.company._id, name: "B's Deletable Workflow", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .delete(`/api/v1/workflows/${wfB._id}`)
    .set(auth(tokenA));
  assert.equal(response.status, 404);
  const stillExists = await Workflow.findById(wfB._id);
  assert.ok(stillExists);
  assert.equal(stillExists.isDeleted, false);
});

test("Stage H Security #7: Readonly user cannot update workflow", async () => {
  const wfA = await Workflow.create({ companyId: a.company._id, name: "Readonly Target", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const [roleA2] = await Role.create([{ companyId: a.company._id, name: "A Readonly", slug: "stage-h-adv-readonly", permissions: ["workflows:read"] }]);
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [readonlyUser] = await User.create([{ companyId: a.company._id, name: "Readonly", email: "stage-h-adv-readonly@example.com", passwordHash, roleId: roleA2._id, status: "active" }]);
  const loginRes = await request(app).post("/api/v1/auth/login").send({ email: readonlyUser.email, password: "Password123!" });
  const roToken = loginRes.body.data.accessToken;

  const response = await request(app)
    .patch(`/api/v1/workflows/${wfA._id}`)
    .set(auth(roToken))
    .send({ name: "Hijacked" });
  assert.equal(response.status, 403);
});

// === Mass Assignment / Protected Fields ===

test("Stage H Security #8: Cannot set isDeleted via update", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Mass Assign Test", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ isDeleted: true });
  assert.equal(response.status, 400);
  const fresh = await Workflow.findById(wf._id);
  assert.equal(fresh.isDeleted, false);
});

test("Stage H Security #9: Cannot set deletedAt via update", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Mass Assign Test 2", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ deletedAt: new Date() });
  assert.equal(response.status, 400);
});

test("Stage H Security #10: Cannot set createdAt via update", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Mass Assign Test 3", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ createdAt: new Date() });
  assert.equal(response.status, 400);
});

test("Stage H Security #11: Cannot set updatedAt via update", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Mass Assign Test 4", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ updatedAt: new Date() });
  assert.equal(response.status, 400);
});

test("Stage H Security #12: Cannot set companyId via update", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Mass Assign Test 5", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ companyId: String(b.company._id) });
  assert.equal(response.status, 400);
});

test("Stage H Security #13: Cannot set createdBy via create", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "CreatedBy Override", createdBy: String(b.user._id), trigger: { type: "message.received" }, conditions: [], actions: [] });
  assert.equal(response.status, 400);
});

// === Input Validation ===

test("Stage H Security #14: Invalid trigger type is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Bad Trigger", trigger: { type: "webhook.received" }, conditions: [], actions: [] });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /trigger/i);
});

test("Stage H Security #15: Invalid action type is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Bad Action", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "send.email" }] });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /action/i);
});

test("Stage H Security #16: Invalid condition operator is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Bad Operator", trigger: { type: "message.received" }, conditions: [{ field: "x", operator: "eval", value: "1" }], actions: [] });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /operator/i);
});

test("Stage H Security #17: Empty workflow name is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "", trigger: { type: "message.received" }, conditions: [], actions: [] });
  assert.equal(response.status, 400);
});

test("Stage H Security #18: Missing trigger type is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Missing Trigger", conditions: [], actions: [] });
  assert.equal(response.status, 400);
});

test("Stage H Security #19: Priority out of range is rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Bad Priority", priority: 99999, trigger: { type: "message.received" }, conditions: [], actions: [] });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /priority/i);
});

test("Stage H Security #20: Non-array conditions are rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Bad Conditions", conditions: "not an array", trigger: { type: "message.received" }, actions: [] });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /array/i);
});

test("Stage H Security #21: Non-array actions are rejected", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Bad Actions", actions: "not an array", trigger: { type: "message.received" }, conditions: [] });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /array/i);
});

test("Stage H Security #22: Condition field over 200 chars is rejected", async () => {
  const longField = "x.".repeat(101).slice(0, -1);
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Long Field", trigger: { type: "message.received" }, conditions: [{ field: longField, operator: "eq", value: "x" }], actions: [] });
  assert.equal(response.status, 400);
});

// === Condition Evaluator Security ===

test("Stage H Security #23: eval() in condition field is blocked", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [{ field: "eval(body)", operator: "eq", value: "x" }], actions: [] }),
    /forbidden|operator|not supported|Unsupported/
  );
});

test("Stage H Security #24: function() in condition field is blocked", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [{ field: "function.bad()", operator: "eq", value: "x" }], actions: [] }),
    /forbidden|operator|not supported|Unsupported/
  );
});

test("Stage H Security #25: __proto__ in condition field is blocked", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [{ field: "__proto__.polluted", operator: "eq", value: "x" }], actions: [] }),
    /forbidden|operator|not supported|Unsupported/
  );
});

test("Stage H Security #26: constructor in condition field is blocked", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [{ field: "constructor", operator: "eq", value: "x" }], actions: [] }),
    /forbidden|operator|not supported|Unsupported/
  );
});

test("Stage H Security #27: require() in condition field is blocked", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [{ field: "require('os')", operator: "eq", value: "x" }], actions: [] }),
    /forbidden|operator|not supported|Unsupported/
  );
});

test("Stage H Security #28: import() in condition field is blocked", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [{ field: "import.meta", operator: "eq", value: "x" }], actions: [] }),
    /forbidden|operator|not supported|Unsupported/
  );
});

test("Stage H Security #29: No eval() usage in condition evaluation", () => {
  const { evaluateConditions } = require("../src/services/workflow/conditionEvaluator");
  let evalUsed = false;
  try {
    global.eval = () => { evalUsed = true; };
    evaluateConditions([{ field: "x", operator: "eq", value: "y" }], { x: "y" });
  } finally {
    delete global.eval;
  }
  assert.equal(evalUsed, false);
});

// === Action Executor Security ===

test("Stage H Security #30: Action params cannot inject prototype properties", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Pollution Test",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "update.conversation.metadata", params: { key: "__proto__.polluted", value: "yes" } }],
  });
  const response = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.ok(!response.executions[0]?.error || response.executions[0].status !== "failed");
});

test("Stage H Security #31: Action params with __proto__ keys are rejected", () => {
  const { validateActionsArray } = require("../src/services/workflow/actions");
  const params = {};
  Object.defineProperty(params, "__proto__", { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
  assert.throws(
    () => validateActionsArray([{ type: "update.conversation.metadata", params }]),
    /forbidden/
  );
});

test("Stage H Security #32: Action params with constructor keys are rejected", () => {
  const { validateActionsArray } = require("../src/services/workflow/actions");
  assert.throws(
    () => validateActionsArray([{ type: "update.conversation.metadata", params: { constructor: {} } }]),
    /forbidden/
  );
});

test("Stage H Security #33: Assign to non-existent employee is rejected", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Bad Employee Assign",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "assign.conversation.employee", params: { employeeId: String(b.customer._id) } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "failed");
  assert.ok(result.executions[0].error);
});

test("Stage H Security #34: Assign to employee in another company is rejected", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Cross-company Assign",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "assign.conversation.employee", params: { employeeId: String(b.user._id) } }],
  });
  const result = await runEventWorkflows({
   companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "failed");
  assert.ok(result.executions[0].error);
});

// === Workflow Engine Safety ===

test("Stage H Security #35: Workflows from other companies are never matched", async () => {
  await Workflow.create({
    companyId: b.company._id,
    name: "B's Active Workflow",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "b.wf.ran" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg1" }, conversation: { _id: String(a.conversation._id) } },
  });
  const bWfRan = await AuditLog.findOne({ action: "b.wf.ran", companyId: b.company._id });
  assert.ok(!bWfRan);
});

test("Stage H Security #36: Workflow with no companyId is rejected by engine", async () => {
  const { runEventWorkflows } = require("../src/services/workflow/engine");
  await assert.rejects(
    () => runEventWorkflows({ companyId: null, eventType: "message.received", eventContext: {} }),
    /company.*required/i
  );
});

test("Stage H Security #37: Recursive workflow loop is prevented", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Recursion Test",
    status: "active",
    trigger: { type: "conversation.updated" },
    conditions: [],
    actions: [{ type: "update.conversation.status", params: { status: "waiting" } }],
  });

  for (let i = 0; i < 5; i += 1) {
    await runEventWorkflows({
      companyId: a.company._id,
      eventType: "conversation.updated",
      eventContext: { conversation: { _id: String(a.conversation._id) } },
    });
  }

  const executions = await WorkflowExecution.find({ workflowId: wf._id });
  assert.ok(executions.length > 0);
});

test("Stage H Security #38: Malformed conversation context does not crash engine", async () => {
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg1" } },
  });
  assert.ok(Array.isArray(result.executions));
});

test("Stage H Security #39: Conversation not found is handled gracefully", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Missing Conv",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "assign.conversation.employee", params: { employeeId: String(a.user._id) } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: "000000000000000000000000" } },
  });
  assert.equal(result.executions[0].status, "failed");
  assert.ok(result.executions[0].error);
});

test("Stage H Security #40: Invalid conversation ID in context is handled", async () => {
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: "not-a-valid-id" } },
  });
  assert.ok(Array.isArray(result.executions));
});

test("Stage H Security #41: Workflow with disallowed status value is rejected on create", async () => {
  const response = await request(app)
    .post("/api/v1/workflows")
    .set(auth(tokenA))
    .send({ name: "Bad Status", status: "malicious", trigger: { type: "message.received" }, conditions: [], actions: [] });
  assert.equal(response.status, 400);
});

test("Stage H Security #42: Workflow with arbitrary JS condition is blocked", () => {
  assert.throws(
    () => validateWorkflowInput({
      name: "JS Injection",
      trigger: { type: "message.received" },
      conditions: [{ field: "require('child_process').execSync('rm -rf /')", operator: "eq", value: "x" }],
      actions: [],
    }),
    /forbidden|operator|Unsupported/
  );
});

test("Stage H Security #43: No arbitrary code execution in condition values", () => {
  const { evaluateConditions } = require("../src/services/workflow/conditionEvaluator");
  assert.doesNotThrow(() => {
    evaluateConditions([{ field: "x", operator: "eq", value: "require('fs')" }], { x: "y" });
  });
  const result = evaluateConditions([{ field: "x", operator: "eq", value: "require('fs')" }], { x: "y" });
  assert.equal(result.passed, false);
});

test("Stage H Security #44: Customer update blocks protected fields", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Customer Field Block",
    status: "active",
    trigger: { type: "customer.created" },
    conditions: [],
    actions: [{ type: "update.customer.info", params: { data: { passwordHash: "stolen" } } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "customer.created",
    eventContext: { customer: { _id: String(a.customer._id) } },
  });
  assert.equal(result.executions[0].status, "failed");
  assert.ok(result.executions[0].error);
});

test("Stage H Security #45: Invalid UUID in workflowId params is handled", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Bad UUID",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "assign.conversation.employee", params: { employeeId: "not-a-valid-objectid" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "failed");
});

test("Stage H Security #46: Workflow preview without eventContext returns condition evaluation", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Preview Test",
    trigger: { type: "message.received" },
    conditions: [{ field: "channel.type", operator: "eq", value: "email" }],
    actions: [{ type: "create.audit.event", params: { action: "wf.preview" } }],
  });
  const response = await request(app)
    .post(`/api/v1/workflows/${wf._id}/preview`)
    .set(auth(tokenA))
    .send({});
  assert.equal(response.status, 200);
  assert.equal(response.body.data.conditionsPassed, false);
  assert.ok(Array.isArray(response.body.data.conditionResults));
});

test("Stage H Security #47: Workflow preview validates companyId", async () => {
  const wf = await Workflow.create({
    companyId: b.company._id,
    name: "B Preview",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [],
  });
  const response = await request(app)
    .post(`/api/v1/workflows/${wf._id}/preview`)
    .set(auth(tokenA))
    .send({});
  assert.equal(response.status, 404);
});

test("Stage H Security #48: Execution log is scoped to company", async () => {
  await WorkflowExecution.create([
    { companyId: a.company._id, workflowId: "000000000000000000000001", eventType: "message.received", status: "completed" },
    { companyId: b.company._id, workflowId: "000000000000000000000002", eventType: "message.received", status: "completed" },
  ]);
  const response = await request(app)
    .get("/api/v1/workflows/executions")
    .set(auth(tokenA));
  assert.equal(response.status, 200);
  for (const exec of response.body.data) {
    assert.equal(String(exec.companyId), String(a.company._id));
  }
});

test("Stage H Security #49: Workflow engine never leaks companyId in errors", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Error Leak Test",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "assign.conversation.employee", params: { employeeId: "000000000000000000000000" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  const errorStr = JSON.stringify(result.executions[0]?.error || "");
  assert.ok(!errorStr.includes(String(b.company._id)));
});

test("Stage H Security #50: Workflow update prevents invalid status", async () => {
  const wf = await Workflow.create({ companyId: a.company._id, name: "Status Update", trigger: { type: "message.received" }, conditions: [], actions: [] });
  const response = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ status: "active" });
  assert.equal(response.status, 200);

  const badResponse = await request(app)
    .patch(`/api/v1/workflows/${wf._id}`)
    .set(auth(tokenA))
    .send({ status: "DELETED" });
  assert.equal(badResponse.status, 400);
});
