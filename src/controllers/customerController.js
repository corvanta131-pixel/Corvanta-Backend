const asyncHandler = require("../utils/asyncHandler");
const { validateCustomerInput } = require("../validators/domainValidator");
const { validateObjectId } = require("../validators/commonValidator");
const { logAudit } = require("../services/auditService");
const {
  listCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} = require("../services/customerService");

exports.listCustomers = asyncHandler(async (req, res) => {
  const customers = await listCustomers(req.user.companyId, req.query || {});

  res.status(200).json({
    success: true,
    data: customers,
  });
});

exports.getCustomer = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "customerId");
  const customer = await getCustomerById(req.user.companyId, req.params.id);

  res.status(200).json({
    success: true,
    data: customer,
  });
});

exports.createCustomer = asyncHandler(async (req, res) => {
  validateCustomerInput(req.body);
  const customer = await createCustomer(req.user.companyId, req.body);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "customer.created",
    entityType: "Customer",
    entityId: String(customer._id),
    metadata: { customerName: customer.name },
  });

  res.status(201).json({
    success: true,
    message: "Customer created successfully.",
    data: customer,
  });
});

exports.updateCustomer = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "customerId");
  validateCustomerInput(req.body, { isUpdate: true });
  const customer = await updateCustomer(req.user.companyId, req.params.id, req.body);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "customer.updated",
    entityType: "Customer",
    entityId: String(customer._id),
    metadata: { customerName: customer.name },
  });

  res.status(200).json({
    success: true,
    message: "Customer updated successfully.",
    data: customer,
  });
});

exports.deleteCustomer = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "customerId");
  const customer = await deleteCustomer(req.user.companyId, req.params.id);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "customer.deleted",
    entityType: "Customer",
    entityId: String(customer._id),
  });

  res.status(200).json({
    success: true,
    message: "Customer deleted successfully.",
    data: customer,
  });
});
