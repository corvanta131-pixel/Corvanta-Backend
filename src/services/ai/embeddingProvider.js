const { AIProviderError } = require("./aiService");

class EmbeddingProvider {
  constructor({ provider = "unknown", model = "unknown", dimensions = 0 } = {}) {
    this.provider = provider;
    this.model = model;
    this.dimensions = Number(dimensions || 0);
  }

  async generateEmbedding() {
    throw new AIProviderError("Embedding provider is not configured.", "EMBEDDING_NOT_IMPLEMENTED", 501);
  }
}

class MockEmbeddingProvider extends EmbeddingProvider {
  constructor(options = {}) {
    super({ provider: "mock", model: options.model || "mock-embedding-model", dimensions: options.dimensions || 1536 });
    this.dimensions = options.dimensions || 1536;
  }

  async generateEmbedding(input) {
    const text = String(input || "").trim();
    if (!text) {
      throw new AIProviderError("Embedding input cannot be empty.", "EMPTY_EMBEDDING_INPUT", 400);
    }
    if (text.includes("__EMBEDDING_FAILURE__")) {
      throw new AIProviderError("Mock embedding provider failure.", "EMBEDDING_FAILURE", 502, { retryable: true });
    }
    const vector = computeDeterministicVector(text, this.dimensions);
    return {
      vector,
      model: this.model,
      dimensions: vector.length,
      provider: this.provider,
      usage: { inputTokens: Math.ceil(text.length / 4), totalTokens: Math.ceil(text.length / 4) },
    };
  }
}

function computeDeterministicVector(text, dimensions) {
  const vector = new Array(dimensions).fill(0);
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!tokens.length) return vector;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const hash = fnv1a(`${token}:${dimension}`);
      vector[dimension] += (hash % 1000) / 1000 - 0.5;
    }
  }
  return normalizeVector(vector);
}

function fnv1a(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function normalizeVector(vector) {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

class OpenAIEmbeddingProvider extends EmbeddingProvider {
  constructor(options = {}) {
    super({ provider: "openai", model: options.model || "text-embedding-3-small", dimensions: options.dimensions || 1536 });
    this.apiKey = options.apiKey || "";
    this.model = options.model || "text-embedding-3-small";
    this.timeoutMs = options.timeoutMs || 10000;
    this.client = null;
    this.initialized = false;
    this.initializationError = null;
    this.placeholder = !this.apiKey
      || this.apiKey === "development-placeholder-openai-key"
      || this.apiKey === "development-placeholder-ai-key";
  }

  _ensureClient() {
    if (this.initialized) return;
    this.initialized = true;
    if (this.placeholder) {
      this.initializationError = new AIProviderError(
        "OpenAI embedding provider is not configured: missing API key.",
        "EMBEDDING_NOT_CONFIGURED",
        503
      );
      return;
    }
    try {
      const OpenAI = require("openai");
      this.client = new OpenAI({ apiKey: this.apiKey, timeout: this.timeoutMs });
    } catch (error) {
      this.initializationError = new AIProviderError("OpenAI embedding provider failed to initialize.", "EMBEDDING_INIT_FAILED", 503);
    }
  }

  async generateEmbedding(input) {
    this._ensureClient();
    if (this.initializationError) throw this.initializationError;
    const text = String(input || "").trim();
    if (!text) throw new AIProviderError("Embedding input cannot be empty.", "EMPTY_EMBEDDING_INPUT", 400);
    let response;
    try {
      response = await this.client.embeddings.create({ model: this.model, input: text });
    } catch (error) {
      if (error && (error.status === 429 || (error.code === "ETIMEDOUT"))) {
        throw new AIProviderError("OpenAI embedding request failed.", "EMBEDDING_RATE_LIMIT", 429, { retryable: true });
      }
      throw new AIProviderError("OpenAI embedding request failed.", "EMBEDDING_FAILURE", 502, { retryable: true });
    }
    const item = response && response.data && response.data[0];
    if (!item || !Array.isArray(item.embedding)) {
      throw new AIProviderError("OpenAI embedding response was invalid.", "EMBEDDING_INVALID_RESPONSE", 502);
    }
    const vector = normalizeVector(item.embedding.map((value) => Number(value)));
    const usage = response && response.usage ? response.usage : {};
    return {
      vector,
      model: this.model,
      dimensions: vector.length,
      provider: this.provider,
      usage: { inputTokens: Number(usage.prompt_tokens || 0), totalTokens: Number(usage.total_tokens || 0) },
    };
  }
}

function createEmbeddingProvider(providerName = "mock", options = {}) {
  const name = String(providerName || "").toLowerCase();
  if (name === "mock" || name === "") {
    return new MockEmbeddingProvider({ model: options.model, dimensions: options.dimensions });
  }
  if (name === "openai") {
    return new OpenAIEmbeddingProvider({
      apiKey: options.apiKey,
      model: options.model,
      timeoutMs: options.timeoutMs,
      dimensions: options.dimensions,
    });
  }
  throw new AIProviderError(`Unsupported embedding provider: ${providerName}`, "EMBEDDING_PROVIDER_NOT_SUPPORTED", 400);
}

module.exports = {
  EmbeddingProvider,
  MockEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
  computeDeterministicVector,
  normalizeVector,
};
