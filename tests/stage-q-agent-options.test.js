process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/corvanta-test";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "test-access-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const src = path.join(__dirname, "..", "src");
const config = require(path.join(src, "config", "config.js"));
const { getAgentOptions } = require(path.join(src, "services", "agentOptionsService.js"));

function withConfig(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = config[key];
    config[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    Object.assign(config, saved);
  }
}

test("options come from server policy and expose no secrets", () => {
  const options = withConfig(
    {
      AI_ALLOWED_PROVIDERS: ["mock", "openai"],
      AI_ALLOWED_GENERATION_MODELS: ["mock-model", "gpt-4o-mini"],
      AI_MAX_OUTPUT_TOKENS: 800,
      OPENAI_API_KEY: "sk-live-secret-value",
    },
    () => getAgentOptions()
  );
  assert.deepEqual(options.providers.map((p) => p.id), ["mock", "openai"]);
  assert.deepEqual(options.models, [
    { id: "mock-model", provider: "mock" },
    { id: "gpt-4o-mini", provider: "openai" },
  ]);
  assert.equal(options.limits.maxTokens.max, 800);
  assert.equal(JSON.stringify(options).includes("sk-live-secret-value"), false, "the API key must never be returned");
});

test("OpenAI is reported as configured only when a real key is present", () => {
  const configured = withConfig({ OPENAI_API_KEY: "sk-real" }, () => getAgentOptions().providers.find((p) => p.id === "openai"));
  assert.equal(configured.configured, true);

  for (const placeholder of ["development-placeholder-openai-key", "development-placeholder-ai-key", ""]) {
    const result = withConfig({ OPENAI_API_KEY: placeholder }, () => getAgentOptions().providers.find((p) => p.id === "openai"));
    assert.equal(result.configured, false, `placeholder ${JSON.stringify(placeholder)}`);
  }
  assert.equal(getAgentOptions().providers.find((p) => p.id === "mock").configured, true);
});

test("providers outside the server allow-list are not offered", () => {
  const options = withConfig({ AI_ALLOWED_PROVIDERS: ["mock"] }, () => getAgentOptions());
  assert.deepEqual(options.providers.map((p) => p.id), ["mock"]);
});

test("limits match the validators the server enforces", () => {
  const { limits, defaults } = getAgentOptions();
  assert.deepEqual(limits.temperature, { min: 0, max: 2 });
  assert.deepEqual(limits.nameLength, { min: 2, max: 120 });
  assert.equal(limits.promptTemplateMax, 20000);
  assert.equal(limits.descriptionMax, 2000);
  assert.ok(defaults.temperature >= limits.temperature.min && defaults.temperature <= limits.temperature.max);
  assert.ok(defaults.maxTokens <= Math.max(limits.maxTokens.max, defaults.maxTokens));
});