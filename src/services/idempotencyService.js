const IdempotencyRecord = require("../models/IdempotencyRecord");

/**
 * Persistent idempotency service.
 *
 * Replaces the previous in-memory Map implementation so that idempotency
 * state survives process restarts and is shared across worker instances.
 *
 * Public API is intentionally unchanged from the previous in-memory version:
 * `getIdempotencyKey`, `checkIdempotency`, `storeIdempotency`, and
 * `cleanupExpiredIdempotency` keep the same signatures and return shapes so
 * every existing caller (outboundPipeline, inboundPipeline, workflow engine,
 * webhookAuth, webhookSecurity) works without modification.
 *
 * When MongoDB is connected (the normal case in tests and production) state
 * is persisted to the `IdempotencyRecord` collection with a unique index on
 * `key` that makes duplicate writes fail atomically. When MongoDB is not
 * connected (degraded development mode), the previous in-memory Map is used
 * as a fallback so idempotency still works.
 */

const IDEMPOTENCY_STORE = new Map();
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function isDatabaseAvailable() {
  try {
    const mongoose = require("mongoose");
    return mongoose.connection && mongoose.connection.readyState === 1;
  } catch (_error) {
    return false;
  }
}

function getIdempotencyKey(companyId, channelType, externalMessageId) {
  return `idemp:${companyId}:${channelType}:${externalMessageId}`;
}

async function checkIdempotency(companyId, channelType, externalMessageId) {
  const key = getIdempotencyKey(companyId, channelType, externalMessageId);

  if (isDatabaseAvailable()) {
    const record = await IdempotencyRecord.findOne({ key, executed: true }).lean();
    if (record) {
      return {
        key,
        result: record.result,
        createdAt: record.createdAt,
        persisted: true,
      };
    }
    return null;
  }

  const existing = IDEMPOTENCY_STORE.get(key);
  return existing || null;
}

async function storeIdempotency(companyId, channelType, externalMessageId, result, options = {}) {
  const key = getIdempotencyKey(companyId, channelType, externalMessageId);
  const scope = channelType;
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
  const ttl = new Date(Date.now() + ttlMs);

  if (isDatabaseAvailable()) {
    try {
      const record = await IdempotencyRecord.create({
        key,
        scope,
        externalMessageId: String(externalMessageId || ""),
        result: result || null,
        executed: true,
        ttl,
        companyId,
      });
      return {
        key,
        result: record.result,
        createdAt: record.createdAt,
        persisted: true,
      };
    } catch (error) {
      // Unique-index race: another worker stored the same key first.
      if (error && error.code === 11000) {
        const existing = await IdempotencyRecord.findOne({ key }).lean();
        return {
          key,
          result: existing ? existing.result : null,
          createdAt: existing ? existing.createdAt : new Date(),
          persisted: true,
          duplicate: true,
        };
      }
      throw error;
    }
  }

  IDEMPOTENCY_STORE.set(key, {
    key,
    result,
    createdAt: Date.now(),
  });
  return { key, result, createdAt: Date.now(), persisted: false };
}

async function cleanupExpiredIdempotency(ttlMs = DEFAULT_TTL_MS) {
  const cutoff = new Date(Date.now() - ttlMs);

  if (isDatabaseAvailable()) {
    // Only delete records that have an explicit ttl set and are expired.
    // Records without a ttl are never auto-removed by this function.
    const result = await IdempotencyRecord.deleteMany({
      ttl: { $exists: true, $lte: cutoff },
    });
    return result.deletedCount || 0;
  }

  let removed = 0;
  const now = Date.now();
  for (const [key, entry] of IDEMPOTENCY_STORE.entries()) {
    if (now - entry.createdAt > ttlMs) {
      IDEMPOTENCY_STORE.delete(key);
      removed += 1;
    }
  }
  return removed;
}

module.exports = {
  getIdempotencyKey,
  checkIdempotency,
  storeIdempotency,
  cleanupExpiredIdempotency,
};