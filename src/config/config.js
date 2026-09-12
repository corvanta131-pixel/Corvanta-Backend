const dotenv = require("dotenv");

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";
const isDevelopment = !isProduction && !isTest;

const config = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || 5000),
  isProduction,
  isDevelopment,
  isTest,
  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/corvanta_dev",
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || "development-placeholder-change-this",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "development-placeholder-change-this",
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",
  CORS_ORIGINS: (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  RESEND_API_KEY: process.env.RESEND_API_KEY || "development-placeholder-resend-key",
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "development-placeholder-cloud-name",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "development-placeholder-cloud-key",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "development-placeholder-cloud-secret",
  AI_API_KEY: process.env.AI_API_KEY || "development-placeholder-ai-key",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "development-placeholder-openai-key",
  OPENAI_ORGANIZATION: process.env.OPENAI_ORGANIZATION || "",
  AI_PROVIDER: process.env.AI_PROVIDER || "mock",
  AI_PROVIDER_TIMEOUT_MS: Number(process.env.AI_PROVIDER_TIMEOUT_MS || 10000),
  AI_MAX_RETRIES: Number(process.env.AI_MAX_RETRIES || 2),
  AI_RETRY_BASE_DELAY_MS: Number(process.env.AI_RETRY_BASE_DELAY_MS || 1000),
  AI_MAX_PROMPT_CHARS: Number(process.env.AI_MAX_PROMPT_CHARS || 60000),
  AI_MAX_CONTEXT_DOCUMENTS: Number(process.env.AI_MAX_CONTEXT_DOCUMENTS || 10),
  AI_USER_MESSAGE_MAX_CHARS: Number(process.env.AI_USER_MESSAGE_MAX_CHARS || 20000),
  AI_HISTORY_MESSAGE_LIMIT: Number(process.env.AI_HISTORY_MESSAGE_LIMIT || 20),
  AI_CONTEXT_DOCUMENT_LIMIT: Number(process.env.AI_CONTEXT_DOCUMENT_LIMIT || 5),
  AI_CONTEXT_MAX_CHARS: Number(process.env.AI_CONTEXT_MAX_CHARS || 12000),
  AI_MESSAGE_LIST_LIMIT: Number(process.env.AI_MESSAGE_LIST_LIMIT || 50),
  AI_MAX_OUTPUT_TOKENS: Number(process.env.AI_MAX_OUTPUT_TOKENS || 1024),
  AI_ALLOWED_PROVIDERS: (process.env.AI_ALLOWED_PROVIDERS || "mock,openai")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  AI_ALLOWED_GENERATION_MODELS: (process.env.AI_ALLOWED_GENERATION_MODELS
    || "mock-model,gpt-4o-mini,gpt-4o,gpt-4.1-mini,gpt-3.5-turbo")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  AI_ALLOWED_EMBEDDING_MODELS: (process.env.AI_ALLOWED_EMBEDDING_MODELS
    || "mock-embedding-model,text-embedding-3-small,text-embedding-3-large")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  AI_DEFAULT_EMBEDDING_MODEL: process.env.AI_DEFAULT_EMBEDDING_MODEL || "text-embedding-3-small",
  AI_DEFAULT_EMBEDDING_DIMENSIONS: Number(process.env.AI_DEFAULT_EMBEDDING_DIMENSIONS || 1536),
  AI_EMBEDDING_PROVIDER: process.env.AI_EMBEDDING_PROVIDER || "mock",
  CHUNK_SIZE_CHARS: Number(process.env.CHUNK_SIZE_CHARS || 1200),
  CHUNK_OVERLAP_CHARS: Number(process.env.CHUNK_OVERLAP_CHARS || 200),
  CHUNK_MAX_CHARS: Number(process.env.CHUNK_MAX_CHARS || 4000),
  API_RATE_LIMIT_WINDOW_MS: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60000),
  API_RATE_LIMIT_MAX: Number(process.env.API_RATE_LIMIT_MAX || 120),
  AUTH_RATE_LIMIT_WINDOW_MS: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 600000),
  AUTH_RATE_LIMIT_MAX: Number(process.env.AUTH_RATE_LIMIT_MAX || 10),
};

function validateStartupConfig() {
  const required = ["MONGO_URI", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"];

  for (const key of required) {
    if (!config[key]) {
      throw new Error(`${key} is required but was not provided.`);
    }
  }

  if (config.NODE_ENV === "production") {
    const placeholders = [
      "development-placeholder-change-this",
      "development-placeholder-resend-key",
      "development-placeholder-cloud-name",
      "development-placeholder-cloud-key",
      "development-placeholder-cloud-secret",
      "development-placeholder-ai-key",
      "development-placeholder-openai-key",
    ];

    for (const placeholder of placeholders) {
      if ([
        config.JWT_ACCESS_SECRET,
        config.JWT_REFRESH_SECRET,
        config.RESEND_API_KEY,
        config.CLOUDINARY_CLOUD_NAME,
        config.CLOUDINARY_API_KEY,
        config.CLOUDINARY_API_SECRET,
        config.AI_API_KEY,
        config.OPENAI_API_KEY,
      ].includes(placeholder)) {
        throw new Error("Production validation failed: replace development placeholder values before starting in production.");
      }
    }
  }
}

validateStartupConfig();

module.exports = config;
