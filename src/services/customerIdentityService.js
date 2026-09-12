const CustomerIdentity = require("../models/CustomerIdentity");
const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");

function getCompanyScope(companyId) {
  if (!companyId) throw new AppError(403, "Missing company context.");
  return { companyId };
}

async function listIdentities(companyId, filters = {}) {
  const query = { ...getCompanyScope(companyId), isDeleted: false };
  if (filters.customerId) {
    validateObjectId(filters.customerId, "customerId");
    query.customerId = filters.customerId;
  }
  if (filters.channelType) query.channelType = filters.channelType;
  return CustomerIdentity.find(query).sort({ createdAt: -1 }).lean();
}

async function getIdentityById(companyId, identityId) {
  validateObjectId(identityId, "identityId");
  const identity = await CustomerIdentity.findOne({ _id: identityId, ...getCompanyScope(companyId), isDeleted: false });
  if (!identity) throw new AppError(404, "Customer identity not found.");
  return identity;
}

async function findIdentityByExternalId(companyId, channelType, externalId) {
  return CustomerIdentity.findOne({ 
    ...getCompanyScope(companyId), 
    channelType, 
    externalId, 
    isDeleted: false 
  }).lean();
}

async function createIdentity(companyId, payload) {
  validateObjectId(payload.customerId, "customerId");
  
  const customer = await Customer.findOne({ _id: payload.customerId, companyId, isDeleted: false });
  if (!customer) throw new AppError(403, "Customer not found or does not belong to your company.");

  const existing = await CustomerIdentity.findOne({ 
    companyId, 
    channelType: payload.channelType, 
    externalId: payload.externalId,
    isDeleted: false 
  });
  if (existing) throw new AppError(409, "This external identifier is already linked to another customer.");

  const identity = await CustomerIdentity.create({
    customerId: payload.customerId,
    channelType: payload.channelType,
    externalId: payload.externalId,
    companyId,
    isDeleted: false,
    deletedAt: null,
  });
  return identity;
}

async function updateIdentity(companyId, identityId, payload) {
  const identity = await getIdentityById(companyId, identityId);
  
  if (payload.externalId && payload.externalId !== identity.externalId) {
    const conflict = await CustomerIdentity.findOne({ 
      companyId, 
      channelType: identity.channelType, 
      externalId: payload.externalId,
      isDeleted: false 
    });
    if (conflict && String(conflict._id) !== String(identityId)) {
      throw new AppError(409, "This external identifier is already linked to another customer.");
    }
    identity.externalId = payload.externalId;
  }
  
  await identity.save();
  return identity;
}

async function deleteIdentity(companyId, identityId) {
  const identity = await getIdentityById(companyId, identityId);
  identity.isDeleted = true;
  identity.deletedAt = new Date();
  await identity.save();
  return identity;
}

async function resolveCustomerFromIdentity(companyId, channelType, externalId) {
  const identity = await findIdentityByExternalId(companyId, channelType, externalId);
  if (!identity) return null;
  
  const customer = await Customer.findOne({ _id: identity.customerId, companyId, isDeleted: false }).lean();
  return customer;
}

module.exports = { 
  listIdentities, 
  getIdentityById, 
  findIdentityByExternalId, 
  createIdentity, 
  updateIdentity, 
  deleteIdentity,
  resolveCustomerFromIdentity 
};