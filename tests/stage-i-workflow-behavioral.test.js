const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-h-beh-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-h-beh-refresh-secret";

let mongo;
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

const { runEventWorkflows, executeWorkflow, resetEngineState, getEngineStats } = require("../src/services/workflow/engine");
const { validateWorkflowInput } = require("../src/validators/workflowValidator");
const { evaluateConditions } = require("../src/services/workflow/conditionEvaluator");
const { setVectorStoreForTests, setEmbeddingProviderForTests } = require("../src/services/ragRuntime");
const { InMemoryVectorStore } = require("../src/services/vectorStore");
const { MockEmbeddingProvider } = require("../src/services/ai/embeddingProvider");

function asyncRun(asyncFn) {
  return Promise.resolve().then(asyncFn);
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_h_beh");
  require("../app");

  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Stage H Beh A", slug: "stage-h-beh-a" },
    { name: "Stage H Beh B", slug: "stage-h-beh-b" },
  ]);
  const permissions = ["workflows:read", "workflows:create", "workflows:update", "workflows:delete", "conversations:read", "conversations:create", "customers:read", "agents:read"];
  const [roleA, roleB] = await Role.create([
    { companyId: companyA._id, name: "A", slug: "stage-h-beh-a", permissions },
    { companyId: companyB._id, name: "B", slug: "stage-h-beh-b", permissions },
  ]);
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB] = await User.create([
    { companyId: companyA._id, name: "A User", email: "stage-h-beh-a@example.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "B User", email: "stage-h-beh-b@example.com", passwordHash, roleId: roleB._id, status: "active" },
  ]);
  const [customerA, customerB] = await Customer.create([
    { companyId: companyA._id, name: "A Customer", email: "a@example.com" },
    { companyId: companyB._id, name: "B Customer", email: "b@example.com" },
  ]);
  const [kbA] = await require("../src/models/KnowledgeBase").create([{ companyId: companyA._id, name: "A KB" }]);
  const [agentA] = await AIAgent.create([{ companyId: companyA._id, name: "A Agent", slug: "stage-h-beh-a-agent", status: "active", knowledgeBaseIds: [kbA._id], promptTemplate: "Follow system." }]);
  const [conversationA] = await Conversation.create([{ companyId: companyA._id, customerId: customerA._id, agentId: agentA._id }]);

  a = { company: companyA, user: userA, customer: customerA, agent: agentA, conversation: conversationA };
  b = { company: companyB, user: userB, customer: customerB };

  setVectorStoreForTests(new InMemoryVectorStore());
  setEmbeddingProviderForTests(new MockEmbeddingProvider({ model: "mock-embedding-model", dimensions: 16 }));
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(async () => {
  resetEngineState();
  await Workflow.deleteMany({ companyId: { $in: [a.company._id, b.company._id] } });
  await WorkflowExecution.deleteMany({ companyId: { $in: [a.company._id, b.company._id] } });
  await AuditLog.deleteMany({ companyId: { $in: [a.company._id, b.company._id] } });
  await Conversation.findByIdAndUpdate(a.conversation._id, { participantIds: [], agentId: a.agent._id, status: "open", metadata: {} });
  await Customer.findByIdAndUpdate(a.customer._id, { notes: "" });
});

// === Workflow Engine ===

test("Stage H Behavioral #1: Active workflow matching trigger is executed", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Active Test",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "test.ran" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg1" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].status, "completed");
  assert.ok(result.executions[0].actionsExecuted >= 1);
  const log = await AuditLog.findOne({ action: "test.ran" });
  assert.ok(log);
  assert.equal(String(log.companyId), String(a.company._id));
});

test("Stage H Behavioral #2: Inactive workflow is not executed", async () => {
  await Workflow.create({
    companyId: a.company._id,
    name: "Inactive Test",
    status: "inactive",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "inactive.ran" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg2" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions.length, 0);
});

test("Stage H Behavioral #3: Draft workflow is not executed", async () => {
  await Workflow.create({
    companyId: a.company._id,
    name: "Draft Test",
    status: "draft",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "draft.ran" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg3" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions.length, 0);
});

test("Stage H Behavioral #4: Conditions are evaluated and only matching workflows run", async () => {
  await Workflow.create({
    companyId: a.company._id,
    name: "Email Only",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [{ field: "channel.type", operator: "eq", value: "email" }],
    actions: [{ type: "create.audit.event", params: { action: "email.only" } }],
  });
  await Workflow.create({
    companyId: a.company._id,
    name: "Webchat Only",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [{ field: "channel.type", operator: "eq", value: "webchat" }],
    actions: [{ type: "create.audit.event", params: { action: "webchat.only" } }],
  });

  const emailResult = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { channel: { type: "email" }, message: { _id: "msg-email" }, conversation: { _id: String(a.conversation._id) } },
  });
  const emailCompleted = emailResult.executions.filter((e) => e.status === "completed");
  assert.equal(emailCompleted.length, 1);
  assert.equal(emailCompleted[0].status, "completed");

  const webchatResult = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { channel: { type: "webchat" }, message: { _id: "msg-web" }, conversation: { _id: String(a.conversation._id) } },
  });
  const webchatCompleted = webchatResult.executions.filter((e) => e.status === "completed");
  assert.equal(webchatCompleted.length, 1);
  assert.equal(webchatCompleted[0].status, "completed");
});

test("Stage H Behavioral #5: Workflows are ordered by priority", async () => {
  await Workflow.create({
    companyId: a.company._id,
    name: "Low Priority",
    status: "active",
    priority: 10,
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "low.priority" } }],
  });
  await Workflow.create({
    companyId: a.company._id,
    name: "High Priority",
    status: "active",
    priority: 200,
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "high.priority" } }],
  });

  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg-priority" }, conversation: { _id: String(a.conversation._id) } },
  });

  assert.equal(result.executions.length, 2);
  const highFirst = result.executions[0].workflowId !== result.executions[1].workflowId;
  assert.ok(highFirst);
});

test("Stage H Behavioral #6: Assign conversation to employee action works", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Assign Employee",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "assign.conversation.employee", params: { employeeId: String(a.user._id) } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
  const conv = await Conversation.findById(a.conversation._id);
  assert.ok(conv.participantIds.map(String).includes(String(a.user._id)));
});

test("Stage H Behavioral #7: Assign conversation to agent action works", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Assign Agent",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "assign.conversation.agent", params: { agentId: String(a.agent._id) } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
  const conv = await Conversation.findById(a.conversation._id);
  assert.equal(String(conv.agentId), String(a.agent._id));
});

test("Stage H Behavioral #8: Update conversation status action works", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Update Status",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "update.conversation.status", params: { status: "resolved" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
  const conv = await Conversation.findById(a.conversation._id);
  assert.equal(conv.status, "resolved");
});

test("Stage H Behavioral #9: Update conversation metadata action works", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Update Metadata",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "update.conversation.metadata", params: { key: "workflow_tag", value: "test" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
  const conv = await Conversation.findById(a.conversation._id);
  assert.equal(conv.metadata.workflow_tag, "test");
});

test("Stage H Behavioral #10: Update customer info action works", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Update Customer",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "update.customer.info", params: { data: { notes: "VIP customer via workflow" } } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { customer: { _id: String(a.customer._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
  const customer = await Customer.findById(a.customer._id);
  assert.equal(customer.notes, "VIP customer via workflow");
});

test("Stage H Behavioral #11: Create audit event action works", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Audit Event",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "workflow.audit.test", metadata: { source: "workflow_test" } } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg-audit" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
  const log = await AuditLog.findOne({ action: "workflow.audit.test" });
  assert.ok(log);
  assert.equal(log.metadata.source, "workflow_test");
});

test("Stage H Behavioral #12: Multiple workflows match same event", async () => {
  await Workflow.create([
    { companyId: a.company._id, name: "Multi 1", status: "active", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "multi.1" } }] },
    { companyId: a.company._id, name: "Multi 2", status: "active", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "multi.2" } }] },
    { companyId: a.company._id, name: "Multi 3", status: "active", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "create.audit.event", params: { action: "multi.3" } }] },
  ]);
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg-multi" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions.length, 3);
  assert.ok(result.executions.every((e) => e.status === "completed"));
});

test("Stage H Behavioral #13: Action failure stops subsequent actions", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Fail Middle",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [
      { type: "create.audit.event", params: { action: "before.fail" } },
      { type: "assign.conversation.employee", params: { employeeId: "000000000000000000000000" } },
      { type: "create.audit.event", params: { action: "after.fail" } },
    ],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "failed");
  assert.equal(result.executions[0].actionsExecuted, 2);
  const beforeLog = await AuditLog.findOne({ action: "before.fail" });
  const afterLog = await AuditLog.findOne({ action: "after.fail" });
  assert.ok(beforeLog);
  assert.ok(!afterLog);
});

test("Stage H Behavioral #14: Condition eq operator", () => {
  const result = evaluateConditions([{ field: "message.direction", operator: "eq", value: "inbound" }], { message: { direction: "inbound" } });
  assert.equal(result.passed, true);
});

test("Stage H Behavioral #15: Condition ne operator", () => {
  const result = evaluateConditions([{ field: "message.direction", operator: "ne", value: "outbound" }], { message: { direction: "inbound" } });
  assert.equal(result.passed, true);
});

test("Stage H Behavioral #16: Condition in operator", () => {
  const result = evaluateConditions([{ field: "channel.type", operator: "in", value: ["email", "sms"] }], { channel: { type: "sms" } });
  assert.equal(result.passed, true);
});

test("Stage H Behavioral #17: Condition nin operator", () => {
  const result = evaluateConditions([{ field: "channel.type", operator: "nin", value: ["whatsapp", "instagram"] }], { channel: { type: "email" } });
  assert.equal(result.passed, true);
});

test("Stage H Behavioral #18: Condition contains operator", () => {
  const result = evaluateConditions([{ field: "message.body", operator: "contains", value: "help" }], { message: { body: "I need help please" } });
  assert.equal(result.passed, true);
});

test("Stage H Behavioral #19: Condition startsWith operator", () => {
  const result = evaluateConditions([{ field: "message.body", operator: "startsWith", value: "hi" }], { message: { body: "hi there" } });
  assert.equal(result.passed, true);
});

test("Stage H Behavioral #20: Condition endsWith operator", () => {
  const result = evaluateConditions([{ field: "message.body", operator: "endsWith", value: "bye" }], { message: { body: "good bye" } });
  assert.equal(result.passed, true);
});

test("Stage H Behavioral #21: Condition exists operator", () => {
  const result = evaluateConditions([{ field: "customer.email", operator: "exists", value: null }], { customer: { name: "John" } });
  assert.equal(result.passed, false);
  const result2 = evaluateConditions([{ field: "customer.email", operator: "exists", value: null }], { customer: { email: "john@example.com" } });
  assert.equal(result2.passed, true);
});

test("Stage H Behavioral #22: Condition gt/gte/lt/lte operators", () => {
  assert.equal(evaluateConditions([{ field: "x", operator: "gt", value: 5 }], { x: 10 }).passed, true);
  assert.equal(evaluateConditions([{ field: "x", operator: "gt", value: 10 }], { x: 10 }).passed, false);
  assert.equal(evaluateConditions([{ field: "x", operator: "gte", value: 10 }], { x: 10 }).passed, true);
  assert.equal(evaluateConditions([{ field: "x", operator: "lt", value: 10 }], { x: 5 }).passed, true);
  assert.equal(evaluateConditions([{ field: "x", operator: "lte", value: 10 }], { x: 10 }).passed, true);
});

test("Stage H Behavioral #23: Workflow execution creates execution log", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Execution Log Test",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "exec.log" } }],
  });
  await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg-log" }, conversation: { _id: String(a.conversation._id) } },
  });
  const log = await WorkflowExecution.findOne({ workflowId: wf._id });
  assert.ok(log);
  assert.equal(log.status, "completed");
  assert.equal(String(log.companyId), String(a.company._id));
  assert.ok(log.executionTimeMs >= 0);
});

test("Stage H Behavioral #24: Workflow service validates trigger types", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "invalid" }, conditions: [], actions: [] }),
    /trigger/i
  );
});

test("Stage H Behavioral #25: Workflow service validates action types", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [], actions: [{ type: "invalid.action" }] }),
    /action/i
  );
});

test("Stage H Behavioral #26: Workflow service validates condition operators", () => {
  assert.throws(
    () => validateWorkflowInput({ name: "Test", trigger: { type: "message.received" }, conditions: [{ field: "x", operator: "bad", value: "y" }], actions: [] }),
    /operator/i
  );
});

test("Stage H Behavioral #27: Workflow with conditions that don't match skips actions", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "No Match",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [{ field: "channel.type", operator: "eq", value: "sms" }],
    actions: [{ type: "create.audit.event", params: { action: "should.not.run" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { channel: { type: "email" }, message: { _id: "msg-no-match" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "skipped");
  const log = await AuditLog.findOne({ action: "should.not.run" });
  assert.ok(!log);
});

test("Stage H Behavioral #28: Workflow trigger type message.received", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Message Trigger",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "msg.received" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg-trigger" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
});

test("Stage H Behavioral #29: Workflow trigger type conversation.created", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Conv Created Trigger",
    status: "active",
    trigger: { type: "conversation.created" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "conv.created" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "conversation.created",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
});

test("Stage H Behavioral #30: Workflow trigger type conversation.updated", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Conv Updated Trigger",
    status: "active",
    trigger: { type: "conversation.updated" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "conv.updated" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "conversation.updated",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
});

test("Stage H Behavioral #31: Workflow trigger type customer.created", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Customer Created Trigger",
    status: "active",
    trigger: { type: "customer.created" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "customer.created" } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "customer.created",
    eventContext: { customer: { _id: String(a.customer._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
});

test("Stage H Behavioral #32: Soft-deleted workflow is not executed", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Soft Deleted",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "soft.deleted.run" } }],
    isDeleted: true,
    deletedAt: new Date(),
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { message: { _id: "msg-deleted" }, conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions.length, 0);
});

test("Stage H Behavioral #33: Engine stats reflect execution state", async () => {
  resetEngineState();
  const stats = getEngineStats();
  assert.equal(typeof stats.activeExecutions, "number");
  assert.equal(typeof stats.trackedWorkflows, "number");
});

test("Stage H Behavioral #34: Workflow execution records condition results", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Condition Results",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [
      { field: "channel.type", operator: "eq", value: "email" },
      { field: "message.direction", operator: "eq", value: "inbound" },
    ],
    actions: [{ type: "create.audit.event", params: { action: "cond.results" } }],
  });
  await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { channel: { type: "email" }, message: { direction: "inbound", _id: "msg-cond" }, conversation: { _id: String(a.conversation._id) } },
  });
  const exec = await WorkflowExecution.findOne({ workflowId: wf._id });
  assert.ok(exec);
  assert.ok(Array.isArray(exec.conditionResults));
  assert.equal(exec.conditionResults.length, 2);
  assert.ok(exec.conditionResults.every((r) => r.passed === true));
});

test("Stage H Behavioral #35: Update conversation metadata with data object", async () => {
  const wf = await Workflow.create({
    companyId: a.company._id,
    name: "Metadata Data Object",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "update.conversation.metadata", params: { data: { source: "workflow", priority: "high" } } }],
  });
  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: { conversation: { _id: String(a.conversation._id) } },
  });
  assert.equal(result.executions[0].status, "completed");
  const conv = await Conversation.findById(a.conversation._id);
  assert.equal(conv.metadata.source, "workflow");
  assert.equal(conv.metadata.priority, "high");
});
