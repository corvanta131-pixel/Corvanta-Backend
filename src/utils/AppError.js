class AppError extends Error {
  constructor(statusCode, message, isOperational = true) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.isOperational = isOperational;
  }
}

module.exports = AppError;
