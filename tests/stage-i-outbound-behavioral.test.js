const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-i-outbound-beh-access";
process.env.JWT_REFRESH_SECRET = "stage-i-outbound-beh-refresh";

let mongo;
let app;
let tokenA;
let a;

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

const { runEventWorkflows, resetEngineState } = require("../src/services/workflow/engine");
const { setVectorStoreForTests, setEmbeddingProviderForTests } = require("../src/services/ragRuntime");
const { InMemoryVectorStore } = require("../src/services/vectorStore");
const { MockEmbeddingProvider } = require("../src/services/ai/embeddingProvider");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_outbound_beh");
  app = require("../app");

  await mongoose.connect(process.env.MONGO_URI);

  const [companyA] = await Company.create([
    { name: "Outbound Beh A", slug: "outbound-beh-a" },
  ]);

  const permissions = [
    "channels:read", "channels:create", "channels:update", "channels:delete",
    "conversations:read", "conversations:create", "conversations:update", "conversations:delete",
    "conversations:messages:read", "conversations:send", "messages:send",
    "customers:read", "customers:create", "customers:update", "customers:delete",
    "workflows:read", "workflows:create", "workflows:update", "workflows:delete",
  ];

  const [roleA] = await Role.create([
    { companyId: companyA._id, name: "A Role", slug: "outbound-beh-a", permissions },
  ]);

  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA] = await User.create([
    { companyId: companyA._id, name: "User A", email: "outbound-beh-a@test.com", passwordHash, roleId: roleA._id, status: "active" },
  ]);

  const [customerA] = await Customer.create([{ companyId: companyA._id, name: "A Customer" }]);
  const [agentA] = await require("../src/models/AIAgent").create([{ companyId: companyA._id, name: "A Agent", slug: "outbound-beh-a-agent", status: "active", promptTemplate: "Follow system." }]);
  const [conversationA] = await Conversation.create([{ companyId: companyA._id, customerId: customerA._id, agentId: agentA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: companyA._id, name: "A Channel", type: "webchat", status: "active" }]);

  a = { company: companyA, user: userA, customer: customerA, agent: agentA, conversation: conversationA, channel: channelA };

  tokenA = (await request(app).post("/api/v1/auth/login").send({ email: userA.email, password: "Password123!" })).body.data.accessToken;

  setVectorStoreForTests(new InMemoryVectorStore());
  setEmbeddingProviderForTests(new MockEmbeddingProvider({ model: "mock-embedding-model", dimensions: 16 }));
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(async () => {
  resetEngineState();
  await Channel.deleteMany({});
  await Customer.deleteMany({});
  await Conversation.deleteMany({});
  await Message.deleteMany({});
  await Workflow.deleteMany({});
  await WorkflowExecution.deleteMany({});
  await AuditLog.deleteMany({});
  await require("../src/models/AIAgent").deleteMany({});
});

test("Outbound Behavioral #1: HTTP outbound creates message with sent delivery state", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "hello world" })
    .expect(201);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.message.body, "hello world");
  assert.equal(response.body.data.message.direction, "outbound");
  assert.equal(response.body.data.message.deliveryStatus, "sent");
  assert.equal(response.body.data.message.channelType, "webchat");
  assert.equal(String(response.body.data.message.companyId), String(a.company._id));
  assert.equal(String(response.body.data.message.conversationId), String(conversationA._id));
  assert.ok(response.body.data.message.externalMessageId);
  assert.ok(response.body.data.message.deliveredAt);

  const dbMessage = await Message.findById(response.body.data.message._id);
  assert.ok(dbMessage);
  assert.equal(dbMessage.deliveryStatus, "sent");
});

test("Outbound Behavioral #2: HTTP outbound updates conversation lastMessageAt", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const beforeUpdate = await Conversation.findById(conversationA._id);
  assert.ok(beforeUpdate.lastMessageAt === null || beforeUpdate.lastMessageAt < new Date());

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "update check" })
    .expect(201);

  const afterUpdate = await Conversation.findById(conversationA._id);
  assert.ok(afterUpdate.lastMessageAt);
  assert.ok(afterUpdate.lastMessageAt.getTime() >= new Date(response.body.data.message.createdAt).getTime());
});

test("Outbound Behavioral #3: HTTP outbound creates audit log", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "audit test" })
    .expect(201);

  const log = await AuditLog.findOne({ action: "channel.outbound.api.sent" });
  assert.ok(log);
  assert.equal(String(log.companyId), String(a.company._id));
  assert.equal(log.entityType, "Message");
});

test("Outbound Behavioral #4: Workflow send.message action sends outbound message", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const workflow = await Workflow.create({
    companyId: a.company._id,
    name: "Send Message Workflow",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [
      {
        type: "send.message",
        params: {
          conversationId: String(conversationA._id),
          body: "Workflow reply",
          channelType: "webchat",
        },
      },
    ],
  });

  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: {
      message: { _id: "trigger-msg" },
      conversation: { _id: String(conversationA._id) },
    },
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].status, "completed");

  const message = await Message.findOne({ companyId: a.company._id, body: "Workflow reply", direction: "outbound" });
  assert.ok(message);
  assert.equal(message.deliveryStatus, "sent");
  assert.equal(message.channelType, "webchat");
});

test("Outbound Behavioral #5: Workflow send.message action handles adapter failure", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const workflow = await Workflow.create({
    companyId: a.company._id,
    name: "Send Message Failure Workflow",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [
      {
        type: "send.message",
        params: {
          conversationId: String(conversationA._id),
          body: "Failure reply",
          channelType: "webchat",
          simulateFailure: true,
        },
      },
    ],
  });

  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: {
      message: { _id: "trigger-msg-fail" },
      conversation: { _id: String(conversationA._id) },
    },
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].status, "completed");

  const message = await Message.findOne({ companyId: a.company._id, body: "Failure reply", direction: "outbound" });
  assert.ok(message);
  assert.equal(message.deliveryStatus, "failed");
  assert.ok(message.deliveryError);
});

test("Outbound Behavioral #6: Workflow send.message preserves Stage H behavior", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  await Workflow.create({
    companyId: a.company._id,
    name: "Bad Action Workflow",
    status: "active",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [
      {
        type: "send.message",
        params: { body: "" },
      },
    ],
  });

  const result = await runEventWorkflows({
    companyId: a.company._id,
    eventType: "message.received",
    eventContext: {
      message: { _id: "trigger-msg-bad" },
      conversation: { _id: String(conversationA._id) },
    },
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].status, "failed");
  assert.ok(result.executions[0].error);
});

test("Outbound Behavioral #7: Outbound message record contains adapter result in metadata", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "meta test", metadata: { source: "behavioral-test" } })
    .expect(201);

  assert.equal(response.body.data.message.metadata.source, "behavioral-test");
  assert.ok(response.body.data.adapterResult);
  assert.equal(response.body.data.adapterResult.channel.type, "webchat");
});

test("Outbound Behavioral #8: Outbound with customerId links to customer", async () => {
  const [customerA] = await Customer.create([{ companyId: a.company._id, name: "A Customer" }]);
  const [conversationA] = await Conversation.create([{ companyId: a.company._id, customerId: customerA._id, channelType: "webchat" }]);
  const [channelA] = await Channel.create([{ companyId: a.company._id, name: "A Channel", type: "webchat", status: "active" }]);

  const response = await request(app)
    .post("/api/v1/outbound/send")
    .set(auth(tokenA))
    .send({ conversationId: String(conversationA._id), channelType: "webchat", body: "customer link", customerId: String(customerA._id) })
    .expect(201);

  assert.equal(String(response.body.data.message.customerId), String(customerA._id));
});
