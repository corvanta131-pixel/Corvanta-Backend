const crypto = require("crypto");
const { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, PurgeQueueCommand, GetQueueAttributesCommand } = require("@aws-sdk/client-sqs");
const { Queue } = require("../queue");
const {
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
} = require("./sqsError");

const DEFAULT_VISIBILITY_TIMEOUT = 30;
const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_MAX_NUMBER_OF_MESSAGES = 1;

class SQSQueue extends Queue {
  constructor(options = {}) {
    super();
    this.name = options.name || "sqs";
    this.queueUrl = options.queueUrl || process.env.SQS_QUEUE_URL || "";
    this.region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
    this.visibilityTimeout = Number(options.visibilityTimeout || process.env.SQS_VISIBILITY_TIMEOUT || DEFAULT_VISIBILITY_TIMEOUT);
    this.waitTimeSeconds = Number(options.waitTimeSeconds || process.env.SQS_WAIT_TIME_SECONDS || DEFAULT_WAIT_TIME_SECONDS);
    this.maxNumberOfMessages = Number(options.maxNumberOfMessages || process.env.SQS_MAX_NUMBER_OF_MESSAGES || DEFAULT_MAX_NUMBER_OF_MESSAGES);
    this.client = options.client || null;
    this.httpAdapter = options.httpAdapter || null;
    this._handlers = new Map();
    this._draining = false;
    this._closed = false;
  }

  _getClient() {
    if (this.client) return this.client;
    const config = {
      region: this.region,
      maxAttempts: 3,
    };
    return new SQSClient(config);
  }

  _serialize(job) {
    const payload = {
      id: job.jobId || `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      type: String(job.type || ""),
      documentId: job.documentId ? String(job.documentId) : undefined,
      cid: String(job.companyId || job.cid || ""),
      knowledgeBaseId: job.knowledgeBaseId ? String(job.knowledgeBaseId) : undefined,
      embeddingProviderName: job.embeddingProviderName ? String(job.embeddingProviderName) : undefined,
      embeddingModel: job.embeddingModel ? String(job.embeddingModel) : undefined,
      embeddingDimensions: job.embeddingDimensions ? Number(job.embeddingDimensions) : undefined,
      chunkSize: job.chunkSize ? Number(job.chunkSize) : undefined,
      chunkOverlap: job.chunkOverlap ? Number(job.chunkOverlap) : undefined,
      chunkMax: job.chunkMax ? Number(job.chunkMax) : undefined,
      createdAt: new Date().toISOString(),
    };
    return JSON.stringify(payload);
  }

  _parseMessage(body) {
    if (!body) throw new SQSValidationError("SQS message body is empty.");
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new SQSValidationError("SQS message body is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new SQSValidationError("SQS message body is not an object.");
    }
    if (!parsed.type) throw new SQSValidationError("SQS message is missing type.");
    if (parsed.cid === undefined || parsed.cid === null || String(parsed.cid).trim() === "") {
      throw new SQSValidationError("SQS message is missing cid.");
    }
    return parsed;
  }

  async _invoke(operation, input) {
    assertConfigured({ queueUrl: this.queueUrl, region: this.region });
    if (this.httpAdapter) {
      try {
        return await this.httpAdapter({ operation, input, queueUrl: this.queueUrl, region: this.region });
      } catch (error) {
        if (error && error.code) throw error;
        throw normalizeSQSError(error);
      }
    }
    const client = this._getClient();
    const command = this._buildCommand(operation, input);
    try {
      return await client.send(command);
    } catch (error) {
      throw normalizeSQSError(error);
    }
  }

  _buildCommand(operation, input) {
    switch (operation) {
      case "sendMessage":
        return new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: input.body, MessageAttributes: input.attributes });
      case "receiveMessage":
        return new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: this.maxNumberOfMessages, WaitTimeSeconds: this.waitTimeSeconds, VisibilityTimeout: this.visibilityTimeout });
      case "deleteMessage":
        return new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: input.receiptHandle });
      case "changeMessageVisibility":
        return new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: input.receiptHandle, VisibilityTimeout: input.visibilityTimeout });
      case "purgeQueue":
        return new PurgeQueueCommand({ QueueUrl: this.queueUrl });
      case "getQueueAttributes":
        return new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] });
      default:
        throw new SQSValidationError(`Unsupported SQS operation: ${operation}`);
    }
  }

  async enqueue(job) {
    assertJob(job);
    const body = this._serialize(job);
    const attributes = {
      cid: { StringValue: String(job.companyId || job.cid || ""), DataType: "String" },
      type: { StringValue: String(job.type || ""), DataType: "String" },
      documentId: { StringValue: job.documentId ? String(job.documentId) : "", DataType: "String" },
    };
    const result = await this._invoke("sendMessage", { body, attributes });
    return result.MessageId || `sqs:${result.MessageId || "unknown"}`;
  }

  async dequeue() {
    if (this._closed) return null;
    const result = await this._invoke("receiveMessage", {});
    const messages = result.Messages || [];
    if (!messages.length) return null;
    const message = messages[0];
    let parsed;
    try {
      parsed = this._parseMessage(message.Body);
    } catch (error) {
      await this._safeDelete(message.ReceiptHandle);
      return null;
    }
    return {
      id: parsed.id || `sqs:${message.MessageId || message.ReceiptHandle || `job_${Date.now()}`}`,
      type: parsed.type,
      documentId: parsed.documentId,
      cid: parsed.cid,
      knowledgeBaseId: parsed.knowledgeBaseId,
      embeddingProviderName: parsed.embeddingProviderName,
      embeddingModel: parsed.embeddingModel,
      embeddingDimensions: parsed.embeddingDimensions,
      chunkSize: parsed.chunkSize,
      chunkOverlap: parsed.chunkOverlap,
      chunkMax: parsed.chunkMax,
      createdAt: parsed.createdAt,
      receiptHandle: message.ReceiptHandle,
      approximateReceiveCount: message.Attributes && message.Attributes.ApproximateReceiveCount ? Number(message.Attributes.ApproximateReceiveCount) : 1,
    };
  }

  async ack(jobId) {
    if (!jobId) throw new SQSValidationError("ack requires a non-empty job id.");
    const receiptHandle = typeof jobId === "object" && jobId.receiptHandle ? jobId.receiptHandle : jobId;
    if (!receiptHandle) throw new SQSValidationError("ack requires a receipt handle.");
    await this._invoke("deleteMessage", { receiptHandle });
    return true;
  }

  async retry(jobId, delayMs = 1000) {
    const receiptHandle = typeof jobId === "object" && jobId.receiptHandle ? jobId.receiptHandle : jobId;
    if (!receiptHandle) throw new SQSValidationError("retry requires a receipt handle.");
    const visibilityTimeout = Math.max(1, Math.ceil(Number(delayMs) / 1000));
    await this._invoke("changeMessageVisibility", { receiptHandle, visibilityTimeout });
    return true;
  }

  async fail(jobId, error) {
    const receiptHandle = typeof jobId === "object" && jobId.receiptHandle ? jobId.receiptHandle : jobId;
    if (!receiptHandle) throw new SQSValidationError("fail requires a receipt handle.");
    const message = error && error.message ? error.message : "Job failed.";
    await this._invoke("changeMessageVisibility", { receiptHandle, visibilityTimeout: Math.max(1, this.visibilityTimeout) });
    return { failed: true, receiptHandle, error: message };
  }

  async size() {
    const result = await this._invoke("getQueueAttributes", {});
    const attributes = result.Attributes || {};
    const visible = Number(attributes.ApproximateNumberOfMessages || 0);
    const notVisible = Number(attributes.ApproximateNumberOfMessagesNotVisible || 0);
    return visible + notVisible;
  }

  async close() {
    this._closed = true;
    this._draining = false;
    return true;
  }

  registerHandler(type, handler) {
    if (!type) throw new SQSValidationError("registerHandler requires a non-empty type.");
    if (typeof handler !== "function") throw new SQSValidationError("registerHandler requires a function handler.");
    this._handlers.set(String(type), handler);
  }

  async _safeDelete(receiptHandle) {
    if (!receiptHandle) return;
    try {
      await this._invoke("deleteMessage", { receiptHandle });
    } catch (_error) {
      // tolerate delete failures for malformed messages
    }
  }
}

function createSQSQueue(name = "sqs", options = {}) {
  const normalized = String(name || "sqs").toLowerCase();
  if (normalized === "sqs" || normalized === "") {
    return new SQSQueue(options);
  }
  throw new Error(`Unsupported SQS queue: ${name}`);
}

module.exports = { SQSQueue, createSQSQueue };
