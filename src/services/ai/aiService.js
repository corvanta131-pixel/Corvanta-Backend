class MockAIProvider {
  async generateResponse({ prompt, systemPrompt = "", context = [] }) {
    return {
      content: `Mock AI response generated for: ${prompt}`,
      provider: "mock",
      systemPrompt,
      contextCount: context.length,
    };
  }
}

class AIService {
  constructor(provider) {
    this.provider = provider || new MockAIProvider();
  }

  async generateResponse(payload) {
    return this.provider.generateResponse(payload);
  }
}

module.exports = {
  AIService,
  MockAIProvider,
  defaultAIService: new AIService(new MockAIProvider()),
};
