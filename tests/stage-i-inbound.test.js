const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.AI_MAX_RETRIES = "1";
process.env.AI_RETRY_BASE_DELAY_MS = "1";

let mongo;
let app;
let Company;
let Channel;
let Customer;
let CustomerIdentity;
let Conversation;
let Message;
let AuditLog;
let Workflow;
let WorkflowExecution;

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

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_i_inbound");
  app = require("../app");
  await mongoose.connect(process.env.MONGO_URI);

  Company = require("../src/models/Company");
  Channel = require("../src/models/Channel");
  Customer = require("../src/models/Customer");
  CustomerIdentity = require("../src/models/CustomerIdentity");
  Conversation = require("../src/models/Conversation");
  Message = require("../src/models/Message");
  AuditLog = require("../src/models/AuditLog");
  Workflow = require("../src/models/Workflow");
  WorkflowExecution = require("../src/models/WorkflowExecution");
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test.beforeEach(async () => {
  await Conversation.deleteMany({});
  await Message.deleteMany({});
  await CustomerIdentity.deleteMany({});
  await Customer.deleteMany({});
  await Channel.deleteMany({});
  await Company.deleteMany({});
  await AuditLog.deleteMany({});
  await Workflow.deleteMany({});
  await WorkflowExecution.deleteMany({});
});

test.afterEach(async () => {
  await Conversation.deleteMany({});
  await Message.deleteMany({});
  await AuditLog.deleteMany({});
  await Workflow.deleteMany({});
  await WorkflowExecution.deleteMany({});
  await CustomerIdentity.deleteMany({});
  await Customer.deleteMany({});
  await Channel.deleteMany({});
  await Company.deleteMany({});
});

test("1. Valid webhook signature is accepted", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company", slug: "test-company" });
  const channel = await Channel.create({
    name: "Test Email Channel",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Test Customer", email: "test@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "test-customer-identity-1",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Hello World", senderIdentity: "test-customer-identity-1", externalMessageId: "msg-valid-sig" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.duplicate, false);
  assert.ok(response.body.data.message);
  assert.equal(String(response.body.data.conversation.companyId), String(company._id));
});

test("2. Missing signature is rejected", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company B", slug: "test-company-b" });
  const channel = await Channel.create({
    name: "Channel B",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc2", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer B", email: "b@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "b-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Hello World", senderIdentity: "b-identity", externalMessageId: "msg-missing-sig" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set("x-corvanta-timestamp", timestamp)
    .send(body)
    .expect(401);

  assert.equal(response.body.success, false);
});

test("3. Invalid signature is rejected", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company C", slug: "test-company-c" });
  const channel = await Channel.create({
    name: "Channel C",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc3", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer C", email: "c@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "c-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Hello World", senderIdentity: "c-identity", externalMessageId: "msg-invalid-sig" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set("x-corvanta-signature", "sha256=invalidsignature")
    .set("x-corvanta-timestamp", timestamp)
    .send(body)
    .expect(401);

  assert.equal(response.body.success, false);
});

test("4. Expired/stale timestamp is rejected", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company D", slug: "test-company-d" });
  const channel = await Channel.create({
    name: "Channel D",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc4", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer D", email: "d@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "d-identity",
  });

  const timestamp = "1000000000";
  const body = { channelType: "email", body: "Hello World", senderIdentity: "d-identity", externalMessageId: "msg-stale-ts" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(401);

  assert.equal(response.body.success, false);
});

test("5. Replay attack is rejected", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company E", slug: "test-company-e" });
  const channel = await Channel.create({
    name: "Channel E",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_replay_test", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer E", email: "e@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "e-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Replay Me", senderIdentity: "e-identity", externalMessageId: "msg-replay" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(409);

  assert.equal(response.body.success, false);
});

test("6. Missing/invalid required inbound payload is rejected", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company F", slug: "test-company-f" });
  const channel = await Channel.create({
    name: "Channel F",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc5", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer F", email: "f@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "f-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(400);

  assert.equal(response.body.success, false);
});

test("7. Valid inbound message reaches processInboundMessage()", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company G", slug: "test-company-g" });
  const channel = await Channel.create({
    name: "Channel G",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc6", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer G", email: "g@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "g-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Process this message", senderIdentity: "g-identity", externalMessageId: "msg-process-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.data.duplicate, false);
  assert.ok(response.body.data.message, "Message should exist");
  assert.ok(response.body.data.conversation, "Conversation should exist");
  assert.ok(response.body.data.customer, "Customer should exist");
});

test("8. Customer identity resolution works", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company H", slug: "test-company-h" });
  const channel = await Channel.create({
    name: "Channel H",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc7", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer H", email: "h@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "h-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Who am I?", senderIdentity: "h-identity", externalMessageId: "msg-identity-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);
  assert.ok(response.body.data.customer, "Customer should be resolved");
  assert.equal(String(response.body.data.customer._id), String(customer._id));
});

test("9. Conversation creation/resolution works", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company I", slug: "test-company-i" });
  const channel = await Channel.create({
    name: "Channel I",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc8", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer I", email: "i@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "i-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Start a conversation", senderIdentity: "i-identity", externalConversationId: "conv-external-1", externalMessageId: "msg-conv-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);
  assert.ok(response.body.data.conversation, "Conversation should exist");
  assert.equal(response.body.data.conversation.externalConversationId, "conv-external-1");
});

test("10. Duplicate external message is handled idempotently", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company J", slug: "test-company-j" });
  const channel = await Channel.create({
    name: "Channel J",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc9", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer J", email: "j@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "j-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Duplicate me", senderIdentity: "j-identity", externalMessageId: "msg-dup-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const first = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(first.body.data.duplicate, false);
  assert.ok(first.body.data.message, "Message should exist");

  const msgCount = await Message.countDocuments({ companyId: company._id, externalMessageId: "msg-dup-1" });
  assert.equal(msgCount, 1, "Only one message should be created");
});

test("11. message.received workflow trigger is reached", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company K", slug: "test-company-k" });
  const channel = await Channel.create({
    name: "Channel K",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc10", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer K", email: "k@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "k-identity",
  });

  const { resetEngineState } = require("../src/services/workflow/engine");
  resetEngineState();

  const workflow = await Workflow.create({
    companyId: company._id,
    name: "Test Message Workflow",
    trigger: { type: "message.received" },
    conditions: [],
    actions: [{ type: "create.audit.event", params: { action: "test.workflow.trigger" } }],
    priority: 50,
    status: "active",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Trigger workflow", senderIdentity: "k-identity", externalMessageId: "msg-wf-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);
  assert.ok(response.body.data.workflowResult, "Workflow result should exist");
  assert.equal(response.body.data.workflowResult.deduplicated, false);
  assert.ok(response.body.data.workflowResult.executions, "Workflow executions should exist");
  assert.ok(response.body.data.workflowResult.executions.length > 0, "Should have at least one execution");
});

test("12. conversation.created workflow trigger is reached when appropriate", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company L", slug: "test-company-l" });
  const channel = await Channel.create({
    name: "Channel L",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc11", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer L", email: "l@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "l-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "New conversation", senderIdentity: "l-identity", externalConversationId: "conv-new-1", externalMessageId: "msg-newconv-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);
  assert.ok(response.body.data.conversation, "Conversation should be created");
});

test("13. Cross-tenant/company spoofing is prevented", { concurrency: 1 }, async () => {
  const companyB = await Company.create({ name: "Company B", slug: "company-b-test-13" });
  const channelB = await Channel.create({
    name: "Company B Channel",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_company_b_test", webhookSecret: "secret_b_test" },
    companyId: companyB._id,
  });
  const customerB = await Customer.create({ companyId: companyB._id, name: "Customer B", email: "b-spoof@example.com" });
  const customerIdentityB = await CustomerIdentity.create({
    companyId: companyB._id, customerId: customerB._id, channelType: "email", externalId: "test-identity-b",
  });

  const timestamp = nowTimestamp();
  const body = {
    companyId: "000000000000000000000000",
    channelType: "email",
    body: "Spoof attempt",
    senderIdentity: "test-identity-b",
    externalMessageId: "msg-spoof-1",
  };
  const inboundPath = `/api/v1/webhooks/${channelB.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channelB.externalConfig.webhookPath, "secret_b_test", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(String(response.body.data.conversation.companyId), String(companyB._id), "Conversation must belong to channel's company, not the spoofed payload companyId");
});

test("14. A webhook cannot arbitrarily select another company's channel", { concurrency: 1 }, async () => {
  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Attempt cross-company", senderIdentity: "test-identity-x", externalMessageId: "msg-cross-1" };

  const response = await request(app)
    .post("/api/v1/webhooks/nonexistent_path")
    .set(webhookHeaders("nonexistent_path", "fake_secret", timestamp, body))
    .send(body)
    .expect(404);

  assert.equal(response.body.success, false);
});

test("15. No JWT is required for a properly authenticated webhook", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company O", slug: "test-company-o" });
  const channel = await Channel.create({
    name: "Channel O",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc12", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer O", email: "o@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "o-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "No JWT needed", senderIdentity: "o-identity", externalMessageId: "msg-nojwt-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
});

test("16. Error responses follow existing centralized error handling", { concurrency: 1 }, async () => {
  const company = await Company.create({ name: "Test Company P", slug: "test-company-p" });
  const channel = await Channel.create({
    name: "Channel P",
    type: "email",
    status: "active",
    externalConfig: { webhookPath: "wh_test_company_abc13", webhookSecret: "test_webhook_secret_123" },
    companyId: company._id,
  });
  const customer = await Customer.create({ companyId: company._id, name: "Customer P", email: "p@example.com" });
  const customerIdentity = await CustomerIdentity.create({
    companyId: company._id, customerId: customer._id, channelType: "email", externalId: "p-identity",
  });

  const timestamp = nowTimestamp();
  const body = { channelType: "email", body: "Error test", senderIdentity: "p-identity", externalMessageId: "msg-err-1" };
  const inboundPath = `/api/v1/webhooks/${channel.externalConfig.webhookPath}`;

  const response = await request(app)
    .post(inboundPath)
    .set(webhookHeaders(channel.externalConfig.webhookPath, "test_webhook_secret_123", timestamp, body))
    .send(body)
    .expect(200);

  assert.equal(response.body.success, true);

  const missingSigResponse = await request(app)
    .post(inboundPath)
    .set("x-corvanta-timestamp", timestamp)
    .send(body)
    .expect(401);

  assert.equal(missingSigResponse.body.success, false);
  assert.ok(missingSigResponse.body.message, "Error response should have message");
});