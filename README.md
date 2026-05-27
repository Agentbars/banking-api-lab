# banking-api-lab

A small personal-banking REST API built as the substrate for the AQA Course
"API Testing with Playwright" exercise. Single currency (USD), opaque Bearer
tokens, Prisma + PostgreSQL.

The customer-facing API contract is in
[`docs/2026-05-27-banking-api-customer-requirements.md`](docs/2026-05-27-banking-api-customer-requirements.md).

The implementation contains **two intentional defects** that are reproducible
only via pairwise / combinatorial tests. They are documented (only) in the
internal design doc — `docs/2026-05-27-banking-api-feature-design.md`. Do not
share that doc with students.

## Quick start

```bash
cp .env.example .env
docker compose build
docker compose up -d
# API is on http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/health
```

## Local dev (without Docker)

```bash
# 1. Start a Postgres somewhere reachable
# 2. Set DATABASE_URL in .env
npm install
npx prisma migrate dev --name init
npm run dev
```

## Tech

- Node 20 LTS, TypeScript (strict)
- Express
- Prisma 5 + PostgreSQL 15
- bcrypt + opaque Bearer tokens (no JWT)
- `Decimal(14, 2)` for all money
