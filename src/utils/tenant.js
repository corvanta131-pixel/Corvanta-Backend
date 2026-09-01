function getTenantFilter(user, resourceCompanyField = "companyId") {
  if (!user) {
    return { _id: null };
  }

  const isPlatformAdmin = user.roleId && user.roleId.slug === "super-admin";
  if (isPlatformAdmin) {
    return {};
  }

  return { [resourceCompanyField]: user.companyId };
}

function isPlatformAdmin(user) {
  if (!user) return false;
  if (user.roleId && user.roleId.slug === "super-admin") return true;
  if (user.role && user.role.slug === "super-admin") return true;
  if (user.roleSlug && user.roleSlug === "super-admin") return true;
  return false;
}

module.exports = {
  getTenantFilter,
  isPlatformAdmin,
};
