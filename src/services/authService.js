const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Company = require("../models/Company");
const Role = require("../models/Role");
const RefreshToken = require("../models/RefreshToken");
const AppError = require("../utils/AppError");
const config = require("../config/config");
const { signAccessToken, signRefreshToken, hashToken } = require("./tokenService");
const { createCompany } = require("./companyService");
const { logAudit } = require("./auditService");

const DEFAULT_PERMISSIONS = [
  "companies:read",
  "companies:create",
  "employees:read",
  "employees:create",
  "employees:update",
  "employees:delete",
  "users:read",
  "users:create",
  "users:update",
  "users:delete",
  "customers:read",
  "customers:create",
  "customers:update",
  "customers:delete",
  "agents:read",
  "agents:create",
  "agents:update",
  "agents:delete",
  "knowledge:read",
  "knowledge:create",
  "knowledge:update",
  "knowledge:delete",
  "conversations:read",
  "conversations:create",
  "conversations:update",
  "conversations:delete",
  "documents:read",
  "documents:upload",
  "documents:delete",
  "permissions:read",
  "permissions:update",
  "*",
];

async function createDefaultRole(companyId, createdById) {
  const role = await Role.findOne({ companyId, slug: "super-admin" });

  if (role) {
    return role;
  }

  return Role.create({
    companyId,
    name: "Super Admin",
    slug: "super-admin",
    permissions: DEFAULT_PERMISSIONS,
    isSystem: true,
    createdBy: createdById,
  });
}

async function issueTokenPair(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    companyId: user.companyId,
    tokenHash: refreshTokenHash,
    expiresAt,
    createdByIp: "local-development",
  });

  return { accessToken, refreshToken };
}

async function registerUser({ name, email, password, companyName, industry = "" }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const trimmedName = String(name || "").trim();

  if (!trimmedName || !normalizedEmail || !password) {
    throw new AppError(400, "Name, email, password, and company name are required.");
  }

  if (password.length < 8) {
    throw new AppError(400, "Password must be at least 8 characters long.");
  }

  const existingUser = await User.findOne({ email: normalizedEmail, isDeleted: false });
  if (existingUser) {
    throw new AppError(409, "A user with this email already exists.");
  }

  const company = await createCompany({ name: companyName, industry });
  const defaultRole = await createDefaultRole(company._id, null);
  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.create({
    companyId: company._id,
    name: trimmedName,
    email: normalizedEmail,
    passwordHash,
    roleId: defaultRole._id,
    status: "active",
    isEmailVerified: false,
  });

  await Company.findByIdAndUpdate(company._id, { ownerId: user._id });
  await logAudit({
    user,
    companyId: company._id,
    action: "user.registered",
    entityType: "User",
    entityId: user._id.toString(),
    metadata: { companyName: company.name },
  });

  const tokens = await issueTokenPair(user);

  return {
    user: user.toPublicJSON(),
    company: { ...company.toObject(), ownerId: user._id },
    ...tokens,
  };
}

async function loginUser({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || !password) {
    throw new AppError(400, "Email and password are required.");
  }

  const user = await User.findOne({ email: normalizedEmail, isDeleted: false }).select("+passwordHash").populate("roleId");
  if (!user) {
    throw new AppError(401, "Invalid email or password.");
  }

  if (user.status !== "active") {
    throw new AppError(403, "Account is not active.");
  }

  const isValidPassword = await bcrypt.compare(password, user.passwordHash);
  if (!isValidPassword) {
    throw new AppError(401, "Invalid email or password.");
  }

  user.lastLoginAt = new Date();
  await user.save();
  await logAudit({
    user,
    companyId: user.companyId,
    action: "user.login",
    entityType: "User",
    entityId: user._id.toString(),
  });

  const tokens = await issueTokenPair(user);
  const publicUser = user.toPublicJSON();

  return {
    user: publicUser,
    ...tokens,
  };
}

async function refreshUserToken(refreshTokenValue) {
  if (!refreshTokenValue) {
    throw new AppError(401, "Refresh token is required.");
  }

  let payload;
  try {
    payload = jwt.verify(refreshTokenValue, config.JWT_REFRESH_SECRET);
  } catch (error) {
    throw new AppError(401, "Invalid or expired refresh token.");
  }

  if (payload.type !== "refresh") {
    throw new AppError(401, "Invalid token type.");
  }

  const refreshHash = hashToken(refreshTokenValue);
  const storedToken = await RefreshToken.findOne({
    userId: payload.sub,
    companyId: payload.companyId,
    tokenHash: refreshHash,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!storedToken) {
    throw new AppError(401, "Refresh token has been revoked or expired.");
  }

  const user = await User.findById(payload.sub).populate("roleId");
  if (!user || user.isDeleted || user.status !== "active") {
    throw new AppError(401, "User no longer exists or is inactive.");
  }

  await RefreshToken.findByIdAndUpdate(storedToken._id, {
    revokedAt: new Date(),
    replacedByToken: refreshTokenValue,
  });

  const tokens = await issueTokenPair(user);
  return {
    user: user.toPublicJSON(),
    ...tokens,
  };
}

async function logoutUser(userId, refreshTokenValue) {
  if (!refreshTokenValue) {
    return { success: true, message: "No refresh token provided." };
  }

  const refreshHash = hashToken(refreshTokenValue);
  await RefreshToken.updateMany(
    { userId, tokenHash: refreshHash },
    { revokedAt: new Date() }
  );

  return { success: true, message: "Logged out successfully." };
}

module.exports = {
  registerUser,
  loginUser,
  refreshUserToken,
  logoutUser,
  createDefaultRole,
  issueTokenPair,
};
