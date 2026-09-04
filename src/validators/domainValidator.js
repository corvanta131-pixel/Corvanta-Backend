const validator = require("validator");
const AppError = require("../utils/AppError");
const {
  validateRequiredString,
  validateOptionalString,
  validateEnumValue,
  rejectProtectedFieldOverrides,
} = require("./commonValidator");

function validateCustomerInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  if (!payload.name || !validator.isLength(payload.name.trim(), { min: 2, max: 150 })) {
    throw new AppError(400, "Customer name is required and must be between 2 and 150 characters.");
  }

  if (payload.email && !validator.isEmail(payload.email)) {
    throw new AppError(400, "Customer email must be a valid email address.");
  }

  validateOptionalString(payload.phone, "Customer phone", 2, 30);
  validateOptionalString(payload.notes, "Customer notes", 0, 2000);
  validateEnumValue(payload.status, ["active", "inactive", "prospect", "archived"], "status");
}

function validateEmployeeInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  if (!payload.name || !validator.isLength(payload.name.trim(), { min: 2, max: 120 })) {
    throw new AppError(400, "Employee name is required and must be between 2 and 120 characters.");
  }

  if (!payload.email || !validator.isEmail(payload.email)) {
    throw new AppError(400, "A valid employee email is required.");
  }

  if (payload.password && !validator.isLength(payload.password, { min: 8 })) {
    throw new AppError(400, "Employee password must be at least 8 characters long.");
  }

  validateOptionalString(payload.department, "Department", 2, 100);
  validateOptionalString(payload.title, "Title", 2, 100);
  validateOptionalString(payload.employeeCode, "Employee code", 2, 50);
  validateEnumValue(payload.status, ["active", "invited", "disabled"], "status");
}

function validateAIAgentInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  validateRequiredString(payload.name, "Agent name", 2, 120);
  validateOptionalString(payload.description, "Description", 0, 2000);
  validateOptionalString(payload.model, "Model", 2, 120);
  validateOptionalString(payload.promptTemplate, "Prompt template", 0, 20000);
  validateEnumValue(payload.status, ["draft", "active", "disabled", "archived"], "status");
}

function validateKnowledgeBaseInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  validateRequiredString(payload.name, "Knowledge base name", 2, 120);
  validateOptionalString(payload.description, "Description", 0, 2000);
  validateEnumValue(payload.status, ["active", "archived"], "status");
}

function validateKnowledgeDocumentInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  validateRequiredString(payload.title, "Document title", 2, 200);
  validateOptionalString(payload.summary, "Summary", 0, 2000);
  validateOptionalString(payload.content, "Content", 0, 50000);
  validateOptionalString(payload.fileName, "File name", 1, 255);
  validateOptionalString(payload.mimeType, "Mime type", 1, 120);
  validateEnumValue(payload.status, ["draft", "published", "archived"], "status");
}

function validateConversationInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  validateOptionalString(payload.title, "Conversation title", 0, 200);
  validateEnumValue(payload.status, ["open", "waiting", "resolved", "archived"], "status");
}

function validateMessageInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  validateRequiredString(payload.body, "Message body", 1, 20000);
  validateEnumValue(payload.senderType, ["user", "customer", "agent", "system"], "senderType");
}

function validateAttachmentInput(payload = {}, { isUpdate = false } = {}) {
  rejectProtectedFieldOverrides(payload);

  validateRequiredString(payload.fileName, "Attachment file name", 1, 255);
  validateRequiredString(payload.storageKey, "Storage key", 1, 512);
  validateOptionalString(payload.mimeType, "Mime type", 1, 120);
  validateOptionalString(payload.url, "URL", 0, 1024);
  validateEnumValue(payload.entityType, ["message", "knowledge_document", "customer", "conversation"], "entityType");
}

module.exports = {
  validateCustomerInput,
  validateEmployeeInput,
  validateAIAgentInput,
  validateKnowledgeBaseInput,
  validateKnowledgeDocumentInput,
  validateConversationInput,
  validateMessageInput,
  validateAttachmentInput,
};
