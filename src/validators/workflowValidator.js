const AppError = require("../utils/AppError");
const { rejectProtectedFieldOverrides, validateEnumValue, validateRequiredString } = require("./commonValidator");
const { TRIGGER_TYPES, ACTION_TYPES, CONDITION_OPERATORS } = require("../models/Workflow");

function validateWorkflowInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  if (!isUpdate || payload.name !== undefined) {
    const name = isUpdate ? payload.name : payload.name;
    if (!isUpdate && (!name || typeof name !== "string" || name.trim().length < 2)) {
      throw new AppError(400, "Workflow name is required and must be at least 2 characters.");
    }
    if (name !== undefined && typeof name !== "string") {
      throw new AppError(400, "Workflow name must be a string.");
    }
  }

  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string" || payload.description.length > 2000) {
      throw new AppError(400, "Workflow description must be a string of at most 2000 characters.");
    }
  }

  if (payload.priority !== undefined) {
    if (typeof payload.priority !== "number" || !Number.isFinite(payload.priority) || payload.priority < 0 || payload.priority > 10000) {
      throw new AppError(400, "Priority must be a number between 0 and 10000.");
    }
  }

  if (payload.trigger !== undefined) {
    validateTriggerInput(payload.trigger);
  }

  if (payload.conditions !== undefined && payload.conditions !== null) {
    if (!Array.isArray(payload.conditions)) {
      throw new AppError(400, "Conditions must be an array.");
    }
    for (let i = 0; i < payload.conditions.length; i += 1) {
      validateConditionInput(payload.conditions[i], i);
    }
  }

  if (payload.actions !== undefined && payload.actions !== null) {
    if (!Array.isArray(payload.actions)) {
      throw new AppError(400, "Actions must be an array.");
    }
    for (let i = 0; i < payload.actions.length; i += 1) {
      validateActionInput(payload.actions[i], i);
    }
  }
}

function validateTriggerInput(trigger) {
  if (!trigger || typeof trigger !== "object") {
    throw new AppError(400, "Trigger must be an object with a 'type' field.");
  }
  validateEnumValue(trigger.type, TRIGGER_TYPES, "trigger.type");
  if (trigger.config !== undefined && (typeof trigger.config !== "object" || Array.isArray(trigger.config))) {
    throw new AppError(400, "Trigger config must be an object.");
  }
}

function validateConditionInput(condition, index) {
  if (!condition || typeof condition !== "object") {
    throw new AppError(400, `Condition at index ${index} must be an object.`);
  }
  if (!condition.field || typeof condition.field !== "string") {
    throw new AppError(400, `Condition at index ${index} must have a string 'field' property.`);
  }
  if (condition.field.length > 200) {
    throw new AppError(400, `Condition at index ${index} field path exceeds maximum length.`);
  }

  const FORBIDDEN_FIELD_PATTERNS = [
    /__proto__/i,
    /constructor/i,
    /prototype/i,
    /eval/i,
    /function/i,
    /\bimport\b/i,
    /\brequire\b/i,
  ];
  for (const pattern of FORBIDDEN_FIELD_PATTERNS) {
    if (pattern.test(condition.field)) {
      throw new AppError(400, `Condition at index ${index} field contains forbidden pattern.`);
    }
  }

  if (!condition.operator || typeof condition.operator !== "string") {
    throw new AppError(400, `Condition at index ${index} must have a string 'operator' property.`);
  }
  if (!CONDITION_OPERATORS.includes(condition.operator)) {
    throw new AppError(400, `Condition at index ${index} has unsupported operator. Allowed: ${CONDITION_OPERATORS.join(", ")}`);
  }
  if (condition.value !== undefined && condition.value !== null && typeof condition.value !== "string" && typeof condition.value !== "number" && typeof condition.value !== "boolean" && !Array.isArray(condition.value)) {
    throw new AppError(400, `Condition at index ${index} value must be a string, number, boolean, or array.`);
  }
}

function validateActionInput(action, index) {
  if (!action || typeof action !== "object") {
    throw new AppError(400, `Action at index ${index} must be an object.`);
  }
  if (!action.type || typeof action.type !== "string") {
    throw new AppError(400, `Action at index ${index} must have a string 'type' property.`);
  }
  if (!ACTION_TYPES.includes(action.type)) {
    throw new AppError(400, `Action at index ${index} has unsupported type. Allowed: ${ACTION_TYPES.join(", ")}`);
  }
  if (action.params !== undefined && (typeof action.params !== "object" || Array.isArray(action.params))) {
    throw new AppError(400, `Action at index ${index} params must be an object.`);
  }
  if (action.params && typeof action.params === "object") {
    const paramKeys = Object.getOwnPropertyNames(action.params);
    for (const key of paramKeys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new AppError(400, `Action at index ${index} params contain forbidden key: ${key}`);
      }
    }
  }
}

module.exports = {
  validateWorkflowInput,
  validateTriggerInput,
  validateConditionInput,
  validateActionInput,
};
