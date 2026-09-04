const mongoose = require("mongoose");
const validator = require("validator");
const AppError = require("../utils/AppError");

function validateObjectId(value, fieldName = "id") {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError(400, `Invalid ${fieldName}.`);
  }
}

function validateRequiredString(value, fieldName, minLength = 2, maxLength = 255) {
  if (typeof value !== "string" || !validator.isLength(value.trim(), { min: minLength, max: maxLength })) {
    throw new AppError(400, `${fieldName} is required and must be between ${minLength} and ${maxLength} characters.`);
  }
}

function validateOptionalString(value, fieldName, minLength = 0, maxLength = 255) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (typeof value !== "string" || !validator.isLength(value.trim(), { min: minLength, max: maxLength })) {
    throw new AppError(400, `${fieldName} must be between ${minLength} and ${maxLength} characters.`);
  }
}

function validateEnumValue(value, allowedValues, fieldName) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (!allowedValues.includes(value)) {
    throw new AppError(400, `Invalid ${fieldName}. Allowed values: ${allowedValues.join(", ")}.`);
  }
}

function rejectClientCompanyOverride(payload, fieldName = "companyId") {
  if (payload && Object.prototype.hasOwnProperty.call(payload, fieldName)) {
    throw new AppError(400, "Company context is determined by the authenticated user and cannot be overridden.");
  }
}

function rejectProtectedFieldOverrides(payload = {}) {
  const protectedFields = [
    "_id",
    "companyId",
    "isDeleted",
    "deletedAt",
    "createdAt",
    "updatedAt",
    "passwordHash",
    "lastLoginAt",
  ];

  const attemptedField = protectedFields.find((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (attemptedField) {
    if (attemptedField === "companyId") {
      throw new AppError(400, "Company context is determined by the authenticated user and cannot be overridden.");
    }
    throw new AppError(400, `${attemptedField} cannot be modified by the client.`);
  }
}

module.exports = {
  validateObjectId,
  validateRequiredString,
  validateOptionalString,
  validateEnumValue,
  rejectClientCompanyOverride,
  rejectProtectedFieldOverrides,
};
