const crypto = require("crypto");
const { computeDeterministicVector, normalizeVector } = require("./ai/embeddingProvider");

class VectorStore {
  async upsert() { throw new Error("VectorStore.upsert not implemented"); }
  async search() { throw new Error("VectorStore.search not implemented"); }
  async delete() { throw new Error("VectorStore.delete not implemented"); }
  async deleteByDocument() { throw new Error("VectorStore.deleteByDocument not implemented"); }
  async deleteByKnowledgeBase() { throw new Error("VectorStore.deleteByKnowledgeBase not implemented"); }
  async deleteByCompany() { throw new Error("VectorStore.deleteByCompany not implemented"); }
}

class InMemoryVectorStore extends VectorStore {
  constructor(options = {}) {
    super();
    this.name = options.name || "in-memory";
    this.shouldFailNext = Boolean(options.shouldFailNext);
  }

  _id(companyId, knowledgeBaseId, documentId, chunkId) {
    return crypto
      .createHash("sha256")
      .update(`${companyId}:${knowledgeBaseId}:${documentId}:${chunkId}`)
      .digest("hex")
      .slice(0, 32);
  }

  async upsert(records = []) {
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error("In-memory vector store simulated failure.");
    }
    const out = [];
    for (const record of records) {
      if (!record || !record.companyId || !record.knowledgeDocumentId || !record.chunkId) {
        throw new Error("Vector record requires companyId, knowledgeDocumentId, chunkId.");
      }
      const id = this._id(record.companyId, record.knowledgeBaseId, record.knowledgeDocumentId, record.chunkId);
      const vector = normalizeVector(Array.isArray(record.vector) ? record.vector.map(Number) : []);
      const stored = {
        id,
        companyId: String(record.companyId),
        knowledgeBaseId: String(record.knowledgeBaseId),
        knowledgeDocumentId: String(record.knowledgeDocumentId),
        chunkId: String(record.chunkId),
        vector,
      };
      this[id] = stored;
      out.push(id);
    }
    return out;
  }

  async search({ companyId, vector, limit = 5, minScore = 0, knowledgeBaseIds = [] } = {}) {
    if (!companyId) throw new Error("companyId is required for vector search.");
    if (!Array.isArray(vector) || !vector.length) return [];
    const normalizedQuery = normalizeVector(vector.map(Number));
    const allowed = new Set((knowledgeBaseIds || []).map(String));
    const results = [];
    for (const stored of Object.values(this)) {
      if (stored.companyId !== String(companyId)) continue;
      if (allowed.size && !allowed.has(stored.knowledgeBaseId)) continue;
      const score = cosineSimilarity(normalizedQuery, stored.vector);
      if (score >= minScore) {
        results.push({
          id: stored.id,
          chunkId: stored.chunkId,
          knowledgeBaseId: stored.knowledgeBaseId,
          knowledgeDocumentId: stored.knowledgeDocumentId,
          companyId: stored.companyId,
          score,
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(0, Number(limit) || 0));
  }

  async delete(id) {
    if (id && this[id]) {
      delete this[id];
      return true;
    }
    return false;
  }

  async deleteByDocument({ companyId, knowledgeDocumentId } = {}) {
    if (!companyId || !knowledgeDocumentId) return 0;
    let count = 0;
    for (const id of Object.keys(this)) {
      const stored = this[id];
      if (stored.companyId === String(companyId) && stored.knowledgeDocumentId === String(knowledgeDocumentId)) {
        delete this[id];
        count += 1;
      }
    }
    return count;
  }

  async deleteByKnowledgeBase({ companyId, knowledgeBaseId } = {}) {
    if (!companyId || !knowledgeBaseId) return 0;
    let count = 0;
    for (const id of Object.keys(this)) {
      const stored = this[id];
      if (stored.companyId === String(companyId) && stored.knowledgeBaseId === String(knowledgeBaseId)) {
        delete this[id];
        count += 1;
      }
    }
    return count;
  }

  async deleteByCompany({ companyId } = {}) {
    if (!companyId) return 0;
    let count = 0;
    for (const id of Object.keys(this)) {
      const stored = this[id];
      if (stored.companyId === String(companyId)) {
        delete this[id];
        count += 1;
      }
    }
    return count;
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

function createVectorStore(name = "memory", options = {}) {
  const normalized = String(name || "memory").toLowerCase();
  if (normalized === "memory" || normalized === "in-memory" || normalized === "") {
    return new InMemoryVectorStore(options);
  }
  if (normalized === "pinecone") {
    const { createPineconeVectorStore } = require("./providers/pineconeVectorStore");
    return createPineconeVectorStore("pinecone", options);
  }
  throw new Error(`Unsupported vector store: ${name}`);
}

module.exports = { VectorStore, InMemoryVectorStore, createVectorStore, computeDeterministicVector };
