const mongoose = require("mongoose");
const AppError = require("../utils/AppError");

function validateObjectId(value, fieldName = "id") {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError(400, `Invalid ${fieldName}.`);
  }
}

module.exports = { validateObjectId };
