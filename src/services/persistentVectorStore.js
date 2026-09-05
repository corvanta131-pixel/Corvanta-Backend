const { VectorStore } = require("./vectorStore");
const KnowledgeChunk = require("../models/KnowledgeChunk");
const AppError = require("../utils/AppError");
const config = require("../config/config");

class PersistentVectorStore extends VectorStore {
  constructor(options = {}) {
    super();
    this.name = options.name || "persistent-mongodb";
    this.model = options.model || null;
    this.dimensions = Number(options.dimensions || config.AI_DEFAULT_EMBEDDING_DIMENSIONS || 1536);
  }

  async upsert(records = []) {
    if (!records.length) return [];
    const docs = records.map((record) => ({
      companyId: record.companyId,
      knowledgeBaseId: record.knowledgeBaseId,
      knowledgeDocumentId: record.knowledgeDocumentId,
      chunkId: record.chunkId,
      vector: record.vector,
      dimensions: record.vector ? record.vector.length : this.dimensions,
      embeddingProvider: record.embeddingProvider || "",
      embeddingModel: record.embeddingModel || "",
    }));
    const result = await KnowledgeChunk.insertMany(docs, { ordered: false });
    return result.map((doc) => doc._id.toString());
  }

  async search({ companyId, vector, limit = 5, minScore = 0, knowledgeBaseIds = [] } = {}) {
    if (!companyId) throw new AppError(403, "Missing company context.");
    if (!Array.isArray(vector) || !vector.length) return [];

    const query = {
      companyId,
      isDeleted: false,
    };

    if (knowledgeBaseIds && knowledgeBaseIds.length) {
      query.knowledgeBaseId = { $in: knowledgeBaseIds.map(String) };
    }

    // For MongoDB-based persistent store, we use a deterministic distance metric
    // since MongoDB doesn't support native vector search without additional plugins.
    // This is a persistent adapter, not a production vector database.
    const chunks = await KnowledgeChunk.find(query)
      .select("_id knowledgeBaseId knowledgeDocumentId chunkIndex content metadata vector dimensions embeddingProvider embeddingModel")
      .lean();

    const results = [];
    for (const chunk of chunks) {
      if (!chunk.vector || !Array.isArray(chunk.vector) || !chunk.vector.length) continue;
      const score = cosineSimilarity(vector, chunk.vector);
      if (score >= minScore) {
        results.push({
          id: chunk._id.toString(),
          chunkId: chunk._id.toString(),
          knowledgeBaseId: chunk.knowledgeBaseId,
          knowledgeDocumentId: chunk.knowledgeDocumentId,
          companyId: chunk.companyId,
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(0, Number(limit) || 0));
  }

  async delete(id) {
    if (!id) return false;
    const result = await KnowledgeChunk.updateOne(
      { _id: id },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  async deleteByDocument({ companyId, knowledgeDocumentId } = {}) {
    if (!companyId || !knowledgeDocumentId) return 0;
    const result = await KnowledgeChunk.updateMany(
      { companyId, knowledgeDocumentId: String(knowledgeDocumentId), isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  async deleteByKnowledgeBase({ companyId, knowledgeBaseId } = {}) {
    if (!companyId || !knowledgeBaseId) return 0;
    const result = await KnowledgeChunk.updateMany(
      { companyId, knowledgeBaseId: String(knowledgeBaseId), isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  async deleteByCompany({ companyId } = {}) {
    if (!companyId) return 0;
    const result = await KnowledgeChunk.updateMany(
      { companyId, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  async health() {
    try {
      const count = await KnowledgeChunk.countDocuments({ isDeleted: false });
      return { status: "healthy", type: this.name, indexedChunks: count };
    } catch (error) {
      return { status: "unhealthy", type: this.name, error: error.message };
    }
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  const length = a.length;
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  if (!normA || !normB) return 0;
  return dot / (normA * normB);
}

function createPersistentVectorStore(name = "persistent-mongodb", options = {}) {
  const normalized = String(name || "persistent-mongodb").toLowerCase();
  if (normalized === "persistent-mongodb" || normalized === "persistent" || normalized === "") {
    return new PersistentVectorStore(options);
  }
  throw new Error(`Unsupported persistent vector store: ${name}`);
}

module.exports = { PersistentVectorStore, createPersistentVectorStore, cosineSimilarity };