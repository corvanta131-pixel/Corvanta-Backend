process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/corvanta-test";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "test-access-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const src = path.join(__dirname, "..", "src");
const COMPANY = "64d3a8f2c54f4020a959c9aa";
const KB = "64d3a8f2c54f4020a959c9b1";
const DOC = "64d3a8f2c54f4020a959c9c1";

function stub(rel, exports) {
  const resolved = require.resolve(path.join(src, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const seen = { chunkDeletes: [], searchArgs: [], kbCounts: [] };
const state = { doc: null };

stub("models/KnowledgeDocument.js", { findOne: async () => state.doc });
stub("models/KnowledgeBase.js", {
  findOne: async () => ({ _id: KB }),
  countDocuments: async (filter) => {
    seen.kbCounts.push(filter);
    return filter._id.$in.length;
  },
});
stub("models/User.js", { findOne: async () => null });
stub("models/KnowledgeChunk.js", {
  deleteMany: async (filter) => {
    seen.chunkDeletes.push(filter);
    return { deletedCount: 2 };
  },
});
stub("services/knowledgeSearchService.js", {
  searchKnowledge: async (args) => {
    seen.searchArgs.push(args);
    return [{ id: DOC, title: "Returns", content: "30 days", score: 3 }];
  },
});

const { deleteKnowledgeDocument } = require(path.join(src, "services", "knowledgeDocumentService.js"));
const controller = require(path.join(src, "controllers", "knowledgeSearchController.js"));
const { validateKnowledgeSearchInput } = require(path.join(src, "validators", "domainValidator.js"));

function runSearch(body) {
  return new Promise((resolve, reject) => {
    const req = { body, user: { companyId: COMPANY } };
    const res = {
      status() {
        return this;
      },
      json: (payload) => resolve(payload),
    };
    controller.searchKnowledgeBases(req, res, reject);
  });
}

test("deleting a document also deletes its stored chunks, scoped to the company", async () => {
  seen.chunkDeletes.length = 0;
  state.doc = {
    _id: DOC,
    companyId: COMPANY,
    isDeleted: false,
    indexingState: "indexed",
    chunkCount: 4,
    async save() {},
  };
  const result = await deleteKnowledgeDocument(COMPANY, DOC);
  assert.equal(result.isDeleted, true);
  assert.equal(result.indexingState, "unindexed");
  assert.equal(result.chunkCount, 0);
  assert.deepEqual(seen.chunkDeletes, [{ companyId: COMPANY, knowledgeDocumentId: DOC }]);
});

test("search defaults to semantic and supports keyword mode (what website chat uses)", async () => {
  seen.searchArgs.length = 0;
  await runSearch({ query: "refund", knowledgeBaseIds: [KB] });
  assert.equal(seen.searchArgs[0].options.useSemantic, true, "unchanged default");
  assert.equal(seen.searchArgs[0].companyId, COMPANY);

  await runSearch({ query: "refund", knowledgeBaseIds: [KB], mode: "keyword" });
  assert.equal(seen.searchArgs[1].options.useSemantic, false);
  assert.deepEqual(seen.searchArgs[1].knowledgeBaseIds, [KB]);
});

test("search checks knowledge bases belong to the caller's company", async () => {
  seen.kbCounts.length = 0;
  await runSearch({ query: "refund", knowledgeBaseIds: [KB], mode: "keyword" });
  assert.equal(seen.kbCounts[0].companyId, COMPANY);
  assert.equal(seen.kbCounts[0].status, "active");
});

test("search validation accepts the two modes and rejects anything else", () => {
  assert.doesNotThrow(() => validateKnowledgeSearchInput({ query: "x", mode: "keyword" }));
  assert.doesNotThrow(() => validateKnowledgeSearchInput({ query: "x", mode: "semantic" }));
  assert.doesNotThrow(() => validateKnowledgeSearchInput({ query: "x" }));
  assert.throws(() => validateKnowledgeSearchInput({ query: "x", mode: "magic" }), (e) => e.statusCode === 400);
  assert.throws(() => validateKnowledgeSearchInput({ query: "" }), (e) => e.statusCode === 400);
});
