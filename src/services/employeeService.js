const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Role = require("../models/Role");
const AppError = require("../utils/AppError");
const { validateObjectId } = require("../validators/commonValidator");

function getCompanyScope(companyId) {
  if (!companyId) {
    throw new AppError(403, "Missing company context.");
  }

  return { companyId };
}

async function listEmployees(companyId, filters = {}) {
  const query = { ...getCompanyScope(companyId), isDeleted: false };
  if (filters.status) query.status = filters.status;
  if (filters.department) query.department = filters.department;
  return User.find(query).populate("roleId").sort({ createdAt: -1 }).lean();
}

async function getEmployeeById(companyId, userId) {
  validateObjectId(userId, "employeeId");
  const user = await User.findOne({ _id: userId, ...getCompanyScope(companyId), isDeleted: false }).populate("roleId");

  if (!user) {
    throw new AppError(404, "Employee not found.");
  }

  return user;
}

async function createEmployee(companyId, payload) {
  const normalizedEmail = String(payload.email || "").trim().toLowerCase();
  const duplicate = await User.findOne({
    companyId,
    email: normalizedEmail,
    isDeleted: false,
  });

  if (duplicate) {
    throw new AppError(409, "An employee with this email already exists in this company.");
  }

  // Validate managerId belongs to same company
  if (payload.managerId) {
    validateObjectId(payload.managerId, "managerId");
    const manager = await User.findOne({ _id: payload.managerId, companyId, isDeleted: false });
    if (!manager) {
      throw new AppError(403, "Manager not found or does not belong to your company.");
    }
  }

  // Validate roleId exists if provided
  if (payload.roleId) {
    validateObjectId(payload.roleId, "roleId");
    const role = await Role.findOne({ _id: payload.roleId, companyId });
    if (!role) {
      throw new AppError(403, "Role not found or does not belong to your company.");
    }
  }

  const passwordHash = payload.password ? await bcrypt.hash(payload.password, 12) : await bcrypt.hash("TempPassword123!", 12);
  const employee = await User.create({
    companyId,
    name: payload.name,
    email: normalizedEmail,
    passwordHash,
    roleId: payload.roleId || null,
    employeeCode: payload.employeeCode || "",
    department: payload.department || "",
    title: payload.title || "",
    managerId: payload.managerId || null,
    status: payload.status || "active",
    isEmailVerified: payload.isEmailVerified || false,
    metadata: payload.metadata || {},
  });

  return employee;
}

async function updateEmployee(companyId, userId, payload) {
  const employee = await getEmployeeById(companyId, userId);

  if (payload.email) {
    const duplicate = await User.findOne({
      _id: { $ne: userId },
      companyId,
      email: String(payload.email).trim().toLowerCase(),
      isDeleted: false,
    });

    if (duplicate) {
      throw new AppError(409, "An employee with this email already exists in this company.");
    }

    employee.email = String(payload.email).trim().toLowerCase();
  }

  if (payload.password) {
    employee.passwordHash = await bcrypt.hash(payload.password, 12);
  }

  if (payload.roleId) {
    validateObjectId(payload.roleId, "roleId");
    const role = await Role.findOne({ _id: payload.roleId, companyId });
    if (!role) {
      throw new AppError(403, "Role not found or does not belong to your company.");
    }
    employee.roleId = payload.roleId;
  }

  if (payload.managerId !== undefined) {
    if (payload.managerId) {
      validateObjectId(payload.managerId, "managerId");
      const manager = await User.findOne({ _id: payload.managerId, companyId, isDeleted: false });
      if (!manager) {
        throw new AppError(403, "Manager not found or does not belong to your company.");
      }
    }
    employee.managerId = payload.managerId;
  }

  if (payload.name) employee.name = payload.name;
  if (payload.employeeCode !== undefined) employee.employeeCode = payload.employeeCode;
  if (payload.department !== undefined) employee.department = payload.department;
  if (payload.title !== undefined) employee.title = payload.title;
  if (payload.status) employee.status = payload.status;
  if (payload.isEmailVerified !== undefined) employee.isEmailVerified = payload.isEmailVerified;
  if (payload.metadata) employee.metadata = { ...employee.metadata, ...payload.metadata };

  await employee.save();
  return employee;
}

async function deleteEmployee(companyId, userId) {
  const employee = await getEmployeeById(companyId, userId);
  employee.isDeleted = true;
  employee.status = "disabled";
  await employee.save();
  return employee;
}

module.exports = {
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
};
