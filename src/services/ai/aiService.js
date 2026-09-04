const config = require("../../config/config");

class AIProviderError extends Error {
  constructor(message = "AI provider request failed.", code = "PROVIDER_ERROR", statusCode = 502, options = {}) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = Boolean(options.retryable);
    this.isOperational = true;
  }
}

class AIProviderTimeoutError extends AIProviderError {
  constructor() {
    super("AI provider request timed out.", "PROVIDER_TIMEOUT", 504, { retryable: true });
    this.name = "AIProviderTimeoutError";
  }
}

class AIRateLimitError extends AIProviderError {
  constructor() {
    super("AI provider rate limit reached.", "PROVIDER_RATE_LIMIT", 429, { retryable: true });
    this.name = "AIRateLimitError";
  }
}

function normalizeRequest(payload = {}) {
  const legacyPrompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const normalizedMessages = messages
    .filter((message) => message && ["system", "user", "assistant"].includes(message.role))
    .map((message) => ({ role: message.role, content: String(message.content || "") }));

  if (legacyPrompt && !normalizedMessages.some((message) => message.role === "user" && message.content === legacyPrompt)) {
    normalizedMessages.push({ role: "user", content: legacyPrompt });
  }

  return {
    systemPrompt: String(payload.systemPrompt || ""),
    messages: normalizedMessages,
    context: Array.isArray(payload.context) ? payload.context : [],
    temperature: typeof payload.temperature === "number" ? payload.temperature : 0.2,
    maxTokens: Number.isInteger(payload.maxTokens) ? payload.maxTokens : 512,
  };
}

class AIProvider {
  constructor({ provider = "unknown", model = "unknown" } = {}) {
    this.provider = provider;
    this.model = model;
  }

  async generate() {
    throw new AIProviderError("AI provider is not configured.", "PROVIDER_NOT_IMPLEMENTED", 501);
  }

  async generateResponse(request) {
    return this.generate(normalizeRequest(request));
  }
}

class MockAIProvider extends AIProvider {
  constructor(options = {}) {
    super({ provider: "mock", model: options.model || "mock-model" });
    this.provider = "mock";
    this.model = options.model || "mock-model";
    this.delayMs = Number(options.delayMs || 0);
  }

  async generate(request = {}) {
    const normalized = normalizeRequest(request);
    const userMessage = [...normalized.messages].reverse().find((message) => message.role === "user");
    const prompt = userMessage ? userMessage.content : "";

    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (prompt.includes("__AI_PROVIDER_TIMEOUT__")) throw new AIProviderTimeoutError();
    if (prompt.includes("__AI_PROVIDER_RATE_LIMIT__")) throw new AIRateLimitError();
    if (prompt.includes("__AI_PROVIDER_FAILURE__")) throw new AIProviderError("AI provider is unavailable.", "PROVIDER_UNAVAILABLE", 502, { retryable: true });

    const text = `Mock AI response generated for: ${prompt}`;
    const promptTokens = Math.ceil((normalized.systemPrompt.length + normalized.messages.reduce((sum, item) => sum + item.content.length, 0)) / 4);
    const completionTokens = Math.ceil(text.length / 4);
    return {
      text,
      content: text,
      provider: this.provider,
      model: this.model,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      tokenMetadata: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      finishReason: "stop",
      providerRequestId: `mock-${Buffer.from(prompt).toString("base64url").slice(0, 24)}`,
    };
  }

  async generateResponse(payload) {
    return this.generate(payload);
  }
}

class AIService {
  constructor(provider = new MockAIProvider(), options = {}) {
    this.provider = provider;
    this.timeoutMs = Number(options.timeoutMs || config.AI_PROVIDER_TIMEOUT_MS || 10000);
  }

  async generateResponse(payload = {}) {
    const request = normalizeRequest(payload);
    let timeout;
    try {
      const providerRequest = this.provider.generate
        ? this.provider.generate(request)
        : this.provider.generateResponse(request);
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new AIProviderTimeoutError()), this.timeoutMs);
      });
      const result = await Promise.race([providerRequest, timeoutPromise]);
      clearTimeout(timeout);
      const text = String(result?.text || result?.content || "");
      if (!text) throw new AIProviderError("AI provider returned an empty response.", "EMPTY_RESPONSE", 502);
      return {
        text,
        content: text,
        provider: String(result.provider || "unknown"),
        model: String(result.model || "unknown"),
        usage: result.usage || result.tokenMetadata || {},
        tokenMetadata: result.tokenMetadata || result.usage || {},
        finishReason: result.finishReason || "stop",
        providerRequestId: result.providerRequestId || null,
      };
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError("AI provider request failed.", "PROVIDER_ERROR", 502, { retryable: true });
    }
  }

  async generate(payload = {}) {
    return this.generateResponse(payload);
  }
}

const defaultAIService = new AIService(new MockAIProvider({ model: "mock-model" }));

module.exports = {
  AIProviderError,
  AIProviderTimeoutError,
  AIRateLimitError,
  AIProvider,
  AIService,
  MockAIProvider,
  normalizeRequest,
  defaultAIService,
};
