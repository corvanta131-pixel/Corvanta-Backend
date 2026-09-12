const https = require("https");
const { URL } = require("url");
const { VectorStore } = require("../vectorStore");
const {
  VectorStoreError,
  VectorStoreAuthError,
  VectorStoreTimeoutError,
  VectorStoreUnavailableError,
  VectorStoreValidationError,
  normalizeVectorStoreError,
  assertConfigured,
  assertTenant,
  assertTenantSearch,
} = require("./pineconeError");

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_TOPK = 5;

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

class PineconeVectorStore extends VectorStore {
  constructor(options = {}) {
    super();
    this.name = options.name || "pinecone";
    this.apiKey = options.apiKey || process.env.PINECONE_API_KEY || "";
    this.index = options.index || process.env.PINECONE_INDEX || "";
    this.namespace = options.namespace || process.env.PINECONE_NAMESPACE || "";
    this.host = options.host || process.env.PINECONE_HOST || "";
    this.timeoutMs = Number(options.timeoutMs || process.env.PINECONE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.dimensions = Number(options.dimensions || process.env.PINECONE_DIMENSIONS || 1536);
    this.shouldFailNext = Boolean(options.shouldFailNext);
    this.httpAdapter = options.httpAdapter || null;
  }

  _requestOptions(path, method = "GET", body) {
    const url = new URL(path, this.host || "https://api.pinecone.io");
    const headers = {
      "Content-Type": "application/json",
      "Api-Key": String(this.apiKey || ""),
      "X-Pinecone-API-Version": "2024-07",
    };
    return {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: this.timeoutMs,
    };
  }

  _request(path, method = "GET", body) {
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      return Promise.reject(new VectorStoreUnavailableError());
    }
    if (this.httpAdapter) {
      return Promise.resolve()
        .then(() => this.httpAdapter({ path, method, body, headers: this._requestOptions(path, method, body).headers }))
        .then((result) => {
          if (result && typeof result === "object" && (result.status || result.statusCode)) {
            const statusCode = Number(result.status || result.statusCode);
            if (statusCode >= 200 && statusCode < 300) return result.body !== undefined ? result.body : result;
            if (statusCode === 401 || statusCode === 403) throw new VectorStoreAuthError();
            if (statusCode === 408 || statusCode === 429) throw new VectorStoreUnavailableError();
            if (statusCode >= 500) throw new VectorStoreUnavailableError();
            const message = (result.body && (result.body.error || result.body.message)) || `Vector store request failed with status ${statusCode}.`;
            throw new VectorStoreError(message, "VECTOR_STORE_ERROR", statusCode, { retryable: statusCode >= 500 });
          }
          return result;
        })
        .catch((error) => {
          if (error && error.code === "VECTOR_STORE_MALFORMED_RESPONSE") {
            throw new VectorStoreError(error.message || "Malformed response from vector store.", "VECTOR_STORE_MALFORMED_RESPONSE", 502, { retryable: false });
          }
          throw normalizeVectorStoreError(error);
        });
    }
    return new Promise((resolve, reject) => {
      const options = this._requestOptions(path, method, body);
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (parseError) {
            return reject(new VectorStoreError("Malformed response from vector store.", "VECTOR_STORE_MALFORMED_RESPONSE", 502, { retryable: false }));
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(parsed);
          }
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new VectorStoreAuthError());
          }
          if (res.statusCode === 408 || res.statusCode === 429) {
            return reject(new VectorStoreUnavailableError());
          }
          if (res.statusCode >= 500) {
            return reject(new VectorStoreUnavailableError());
          }
          const message = (parsed && (parsed.error || parsed.message)) || `Vector store request failed with status ${res.statusCode}.`;
          return reject(new VectorStoreError(message, "VECTOR_STORE_ERROR", res.statusCode, { retryable: res.statusCode >= 500 }));
        });
      });
      req.on("error", (error) => reject(normalizeVectorStoreError(error)));
      req.on("timeout", () => { req.destroy(); reject(new VectorStoreTimeoutError()); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  _normalizeRecord(record) {
    const recordWithCompany = { ...record, cid: record.cid || record.companyId, cidVal: record.companyId || record.cid };
    assertTenant({ ...record, cid: record.cid || record.companyId });
    const cid = record.companyId || record.cid;
    const vector = Array.isArray(record.vector) ? record.vector.map(Number) : [];
    if (!vector.length) {
      throw new VectorStoreValidationError("Vector record requires a non-empty numeric vector.");
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new VectorStoreValidationError("Vector record contains non-numeric vector values.");
    }
    return {
      id: String(record.chunkId),
      values: vector,
      metadata: {
        _companyId: String(cid),
        _knowledgeBaseId: String(record.knowledgeBaseId || ""),
        _knowledgeDocumentId: String(record.knowledgeDocumentId),
        _chunkId: String(record.chunkId),
        knowledgeBaseId: String(record.knowledgeBaseId || ""),
        knowledgeDocumentId: String(record.knowledgeDocumentId),
        chunkId: String(record.chunkId),
        embeddingProvider: String(record.embeddingProvider || ""),
        embeddingModel: String(record.embeddingModel || ""),
      },
    };
  }

  async upsert(records = []) {
    assertConfigured({ apiKey: this.apiKey, index: this.index });
    if (!Array.isArray(records) || !records.length) return [];
    const vectors = records.map((record) => this._normalizeRecord(record));
    const payload = {
      vectors,
      namespace: this.namespace || undefined,
    };
    const result = await this._request(`/vectors/upsert`, "POST", payload);
    return Array.isArray(result && result.upsertedCount) ? Array(result.upsertedCount).fill(0).map((_, i) => String(vectors[i].id)) : vectors.map((v) => v.id);
  }

  async search({ vector, limit = DEFAULT_TOPK, minScore = 0, knowledgeBaseIds = [], includeMetadata = true, cid, companyId } = {}) {
    assertTenantSearch({ cid, companyId });
    const cidVal = String(companyId || cid);
    const normalizedVector = Array.isArray(vector) ? vector.map(Number) : [];
    if (!normalizedVector.length) return [];
    const filter = { _companyId: { $eq: cidVal } };
    if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length) {
      filter._knowledgeBaseId = { $in: knowledgeBaseIds.map(String) };
    }
    const payload = {
      vector: normalizedVector,
      topK: Math.max(1, Number(limit) || DEFAULT_TOPK),
      filter,
      includeMetadata,
      namespace: this.namespace || undefined,
    };
    const result = await this._request(`/query`, "POST", payload);
    const matches = Array.isArray(result && result.matches) ? result.matches : [];
    const out = [];
    for (const match of matches) {
      const metadata = (match && match.metadata) || {};
      if (metadata._companyId && String(metadata._companyId) !== cidVal) continue;
      const score = Number(match && match.score);
      if (score < minScore) continue;
      out.push({
        id: String(match && match.id),
        chunkId: String(metadata._chunkId || (match && match.id)),
        knowledgeBaseId: String(metadata._knowledgeBaseId || ""),
        knowledgeDocumentId: String(metadata._knowledgeDocumentId || ""),
        cid: metadata._companyId || cidVal,
        score,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  async delete(id) {
    assertConfigured({ apiKey: this.apiKey, index: this.index });
    if (!id) throw new VectorStoreValidationError("delete requires a non-empty id.");
    await this._request(`/vectors/delete`, "POST", { ids: [String(id)], namespace: this.namespace || undefined });
    return true;
  }

  async deleteByDocument({ cid, knowledgeDocumentId } = {}) {
    if (!cid || !knowledgeDocumentId) throw new VectorStoreValidationError("deleteByDocument requires cid and knowledgeDocumentId.");
    assertConfigured({ apiKey: this.apiKey, index: this.index });
    const filter = { _companyId: { $eq: String(cid) }, _knowledgeDocumentId: { $eq: String(knowledgeDocumentId) } };
    await this._request(`/vectors/delete`, "POST", { filter, namespace: this.namespace || undefined, deleteAll: false });
    return 0;
  }

  async deleteByKnowledgeBase({ cid, knowledgeBaseId } = {}) {
    if (!cid || !knowledgeBaseId) throw new VectorStoreValidationError("deleteByKnowledgeBase requires cid and knowledgeBaseId.");
    assertConfigured({ apiKey: this.apiKey, index: this.index });
    const filter = { _companyId: { $eq: String(cid) }, _knowledgeBaseId: { $eq: String(knowledgeBaseId) } };
    await this._request(`/vectors/delete`, "POST", { filter, namespace: this.namespace || undefined, deleteAll: false });
    return 0;
  }

  async deleteByCompany({ cid } = {}) {
    if (!cid) throw new VectorStoreValidationError("deleteByCompany requires cid.");
    assertConfigured({ apiKey: this.apiKey, index: this.index });
    const filter = { _companyId: { $eq: String(cid) } };
    await this._request(`/vectors/delete`, "POST", { filter, namespace: this.namespace || undefined, deleteAll: false });
    return 0;
  }

  async health() {
    try {
      assertConfigured({ apiKey: this.apiKey, index: this.index });
      await this._request(`/describe`, "GET");
      return { status: "healthy", type: this.name, index: this.index };
    } catch (error) {
      return { status: "unhealthy", type: this.name, error: error.message };
    }
  }
}

function createPineconeVectorStore(name = "pinecone", options = {}) {
  const normalized = String(name || "pinecone").toLowerCase();
  if (normalized === "pinecone" || normalized === "") {
    return new PineconeVectorStore(options);
  }
  throw new Error(`Unsupported pinecone vector store: ${name}`);
}

module.exports = {
  PineconeVectorStore,
  createPineconeVectorStore,
  cosineSimilarity,
};
