const test = require("node:test");
const assert = require("node:assert/strict");
const { SQSQueue } = require("../src/services/providers/sqsQueue");
const { SQSError, SQSConfigError, SQSValidationError, SQSTimeoutError } = require("../src/services/providers/sqsError");

const COMP_A = "comp-a";
const COMP_B = "comp-b";

function makeStore(overrides = {}) {
  return new SQSQueue({
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123/test-queue",
    region: "us-east-1",
    httpAdapter: overrides.httpAdapter,
    ...overrides,
  });
}

test("M3 - cid is preserved through the SQS round trip", async () => {
  let enqueuedBody = null;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "sendMessage") {
        enqueuedBody = request.input.body;
        return { MessageId: "mid" };
      }
      if (request.operation === "receiveMessage") {
        return { Messages: [{ Body: enqueuedBody, ReceiptHandle: "h" }] };
      }
      return {};
    },
  });
  await store.enqueue({ type: "ingest", documentId: "doc-1", cid: COMP_A });
  const job = await store.dequeue();
  assert.ok(job, "dequeue should return the enqueued job");
  assert.equal(job.cid, COMP_A);
});

test("M3 - a consumer can distinguish tenant A from tenant B by cid", async () => {
  const store = makeStore({
    httpAdapter: () => ({ Messages: [{ Body: JSON.stringify({ id: "job-b", type: "ingest", cid: COMP_B }), ReceiptHandle: "h" }] }),
  });
  const job = await store.dequeue();
  assert.equal(job.cid, COMP_B);
  // The application layer is responsible for filtering by tenant.
  assert.notEqual(job.cid, COMP_A);
});

test("M3 - malformed JSON body is rejected and deleted", async () => {
  let deleted = false;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "receiveMessage") {
        return { Messages: [{ Body: "{bad json", ReceiptHandle: "h" }] };
      }
      if (request.operation === "deleteMessage") { deleted = true; return {}; }
      return {};
    },
  });
  const job = await store.dequeue();
  assert.equal(job, null);
  assert.equal(deleted, true);
});

test("M3 - missing job ID is generated safely", async () => {
  const store = makeStore({
    httpAdapter: () => ({ Messages: [{ Body: JSON.stringify({ type: "ingest", cid: COMP_A }), ReceiptHandle: "h" }] }),
  });
  const job = await store.dequeue();
  assert.ok(job);
  assert.ok(typeof job.id === "string" && job.id.length > 0, "a job id should be present");
});

test("M3 - duplicate message delivery is returned (at-least-once); consumer must dedupe", async () => {
  const store = makeStore({
    httpAdapter: () => ({ Messages: [{ Body: JSON.stringify({ id: "dup-1", type: "ingest", cid: COMP_A }), ReceiptHandle: "h1" }] }),
  });
  const first = await store.dequeue();
  const second = await store.dequeue();
  assert.ok(first);
  // SQS is at-least-once: the same logical message may be redelivered.
  assert.ok(second, "duplicate delivery must be surfaced to the consumer for idempotent handling");
  assert.equal(second.id, first.id);
});

test("M3 - ack with empty receipt handle is rejected", async () => {
  const store = makeStore({ httpAdapter: () => ({}) });
  await assert.rejects(() => store.ack(""), SQSValidationError);
});

test("M3 - ack failure normalizes to SQS error", async () => {
  const store = makeStore({ httpAdapter: () => { throw new Error("delete failed"); } });
  await assert.rejects(() => store.ack("h"), SQSError);
});

test("M3 - retry after visibility timeout works", async () => {
  let captured = null;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "changeMessageVisibility") captured = request.input;
      return {};
    },
  });
  await store.retry("h", 5000);
  assert.equal(captured.visibilityTimeout, 5);
});

test("M3 - retry failure normalizes to SQS error", async () => {
  const store = makeStore({ httpAdapter: () => { throw new Error("visibility failed"); } });
  await assert.rejects(() => store.retry("h"), SQSError);
});

test("M3 - fail does not make the message disappear unexpectedly", async () => {
  let captured = null;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "changeMessageVisibility") captured = request.input;
      return {};
    },
  });
  const result = await store.fail("h", new Error("boom"));
  assert.equal(captured.receiptHandle, "h");
  assert.equal(result.failed, true);
  assert.equal(result.error, "boom");
});

test("M3 - missing region is rejected", async () => {
  const store = makeStore({ region: "", queueUrl: "u" });
  await assert.rejects(() => store.enqueue({ type: "ingest", cid: COMP_A }), SQSConfigError);
});

test("M3 - missing queue URL is rejected", async () => {
  const store = makeStore({ queueUrl: "", region: "r" });
  await assert.rejects(() => store.enqueue({ type: "ingest", cid: COMP_A }), SQSConfigError);
});

test("M3 - timeout normalizes to SQSTimeoutError", async () => {
  const store = makeStore({ httpAdapter: () => { throw new Error("request timed out"); } });
  await assert.rejects(() => store.enqueue({ type: "ingest", cid: COMP_A }), SQSTimeoutError);
});

test("M3 - throttling normalizes to SQS error", async () => {
  const store = makeStore({ httpAdapter: () => { throw new Error("Request is throttled"); } });
  await assert.rejects(() => store.enqueue({ type: "ingest", cid: COMP_A }), SQSError);
});

test("M3 - malformed SDK response is handled", async () => {
  const store = makeStore({ httpAdapter: () => ({ Messages: "not-an-array" }) });
  const job = await store.dequeue();
  assert.equal(job, null);
});

test("M3 - credentials are never exposed in errors", async () => {
  const store = makeStore({ httpAdapter: () => { throw new Error("401 Unauthorized"); } });
  let caught = null;
  try { await store.enqueue({ type: "ingest", cid: COMP_A }); } catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(String(caught.message).includes("us-east-1"), false);
  assert.equal(String(caught.stack || "").includes("us-east-1"), false);
});

test("M3 - tenant identity survives enqueue -> dequeue round trip", async () => {
  let enqueuedBody = null;
  const store = makeStore({
    httpAdapter: (request) => {
      if (request.operation === "sendMessage") {
        enqueuedBody = request.input.body;
        return { MessageId: "mid" };
      }
      if (request.operation === "receiveMessage") {
        return { Messages: [{ Body: enqueuedBody, ReceiptHandle: "h" }] };
      }
      return {};
    },
  });
  await store.enqueue({ type: "ingest", documentId: "doc-1", cid: COMP_A });
  const job = await store.dequeue();
  assert.ok(job);
  assert.equal(job.cid, COMP_A);
});

test("M3 - ingestionService can select queueType without business changes", async () => {
  const { createQueue } = require("../src/services/queue");
  const sqs = createQueue("sqs", { queueUrl: "u", region: "r", httpAdapter: () => ({ Messages: [] }) });
  assert.equal(sqs.name, "sqs");
  const mem = createQueue("in-memory");
  assert.equal(mem.name, "in-memory");
});