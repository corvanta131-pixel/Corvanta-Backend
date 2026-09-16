const test = require("node:test");
const assert = require("node:assert/strict");
const { Queue, InMemoryQueue, createQueue } = require("../src/services/queue");
const { SQSQueue, createSQSQueue } = require("../src/services/providers/sqsQueue");
const {
  SQSError,
  SQSAuthError,
  SQSConfigError,
  SQSTimeoutError,
  SQSUnavailableError,
  SQSValidationError,
  normalizeSQSError,
  isConfigured,
  assertConfigured,
  assertJob,
} = require("../src/services/providers/sqsError");

const COMP_A = "comp-a";
const COMP_B = "comp-b";

function makeAdapter(responder) {
  return async (request) => responder(request);
}

function makeStore(overrides = {}) {
  return new SQSQueue({
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123/test-queue",
    region: "us-east-1",
    httpAdapter: overrides.httpAdapter,
    ...overrides,
  });
}

// ---------- CONSTRUCTION ----------

test("M - SQSQueue extends Queue and has a name", () => {
  const store = makeStore();
  assert.ok(store instanceof Queue);
  assert.equal(store.name, "sqs");
});

test("M - createSQSQueue returns an SQSQueue", () => {
  const store = createSQSQueue("sqs", { queueUrl: "u", region: "r" });
  assert.ok(store instanceof SQSQueue);
  assert.ok(store instanceof Queue);
});

test("M - createSQSQueue throws on unsupported name", () => {
  assert.throws(() => createSQSQueue("s3"), /Unsupported SQS/);
});

test("M - Queue abstract base cannot be instantiated directly", () => {
  assert.throws(() => new Queue(), /abstract/);
});

// ---------- CONFIGURATION ----------

test("M - isConfigured returns false when credentials are missing", () => {
  assert.equal(isConfigured({ queueUrl: "", region: "" }), false);
  assert.equal(isConfigured({ queueUrl: "u", region: "" }), false);
  assert.equal(isConfigured({ queueUrl: "u", region: "r" }), true);
});

test("M - assertConfigured throws when not configured", () => {
  assert.throws(() => assertConfigured({ queueUrl: "", region: "" }), SQSConfigError);
});

test("M - factory default remains in-memory and unchanged", () => {
  const store = createQueue();
  assert.ok(store instanceof InMemoryQueue);
  assert.equal(store.name, "in-memory");
});

test("M - factory selects sqs only when explicitly configured", () => {
  const store = createQueue("sqs", { queueUrl: "u", region: "r" });
  assert.ok(store instanceof SQSQueue);
});

test("M - factory throws on unsupported queue name", () => {
  assert.throws(() => createQueue("s3"), /Unsupported queue/);
});

// ---------- ENQUEUE ----------

test("M - enqueue returns a message id for a valid job", async () => {
  const store = makeStore({ httpAdapter: () => ({ MessageId: "msg-123" }) });
  const id = await store.enqueue({ type: "ingest", documentId: "doc-1", cid: COMP_A });
  assert.equal(typeof id, "string");
  assert.equal(id, "msg-123");
});

test("M - enqueue preserves cid in the serialized payload", async () => {
  let captured = null;
  const store = makeStore({
    httpAdapter: (request) => {
      captured = request.input.body;
      return { MessageId: "msg-456" };
    },
  });
  await store.enqueue({ type: "ingest", documentId: "doc-1", cid: COMP_A });
  const parsed = JSON.parse(captured);
  assert.equal(parsed.cid, COMP_A);
  assert.equal(parsed.type, "ingest");
  assert.equal(parsed.documentId, "doc-1");
  assert.ok(parsed.id);
  assert.ok(parsed.createdAt);
});

test("M - enqueue rejects malformed job without type", async () => {
  const store = makeStore({ httpAdapter: () => ({ MessageId: "x" }) });
  await assert.rejects(() => store.enqueue({ documentId: "doc-1", cid: COMP_A }), SQSValidationError);
});

test("M - enqueue rejects job missing cid", async () => {
  const store = makeStore({ httpAdapter: () => ({ MessageId: "x" }) });
  await assert.rejects(() => store.enqueue({ type: "ingest", documentId: "doc-1" }), SQSValidationError);
});

test("M - enqueue rejects non-object job", async () => {
  const store = makeStore({ httpAdapter: () => ({ MessageId: "x" }) });
  await assert.rejects(() => store.enqueue(null), SQSValidationError);
  await assert.rejects(() => store.enqueue("string"), SQSValidationError);
});

// ---------- DEQUEUE ----------

test("M - dequeue returns a parsed job from a valid SQS response", async () => {
  const store = makeStore({
    httpAdapter: () => ({
      Messages: [
        {
          Body: JSON.stringify({ id: "job-1", type: "ingest", documentId: "doc-1", cid: COMP_A, createdAt: "2026-01-01T00:00:00.000Z" }),
          ReceiptHandle: "handle-1",
          Attributes: { ApproximateReceiveCount: "1" },
        },
      ],
    }),
  });
  const job = await store.dequeue();
  assert.ok(job);
  assert.equal(job.id, "job-1");
  assert.equal(job.type, "ingest");
  assert.equal(job.cid, COMP_A);
  assert.equal(job.receiptHandle, "handle-1");
  assert.equal(job.approximateReceiveCount, 1);
});

test("M - dequeue returns null on empty queue", async () => {
  const store = makeStore({ httpAdapter: () => ({ Messages: [] }) });
  const job = await store.dequeue();
  assert.equal(job, null);
});

test("M - dequeue tolerates malformed message bodies and deletes them", async () => {
  let deleted = false;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "receiveMessage") {
        return { Messages: [{ Body: "not-json", ReceiptHandle: "bad-handle" }] };
      }
      if (request.operation === "deleteMessage") {
        deleted = true;
        return {};
      }
      return {};
    },
  });
  const job = await store.dequeue();
  assert.equal(job, null);
  assert.equal(deleted, true, "malformed message should be deleted");
});

test("M - dequeue rejects message missing cid", async () => {
  const store = makeStore({
    httpAdapter: () => ({ Messages: [{ Body: JSON.stringify({ id: "job-2", type: "ingest" }), ReceiptHandle: "h2" }] }),
  });
  const job = await store.dequeue();
  assert.equal(job, null);
});

// ---------- ACK ----------

test("M - ack deletes the message by receipt handle", async () => {
  let captured = null;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "deleteMessage") captured = request.input.receiptHandle;
      return {};
    },
  });
  const result = await store.ack("handle-abc");
  assert.equal(result, true);
  assert.equal(captured, "handle-abc");
});

test("M - ack with object job uses its receipt handle", async () => {
  let captured = null;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "deleteMessage") captured = request.input.receiptHandle;
      return {};
    },
  });
  await store.ack({ receiptHandle: "handle-obj" });
  assert.equal(captured, "handle-obj");
});

test("M - ack rejects missing receipt handle", async () => {
  const store = makeStore({ httpAdapter: () => ({}) });
  await assert.rejects(() => store.ack(""), SQSValidationError);
  await assert.rejects(() => store.ack(null), SQSValidationError);
});

test("M - ack failure normalizes to SQS error", async () => {
  const store = makeStore({ httpAdapter: () => { throw new Error("delete failed"); } });
  await assert.rejects(() => store.ack("h"), SQSError);
});

// ---------- RETRY ----------

test("M - retry changes message visibility timeout", async () => {
  let captured = null;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "changeMessageVisibility") captured = request.input;
      return {};
    },
  });
  await store.retry("handle-r", 2000);
  assert.equal(captured.receiptHandle, "handle-r");
  assert.equal(captured.visibilityTimeout, 2);
});

test("M - retry failure normalizes to SQS error", async () => {
  const store = makeStore({ httpAdapter: () => { throw new Error("visibility change failed"); } });
  await assert.rejects(() => store.retry("h"), SQSError);
});
