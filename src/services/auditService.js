const AuditLog = require("../models/AuditLog");

async function logAudit({ user, companyId, action, entityType = "", entityId = "", metadata = {} }) {
  if (!action) {
    return null;
  }

  const targetCompanyId = companyId || (user && user.companyId ? user.companyId : null);
  if (!targetCompanyId) {
    return null;
  }

  try {
    return await AuditLog.create({
      companyId: targetCompanyId,
      userId: user && user._id ? user._id : null,
      action,
      entityType,
      entityId: String(entityId || ""),
      metadata,
    });
  } catch (error) {
    return null;
  }
}

module.exports = { logAudit };
