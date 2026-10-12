const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

test("createCustomer allows several customers without an email", async () => {
  const base = path.join(__dirname, "..", "src");
  let findOneCalls = 0;
  const created = [];
  stub(path.join(base, "models", "Customer.js"), {
    findOne: async () => {
      findOneCalls += 1;
      return null;
    },
    create: async (doc) => {
      created.push(doc);
      return { _id: String(created.length), ...doc };
    },
  });
  stub(path.join(base, "services", "workflow", "engine.js"), { runEventWorkflows: async () => {} });
  delete require.cache[require.resolve(path.join(base, "services", "customerService.js"))];
  const { createCustomer } = require(path.join(base, "services", "customerService.js"));

  await createCustomer("64d3a8f2c54f4020a959c9ab", { name: "First" });
  await createCustomer("64d3a8f2c54f4020a959c9ab", { name: "Second" });

  assert.equal(created.length, 2);
  assert.equal(findOneCalls, 0, "no duplicate lookup should happen for empty emails");
});

test("createCustomer still rejects a duplicate non-empty email", async () => {
  const base = path.join(__dirname, "..", "src");
  stub(path.join(base, "models", "Customer.js"), {
    findOne: async () => ({ _id: "existing" }),
    create: async () => {
      throw new Error("should not create");
    },
  });
  stub(path.join(base, "services", "workflow", "engine.js"), { runEventWorkflows: async () => {} });
  delete require.cache[require.resolve(path.join(base, "services", "customerService.js"))];
  const { createCustomer } = require(path.join(base, "services", "customerService.js"));

  await assert.rejects(
    () => createCustomer("64d3a8f2c54f4020a959c9ab", { name: "Dup", email: "A@X.com" }),
    (err) => err.statusCode === 409
  );
});

test("employee creation never uses a shared default password", async () => {
  const base = path.join(__dirname, "..", "src");
  const bcrypt = require("bcryptjs");
  const hashed = [];
  const realHash = bcrypt.hash;
  bcrypt.hash = async (value) => {
    hashed.push(value);
    return "hash";
  };
  stub(path.join(base, "models", "User.js"), {
    findOne: async () => null,
    create: async (doc) => ({ _id: "1", ...doc, toObject() { return doc; } }),
  });
  stub(path.join(base, "models", "Role.js"), { findOne: async () => null });
  delete require.cache[require.resolve(path.join(base, "services", "employeeService.js"))];
  const { createEmployee } = require(path.join(base, "services", "employeeService.js"));

  try {
    await createEmployee("64d3a8f2c54f4020a959c9ab", { name: "Ada", email: "ada@x.com" });
    await createEmployee("64d3a8f2c54f4020a959c9ab", { name: "Ben", email: "ben@x.com" });
    await createEmployee("64d3a8f2c54f4020a959c9ab", { name: "Cy", email: "cy@x.com", password: "ChosenPass1!" });
  } finally {
    bcrypt.hash = realHash;
  }

  assert.equal(hashed.includes("TempPassword123!"), false);
  assert.notEqual(hashed[0], hashed[1], "random passwords must differ per employee");
  assert.equal(hashed[0].length, 64);
  assert.equal(hashed[2], "ChosenPass1!");
});
