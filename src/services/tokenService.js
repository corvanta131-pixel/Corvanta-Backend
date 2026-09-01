const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../config/config");

function createTokenPayload(user) {
  return {
    sub: user._id.toString(),
    companyId: user.companyId.toString(),
    email: user.email,
    roleId: user.roleId ? user.roleId.toString() : null,
    type: "access",
  };
}

function signAccessToken(user) {
  return jwt.sign(createTokenPayload(user), config.JWT_ACCESS_SECRET, {
    expiresIn: config.JWT_ACCESS_EXPIRES_IN,
  });
}

function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      companyId: user.companyId.toString(),
      type: "refresh",
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: config.JWT_REFRESH_EXPIRES_IN }
  );
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  createTokenPayload,
  signAccessToken,
  signRefreshToken,
  hashToken,
};
