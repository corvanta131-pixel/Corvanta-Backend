const asyncHandler = require("../utils/asyncHandler");
const { listAuditLogs } = require("../services/auditQueryService");

exports.listAuditLogs = asyncHandler(async (req, res) => {
  const result = await listAuditLogs(req.user.companyId, req.query || {});
  res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
});
