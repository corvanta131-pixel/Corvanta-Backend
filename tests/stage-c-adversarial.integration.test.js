const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = "stage-c-integration-access-secret";
process.env.JWT_REFRESH_SECRET = "stage-c-integration-refresh-secret";

let mongo;
let app;
let models;
let a;
let b;

const resources = [
  { key: "customer", path: "customers", model: "Customer", label: "customer" },
  { key: "employee", path: "users", model: "User", label: "employee" },
  { key: "agent", path: "agents", model: "AIAgent", label: "agent" },
  { key: "knowledgeBase", path: "knowledge-bases", model: "KnowledgeBase", label: "knowledge base" },
  { key: "document", path: "knowledge-documents", model: "KnowledgeDocument", label: "document" },
  { key: "conversation", path: "conversations", model: "Conversation", label: "conversation" },
];

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function bodyFor(resource, tenant, overrides = {}) {
  const base = {
    customer: { name: `${tenant} Customer`, email: `${tenant.toLowerCase()}-customer@example.com` },
    employee: { name: `${tenant} Employee`, email: `${tenant.toLowerCase()}-employee@example.com`, password: "Password123!" },
    agent: { name: `${tenant} Agent`, status: "active" },
    knowledgeBase: { name: `${tenant} Knowledge Base` },
    document: { title: `${tenant} Document`, content: `${tenant} confidential content`, knowledgeBaseId: tenant === "A" ? a.knowledgeBase._id : b.knowledgeBase._id },
    conversation: { title: `${tenant} Conversation`, customerId: tenant === "A" ? a.customer._id : b.customer._id, agentId: tenant === "A" ? a.agent._id : b.agent._id },
  };
  return { ...base[resource], ...overrides };
}

async function login(email, password = "Password123!") {
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password });
  assert.equal(response.status, 200);
  return response.body.data.accessToken;
}

function assertNoLeak(response, forbiddenValues) {
  const serialized = JSON.stringify(response.body);
  for (const value of forbiddenValues) {
    assert.equal(serialized.includes(String(value)), false, `response leaked ${value}`);
  }
}

async function reload(tenant, key) {
  const model = models[resources.find((item) => item.key === key).model];
  return model.findById(tenant[key]._id).lean();
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri("corvanta_stage_c_adversarial");

  app = require("../app");
  models = {
    Company: require("../src/models/Company"),
    User: require("../src/models/User"),
    Role: require("../src/models/Role"),
    Customer: require("../src/models/Customer"),
    AIAgent: require("../src/models/AIAgent"),
    KnowledgeBase: require("../src/models/KnowledgeBase"),
    KnowledgeDocument: require("../src/models/KnowledgeDocument"),
    Conversation: require("../src/models/Conversation"),
    RefreshToken: require("../src/models/RefreshToken"),
    AuditLog: require("../src/models/AuditLog"),
  };

  await mongoose.connect(process.env.MONGO_URI);
  const passwordHash = await bcrypt.hash("Password123!", 4);
  const [companyA, companyB] = await models.Company.create([
    { name: "Stage C Company A", slug: "stage-c-company-a" },
    { name: "Stage C Company B", slug: "stage-c-company-b" },
  ]);
  const permissions = [
    "employees:read", "employees:create", "employees:update", "employees:delete",
    "customers:read", "customers:create", "customers:update", "customers:delete",
    "agents:read", "agents:create", "agents:update", "agents:delete",
    "knowledge:read", "knowledge:create", "knowledge:update", "knowledge:delete",
    "conversations:read", "conversations:create", "conversations:update", "conversations:delete",
  ];
  const [roleA, roleB, readonlyRole] = await models.Role.create([
    { companyId: companyA._id, name: "A Admin", slug: "stage-c-a-admin", permissions },
    { companyId: companyB._id, name: "B Admin", slug: "stage-c-b-admin", permissions },
    { companyId: companyA._id, name: "A Read Only", slug: "stage-c-a-readonly", permissions: ["customers:read"] },
  ]);
  const [adminA, adminB, readonlyA] = await models.User.create([
    { companyId: companyA._id, name: "Company A Admin", email: "stage-c-admin-a@example.com", passwordHash, roleId: roleA._id, status: "active" },
    { companyId: companyB._id, name: "Company B Admin", email: "stage-c-admin-b@example.com", passwordHash, roleId: roleB._id, status: "active" },
    { companyId: companyA._id, name: "Company A Read Only", email: "stage-c-readonly-a@example.com", passwordHash, roleId: readonlyRole._id, status: "active" },
  ]);
  companyA.ownerId = adminA._id;
  companyB.ownerId = adminB._id;
  await companyA.save();
  await companyB.save();

  const [customerA, customerB] = await models.Customer.create([
    { companyId: companyA._id, name: "A Customer", email: "a-customer@example.com" },
    { companyId: companyB._id, name: "B Customer", email: "b-customer@example.com" },
  ]);
  const [employeeA, employeeB] = await models.User.create([
    { companyId: companyA._id, name: "A Employee", email: "a-employee@example.com", passwordHash, roleId: roleA._id, managerId: adminA._id },
    { companyId: companyB._id, name: "B Employee", email: "b-employee@example.com", passwordHash, roleId: roleB._id, managerId: adminB._id },
  ]);
  const [knowledgeBaseA, knowledgeBaseB] = await models.KnowledgeBase.create([
    { companyId: companyA._id, name: "A Knowledge Base", ownerId: adminA._id },
    { companyId: companyB._id, name: "B Knowledge Base", ownerId: adminB._id },
  ]);
  const [agentA, agentB] = await models.AIAgent.create([
    { companyId: companyA._id, name: "A Agent", slug: "a-agent", ownerId: adminA._id, knowledgeBaseIds: [knowledgeBaseA._id] },
    { companyId: companyB._id, name: "B Agent", slug: "b-agent", ownerId: adminB._id, knowledgeBaseIds: [knowledgeBaseB._id] },
  ]);
  const [documentA, documentB] = await models.KnowledgeDocument.create([
    { companyId: companyA._id, knowledgeBaseId: knowledgeBaseA._id, createdBy: adminA._id, title: "A Document", content: "A secret" },
    { companyId: companyB._id, knowledgeBaseId: knowledgeBaseB._id, createdBy: adminB._id, title: "B Document", content: "B secret" },
  ]);
  const [conversationA, conversationB] = await models.Conversation.create([
    { companyId: companyA._id, customerId: customerA._id, agentId: agentA._id, title: "A Conversation" },
    { companyId: companyB._id, customerId: customerB._id, agentId: agentB._id, title: "B Conversation" },
  ]);

  a = { company: companyA, admin: adminA, readonly: readonlyA, role: roleA, customer: customerA, employee: employeeA, agent: agentA, knowledgeBase: knowledgeBaseA, document: documentA, conversation: conversationA };
  b = { company: companyB, admin: adminB, role: roleB, customer: customerB, employee: employeeB, agent: agentB, knowledgeBase: knowledgeBaseB, document: documentB, conversation: conversationB };
  a.token = await login(adminA.email);
  b.token = await login(adminB.email);
  a.readonlyToken = await login(readonlyA.email);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test("adversarial LIST isolation excludes Company B and ignores tenant filter tampering", async () => {
  for (const resource of resources) {
    const response = await request(app)
      .get(`/api/v1/${resource.path}?companyId=${b.company._id}&isDeleted=true`)
      .set(auth(a.token));
    assert.equal(response.status, 200, resource.label);
    assert.equal(response.body.data.some((item) => String(item._id) === String(b[resource.key]._id)), false, resource.label);
    assert.equal(response.body.data.every((item) => String(item.companyId) === String(a.company._id)), true, resource.label);
  }
});

test("adversarial GET, UPDATE, and DELETE IDOR attempts cannot access Company B", async () => {
  for (const resource of resources) {
    const endpoint = `/api/v1/${resource.path}/${b[resource.key]._id}`;
    const getResponse = await request(app).get(endpoint).set(auth(a.token));
    assert.ok([403, 404].includes(getResponse.status), resource.label);
    assertNoLeak(getResponse, [b[resource.key]._id, `B ${resource.label}`]);

    const updateResponse = await request(app).patch(endpoint).set(auth(a.token)).send(bodyFor(resource.key, "A", { companyId: b.company._id }));
    assert.ok([400, 403, 404].includes(updateResponse.status), resource.label);
    assertNoLeak(updateResponse, [b[resource.key]._id, `B ${resource.label}`]);

    const deleteResponse = await request(app).delete(endpoint).set(auth(a.token));
    assert.ok([403, 404].includes(deleteResponse.status), resource.label);
    assertNoLeak(deleteResponse, [b[resource.key]._id, `B ${resource.label}`]);
    const unchanged = await reload(b, resource.key);
    assert.equal(unchanged.isDeleted, false, `${resource.label} was deleted`);
  }
});

test("adversarial CREATE relationship attacks reject every Company B reference", async () => {
  const attacks = [
    ["conversations", { title: "cross customer", customerId: b.customer._id }],
    ["conversations", { title: "cross agent", agentId: b.agent._id }],
    ["knowledge-documents", { title: "cross document", knowledgeBaseId: b.knowledgeBase._id }],
    ["knowledge-documents", { title: "cross creator", knowledgeBaseId: a.knowledgeBase._id, createdBy: b.admin._id }],
    ["agents", { name: "cross owner", ownerId: b.admin._id }],
    ["agents", { name: "cross kb", knowledgeBaseIds: [b.knowledgeBase._id] }],
    ["knowledge-bases", { name: "cross owner", ownerId: b.admin._id }],
    ["users", { name: "cross manager", email: "cross-manager@example.com", password: "Password123!", managerId: b.employee._id }],
  ];
  for (const [path, payload] of attacks) {
    const response = await request(app).post(`/api/v1/${path}`).set(auth(a.token)).send(payload);
    assert.equal(response.status, 403, path);
    assertNoLeak(response, [b.company._id, b.admin._id, b.employee._id, b.knowledgeBase._id]);
  }
});

test("adversarial UPDATE relationship attacks preserve Company A relationships", async () => {
  const attacks = [
    ["conversations", a.conversation, { customerId: b.customer._id }, "customerId"],
    ["conversations", a.conversation, { agentId: b.agent._id }, "agentId"],
    ["knowledge-documents", a.document, { knowledgeBaseId: b.knowledgeBase._id }, "knowledgeBaseId"],
    ["knowledge-documents", a.document, { createdBy: b.admin._id }, "createdBy"],
    ["agents", a.agent, { ownerId: b.admin._id }, "ownerId"],
    ["agents", a.agent, { knowledgeBaseIds: [b.knowledgeBase._id] }, "knowledgeBaseIds"],
    ["knowledge-bases", a.knowledgeBase, { ownerId: b.admin._id }, "ownerId"],
    ["users", a.employee, { managerId: b.employee._id }, "managerId"],
  ];
  for (const [path, resource, override, field] of attacks) {
    const key = path === "users" ? "employee" : resources.find((item) => item.path === path).key;
    const response = await request(app).patch(`/api/v1/${path}/${resource._id}`).set(auth(a.token)).send(bodyFor(key, "A", override));
    assert.equal(response.status, 403, `${path}.${field}`);
    const stored = await reload(a, key);
    assert.deepEqual(String(stored[field]), String(a[key][field]), `${path}.${field} changed`);
  }
});

test("companyId tampering and mass assignment cannot change ownership or system fields", async () => {
  const arbitraryCompanyId = new mongoose.Types.ObjectId();
  for (const resource of resources) {
    const createResponse = await request(app).post(`/api/v1/${resource.path}`).set(auth(a.token)).send({
      ...bodyFor(resource.key, "A"),
      companyId: b.company._id,
    });
    assert.equal(createResponse.status, 400, `${resource.label} create companyId`);

    const updateResponse = await request(app).patch(`/api/v1/${resource.path}/${a[resource.key]._id}`).set(auth(a.token)).send({
      ...bodyFor(resource.key, "A"),
      companyId: arbitraryCompanyId,
      _id: b[resource.key]._id,
      isDeleted: true,
      deletedAt: new Date().toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    assert.equal(updateResponse.status, 400, `${resource.label} update protected fields`);
    const stored = await reload(a, resource.key);
    assert.equal(String(stored.companyId), String(a.company._id));
    assert.equal(stored.isDeleted, false);
  }
});

test("permissions are enforced independently of valid Company A authentication", async () => {
  const protectedOperations = [
    ["customers", "post", bodyFor("customer", "A")],
    ["agents", "post", bodyFor("agent", "A")],
    ["knowledge-bases", "post", bodyFor("knowledgeBase", "A")],
    ["knowledge-documents", "post", bodyFor("document", "A")],
    ["conversations", "post", bodyFor("conversation", "A")],
    ["users", "post", bodyFor("employee", "A")],
    ["customers", "patch", bodyFor("customer", "A")],
    ["customers", "delete", null],
  ];
  for (const [path, method, payload] of protectedOperations) {
    const target = method === "post" ? `/api/v1/${path}` : `/api/v1/${path}/${a.customer._id}`;
    let requestBuilder = request(app)[method](target).set(auth(a.readonlyToken));
    if (payload) requestBuilder = requestBuilder.send(payload);
    const response = await requestBuilder;
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  const roleEscalation = await request(app)
    .patch(`/api/v1/users/${a.employee._id}`)
    .set(auth(a.token))
    .send(bodyFor("employee", "A", { roleId: b.role._id }));
  assert.equal(roleEscalation.status, 403);
  assert.equal(String((await models.User.findById(a.employee._id).lean()).roleId), String(a.role._id));
  const crossTenant = await request(app).get(`/api/v1/customers/${b.customer._id}`).set(auth(a.readonlyToken));
  assert.ok([403, 404].includes(crossTenant.status));
});

test("soft deletion removes Company A resources from normal access and relationship targets", async () => {
  const created = await request(app).post("/api/v1/customers").set(auth(a.token)).send({
    name: "A Delete Me",
    email: "a-delete-me@example.com",
  });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  const deleted = await request(app).delete(`/api/v1/customers/${id}`).set(auth(a.token));
  assert.equal(deleted.status, 200);
  const stored = await models.Customer.findById(id).lean();
  assert.equal(stored.isDeleted, true);
  assert.ok(stored.deletedAt);
  assert.equal((await request(app).get(`/api/v1/customers/${id}`).set(auth(a.token))).status, 404);
  assert.equal((await request(app).get("/api/v1/customers").set(auth(a.token))).body.data.some((item) => String(item._id) === String(id)), false);
  assert.equal((await request(app).patch(`/api/v1/customers/${id}`).set(auth(a.token)).send({ name: "revive", email: "revive@example.com" })).status, 404);
  const relation = await request(app).post("/api/v1/conversations").set(auth(a.token)).send({ title: "deleted target", customerId: id });
  assert.equal(relation.status, 403);
  assert.equal((await models.Customer.findById(id).lean()).isDeleted, true);

  const bCreated = await request(app).post("/api/v1/customers").set(auth(b.token)).send({
    name: "B Delete Me",
    email: "b-delete-me@example.com",
  });
  assert.equal(bCreated.status, 201);
  const bDeletedId = bCreated.body.data._id;
  assert.equal((await request(app).delete(`/api/v1/customers/${bDeletedId}`).set(auth(b.token))).status, 200);
  assert.equal((await request(app).get(`/api/v1/customers/${bDeletedId}`).set(auth(a.token))).status, 404);
  assert.equal((await request(app).delete(`/api/v1/customers/${bDeletedId}`).set(auth(a.token))).status, 404);
  assert.equal((await models.Customer.findById(bDeletedId).lean()).isDeleted, true);
});

test("valid MongoDB IDs from Company B are denied while malformed IDs return controlled 400 responses", async () => {
  for (const resource of resources) {
    const response = await request(app).get(`/api/v1/${resource.path}/not-a-valid-object-id`).set(auth(a.token));
    assert.equal(response.status, 400, resource.label);
    assert.equal(response.body.success, false);
    assert.equal(JSON.stringify(response.body).includes("CastError"), false);
  }
  const validIdResponse = await request(app).get(`/api/v1/customers/${b.customer._id}`).set(auth(a.token));
  assert.ok([403, 404].includes(validIdResponse.status));
});

test("database state proves cross-tenant attacks did not mutate or reassign records", async () => {
  const bChecks = await Promise.all([
    models.Company.findById(b.company._id).lean(),
    models.User.findById(b.employee._id).lean(),
    models.Customer.findById(b.customer._id).lean(),
    models.AIAgent.findById(b.agent._id).lean(),
    models.KnowledgeBase.findById(b.knowledgeBase._id).lean(),
    models.KnowledgeDocument.findById(b.document._id).lean(),
    models.Conversation.findById(b.conversation._id).lean(),
  ]);
  assert.equal(String(bChecks[0]._id), String(b.company._id));
  assert.equal(String(bChecks[1].companyId), String(b.company._id));
  assert.equal(String(bChecks[2].companyId), String(b.company._id));
  assert.equal(String(bChecks[3].companyId), String(b.company._id));
  assert.equal(String(bChecks[4].companyId), String(b.company._id));
  assert.equal(String(bChecks[5].companyId), String(b.company._id));
  assert.equal(String(bChecks[5].knowledgeBaseId), String(b.knowledgeBase._id));
  assert.equal(String(bChecks[6].companyId), String(b.company._id));
  assert.equal(String(bChecks[6].customerId), String(b.customer._id));
  assert.equal(String(bChecks[6].agentId), String(b.agent._id));
});
