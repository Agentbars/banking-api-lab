# Banking API — Implementation Spec

**Date:** 2026-05-27
**Status:** Design approved, ready for implementation
**Audience:** Banking API developer(s) (Pavel and whoever he hands this to)
**Purpose:** Build a small personal-banking REST API as the substrate for the AQA Course "API Testing with Playwright" task. Two real-feeling defects are intentionally included as teaching artifacts; they require pairwise / combinatorial coverage to surface.

> ⚠️ **This document contains the intentional defects.** A sibling document, [`2026-05-27-banking-api-customer-requirements.md`](./2026-05-27-banking-api-customer-requirements.md), describes the *expected* behavior with no mention of defects. That sibling is the student-facing source of truth and gets attached to the course task. Do not leak this document to students.

---

## 1. Feature overview

A REST API for personal banking. One user owns multiple accounts (checking, savings). They can deposit, withdraw, transfer between their own and other users' accounts, and reverse recent transfers. Statements summarise an account's activity over a period.

Single currency (`USD`). No multi-currency, no FX, no investment / lending products — the scope is intentionally small.

This is a teaching artifact, not a real banking system. It does not need real fraud detection, KYC, sanctions screening, or actual money movement.

## 2. Tech stack

- **Runtime:** Node.js 20 LTS
- **Language:** TypeScript (`strict` on)
- **HTTP:** Express (or Fastify — pick one and stick with it)
- **ORM:** Prisma
- **DB:** PostgreSQL 15
- **Deployment:** Docker Compose, alongside the existing MailLab stack on the same VPS
- **Auth:** simple opaque Bearer tokens stored in DB (no JWT — easier to debug, sufficient for the course)

## 3. Resources / data model

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String
  password  String   // bcrypt
  createdAt DateTime @default(now())

  accounts  Account[]
  tokens    AuthToken[]
}

model AuthToken {
  id        String   @id @default(cuid())
  userId    String
  token     String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())

  user      User @relation(fields: [userId], references: [id])
}

model Account {
  id        String        @id @default(cuid())
  userId    String
  type      AccountType   // checking | savings
  number    String        @unique
  currency  String        @default("USD")
  balance   Decimal       @db.Decimal(14, 2) @default(0)
  status    AccountStatus @default(active)
  createdAt DateTime      @default(now())

  user          User           @relation(fields: [userId], references: [id])
  transactions  Transaction[]
}

enum AccountType   { checking, savings }
enum AccountStatus { active, frozen, closed }

model Transaction {
  id                   String              @id @default(cuid())
  accountId            String
  type                 TransactionType
  amount               Decimal             @db.Decimal(14, 2)
  status               TransactionStatus
  counterpartyAccountId String?
  transferId           String?
  description          String?
  createdAt            DateTime            @default(now())

  account  Account @relation(fields: [accountId], references: [id])
  transfer Transfer? @relation(fields: [transferId], references: [id])
}

enum TransactionType   { deposit, withdrawal, transfer_in, transfer_out }
enum TransactionStatus { pending, posted, rejected, reversed }

model Transfer {
  id              String         @id @default(cuid())
  fromAccountId   String
  toAccountId     String
  amount          Decimal        @db.Decimal(14, 2)
  status          TransferStatus
  batchId         String?
  createdAt       DateTime       @default(now())
  postedAt        DateTime?

  transactions    Transaction[]
}

enum TransferStatus { pending, posted, failed, reversed }
```

Use `Decimal(14, 2)` for all money — never `Float`. (This single choice prevents an entire class of off-by-cents bugs.)

## 4. Endpoints (~16)

### Auth

#### `POST /auth/register`
- Body: `{ email, name, password }`
- Validation: email unique, password min 8 chars
- Response 201: `{ id, email, name, createdAt }`
- Response 400: `{ error: { code, message } }`

#### `POST /auth/login`
- Body: `{ email, password }`
- Response 200: `{ token, expiresAt }` — token TTL 1 hour
- Response 401: `{ error: { code: "INVALID_CREDENTIALS", message } }`

#### `GET /me`
- Auth required
- Response 200: `{ id, email, name, createdAt }`

### Accounts

#### `GET /accounts`
- Auth required. Returns accounts of the current user only.
- Response 200: `[{ id, type, number, currency, balance, status, createdAt }, ...]`

#### `POST /accounts`
- Auth required. Creates an account for the current user.
- Body: `{ type: "checking" | "savings" }`. Server generates `number`. Initial balance `0`.
- Response 201: full account object.

#### `GET /accounts/:id`
- Auth required. Owner-only — returns 403 (not 404) if account belongs to another user.
- Response 200: full account object.
- Response 403: `{ error: { code: "FORBIDDEN", message: "Account does not belong to you" } }`

#### `PATCH /accounts/:id`
- Auth required. Owner-only.
- Body: `{ status?: "active" | "frozen" }` — only the owner can freeze/unfreeze.
- Cannot move to or from `closed` via PATCH (use DELETE for closure).
- Response 200: updated account.

#### `DELETE /accounts/:id`
- Auth required. Owner-only.
- Effect: sets `status: closed`. Hard requirement: balance MUST be exactly `0.00`.
- Response 204 on success.
- Response 409: `{ error: { code: "ACCOUNT_HAS_BALANCE", message: "Close requires zero balance" } }` if balance ≠ 0.

### Transactions

#### `GET /accounts/:id/transactions?limit=&offset=`
- Auth required. Owner-only.
- Default `limit: 50`, max `100`.
- Response 200: `{ items: [...], total: <int>, limit, offset }`. Order: `createdAt DESC`.

#### `POST /accounts/:id/deposit`
- Auth required. Owner-only.
- Body: `{ amount: <positive Decimal>, description?: string }`.
- Side effect: balance += amount. Creates a `Transaction(type=deposit, status=posted)`.
- Rejects: account `frozen` or `closed`; amount ≤ 0.
- Response 201: created transaction object.

#### `POST /accounts/:id/withdraw`
- Auth required. Owner-only.
- Body: `{ amount, description? }`.
- Side effect: balance -= amount. Creates a `Transaction(type=withdrawal, status=posted)`.
- Rejects: insufficient funds; account `frozen`/`closed`; amount ≤ 0.
- Response 201: created transaction object.

### Transfers

#### `POST /transfers`
- Auth required.
- Body: `{ fromAccountId, toAccountId, amount, description? }`.
- `fromAccountId` MUST belong to the current user (otherwise 403).
- `toAccountId` may belong to another user; only its existence is checked (otherwise 404).
- Effect: synchronously moves funds, creating two `Transaction`s (`transfer_out` on `from`, `transfer_in` on `to`) and one `Transfer` linking them. Final status `posted` on success.
- Rejects: insufficient funds; same `from` and `to`; amount ≤ 0; **source account `frozen`/`closed`**; daily limit exceeded (see §5).
- **Acceptance note:** see Bug #1 in §6 — the spec says destination status must also be checked (frozen/closed destination → 409), but the implementation deliberately omits the destination-status check.
- Response 201: full transfer object including `status: "posted"`.

#### `GET /transfers/:id`
- Auth required. Visible to either party (from-owner or to-owner). Otherwise 403.
- Response 200: full transfer object.

#### `POST /transfers/:id/reverse`
- Auth required. Only the **from-owner** can reverse.
- Constraints: transfer must be `posted`; the reverse window is **24 hours from `postedAt`**.
- Effect: reverses both legs — debits the `to` account, credits the `from` account, sets the original transfer to `reversed` and creates two new `Transaction`s of type `transfer_in` (back to from) and `transfer_out` (off of to) tagged with the reversal.
- Rejects: transfer not posted; window expired; not from-owner.
- Response 200: updated transfer.

#### `POST /transfers/batch`
- Auth required.
- Body:
  ```json
  {
    "transfers": [ { "fromAccountId", "toAccountId", "amount", "metadata"?: { "memo"?, "tags"?: [] } }, ... ],
    "atomicity": "all-or-nothing" | "best-effort"
  }
  ```
- `atomicity: "all-or-nothing"` — if any single transfer would fail, **none** are applied. Response carries the rejections in `results`, but the DB sees no changes.
- `atomicity: "best-effort"` — each transfer succeeds or fails independently. Response carries per-transfer results.
- Maximum 50 transfers per batch.
- Response 200:
  ```json
  {
    "batchId": "...",
    "summary": { "succeeded": <int>, "failed": <int>, "total": <int> },
    "results": [
      { "transferId": "..." | null, "status": "posted" | "rejected", "error": null | { "code", "message" } },
      ...
    ]
  }
  ```
- Response 400 on malformed body. Response 413 if `transfers.length > 50`.

### Statements

#### `GET /accounts/:id/statement?from=YYYY-MM-DD&to=YYYY-MM-DD`
- Auth required. Owner-only.
- `from` and `to` required. `to >= from`. Max range 1 year.
- Response 200:
  ```json
  {
    "accountId": "...",
    "period": { "from": "2026-05-01", "to": "2026-05-31" },
    "openingBalance": <Decimal>,
    "closingBalance": <Decimal>,
    "transactions": [ { "id", "date", "type", "amount", "balanceAfter", "counterparty"?: { "accountId", "ownerName" }, "metadata"?: { "memo", "category", "tags": [] } }, ... ],
    "summary": {
      "totalDeposits": <Decimal>,
      "totalWithdrawals": <Decimal>,
      "transactionsByCategory": { "<category>": <Decimal>, ... }
    }
  }
  ```
- Reversed transactions appear in `transactions` with `status: reversed` (not filtered out — they're history).

## 5. Business rules

### Daily transfer limit

- `$10,000.00` per **calendar day** (server time, UTC), per **user** (across all accounts they own).
- Calculation: `sum(amount) over Transfers where fromAccountId IN user.accounts AND createdAt >= start_of_day(UTC) AND status IN ('pending', 'posted')`.
- **Acceptance note:** see Bug #2 in §6 — the spec says reversed transfers must NOT count against the limit, but the implementation deliberately includes them in the sum.
- On exceed: `409 { error: { code: "DAILY_LIMIT_EXCEEDED", message: "Daily transfer limit of $10,000 reached" } }`.

### Reverse window

- 24 hours from `Transfer.postedAt`. After that: `410 { error: { code: "REVERSE_WINDOW_EXPIRED", message: "..." } }`.

### Token expiry

- 1 hour from issuance. Expired tokens: `401 { error: { code: "TOKEN_EXPIRED", message: "..." } }`.

## 6. Intentional defects

### 🐞 Defect #1 — Frozen destination accepts incoming transfers

**Spec says:** `POST /transfers` should reject when either the source OR the destination account is in status `frozen` or `closed`. Frozen-destination → `409 { error: { code: "DESTINATION_ACCOUNT_NOT_ACTIVE", message: "Destination account is not active" } }`.

**Implementation deliberately omits the destination-status check.** Only the source is validated.

**How it surfaces:**
- Single tests against frozen source: rejected ✅ — the test passes against the buggy code.
- Single tests against active destination: succeed ✅ — passes.
- Combination `(source: active, destination: frozen)`: should reject per spec, but the API returns `201` and money lands in the frozen account.

**Implementation location:** in the `POST /transfers` handler, the validation that checks `fromAccount.status === 'active'` exists; the analogous check on `toAccount.status` is missing. Leave a comment in the code explaining the intent.

**Pairwise discovery path:** a `from_status × to_status` matrix (3 × 3) of accounts. The cell `(active, frozen)` exposes the bug.

### 🐞 Defect #2 — Daily transfer limit double-counts reversed transfers

**Spec says:** the daily limit calculation sums transfers with status `pending` or `posted` only. Reversed transfers should NOT count against the limit (because the money came back).

**Implementation deliberately includes `reversed` in the sum.**

**How it surfaces:**
- Single test "transfer $5K": succeeds ✅.
- Single test "transfer $10K then $1": second blocked ✅.
- Single test "transfer $10K then reverse it": both succeed ✅.
- Combination "transfer $10K, reverse it, attempt another transfer": should succeed per spec (limit is back to $0 used), but the API returns `409 DAILY_LIMIT_EXCEEDED` because the reversed $10K still counts.

**Implementation location:** in the limit calculation query, the `status IN (...)` filter deliberately includes `'reversed'`. Leave a comment.

**Pairwise discovery path:** `(transfers_made_today_amount × has_been_reversed × attempts_more)` — three-way, but a pairwise approach with the right factors reaches it.

## 7. Hosting

- Container next to MailLab on the existing VPS.
- Public hostname: `banking.srv1505121.hstgr.cloud` (or whatever Pavel picks).
- TLS via the existing reverse proxy / certbot setup.
- Database: a separate PG instance or a separate database in the existing PG — does not matter as long as data is isolated from MailLab's.

## 8. Out of scope

- Multi-currency / FX.
- Investment, lending, cards, payments to external systems.
- Real KYC, AML, sanctions screening, fraud detection.
- Notifications (email / SMS) on activity.
- Two-factor authentication, password reset flows.
- Concurrent-transfer race conditions (could be a future bug, intentionally not in v1).
- Webhooks / subscriptions.
- Admin endpoints (no admin role in v1).

## 9. Test acceptance for the API dev

Before considering the API "done":

1. **All endpoints in §4 return the documented shape on happy path** — including the nested batch results and the statement aggregations.
2. **The intentional defects are present and reproducible** via the matrices described in §6.
3. The clean rules (auth required where stated, owner-only where stated, daily limit at $10K, reverse window at 24h, decimals as `Decimal(14,2)`) hold.
4. A naive smoke run of CRUD against every endpoint succeeds and does not surface the two defects — the defects are pairwise-only by construction.

## 10. Related course artifacts

- **Student-facing API contract:** [`2026-05-27-banking-api-customer-requirements.md`](./2026-05-27-banking-api-customer-requirements.md). Attached to the AQA Course "API Testing with Playwright" task. Describes the same API as this doc, without any mention of the defects.
- **AQA Course task:** "API Testing with Playwright" (template id `cmos7t3te001f5zhngl4ceric`). Updated to point at this Banking API and include a bonus that hints at the two pairwise defects without revealing them.
