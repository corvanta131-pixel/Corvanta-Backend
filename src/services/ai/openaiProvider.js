const { AIProvider, AIProviderError, AIProviderTimeoutError, AIRateLimitError, AIContextLengthExceededError, AIModelUnavailableError } = require("./aiService");

class OpenAIProvider extends AIProvider {
  constructor(options = {}) {
    super({ provider: "openai", model: options.model || "gpt-4o-mini" });
    this.apiKey = options.apiKey || "";
    this.organization = options.organization || "";
    this.model = options.model || "gpt-4o-mini";
    this.timeoutMs = Number(options.timeoutMs || 10000);
    this.client = null;
    this.initialized = false;
    this.initializationError = null;
  }

  _ensureClient() {
    if (this.initialized) return;
    this.initialized = true;
    const placeholder = !this.apiKey
      || this.apiKey === "development-placeholder-openai-key"
      || this.apiKey === "development-placeholder-ai-key";
    if (placeholder) {
      this.initializationError = new AIProviderError(
        "OpenAI provider is not configured: missing API key.",
        "PROVIDER_NOT_CONFIGURED",
        503
      );
      return;
    }
    try {
      const OpenAI = require("openai");
      const clientOptions = { apiKey: this.apiKey, timeout: this.timeoutMs };
      if (this.organization) clientOptions.organization = this.organization;
      this.client = new OpenAI(clientOptions);
    } catch (error) {
      this.initializationError = new AIProviderError(
        "OpenAI provider failed to initialize.",
        "PROVIDER_INIT_FAILED",
        503
      );
    }
  }

  _normalizeUpstreamError(error) {
    if (!error) {
      return new AIProviderError("AI provider request failed.", "PROVIDER_ERROR", 502, { retryable: true });
    }
    const status = Number(error.status || 0);
    const code = String(error.code || "");
    const message = String(error.message || "");

    if (code === "ETIMEDOUT" || status === 408) {
      return new AIProviderTimeoutError();
    }
    if (status === 429) {
      const retryAfterMs = Number(error.headers && error.headers["retry-after"]) * 1000 || 0;
      return new AIRateLimitError(retryAfterMs);
    }
    if (status === 400 && /context[-_ ]length|maximum context|tokens?/i.test(message)) {
      return new AIContextLengthExceededError();
    }
    if (status === 401 || status === 403) {
      return new AIProviderError("OpenAI authentication failed.", "PROVIDER_AUTH_FAILED", 502, { retryable: false });
    }
    if (status === 404 || (status === 400 && /model/i.test(message) && /not[-_ ]?(found|exist)/i.test(message))) {
      return new AIModelUnavailableError();
    }
    if (status >= 500 || code === "ECONNRESET" || code === "ENOTFOUND" || code === "ECONNREFUSED") {
      return new AIProviderError("OpenAI provider is unavailable.", "PROVIDER_UNAVAILABLE", 502, { retryable: true });
    }
    if (code === "PROVIDER_ERROR" && status === 0) {
      return new AIProviderError("OpenAI provider is unavailable.", "PROVIDER_UNAVAILABLE", 502, { retryable: true });
    }
    return new AIProviderError("AI provider request failed.", "PROVIDER_ERROR", 502, { retryable: true });
  }

  async generate(request = {}) {
    this._ensureClient();
    if (this.initializationError) throw this.initializationError;
    const messages = [];
    if (request.systemPrompt) messages.push({ role: "system", content: String(request.systemPrompt) });
    const history = Array.isArray(request.messages) ? request.messages : [];
    for (const message of history) {
      if (message && ["system", "user", "assistant"].includes(message.role) && message.content) {
        messages.push({ role: message.role, content: String(message.content) });
      }
    }
    if (!messages.some((message) => message.role === "user")) {
      throw new AIProviderError("OpenAI request requires at least one user message.", "EMPTY_PROMPT", 400, { retryable: false });
    }
    const params = {
      model: this.model,
      messages,
      temperature: typeof request.temperature === "number" ? request.temperature : 0.2,
      max_tokens: Number.isInteger(request.maxTokens) ? request.maxTokens : 512,
    };
    let response;
    try {
      response = await this.client.chat.completions.create(params);
    } catch (error) {
      throw this._normalizeUpstreamError(error);
    }
    if (!response || typeof response !== "object") {
      throw new AIProviderError("OpenAI returned a malformed response.", "MALFORMED_RESPONSE", 502, { retryable: true });
    }
    const choice = response.choices && response.choices[0];
    if (!choice || !choice.message || typeof choice.message.content !== "string") {
      throw new AIProviderError("OpenAI returned a malformed response.", "MALFORMED_RESPONSE", 502, { retryable: true });
    }
    const text = choice.message.content;
    if (!text) throw new AIProviderError("OpenAI returned an empty response.", "EMPTY_RESPONSE", 502, { retryable: false });
    const usage = response.usage || {};
    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);
    return {
      text,
      content: text,
      provider: this.provider,
      model: this.model,
      usage: { promptTokens, completionTokens, totalTokens, raw: usage },
      tokenMetadata: { promptTokens, completionTokens, totalTokens },
      finishReason: choice.finish_reason ? String(choice.finish_reason) : "stop",
      providerRequestId: response.id ? String(response.id) : null,
    };
  }
}

module.exports = { OpenAIProvider };