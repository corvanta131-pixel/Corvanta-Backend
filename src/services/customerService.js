const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");

function getCompanyScope(companyId) {
  if (!companyId) {
    throw new AppError(403, "Missing company context.");
  }

  return { companyId };
}

async function listCustomers(companyId, filters = {}) {
  const scope = getCompanyScope(companyId);
  const query = { ...scope, isDeleted: false };
  if (filters.status) query.status = filters.status;
  if (filters.email) query.email = filters.email;
  return Customer.find(query).sort({ createdAt: -1 }).lean();
}

async function getCustomerById(companyId, customerId) {
  validateObjectId(customerId, "customerId");
  const customer = await Customer.findOne({ _id: customerId, ...getCompanyScope(companyId), isDeleted: false });

  if (!customer) {
    throw new AppError(404, "Customer not found.");
  }

  return customer;
}

async function createCustomer(companyId, payload) {
  const scopedCompanyId = getCompanyScope(companyId);
  const existingCustomer = await Customer.findOne({
    ...scopedCompanyId,
    email: payload.email ? String(payload.email).trim().toLowerCase() : "",
    isDeleted: false,
  });

  if (existingCustomer) {
    throw new AppError(409, "A customer with this email already exists in this company.");
  }

  const customer = await Customer.create({
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    status: payload.status,
    notes: payload.notes,
    metadata: payload.metadata,
    companyId,
    isDeleted: false,
    deletedAt: null,
  });

  return customer;
}

async function updateCustomer(companyId, customerId, payload) {
  const customer = await getCustomerById(companyId, customerId);

  if (payload.email) {
    const duplicate = await Customer.findOne({
      _id: { $ne: customerId },
      companyId,
      email: String(payload.email).trim().toLowerCase(),
      isDeleted: false,
    });

    if (duplicate) {
      throw new AppError(409, "A customer with this email already exists in this company.");
    }
  }

  const allowedFields = ["name", "email", "phone", "status", "notes", "metadata"];
  for (const field of allowedFields) {
    if (payload[field] !== undefined) customer[field] = payload[field];
  }
  customer.updatedAt = new Date();
  await customer.save();
  return customer;
}

async function deleteCustomer(companyId, customerId) {
  const customer = await getCustomerById(companyId, customerId);
  customer.isDeleted = true;
  customer.deletedAt = new Date();
  await customer.save();
  return customer;
}

module.exports = {
  listCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
