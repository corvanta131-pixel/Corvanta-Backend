/**
 * Queue abstraction for ingestion jobs.
 * Designed to be swappable with AWS SQS / BullMQ / Redis later.
 * Default implementation is an in-memory queue suitable for development and testing.
 */

class InMemoryQueue {
  constructor(options = {}) {
    this.name = options.name || "in-memory";
    this.maxRetries = Number(options.maxRetries || 3);
    this.processingTimeout = Number(options.processingTimeout || 30000);
    this._jobs = new Map();
    this._pending = [];
    this._processing = new Set();
    this._handlers = new Map();
    this._timers = new Map();
  }

  async enqueue(job) {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const record = {
      id,
      ...job,
      status: "pending",
      attempts: 0,
      createdAt: new Date(),
    };
    this._jobs.set(id, record);
    this._pending.push(id);
    this._drain();
    return id;
  }

  async dequeue() {
    return this._pending.shift() || null;
  }

  async ack(jobId) {
    this._jobs.delete(jobId);
    this._processing.delete(jobId);
    return true;
  }

  async retry(jobId, delayMs = 1000) {
    const record = this._jobs.get(jobId);
    if (!record) return false;
    record.attempts += 1;
    if (record.attempts > this.maxRetries) {
      this._jobs.delete(jobId);
      this._processing.delete(jobId);
      return false;
    }
    record.status = "pending";
    this._processing.delete(jobId);
    setTimeout(() => {
      this._pending.push(jobId);
      this._drain();
    }, delayMs);
    return true;
  }

  async fail(jobId, error) {
    const record = this._jobs.get(jobId);
    if (!record) return false;
    record.status = "failed";
    record.error = String(error && error.message ? error.message : error);
    return true;
  }

  async size() {
    return this._pending.length + this._processing.size;
  }

  async close() {
    this._pending = [];
    this._processing.clear();
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
  }

  _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._pending.length > 0) {
        const jobId = this._pending.shift();
        if (this._processing.has(jobId)) continue;
        this._processing.add(jobId);
        this._processJob(jobId);
      }
    } finally {
      this._draining = false;
    }
  }

  async _processJob(jobId) {
    const record = this._jobs.get(jobId);
    if (!record) return;
    const handler = this._handlers.get(record.type) || this._handlers.get("*");
    if (!handler) {
      await this.fail(jobId, new Error("No handler registered for job type"));
      return;
    }
    try {
      record.status = "processing";
      record.startedAt = new Date();
      await handler(record);
      await this.ack(jobId);
    } catch (error) {
      const retryable = await this.retry(jobId);
      if (!retryable) {
        await this.fail(jobId, error);
      }
    }
  }

  registerHandler(type, handler) {
    this._handlers.set(type, handler);
  }
}

class Queue {
  constructor() {
    throw new Error("Queue is abstract. Use createQueue().");
  }

  async enqueue() { throw new Error("Queue.enqueue not implemented"); }
  async dequeue() { throw new Error("Queue.dequeue not implemented"); }
  async ack() { throw new Error("Queue.ack not implemented"); }
  async retry() { throw new Error("Queue.retry not implemented"); }
  async fail() { throw new Error("Queue.fail not implemented"); }
  async size() { throw new Error("Queue.size not implemented"); }
  async close() { throw new Error("Queue.close not implemented"); }
  registerHandler() { throw new Error("Queue.registerHandler not implemented"); }
}

function createQueue(name = "in-memory", options = {}) {
  const normalized = String(name || "in-memory").toLowerCase();
  if (normalized === "in-memory" || normalized === "memory" || normalized === "") {
    return new InMemoryQueue(options);
  }
  throw new Error(`Unsupported queue: ${name}`);
}

module.exports = { Queue, InMemoryQueue, createQueue };