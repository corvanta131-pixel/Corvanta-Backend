const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const Customer = require("../src/models/Customer");
const { validateCustomerInput, validateAIAgentInput, validateKnowledgeBaseInput, validateConversationInput } = require("../src/validators/domainValidator");
const { listCustomers, createCustomer } = require("../src/services/customerService");
const { getTenantFilter } = require("../src/utils/tenant");

function withPatchedModel(methodName, fn, callback) {
  const original = Customer[methodName];
  Customer[methodName] = fn;
  try {
    return callback();
  } finally {
    Customer[methodName] = original;
  }
}

test("customer validation rejects client-supplied companyId overrides", () => {
  assert.throws(() => validateCustomerInput({ name: "ACME Corp", companyId: "64d3a8f2c54f4020a959c9ab" }), /authenticated user/);
});

test("AI agent validation rejects invalid enum values", () => {
  assert.throws(() => validateAIAgentInput({ name: "Support Bot", status: "unknown" }), /Invalid status/);
});

test("knowledge base validation rejects malformed names", () => {
  assert.throws(() => validateKnowledgeBaseInput({ name: "A" }), /between 2 and 120/);
});

test("conversation validation rejects invalid status", () => {
  assert.throws(() => validateConversationInput({ status: "pending" }), /Invalid status/);
});

test("tenant filter is applied when user has a company and no platform admin access", () => {
  const filter = getTenantFilter({ companyId: "64d3a8f2c54f4020a959c9ab", roleId: { slug: "employee" } }, "companyId");
  assert.deepEqual(filter, { companyId: "64d3a8f2c54f4020a959c9ab" });
});

test("customer list service scopes queries to current company", async () => {
  const original = Customer.find;
  const calls = [];

  Customer.find = (query) => {
    calls.push(query);
    return {
      sort: () => ({
        lean: async () => [{ _id: "customer-1" }],
      }),
    };
  };

  try {
    const customers = await listCustomers("64d3a8f2c54f4020a959c9ab");
    assert.equal(customers.length, 1);
    assert.deepEqual(calls[0], { companyId: "64d3a8f2c54f4020a959c9ab", isDeleted: false });
  } finally {
    Customer.find = original;
  }
});

test("customer create service rejects duplicate emails in the same company", async () => {
  const originalFindOne = Customer.findOne;
  const originalCreate = Customer.create;

  Customer.findOne = async (query) => ({ _id: "existing-customer", email: query.email });
  Customer.create = async () => {
    throw new Error("should not create duplicate customer");
  };

  try {
    await assert.rejects(() => createCustomer("64d3a8f2c54f4020a959c9ab", { name: "Duplicate Customer", email: "dup@example.com" }), /already exists/);
  } finally {
    Customer.findOne = originalFindOne;
    Customer.create = originalCreate;
  }
});

test("customer routes require authentication for company-owned reads", async () => {
  const response = await request(app).get("/api/v1/customers");
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});

test("agent routes require authentication for company-owned reads", async () => {
  const response = await request(app).get("/api/v1/agents");
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
});
