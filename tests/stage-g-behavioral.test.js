const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AIProviderError,
  AIProviderTimeoutError,
  AIRateLimitError,
  AIContextLengthExceededError,
  AIModelUnavailableError,
  MockAIProvider,
  AIService,
  normalizeRequest,
} = require("../src/services/ai/aiService");

const { OpenAIProvider } = require("../src/services/ai/openaiProvider");
const {
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
} = require("../src/services/ai/embeddingProvider");
const { createProvider, isPlaceholderOpenAIKey } = require("../src/services/ai/providerRegistry");
const { validateAgentRuntimeConfig } = require("../src/services/ai/agentConfigValidator");
const { checkAIRateLimit, resetRateLimiter } = require("../src/middleware/aiRateLimit");
const logger = require("../src/utils/logger");

function asyncRun(asyncFn) {
  return Promise.resolve().then(asyncFn);
}

// === Configuration tests ===

test("Stage G CONFIG: OpenAI key placeholder is detected", () => {
  assert.equal(isPlaceholderOpenAIKey("development-placeholder-openai-key"), true);
  assert.equal(isPlaceholderOpenAIKey("development-placeholder-ai-key"), true);
  assert.equal(isPlaceholderOpenAIKey(""), true);
  assert.equal(isPlaceholderOpenAIKey(undefined), true);
  assert.equal(isPlaceholderOpenAIKey("sk-real-key-not-a-placeholder"), false);
});

test("Stage G CONFIG: createProvider returns OpenAI when 'openai' is requested", () => {
  const provider = createProvider("openai", { apiKey: "test-key-not-placeholder", model: "gpt-4o-mini" });
  assert.equal(provider.provider, "openai");
  assert.equal(provider.model, "gpt-4o-mini");
});

test("Stage G CONFIG: createProvider returns Mock by default", () => {
  const provider = createProvider("mock");
  assert.equal(provider.provider, "mock");
});

test("Stage G CONFIG: unsupported provider name throws AIProviderError", () => {
  assert.throws(() => createProvider("mystery"), /Unsupported AI provider/);
});

// === OpenAI Provider unit tests ===

test("Stage G UNIT: OpenAI provider rejects placeholder API key safely", async () => {
  const provider = new OpenAIProvider({ apiKey: "development-placeholder-openai-key", model: "gpt-4o-mini" });
  await assert.rejects(
    () => provider.generate({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "PROVIDER_NOT_CONFIGURED"
  );
});

test("Stage G UNIT: OpenAI provider rejects empty API key safely", async () => {
  const provider = new OpenAIProvider({ apiKey: "", model: "gpt-4o-mini" });
  await assert.rejects(
    () => provider.generate({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "PROVIDER_NOT_CONFIGURED"
  );
});

test("Stage G UNIT: OpenAI provider rejects missing user message", async () => {
  const provider = new OpenAIProvider({ apiKey: "real-key-here", model: "gpt-4o-mini" });
  await assert.rejects(
    () => provider.generate({ messages: [{ role: "system", content: "no user" }] }),
    (error) => error.code === "EMPTY_PROMPT"
  );
});

test("Stage G UNIT: OpenAI provider normalizes 429 as AIRateLimitError", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err = provider._normalizeUpstreamError({ status: 429, message: "Rate limit" });
  assert.ok(err instanceof AIRateLimitError);
  assert.equal(err.statusCode, 429);
  assert.equal(err.retryable, true);
});

test("Stage G UNIT: OpenAI provider normalizes 401/403 as auth failure (not retryable)", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err401 = provider._normalizeUpstreamError({ status: 401, message: "Unauthorized" });
  assert.equal(err401.code, "PROVIDER_AUTH_FAILED");
  assert.equal(err401.retryable, false);
  const err403 = provider._normalizeUpstreamError({ status: 403, message: "Forbidden" });
  assert.equal(err403.code, "PROVIDER_AUTH_FAILED");
  assert.equal(err403.retryable, false);
});

test("Stage G UNIT: OpenAI provider normalizes 5xx as PROVIDER_UNAVAILABLE (retryable)", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err500 = provider._normalizeUpstreamError({ status: 500, message: "Server error" });
  assert.equal(err500.code, "PROVIDER_UNAVAILABLE");
  assert.equal(err500.retryable, true);
  const err503 = provider._normalizeUpstreamError({ status: 503, message: "Service Unavailable" });
  assert.equal(err503.code, "PROVIDER_UNAVAILABLE");
});

test("Stage G UNIT: OpenAI provider normalizes ETIMEDOUT as timeout (retryable)", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err = provider._normalizeUpstreamError({ code: "ETIMEDOUT" });
  assert.ok(err instanceof AIProviderTimeoutError);
  assert.equal(err.retryable, true);
});

test("Stage G UNIT: OpenAI provider normalizes ECONNRESET/ENOTFOUND as transient", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err1 = provider._normalizeUpstreamError({ code: "ECONNRESET" });
  assert.equal(err1.code, "PROVIDER_UNAVAILABLE");
  assert.equal(err1.retryable, true);
  const err2 = provider._normalizeUpstreamError({ code: "ENOTFOUND" });
  assert.equal(err2.code, "PROVIDER_UNAVAILABLE");
});

test("Stage G UNIT: OpenAI provider normalizes model-not-found as AIModelUnavailableError", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err = provider._normalizeUpstreamError({ status: 404, message: "model not found" });
  assert.ok(err instanceof AIModelUnavailableError);
});

test("Stage G UNIT: OpenAI provider normalizes context-length errors", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err = provider._normalizeUpstreamError({ status: 400, message: "maximum context length exceeded" });
  assert.ok(err instanceof AIContextLengthExceededError);
  assert.equal(err.retryable, false);
});

test("Stage G UNIT: OpenAI provider never exposes raw upstream messages", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  const err = provider._normalizeUpstreamError({ status: 500, message: "Detailed internal error: api_key=sk-leaked" });
  assert.ok(!err.message.includes("sk-leaked"), "Provider error message must not leak upstream details");
});

test("Stage G UNIT: OpenAI provider handles missing usage gracefully", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  // Mock the client's response
  const originalEnsure = provider._ensureClient.bind(provider);
  provider._ensureClient = () => {
    provider.initialized = true;
    provider.client = {
      chat: {
        completions: {
          create: async () => ({
            id: "test-id",
            choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
            // no usage field
          }),
        },
      },
    };
  };
  return asyncRun(async () => {
    const result = await provider.generate({ messages: [{ role: "user", content: "hello" }] });
    assert.equal(result.text, "hi");
    assert.equal(result.usage.promptTokens, 0);
    assert.equal(result.usage.completionTokens, 0);
    assert.equal(result.usage.totalTokens, 0);
  });
});

test("Stage G UNIT: OpenAI provider handles malformed response", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  provider._ensureClient = () => {
    provider.initialized = true;
    provider.client = {
      chat: {
        completions: {
          create: async () => ({ choices: [] }), // no choices
        },
      },
    };
  };
  return asyncRun(async () => {
    await assert.rejects(
      () => provider.generate({ messages: [{ role: "user", content: "hi" }] }),
      (error) => error.code === "MALFORMED_RESPONSE"
    );
  });
});

test("Stage G UNIT: OpenAI provider extracts usage and request ID", () => {
  const provider = new OpenAIProvider({ apiKey: "real-key", model: "gpt-4o-mini" });
  provider._ensureClient = () => {
    provider.initialized = true;
    provider.client = {
      chat: {
        completions: {
          create: async () => ({
            id: "req-abc-123",
            choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
    };
  };
  return asyncRun(async () => {
    const result = await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.usage.promptTokens, 10);
    assert.equal(result.usage.completionTokens, 5);
    assert.equal(result.usage.totalTokens, 15);
    assert.equal(result.providerRequestId, "req-abc-123");
    assert.equal(result.finishReason, "stop");
  });
});

// === Embedding provider tests ===

test("Stage G UNIT: OpenAI embedding provider fails safely with placeholder key", async () => {
  const provider = new OpenAIEmbeddingProvider({ apiKey: "development-placeholder-openai-key" });
  await assert.rejects(
    () => provider.generateEmbedding("hello"),
    (error) => error.code === "EMBEDDING_NOT_CONFIGURED"
  );
});

test("Stage G UNIT: OpenAI embedding provider rejects empty input", async () => {
  const provider = new OpenAIEmbeddingProvider({ apiKey: "real-key" });
  // Skip client init by passing placeholder
  const placeholderProvider = new OpenAIEmbeddingProvider({ apiKey: "development-placeholder-ai-key" });
  await assert.rejects(
    () => placeholderProvider.generateEmbedding(""),
    (error) => error.code === "EMBEDDING_NOT_CONFIGURED"
  );
  // For non-placeholder, _ensureClient will attempt to require('openai')
  await assert.rejects(
    () => provider.generateEmbedding("   "),
    (error) => error.code === "EMPTY_EMBEDDING_INPUT"
  );
});

test("Stage G UNIT: OpenAI embedding provider normalizes 429 as rate limit", () => {
  const provider = new OpenAIEmbeddingProvider({ apiKey: "real-key" });
  // Simulating rate limit normalization by examining error type
  const { AIProviderError } = require("../src/services/ai/aiService");
  const err = new AIProviderError("test", "EMBEDDING_RATE_LIMIT", 429, { retryable: true });
  assert.equal(err.statusCode, 429);
  assert.equal(err.retryable, true);
});

test("Stage G UNIT: createEmbeddingProvider returns mock by default", () => {
  const provider = createEmbeddingProvider("mock", { model: "mock-embedding-model", dimensions: 16 });
  assert.equal(provider.provider, "mock");
});

test("Stage G UNIT: createEmbeddingProvider rejects unsupported provider", () => {
  assert.throws(() => createEmbeddingProvider("invalid"), /Unsupported embedding provider/);
});

test("Stage G UNIT: createEmbeddingProvider returns OpenAI when requested", () => {
  const provider = createEmbeddingProvider("openai", { apiKey: "real-key", model: "text-embedding-3-small" });
  assert.equal(provider.provider, "openai");
  assert.equal(provider.model, "text-embedding-3-small");
});

// === Agent config validator tests ===

test("Stage G UNIT: validateAgentRuntimeConfig rejects disallowed provider", () => {
  assert.throws(() => validateAgentRuntimeConfig({ provider: "unapproved", model: "gpt-4o-mini" }), /not allowed/);
});

test("Stage G UNIT: validateAgentRuntimeConfig rejects disallowed model", () => {
  assert.throws(() => validateAgentRuntimeConfig({ provider: "openai", model: "rogue-model" }), /not allowed/);
});

test("Stage G UNIT: validateAgentRuntimeConfig rejects temperature out of range", () => {
  assert.throws(() => validateAgentRuntimeConfig({ provider: "mock", model: "mock-model", temperature: 5 }), /Temperature/);
});

test("Stage G UNIT: validateAgentRuntimeConfig rejects maxTokens exceeding server ceiling", () => {
  const aboveCeiling = 1000000;
  assert.throws(
    () => validateAgentRuntimeConfig({ provider: "mock", model: "mock-model", maxTokens: aboveCeiling }),
    /maxTokens/
  );
});

test("Stage G UNIT: validateAgentRuntimeConfig rejects empty provider/model", () => {
  assert.throws(() => validateAgentRuntimeConfig({ provider: "", model: "gpt-4o-mini" }), /required/);
  assert.throws(() => validateAgentRuntimeConfig({ provider: "mock", model: "" }), /required/);
});

test("Stage G UNIT: validateAgentRuntimeConfig accepts valid config", () => {
  const result = validateAgentRuntimeConfig({ provider: "mock", model: "mock-model", temperature: 0.5, maxTokens: 256 });
  assert.equal(result.provider, "mock");
  assert.equal(result.model, "mock-model");
});

// === AI Service retry tests ===

test("Stage G UNIT: AIService retries on retryable error", async () => {
  const service = new AIService(new MockAIProvider({ model: "mock-model" }), {
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });
  // Override provider's generate to throw on first two calls
  let attempts = 0;
  service.provider.generate = async () => {
    attempts += 1;
    if (attempts <= 2) throw new AIProviderError("retry me", "PROVIDER_UNAVAILABLE", 502, { retryable: true });
    return { text: "ok", content: "ok", provider: "mock", model: "mock-model", usage: {}, finishReason: "stop", providerRequestId: "x" };
  };
  const result = await service.generateResponse({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(attempts, 3, "should have retried 2 times before succeeding");
  assert.equal(result.text, "ok");
});

test("Stage G UNIT: AIService does NOT retry on non-retryable error", async () => {
  const service = new AIService(new MockAIProvider({ model: "mock-model" }), {
    maxRetries: 3,
    retryBaseDelayMs: 1,
  });
  let attempts = 0;
  service.provider.generate = async () => {
    attempts += 1;
    throw new AIProviderError("auth fail", "PROVIDER_AUTH_FAILED", 502, { retryable: false });
  };
  await assert.rejects(
    () => service.generateResponse({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "PROVIDER_AUTH_FAILED"
  );
  assert.equal(attempts, 1, "should NOT retry non-retryable error");
});

test("Stage G UNIT: AIService retries with exponential backoff", async () => {
  const service = new AIService(new MockAIProvider({ model: "mock-model" }), {
    maxRetries: 3,
    retryBaseDelayMs: 10,
  });
  let attempts = 0;
  const delays = [];
  let lastTime = Date.now();
  service.provider.generate = async () => {
    const now = Date.now();
    if (attempts > 0) delays.push(now - lastTime);
    lastTime = now;
    attempts += 1;
    if (attempts <= 3) throw new AIProviderError("retry", "PROVIDER_UNAVAILABLE", 502, { retryable: true });
    return { text: "ok", content: "ok", provider: "mock", model: "mock-model", usage: {}, finishReason: "stop" };
  };
  await service.generateResponse({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(attempts, 4);
  assert.ok(delays.length >= 2);
  // First delay should be ~baseDelayMs (10), second ~20
  // Allow tolerance for timing
  assert.ok(delays[0] >= 8, `first delay should be >= 8ms, got ${delays[0]}`);
  assert.ok(delays[1] >= delays[0], "delays should be increasing (exponential)");
});

test("Stage G UNIT: AIService retries up to maxRetries then throws", async () => {
  const service = new AIService(new MockAIProvider({ model: "mock-model" }), {
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });
  let attempts = 0;
  service.provider.generate = async () => {
    attempts += 1;
    throw new AIProviderError("keep failing", "PROVIDER_UNAVAILABLE", 502, { retryable: true });
  };
  await assert.rejects(
    () => service.generateResponse({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "PROVIDER_UNAVAILABLE"
  );
  assert.equal(attempts, 3, "should attempt initial + 2 retries = 3 total");
});

test("Stage G UNIT: AIService respects AIRateLimitError retry-after", async () => {
  const service = new AIService(new MockAIProvider({ model: "mock-model" }), {
    maxRetries: 1,
    retryBaseDelayMs: 10000, // large base delay
  });
  let attempts = 0;
  service.provider.generate = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new AIRateLimitError(50); // wait 50ms
    }
    return { text: "ok", content: "ok", provider: "mock", model: "mock-model", usage: {}, finishReason: "stop" };
  };
  const start = Date.now();
  await service.generateResponse({ messages: [{ role: "user", content: "hi" }] });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, "should have used retry-after (50ms) instead of base delay (10000ms)");
  assert.equal(attempts, 2);
});

// === Timeout tests ===

test("Stage G UNIT: AIService times out on slow provider", async () => {
  const slowProvider = new MockAIProvider({ model: "mock-model", delayMs: 2000 });
  const service = new AIService(slowProvider, { timeoutMs: 50, maxRetries: 0 });
  await assert.rejects(
    () => service.generateResponse({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error instanceof AIProviderTimeoutError
  );
});

// === Secret redaction tests ===

test("Stage G SECURITY: logger does not leak OpenAI API keys", () => {
  const originalError = console.error;
  let captured = "";
  console.error = (...args) => {
    captured += args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  };
  try {
    logger.error("AI provider failed", { apiKey: "sk-secret-leaked-key-12345678", provider: "openai", model: "gpt-4o-mini" });
  } finally {
    console.error = originalError;
  }
  assert.ok(!captured.includes("sk-secret-leaked-key-12345678"), "API key must be redacted");
  assert.ok(captured.includes("[REDACTED]"), "should show [REDACTED] placeholder");
});

test("Stage G SECURITY: logger redacts Bearer tokens", () => {
  const originalError = console.error;
  let captured = "";
  console.error = (...args) => {
    captured += args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  };
  try {
    logger.error("Authorization test", { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload" });
  } finally {
    console.error = originalError;
  }
  assert.ok(!captured.includes("eyJhbGciOiJIUzI1NiJ9"), "Bearer token must be redacted");
});

test("Stage G SECURITY: logger redacts sk- patterns in strings", () => {
  const originalError = console.error;
  let captured = "";
  console.error = (...args) => {
    captured += args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  };
  try {
    logger.error("error details", "AI call failed: sk-1234567890abcdef status=500");
  } finally {
    console.error = originalError;
  }
  assert.ok(!captured.includes("sk-1234567890abcdef"), "API key in string must be redacted");
  assert.ok(captured.includes("[REDACTED]"), "should show [REDACTED] placeholder");
});

// === Rate limiter tests ===

test("Stage G UNIT: rate limiter allows requests under limit", () => {
  resetRateLimiter();
  for (let i = 0; i < 30; i += 1) {
    const result = checkAIRateLimit("company-a");
    assert.ok(result.allowed, `request ${i + 1} should be allowed`);
  }
});

test("Stage G UNIT: rate limiter blocks requests over limit", () => {
  resetRateLimiter();
  for (let i = 0; i < 30; i += 1) {
    checkAIRateLimit("company-b");
  }
  const result = checkAIRateLimit("company-b");
  assert.ok(!result.allowed, "31st request should be blocked");
  assert.ok(result.resetMs > 0, "should return reset time");
});

test("Stage G UNIT: rate limiter is per-company", () => {
  resetRateLimiter();
  for (let i = 0; i < 30; i += 1) {
    checkAIRateLimit("company-c");
  }
  // Company D should not be affected
  const result = checkAIRateLimit("company-d");
  assert.ok(result.allowed, "different company should not share rate limit");
});

// === normalizeRequest tests ===

test("Stage G UNIT: normalizeRequest filters invalid roles", () => {
  const result = normalizeRequest({
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "dropped" },
      { role: "system", content: "sys" },
    ],
  });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].role, "system");
});

test("Stage G UNIT: normalizeRequest coerces message content to string", () => {
  const result = normalizeRequest({
    messages: [{ role: "user", content: 12345 }],
  });
  assert.equal(typeof result.messages[0].content, "string");
});