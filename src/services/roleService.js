const Role = require("../models/Role");
const AppError = require("../utils/AppError");
const { PLATFORM_ADMIN_SLUG } = require("../utils/tenant");

function publicRole(role) {
  return {
    _id: role._id,
    name: role.name,
    slug: role.slug,
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    isSystem: Boolean(role.isSystem),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

/**
 * Lists the roles that belong to the caller's company. The platform-admin role can never be
 * assigned through the API, so it is not offered.
 */
async function listRoles(companyId) {
  if (!companyId) {
    throw new AppError(403, "Missing company context.");
  }

  const roles = await Role.find({ companyId, slug: { $ne: PLATFORM_ADMIN_SLUG } })
    .sort({ name: 1 })
    .lean();

  return roles.map(publicRole);
}

module.exports = { listRoles, publicRole };
