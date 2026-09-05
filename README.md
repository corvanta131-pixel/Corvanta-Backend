# Corvanta Backend

Corvanta is an AI-powered business and customer service platform for multi-tenant operations across regions, countries, cities, and companies.

## Purpose

This backend provides a production-ready foundation for:

- multi-tenant company isolation
- authentication and authorization
- central service architecture
- AI provider abstraction
- storage abstraction
- email abstraction
- MongoDB data model foundation
- health monitoring and API versioning

## Stack

- Node.js
- Express.js
- MongoDB + Mongoose
- JWT authentication
- bcryptjs password hashing
- Helmet, CORS, Morgan
- REST API with versioning under /api/v1

## Architecture

The initial foundation follows a modular layout inspired by enterprise backend systems:

- `src/config` for environment and database startup
- `src/controllers` for request handling
- `src/services` for business logic
- `src/models` for MongoDB schemas
- `src/routes` for API endpoints
- `src/middleware` for auth, errors, and security
- `src/utils` for reusable helpers
- `src/integrations` for AI, email, and storage abstraction

## Local installation

1. Copy `.env.example` to `.env` if needed.
2. Install dependencies:
   npm install
3. Start the app:
   npm run dev

## Scripts

- `npm run dev` — starts the app with nodemon
- `npm start` — production start command
- `npm test` — runs the test suite

## API versioning

All API endpoints are prefixed with:

- `/api/v1`

## Health check

- `GET /api/v1/health`

## Environment variables

See `.env.example` for the supported variables. All local placeholders are safe development values only.

## Development conventions

- Keep business logic out of routes.
- Use centralized error handling.
- Protect routes with authentication + authorization middleware.
- Validate environment variables on startup.
- Never commit `.env` or real credentials.
- Email addresses are treated as globally unique across the platform to keep authentication consistent and tenant-safe.

## Notes

## Stage D: secure AI conversations

Stage D adds a provider-agnostic conversation workflow without external AI calls:

- `AIProvider`/`AIService` normalize requests (`systemPrompt`, `messages`, `context`, `temperature`, `maxTokens`) and responses (text/content, provider/model, usage, finish reason, and request ID). The deterministic mock provider is the default.
- `KnowledgeRetriever` only searches published, non-deleted documents in active, non-deleted knowledge bases belonging to the authenticated company and the selected agent.
- `contextBuilder` keeps system instructions, bounded history, retrieved knowledge, and current user content as separate inputs.
- `messageService` and `aiConversationService` enforce company scope for every conversation, customer, agent, knowledge base, document, and message lookup. Provider failures become controlled API errors and never expose raw provider errors.
- `POST /api/v1/conversations/:conversationId/messages` requires `conversations:send`; `GET /api/v1/conversations/:conversationId/messages` requires `conversations:messages:read`. Public message creation accepts only `user` or `customer` sender types; assistant/system messages are server-generated.
- Agent configuration supports `provider`, `temperature`, `maxTokens`, `responseConfig`, and `fallbackConfig`; credentials are intentionally not stored in agents.

Stage D intentionally defers streaming, embeddings/vector search, external provider credentials, tool/function calling, and asynchronous generation queues. Configure limits and the mock provider with the `AI_*` variables in `.env.example`.

## Stage E: production RAG foundation

Stage E upgrades the Stage D foundation toward a production-quality RAG pipeline while remaining provider-agnostic and tenant-isolated. It does **not** deploy production infrastructure; it builds the application-layer architecture that can later be connected to AWS/vector infrastructure without rewriting the business layer.

### What Stage E adds

- **Provider-agnostic AI layer.** `AIService` and the new `providerRegistry` accept any `AIProvider`. `MockAIProvider` remains the default and is the only provider used in the test suite.
- **Real OpenAI provider adapter.** `OpenAIProvider` (in `src/services/ai/openaiProvider.js`) implements the normalized `generate({ systemPrompt, messages, context, temperature, maxTokens })` interface. It fails safely with a `PROVIDER_NOT_CONFIGURED` error when `OPENAI_API_KEY` is missing or is a placeholder, so the server can boot without external credentials and tests do not require them.
- **Server-controlled provider/model allowlist.** `AI_ALLOWED_PROVIDERS` and `AI_ALLOWED_GENERATION_MODELS` in `.env.example` define the only provider/model values an `AIAgent` may be configured with. `agentConfigValidator` rejects any other value at create/update time. Clients cannot select an unapproved provider or model.
- **Embedding abstraction.** `EmbeddingProvider` defines `generateEmbedding(input)` and returns a normalized `{ vector, model, dimensions, usage, provider }`. A deterministic `MockEmbeddingProvider` is used for tests; `OpenAIEmbeddingProvider` calls OpenAI's embeddings endpoint when configured.
- **Deterministic document chunking.** `chunker` splits knowledge document content into bounded, order-preserving, deterministic chunks with configurable size and overlap.
- **KnowledgeChunk model.** Tenant-scoped (`companyId` indexed), with `knowledgeBaseId`, `knowledgeDocumentId`, `chunkIndex`, `contentHash`, embedding metadata, and soft deletion. A unique compound index on `(companyId, knowledgeDocumentId, chunkIndex)` guarantees re-indexing does not produce duplicate chunks.
- **VectorStore abstraction.** `VectorStore` defines `upsert`, `search`, `delete`, `deleteByDocument`, `deleteByKnowledgeBase`, `deleteByCompany`. `InMemoryVectorStore` is the deterministic dev/test implementation. The application depends only on this interface, not on any specific vector database.
- **Semantic retrieval.** `retrieveKnowledgeSemantic` performs tenant-scoped embedding search against the vector store, then re-validates every result against the MongoDB document/kb status and soft-delete flags. The Stage D deterministic retriever is preserved for backwards compatibility and explicit non-semantic callers.
- **Knowledge ingestion pipeline.** `ingestionService.ingestKnowledgeDocument` runs validate → chunk → embed → persist chunks → upsert vectors → mark indexed. Re-ingestion is idempotent: it clears prior chunks and vectors for the document before re-creating them. Failures mark the document as `index_failed` with a normalized `indexingError` rather than silently leaving it in a half-indexed state.
- **Source attribution.** `buildSources` returns a normalized source reference list `{ index, documentId, chunkId, knowledgeBaseId, title, score }`. The assistant message metadata carries `sourceCount` and (server-side) the full `sources` array; the public API only exposes `sourceCount` by design.
- **Prompt-injection-aware context builder.** `buildPromptWithUntrustedKnowledge` wraps retrieved passages in a clearly delimited `--- BEGIN UNTRUSTED KNOWLEDGE ---` block, preceded by explicit instructions that passages are data, not commands, and that conflicts with system instructions are resolved in favor of the system instructions.
- **Extended usage/cost metadata.** Message metadata now records provider, model, generation usage (`promptTokens`, `completionTokens`, `totalTokens`), embedding usage, `latencyMs`, `providerRequestId`, `retrievalMode`, and `sourceCount`. Generation and embedding usage are tracked separately.
- **Bounded limits everywhere.** History (`AI_HISTORY_MESSAGE_LIMIT`), retrieved chunks (`AI_CONTEXT_DOCUMENT_LIMIT`), context characters (`AI_CONTEXT_MAX_CHARS`), and output tokens (`AI_MAX_OUTPUT_TOKENS`, capped from `agent.maxTokens`) are all bounded. Client and document content cannot override them.

### New endpoints

All endpoints are tenant-scoped, require authentication, use permission middleware, and validate input.

- `POST /api/v1/knowledge-documents/:id/index` — run ingestion for a document (`knowledge:update`).
- `GET  /api/v1/knowledge-documents/:id/index-status` — read indexing state, last error, chunk count (`knowledge:read`).
- `DELETE /api/v1/knowledge-documents/:id/index` — remove document from the vector index (`knowledge:update`).
- `POST /api/v1/knowledge-bases/search` — semantic knowledge search over the authenticated company's knowledge bases (`knowledge:read`).

### Configuration

New environment variables (all in `.env.example`):

- `OPENAI_API_KEY` (optional, required only for real generation/embedding)
- `OPENAI_ORGANIZATION` (optional)
- `AI_ALLOWED_PROVIDERS` (server-side allowlist, default `mock,openai`)
- `AI_ALLOWED_GENERATION_MODELS` (server-side allowlist, default `mock-model,gpt-4o-mini,gpt-4o,gpt-4.1-mini,gpt-3.5-turbo`)
- `AI_ALLOWED_EMBEDDING_MODELS` (default `mock-embedding-model,text-embedding-3-small,text-embedding-3-large`)
- `AI_EMBEDDING_PROVIDER` (default `mock`)
- `AI_DEFAULT_EMBEDDING_MODEL` (default `text-embedding-3-small`)
- `AI_DEFAULT_EMBEDDING_DIMENSIONS` (default `1536`)
- `AI_MAX_OUTPUT_TOKENS` (default `1024`, caps `agent.maxTokens`)
- `CHUNK_SIZE_CHARS` (default `1200`)
- `CHUNK_OVERLAP_CHARS` (default `200`)
- `CHUNK_MAX_CHARS` (default `4000`)

In production, the server refuses to start if any of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `RESEND_API_KEY`, `CLOUDINARY_*`, `AI_API_KEY`, or `OPENAI_API_KEY` is still a development placeholder.

### Security considerations

- Tenant isolation is enforced at every layer: the vector store keys by `companyId` and refuses cross-company reads, the retriever re-validates chunks against the database, and the chunk model is indexed on `companyId`.
- The retriever never returns chunks from deleted knowledge bases, deleted documents, draft documents, or archived documents — even if a stale vector exists in the store.
- The OpenAI provider normalizes all upstream errors into `AIProviderError` with controlled status codes (502/503/504/429); the controller never forwards raw provider error messages to the client.
- `publicMessage` strips forbidden metadata keys and only whitelists `usage.{promptTokens,completionTokens,totalTokens,inputTokens,outputTokens}`.
- The logger redacts `apiKey`, `authorization`, `api_key`, `secret`, `password`, `token`, `credential`, `credentials` and any `sk-…` / `Bearer …` strings before writing.
- The conversation flow and ingestion endpoints explicitly reject client-supplied `companyId`, `_id`, `isDeleted`, `deletedAt`, and other protected fields via `rejectProtectedFieldOverrides`.

### Prompt-injection limitations

Stage E adds structural defenses (untrusted-knowledge wrapping, explicit "data not instructions" instructions, system-instructions-first ordering) and adversarial tests, but it **does not claim to fully prevent prompt injection**. The model is still a language model, and a sufficiently adversarial document plus a permissive downstream model can still produce unsafe outputs. The application layer treats knowledge as untrusted and should be combined with output validation, content moderation, and human review before any autonomous action. This limitation is by design and is documented here so the platform is not over-claimed.

### Testing

- `tests/stage-e-adversarial.integration.test.js` — 24 adversarial integration tests against real Company A / Company B records, covering all the attack scenarios listed in the Stage E spec.
- `tests/stage-e-behavioral.test.js` — unit-level coverage for the chunker, embedding provider, vector store, context builder, agent config validator, OpenAI provider fail-safe, and provider registry.
- The Stage C and Stage D suites continue to pass unchanged, confirming no regressions.

### Explicitly deferred (not in Stage E)

The following are intentionally **not** built in Stage E and remain future work: AWS infrastructure, EC2, S3, Docker, Terraform, Kubernetes, WebSockets, streaming responses, frontend, billing, email/Resend, Cloudinary, queues, production observability platforms, CI/CD redesign, and any production vector database. The `VectorStore` and `EmbeddingProvider` abstractions are designed to be replaceable with AWS/managed implementations without changing the business layer.

# Corvanta-Backend
# Corvanta-Backend
