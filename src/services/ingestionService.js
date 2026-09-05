const crypto = require("crypto");
const KnowledgeDocument = require("../models/KnowledgeDocument");
const KnowledgeBase = require("../models/KnowledgeBase");
const KnowledgeChunk = require("../models/KnowledgeChunk");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const { chunkText } = require("./chunker");
const { createEmbeddingProvider } = require("./ai/embeddingProvider");
const ragRuntime = require("./ragRuntime");
const config = require("../config/config");

function hashContent(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function ensureKnowledgeBaseForCompany({ companyId, knowledgeBaseId }) {
  validateObjectId(knowledgeBaseId, "knowledgeBaseId");
  const base = await KnowledgeBase.findOne({ _id: knowledgeBaseId, companyId, isDeleted: false });
  if (!base) throw new AppError(403, "Knowledge base not found or does not belong to your company.");
  return base;
}

async function ensureDocumentForCompany({ companyId, documentId, knowledgeBaseId }) {
  validateObjectId(documentId, "documentId");
  const document = await KnowledgeDocument.findOne({
    _id: documentId,
    companyId,
    knowledgeBaseId,
    isDeleted: false,
  });
  if (!document) throw new AppError(404, "Knowledge document not found.");
  return document;
}

function buildEmbeddingProvider(options = {}) {
  return options.embeddingProvider || createEmbeddingProvider(
    options.embeddingProviderName || config.AI_EMBEDDING_PROVIDER,
    {
      apiKey: options.embeddingApiKey,
      model: options.embeddingModel || config.AI_DEFAULT_EMBEDDING_MODEL,
      dimensions: options.embeddingDimensions || config.AI_DEFAULT_EMBEDDING_DIMENSIONS,
      timeoutMs: options.embeddingTimeoutMs || config.AI_PROVIDER_TIMEOUT_MS,
    }
  );
}

function getVectorStore(options = {}) {
  if (options.vectorStore) return options.vectorStore;
  return ragRuntime.getVectorStore();
}

async function clearExistingChunks({ companyId, knowledgeDocumentId, vectorStore }) {
  await KnowledgeChunk.deleteMany({ companyId, knowledgeDocumentId });
  if (vectorStore) {
    try {
      await vectorStore.deleteByDocument({ companyId, knowledgeDocumentId });
    } catch (error) {
      // continue: vector store will diverge from DB state but ingestion will not silently succeed
    }
  }
}

async function ingestKnowledgeDocument({ companyId, documentId, options = {} } = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  validateObjectId(documentId, "documentId");
  const document = await KnowledgeDocument.findOne({ _id: documentId, companyId, isDeleted: false });
  if (!document) throw new AppError(404, "Knowledge document not found.");
  const knowledgeBase = await ensureKnowledgeBaseForCompany({ companyId, knowledgeBaseId: document.knowledgeBaseId });
  const vectorStore = getVectorStore(options);
  const embeddingProvider = buildEmbeddingProvider(options);

  document.indexingState = "indexing";
  document.indexingError = "";
  await document.save();

  let chunks;
  let totalEmbeddingUsage = { inputTokens: 0, totalTokens: 0 };
  let embeddingMetadata = { provider: embeddingProvider.provider, model: embeddingProvider.model, dimensions: 0 };
  let vectorIds = [];

  try {
    chunks = chunkText(document.content || document.summary || "", {
      size: options.chunkSize || config.CHUNK_SIZE_CHARS,
      overlap: options.chunkOverlap || config.CHUNK_OVERLAP_CHARS,
      max: options.chunkMax || config.CHUNK_MAX_CHARS,
    });
    if (!chunks.length) {
      await clearExistingChunks({ companyId, knowledgeDocumentId: document._id, vectorStore });
      document.indexingState = "indexed";
      document.indexingError = "";
      document.lastIndexedAt = new Date();
      document.chunkCount = 0;
      await document.save();
      return { document, chunks: 0, vectorIds: [] };
    }

    await clearExistingChunks({ companyId, knowledgeDocumentId: document._id, vectorStore });

    const records = [];
    for (const chunk of chunks) {
      const contentHash = hashContent(chunk.content);
      const persisted = await KnowledgeChunk.create({
        companyId,
        knowledgeBaseId: knowledgeBase._id,
        knowledgeDocumentId: document._id,
        chunkIndex: chunk.index,
        content: chunk.content,
        contentHash,
        metadata: { start: chunk.start, end: chunk.end, length: chunk.content.length },
        embeddingProvider: embeddingProvider.provider,
        embeddingModel: embeddingProvider.model,
        embeddingDimensions: embeddingProvider.dimensions,
        embeddingUsage: {},
        vectorStoreId: "",
        isDeleted: false,
        deletedAt: null,
      });
      let embedding;
      try {
        embedding = await embeddingProvider.generateEmbedding(persisted.content);
      } catch (error) {
        await KnowledgeChunk.deleteOne({ _id: persisted._id, companyId });
        throw new AppError(502, "Embedding generation failed during ingestion.");
      }
      persisted.embeddingDimensions = embedding.dimensions;
      persisted.embeddingUsage = embedding.usage || {};
      await persisted.save();
      totalEmbeddingUsage.inputTokens += Number(embedding.usage?.inputTokens || 0);
      totalEmbeddingUsage.totalTokens += Number(embedding.usage?.totalTokens || 0);
      embeddingMetadata.dimensions = embedding.dimensions;
      records.push({
        companyId,
        knowledgeBaseId: knowledgeBase._id,
        knowledgeDocumentId: document._id,
        chunkId: persisted._id,
        vector: embedding.vector,
      });
    }

    vectorIds = await vectorStore.upsert(records);
    for (let i = 0; i < records.length; i += 1) {
      const persisted = await KnowledgeChunk.findOne({ _id: records[i].chunkId, companyId });
      if (persisted) {
        persisted.vectorStoreId = vectorIds[i];
        await persisted.save();
      }
    }

    document.indexingState = "indexed";
    document.indexingError = "";
    document.lastIndexedAt = new Date();
    document.chunkCount = chunks.length;
    await document.save();

    return {
      document,
      chunks: chunks.length,
      vectorIds,
      embeddingMetadata,
      embeddingUsage: totalEmbeddingUsage,
    };
  } catch (error) {
    document.indexingState = "index_failed";
    document.indexingError = String(error && error.message ? error.message : "indexing failed").slice(0, 500);
    document.lastIndexedAt = new Date();
    await document.save();
    if (error instanceof AppError) throw error;
    throw new AppError(502, "Knowledge ingestion failed.");
  }
}

async function removeDocumentFromIndex({ companyId, documentId, options = {} } = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  validateObjectId(documentId, "documentId");
  const document = await ensureDocumentForCompany({ companyId, documentId, knowledgeBaseId: options.knowledgeBaseId });
  const vectorStore = options.vectorStore;
  if (vectorStore) {
    try { await vectorStore.deleteByDocument({ companyId, knowledgeDocumentId: document._id }); } catch (error) { /* tolerate */ }
  }
  await KnowledgeChunk.deleteMany({ companyId, knowledgeDocumentId: document._id });
  document.indexingState = "unindexed";
  document.indexingError = "";
  document.lastIndexedAt = new Date();
  document.chunkCount = 0;
  await document.save();
  return document;
}

module.exports = {
  ingestKnowledgeDocument,
  removeDocumentFromIndex,
};
