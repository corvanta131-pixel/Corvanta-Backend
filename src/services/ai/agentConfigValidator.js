const AppError = require("../../utils/AppError");
const config = require("../../config/config");

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeModel(value) {
  return String(value || "").trim();
}

function validateAgentRuntimeConfig(agent = {}) {
  const provider = normalizeProvider(agent.provider);
  const model = normalizeModel(agent.model);

  if (!provider) {
    throw new AppError(400, "AI agent provider is required.");
  }
  if (!config.AI_ALLOWED_PROVIDERS.includes(provider)) {
    throw new AppError(400, `AI provider '${provider}' is not allowed by server policy.`);
  }
  if (!model) {
    throw new AppError(400, "AI agent model is required.");
  }
  if (!config.AI_ALLOWED_GENERATION_MODELS.includes(model)) {
    throw new AppError(400, `AI model '${model}' is not allowed by server policy.`);
  }
  if (typeof agent.temperature === "number" && (agent.temperature < 0 || agent.temperature > 2)) {
    throw new AppError(400, "Temperature must be between 0 and 2.");
  }
  if (Number.isInteger(agent.maxTokens) && (agent.maxTokens < 1 || agent.maxTokens > config.AI_MAX_OUTPUT_TOKENS)) {
    throw new AppError(400, `maxTokens must be an integer between 1 and ${config.AI_MAX_OUTPUT_TOKENS}.`);
  }
  return { provider, model };
}

module.exports = { validateAgentRuntimeConfig, normalizeProvider, normalizeModel };
