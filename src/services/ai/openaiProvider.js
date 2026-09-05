const { AIProvider, AIProviderError, AIProviderTimeoutError, AIRateLimitError } = require("./aiService");

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
      throw new AIProviderError("OpenAI request requires at least one user message.", "EMPTY_PROMPT", 400);
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
      if (error && error.code === "ETIMEDOUT") throw new AIProviderTimeoutError();
      if (error && error.status === 429) throw new AIRateLimitError();
      if (error && (error.status >= 500 || error.code === "ECONNRESET" || error.code === "ENOTFOUND")) {
        throw new AIProviderError("OpenAI provider is unavailable.", "PROVIDER_UNAVAILABLE", 502, { retryable: true });
      }
      throw new AIProviderError("AI provider request failed.", "PROVIDER_ERROR", 502, { retryable: true });
    }
    const choice = response && response.choices && response.choices[0];
    const text = choice && choice.message && choice.message.content ? String(choice.message.content) : "";
    if (!text) throw new AIProviderError("AI provider returned an empty response.", "EMPTY_RESPONSE", 502);
    const usage = response && response.usage ? response.usage : {};
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
      finishReason: choice && choice.finish_reason ? String(choice.finish_reason) : "stop",
      providerRequestId: response && response.id ? String(response.id) : null,
    };
  }
}

module.exports = { OpenAIProvider };
