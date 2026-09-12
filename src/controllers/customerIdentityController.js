const asyncHandler = require("../utils/asyncHandler");
const { validateObjectId } = require("../validators/commonValidator");
const { validateCustomerIdentityInput } = require("../validators/domainValidator");
const { logAudit } = require("../services/auditService");
const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");
const {
  listIdentities,
  getIdentityById,
  createIdentity,
  updateIdentity,
  deleteIdentity,
} = require("../services/customerIdentityService");

function sanitizeIdentityResponse(identity) {
  return identity;
}

exports.listIdentities = asyncHandler(async (req, res) => {
  const filters = req.query || {};
  const identities = await listIdentities(req.user.companyId, filters);
  const sanitized = identities.map(sanitizeIdentityResponse);

  res.status(200).json({
    success: true,
    data: sanitized,
  });
});

exports.getIdentity = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "identityId");
  const identity = await getIdentityById(req.user.companyId, req.params.id);
  const sanitized = sanitizeIdentityResponse(identity);

  res.status(200).json({
    success: true,
    data: sanitized,
  });
});

exports.createIdentity = asyncHandler(async (req, res) => {
  validateCustomerIdentityInput(req.body);
  const identity = await createIdentity(req.user.companyId, req.body);
  const sanitized = sanitizeIdentityResponse(identity);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "customerIdentity.created",
    entityType: "CustomerIdentity",
    entityId: String(identity._id),
    metadata: { customerId: String(identity.customerId), channelType: identity.channelType },
  });

  res.status(201).json({
    success: true,
    message: "Customer identity created successfully.",
    data: sanitized,
  });
});

exports.updateIdentity = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "identityId");
  validateCustomerIdentityInput(req.body, { isUpdate: true });

  const identity = await updateIdentity(req.user.companyId, req.params.id, req.body);
  const sanitized = sanitizeIdentityResponse(identity);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "customerIdentity.updated",
    entityType: "CustomerIdentity",
    entityId: String(identity._id),
    metadata: { customerId: String(identity.customerId), channelType: identity.channelType },
  });

  res.status(200).json({
    success: true,
    message: "Customer identity updated successfully.",
    data: sanitized,
  });
});

exports.deleteIdentity = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "identityId");
  const identity = await deleteIdentity(req.user.companyId, req.params.id);
  const sanitized = sanitizeIdentityResponse(identity);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "customerIdentity.deleted",
    entityType: "CustomerIdentity",
    entityId: String(identity._id),
  });

  res.status(200).json({
    success: true,
    message: "Customer identity deleted successfully.",
    data: sanitized,
  });
});