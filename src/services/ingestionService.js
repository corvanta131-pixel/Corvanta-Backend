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
const { createQueue } = require("./queue");

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
  const query = { _id: documentId, companyId, isDeleted: false };
  if (knowledgeBaseId) query.knowledgeBaseId = knowledgeBaseId;
  const document = await KnowledgeDocument.findOne(query);
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

async function executeIngestion({ companyId, documentId, jobId, options = {} } = {}) {
  const vectorStore = getVectorStore(options);
  const embeddingProvider = buildEmbeddingProvider(options);

  const document = await KnowledgeDocument.findOne({ _id: documentId, companyId, isDeleted: false });
  if (!document) throw new AppError(404, "Knowledge document not found.");

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
      if (jobId) {
        await IngestionJob.findOneAndUpdate(
          { jobId },
          { $set: { status: "indexed", completedAt: new Date(), processingDurationMs: 0, chunkCount: 0, vectorCount: 0 } }
        );
      }
      return { document, chunks: 0, vectorIds: [] };
    }

    await clearExistingChunks({ companyId, knowledgeDocumentId: document._id, vectorStore });

    const records = [];
    for (const chunk of chunks) {
      const contentHash = hashContent(chunk.content);
      const persisted = await KnowledgeChunk.create({
        companyId,
        knowledgeBaseId: document.knowledgeBaseId,
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
        knowledgeBaseId: document.knowledgeBaseId,
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

    if (jobId) {
      await IngestionJob.findOneAndUpdate(
        { jobId },
        { $set: { status: "indexed", completedAt: new Date(), processingDurationMs: 0, chunkCount: chunks.length, vectorCount: vectorIds.length, embeddingProvider: embeddingMetadata.provider, embeddingModel: embeddingMetadata.model, embeddingDimensions: embeddingMetadata.dimensions, embeddingUsage: totalEmbeddingUsage } }
      );
    }

    return {
      document: await KnowledgeDocument.findById(document._id),
      chunks: chunks.length,
      vectorIds,
      embeddingMetadata,
      embeddingUsage: totalEmbeddingUsage,
    };
  } catch (error) {
    if (document) {
      document.indexingState = "index_failed";
      document.indexingError = String(error && error.message ? error.message : "indexing failed").slice(0, 500);
      document.lastIndexedAt = new Date();
      await document.save();
    }
    if (jobId) {
      await IngestionJob.findOneAndUpdate(
        { jobId },
        { $set: { status: "index_failed", completedAt: new Date(), processingDurationMs: 0, errorCode: error.code || "INGESTION_FAILED", errorMessage: String(error && error.message ? error.message : "indexing failed").slice(0, 500) } }
      );
    }
    if (error instanceof AppError) throw error;
    throw new AppError(502, "Knowledge ingestion failed.");
  }
}

async function ingestKnowledgeDocument({ companyId, documentId, options = {} } = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  validateObjectId(documentId, "documentId");

  const document = await KnowledgeDocument.findOne({ _id: documentId, companyId, isDeleted: false });
  if (!document) throw new AppError(404, "Knowledge document not found.");

  const knowledgeBase = await ensureKnowledgeBaseForCompany({ companyId, knowledgeBaseId: document.knowledgeBaseId });

  // Concurrency protection: check for existing pending job
  if (document.indexingState === "indexing") {
    const existingJob = await IngestionJob.findOne({
      documentId,
      companyId,
      status: "pending",
    });
    if (existingJob) {
      throw new AppError(409, "Ingestion already in progress. Please wait for the current job to complete or retry.");
    }
  }

  const useQueue = options.useQueue === true;
  const vectorStore = getVectorStore(options);
  const embeddingProvider = buildEmbeddingProvider(options);

  // Generate a job ID for tracking
  const jobId = `ingest_${companyId}_${documentId}_${Date.now()}`;

  // Create ingestion job record
  const job = await IngestionJob.create({
    jobId,
    documentId,
    knowledgeBaseId: document.knowledgeBaseId,
    companyId,
    status: "pending",
  });

  // Set document to indexing state
  document.indexingState = "indexing";
  document.indexingError = "";
  await document.save();

  // If queue is requested, enqueue the job for async processing
  if (useQueue) {
    const queue = createQueue(options.queueType || "in-memory", options);
    await queue.enqueue({
      jobId,
      documentId,
      companyId,
      knowledgeBaseId: document.knowledgeBaseId,
      type: "ingest",
      embeddingProviderName: options.embeddingProviderName || config.AI_EMBEDDING_PROVIDER,
      embeddingModel: options.embeddingModel || config.AI_DEFAULT_EMBEDDING_MODEL,
      embeddingDimensions: options.embeddingDimensions || config.AI_DEFAULT_EMBEDDING_DIMENSIONS,
      chunkSize: options.chunkSize || config.CHUNK_SIZE_CHARS,
      chunkOverlap: options.chunkOverlap || config.CHUNK_OVERLAP_CHARS,
      chunkMax: options.chunkMax || config.CHUNK_MAX_CHARS,
    });
    return {
      document,
      jobId,
      message: "Ingestion job submitted.",
    };
  }

  // Default: synchronous execution (backward compatible with existing tests)
  return executeIngestion({ companyId, documentId, jobId, document, options });
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

async function checkIngestionStatus({ companyId, documentId }) {
  validateObjectId(documentId, "documentId");
  const document = await KnowledgeDocument.findOne({ _id: documentId, companyId, isDeleted: false });
  if (!document) throw new AppError(404, "Knowledge document not found.");

  const job = await IngestionJob.findOne({ documentId, companyId }).sort({ createdAt: -1 });

  return {
    documentId: document._id,
    indexingState: document.indexingState,
    indexingError: document.indexingError,
    lastIndexedAt: document.lastIndexedAt,
    chunkCount: document.chunkCount,
    jobStatus: job ? job.status : null,
    jobProgress: job ? {
      attempts: job.attemptCount,
      maxAttempts: job.maxAttempts,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    } : null,
  };
}

async function retryIngestion({ companyId, documentId, options = {} } = {}) {
  validateObjectId(documentId, "documentId");
  const document = await KnowledgeDocument.findOne({ _id: documentId, companyId, isDeleted: false });
  if (!document) throw new AppError(404, "Knowledge document not found.");

  if (document.indexingState !== "index_failed") {
    throw new AppError(400, "Ingestion can only be retried for documents with index_failed state.");
  }

  // Reset document state and create new job
  document.indexingState = "indexing";
  document.indexingError = "";
  document.lastIndexedAt = new Date();
  await document.save();

  const jobId = `ingest_retry_${companyId}_${documentId}_${Date.now()}`;
  await IngestionJob.create({
    jobId,
    documentId,
    knowledgeBaseId: document.knowledgeBaseId,
    companyId,
    status: "pending",
    attemptCount: 0,
    maxAttempts: 3,
  });

  const queue = createQueue(options.queueType || "in-memory", options);
  await queue.enqueue({
    jobId,
    documentId,
    companyId,
    knowledgeBaseId: document.knowledgeBaseId,
    type: "ingest",
    embeddingProviderName: options.embeddingProviderName || config.AI_EMBEDDING_PROVIDER,
    embeddingModel: options.embeddingModel || config.AI_DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: options.embeddingDimensions || config.AI_DEFAULT_EMBEDDING_DIMENSIONS,
    chunkSize: options.chunkSize || config.CHUNK_SIZE_CHARS,
    chunkOverlap: options.chunkOverlap || config.CHUNK_OVERLAP_CHARS,
    chunkMax: options.chunkMax || config.CHUNK_MAX_CHARS,
  });

  return {
    document,
    jobId,
    message: "Retry ingestion job submitted.",
  };
}

module.exports = {
  ingestKnowledgeDocument,
  removeDocumentFromIndex,
  checkIngestionStatus,
  retryIngestion,
  IngestionJob,
  executeIngestion,
  createQueue,
};