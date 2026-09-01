const asyncHandler = require("../utils/asyncHandler");

exports.getCurrentUser = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      user: req.user.toPublicJSON ? req.user.toPublicJSON() : req.user,
    },
  });
});
