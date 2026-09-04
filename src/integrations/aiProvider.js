const {
  AIService,
  MockAIProvider,
  AIProviderError,
  AIProviderTimeoutError,
  AIRateLimitError,
  defaultAIService,
} = require("../services/ai/aiService");
const { AIProvider } = require("../services/ai/aiProvider");

module.exports = {
  AIService,
  MockAIProvider,
  AIProviderError,
  AIProviderTimeoutError,
  AIRateLimitError,
  AIProvider,
  defaultAIService,
  createAIProvider: (options = {}) => new AIService(new MockAIProvider(options), options),
};
