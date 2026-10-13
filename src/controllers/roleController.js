const asyncHandler = require("../utils/asyncHandler");
const { listRoles } = require("../services/roleService");

exports.listRoles = asyncHandler(async (req, res) => {
  const roles = await listRoles(req.user.companyId);
  res.status(200).json({ success: true, data: roles });
});
