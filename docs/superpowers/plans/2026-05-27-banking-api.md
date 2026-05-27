# Banking API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal-banking REST API per the spec at `D:\programs\finance_api_lab\2026-05-27-banking-api-feature-design.md`, containing 16 endpoints and 2 intentional defects (frozen-destination accepted, daily-limit double-counts reversed transfers).

**Architecture:** Node.js 20 + TypeScript (strict) + Express + Prisma + PostgreSQL 15, deployed via Docker Compose. Opaque Bearer tokens in DB. Decimal(14,2) for money. Layered structure: routes → services → repositories (Prisma). One Express app, mounted on `/`.

**Tech Stack:** Node 20, TypeScript strict, Express, Prisma 5, PostgreSQL 15, bcrypt, zod, decimal.js (via Prisma.Decimal), vitest + supertest for tests, Docker Compose.

---

## File Structure

```
banking-api-lab/
├── docker-compose.yml          # postgres + api
├── Dockerfile                  # multi-stage build
├── package.json
├── tsconfig.json
├── .env.example
├── prisma/
│   ├── schema.prisma           # User, AuthToken, Account, Transaction, Transfer
│   └── migrations/...
├── src/
│   ├── server.ts               # entry: createApp + listen
│   ├── app.ts                  # express app factory (no listen — for tests)
│   ├── db.ts                   # PrismaClient singleton
│   ├── errors.ts               # AppError class + httpError helper
│   ├── middleware/
│   │   ├── auth.ts             # Bearer-token → req.user
│   │   └── errorHandler.ts     # Express error → error envelope
│   ├── lib/
│   │   ├── decimal.ts          # parse/format Decimal safely
│   │   ├── accountNumber.ts    # generate 10-digit account numbers
│   │   └── token.ts            # secure random opaque token
│   ├── routes/
│   │   ├── auth.ts             # POST /auth/register, /auth/login, GET /me
│   │   ├── accounts.ts         # GET/POST/PATCH/DELETE /accounts (+:id)
│   │   ├── transactions.ts     # GET /accounts/:id/transactions, deposit, withdraw
│   │   ├── transfers.ts        # POST /transfers, GET /transfers/:id, /reverse, /batch
│   │   └── statements.ts       # GET /accounts/:id/statement
│   └── services/
│       ├── auth.service.ts
│       ├── accounts.service.ts
│       ├── transactions.service.ts
│       ├── transfers.service.ts    # contains Defect #1 + Defect #2
│       └── statements.service.ts
└── tests/
    ├── helpers.ts              # test client + fixtures
    ├── auth.test.ts
    ├── accounts.test.ts
    ├── transactions.test.ts
    ├── transfers.test.ts       # includes pairwise tests for defects
    └── statements.test.ts
```

---

## Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "banking-api-lab",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate deploy",
    "prisma:migrate:dev": "prisma migrate dev"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0",
    "bcrypt": "^5.1.1",
    "cuid": "^3.0.0",
    "express": "^4.21.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/express": "^5.0.0",
    "@types/node": "^20.17.6",
    "@types/supertest": "^6.0.2",
    "prisma": "^5.22.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": false,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.env
.env.local
*.log
coverage/
```

- [ ] **Step 4: Create `.env.example`**

```
DATABASE_URL="postgresql://banking:banking@localhost:5432/banking?schema=public"
PORT=3000
NODE_ENV=development
```

- [ ] **Step 5: Create `README.md`** with short usage notes (docker-compose up, npm test, public hostname target).

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: scaffold project skeleton"
```

---

## Task 2: Docker Compose + Dockerfile

**Files:**
- Create: `docker-compose.yml`, `Dockerfile`

- [ ] **Step 1: Create `Dockerfile` (multi-stage)**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: banking
      POSTGRES_PASSWORD: banking
      POSTGRES_DB: banking
    volumes:
      - banking_pgdata:/var/lib/postgresql/data
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U banking -d banking"]
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build: .
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://banking:banking@postgres:5432/banking?schema=public
      PORT: 3000
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "3000:3000"

volumes:
  banking_pgdata:
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "chore: docker compose with postgres + api"
```

---

## Task 3: Prisma schema + initial migration

**Files:**
- Create: `prisma/schema.prisma`

- [ ] **Step 1: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String
  password  String
  createdAt DateTime @default(now())

  accounts Account[]
  tokens   AuthToken[]
}

model AuthToken {
  id        String   @id @default(cuid())
  userId    String
  token     String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([token])
}

enum AccountType {
  checking
  savings
}

enum AccountStatus {
  active
  frozen
  closed
}

model Account {
  id        String        @id @default(cuid())
  userId    String
  type      AccountType
  number    String        @unique
  currency  String        @default("USD")
  balance   Decimal       @db.Decimal(14, 2) @default(0)
  status    AccountStatus @default(active)
  createdAt DateTime      @default(now())

  user         User          @relation(fields: [userId], references: [id])
  transactions Transaction[]

  @@index([userId])
}

enum TransactionType {
  deposit
  withdrawal
  transfer_in
  transfer_out
}

enum TransactionStatus {
  pending
  posted
  rejected
  reversed
}

model Transaction {
  id                    String            @id @default(cuid())
  accountId             String
  type                  TransactionType
  amount                Decimal           @db.Decimal(14, 2)
  status                TransactionStatus
  counterpartyAccountId String?
  transferId            String?
  description           String?
  createdAt             DateTime          @default(now())

  account  Account   @relation(fields: [accountId], references: [id])
  transfer Transfer? @relation(fields: [transferId], references: [id])

  @@index([accountId, createdAt])
  @@index([transferId])
}

enum TransferStatus {
  pending
  posted
  failed
  reversed
}

model Transfer {
  id            String         @id @default(cuid())
  fromAccountId String
  toAccountId   String
  amount        Decimal        @db.Decimal(14, 2)
  status        TransferStatus
  batchId       String?
  createdAt     DateTime       @default(now())
  postedAt      DateTime?

  transactions Transaction[]

  @@index([fromAccountId, createdAt])
  @@index([toAccountId])
  @@index([batchId])
}
```

- [ ] **Step 2: Note — migration is generated at run time via `docker compose up` (entrypoint runs `prisma migrate deploy`).** For dev, the developer runs `npx prisma migrate dev --name init` once a postgres is reachable. We don't pre-create the migration directory in this plan; it will be generated when the dev runs the command.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: prisma schema for banking domain"
```

---

## Task 4: Core utilities (db, errors, decimal, token, accountNumber)

**Files:**
- Create: `src/db.ts`, `src/errors.ts`, `src/lib/decimal.ts`, `src/lib/token.ts`, `src/lib/accountNumber.ts`

- [ ] **Step 1: Create `src/db.ts`**

```ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
```

- [ ] **Step 2: Create `src/errors.ts`**

```ts
export type ErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
};

export class AppError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { error: { code: this.code, message: this.message } };
    if (this.fields) body.error.fields = this.fields;
    return body;
  }
}
```

- [ ] **Step 3: Create `src/lib/decimal.ts`**

```ts
import { Prisma } from '@prisma/client';

export function toDecimal(input: unknown): Prisma.Decimal {
  if (input instanceof Prisma.Decimal) return input;
  if (typeof input === 'number') return new Prisma.Decimal(input.toFixed(2));
  if (typeof input === 'string') return new Prisma.Decimal(input);
  throw new Error('Cannot coerce value to Decimal');
}

export function isPositive(d: Prisma.Decimal): boolean {
  return d.greaterThan(0);
}

export function formatDecimal(d: Prisma.Decimal): string {
  return d.toFixed(2);
}
```

- [ ] **Step 4: Create `src/lib/token.ts`**

```ts
import { randomBytes } from 'node:crypto';

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
```

- [ ] **Step 5: Create `src/lib/accountNumber.ts`**

```ts
import { randomInt } from 'node:crypto';

export function generateAccountNumber(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += randomInt(0, 10).toString();
  return out;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/errors.ts src/lib/
git commit -m "feat: core utilities (db, errors, decimal, token, account number)"
```

---

## Task 5: App factory, error handler, auth middleware

**Files:**
- Create: `src/app.ts`, `src/server.ts`, `src/middleware/errorHandler.ts`, `src/middleware/auth.ts`

- [ ] **Step 1: Create `src/middleware/errorHandler.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors.js';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
```

- [ ] **Step 2: Create `src/middleware/auth.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';

export interface AuthUser { id: string; email: string; name: string; createdAt: Date; }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser; }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header('authorization') ?? req.header('Authorization');
    if (!header) throw new AppError(401, 'TOKEN_MISSING', 'Authorization header is missing');
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) throw new AppError(401, 'TOKEN_MISSING', 'Bearer token is missing');
    const token = m[1]!.trim();
    if (!token) throw new AppError(401, 'TOKEN_MISSING', 'Bearer token is empty');

    const found = await prisma.authToken.findUnique({ where: { token }, include: { user: true } });
    if (!found) throw new AppError(401, 'TOKEN_INVALID', 'Token is invalid');
    if (found.expiresAt.getTime() <= Date.now()) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Token has expired');
    }
    req.user = {
      id: found.user.id,
      email: found.user.email,
      name: found.user.name,
      createdAt: found.user.createdAt,
    };
    next();
  } catch (e) {
    next(e);
  }
}
```

- [ ] **Step 3: Create `src/app.ts`**

```ts
import express from 'express';
import { errorHandler } from './middleware/errorHandler.js';
import authRouter from './routes/auth.js';
import accountsRouter from './routes/accounts.js';
import transactionsRouter from './routes/transactions.js';
import transfersRouter from './routes/transfers.js';
import statementsRouter from './routes/statements.js';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(authRouter);
  app.use(accountsRouter);
  app.use(transactionsRouter);
  app.use(transfersRouter);
  app.use(statementsRouter);
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 4: Create `src/server.ts`**

```ts
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`banking-api listening on :${port}`);
});
```

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/server.ts src/middleware/
git commit -m "feat: express app, error handler, auth middleware"
```

---

## Task 6: Auth routes (`/auth/register`, `/auth/login`, `/me`)

**Files:**
- Create: `src/services/auth.service.ts`, `src/routes/auth.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: Create `src/services/auth.service.ts`**

```ts
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { generateOpaqueToken } from '../lib/token.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

function validationError(err: z.ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] = issue.message;
  }
  return new AppError(400, 'VALIDATION_FAILED', 'Validation failed', fields);
}

export async function registerUser(body: unknown) {
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  const { email, name, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'Email already registered');

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, name, password: hash } });
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt.toISOString() };
}

export async function loginUser(body: unknown) {
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.authToken.create({ data: { userId: user.id, token, expiresAt } });

  return { token, expiresAt: expiresAt.toISOString() };
}
```

- [ ] **Step 2: Create `src/routes/auth.ts`**

```ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { loginUser, registerUser } from '../services/auth.service.js';

const router = Router();

router.post('/auth/register', async (req, res, next) => {
  try { res.status(201).json(await registerUser(req.body)); } catch (e) { next(e); }
});

router.post('/auth/login', async (req, res, next) => {
  try { res.status(200).json(await loginUser(req.body)); } catch (e) { next(e); }
});

router.get('/me', requireAuth, (req, res) => {
  const u = req.user!;
  res.json({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt.toISOString() });
});

export default router;
```

- [ ] **Step 3: Smoke check** — start the app locally with a running Postgres (see Task 14 for full test infrastructure). Defer end-to-end tests for now; we'll add the full integration suite at the end.

- [ ] **Step 4: Commit**

```bash
git add src/services/auth.service.ts src/routes/auth.ts
git commit -m "feat: auth endpoints (register, login, me)"
```

---

## Task 7: Accounts routes (`GET /accounts`, `POST /accounts`, `GET/PATCH/DELETE /accounts/:id`)

**Files:**
- Create: `src/services/accounts.service.ts`, `src/routes/accounts.ts`

- [ ] **Step 1: Create `src/services/accounts.service.ts`**

```ts
import { z } from 'zod';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { generateAccountNumber } from '../lib/accountNumber.js';
import type { Account, AccountStatus } from '@prisma/client';

const createSchema = z.object({ type: z.enum(['checking', 'savings']) });
const patchSchema = z.object({ status: z.enum(['active', 'frozen', 'closed']).optional() });

function serialize(a: Account) {
  return {
    id: a.id,
    type: a.type,
    number: a.number,
    currency: a.currency,
    balance: a.balance.toFixed(2),
    status: a.status,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listAccounts(userId: string) {
  const accounts = await prisma.account.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  return accounts.map(serialize);
}

export async function createAccount(userId: string, body: unknown) {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid account type', { type: 'must be "checking" or "savings"' });
  }
  // Retry up to 5 times in the (astronomically unlikely) event of number collision.
  for (let i = 0; i < 5; i++) {
    try {
      const created = await prisma.account.create({
        data: { userId, type: parsed.data.type, number: generateAccountNumber() },
      });
      return serialize(created);
    } catch (e: unknown) {
      if (i === 4) throw e;
    }
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Failed to create account');
}

async function loadOwnedAccount(userId: string, accountId: string): Promise<Account> {
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acc.userId !== userId) throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');
  return acc;
}

export async function getAccount(userId: string, accountId: string) {
  return serialize(await loadOwnedAccount(userId, accountId));
}

export async function patchAccount(userId: string, accountId: string, body: unknown) {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid patch body');
  }
  const acc = await loadOwnedAccount(userId, accountId);
  const next = parsed.data.status;
  if (next === undefined) return serialize(acc);
  if (next === 'closed' || acc.status === 'closed') {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Use DELETE to close an account; cannot transition via PATCH');
  }
  const updated = await prisma.account.update({
    where: { id: acc.id },
    data: { status: next as AccountStatus },
  });
  return serialize(updated);
}

export async function closeAccount(userId: string, accountId: string) {
  const acc = await loadOwnedAccount(userId, accountId);
  if (!acc.balance.equals(0)) {
    throw new AppError(409, 'ACCOUNT_HAS_BALANCE', 'Close requires zero balance');
  }
  if (acc.status === 'closed') return; // idempotent close
  await prisma.account.update({ where: { id: acc.id }, data: { status: 'closed' } });
}
```

- [ ] **Step 2: Create `src/routes/accounts.ts`**

```ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { closeAccount, createAccount, getAccount, listAccounts, patchAccount } from '../services/accounts.service.js';

const router = Router();

router.get('/accounts', requireAuth, async (req, res, next) => {
  try { res.json(await listAccounts(req.user!.id)); } catch (e) { next(e); }
});

router.post('/accounts', requireAuth, async (req, res, next) => {
  try { res.status(201).json(await createAccount(req.user!.id, req.body)); } catch (e) { next(e); }
});

router.get('/accounts/:id', requireAuth, async (req, res, next) => {
  try { res.json(await getAccount(req.user!.id, req.params.id!)); } catch (e) { next(e); }
});

router.patch('/accounts/:id', requireAuth, async (req, res, next) => {
  try { res.json(await patchAccount(req.user!.id, req.params.id!, req.body)); } catch (e) { next(e); }
});

router.delete('/accounts/:id', requireAuth, async (req, res, next) => {
  try { await closeAccount(req.user!.id, req.params.id!); res.status(204).end(); } catch (e) { next(e); }
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add src/services/accounts.service.ts src/routes/accounts.ts
git commit -m "feat: accounts CRUD with owner-only access and close-on-zero rule"
```

---

## Task 8: Transactions routes (list, deposit, withdraw)

**Files:**
- Create: `src/services/transactions.service.ts`, `src/routes/transactions.ts`

- [ ] **Step 1: Create `src/services/transactions.service.ts`**

```ts
import { Prisma, type Account, type Transaction } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { toDecimal } from '../lib/decimal.js';

const amountSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(500).optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function serializeTx(t: Transaction) {
  return {
    id: t.id,
    accountId: t.accountId,
    type: t.type,
    amount: t.amount.toFixed(2),
    status: t.status,
    counterpartyAccountId: t.counterpartyAccountId,
    transferId: t.transferId,
    description: t.description,
    createdAt: t.createdAt.toISOString(),
  };
}

async function loadOwnedAccountForMutation(tx: Prisma.TransactionClient, userId: string, accountId: string): Promise<Account> {
  const acc = await tx.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acc.userId !== userId) throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');
  return acc;
}

function parsePositiveAmount(input: unknown): Prisma.Decimal {
  const parsed = amountSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid amount body');
  let d: Prisma.Decimal;
  try { d = toDecimal(parsed.data.amount); } catch { throw new AppError(400, 'INVALID_AMOUNT', 'Amount is not a valid decimal'); }
  if (d.lessThanOrEqualTo(0)) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be > 0');
  // Restrict to 2 decimal places.
  if (d.decimalPlaces() > 2) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must have at most 2 decimal places');
  return d;
}

export async function listTransactions(userId: string, accountId: string, query: unknown) {
  const parsed = listSchema.safeParse(query);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid query');
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acc.userId !== userId) throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');

  const { limit, offset } = parsed.data;
  const [items, total] = await Promise.all([
    prisma.transaction.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.transaction.count({ where: { accountId } }),
  ]);
  return { items: items.map(serializeTx), total, limit, offset };
}

export async function deposit(userId: string, accountId: string, body: unknown) {
  const amount = parsePositiveAmount(body);
  const parsedBody = amountSchema.parse(body); // safe after parsePositiveAmount
  return prisma.$transaction(async (tx) => {
    const acc = await loadOwnedAccountForMutation(tx, userId, accountId);
    if (acc.status !== 'active') throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
    const created = await tx.transaction.create({
      data: {
        accountId: acc.id,
        type: 'deposit',
        amount,
        status: 'posted',
        description: parsedBody.description ?? null,
      },
    });
    await tx.account.update({ where: { id: acc.id }, data: { balance: { increment: amount } } });
    return serializeTx(created);
  });
}

export async function withdraw(userId: string, accountId: string, body: unknown) {
  const amount = parsePositiveAmount(body);
  const parsedBody = amountSchema.parse(body);
  return prisma.$transaction(async (tx) => {
    const acc = await loadOwnedAccountForMutation(tx, userId, accountId);
    if (acc.status !== 'active') throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
    if (acc.balance.lessThan(amount)) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
    const created = await tx.transaction.create({
      data: {
        accountId: acc.id,
        type: 'withdrawal',
        amount,
        status: 'posted',
        description: parsedBody.description ?? null,
      },
    });
    await tx.account.update({ where: { id: acc.id }, data: { balance: { decrement: amount } } });
    return serializeTx(created);
  });
}
```

- [ ] **Step 2: Create `src/routes/transactions.ts`**

```ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { deposit, listTransactions, withdraw } from '../services/transactions.service.js';

const router = Router();

router.get('/accounts/:id/transactions', requireAuth, async (req, res, next) => {
  try { res.json(await listTransactions(req.user!.id, req.params.id!, req.query)); } catch (e) { next(e); }
});

router.post('/accounts/:id/deposit', requireAuth, async (req, res, next) => {
  try { res.status(201).json(await deposit(req.user!.id, req.params.id!, req.body)); } catch (e) { next(e); }
});

router.post('/accounts/:id/withdraw', requireAuth, async (req, res, next) => {
  try { res.status(201).json(await withdraw(req.user!.id, req.params.id!, req.body)); } catch (e) { next(e); }
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add src/services/transactions.service.ts src/routes/transactions.ts
git commit -m "feat: transactions list + deposit + withdraw"
```

---

## Task 9: Transfers — single transfer + get + reverse (with Defect #1)

**Files:**
- Create: `src/services/transfers.service.ts`, `src/routes/transfers.ts`

- [ ] **Step 1: Create `src/services/transfers.service.ts` (single + get + reverse)**

The file is long. Splits between this task and Task 10 (batch). The single-transfer flow MUST contain the intentional Defect #1 (no destination-status check) and the daily-limit function for Defect #2.

```ts
import { Prisma, type Account, type Transfer } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { toDecimal } from '../lib/decimal.js';

const REVERSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = new Prisma.Decimal('10000.00');

const singleSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(500).optional(),
});

export function serializeTransfer(t: Transfer) {
  return {
    id: t.id,
    fromAccountId: t.fromAccountId,
    toAccountId: t.toAccountId,
    amount: t.amount.toFixed(2),
    status: t.status,
    batchId: t.batchId,
    createdAt: t.createdAt.toISOString(),
    postedAt: t.postedAt ? t.postedAt.toISOString() : null,
  };
}

function parsePositive(input: unknown): Prisma.Decimal {
  let d: Prisma.Decimal;
  try { d = toDecimal(input); } catch { throw new AppError(400, 'INVALID_AMOUNT', 'Amount is not a valid decimal'); }
  if (d.lessThanOrEqualTo(0)) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be > 0');
  if (d.decimalPlaces() > 2) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must have at most 2 decimal places');
  return d;
}

function startOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Sum of source-side transfer amounts today (UTC) for this user.
 *
 * 🐞 INTENTIONAL DEFECT #2: per the customer-facing spec, only `pending` and
 * `posted` count toward the daily limit; reversed transfers should NOT count
 * (the money came back). This implementation deliberately includes `reversed`,
 * which surfaces with the pairwise pattern (transfer $10K → reverse → try more).
 */
async function sumTodaysTransfers(tx: Prisma.TransactionClient, userId: string): Promise<Prisma.Decimal> {
  const accountIds = (await tx.account.findMany({ where: { userId }, select: { id: true } })).map((a) => a.id);
  if (accountIds.length === 0) return new Prisma.Decimal(0);

  const since = startOfUtcDay(new Date());
  const rows = await tx.transfer.findMany({
    where: {
      fromAccountId: { in: accountIds },
      createdAt: { gte: since },
      status: { in: ['pending', 'posted', 'reversed'] }, // 🐞 defect #2
    },
    select: { amount: true },
  });
  let sum = new Prisma.Decimal(0);
  for (const r of rows) sum = sum.plus(r.amount);
  return sum;
}

type SinglePlan = {
  fromAccountId: string;
  toAccountId: string;
  amount: Prisma.Decimal;
  description?: string | null;
};

type PlanRejection = { code: string; message: string; status: number };
type PlanResult = { ok: true } | { ok: false; rejection: PlanRejection };

/**
 * Validates one prospective transfer against current state. Used by both the
 * single-transfer endpoint and the batch endpoint.
 *
 * 🐞 INTENTIONAL DEFECT #1: the spec requires us to reject when the
 * destination account is not active (frozen/closed) with code
 * DESTINATION_ACCOUNT_NOT_ACTIVE. This implementation deliberately omits the
 * destination-status check; only the source is validated.
 */
async function validateSingle(
  tx: Prisma.TransactionClient,
  userId: string,
  plan: SinglePlan,
  alreadyConsumed: Prisma.Decimal,
): Promise<PlanResult> {
  if (plan.fromAccountId === plan.toAccountId) {
    return { ok: false, rejection: { status: 409, code: 'SAME_ACCOUNT', message: 'Source and destination accounts must differ' } };
  }
  const from = await tx.account.findUnique({ where: { id: plan.fromAccountId } });
  if (!from) return { ok: false, rejection: { status: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Source account not found' } };
  if (from.userId !== userId) {
    return { ok: false, rejection: { status: 403, code: 'FORBIDDEN', message: 'Source account does not belong to you' } };
  }
  if (from.status !== 'active') {
    return { ok: false, rejection: { status: 409, code: 'SOURCE_ACCOUNT_NOT_ACTIVE', message: 'Source account is not active' } };
  }

  const to = await tx.account.findUnique({ where: { id: plan.toAccountId } });
  if (!to) return { ok: false, rejection: { status: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Destination account not found' } };
  // 🐞 defect #1 — destination-status check intentionally omitted.

  if (from.balance.lessThan(plan.amount)) {
    return { ok: false, rejection: { status: 409, code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' } };
  }

  if (alreadyConsumed.plus(plan.amount).greaterThan(DAILY_LIMIT)) {
    return { ok: false, rejection: { status: 409, code: 'DAILY_LIMIT_EXCEEDED', message: 'Daily transfer limit of $10,000 reached' } };
  }

  return { ok: true };
}

async function applySingle(
  tx: Prisma.TransactionClient,
  plan: SinglePlan,
  opts: { batchId?: string | null } = {},
): Promise<Transfer> {
  const now = new Date();
  const transfer = await tx.transfer.create({
    data: {
      fromAccountId: plan.fromAccountId,
      toAccountId: plan.toAccountId,
      amount: plan.amount,
      status: 'posted',
      batchId: opts.batchId ?? null,
      postedAt: now,
    },
  });

  await tx.transaction.create({
    data: {
      accountId: plan.fromAccountId,
      type: 'transfer_out',
      amount: plan.amount,
      status: 'posted',
      counterpartyAccountId: plan.toAccountId,
      transferId: transfer.id,
      description: plan.description ?? null,
    },
  });
  await tx.transaction.create({
    data: {
      accountId: plan.toAccountId,
      type: 'transfer_in',
      amount: plan.amount,
      status: 'posted',
      counterpartyAccountId: plan.fromAccountId,
      transferId: transfer.id,
      description: plan.description ?? null,
    },
  });
  await tx.account.update({ where: { id: plan.fromAccountId }, data: { balance: { decrement: plan.amount } } });
  await tx.account.update({ where: { id: plan.toAccountId }, data: { balance: { increment: plan.amount } } });
  return transfer;
}

export async function createTransfer(userId: string, body: unknown) {
  const parsed = singleSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid transfer body');
  const amount = parsePositive(parsed.data.amount);
  const plan: SinglePlan = {
    fromAccountId: parsed.data.fromAccountId,
    toAccountId: parsed.data.toAccountId,
    amount,
    description: parsed.data.description ?? null,
  };
  return prisma.$transaction(async (tx) => {
    const consumed = await sumTodaysTransfers(tx, userId);
    const v = await validateSingle(tx, userId, plan, consumed);
    if (!v.ok) {
      throw new AppError(v.rejection.status, v.rejection.code, v.rejection.message);
    }
    const t = await applySingle(tx, plan);
    return serializeTransfer(t);
  });
}

export async function getTransfer(userId: string, transferId: string) {
  const t = await prisma.transfer.findUnique({ where: { id: transferId } });
  if (!t) throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Transfer not found');
  const [from, to] = await Promise.all([
    prisma.account.findUnique({ where: { id: t.fromAccountId } }),
    prisma.account.findUnique({ where: { id: t.toAccountId } }),
  ]);
  if (from?.userId !== userId && to?.userId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have access to this transfer');
  }
  return serializeTransfer(t);
}

export async function reverseTransfer(userId: string, transferId: string) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.transfer.findUnique({ where: { id: transferId } });
    if (!t) throw new AppError(404, 'TRANSFER_NOT_FOUND', 'Transfer not found');
    const from = await tx.account.findUnique({ where: { id: t.fromAccountId } });
    if (!from) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Source account not found');
    if (from.userId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the from-owner can reverse a transfer');
    }
    if (t.status !== 'posted') {
      throw new AppError(409, 'NOT_REVERSIBLE', 'Transfer is not in posted status');
    }
    if (!t.postedAt) throw new AppError(409, 'NOT_REVERSIBLE', 'Transfer has no postedAt');
    if (Date.now() - t.postedAt.getTime() > REVERSE_WINDOW_MS) {
      throw new AppError(410, 'REVERSE_WINDOW_EXPIRED', 'Reverse window of 24 hours has expired');
    }

    const updated = await tx.transfer.update({ where: { id: t.id }, data: { status: 'reversed' } });

    // Two new compensating transactions linked to the same transferId.
    await tx.transaction.create({
      data: {
        accountId: t.toAccountId,
        type: 'transfer_out',
        amount: t.amount,
        status: 'posted',
        counterpartyAccountId: t.fromAccountId,
        transferId: t.id,
        description: 'Reversal',
      },
    });
    await tx.transaction.create({
      data: {
        accountId: t.fromAccountId,
        type: 'transfer_in',
        amount: t.amount,
        status: 'posted',
        counterpartyAccountId: t.toAccountId,
        transferId: t.id,
        description: 'Reversal',
      },
    });
    await tx.account.update({ where: { id: t.toAccountId }, data: { balance: { decrement: t.amount } } });
    await tx.account.update({ where: { id: t.fromAccountId }, data: { balance: { increment: t.amount } } });

    return serializeTransfer(updated);
  });
}

// Exported for the batch endpoint in Task 10.
export const _internals = { sumTodaysTransfers, validateSingle, applySingle, parsePositive, DAILY_LIMIT };
```

- [ ] **Step 2: Create `src/routes/transfers.ts` (single + get + reverse only; batch added in Task 10)**

```ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createTransfer, getTransfer, reverseTransfer } from '../services/transfers.service.js';

const router = Router();

router.post('/transfers', requireAuth, async (req, res, next) => {
  try { res.status(201).json(await createTransfer(req.user!.id, req.body)); } catch (e) { next(e); }
});

router.get('/transfers/:id', requireAuth, async (req, res, next) => {
  try { res.json(await getTransfer(req.user!.id, req.params.id!)); } catch (e) { next(e); }
});

router.post('/transfers/:id/reverse', requireAuth, async (req, res, next) => {
  try { res.json(await reverseTransfer(req.user!.id, req.params.id!)); } catch (e) { next(e); }
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add src/services/transfers.service.ts src/routes/transfers.ts
git commit -m "feat: single transfer, get, reverse — incl. intentional defects #1 and #2"
```

---

## Task 10: Transfers — batch endpoint

**Files:**
- Modify: `src/services/transfers.service.ts` (add `createBatch`), `src/routes/transfers.ts` (add `POST /transfers/batch`)

- [ ] **Step 1: Add `createBatch` to `src/services/transfers.service.ts`** (appended near bottom)

```ts
import { randomUUID } from 'node:crypto';

const batchItemSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  metadata: z.object({
    memo: z.string().max(500).optional(),
    tags: z.array(z.string().max(50)).optional(),
  }).optional(),
});
const batchSchema = z.object({
  transfers: z.array(batchItemSchema).min(1),
  atomicity: z.enum(['all-or-nothing', 'best-effort']),
});

type BatchResult = {
  transferId: string | null;
  status: 'posted' | 'rejected';
  error: { code: string; message: string } | null;
};

export async function createBatch(userId: string, body: unknown) {
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid batch body');
  if (parsed.data.transfers.length > 50) {
    throw new AppError(413, 'BATCH_TOO_LARGE', 'Maximum 50 transfers per batch');
  }
  const items = parsed.data.transfers;
  const atomicity = parsed.data.atomicity;
  const batchId = randomUUID();

  // Pre-parse amounts so we can reject the whole call on malformed input.
  const plans: SinglePlan[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    let amount: Prisma.Decimal;
    try { amount = _internals.parsePositive(it.amount); } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(400, 'INVALID_AMOUNT', 'Invalid amount in batch');
    }
    const memo = it.metadata?.memo;
    plans.push({
      fromAccountId: it.fromAccountId,
      toAccountId: it.toAccountId,
      amount,
      description: memo ?? null,
    });
  }

  if (atomicity === 'all-or-nothing') {
    return prisma.$transaction(async (tx) => {
      let consumed = await _internals.sumTodaysTransfers(tx, userId);
      const validations: PlanResult[] = [];
      for (const plan of plans) {
        const v = await _internals.validateSingle(tx, userId, plan, consumed);
        validations.push(v);
        if (v.ok) consumed = consumed.plus(plan.amount);
      }
      const anyFail = validations.some((v) => !v.ok);
      const results: BatchResult[] = [];
      if (anyFail) {
        for (const v of validations) {
          if (v.ok) {
            results.push({ transferId: null, status: 'rejected', error: { code: 'BATCH_ROLLED_BACK', message: 'Another transfer in this all-or-nothing batch failed; nothing applied' } });
          } else {
            results.push({ transferId: null, status: 'rejected', error: { code: v.rejection.code, message: v.rejection.message } });
          }
        }
        // No mutations applied (we never called applySingle).
        return {
          batchId,
          summary: { succeeded: 0, failed: results.length, total: results.length },
          results,
        };
      }
      // All valid — apply.
      for (const plan of plans) {
        const t = await _internals.applySingle(tx, plan, { batchId });
        results.push({ transferId: t.id, status: 'posted', error: null });
      }
      return {
        batchId,
        summary: { succeeded: results.length, failed: 0, total: results.length },
        results,
      };
    });
  }

  // best-effort: each transfer attempted in its own transaction.
  const results: BatchResult[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const plan of plans) {
    try {
      const t = await prisma.$transaction(async (tx) => {
        const consumed = await _internals.sumTodaysTransfers(tx, userId);
        const v = await _internals.validateSingle(tx, userId, plan, consumed);
        if (!v.ok) throw new AppError(v.rejection.status, v.rejection.code, v.rejection.message);
        return _internals.applySingle(tx, plan, { batchId });
      });
      results.push({ transferId: t.id, status: 'posted', error: null });
      succeeded++;
    } catch (e) {
      if (e instanceof AppError) {
        results.push({ transferId: null, status: 'rejected', error: { code: e.code, message: e.message } });
      } else {
        results.push({ transferId: null, status: 'rejected', error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
      }
      failed++;
    }
  }
  return { batchId, summary: { succeeded, failed, total: results.length }, results };
}
```

- [ ] **Step 2: Add `POST /transfers/batch` route in `src/routes/transfers.ts`**

```ts
import { createBatch, createTransfer, getTransfer, reverseTransfer } from '../services/transfers.service.js';
// ...
router.post('/transfers/batch', requireAuth, async (req, res, next) => {
  try { res.status(200).json(await createBatch(req.user!.id, req.body)); } catch (e) { next(e); }
});
```

- [ ] **Step 3: Commit**

```bash
git add src/services/transfers.service.ts src/routes/transfers.ts
git commit -m "feat: batch transfers (all-or-nothing + best-effort)"
```

---

## Task 11: Statements

**Files:**
- Create: `src/services/statements.service.ts`, `src/routes/statements.ts`

- [ ] **Step 1: Create `src/services/statements.service.ts`**

```ts
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  from: z.string().regex(dateRe, 'must be YYYY-MM-DD'),
  to: z.string().regex(dateRe, 'must be YYYY-MM-DD'),
});

function parseUtcDay(yyyymmdd: string): Date {
  const [y, m, d] = yyyymmdd.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  if (isNaN(dt.getTime())) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid date');
  return dt;
}

export async function getStatement(userId: string, accountId: string, query: unknown) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join('.')] = issue.message;
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid query', fields);
  }
  const fromDate = parseUtcDay(parsed.data.from);
  const toDate = new Date(parseUtcDay(parsed.data.to).getTime() + 24 * 60 * 60 * 1000 - 1);
  if (toDate.getTime() < fromDate.getTime()) {
    throw new AppError(400, 'VALIDATION_FAILED', 'to must be >= from');
  }
  if (toDate.getTime() - fromDate.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Range cannot exceed 1 year');
  }

  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acc.userId !== userId) throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');

  // Sum all transactions strictly before `fromDate` to get openingBalance.
  const priorPostedDeposits = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      accountId,
      createdAt: { lt: fromDate },
      type: { in: ['deposit', 'transfer_in'] },
      status: 'posted',
    },
  });
  const priorPostedDebits = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      accountId,
      createdAt: { lt: fromDate },
      type: { in: ['withdrawal', 'transfer_out'] },
      status: 'posted',
    },
  });
  const openingBalance = (priorPostedDeposits._sum.amount ?? new Prisma.Decimal(0))
    .minus(priorPostedDebits._sum.amount ?? new Prisma.Decimal(0));

  const items = await prisma.transaction.findMany({
    where: { accountId, createdAt: { gte: fromDate, lte: toDate } },
    orderBy: { createdAt: 'asc' },
  });

  // Resolve counterparty owner names.
  const cpIds = Array.from(new Set(items.map((i) => i.counterpartyAccountId).filter((x): x is string => !!x)));
  const cpAccounts = cpIds.length
    ? await prisma.account.findMany({ where: { id: { in: cpIds } }, include: { user: true } })
    : [];
  const cpMap = new Map(cpAccounts.map((a) => [a.id, { accountId: a.id, ownerName: a.user.name }]));

  let running = openingBalance;
  let totalDeposits = new Prisma.Decimal(0);
  let totalWithdrawals = new Prisma.Decimal(0);

  const lines = items.map((t) => {
    const isCredit = t.type === 'deposit' || t.type === 'transfer_in';
    if (t.status === 'posted') {
      if (isCredit) running = running.plus(t.amount);
      else running = running.minus(t.amount);
    }
    if (t.status === 'posted') {
      if (isCredit) totalDeposits = totalDeposits.plus(t.amount);
      else totalWithdrawals = totalWithdrawals.plus(t.amount);
    }
    return {
      id: t.id,
      date: t.createdAt.toISOString(),
      type: t.type,
      amount: t.amount.toFixed(2),
      balanceAfter: running.toFixed(2),
      counterparty: t.counterpartyAccountId ? cpMap.get(t.counterpartyAccountId) ?? null : undefined,
    };
  });

  return {
    accountId,
    period: { from: parsed.data.from, to: parsed.data.to },
    openingBalance: openingBalance.toFixed(2),
    closingBalance: running.toFixed(2),
    transactions: lines,
    summary: {
      totalDeposits: totalDeposits.toFixed(2),
      totalWithdrawals: totalWithdrawals.toFixed(2),
      transactionsByCategory: {},
    },
  };
}
```

- [ ] **Step 2: Create `src/routes/statements.ts`**

```ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getStatement } from '../services/statements.service.js';

const router = Router();

router.get('/accounts/:id/statement', requireAuth, async (req, res, next) => {
  try { res.json(await getStatement(req.user!.id, req.params.id!, req.query)); } catch (e) { next(e); }
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add src/services/statements.service.ts src/routes/statements.ts
git commit -m "feat: account statements with opening/closing balances"
```

---

## Task 12: Smoke verification

**Files:**
- (No new code) — bring up `docker compose`, hit endpoints with `curl`, verify the two defects.

- [ ] **Step 1: Bring up stack**

```bash
docker compose build
docker compose up -d
docker compose logs -f api    # wait for "banking-api listening on :3000"
```

- [ ] **Step 2: Register two users, login, create accounts**

```bash
# user A
curl -s -X POST http://localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@a.io","name":"Alice","password":"pass1234"}'
TOKEN_A=$(curl -s -X POST http://localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"a@a.io","password":"pass1234"}' | jq -r .token)

# user B
curl -s -X POST http://localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"b@b.io","name":"Bob","password":"pass1234"}'
TOKEN_B=$(curl -s -X POST http://localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"b@b.io","password":"pass1234"}' | jq -r .token)

# accounts
A1=$(curl -s -X POST http://localhost:3000/accounts -H "authorization: Bearer $TOKEN_A" \
  -H 'content-type: application/json' -d '{"type":"checking"}' | jq -r .id)
B1=$(curl -s -X POST http://localhost:3000/accounts -H "authorization: Bearer $TOKEN_B" \
  -H 'content-type: application/json' -d '{"type":"savings"}' | jq -r .id)

# deposit funds to A1
curl -s -X POST http://localhost:3000/accounts/$A1/deposit \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"amount":"50000.00"}'
```

- [ ] **Step 3: Verify Defect #1 (frozen destination accepts incoming)**

```bash
# Freeze B1 (Bob freezes his own account)
curl -s -X PATCH http://localhost:3000/accounts/$B1 -H "authorization: Bearer $TOKEN_B" \
  -H 'content-type: application/json' -d '{"status":"frozen"}'

# Alice transfers to frozen Bob — should be REJECTED per spec, but will SUCCEED.
curl -s -X POST http://localhost:3000/transfers -H "authorization: Bearer $TOKEN_A" \
  -H 'content-type: application/json' \
  -d "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"$B1\",\"amount\":\"10.00\"}"
# Expected (per spec): 409 DESTINATION_ACCOUNT_NOT_ACTIVE
# Actual (defect): 201 with status "posted"
```

- [ ] **Step 4: Verify Defect #2 (reversed transfer still counts against daily limit)**

```bash
# Unfreeze B1
curl -s -X PATCH http://localhost:3000/accounts/$B1 -H "authorization: Bearer $TOKEN_B" \
  -H 'content-type: application/json' -d '{"status":"active"}'

# Transfer $10K, then reverse, then try $1 — should succeed per spec, will be blocked.
T1=$(curl -s -X POST http://localhost:3000/transfers -H "authorization: Bearer $TOKEN_A" \
  -H 'content-type: application/json' \
  -d "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"$B1\",\"amount\":\"10000.00\"}" | jq -r .id)
curl -s -X POST http://localhost:3000/transfers/$T1/reverse -H "authorization: Bearer $TOKEN_A"

# Now another $1 — per spec, daily counter is back to $0; per defect, it stays at $10K and blocks.
curl -s -X POST http://localhost:3000/transfers -H "authorization: Bearer $TOKEN_A" \
  -H 'content-type: application/json' \
  -d "{\"fromAccountId\":\"$A1\",\"toAccountId\":\"$B1\",\"amount\":\"1.00\"}"
# Expected (per spec): 201
# Actual (defect): 409 DAILY_LIMIT_EXCEEDED
```

- [ ] **Step 5: Spot-check happy paths** (statement, get-transfer, withdraw, list).

- [ ] **Step 6: Commit (if anything changed during smoke)**

```bash
git add -A
git commit -m "chore: smoke verification confirmed defects #1 and #2 reproduce" || echo "nothing to commit"
```

---

## Task 13: Push to GitHub

- [ ] **Step 1: Push**

```bash
git push -u origin main
```

- [ ] **Step 2: Confirm contents are visible at https://github.com/Agentbars/banking-api-lab.**

---

## Self-Review notes

- **Spec coverage**:
  - §2 auth tokens (TOKEN_MISSING / EXPIRED / INVALID) → Task 5 middleware ✓
  - §3 error envelope incl. `fields` → `AppError.toBody()` Task 4 ✓
  - §4.1–4.5 all endpoints → Tasks 6/7/8/9/10/11 ✓
  - §5 daily limit + reverse window → Task 9 ✓
  - §6 state machines → enforced by status checks in services ✓
  - §6 (design doc) intentional defects → labelled comments in Task 9 ✓
  - §8 atomicity within single + batch all-or-nothing → `prisma.$transaction` ✓
- **Placeholders**: none.
- **Type consistency**: `SinglePlan`, `BatchResult`, internals reused between single + batch endpoints.

---
