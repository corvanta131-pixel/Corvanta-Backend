const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");

const config = require("./src/config/config");
const routes = require("./src/routes");
const { createAuthLimiter, createApiLimiter } = require("./src/config/rateLimits");
const { notFound } = require("./src/middleware/notFound");
const { errorHandler } = require("./src/middleware/errorHandler");

const app = express();

app.use(
  cors({
    origin: function originCheck(origin, callback) {
      const allowedOrigins = config.CORS_ORIGINS;
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(config.NODE_ENV === "production" ? "combined" : "dev"));
app.use("/api/v1/auth", createAuthLimiter());
app.use("/api/v1", createApiLimiter());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Welcome to Corvanta API",
    version: "v1",
  });
});

app.use("/api/v1", routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
