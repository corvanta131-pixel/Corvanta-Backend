const { VectorStore } = require("../vectorStore");

class VectorStoreError extends Error {
  constructor(message = "Vector store request failed.", code = "VECTOR_STORE_ERROR", statusCode = 502, options = {}) {
    super(message);
    this.name = "VectorStoreError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = Boolean(options.retryable);
    this.isOperational = true;
  }
}

class VectorStoreAuthError extends VectorStoreError {
  constructor() {
    super("Vector store authentication failed.", "VECTOR_STORE_AUTH", 401, { retryable: false });
    this.name = "VectorStoreAuthError";
  }
}

class VectorStoreTimeoutError extends VectorStoreError {
  constructor() {
    super("Vector store request timed out.", "VECTOR_STORE_TIMEOUT", 504, { retryable: true });
    this.name = "VectorStoreTimeoutError";
  }
}

class VectorStoreUnavailableError extends VectorStoreError {
  constructor() {
    super("Vector store is currently unavailable.", "VECTOR_STORE_UNAVAILABLE", 503, { retryable: true });
    this.name = "VectorStoreUnavailableError";
  }
}

class VectorStoreValidationError extends VectorStoreError {
  constructor(message = "Invalid vector store request.") {
    super(message, "VECTOR_STORE_VALIDATION", 400, { retryable: false });
    this.name = "VectorStoreValidationError";
  }
}

function normalizeVectorStoreError(error, context) {
  if (error && error.code === "VECTOR_STORE_AUTH") return new VectorStoreAuthError();
  if (error && error.code === "VECTOR_STORE_TIMEOUT") return new VectorStoreTimeoutError();
  if (error && error.code === "VECTOR_STORE_UNAVAILABLE") return new VectorStoreUnavailableError();
  if (error && error.code === "VECTOR_STORE_VALIDATION") return new VectorStoreValidationError(error.message);
  if (error && error.code === "VECTOR_STORE_MALFORMED_RESPONSE") {
    return new VectorStoreError(error.message || "Malformed response from vector store.", "VECTOR_STORE_MALFORMED_RESPONSE", 502, { retryable: false });
  }
  if (error && error.name === "VectorStoreError") return error;
  const message = (error && error.message) || "Vector store request failed.";
  const lower = String(message).toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return new VectorStoreTimeoutError();
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("network") || lower.includes("unavailable")) {
    return new VectorStoreUnavailableError();
  }
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("api key") || lower.includes("invalid api key")) {
    return new VectorStoreAuthError();
  }
  return new VectorStoreError(message, "VECTOR_STORE_ERROR", 502, { retryable: true });
}

function isConfigured(options = {}) {
  const apiKey = options.apiKey || process.env.PINECONE_API_KEY;
  const index = options.index || process.env.PINECONE_INDEX;
  return Boolean(apiKey && String(apiKey).trim() && index && String(index).trim());
}

function assertConfigured(options = {}) {
  if (!isConfigured(options)) {
    throw new VectorStoreValidationError(
      "Pinecone is not configured. Set PINECONE_API_KEY and PINECONE_INDEX to use the Pinecone vector store."
    );
  }
}

function assertTenant(record) {
  const cid = record && (record.companyId || record.cid);
  if (!cid) {
    throw new VectorStoreValidationError("Vector record requires a non-empty cid.");
  }
  if (!record.knowledgeDocumentId || !record.chunkId) {
    throw new VectorStoreValidationError("Vector record requires knowledgeDocumentId and chunkId.");
  }
}

function assertTenantSearch(payload) {
  const cid = payload && (payload.companyId || payload.cid);
  if (!cid) {
    throw new VectorStoreValidationError("Vector search requires a non-empty cid.");
  }
}

module.exports = {
  VectorStoreError,
  VectorStoreAuthError,
  VectorStoreTimeoutError,
  VectorStoreUnavailableError,
  VectorStoreValidationError,
  normalizeVectorStoreError,
  isConfigured,
  assertConfigured,
  assertTenant,
  assertTenantSearch,
};