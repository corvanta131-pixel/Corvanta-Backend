const validator = require("validator");
const AppError = require("../utils/AppError");

function validateCompanyInput({ name, industry }) {
  if (!name || !validator.isLength(name.trim(), { min: 2, max: 150 })) {
    throw new AppError(400, "Company name is required and must be at least 2 characters long.");
  }

  if (industry && !validator.isLength(industry.trim(), { min: 2, max: 100 })) {
    throw new AppError(400, "Industry must be between 2 and 100 characters when provided.");
  }
}

module.exports = { validateCompanyInput };
