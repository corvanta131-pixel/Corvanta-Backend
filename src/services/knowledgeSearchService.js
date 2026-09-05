const AppError = require("../utils/AppError");
const { retrieveKnowledge, retrieveKnowledgeSemantic } = require("./knowledgeRetriever");
const { getEmbeddingProvider, getVectorStore } = require("./ragRuntime");
const config = require("../config/config");

async function searchKnowledge({ companyId, query = "", knowledgeBaseIds = [], limit = config.AI_CONTEXT_DOCUMENT_LIMIT, options = {} } = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  const max = Math.max(1, Math.min(Number(limit) || config.AI_CONTEXT_DOCUMENT_LIMIT, 50));
  const useSemantic = options.useSemantic !== false;
  if (useSemantic) {
    return retrieveKnowledgeSemantic({
      companyId,
      knowledgeBaseIds,
      query,
      limit: max,
      options: {
        embeddingProvider: options.embeddingProvider || getEmbeddingProvider(),
        vectorStore: options.vectorStore || getVectorStore(),
      },
    });
  }
  return retrieveKnowledge({ companyId, knowledgeBaseIds, query, limit: max });
}

module.exports = { searchKnowledge };
