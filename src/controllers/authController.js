const { registerUser, loginUser, refreshUserToken, logoutUser } = require("../services/authService");
const { defaultEmailService } = require("../services/email/emailService");
const asyncHandler = require("../utils/asyncHandler");
const { validateRegistration, validateLogin } = require("../validators/authValidator");
const { logAudit } = require("../services/auditService");

exports.register = asyncHandler(async (req, res) => {
  validateRegistration(req.body);

  const result = await registerUser(req.body);

  await defaultEmailService.sendWelcomeEmail({
    to: result.user.email,
    name: result.user.name,
  });

  res.status(201).json({
    success: true,
    message: "User registered successfully.",
    data: result,
  });
});

exports.login = asyncHandler(async (req, res) => {
  validateLogin(req.body);

  const result = await loginUser(req.body);

  res.status(200).json({
    success: true,
    message: "Login successful.",
    data: result,
  });
});

exports.refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const result = await refreshUserToken(refreshToken);

  res.status(200).json({
    success: true,
    message: "Tokens refreshed successfully.",
    data: result,
  });
});

exports.logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const result = await logoutUser(req.user._id, refreshToken);

  await logAudit({
    user: req.user,
    companyId: req.user.companyId,
    action: "user.logout",
    entityType: "User",
    entityId: req.user._id.toString(),
  });

  res.status(200).json({
    success: true,
    message: result.message,
  });
});

exports.getMe = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      user: req.user.toPublicJSON ? req.user.toPublicJSON() : req.user,
    },
  });
});
