// Safe defaults so this file runs with or without a local .env (never overrides real values).
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/corvanta-test";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "test-access-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const src = path.join(__dirname, "..", "src");
const COMPANY = "64d3a8f2c54f4020a959c9aa";
const OTHER_COMPANY = "64d3a8f2c54f4020a959c9bb";
const CONVERSATION = "64d3a8f2c54f4020a959c9f1";
const AGENT = "64d3a8f2c54f4020a959c9d1";
const STAFF = "64d3a8f2c54f4020a959c9a1";
const COLLEAGUE = "64d3a8f2c54f4020a959c9a2";

function stub(rel, exports) {
  const resolved = require.resolve(path.join(src, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function query(result) {
  const q = {
    select: () => q,
    lean: () => q,
    then: (resolve, reject) => Promise.resolve(typeof result === "function" ? result() : result).then(resolve, reject),
  };
  return q;
}

const calls = { messageCreate: [], updateOne: [], workflow: 0 };
const state = { conversation: null, agent: null, user: null, lastAgentQuery: null, lastUserQuery: null };

stub("models/Conversation.js", {
  findOne: async () => state.conversation,
  updateOne: async (...args) => {
    calls.updateOne.push(args);
    return { modifiedCount: 1 };
  },
});
stub("models/Message.js", {
  create: async (doc) => {
    calls.messageCreate.push(doc);
    return { _id: "64d3a8f2c54f4020a959c9m1".replace("m", "0"), createdAt: new Date("2025-01-01"), ...doc, toObject() { return { ...doc, _id: "msg-1" }; } };
  },
});
stub("models/Customer.js", { findOne: () => query(null) });
stub("models/AIAgent.js", {
  findOne: (q) => {
    state.lastAgentQuery = q;
    return query(() => state.agent);
  },
});
stub("models/User.js", {
  findOne: (q) => {
    state.lastUserQuery = q;
    return query(() => state.user);
  },
  countDocuments: async () => 0,
});
stub("services/workflow/engine.js", {
  runEventWorkflows: async () => {
    calls.workflow += 1;
  },
});

const { sendStaffReply, MAX_REPLY_CHARS } = require(path.join(src, "services", "conversationReplyService.js"));
const { updateConversation } = require(path.join(src, "services", "conversationService.js"));
const { validateConversationInput } = require(path.join(src, "validators", "domainValidator.js"));

function conversationDoc(over = {}) {
  return {
    _id: CONVERSATION,
    companyId: COMPANY,
    customerId: "64d3a8f2c54f4020a959c9e1",
    agentId: AGENT,
    status: "open",
    handlingMode: "HUMAN",
    saved: 0,
    async save() {
      this.saved += 1;
    },
    ...over,
  };
}
const staff = { _id: STAFF, companyId: COMPANY, name: "Sam" };

function reset() {
  calls.messageCreate.length = 0;
  calls.updateOne.length = 0;
  calls.workflow = 0;
  state.conversation = conversationDoc();
  state.agent = { _id: AGENT };
  state.user = { _id: COLLEAGUE };
}

test("a staff reply is only allowed once a person has taken over", async () => {
  reset();
  for (const mode of ["AI", "HYBRID"]) {
    state.conversation = conversationDoc({ handlingMode: mode });
    await assert.rejects(
      () => sendStaffReply(COMPANY, CONVERSATION, "Hello", staff),
      (e) => e.statusCode === 409 && /take over/i.test(e.message),
      mode
    );
  }
  assert.equal(calls.messageCreate.length, 0, "the AI is never talked over");
});

test("staff replies are validated and refused on archived conversations", async () => {
  reset();
  await assert.rejects(() => sendStaffReply(COMPANY, CONVERSATION, "   ", staff), (e) => e.statusCode === 400);
  await assert.rejects(() => sendStaffReply(COMPANY, CONVERSATION, 42, staff), (e) => e.statusCode === 400);
  await assert.rejects(
    () => sendStaffReply(COMPANY, CONVERSATION, "x".repeat(MAX_REPLY_CHARS + 1), staff),
    (e) => e.statusCode === 400
  );
  state.conversation = conversationDoc({ status: "archived" });
  await assert.rejects(() => sendStaffReply(COMPANY, CONVERSATION, "hi", staff), (e) => e.statusCode === 409);
  assert.equal(calls.messageCreate.length, 0);
});

test("a reply from a user of another company is refused", async () => {
  reset();
  await assert.rejects(
    () => sendStaffReply(COMPANY, CONVERSATION, "hi", { _id: STAFF, companyId: OTHER_COMPANY }),
    (e) => e.statusCode === 403
  );
  await assert.rejects(() => sendStaffReply(COMPANY, CONVERSATION, "hi", null), (e) => e.statusCode === 403);
  assert.equal(calls.messageCreate.length, 0);
});

test("a valid reply stores a team message, awaits the customer, and assigns the replier", async () => {
  reset();
  const result = await sendStaffReply(COMPANY, CONVERSATION, "  We are on it.  ", staff);

  assert.equal(calls.messageCreate.length, 1);
  const stored = calls.messageCreate[0];
  assert.equal(stored.companyId, COMPANY);
  assert.equal(stored.senderType, "user");
  assert.equal(stored.senderId, STAFF);
  assert.equal(stored.body, "We are on it.");
  assert.equal(state.conversation.saved, 1, "lastMessageAt is updated");

  assert.equal(calls.updateOne.length, 2);
  const [statusFilter, statusUpdate] = calls.updateOne[0];
  assert.deepEqual(statusFilter, { _id: CONVERSATION, companyId: COMPANY, status: "open" });
  assert.deepEqual(statusUpdate, { $set: { status: "waiting" } });
  const [assignFilter, assignUpdate] = calls.updateOne[1];
  assert.deepEqual(assignFilter, { _id: CONVERSATION, companyId: COMPANY, assigneeId: null });
  assert.deepEqual(assignUpdate, { $set: { assigneeId: STAFF } });

  assert.equal(result.senderType, "user");
  assert.equal(result.body, "We are on it.");
});

test("handing a conversation to the AI needs an active agent", async () => {
  reset();
  state.agent = null;
  await assert.rejects(
    () => updateConversation(COMPANY, CONVERSATION, { handlingMode: "AI" }),
    (e) => e.statusCode === 409
  );
  await assert.rejects(
    () => updateConversation(COMPANY, CONVERSATION, { handlingMode: "HYBRID" }),
    (e) => e.statusCode === 409
  );

  state.agent = { _id: AGENT };
  state.conversation = conversationDoc({ handlingMode: "HUMAN" });
  await updateConversation(COMPANY, CONVERSATION, { handlingMode: "AI" });
  assert.equal(state.conversation.handlingMode, "AI");
  assert.equal(state.lastAgentQuery.companyId, COMPANY, "agent lookup is company-scoped");
  assert.equal(state.lastAgentQuery.status, "active");
});

test("taking over (HUMAN) never needs an agent", async () => {
  reset();
  state.agent = null;
  state.conversation = conversationDoc({ handlingMode: "AI", agentId: null });
  await updateConversation(COMPANY, CONVERSATION, { handlingMode: "HUMAN" });
  assert.equal(state.conversation.handlingMode, "HUMAN");
});

test("assignment accepts an active teammate of the same company, or null to unassign", async () => {
  reset();
  await updateConversation(COMPANY, CONVERSATION, { assigneeId: COLLEAGUE });
  assert.equal(state.conversation.assigneeId, COLLEAGUE);
  assert.equal(state.lastUserQuery.companyId, COMPANY, "assignee lookup is company-scoped");
  assert.equal(state.lastUserQuery.status, "active");
  assert.equal(state.lastUserQuery.isDeleted, false);

  await updateConversation(COMPANY, CONVERSATION, { assigneeId: null });
  assert.equal(state.conversation.assigneeId, null);
  await updateConversation(COMPANY, CONVERSATION, { assigneeId: "" });
  assert.equal(state.conversation.assigneeId, null);
});

test("assigning someone from another company, or an inactive user, is refused", async () => {
  reset();
  state.user = null;
  await assert.rejects(
    () => updateConversation(COMPANY, CONVERSATION, { assigneeId: COLLEAGUE }),
    (e) => e.statusCode === 403
  );
  await assert.rejects(
    () => updateConversation(COMPANY, CONVERSATION, { assigneeId: "not-an-id" }),
    (e) => e.statusCode === 400
  );
  assert.equal(state.conversation.saved, 0, "nothing was saved");
});

test("the validator accepts the new fields and rejects bad values", () => {
  assert.doesNotThrow(() => validateConversationInput({ handlingMode: "HUMAN" }, { isUpdate: true }));
  assert.doesNotThrow(() => validateConversationInput({ assigneeId: null }, { isUpdate: true }));
  assert.doesNotThrow(() => validateConversationInput({ assigneeId: COLLEAGUE }, { isUpdate: true }));
  assert.throws(() => validateConversationInput({ handlingMode: "ROBOT" }, { isUpdate: true }), (e) => e.statusCode === 400);
  assert.throws(() => validateConversationInput({ assigneeId: "123" }, { isUpdate: true }), (e) => e.statusCode === 400);
});

test("an update does not mutate the caller's payload", async () => {
  reset();
  const payload = { assigneeId: "" };
  await updateConversation(COMPANY, CONVERSATION, payload);
  assert.deepEqual(payload, { assigneeId: "" });
});
