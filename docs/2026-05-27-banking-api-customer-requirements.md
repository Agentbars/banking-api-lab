# Banking API — Customer Requirements

**For:** the team automating the Banking API
**Source of truth for:** endpoint contracts, validation rules, error codes, state machines, and persistence behavior

This document describes the expected behavior of the Banking API. It is the specification you test against. Anything the application does that contradicts what is written here is a defect — treat your tests and assertions as the proof of conformance.

---

## 1. Domain summary

A small personal-banking API. A user owns one or more accounts (checking and/or savings). They can deposit, withdraw, transfer between their own and other users' accounts, reverse recent transfers, batch many transfers in one call, and pull a statement for any period.

Single currency: **USD**. All money amounts are decimals with two fractional digits (`Decimal(14, 2)` representation; never floats).

## 2. Authentication

The API uses **opaque Bearer tokens**. To call any non-public endpoint, send `Authorization: Bearer <token>` on the request.

| Property | Value |
|---|---|
| Token lifetime | 1 hour from issuance |
| Expired token response | `401 { "error": { "code": "TOKEN_EXPIRED", "message": "..." } }` |
| Missing token response | `401 { "error": { "code": "TOKEN_MISSING", "message": "..." } }` |
| Invalid token response | `401 { "error": { "code": "TOKEN_INVALID", "message": "..." } }` |

## 3. Error envelope

All non-2xx responses use this shape:

```json
{ "error": { "code": "<UPPER_SNAKE_CASE>", "message": "<human-readable>" } }
```

Where multiple fields fail validation, the envelope becomes:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "fields": { "<fieldName>": "<reason>", ... } } }
```

## 4. Endpoints

### 4.1 Auth

#### `POST /auth/register`
- **Public.** Body: `{ "email", "name", "password" }`.
- Validation: email must be a valid format and unique; password ≥ 8 characters.
- 201 → `{ "id", "email", "name", "createdAt" }`.
- 400 on validation failure (see error envelope above).
- 409 → `{ "error": { "code": "EMAIL_ALREADY_REGISTERED", "message": "..." } }`.

#### `POST /auth/login`
- **Public.** Body: `{ "email", "password" }`.
- 200 → `{ "token", "expiresAt": "<ISO8601>" }`.
- 401 → `{ "error": { "code": "INVALID_CREDENTIALS", "message": "..." } }`.

#### `GET /me`
- **Auth.** 200 → `{ "id", "email", "name", "createdAt" }`.

### 4.2 Accounts

#### `GET /accounts`
- **Auth.** Lists the current user's accounts (and only theirs).
- 200 → `[ { "id", "type", "number", "currency", "balance", "status", "createdAt" }, ... ]`.

#### `POST /accounts`
- **Auth.** Body: `{ "type": "checking" | "savings" }`.
- Server generates `number`. Initial `balance: 0`. `status: "active"`. `currency: "USD"`.
- 201 → full account object.
- 400 on invalid `type`.

#### `GET /accounts/:id`
- **Auth + owner-only.** Returns 403 (not 404) if the account belongs to another user.
- 200 → full account object.
- 404 if the account does not exist at all.
- 403 → `{ "error": { "code": "FORBIDDEN", "message": "Account does not belong to you" } }`.

#### `PATCH /accounts/:id`
- **Auth + owner-only.** Body: `{ "status"?: "active" | "frozen" }`.
- Cannot transition to or from `closed` here (use DELETE for closure).
- 200 → updated account.
- 409 if trying to set `status` to `closed`.

#### `DELETE /accounts/:id`
- **Auth + owner-only.** Sets `status: closed`.
- **Hard requirement:** balance must be exactly `0.00`.
- 204 on success (no body).
- 409 → `{ "error": { "code": "ACCOUNT_HAS_BALANCE", "message": "Close requires zero balance" } }` if balance ≠ 0.
- 404 if account does not exist.
- 403 if account belongs to another user.

### 4.3 Transactions

#### `GET /accounts/:id/transactions?limit=&offset=`
- **Auth + owner-only.** Defaults: `limit: 50`, `offset: 0`. Max `limit: 100`.
- 200 →
  ```json
  { "items": [ { /* transaction */ }, ... ], "total": <int>, "limit": <int>, "offset": <int> }
  ```
- Order: `createdAt DESC`.

Transaction shape:
```json
{
  "id": "...",
  "accountId": "...",
  "type": "deposit" | "withdrawal" | "transfer_in" | "transfer_out",
  "amount": "<Decimal>",
  "status": "pending" | "posted" | "rejected" | "reversed",
  "counterpartyAccountId": "..." | null,
  "transferId": "..." | null,
  "description": "..." | null,
  "createdAt": "<ISO8601>"
}
```

#### `POST /accounts/:id/deposit`
- **Auth + owner-only.** Body: `{ "amount", "description"?: string }`.
- Effect: increases balance by `amount`; creates a `Transaction` with `type: "deposit"`, `status: "posted"`.
- Rejections:
  - `amount <= 0` → `400 INVALID_AMOUNT`.
  - Account `frozen` or `closed` → `409 ACCOUNT_NOT_ACTIVE`.
- 201 → created transaction object.

#### `POST /accounts/:id/withdraw`
- **Auth + owner-only.** Body: `{ "amount", "description"? }`.
- Effect: decreases balance; creates a `Transaction` with `type: "withdrawal"`, `status: "posted"`.
- Rejections:
  - `amount <= 0` → `400 INVALID_AMOUNT`.
  - Insufficient funds → `409 INSUFFICIENT_FUNDS`.
  - Account `frozen` or `closed` → `409 ACCOUNT_NOT_ACTIVE`.
- 201 → created transaction object.

### 4.4 Transfers

#### `POST /transfers`
- **Auth.** Body: `{ "fromAccountId", "toAccountId", "amount", "description"? }`.
- `fromAccountId` MUST belong to the current user (otherwise 403).
- `toAccountId` may belong to another user; existence is required (otherwise 404).
- Effect: atomically moves funds. Creates two `Transaction`s (`transfer_out` on `from`, `transfer_in` on `to`) and one `Transfer` linking them, both transactions and transfer ending at `status: "posted"`.
- Rejections:
  - `amount <= 0` → `400 INVALID_AMOUNT`.
  - `fromAccountId === toAccountId` → `409 SAME_ACCOUNT`.
  - Source account `frozen` or `closed` → `409 SOURCE_ACCOUNT_NOT_ACTIVE`.
  - **Destination account `frozen` or `closed`** → `409 DESTINATION_ACCOUNT_NOT_ACTIVE`.
  - Insufficient funds → `409 INSUFFICIENT_FUNDS`.
  - Daily transfer limit exceeded → `409 DAILY_LIMIT_EXCEEDED` (see §5).
- 201 → full transfer object.

Transfer shape:
```json
{
  "id": "...",
  "fromAccountId": "...",
  "toAccountId": "...",
  "amount": "<Decimal>",
  "status": "pending" | "posted" | "failed" | "reversed",
  "batchId": "..." | null,
  "createdAt": "<ISO8601>",
  "postedAt": "<ISO8601>" | null
}
```

#### `GET /transfers/:id`
- **Auth.** Visible to either party (the owner of `from` or the owner of `to`). Otherwise 403.
- 200 → full transfer object.

#### `POST /transfers/:id/reverse`
- **Auth.** Only the **from-owner** can reverse.
- Constraints: transfer must be `posted`; reverse window is **24 hours from `postedAt`**.
- Effect: debits `to`, credits `from`, sets the original transfer to `status: reversed`, and creates two new `Transaction`s tagged with the original `transferId`.
- Rejections:
  - Not from-owner → `403 FORBIDDEN`.
  - Transfer not in `posted` status → `409 NOT_REVERSIBLE`.
  - Window expired → `410 REVERSE_WINDOW_EXPIRED`.
- 200 → updated transfer.

#### `POST /transfers/batch`
- **Auth.** Body:
  ```json
  {
    "transfers": [
      {
        "fromAccountId": "...",
        "toAccountId": "...",
        "amount": "<Decimal>",
        "metadata"?: { "memo"?: string, "tags"?: string[] }
      },
      ...
    ],
    "atomicity": "all-or-nothing" | "best-effort"
  }
  ```
- Maximum 50 transfers per batch (otherwise `413 BATCH_TOO_LARGE`).
- `atomicity: "all-or-nothing"` — if any single transfer would fail any validation, **none** are applied. The response still describes the per-transfer rejection reasons, but the DB sees no changes.
- `atomicity: "best-effort"` — each transfer is attempted independently. Failures of one do not block others. **Daily limit** is consumed in order; transfers later in the array may be rejected for `DAILY_LIMIT_EXCEEDED` even if earlier ones in the same batch succeeded.
- 200 →
  ```json
  {
    "batchId": "...",
    "summary": { "succeeded": <int>, "failed": <int>, "total": <int> },
    "results": [
      {
        "transferId": "..." | null,
        "status": "posted" | "rejected",
        "error": null | { "code": "...", "message": "..." }
      },
      ...
    ]
  }
  ```
  `results.length === transfers.length`, in the same order as the request.
- 400 on malformed body.

### 4.5 Statements

#### `GET /accounts/:id/statement?from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Auth + owner-only.**
- Both `from` and `to` are required. `to >= from`. Maximum range: 1 year.
- 200 →
  ```json
  {
    "accountId": "...",
    "period": { "from": "2026-05-01", "to": "2026-05-31" },
    "openingBalance": "<Decimal>",
    "closingBalance": "<Decimal>",
    "transactions": [
      {
        "id": "...",
        "date": "<ISO8601>",
        "type": "deposit" | "withdrawal" | "transfer_in" | "transfer_out",
        "amount": "<Decimal>",
        "balanceAfter": "<Decimal>",
        "counterparty"?: { "accountId": "...", "ownerName": "..." },
        "metadata"?: { "memo"?: string, "category"?: string, "tags"?: string[] }
      },
      ...
    ],
    "summary": {
      "totalDeposits": "<Decimal>",
      "totalWithdrawals": "<Decimal>",
      "transactionsByCategory": { "<categoryName>": "<Decimal>", ... }
    }
  }
  ```
- `transactions` is ordered `date ASC`.
- Reversed transactions appear in `transactions` with the relevant entries — they are part of history, not filtered out.
- 400 on bad / missing date parameters.
- 403 if the account belongs to another user.

## 5. Business rules

### Daily transfer limit

- **$10,000.00 per user per calendar day (UTC).** Across all accounts the user owns.
- The limit is computed as the **sum of `amount` over transfers whose source account belongs to the user, were created today (UTC), and whose status is `pending` or `posted`**.
- **Reversed transfers do NOT count against the limit.** The money came back; the daily ceiling should reflect what is actually out.
- On exceed: `409 { "error": { "code": "DAILY_LIMIT_EXCEEDED", "message": "Daily transfer limit of $10,000 reached" } }`.

### Reverse window

- 24 hours from `Transfer.postedAt`. Past that → `410 REVERSE_WINDOW_EXPIRED`.

## 6. State machines

### Account status

```
active ↔ frozen
active → closed (terminal; requires balance == 0)
```

### Transaction status

```
pending → posted | rejected
posted  → reversed (only as part of a transfer reversal)
```

### Transfer status

```
pending → posted | failed
posted  → reversed (within 24h)
```

## 7. Out of scope

- Multi-currency / FX.
- Investment, lending, cards, payments to external systems.
- Real KYC / AML / fraud checks.
- Notifications.
- Two-factor authentication, password reset, account recovery.
- Admin endpoints.
- Webhooks / event streams.

## 8. Concurrency & consistency

- Each transfer (single or as part of a batch) is committed atomically — partial state on the affected accounts is never observable.
- Within a batch, transfers are applied in the order given.
- The API does not guarantee anything specific about concurrent requests from the same user across separate HTTP calls — your tests should not depend on a particular ordering when running in parallel.
