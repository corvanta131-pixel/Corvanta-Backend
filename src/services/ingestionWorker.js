/**
 * Ingestion Worker - processes ingestion jobs from the queue.
 * Separates the ingestion pipeline from the API request lifecycle.
 */

const crypto = require("crypto");
const KnowledgeDocument = require("../models/KnowledgeDocument");
const KnowledgeBase = require("../models/KnowledgeBase");
const KnowledgeChunk = require("../models/KnowledgeChunk");
const IngestionJob = require("../models/IngestionJob");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const { chunkText } = require("./chunker");
const { createEmbeddingProvider } = require("./ai/embeddingProvider");
const ragRuntime = require("./ragRuntime");
const config = require("../config/config");
const logger = require("../utils/logger");

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
      logger.error("Vector store deleteByDocument failed during cleanup", { companyId, knowledgeDocumentId, error: error.message });
    }
  }
}

async function processIngestionJob(job) {
  const { companyId, documentId, jobId, options = {} } = job;
  const startedAt = Date.now();

  // Atomically transition document to indexing state and create job record
  const document = await KnowledgeDocument.findOneAndUpdate(
    { _id: documentId, companyId, isDeleted: false },
    { $set: { indexingState: "indexing", indexingError: "", lastIndexedAt: new Date() } },
    { new: true }
  );

  if (!document) {
    throw new AppError(404, "Knowledge document not found.");
  }

  const knowledgeBase = await ensureKnowledgeBaseForCompany({ companyId, knowledgeBaseId: document.knowledgeBaseId });
  const vectorStore = getVectorStore(options);
  const embeddingProvider = buildEmbeddingProvider(options);

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
      await KnowledgeDocument.findByIdAndUpdate(document._id, {
        $set: {
          indexingState: "indexed",
          indexingError: "",
          lastIndexedAt: new Date(),
          chunkCount: 0,
        },
      });
      await IngestionJob.findOneAndUpdate(
        { jobId },
        { $set: { status: "indexed", completedAt: new Date(), processingDurationMs: Date.now() - startedAt, chunkCount: 0, vectorCount: 0 } }
      );
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

    await KnowledgeDocument.findByIdAndUpdate(document._id, {
      $set: {
        indexingState: "indexed",
        indexingError: "",
        lastIndexedAt: new Date(),
        chunkCount: chunks.length,
      },
    });

    await IngestionJob.findOneAndUpdate(
      { jobId },
      { $set: { status: "indexed", completedAt: new Date(), processingDurationMs: Date.now() - startedAt, chunkCount: chunks.length, vectorCount: vectorIds.length, embeddingProvider: embeddingMetadata.provider, embeddingModel: embeddingMetadata.model, embeddingDimensions: embeddingMetadata.dimensions, embeddingUsage: totalEmbeddingUsage } }
    );

    logger.info("Knowledge ingestion completed", {
      jobId,
      companyId,
      documentId,
      chunks: chunks.length,
      vectors: vectorIds.length,
      durationMs: Date.now() - startedAt,
    });

    return {
      document: await KnowledgeDocument.findById(document._id),
      chunks: chunks.length,
      vectorIds,
      embeddingMetadata,
      embeddingUsage: totalEmbeddingUsage,
    };
  } catch (error) {
    await KnowledgeDocument.findByIdAndUpdate(document._id, {
      $set: {
        indexingState: "index_failed",
        indexingError: String(error && error.message ? error.message : "indexing failed").slice(0, 500),
        lastIndexedAt: new Date(),
      },
    });

    await IngestionJob.findOneAndUpdate(
      { jobId },
      { $set: { status: "index_failed", completedAt: new Date(), processingDurationMs: Date.now() - startedAt, errorCode: error.code || "INGESTION_FAILED", errorMessage: String(error && error.message ? error.message : "indexing failed").slice(0, 500) } }
    );

    logger.error("Knowledge ingestion failed", { jobId, companyId, documentId, error: error.message, durationMs: Date.now() - startedAt });

    if (error instanceof AppError) throw error;
    throw new AppError(502, "Knowledge ingestion failed.");
  }
}

async function startIngestionWorker(queue, options = {}) {
  if (!queue) throw new Error("Queue is required for ingestion worker.");
  queue.registerHandler("ingest", async (job) => {
    await processIngestionJob(job);
  });
}

module.exports = {
  processIngestionJob,
  startIngestionWorker,
  clearExistingChunks,
};