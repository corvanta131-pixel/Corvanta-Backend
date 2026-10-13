const AuditLog = require("../models/AuditLog");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");

const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|api[-_]?key|credential|cookie|signature/i;
const MAX_DEPTH = 5;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Recursively redacts values stored under sensitive-looking keys before they leave the server. */
function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, inner] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeMetadata(inner, depth + 1);
    }
    return output;
  }
  return value;
}

function cleanString(value, name, max = 100) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > max) {
    throw new AppError(400, `${name} must be a string of at most ${max} characters.`);
  }
  return value.trim();
}

function parseDate(value, name) {
  if (value === undefined || value === "") return undefined;
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime())) {
    throw new AppError(400, `${name} must be a valid ISO date.`);
  }
  return date;
}

/** Builds the Mongo filter. The caller's company is always applied; nothing client-side can widen it. */
function buildAuditFilter(companyId, query = {}) {
  if (!companyId) throw new AppError(403, "Missing company context.");

  const filter = { companyId };
  const action = cleanString(query.action, "action");
  const entityType = cleanString(query.entityType, "entityType");
  if (action) filter.action = action;
  if (entityType) filter.entityType = entityType;

  if (query.userId !== undefined && query.userId !== "") {
    validateObjectId(query.userId, "userId");
    filter.userId = query.userId;
  }

  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  if (from && to && from > to) throw new AppError(400, "from must be earlier than to.");
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  return filter;
}

function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  return { page, limit };
}

function publicAuditLog(log) {
  const user = log.userId && typeof log.userId === "object" && log.userId._id ? log.userId : null;
  return {
    _id: log._id,
    action: log.action,
    entityType: log.entityType || "",
    entityId: log.entityId || "",
    actor: user ? { _id: user._id, name: user.name, email: user.email } : null,
    metadata: sanitizeMetadata(log.metadata || {}),
    createdAt: log.createdAt,
  };
}

async function listAuditLogs(companyId, query = {}) {
  const filter = buildAuditFilter(companyId, query);
  const { page, limit } = parsePagination(query);

  const [total, logs] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("userId", "name email")
      .lean(),
  ]);

  return {
    data: logs.map(publicAuditLog),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

module.exports = { listAuditLogs, buildAuditFilter, parsePagination, sanitizeMetadata, publicAuditLog };
