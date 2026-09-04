const asyncHandler = require("../utils/asyncHandler");
const { logAudit } = require("../services/auditService");
const {
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} = require("../services/employeeService");
const { validateEmployeeInput } = require("../validators/domainValidator");
const { validateObjectId } = require("../validators/commonValidator");

exports.getCurrentUser = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      user: req.user.toPublicJSON ? req.user.toPublicJSON() : req.user,
    },
  });
});

exports.listEmployees = asyncHandler(async (req, res) => {
  const employees = await listEmployees(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: employees });
});

exports.getEmployee = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "employeeId");
  const employee = await getEmployeeById(req.user.companyId, req.params.id);
  res.status(200).json({ success: true, data: employee });
});

exports.createEmployee = asyncHandler(async (req, res) => {
  validateEmployeeInput(req.body);
  const employee = await createEmployee(req.user.companyId, req.body);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "employee.created",
    entityType: "User",
    entityId: String(employee._id),
    metadata: { email: employee.email },
  });

  res.status(201).json({ success: true, message: "Employee created successfully.", data: employee });
});

exports.updateEmployee = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "employeeId");
  validateEmployeeInput(req.body, { isUpdate: true });
  const employee = await updateEmployee(req.user.companyId, req.params.id, req.body);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "employee.updated",
    entityType: "User",
    entityId: String(employee._id),
    metadata: { email: employee.email },
  });

  res.status(200).json({ success: true, message: "Employee updated successfully.", data: employee });
});

exports.deleteEmployee = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, "employeeId");
  const employee = await deleteEmployee(req.user.companyId, req.params.id);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "employee.deleted",
    entityType: "User",
    entityId: String(employee._id),
  });

  res.status(200).json({ success: true, message: "Employee deleted successfully.", data: employee });
});
