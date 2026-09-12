const AppError = require("../../utils/AppError");
const { CONDITION_OPERATORS } = require("../../models/Workflow");

const SAFE_FIELD_PREFIXES = [
  "message.",
  "conversation.",
  "customer.",
  "channel.",
  "event.",
  "sender.",
  "metadata.",
];

  const FORBIDDEN_PATTERNS = [
  /__proto__/i,
  /constructor/i,
  /prototype/i,
  /eval/i,
  /function/i,
  /script/i,
  /\$_/,
  /\bimport\b/i,
  /\brequire\b/i,
];

function sanitizeFieldPath(field) {
  if (typeof field !== "string" || !field.trim()) {
    throw new AppError(400, "Condition field must be a non-empty string.");
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(field)) {
      throw new AppError(400, `Condition field contains forbidden pattern: ${field}`);
    }
  }

  const normalized = field.trim();
  if (normalized.length > 200) {
    throw new AppError(400, "Condition field path exceeds maximum length.");
  }

  return normalized;
}

function isAllowedOperator(operator) {
  return CONDITION_OPERATORS.includes(operator);
}

function safeStringValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function safeArrayValue(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" || typeof v === "number");
  return [];
}

function evaluateSingleCondition(condition, context) {
  const field = sanitizeFieldPath(condition.field);

  if (!isAllowedOperator(condition.operator)) {
    throw new AppError(400, `Unsupported condition operator: ${condition.operator}`);
  }

  let actual;
  const fieldParts = field.split(".");
  let node = context;

  for (const part of fieldParts) {
    if (node === null || node === undefined) {
      actual = undefined;
      break;
    }
    if (typeof node !== "object") {
      actual = undefined;
      break;
    }
    if (!Object.prototype.hasOwnProperty.call(node, part)) {
      actual = undefined;
      break;
    }
    node = node[part];
    actual = node;
  }
  if (fieldParts.length === 0) {
    actual = context;
  }

  const operator = condition.operator;
  const expected = condition.value;

  switch (operator) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "in": {
      const allowed = safeArrayValue(expected);
      return allowed.includes(actual);
    }
    case "nin": {
      const excluded = safeArrayValue(expected);
      return !excluded.includes(actual);
    }
    case "contains": {
      const haystack = safeStringValue(actual);
      const needle = safeStringValue(expected);
      if (haystack === null || needle === null) return false;
      return haystack.toLowerCase().includes(needle.toLowerCase());
    }
    case "startsWith": {
      const haystack = safeStringValue(actual);
      const prefix = safeStringValue(expected);
      if (haystack === null || prefix === null) return false;
      return haystack.toLowerCase().startsWith(prefix.toLowerCase());
    }
    case "endsWith": {
      const haystack = safeStringValue(actual);
      const suffix = safeStringValue(expected);
      if (haystack === null || suffix === null) return false;
      return haystack.toLowerCase().endsWith(suffix.toLowerCase());
    }
    case "exists":
      return actual !== undefined;
    case "gt": {
      const a = Number(actual);
      const b = Number(expected);
      if (isNaN(a) || isNaN(b)) return false;
      return a > b;
    }
    case "gte": {
      const a = Number(actual);
      const b = Number(expected);
      if (isNaN(a) || isNaN(b)) return false;
      return a >= b;
    }
    case "lt": {
      const a = Number(actual);
      const b = Number(expected);
      if (isNaN(a) || isNaN(b)) return false;
      return a < b;
    }
    case "lte": {
      const a = Number(actual);
      const b = Number(expected);
      if (isNaN(a) || isNaN(b)) return false;
      return a <= b;
    }
    default:
      throw new AppError(400, `Unsupported condition operator: ${operator}`);
  }
}

function evaluateConditions(conditions, context) {
  if (!Array.isArray(conditions)) {
    throw new AppError(400, "Conditions must be an array.");
  }

  if (conditions.length === 0) {
    return { passed: true, results: [] };
  }

  const results = [];

  for (const condition of conditions) {
    if (!condition || typeof condition !== "object") {
      throw new AppError(400, "Each condition must be an object with field, operator, and value.");
    }

    if (!condition.field || typeof condition.field !== "string") {
      throw new AppError(400, "Each condition must have a string 'field' property.");
    }

    if (!condition.operator || typeof condition.operator !== "string") {
      throw new AppError(400, "Each condition must have a string 'operator' property.");
    }

    const passed = evaluateSingleCondition(condition, context);
    results.push({
      field: condition.field,
      operator: condition.operator,
      expected: condition.value,
      actual: (() => {
        try {
          const fieldParts = condition.field.split(".");
          let node = context;
          for (const part of fieldParts) {
            if (node === null || node === undefined) return undefined;
            if (typeof node !== "object") return undefined;
            node = node[part];
          }
          return node;
        } catch {
          return undefined;
        }
      })(),
      passed,
    });
  }

  const allPassed = results.every((r) => r.passed);

  return { passed: allPassed, results };
}

module.exports = {
  sanitizeFieldPath,
  evaluateSingleCondition,
  evaluateConditions,
};
