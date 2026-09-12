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

// Capture the raw request body for webhook signature verification BEFORE the
// JSON parser consumes the stream. Scoped to webhook paths only so other routes
// are unaffected.
app.use((req, res, next) => {
  if (!req.path || !req.path.startsWith("/api/v1/webhooks")) {
    return next();
  }
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    data += chunk;
  });
  req.on("end", () => {
    req.rawBody = data;
    try {
      req.body = data ? JSON.parse(data) : {};
    } catch (error) {
      req.body = {};
    }
    req._body = true;
    next();
  });
  req.on("error", next);
});

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
