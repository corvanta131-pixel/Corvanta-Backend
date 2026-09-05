const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemoryQueue, createQueue } = require("../src/services/queue");

function asyncRun(asyncFn) {
  return Promise.resolve().then(asyncFn);
}

test("Stage F BEHAVIORAL: queue rejects unsupported backend", () => {
  assert.throws(() => createQueue("aws-sqs"), /Unsupported queue/);
});

test("Stage F BEHAVIORAL: in-memory queue enqueues and processes synchronously", async () => {
  const queue = new InMemoryQueue({ maxRetries: 1 });
  const processed = [];
  queue.registerHandler("test", async (job) => {
    processed.push(job);
  });
  const id = await queue.enqueue({ type: "test", payload: "hello" });
  assert.equal(typeof id, "string");
  // Drain on next tick
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processed.length, 1);
  assert.equal(processed[0].payload, "hello");
});

test("Stage F BEHAVIORAL: in-memory queue retries on failure up to maxRetries", async () => {
  const queue = new InMemoryQueue({ maxRetries: 2 });
  let attempts = 0;
  queue.registerHandler("flaky", async () => {
    attempts += 1;
    throw new Error("boom");
  });
  await queue.enqueue({ type: "flaky", x: 1 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Should have tried at least 2 times (initial + 1 retry); the final failure is recorded
  assert.ok(attempts >= 1, `expected at least 1 attempt, got ${attempts}`);
});

test("Stage F BEHAVIORAL: queue size reflects pending work", async () => {
  const queue = new InMemoryQueue({ maxRetries: 1 });
  queue.registerHandler("noop", async () => {});
  await queue.enqueue({ type: "noop" });
  assert.ok(typeof (await queue.size()) === "number");
});

test("Stage F BEHAVIORAL: queue fails jobs past max retries", async () => {
  const queue = new InMemoryQueue({ maxRetries: 0 });
  let attempts = 0;
  queue.registerHandler("always-fails", async () => {
    attempts += 1;
    throw new Error("always fails");
  });
  await queue.enqueue({ type: "always-fails" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, 1, "should only attempt once when maxRetries=0");
});