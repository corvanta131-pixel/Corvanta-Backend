const KnowledgeBase = require("../models/KnowledgeBase");
const KnowledgeDocument = require("../models/KnowledgeDocument");
const KnowledgeChunk = require("../models/KnowledgeChunk");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");
const config = require("../config/config");
const { createEmbeddingProvider } = require("./ai/embeddingProvider");

function tokens(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]{2,}/g) || [];
}

async function validateKnowledgeBases(companyId, knowledgeBaseIds) {
  if (knowledgeBaseIds !== undefined && !Array.isArray(knowledgeBaseIds)) {
    throw new AppError(400, "knowledgeBaseIds must be an array.");
  }
  const ids = Array.isArray(knowledgeBaseIds) ? [...new Set(knowledgeBaseIds.map(String))] : [];
  ids.forEach((id) => validateObjectId(id, "knowledgeBaseId"));
  if (!ids.length) return [];
  const bases = await KnowledgeBase.find({
    _id: { $in: ids },
    companyId,
    isDeleted: false,
    status: "active",
  }).select("_id").lean();
  if (bases.length !== ids.length) {
    throw new AppError(403, "One or more agent knowledge bases are invalid or unavailable.");
  }
  return ids;
}

async function retrieveKnowledge({ companyId, knowledgeBaseIds = [], query = "", limit = config.AI_CONTEXT_DOCUMENT_LIMIT } = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  const ids = await validateKnowledgeBases(companyId, knowledgeBaseIds);
  if (!ids.length) return [];

  const documents = await KnowledgeDocument.find({
    companyId,
    knowledgeBaseId: { $in: ids },
    status: "published",
    isDeleted: false,
  }).select("_id knowledgeBaseId title content summary tags").lean();

  const queryTokens = tokens(query);
  const ranked = documents.map((document) => {
    const haystack = tokens([document.title, document.summary, document.content, ...(document.tags || [])].join(" "));
    const score = queryTokens.reduce((total, token) => total + haystack.filter((item) => item === token).length, 0);
    return { ...document, score };
  }).sort((a, b) => b.score - a.score || String(a._id).localeCompare(String(b._id)));

  return ranked.slice(0, Math.max(0, Math.min(Number(limit) || 0, 50))).map((document) => ({
    id: document._id,
    knowledgeDocumentId: document._id,
    knowledgeBaseId: document.knowledgeBaseId,
    title: document.title,
    content: document.content || document.summary || "",
    score: document.score,
  }));
}

async function retrieveKnowledgeSemantic({
  companyId,
  knowledgeBaseIds = [],
  query = "",
  limit = config.AI_CONTEXT_DOCUMENT_LIMIT,
  options = {},
} = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  const ids = await validateKnowledgeBases(companyId, knowledgeBaseIds);
  if (!ids.length) return [];
  const embeddingProvider = options.embeddingProvider || createEmbeddingProvider(
    options.embeddingProviderName || config.AI_EMBEDDING_PROVIDER,
    {
      apiKey: options.embeddingApiKey,
      model: options.embeddingModel || config.AI_DEFAULT_EMBEDDING_MODEL,
      dimensions: options.embeddingDimensions || config.AI_DEFAULT_EMBEDDING_DIMENSIONS,
      timeoutMs: options.embeddingTimeoutMs || config.AI_PROVIDER_TIMEOUT_MS,
    }
  );
  const vectorStore = options.vectorStore;
  if (!vectorStore) throw new AppError(503, "Vector store is not configured.");
  const max = Math.max(0, Math.min(Number(limit) || 0, 50));
  if (!max) return [];

  let embedding;
  try {
    embedding = await embeddingProvider.generateEmbedding(query);
  } catch (error) {
    throw new AppError(502, "Embedding generation failed.");
  }

  const matches = await vectorStore.search({
    companyId,
    vector: embedding.vector,
    limit: max,
    knowledgeBaseIds: ids,
  });
  if (!matches.length) return [];

  const chunkIds = matches.map((match) => match.chunkId);
  const chunks = await KnowledgeChunk.find({
    _id: { $in: chunkIds },
    companyId,
    isDeleted: false,
  })
    .select("_id knowledgeBaseId knowledgeDocumentId chunkIndex content metadata")
    .lean();
  const byId = new Map(chunks.map((chunk) => [String(chunk._id), chunk]));
  const documentIds = [...new Set(chunks.map((chunk) => String(chunk.knowledgeDocumentId)))];
  const documents = await KnowledgeDocument.find({
    _id: { $in: documentIds },
    companyId,
    knowledgeBaseId: { $in: ids },
    status: "published",
    isDeleted: false,
  })
    .select("_id knowledgeBaseId title")
    .lean();
  const docById = new Map(documents.map((doc) => [String(doc._id), doc]));

  return matches
    .map((match) => {
      const chunk = byId.get(String(match.chunkId));
      if (!chunk) return null;
      const document = docById.get(String(chunk.knowledgeDocumentId));
      if (!document) return null;
      return {
        id: chunk._id,
        chunkId: chunk._id,
        knowledgeBaseId: chunk.knowledgeBaseId,
        knowledgeDocumentId: chunk.knowledgeDocumentId,
        documentTitle: document.title,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: match.score,
      };
    })
    .filter(Boolean);
}

class KnowledgeRetriever {
  constructor(options = {}) {
    this.limit = options.limit || config.AI_CONTEXT_DOCUMENT_LIMIT;
  }

  retrieve(params) {
    return retrieveKnowledge({ ...params, limit: params?.limit || this.limit });
  }
}

module.exports = {
  KnowledgeRetriever,
  retrieveKnowledge,
  retrieveKnowledgeSemantic,
  validateKnowledgeBases,
};
