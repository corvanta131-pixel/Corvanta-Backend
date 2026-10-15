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

const isWidgetRequest = (req) => (req.originalUrl || "").startsWith("/api/v1/widget");

// Behind a load balancer (AWS ALB / Elastic Beanstalk) set TRUST_PROXY=1 so req.ip is the visitor's
// address instead of the proxy's. Leave unset when the app is exposed directly.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
}

const corsMiddleware = cors({
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
  });

// The public chat widget is called from customers' own websites, so it applies its own per-channel
// origin allow-list (middleware/widgetCors.js) instead of the dashboard's global CORS list.
app.use((req, res, next) => (isWidgetRequest(req) ? next() : corsMiddleware(req, res, next)));

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
const apiLimiter = createApiLimiter();
// The widget has dedicated, stricter limits (see routes/widgetRoutes.js).
app.use("/api/v1", (req, res, next) => (isWidgetRequest(req) ? next() : apiLimiter(req, res, next)));

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
