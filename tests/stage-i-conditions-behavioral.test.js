const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateConditions, sanitizeFieldPath } = require("../src/services/workflow/conditionEvaluator");

test("conditions: empty array passes", () => {
  const result = evaluateConditions([], { message: { body: "hi" } });
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 0);
});

test("conditions: eq matches", () => {
  const result = evaluateConditions(
    [{ field: "message.direction", operator: "eq", value: "inbound" }],
    { message: { direction: "inbound" } }
  );
  assert.equal(result.passed, true);
  assert.equal(result.results.length, 1);
});

test("conditions: ne mismatch", () => {
  const result = evaluateConditions(
    [{ field: "message.direction", operator: "ne", value: "outbound" }],
    { message: { direction: "inbound" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: in matches", () => {
  const result = evaluateConditions(
    [{ field: "channel.type", operator: "in", value: ["email", "webchat"] }],
    { channel: { type: "email" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: nin matches", () => {
  const result = evaluateConditions(
    [{ field: "channel.type", operator: "nin", value: ["whatsapp", "sms"] }],
    { channel: { type: "email" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: contains is case-insensitive", () => {
  const result = evaluateConditions(
    [{ field: "message.body", operator: "contains", value: "Hello" }],
    { message: { body: "say hello world" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: startsWith", () => {
  const result = evaluateConditions(
    [{ field: "message.body", operator: "startsWith", value: "hi" }],
    { message: { body: "hi there" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: endsWith", () => {
  const result = evaluateConditions(
    [{ field: "message.body", operator: "endsWith", value: "bye" }],
    { message: { body: "good bye" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: exists", () => {
  const result = evaluateConditions(
    [{ field: "customer.email", operator: "exists", value: null }],
    { customer: { email: "user@example.com" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: numeric gt/gte/lt/lte", () => {
  assert.equal(evaluateConditions([{ field: "x", operator: "gt", value: 1 }], { x: 2 }).passed, true);
  assert.equal(evaluateConditions([{ field: "x", operator: "gte", value: 2 }], { x: 2 }).passed, true);
  assert.equal(evaluateConditions([{ field: "x", operator: "lt", value: 3 }], { x: 2 }).passed, true);
  assert.equal(evaluateConditions([{ field: "x", operator: "lte", value: 2 }], { x: 2 }).passed, true);
});

test("conditions: missing field resolves to undefined", () => {
  const result = evaluateConditions(
    [{ field: "customer.unknown", operator: "eq", value: "x" }],
    { customer: {} }
  );
  assert.equal(result.passed, false);
});

test("conditions: ALL must pass (AND)", () => {
  const result = evaluateConditions(
    [
      { field: "channel.type", operator: "eq", value: "email" },
      { field: "message.direction", operator: "eq", value: "inbound" },
    ],
    { channel: { type: "email" }, message: { direction: "inbound" } }
  );
  assert.equal(result.passed, true);
});

test("conditions: ANY failing fails entire evaluation", () => {
  const result = evaluateConditions(
    [
      { field: "channel.type", operator: "eq", value: "email" },
      { field: "message.direction", operator: "eq", value: "outbound" },
    ],
    { channel: { type: "email" }, message: { direction: "inbound" } }
  );
  assert.equal(result.passed, false);
});

test("conditions: rejects unknown operator", () => {
  assert.throws(
    () => evaluateConditions([{ field: "x", operator: "regex", value: ".*" }], {}),
    /Unsupported condition operator/
  );
});

test("conditions: rejects unsafe field patterns", () => {
  assert.throws(
    () => sanitizeFieldPath("__proto__"),
    /forbidden pattern/
  );
  assert.throws(
    () => sanitizeFieldPath("constructor"),
    /forbidden pattern/
  );
  assert.throws(
    () => sanitizeFieldPath("prototype.x"),
    /forbidden pattern/
  );
  assert.throws(
    () => sanitizeFieldPath("eval.body"),
    /forbidden pattern/
  );
  assert.throws(
    () => sanitizeFieldPath("function.run"),
    /forbidden pattern/
  );
  assert.throws(
    () => sanitizeFieldPath("$__proto__"),
    /forbidden pattern/
  );
  assert.throws(
    () => sanitizeFieldPath("require.os"),
    /forbidden pattern/
  );
  assert.throws(
    () => sanitizeFieldPath("import.x"),
    /forbidden pattern/
  );
});

test("conditions: rejects empty field", () => {
  assert.throws(
    () => sanitizeFieldPath(""),
    /non-empty string/
  );
  assert.throws(
    () => sanitizeFieldPath("   "),
    /non-empty string/
  );
});

test("conditions: rejects field path exceeding 200 chars", () => {
  const longField = "a." + "x".repeat(250);
  assert.throws(
    () => sanitizeFieldPath(longField),
    /exceeds maximum length/
  );
});

test("conditions: requires array input", () => {
  assert.throws(() => evaluateConditions("not-an-array", {}), /array/);
  assert.throws(() => evaluateConditions(null, {}), /array/);
});

test("conditions: validates each condition shape", () => {
  assert.throws(
    () => evaluateConditions([{ operator: "eq", value: "x" }], {}),
    /string 'field'/
  );
  assert.throws(
    () => evaluateConditions([{ field: "x" }], {}),
    /string 'operator'/
  );
});

test("conditions: prototype pollution attempts are blocked at field level", () => {
  const pollutedContext = {};
  Object.prototype.injected = "pwned";
  try {
    const result = evaluateConditions(
      [{ field: "injected", operator: "eq", value: "pwned" }],
      pollutedContext
    );
    // The field "injected" is not a forbidden pattern, so it is treated as a regular field.
    // It is undefined on the context, so the eq check fails.
    assert.equal(result.passed, false);
  } finally {
    delete Object.prototype.injected;
  }
});

test("conditions: deeply nested prototype pollution is isolated", () => {
  // Try to assign via condition
  assert.throws(
    () => evaluateConditions(
      [{ field: "__proto__.polluted", operator: "eq", value: "x" }],
      {}
    ),
    /forbidden pattern/
  );
});
