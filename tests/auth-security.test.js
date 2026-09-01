const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { validateRegistration, validateLogin } = require("../src/validators/authValidator");
const { requiresPermission } = require("../src/middleware/auth");
const { getTenantFilter } = require("../src/utils/tenant");
const { createAuthLimiter } = require("../src/config/rateLimits");

function createNextSpy() {
  let called = false;
  let arg;
  const next = (...args) => {
    called = true;
    arg = args[0];
  };
  return { next, getCalled: () => called, getArg: () => arg };
}

test("registration validation rejects missing fields", () => {
  assert.throws(() => validateRegistration({ name: "Valid User", email: "user@example.com", password: "validpass123", companyName: "" }), /Company name is required/);
});

test("login validation rejects weak or malformed credentials", () => {
  assert.throws(() => validateLogin({ email: "invalid", password: "short" }), /valid email/);
  assert.throws(() => validateLogin({ email: "user@example.com", password: "short" }), /at least 8 characters/);
});

test("requirePermission accepts authorized user", () => {
  const { next, getCalled, getArg } = createNextSpy();
  const req = { user: { roleId: { permissions: ["users:read"] } } };

  requiresPermission("users:read")(req, {}, next);

  assert.equal(getCalled(), true);
  assert.equal(getArg(), undefined);
});

test("requirePermission rejects user without permission", () => {
  const { next, getCalled, getArg } = createNextSpy();
  const req = { user: { roleId: { permissions: ["companies:read"] } } };

  requiresPermission("users:read")(req, {}, next);

  assert.equal(getCalled(), true);
  assert.equal(getArg().statusCode, 403);
});

test("non platform user gets tenant-scoped filter", () => {
  const filter = getTenantFilter({ companyId: "64d3a8f2c54f4020a959c9ab", roleId: { slug: "employee" } });
  assert.deepEqual(filter, { companyId: "64d3a8f2c54f4020a959c9ab" });
});

test("platform admin gets unrestricted tenant filter", () => {
  const filter = getTenantFilter({ companyId: "64d3a8f2c54f4020a959c9ab", roleId: { slug: "super-admin" } });
  assert.deepEqual(filter, {});
});

test("missing auth token is rejected for guarded routes", async () => {
  const response = await request(app).get("/api/v1/auth/me");

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("invalid access token is rejected for guarded routes", async () => {
  const response = await request(app)
    .get("/api/v1/auth/me")
    .set("Authorization", "Bearer invalid-token");

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("auth rate limiter configuration is valid", () => {
  const limiter = createAuthLimiter();
  assert.ok(limiter && typeof limiter === "function");
});

test("production config rejects insecure placeholder secrets", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
    AI_API_KEY: process.env.AI_API_KEY,
  };

  process.env.NODE_ENV = "production";
  process.env.JWT_ACCESS_SECRET = "development-placeholder-change-this";
  process.env.JWT_REFRESH_SECRET = "development-placeholder-change-this";
  process.env.RESEND_API_KEY = "development-placeholder-resend-key";
  process.env.CLOUDINARY_CLOUD_NAME = "development-placeholder-cloud-name";
  process.env.CLOUDINARY_API_KEY = "development-placeholder-cloud-key";
  process.env.CLOUDINARY_API_SECRET = "development-placeholder-cloud-secret";
  process.env.AI_API_KEY = "development-placeholder-ai-key";

  const configPath = require.resolve("../src/config/config");
  delete require.cache[configPath];

  assert.throws(() => {
    require("../src/config/config");
  }, /Production validation failed/);

  Object.assign(process.env, originalEnv);
  delete require.cache[configPath];
  require("../src/config/config");
});
