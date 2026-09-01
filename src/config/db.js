const mongoose = require("mongoose");
const config = require("./config");
const logger = require("../utils/logger");

async function connectDatabase() {
  try {
    await mongoose.connect(config.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
    });

    logger.info("MongoDB connected successfully.");
    return true;
  } catch (error) {
    logger.error("MongoDB connection failed.", error.message);
    return false;
  }
}

async function disconnectDatabase() {
  try {
    await mongoose.disconnect();
    logger.info("MongoDB disconnected successfully.");
  } catch (error) {
    logger.error("MongoDB disconnect error:", error.message);
  }
}

module.exports = { connectDatabase, disconnectDatabase };
