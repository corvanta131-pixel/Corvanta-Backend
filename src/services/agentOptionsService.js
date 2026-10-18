const config = require("../config/config");
const { isPlaceholderOpenAIKey } = require("./ai/providerRegistry");

const PROVIDER_LABELS = { mock: "Test mode (no real AI)", openai: "OpenAI" };

/**
 * What a dashboard may offer when configuring an agent. Everything comes from server policy, so the
 * UI never has to guess which providers or models are allowed.
 *
 * `configured` tells the UI whether the provider can actually answer right now. OpenAI needs a real
 * API key on the server; an agent set to an unconfigured provider will fail when it tries to reply.
 * A model's provider is derived from its name (the server keeps one flat allow-list of models).
 */
function getAgentOptions() {
  const providers = config.AI_ALLOWED_PROVIDERS.map((id) => ({
    id,
    label: PROVIDER_LABELS[id] || id,
    configured: id === "mock" ? true : id === "openai" ? !isPlaceholderOpenAIKey(config.OPENAI_API_KEY) : false,
  }));

  const models = config.AI_ALLOWED_GENERATION_MODELS.map((id) => ({
    id,
    provider: id === "mock-model" ? "mock" : "openai",
  }));

  return {
    providers,
    models,
    defaults: { temperature: 0.2, maxTokens: 512 },
    limits: {
      temperature: { min: 0, max: 2 },
      maxTokens: { min: 1, max: config.AI_MAX_OUTPUT_TOKENS },
      nameLength: { min: 2, max: 120 },
      descriptionMax: 2000,
      promptTemplateMax: 20000,
    },
  };
}

module.exports = { getAgentOptions };