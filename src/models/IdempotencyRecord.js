const mongoose = require("mongoose");

/**
 * Persistent idempotency record.
 *
 * Replaces the previous in-memory Map implementation so that idempotency
 * state survives process restarts and is shared across worker instances.
 *
 * The record key is derived deterministically from (companyId, scope,
 * externalMessageId) so that the same inbound/outbound/workflow event always
 * maps to the same document; the compound unique index guarantees that a
 * duplicate write is rejected at the database level rather than by an
 * application-level race.
 */
const idempotencyRecordSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    scope: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    externalMessageId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    result: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    executed: {
      type: Boolean,
      default: false,
    },
    ttl: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

idempotencyRecordSchema.index(
  { key: 1 },
  { unique: true, name: "idempotency_key_unique" }
);

// Expiry is handled explicitly by IdempotencyService.cleanupExpiredIdempotency()
// so that cleanup behavior is deterministic and testable. No MongoDB TTL index.

module.exports = mongoose.model("IdempotencyRecord", idempotencyRecordSchema);