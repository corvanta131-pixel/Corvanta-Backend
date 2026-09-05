const { AIService, MockAIProvider, AIProvider, AIProviderError } = require("./aiService");
const { OpenAIProvider } = require("./openaiProvider");
const config = require("../../config/config");

function isPlaceholderOpenAIKey(apiKey) {
  return !apiKey
    || apiKey === "development-placeholder-openai-key"
    || apiKey === "development-placeholder-ai-key";
}

function createProvider(providerName = config.AI_PROVIDER, options = {}) {
  const name = String(providerName || "").toLowerCase();
  if (name === "mock" || name === "") {
    return new MockAIProvider({ model: options.model || "mock-model" });
  }
  if (name === "openai") {
    return new OpenAIProvider({
      apiKey: options.apiKey || config.OPENAI_API_KEY,
      organization: options.organization || config.OPENAI_ORGANIZATION,
      model: options.model || "gpt-4o-mini",
      timeoutMs: options.timeoutMs || config.AI_PROVIDER_TIMEOUT_MS,
    });
  }
  throw new AIProviderError(`Unsupported AI provider: ${providerName}`, "PROVIDER_NOT_SUPPORTED", 400);
}

function createAIService(providerName = config.AI_PROVIDER, options = {}) {
  const provider = options.provider || createProvider(providerName, options);
  return new AIService(provider, { timeoutMs: options.timeoutMs || config.AI_PROVIDER_TIMEOUT_MS });
}

module.exports = {
  createProvider,
  createAIService,
  isPlaceholderOpenAIKey,
  AIProvider,
  MockAIProvider,
  OpenAIProvider,
  AIService,
};
