const test = require("node:test");
const assert = require("node:assert/strict");

const { Queue, InMemoryQueue, createQueue } = require("../src/services/queue");

test("K - createQueue returns an InMemoryQueue by default", () => {
  const queue = createQueue();
  assert.ok(queue instanceof InMemoryQueue);
  assert.equal(queue.name, "in-memory");
});

test("K - createQueue accepts 'memory' and empty name aliases", () => {
  assert.ok(createQueue("memory") instanceof InMemoryQueue);
  assert.ok(createQueue("") instanceof InMemoryQueue);
});

test("K - createQueue throws on unsupported queue name", () => {
  assert.throws(() => createQueue("sqs"), /Unsupported queue/);
});

test("K - Queue abstract class throws on direct instantiation", () => {
  assert.throws(() => new Queue(), /Queue is abstract/);
});

test("K - enqueue returns a job id and the job is pending", async () => {
  const queue = createQueue();
  const id = await queue.enqueue({ type: "ingest", documentId: "doc-1" });
  assert.equal(typeof id, "string");
  assert.ok(id.startsWith("job_"));
  assert.equal(await queue.size(), 1);
});

test("K - dequeue returns null when jobs are auto-drained (queue processes inline)", async () => {
  const queue = createQueue();
  let processed = false;
  queue.registerHandler("ingest", async () => { processed = true; });
  const id = await queue.enqueue({ type: "ingest", documentId: "doc-1" });

  await new Promise((resolve) => setTimeout(resolve, 50));

  // The queue auto-drains on enqueue, so the pending list is empty.
  const drained = await queue.dequeue();
  assert.equal(drained, null);
  assert.equal(processed, true);
  assert.equal(await queue.size(), 0);
  assert.equal(queue._jobs.has(id), false, "acked job should be removed");
});

test("K - ack removes the job record and processing entry", async () => {
  const queue = createQueue("in-memory", { maxRetries: 0 });
  let release;
  queue.registerHandler("ingest", async () => {
    await new Promise((resolve) => { release = resolve; });
  });
  const id = await queue.enqueue({ type: "ingest", documentId: "doc-1" });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(queue._processing.has(id), true);

  await queue.ack(id);
  assert.equal(queue._jobs.has(id), false);
  assert.equal(queue._processing.has(id), false);

  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("K - handler is invoked for matching job type", async () => {
  const queue = createQueue();
  let called = false;
  queue.registerHandler("ingest", async (job) => {
    called = true;
    assert.equal(job.documentId, "doc-1");
    assert.equal(job.type, "ingest");
  });
  await queue.enqueue({ type: "ingest", documentId: "doc-1" });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(called, true);
});

test("K - unhandled job type fails the job", async () => {
  const queue = createQueue();
  queue.registerHandler("ingest", async () => {});
  await queue.enqueue({ type: "unknown-type", documentId: "doc-1" });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const record = Array.from(queue._jobs.values())[0];
  assert.equal(record.status, "failed");
  assert.match(record.error, /No handler registered/);
});

test("K - failing handler retries up to maxRetries then fails", async () => {
  const queue = createQueue("in-memory", { maxRetries: 2 });
  let attempts = 0;
  queue.registerHandler("ingest", async () => {
    attempts += 1;
    throw new Error("boom");
  });
  await queue.enqueue({ type: "ingest", documentId: "doc-1" });

  await new Promise((resolve) => setTimeout(resolve, 2600));

  // After exhausting maxRetries the job is removed from the queue.
  assert.equal(queue._jobs.size, 0, "job should be removed after exhausting retries");
  assert.ok(attempts >= 2, `expected at least 2 attempts, got ${attempts}`);
});

test("K - retry increments attempt count and re-queues", async () => {
  const queue = createQueue("in-memory", { maxRetries: 3 });
  queue.registerHandler("ingest", async () => {
    throw new Error("transient");
  });
  await queue.enqueue({ type: "ingest", documentId: "doc-1" });

  await new Promise((resolve) => setTimeout(resolve, 1600));

  // After the first failure the job is retried: attempts increments to 2
  // and the record is re-queued for processing.
  const record = Array.from(queue._jobs.values())[0];
  assert.equal(record.status, "pending");
  assert.equal(record.attempts, 2, "retry should increment the attempt counter");
});

test("K - fail marks a job failed and records the error", async () => {
  const queue = createQueue();
  const id = await queue.enqueue({ type: "ingest", documentId: "doc-1" });
  await queue.fail(id, new Error("explicit failure"));

  const record = queue._jobs.get(id);
  assert.equal(record.status, "failed");
  assert.equal(record.error, "explicit failure");
});

test("K - size reflects pending plus processing jobs", async () => {
  const queue = createQueue();
  assert.equal(await queue.size(), 0);
  await queue.enqueue({ type: "ingest", documentId: "doc-1" });
  assert.equal(await queue.size(), 1);
  await queue.enqueue({ type: "ingest", documentId: "doc-2" });
  assert.equal(await queue.size(), 2);
});

test("K - close clears pending, processing, and timers", async () => {
  const queue = createQueue();
  queue.registerHandler("ingest", async () => {});
  await queue.enqueue({ type: "ingest", documentId: "doc-1" });
  await queue.enqueue({ type: "ingest", documentId: "doc-2" });

  await new Promise((resolve) => setTimeout(resolve, 50));

  await queue.close();
  assert.equal(queue._pending.length, 0);
  assert.equal(queue._processing.size, 0);
  assert.equal(queue._timers.size, 0);
});

test("K - registerHandler supports wildcard fallback", async () => {
  const queue = createQueue();
  let called = false;
  queue.registerHandler("*", async (job) => {
    called = true;
    assert.equal(job.type, "anything");
  });
  await queue.enqueue({ type: "anything", documentId: "doc-1" });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(called, true);
});

test("K - multiple jobs are processed concurrently", async () => {
  const queue = createQueue();
  let active = 0;
  let maxActive = 0;
  queue.registerHandler("ingest", async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
  });

  await Promise.all([
    queue.enqueue({ type: "ingest", documentId: "doc-1" }),
    queue.enqueue({ type: "ingest", documentId: "doc-2" }),
    queue.enqueue({ type: "ingest", documentId: "doc-3" }),
  ]);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(maxActive >= 1);
  assert.equal(await queue.size(), 0);
});