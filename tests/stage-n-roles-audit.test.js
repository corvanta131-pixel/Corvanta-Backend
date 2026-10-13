const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const base = path.join(__dirname, "..", "src");
function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function fresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

const COMPANY = "64d3a8f2c54f4020a959c9ab";

test("sanitizeMetadata redacts sensitive keys at any depth and truncates deep trees", () => {
  const { sanitizeMetadata } = require(path.join(base, "services", "auditQueryService.js"));
  const out = sanitizeMetadata({
    customerName: "Ada",
    password: "x",
    nested: { accessToken: "t", apiKey: "k", ok: 1, list: [{ secret: "s", fine: true }] },
  });
  assert.equal(out.customerName, "Ada");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.nested.accessToken, "[redacted]");
  assert.equal(out.nested.apiKey, "[redacted]");
  assert.equal(out.nested.ok, 1);
  assert.equal(out.nested.list[0].secret, "[redacted]");
  assert.equal(out.nested.list[0].fine, true);
});

test("buildAuditFilter always scopes to the caller's company and validates input", () => {
  const { buildAuditFilter } = require(path.join(base, "services", "auditQueryService.js"));
  const filter = buildAuditFilter(COMPANY, {
    companyId: "someone-elses-company",
    action: "customer.created",
    from: "2025-01-01T00:00:00.000Z",
    to: "2025-02-01T00:00:00.000Z",
  });
  assert.equal(filter.companyId, COMPANY);
  assert.equal(filter.action, "customer.created");
  assert.ok(filter.createdAt.$gte instanceof Date && filter.createdAt.$lte instanceof Date);

  assert.throws(() => buildAuditFilter(null, {}), (e) => e.statusCode === 403);
  assert.throws(() => buildAuditFilter(COMPANY, { from: "nope" }), (e) => e.statusCode === 400);
  assert.throws(() => buildAuditFilter(COMPANY, { userId: "not-an-id" }), (e) => e.statusCode === 400);
  assert.throws(
    () => buildAuditFilter(COMPANY, { from: "2025-03-01", to: "2025-01-01" }),
    (e) => e.statusCode === 400
  );
});

test("parsePagination clamps page and limit", () => {
  const { parsePagination } = require(path.join(base, "services", "auditQueryService.js"));
  assert.deepEqual(parsePagination({}), { page: 1, limit: 25 });
  assert.deepEqual(parsePagination({ page: "-4", limit: "9999" }), { page: 1, limit: 100 });
  assert.deepEqual(parsePagination({ page: "3", limit: "10" }), { page: 3, limit: 10 });
});

test("listAuditLogs queries only the caller's company and returns sanitized, paginated data", async () => {
  let seenFilter = null;
  let seenSkip = null;
  const rows = [
    {
      _id: "a1",
      action: "customer.created",
      entityType: "Customer",
      entityId: "c1",
      userId: { _id: "u1", name: "Olivia", email: "o@x.com" },
      metadata: { customerName: "Ada", token: "leak" },
      createdAt: new Date("2025-01-02"),
    },
  ];
  stub(path.join(base, "models", "AuditLog.js"), {
    countDocuments: async (filter) => {
      seenFilter = filter;
      return 51;
    },
    find: () => {
      const chain = {
        sort: () => chain,
        skip: (n) => {
          seenSkip = n;
          return chain;
        },
        limit: () => chain,
        populate: () => chain,
        lean: async () => rows,
      };
      return chain;
    },
  });
  const { listAuditLogs } = fresh(path.join(base, "services", "auditQueryService.js"));
  const result = await listAuditLogs(COMPANY, { page: "2", limit: "25" });

  assert.equal(seenFilter.companyId, COMPANY);
  assert.equal(seenSkip, 25);
  assert.deepEqual(result.pagination, { page: 2, limit: 25, total: 51, totalPages: 3 });
  assert.equal(result.data[0].actor.name, "Olivia");
  assert.equal(result.data[0].metadata.token, "[redacted]");
  assert.equal(result.data[0].metadata.customerName, "Ada");
});

test("listRoles is company-scoped, hides the platform-admin role and exposes only public fields", async () => {
  let seenQuery = null;
  stub(path.join(base, "models", "Role.js"), {
    find: (query) => {
      seenQuery = query;
      const chain = {
        sort: () => chain,
        lean: async () => [
          { _id: "r1", name: "Owner", slug: "owner", permissions: ["*"], isSystem: true, createdBy: "secret", __v: 0 },
        ],
      };
      return chain;
    },
  });
  const { listRoles } = fresh(path.join(base, "services", "roleService.js"));
  const roles = await listRoles(COMPANY);

  assert.equal(seenQuery.companyId, COMPANY);
  assert.deepEqual(seenQuery.slug, { $ne: "platform-admin" });
  assert.equal(roles[0].slug, "owner");
  assert.equal("createdBy" in roles[0], false);
  await assert.rejects(() => listRoles(null), (e) => e.statusCode === 403);
});

test("employees cannot be assigned the platform-admin role", async () => {
  stub(path.join(base, "models", "User.js"), { findOne: async () => null, create: async () => ({}) });
  stub(path.join(base, "models", "Role.js"), {
    findOne: async () => ({ _id: "64d3a8f2c54f4020a959c9ac", slug: "platform-admin" }),
  });
  const { createEmployee } = fresh(path.join(base, "services", "employeeService.js"));
  await assert.rejects(
    () => createEmployee(COMPANY, { name: "Eve", email: "eve@x.com", roleId: "64d3a8f2c54f4020a959c9ac" }),
    (e) => e.statusCode === 403
  );
});
