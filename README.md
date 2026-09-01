# Corvanta Backend

Corvanta is an AI-powered business and customer service platform for multi-tenant operations across regions, countries, cities, and companies.

## Purpose

This backend provides a production-ready foundation for:

- multi-tenant company isolation
- authentication and authorization
- central service architecture
- AI provider abstraction
- storage abstraction
- email abstraction
- MongoDB data model foundation
- health monitoring and API versioning

## Stack

- Node.js
- Express.js
- MongoDB + Mongoose
- JWT authentication
- bcryptjs password hashing
- Helmet, CORS, Morgan
- REST API with versioning under /api/v1

## Architecture

The initial foundation follows a modular layout inspired by enterprise backend systems:

- `src/config` for environment and database startup
- `src/controllers` for request handling
- `src/services` for business logic
- `src/models` for MongoDB schemas
- `src/routes` for API endpoints
- `src/middleware` for auth, errors, and security
- `src/utils` for reusable helpers
- `src/integrations` for AI, email, and storage abstraction

## Local installation

1. Copy `.env.example` to `.env` if needed.
2. Install dependencies:
   npm install
3. Start the app:
   npm run dev

## Scripts

- `npm run dev` — starts the app with nodemon
- `npm start` — production start command
- `npm test` — runs the test suite

## API versioning

All API endpoints are prefixed with:

- `/api/v1`

## Health check

- `GET /api/v1/health`

## Environment variables

See `.env.example` for the supported variables. All local placeholders are safe development values only.

## Development conventions

- Keep business logic out of routes.
- Use centralized error handling.
- Protect routes with authentication + authorization middleware.
- Validate environment variables on startup.
- Never commit `.env` or real credentials.
- Email addresses are treated as globally unique across the platform to keep authentication consistent and tenant-safe.

## Notes

This is a Phase 1 foundation. The architecture is designed to scale toward AI agents, customer conversations, knowledge retrieval, and multi-tenant administration.
# Corvanta-Backend
