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

## Production deploy (VPS, behind Traefik)

The production stack lives at `/docker/banking-api-lab` on the VPS,
next to MailLab. The host's Traefik (in `/docker/traefik`) auto-discovers
this container via Docker labels and obtains a Let's Encrypt cert.

First-time provisioning:

```bash
ssh hostinger
cd /docker
git clone git@github.com:Agentbars/banking-api-lab.git
cd banking-api-lab
printf 'DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
chmod 600 .env
docker compose -f docker-compose.prod.yml up -d --build
```

After that, every redeploy is just:

```bash
ssh hostinger '/docker/banking-api-lab/deploy.sh'
```

Public URL: <https://banking.srv1505121.hstgr.cloud>.

## Tech

- Node 20 LTS, TypeScript (strict)
- Express
- Prisma 5 + PostgreSQL 16
- bcrypt + opaque Bearer tokens (no JWT)
- `Decimal(14, 2)` for all money
