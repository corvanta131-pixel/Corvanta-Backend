const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const response = {
    success: false,
    message: err.message || "Something went wrong",
  };

  if (process.env.NODE_ENV === "development") {
    response.error = err.stack || err.message;
  } else if (statusCode >= 500) {
    response.message = "Internal server error";
  }

  res.status(statusCode).json(response);
};

module.exports = { errorHandler };
