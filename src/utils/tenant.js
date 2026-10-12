/**
 * Slug of the platform-level administrator role.
 * IMPORTANT: this is NOT the role given to company owners. Company owners get the
 * tenant-scoped "owner" role (see authService.createDefaultRole). Only a role whose
 * slug is exactly "platform-admin" bypasses tenant scoping.
 */
const PLATFORM_ADMIN_SLUG = "platform-admin";

function getRoleSlug(user) {
  if (!user) return "";
  return (
    (user.roleId && user.roleId.slug) ||
    (user.role && user.role.slug) ||
    user.roleSlug ||
    ""
  );
}

function isPlatformAdmin(user) {
  return getRoleSlug(user) === PLATFORM_ADMIN_SLUG;
}

function getTenantFilter(user, resourceCompanyField = "companyId") {
  if (!user) {
    return { _id: null };
  }

  if (isPlatformAdmin(user)) {
    return {};
  }

  return { [resourceCompanyField]: user.companyId };
}

module.exports = {
  PLATFORM_ADMIN_SLUG,
  getTenantFilter,
  isPlatformAdmin,
};
