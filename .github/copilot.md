Create or update `.github/copilot-instructions.md` for this repository.

Before changing application code, inspect the existing Corvanta backend and understand its current architecture.

Project:

* Corvanta is a multi-tenant AI customer-service platform.
* Backend: Node.js + Express + MongoDB + Mongoose.
* Authentication uses JWT access and refresh tokens.
* The application uses `/api/v1`.
* The company is the tenant boundary.
* Region → Country → City → Company is the organizational hierarchy.
* Company-owned resources must be isolated by `companyId`.

Current architecture:

* Keep controllers thin.
* Keep business logic in services.
* Keep authentication and authorization in middleware.
* Keep integrations behind provider/service abstractions.
* Preserve the existing error handling, validation, logging, security middleware, and configuration structure.
* MongoDB Atlas is the current database.
* Do not expose secrets or credentials in source code.
* `.env` must remain ignored by Git.

Critical security rule:

* Never weaken or bypass tenant isolation.
* Every company-owned query, create, update, delete, and lookup must be scoped to the authenticated user's company.
* Never trust a `companyId` supplied by the client when the authenticated context already determines the tenant.
* Authentication and authorization are separate concerns.
* Permission checks must remain enforced.

Development rules:

* Prefer existing dependencies and patterns before adding new dependencies.
* Do not rewrite working foundation code unnecessarily.
* Do not introduce Docker, Terraform, Kubernetes, ECS, EKS, ALB, AWS infrastructure, billing, or frontend code at this stage.
* Do not implement real AI provider calls yet.
* Do not implement real Cloudinary or Resend integrations yet.
* Every meaningful feature should have appropriate automated tests.
* Validate ObjectIds and request input.
* Use appropriate MongoDB indexes based on actual query patterns.
* Prefer soft deletion where appropriate.
* Keep the code modular and easy to migrate later.

Before implementing a major feature:

1. Inspect the existing repository.
2. Explain the relevant existing architecture briefly.
3. Identify files that need to change.
4. Implement the smallest coherent change.
5. Run the relevant tests.
6. Report what changed, what passed, and anything still deferred.

Do not replace the existing architecture simply because another architecture is possible.
