const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");

exports.getHealth = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});
