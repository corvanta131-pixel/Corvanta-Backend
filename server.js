const app = require("./app");
const config = require("./src/config/config");
const { connectDatabase, disconnectDatabase } = require("./src/config/db");
const logger = require("./src/utils/logger");

let server;

async function startServer() {
  const dbConnected = await connectDatabase();

  if (!dbConnected && config.NODE_ENV === "production") {
    logger.error("Production startup aborted because MongoDB is unavailable.");
    process.exit(1);
  }

  if (!dbConnected && config.NODE_ENV !== "production") {
    logger.warn("Development startup with MongoDB unavailable: continuing in degraded mode.");
  }

  server = app.listen(config.PORT, () => {
    logger.info(`Corvanta backend listening on port ${config.PORT}`);
  });
}

async function shutdown() {
  logger.info("Gracefully shutting down server...");

  if (server) {
    server.close(() => {
      logger.info("HTTP server closed.");
      process.exit(0);
    });
  }

  await disconnectDatabase();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer().catch((error) => {
  logger.error("Failed to start server:", error.message);
  process.exit(1);
});
