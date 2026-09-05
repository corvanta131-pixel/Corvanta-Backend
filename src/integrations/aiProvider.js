const {
  AIService,
  MockAIProvider,
  AIProviderError,
  AIProviderTimeoutError,
  AIRateLimitError,
  defaultAIService,
} = require("../services/ai/aiService");
const { AIProvider } = require("../services/ai/aiProvider");
const { OpenAIProvider } = require("../services/ai/openaiProvider");
const {
  createProvider,
  createAIService,
  isPlaceholderOpenAIKey,
} = require("../services/ai/providerRegistry");

module.exports = {
  AIService,
  MockAIProvider,
  OpenAIProvider,
  AIProviderError,
  AIProviderTimeoutError,
  AIRateLimitError,
  AIProvider,
  defaultAIService,
  createProvider,
  createAIService,
  isPlaceholderOpenAIKey,
  createAIProvider: (options = {}) => new AIService(new MockAIProvider(options), options),
};
