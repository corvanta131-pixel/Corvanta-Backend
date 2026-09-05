const config = require("../config/config");
const { createEmbeddingProvider } = require("./ai/embeddingProvider");
const { createVectorStore } = require("./vectorStore");

const RAG_HOLDER = {
  embeddingProvider: null,
  vectorStore: null,
};

function resetRagRuntime() {
  RAG_HOLDER.embeddingProvider = null;
  RAG_HOLDER.vectorStore = null;
}

function getEmbeddingProvider(overrides = {}) {
  if (overrides.embeddingProvider) return overrides.embeddingProvider;
  if (!RAG_HOLDER.embeddingProvider) {
    RAG_HOLDER.embeddingProvider = createEmbeddingProvider(config.AI_EMBEDDING_PROVIDER, {
      model: config.AI_DEFAULT_EMBEDDING_MODEL,
      dimensions: config.AI_DEFAULT_EMBEDDING_DIMENSIONS,
      apiKey: config.OPENAI_API_KEY,
      timeoutMs: config.AI_PROVIDER_TIMEOUT_MS,
    });
  }
  return RAG_HOLDER.embeddingProvider;
}

function getVectorStore(overrides = {}) {
  if (overrides.vectorStore) return overrides.vectorStore;
  if (!RAG_HOLDER.vectorStore) {
    RAG_HOLDER.vectorStore = createVectorStore(config.AI_VECTOR_STORE || "memory", {});
  }
  return RAG_HOLDER.vectorStore;
}

function setVectorStoreForTests(store) {
  RAG_HOLDER.vectorStore = store;
}

function setEmbeddingProviderForTests(provider) {
  RAG_HOLDER.embeddingProvider = provider;
}

module.exports = {
  getEmbeddingProvider,
  getVectorStore,
  setVectorStoreForTests,
  setEmbeddingProviderForTests,
  resetRagRuntime,
};
