const { SQSClient } = require("@aws-sdk/client-sqs");

class SQSError extends Error {
  constructor(message = "SQS request failed.", code = "SQS_ERROR", options = {}) {
    super(message);
    this.name = "SQSError";
    this.code = code;
    this.statusCode = options.statusCode || 502;
    this.retryable = Boolean(options.retryable);
    this.isOperational = true;
  }
}

class SQSAuthError extends SQSError {
  constructor() {
    super("SQS authentication failed.", "SQS_AUTH", { statusCode: 401, retryable: false });
    this.name = "SQSAuthError";
  }
}

class SQSConfigError extends SQSError {
  constructor(message = "SQS is not configured.") {
    super(message, "SQS_CONFIG", { statusCode: 400, retryable: false });
    this.name = "SQSConfigError";
  }
}

class SQSTimeoutError extends SQSError {
  constructor() {
    super("SQS request timed out.", "SQS_TIMEOUT", { statusCode: 504, retryable: true });
    this.name = "SQSTimeoutError";
  }
}

class SQSUnavailableError extends SQSError {
  constructor() {
    super("SQS is currently unavailable.", "SQS_UNAVAILABLE", { statusCode: 503, retryable: true });
    this.name = "SQSUnavailableError";
  }
}

class SQSValidationError extends SQSError {
  constructor(message = "Invalid SQS request.") {
    super(message, "SQS_VALIDATION", { statusCode: 400, retryable: false });
    this.name = "SQSValidationError";
  }
}

function normalizeSQSError(error) {
  if (error && error.code === "SQS_AUTH") return new SQSAuthError();
  if (error && error.code === "SQS_TIMEOUT") return new SQSTimeoutError();
  if (error && error.code === "SQS_UNAVAILABLE") return new SQSUnavailableError();
  if (error && error.code === "SQS_VALIDATION") return new SQSValidationError(error.message);
  if (error && error.code === "SQS_CONFIG") return new SQSConfigError(error.message);
  if (error && error.name === "SQSError") return error;
  const message = (error && error.message) || "SQS request failed.";
  const lower = String(message).toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("connect timeout") || lower.includes("socket timeout")) return new SQSTimeoutError();
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("network") || lower.includes("unavailable")) {
    return new SQSUnavailableError();
  }
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("accessdenied") || lower.includes("invalidclienttokenid")) {
    return new SQSAuthError();
  }
  if (lower.includes("awsaccesskeyid") || lower.includes("secretaccesskey")) {
    return new SQSAuthError();
  }
  return new SQSError(message, "SQS_ERROR", 502, { retryable: true });
}

function isConfigured(options = {}) {
  const queueUrl = options.queueUrl || process.env.SQS_QUEUE_URL;
  const region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  return Boolean(queueUrl && String(queueUrl).trim() && region && String(region).trim());
}

function assertConfigured(options = {}) {
  if (!isConfigured(options)) {
    throw new SQSConfigError("SQS is not configured. Set SQS_QUEUE_URL and AWS_REGION to use the SQS queue provider.");
  }
}

function assertJob(job) {
  if (!job || typeof job !== "object") {
    throw new SQSValidationError("Queue job must be a non-empty object.");
  }
  if (!job.type) {
    throw new SQSValidationError("Queue job requires a non-empty type.");
  }
  const cid = job.companyId || job.cid;
  if (cid === undefined || cid === null || String(cid).trim() === "") {
    throw new SQSValidationError("Queue job requires a non-empty cid.");
  }
}

module.exports = {
  SQSError,
  SQSAuthError,
  SQSConfigError,
  SQSTimeoutError,
  SQSUnavailableError,
  SQSValidationError,
  normalizeSQSError,
  isConfigured,
  assertConfigured,
  assertJob,
};
