# Banking API Lab

A small banking-style REST API I built in May 2026 for the **API Testing with Playwright** exercise in my QA automation course. It gives students a predictable service for practising API tests with a database, authentication, and related records.

## How I built it

This was one of my first experiments with agentic development. I used a coding agent while I was learning how to break work into tasks, give the agent enough context, and check what it built. My goal was to get a working practice environment into the course. The project reflects how I worked with agents at that stage.

## What to practise

- Register a user and obtain a bearer token, then use it for authenticated requests.
- Test account creation, transfers, transaction history, and statements.
- Check response contracts, validation errors, and state changes across related requests.
- Use boundary and pairwise testing to cover combinations of inputs.

The [student-facing API contract](docs/2026-05-27-banking-api-customer-requirements.md) defines the expected behaviour. Use synthetic data and your local lab instance.

## Run locally

With Docker and Docker Compose installed:

```bash
docker compose up -d --build
curl http://localhost:3001/health
```

The API container listens on port 3000 and Compose exposes it on port 3001. The container applies Prisma migrations on startup. For development without Docker, start PostgreSQL, copy `.env.example` to `.env`, fill in a local `DATABASE_URL`, then run `npm ci`, `npm run prisma:migrate:dev`, and `npm run dev`.

**Stack:** TypeScript, Express, Prisma, PostgreSQL, Docker Compose.
