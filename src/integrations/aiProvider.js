const { AIService, MockAIProvider } = require("../services/ai/aiService");

module.exports = {
  AIService,
  MockAIProvider,
  createAIProvider: () => new AIService(new MockAIProvider()),
};
