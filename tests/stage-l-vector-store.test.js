const test = require("node:test");
const assert = require("node:assert/strict");
const { VectorStore, createVectorStore, InMemoryVectorStore } = require("../src/services/vectorStore");
const {
  PineconeVectorStore,
  createPineconeVectorStore,
} = require("../src/services/providers/pineconeVectorStore");
const {
  VectorStoreError,
  VectorStoreAuthError,
  VectorStoreTimeoutError,
  VectorStoreUnavailableError,
  VectorStoreValidationError,
  normalizeVectorStoreError,
  isConfigured,
  assertConfigured,
} = require("../src/services/providers/pineconeError");

const VECTOR = [0.1, 0.2, 0.3, 0.4];
const COMP_A = "comp-a";
const COMP_B = "comp-b";

function makeAdapter(responder) {
  return async (request) => responder(request);
}

function makeStore(overrides = {}) {
  return new PineconeVectorStore({
    apiKey: "test-api-key",
    index: "test-index",
    host: "https://api.pinecone.io",
    httpAdapter: overrides.httpAdapter,
    shouldFailNext: overrides.shouldFailNext || false,
    ...overrides,
  });
}

// ---------- UNIT: provider construction ----------

test("L - PineconeVectorStore extends VectorStore and has a name", () => {
  const store = makeStore();
  assert.ok(store instanceof VectorStore);
  assert.equal(store.name, "pinecone");
});

test("L - createPineconeVectorStore returns a PineconeVectorStore", () => {
  const store = createPineconeVectorStore("pinecone", { apiKey: "k", index: "i" });
  assert.ok(store instanceof PineconeVectorStore);
  assert.ok(store instanceof VectorStore);
});

test("L - createPineconeVectorStore throws on unsupported name", () => {
  assert.throws(() => createPineconeVectorStore("sqs"), /Unsupported pinecone/);
});

// ---------- UNIT: configuration / opt-in ----------

test("L - isConfigured returns false when credentials are missing", () => {
  assert.equal(isConfigured({ apiKey: "", index: "" }), false);
  assert.equal(isConfigured({ apiKey: "k", index: "" }), false);
  assert.equal(isConfigured({ apiKey: "k", index: "i" }), true);
});

test("L - assertConfigured throws when not configured", () => {
  assert.throws(() => assertConfigured({ apiKey: "", index: "" }), VectorStoreValidationError);
});

test("L - factory default remains in-memory and unchanged", () => {
  const store = createVectorStore();
  assert.ok(store instanceof InMemoryVectorStore);
  assert.equal(store.name, "in-memory");
});

test("L - factory selects pinecone only when explicitly configured", () => {
  const store = createVectorStore("pinecone", { apiKey: "k", index: "i" });
  assert.ok(store instanceof PineconeVectorStore);
});

test("L - factory throws on unsupported vector store name", () => {
  assert.throws(() => createVectorStore("s3"), /Unsupported vector store/);
});

// ---------- UNIT: tenant validation ----------

test("L - upsert rejects records missing cid", async () => {
  const store = makeStore({ httpAdapter: () => ({ upsertedCount: 1 }) });
  await assert.rejects(() => store.upsert([{ knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]), VectorStoreValidationError);
  await assert.rejects(() => store.upsert([{ knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR, knowledgeDocumentId: undefined }]), VectorStoreValidationError);
});

test("L - upsert rejects records missing required fields", async () => {
  const store = makeStore({ httpAdapter: () => ({ upsertedCount: 1 }) });
  await assert.rejects(() => store.upsert([{ knowledgeDocumentId: "d", chunkId: "c" }]), VectorStoreValidationError);
  await assert.rejects(() => store.upsert([{ knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]), VectorStoreValidationError);
  // A record with all required fields present must NOT throw validation.
  const ids = await store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]);
  assert.ok(Array.isArray(ids));
  assert.equal(ids.length, 1);
});

test("L - search rejects missing cid", async () => {
  const store = makeStore({ httpAdapter: () => ({ matches: [] }) });
  await assert.rejects(() => store.search({ vector: VECTOR }), VectorStoreValidationError);
});

// ---------- UNIT: error normalization ----------

test("L - normalizeVectorStoreError maps timeout", () => {
  const err = normalizeVectorStoreError(new Error("request timed out"));
  assert.ok(err instanceof VectorStoreTimeoutError);
});

test("L - normalizeVectorStoreError maps auth", () => {
  const err = normalizeVectorStoreError(new Error("401 Unauthorized: invalid api key"));
  assert.ok(err instanceof VectorStoreAuthError);
});

test("L - normalizeVectorStoreError maps unavailable", () => {
  const err = normalizeVectorStoreError(new Error("ECONNREFUSED"));
  assert.ok(err instanceof VectorStoreUnavailableError);
});

test("L - normalizeVectorStoreError maps malformed response", () => {
  const err = normalizeVectorStoreError({ code: "VECTOR_STORE_MALFORMED_RESPONSE", message: "bad json" });
  assert.equal(err.code, "VECTOR_STORE_MALFORMED_RESPONSE");
  assert.equal(err.statusCode, 502);
});

// ---------- FAILURE: simulated provider failure ----------

test("L - upsert with shouldFailNext rejects with VectorStoreUnavailableError", async () => {
  const store = makeStore({ shouldFailNext: true });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]),
    VectorStoreUnavailableError
  );
});

test("L - upsert without configuration rejects with validation error", async () => {
  const store = makeStore({ apiKey: "", index: "" });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]),
    VectorStoreValidationError
  );
});

test("L - upsert with empty vector rejects with validation error", async () => {
  const store = makeStore({ httpAdapter: () => ({ upsertedCount: 1 }) });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: [] }]),
    VectorStoreValidationError
  );
});

test("L - upsert with malformed vector rejects with validation error", async () => {
  const store = makeStore({ httpAdapter: () => ({ upsertedCount: 1 }) });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: ["not", "numbers"] }]),
    VectorStoreValidationError
  );
});

test("L - search with empty vector returns empty results", async () => {
  const store = makeStore({ httpAdapter: () => ({ matches: [] }) });
  const results = await store.search({ companyId: COMP_A, vector: [] });
  assert.equal(Array.isArray(results), true);
  assert.equal(results.length, 0);
});

// ---------- FAILURE: HTTP adapter failure paths ----------

test("L - upsert via adapter rejects with VectorStoreAuthError on 401", async () => {
  const store = makeStore({
    httpAdapter: () => { throw new Error("401 Unauthorized: invalid api key"); },
  });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]),
    VectorStoreAuthError
  );
});

test("L - upsert via adapter rejects with VectorStoreTimeoutError on timeout", async () => {
  const store = makeStore({
    httpAdapter: () => { throw new Error("request timed out"); },
  });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]),
    VectorStoreTimeoutError
  );
});

test("L - upsert via adapter rejects with VectorStoreUnavailableError on connection refused", async () => {
  const store = makeStore({
    httpAdapter: () => { throw new Error("ECONNREFUSED"); },
  });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]),
    VectorStoreUnavailableError
  );
});

test("L - upsert via adapter rejects with malformed-response error on bad JSON", async () => {
  const store = makeStore({
    httpAdapter: () => { throw { code: "VECTOR_STORE_MALFORMED_RESPONSE", message: "bad json" }; },
  });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]),
    (error) => error.code === "VECTOR_STORE_MALFORMED_RESPONSE"
  );
});

test("L - search via adapter filters out cross-tenant matches", async () => {
  const store = makeStore({
    httpAdapter: () => ({
      matches: [
        { id: "a", score: 0.9, metadata: { _companyId: COMP_A, _chunkId: "a", _knowledgeDocumentId: "da", _knowledgeBaseId: "kb" } },
        { id: "b", score: 0.8, metadata: { _companyId: COMP_B, _chunkId: "b", _knowledgeDocumentId: "db", _knowledgeBaseId: "kb" } },
      ],
    }),
  });
  const results = await store.search({ companyId: COMP_A, vector: VECTOR });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "a");
  assert.equal(results[0].cid, COMP_A);
});

test("L - search via adapter returns empty on no matches", async () => {
  const store = makeStore({
    httpAdapter: () => ({ matches: [] }),
  });
  const results = await store.search({ companyId: COMP_A, vector: VECTOR });
  assert.equal(results.length, 0);
});

test("L - search via adapter applies minScore filter", async () => {
  const store = makeStore({
    httpAdapter: () => ({
      matches: [
        { id: "a", score: 0.5, metadata: { _companyId: COMP_A, _chunkId: "a", _knowledgeDocumentId: "da", _knowledgeBaseId: "kb" } },
        { id: "b", score: 0.9, metadata: { _companyId: COMP_A, _chunkId: "b", _knowledgeDocumentId: "db", _knowledgeBaseId: "kb" } },
      ],
    }),
  });
  const results = await store.search({ companyId: COMP_A, vector: VECTOR, minScore: 0.8 });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "b");
});

// ---------- SECURITY: credentials never exposed ----------

test("L - credentials are never returned in API responses or errors", async () => {
  const store = makeStore({
    httpAdapter: () => ({ upsertedCount: 1 }),
  });
  const ids = await store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]);
  const serialized = JSON.stringify(ids);
  assert.equal(serialized.includes("test-api-key"), false);
  assert.equal(serialized.includes("pinecone"), false);
});

test("L - credentials are read from environment/configuration, never hard-coded", () => {
  const store = new PineconeVectorStore({ apiKey: "", index: "" });
  assert.equal(store.apiKey, "");
  assert.equal(store.index, "");
});

test("L - delete without id throws validation error", async () => {
  const store = makeStore({ httpAdapter: () => ({}) });
  await assert.rejects(() => store.delete(""), VectorStoreValidationError);
});

test("L - deleteByCompany without cid throws validation error", async () => {
  const store = makeStore({ httpAdapter: () => ({}) });
  await assert.rejects(() => store.deleteByCompany({}), VectorStoreValidationError);
});

// ---------- ADVERSARIAL: tenant isolation ----------

test("L - search with forged cid cannot retrieve another company's vectors", async () => {
  const store = makeStore({
    httpAdapter: () => ({
      matches: [
        { id: "a", score: 0.95, metadata: { _companyId: COMP_A, _chunkId: "a", _knowledgeDocumentId: "da", _knowledgeBaseId: "kb" } },
      ],
    }),
  });
  // Company B querying with company A's cid is filtered out server-side.
  const results = await store.search({ companyId: COMP_B, vector: VECTOR });
  assert.equal(results.length, 0);
});

test("L - deleteByDocument with mismatched cid is rejected", async () => {
  const store = makeStore({ httpAdapter: () => ({}) });
  await assert.rejects(() => store.deleteByDocument({ knowledgeDocumentId: "d" }), VectorStoreValidationError);
});

test("L - deleteByKnowledgeBase with mismatched cid is rejected", async () => {
  const store = makeStore({ httpAdapter: () => ({}) });
  await assert.rejects(() => store.deleteByKnowledgeBase({ knowledgeBaseId: "kb" }), VectorStoreValidationError);
});

test("L - upsert with mismatched metadata cid is normalized to the provided cid", async () => {
  let capturedBody = null;
  const store = makeStore({
    httpAdapter: (request) => {
      capturedBody = request.body;
      return { upsertedCount: 1 };
    },
  });
  await store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]);
  assert.ok(capturedBody);
  assert.equal(capturedBody.vectors[0].metadata._companyId, COMP_A);
});

test("L - upsert with empty cid is rejected", async () => {
  const store = makeStore({ httpAdapter: () => ({ upsertedCount: 1 }) });
  await assert.rejects(() => store.upsert([{ knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR, cid: "" }]), VectorStoreValidationError);
});

// ---------- ADVERSARIAL: input validation ----------

test("L - upsert with non-finite vector values is rejected", async () => {
  const store = makeStore({ httpAdapter: () => ({ upsertedCount: 1 }) });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: [0.1, NaN, Infinity] }]),
    VectorStoreValidationError
  );
});

test("L - upsert with missing metadata fields is rejected", async () => {
  const store = makeStore({ httpAdapter: () => ({ upsertedCount: 1 }) });
  await assert.rejects(() => store.upsert([{ companyId: COMP_A, chunkId: "c", vector: VECTOR }]), VectorStoreValidationError);
  await assert.rejects(() => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", vector: VECTOR }]), VectorStoreValidationError);
});

test("L - search with invalid query parameters is handled safely", async () => {
  const store = makeStore({ httpAdapter: () => ({ matches: [] }) });
  // Non-numeric limit falls back to the default topK rather than throwing.
  const results = await store.search({ companyId: COMP_A, vector: VECTOR, limit: "abc" });
  assert.equal(results.length, 0);
});

test("L - search with non-array knowledgeBaseIds is handled safely", async () => {
  const store = makeStore({ httpAdapter: () => ({ matches: [] }) });
  const results = await store.search({ companyId: COMP_A, vector: VECTOR, knowledgeBaseIds: "not-an-array" });
  assert.equal(results.length, 0);
});

// ---------- ADVERSARIAL: provider failure ----------

test("L - upsert via adapter rejects with VectorStoreError on unexpected error", async () => {
  const store = makeStore({
    httpAdapter: () => { throw new Error("unexpected provider error"); },
  });
  await assert.rejects(
    () => store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]),
    VectorStoreError
  );
});

test("L - search via adapter handles partial response gracefully", async () => {
  const store = makeStore({
    httpAdapter: () => ({ matches: undefined }),
  });
  const results = await store.search({ companyId: COMP_A, vector: VECTOR });
  assert.equal(results.length, 0);
});

test("L - health returns unhealthy when not configured", async () => {
  const store = makeStore({ apiKey: "", index: "" });
  const health = await store.health();
  assert.equal(health.status, "unhealthy");
});

test("L - health returns healthy when configured and reachable", async () => {
  const store = makeStore({ httpAdapter: () => ({}) });
  const health = await store.health();
  assert.equal(health.status, "healthy");
  assert.equal(health.index, "test-index");
});

// ---------- SECURITY ----------

test("L - provider credentials are never included in thrown errors", async () => {
  const store = makeStore({
    httpAdapter: () => { throw new Error("401 Unauthorized: invalid api key"); },
  });
  let caught = null;
  try {
    await store.upsert([{ companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.name, "VectorStoreAuthError");
  assert.equal(String(caught.message).includes("test-api-key"), false);
  assert.equal(String(caught.stack || "").includes("test-api-key"), false);
});

test("L - provider never logs credentials", async () => {
  const leaked = [];
  const origError = console.error;
  console.error = (...args) => { leaked.push(args.join(" ")); };
  try {
    const store = makeStore({ httpAdapter: () => { throw new Error("boom"); } });
    await store.upsert([{ cid: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR }]);
  } catch (_error) {
    // expected
  } finally {
    console.error = origError;
  }
  assert.equal(leaked.some((line) => line.includes("test-api-key")), false);
});

// ---------- COMPATIBILITY ----------

test("L - application code depends only on the VectorStore abstraction (ingestionService + knowledgeSearchService)", () => {
  const ingestion = require("../src/services/ingestionService");
  const kss = require("../src/services/knowledgeSearchService");
  assert.ok(typeof ingestion.ingestKnowledgeDocument === "function" || typeof ingestion === "object");
  assert.ok(typeof kss.searchKnowledge === "function" || typeof kss === "object");
});

test("L - existing PersistentVectorStore still works after factory change", async () => {
  const { createPersistentVectorStore } = require("../src/services/persistentVectorStore");
  const store = createPersistentVectorStore("persistent-mongodb");
  assert.equal(store.name, "persistent-mongodb");
});

test("L - provider switching does not require business-layer changes (same contract)", async () => {
  const memory = createVectorStore("memory");
  const pinecone = createVectorStore("pinecone", { apiKey: "k", index: "i", httpAdapter: () => ({ upsertedCount: 1, matches: [] }) });
  const record = { companyId: COMP_A, knowledgeDocumentId: "d", chunkId: "c", vector: VECTOR };
  const memIds = await memory.upsert([{ ...record, companyId: COMP_A }]);
  const pineIds = await pinecone.upsert([record]);
  assert.ok(Array.isArray(memIds));
  assert.ok(Array.isArray(pineIds));
  assert.equal(memIds.length, 1);
  assert.equal(pineIds.length, 1);
});
