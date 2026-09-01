const validator = require("validator");
const AppError = require("../utils/AppError");

function validateRegistration({ name, email, password, companyName }) {
  if (!name || !validator.isLength(name.trim(), { min: 2, max: 100 })) {
    throw new AppError(400, "Name must be at least 2 characters long.");
  }

  if (!email || !validator.isEmail(email)) {
    throw new AppError(400, "A valid email address is required.");
  }

  if (!password || !validator.isLength(password, { min: 8 })) {
    throw new AppError(400, "Password must be at least 8 characters long.");
  }

  if (!companyName || !validator.isLength(companyName.trim(), { min: 2, max: 150 })) {
    throw new AppError(400, "Company name is required.");
  }
}

function validateLogin({ email, password }) {
  if (!email || !validator.isEmail(email)) {
    throw new AppError(400, "A valid email address is required.");
  }

  if (!password || !validator.isLength(password, { min: 8 })) {
    throw new AppError(400, "Password must be at least 8 characters long.");
  }
}

module.exports = { validateRegistration, validateLogin };
