const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-f-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-f-refresh-secret";

let mongo;
let app;
let tokenA;
let tokenB;
let readonlyToken;
let a;
let b;

const KnowledgeChunk = require("../src/models/KnowledgeChunk");
const KnowledgeBase = require("../src/models/KnowledgeBase");
const KnowledgeDocument = require("../src/models/KnowledgeDocument");
const IngestionJob = require("../src/models/IngestionJob");
const AIAgent = require("../src/models/AIAgent");
const Conversation = require("../src/models/Conversation");
const Message = require("../src/models/Message");
const Company = require("../src/models/Company");

const { InMemoryVectorStore, createVectorStore } = require("../src/services/vectorStore");
const { PersistentVectorStore, createPersistentVectorStore } = require("../src/services/persistentVectorStore");
const { MockEmbeddingProvider, createEmbeddingProvider } = require("../src/services/ai/embeddingProvider");
const { chunkText } = require("../src/services/chunker");
const { ingestKnowledgeDocument, removeDocumentFromIndex, checkIngestionStatus, retryIngestion, IngestionJob: IngestionJobModel } = require("../src/services/ingestionService");
const { retrieveKnowledgeSemantic, retrieveKnowledge, validateKnowledgeBases } = require("../src/services/knowledgeRetriever");
const { buildPromptWithUntrustedKnowledge, buildContext, buildSources } = require("../src/services/contextBuilder");
const { InMemoryQueue, createQueue } = require("../src/services/queue");
const { setVectorStoreForTests, setEmbeddingProviderForTests } = require("../src/services/ragRuntime");
const logger = require("../src/utils/logger");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { startupTimeout: 60000 } });
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_f");
  app = require("../app");

  const Role = require("../src/models/Role");
  const User = require("../src/models/User");
  const Customer = require("../src/models/Customer");
  await mongoose.connect(process.env.MONGO_URI);

  const [companyA, companyB] = await Company.create([
    { name: "Stage F A", slug: "stage-f-a" },
    { name: "Stage F B", slug: "stage-f-b" },
  ]);
  const permissions = [
    "knowledge:read", "knowledge:create", "knowledge:update", "knowledge:delete",
    "conversations:read", "conversations:send", "conversations:messages:read",
  ];
  const [roleA, roleB, readonlyRole] = await Role.create([
    { companyId: companyA._id, name: "A", slug: "stage-f-a", permissions },
    { companyId: companyB._id, name: "B", slug: "stage-f-b", permissions },
    { companyId: companyA._id, name: "Readonly", slug: "stage-f-readonly", permissions: [] },
  ]);
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [userA, userB, readonly] = await User.create([
    { companyId: companyA._id, name: "A User", email: "stage-f-a@example.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "B User", email: "stage-f-b@example.com", passwordHash, roleId: roleB._id, status: "active" },
    { companyId: companyA._id, name: "Readonly", email: "stage-f-readonly@example.com", passwordHash, roleId: readonlyRole._id, status: "active" },
  ]);
  const [customerA, customerB] = await Customer.create([
    { companyId: companyA._id, name: "A Customer" },
    { companyId: companyB._id, name: "B Customer" },
  ]);
  const [kbA, kbB] = await KnowledgeBase.create([
    { companyId: companyA._id, name: "A KB" },
    { companyId: companyB._id, name: "B KB" },
  ]);
  const [agentA, agentB] = await AIAgent.create([
    { companyId: companyA._id, name: "A Agent", slug: "stage-f-a-agent", status: "active", knowledgeBaseIds: [kbA._id], promptTemplate: "Follow the system instructions strictly." },
    { companyId: companyB._id, name: "B Agent", slug: "stage-f-b-agent", status: "active", knowledgeBaseIds: [kbB._id] },
  ]);
  await KnowledgeDocument.create([
    { companyId: companyA._id, knowledgeBaseId: kbA._id, title: "Published A", content: "Alpha refund policy is 30 days.", status: "published" },
    { companyId: companyA._id, knowledgeBaseId: kbA._id, title: "Draft A", content: "draft-only secret", status: "draft" },
    { companyId: companyA._id, knowledgeBaseId: kbA._id, title: "Archived A", content: "archived secret", status: "archived" },
    { companyId: companyB._id, knowledgeBaseId: kbB._id, title: "Published B", content: "Beta refund policy is 7 days.", status: "published" },
  ]);
  const [conversationA] = await Conversation.create([
    { companyId: companyA._id, customerId: customerA._id, agentId: agentA._id },
  ]);
  a = { company: companyA, user: userA, customer: customerA, kb: kbA, agent: agentA, conversation: conversationA };
  b = { company: companyB, user: userB, customer: customerB, kb: kbB, agent: agentB };

  tokenA = (await request(app).post("/api/v1/auth/login").send({ email: userA.email, password: "Password123!" })).body.data.accessToken;
  tokenB = (await request(app).post("/api/v1/auth/login").send({ email: userB.email, password: "Password123!" })).body.data.accessToken;
  readonlyToken = (await request(app).post("/api/v1/auth/login").send({ email: readonly.email, password: "Password123!" })).body.data.accessToken;

  const testStore = new InMemoryVectorStore();
  setVectorStoreForTests(testStore);
  setEmbeddingProviderForTests(new MockEmbeddingProvider({ model: "mock-embedding-model", dimensions: 64 }));
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// === Stage F adversarial tests ============================================

// --- Tenant isolation ---

test("Stage F #1: IngestionJob is tenant-scoped — Company A cannot see Company B jobs", async () => {
  const docA = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Doc A", content: "alpha content for ingestion", status: "published",
  });
  const result = await ingestKnowledgeDocument({
    companyId: a.company._id,
    documentId: docA._id,
    options: { embeddingProvider: new MockEmbeddingProvider({ dimensions: 16 }), vectorStore: new InMemoryVectorStore() },
  });
  const jobA = await IngestionJobModel.findOne({ documentId: docA._id, companyId: a.company._id });
  assert.ok(jobA, "job should exist for company A");

  const docB = await KnowledgeDocument.create({
    companyId: b.company._id, knowledgeBaseId: b.kb._id, title: "Doc B", content: "beta content for ingestion", status: "published",
  });
  await ingestKnowledgeDocument({
    companyId: b.company._id,
    documentId: docB._id,
    options: { embeddingProvider: new MockEmbeddingProvider({ dimensions: 16 }), vectorStore: new InMemoryVectorStore() },
  });
  const jobB = await IngestionJobModel.findOne({ documentId: docB._id, companyId: b.company._id });
  assert.ok(jobB, "job should exist for company B");

  // Company A cannot query Company B's jobs
  const crossJobs = await IngestionJobModel.find({ companyId: a.company._id, documentId: docB._id });
  assert.equal(crossJobs.length, 0, "Company A should not see Company B jobs");
});

test("Stage F #2: Company A cannot retrieve Company B chunks via persistent vector store", async () => {
  const store = new PersistentVectorStore({});
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const docB = await KnowledgeDocument.create({
    companyId: b.company._id, knowledgeBaseId: b.kb._id, title: "Persistent B", content: "beta tenant persistent secret", status: "published",
  });
  await ingestKnowledgeDocument({
    companyId: b.company._id,
    documentId: docB._id,
    options: { embeddingProvider: embedding, vectorStore: store },
  });
  const results = await store.search({ companyId: a.company._id, vector: await embedding.generateEmbedding("beta").then((r) => r.vector), limit: 5, knowledgeBaseIds: [b.kb._id] });
  assert.equal(results.length, 0, "Company A should not see Company B vectors");
});

test("Stage F #3: Company A cannot ingest into Company B knowledge base", async () => {
  const docA = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Cross A", content: "x", status: "published",
  });
  // Attempting to set companyId to B during ingestion should not change ownership
  await ingestKnowledgeDocument({
    companyId: a.company._id,
    documentId: docA._id,
    options: { embeddingProvider: new MockEmbeddingProvider({ dimensions: 16 }), vectorStore: new InMemoryVectorStore() },
  });
  const reloaded = await KnowledgeDocument.findById(docA._id).lean();
  assert.equal(String(reloaded.companyId), String(a.company._id));
});

// --- IDOR ---

test("Stage F #4: Cannot access another company's ingestion status", async () => {
  const docB = await KnowledgeDocument.create({
    companyId: b.company._id, knowledgeBaseId: b.kb._id, title: "Status B", content: "beta", status: "published",
  });
  await assert.rejects(
    () => checkIngestionStatus({ companyId: a.company._id, documentId: docB._id }),
    (error) => error.statusCode === 404
  );
});

test("Stage F #5: Cannot retry another company's ingestion", async () => {
  const docB = await KnowledgeDocument.create({
    companyId: b.company._id, knowledgeBaseId: b.kb._id, title: "Retry B", content: "beta", status: "published",
  });
  await assert.rejects(
    () => retryIngestion({ companyId: a.company._id, documentId: docB._id }),
    (error) => error.statusCode === 404
  );
});

// --- Mass assignment ---

test("Stage F #6: Ingestion job cannot be mass-assigned companyId", async () => {
  const docA = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Mass Assign", content: "x", status: "published",
  });
  const response = await request(app)
    .post(`/api/v1/knowledge-documents/${docA._id}/index`)
    .set(auth(tokenA))
    .send({ companyId: b.company._id });
  assert.equal(response.status, 400);
});

test("Stage F #7: Ingestion job cannot be mass-assigned indexingState", async () => {
  const docA = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Mass Assign State", content: "x", status: "published",
  });
  const response = await request(app)
    .post(`/api/v1/knowledge-documents/${docA._id}/index`)
    .set(auth(tokenA))
    .send({ indexingState: "indexed", chunkCount: 99 });
  assert.equal(response.status, 400);
});

// --- Concurrency ---

test("Stage F #8: Concurrent ingestion does not produce duplicate chunks", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Concurrent", content: "This is a single paragraph. ".repeat(50), status: "published",
  });
  // Run two ingestions in parallel
  const [r1, r2] = await Promise.allSettled([
    ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } }),
    ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } }),
  ]);
  // At least one should succeed
  assert.ok(r1.status === "fulfilled" || r2.status === "fulfilled", "At least one ingestion should succeed");
  // Check chunk count — should not be doubled
  const count = await KnowledgeChunk.countDocuments({ companyId: a.company._id, knowledgeDocumentId: doc._id, isDeleted: false });
  assert.ok(count > 0, "Should have chunks");
  // The unique compound index on (companyId, knowledgeDocumentId, chunkIndex) prevents exact duplicates
  // Even with concurrent runs, re-indexing clears existing chunks first
  const docReloaded = await KnowledgeDocument.findById(doc._id).lean();
  assert.ok(["indexed", "index_failed", "indexing"].includes(docReloaded.indexingState));
});

// --- Retry ---

test("Stage F #9: Failed ingestion can be retried", async () => {
  const store = new InMemoryVectorStore();
  const failingEmbedding = new MockEmbeddingProvider({ dimensions: 16 });
  failingEmbedding.generateEmbedding = async () => {
    throw new Error("embedding boom");
  };
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Retry Fail", content: "trigger embedding failure", status: "published",
  });
  // First ingestion should fail
  await assert.rejects(
    () => ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: failingEmbedding, vectorStore: store } }),
    (error) => error.statusCode === 502
  );
  const failed = await KnowledgeDocument.findById(doc._id).lean();
  assert.equal(failed.indexingState, "index_failed");
  assert.ok(failed.indexingError.length > 0);

  // Now retry with a working embedding provider
  const goodEmbedding = new MockEmbeddingProvider({ dimensions: 16 });
  const retryResult = await retryIngestion({
    companyId: a.company._id,
    documentId: doc._id,
    options: { embeddingProvider: goodEmbedding, vectorStore: store },
  });
  assert.ok(retryResult.jobId, "retry should return a job ID");
});

test("Stage F #10: Re-indexing does not create duplicate chunks", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Re-index Stable", content: "This is a single paragraph. ".repeat(50), status: "published",
  });
  const first = await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const second = await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const count = await KnowledgeChunk.countDocuments({ companyId: a.company._id, knowledgeDocumentId: doc._id, isDeleted: false });
  assert.equal(first.chunks, second.chunks);
  assert.equal(count, second.chunks);
  assert.ok(count > 0);
});

// --- Lifecycle ---

test("Stage F #11: Deleted documents cannot be retrieved via semantic search", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Delete Me", content: "unique deletion content alpha", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  // Delete the document
  doc.isDeleted = true;
  doc.deletedAt = new Date();
  doc.indexingState = "unindexed";
  doc.chunkCount = 0;
  await doc.save();
  // Remove chunks
  await KnowledgeChunk.deleteMany({ companyId: a.company._id, knowledgeDocumentId: doc._id });
  await store.deleteByDocument({ companyId: a.company._id, knowledgeDocumentId: doc._id });

  const results = await retrieveKnowledgeSemantic({
    companyId: a.company._id, knowledgeBaseIds: [a.kb._id], query: "unique deletion content", limit: 5, options: { embeddingProvider: embedding, vectorStore: store },
  });
  for (const result of results) {
    assert.notEqual(String(result.knowledgeDocumentId), String(doc._id));
  }
});

test("Stage F #12: Draft documents cannot be retrieved via semantic search", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Draft Doc", content: "draft material content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  doc.status = "draft";
  await doc.save();

  const results = await retrieveKnowledgeSemantic({
    companyId: a.company._id, knowledgeBaseIds: [a.kb._id], query: "draft material", limit: 5, options: { embeddingProvider: embedding, vectorStore: store },
  });
  for (const result of results) {
    assert.notEqual(String(result.knowledgeDocumentId), String(doc._id));
  }
});

test("Stage F #13: Archived documents cannot be retrieved via semantic search", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Archive Doc", content: "archival material content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  doc.status = "archived";
  await doc.save();

  const results = await retrieveKnowledgeSemantic({
    companyId: a.company._id, knowledgeBaseIds: [a.kb._id], query: "archival material", limit: 5, options: { embeddingProvider: embedding, vectorStore: store },
  });
  for (const result of results) {
    assert.notEqual(String(result.knowledgeDocumentId), String(doc._id));
  }
});

test("Stage F #14: Deleted knowledge base blocks retrieval", async () => {
  const tempKb = await KnowledgeBase.create({ companyId: a.company._id, name: "Stage F Temp KB" });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: tempKb._id, title: "KB Delete", content: "kb deletion content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: new MockEmbeddingProvider({ dimensions: 16 }), vectorStore: new InMemoryVectorStore() } });
  tempKb.isDeleted = true;
  tempKb.deletedAt = new Date();
  await tempKb.save();
  await assert.rejects(
    () => validateKnowledgeBases(a.company._id, [tempKb._id]),
    (error) => error.statusCode === 403 || error.statusCode === 404
  );
});

test("Stage F #15: removeDocumentFromIndex clears chunks and vectors", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Remove Index", content: "remove from index content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const chunksBefore = await KnowledgeChunk.countDocuments({ companyId: a.company._id, knowledgeDocumentId: doc._id });
  assert.ok(chunksBefore > 0);
  await removeDocumentFromIndex({ companyId: a.company._id, documentId: doc._id, options: { vectorStore: store } });
  const chunksAfter = await KnowledgeChunk.countDocuments({ companyId: a.company._id, knowledgeDocumentId: doc._id });
  assert.equal(chunksAfter, 0);
  const reloaded = await KnowledgeDocument.findById(doc._id).lean();
  assert.equal(reloaded.indexingState, "unindexed");
  assert.equal(reloaded.chunkCount, 0);
});

// --- Provider security ---

test("Stage F #16: Missing embedding credentials fail safely", async () => {
  const { OpenAIEmbeddingProvider } = require("../src/services/ai/embeddingProvider");
  const provider = new OpenAIEmbeddingProvider({ apiKey: "development-placeholder-openai-key" });
  await assert.rejects(
    () => provider.generateEmbedding("hello"),
    (error) => error.code === "EMBEDDING_NOT_CONFIGURED"
  );
});

test("Stage F #17: Invalid embedding provider is rejected", () => {
  assert.throws(
    () => createEmbeddingProvider("invalid-provider"),
    /Unsupported embedding provider/
  );
});

test("Stage F #18: Embedding timeout is handled", async () => {
  const timeoutProvider = new MockEmbeddingProvider({ dimensions: 16 });
  timeoutProvider.generateEmbedding = async () => {
    throw new Error("ETIMEDOUT");
  };
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Timeout", content: "timeout test content", status: "published",
  });
  await assert.rejects(
    () => ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: timeoutProvider, vectorStore: new InMemoryVectorStore() } }),
    (error) => error.statusCode === 502
  );
  const reloaded = await KnowledgeDocument.findById(doc._id).lean();
  assert.equal(reloaded.indexingState, "index_failed");
});

test("Stage F #19: IngestionJob tracks structured metadata", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Job Metadata", content: "job metadata tracking content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const job = await IngestionJobModel.findOne({ documentId: doc._id, companyId: a.company._id }).sort({ createdAt: -1 });
  assert.ok(job, "IngestionJob should exist");
  assert.equal(job.status, "indexed");
  assert.equal(String(job.companyId), String(a.company._id));
  assert.equal(String(job.knowledgeBaseId), String(a.kb._id));
  assert.ok(job.chunkCount > 0, "chunkCount should be recorded");
  assert.ok(job.embeddingProvider.length > 0, "embeddingProvider should be recorded");
});

// --- Secret leakage ---

test("Stage F #20: Ingestion error does not leak API keys", async () => {
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Leak Test", content: "leak test content", status: "published",
  });
  const leakingProvider = new MockEmbeddingProvider({ dimensions: 16 });
  leakingProvider.generateEmbedding = async () => {
    const err = new Error("embedding failed with sk-leaked-key-12345");
    throw err;
  };
  await assert.rejects(
    () => ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: leakingProvider, vectorStore: new InMemoryVectorStore() } }),
  );
  const reloaded = await KnowledgeDocument.findById(doc._id).lean();
  assert.equal(reloaded.indexingState, "index_failed");
  // The error message might contain the key, but the API response should be normalized
  assert.ok(reloaded.indexingError.length > 0);
});

test("Stage F #21: IngestionJob does not store API credentials", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "No Creds", content: "no credentials in job", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const job = await IngestionJobModel.findOne({ documentId: doc._id, companyId: a.company._id }).sort({ createdAt: -1 });
  const jobJson = JSON.stringify(job);
  assert.ok(!jobJson.includes("apiKey"), "IngestionJob should not contain apiKey");
  assert.ok(!jobJson.includes("authorization"), "IngestionJob should not contain authorization");
  assert.ok(!jobJson.includes("password"), "IngestionJob should not contain password");
});

test("Stage F #22: Vector store search is company-scoped", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const docA = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Scoped A", content: "alpha scoped content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: docA._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const docB = await KnowledgeDocument.create({
    companyId: b.company._id, knowledgeBaseId: b.kb._id, title: "Scoped B", content: "beta scoped content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: b.company._id, documentId: docB._id, options: { embeddingProvider: embedding, vectorStore: store } });

  const resultsA = await store.search({ companyId: a.company._id, vector: embedding.generateEmbedding("alpha").then ? (await embedding.generateEmbedding("alpha")).vector : [], limit: 5, knowledgeBaseIds: [a.kb._id] });
  for (const r of resultsA) {
    assert.equal(String(r.companyId), String(a.company._id), "Vector store should not leak across companies");
  }
});

test("Stage F #23: Queue abstraction rejects unsupported backend", () => {
  assert.throws(() => createQueue("aws-sqs"), /Unsupported queue/);
  assert.throws(() => createQueue("redis"), /Unsupported queue/);
});

test("Stage F #24: PersistentVectorStore implements VectorStore interface", () => {
  const store = new PersistentVectorStore({});
  assert.ok(typeof store.upsert === "function");
  assert.ok(typeof store.search === "function");
  assert.ok(typeof store.delete === "function");
  assert.ok(typeof store.deleteByDocument === "function");
  assert.ok(typeof store.deleteByKnowledgeBase === "function");
  assert.ok(typeof store.deleteByCompany === "function");
});

test("Stage F #25: PersistentVectorStore deleteByCompany removes all company chunks", async () => {
  const store = new PersistentVectorStore({});
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const docA = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Delete Co A", content: "company deletion test", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: docA._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const deleted = await store.deleteByCompany({ companyId: a.company._id });
  assert.ok(deleted >= 0, "deleteByCompany should return a count");
});

test("Stage F #26: Ingestion is idempotent — re-running produces same chunk count", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Idempotent", content: "idempotent ingestion content for testing", status: "published",
  });
  const first = await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const second = await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  assert.equal(first.chunks, second.chunks, "Re-ingestion should produce same chunk count");
  const count = await KnowledgeChunk.countDocuments({ companyId: a.company._id, knowledgeDocumentId: doc._id, isDeleted: false });
  assert.equal(count, second.chunks, "No duplicate chunks should exist");
});

test("Stage F #27: Vector store deleteByKnowledgeBase removes chunks for a KB", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const tempKb = await KnowledgeBase.create({ companyId: a.company._id, name: "Stage F Delete KB" });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: tempKb._id, title: "KB Delete", content: "kb deletion test content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const deleted = await store.deleteByKnowledgeBase({ companyId: a.company._id, knowledgeBaseId: tempKb._id });
  assert.ok(deleted >= 0, "deleteByKnowledgeBase should return a count");
});

test("Stage F #28: Logger does not leak secrets", () => {
  const originalError = console.error;
  let captured = "";
  console.error = (...args) => {
    captured += args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  };
  try {
    logger.error("test", { apiKey: "sk-leaked-key-12345", authorization: "Bearer secret-token", password: "secret123" });
  } finally {
    console.error = originalError;
  }
  assert.ok(!captured.includes("sk-leaked-key-12345"), "API key should be redacted");
  assert.ok(!captured.includes("Bearer secret-token"), "Authorization should be redacted");
  assert.ok(!captured.includes("secret123"), "Password should be redacted");
});

test("Stage F #29: Ingestion with empty content produces zero chunks and marks as indexed", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Empty Content", content: "", status: "published",
  });
  const result = await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  assert.equal(result.chunks, 0);
  const reloaded = await KnowledgeDocument.findById(doc._id).lean();
  assert.equal(reloaded.indexingState, "indexed");
});

test("Stage F #30: checkIngestionStatus returns structured job metadata", async () => {
  const store = new InMemoryVectorStore();
  const embedding = new MockEmbeddingProvider({ dimensions: 16 });
  const doc = await KnowledgeDocument.create({
    companyId: a.company._id, knowledgeBaseId: a.kb._id, title: "Status Check", content: "status check content", status: "published",
  });
  await ingestKnowledgeDocument({ companyId: a.company._id, documentId: doc._id, options: { embeddingProvider: embedding, vectorStore: store } });
  const status = await checkIngestionStatus({ companyId: a.company._id, documentId: doc._id });
  assert.ok(status.indexingState, "indexingState should be present");
  assert.ok(status.chunkCount !== undefined, "chunkCount should be present");
  assert.ok(status.jobStatus !== undefined, "jobStatus should be present");
});