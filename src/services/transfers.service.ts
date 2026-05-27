import { randomUUID } from 'node:crypto';
import { Prisma, type Transfer } from '@prisma/client';
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

const batchItemSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  metadata: z
    .object({
      memo: z.string().max(500).optional(),
      tags: z.array(z.string().max(50)).optional(),
    })
    .optional(),
});

const batchSchema = z.object({
  transfers: z.array(batchItemSchema).min(1),
  atomicity: z.enum(['all-or-nothing', 'best-effort']),
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
  try {
    d = toDecimal(input);
  } catch {
    throw new AppError(400, 'INVALID_AMOUNT', 'Amount is not a valid decimal');
  }
  if (d.lessThanOrEqualTo(0)) {
    throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be > 0');
  }
  if (d.decimalPlaces() > 2) {
    throw new AppError(400, 'INVALID_AMOUNT', 'Amount must have at most 2 decimal places');
  }
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
 * INTENTIONAL DEFECT #2: per the customer-facing spec, only `pending` and
 * `posted` count toward the daily limit; `reversed` transfers should NOT count
 * (the money came back). This implementation deliberately includes `reversed`,
 * which surfaces with the pairwise pattern (transfer 10K -> reverse -> try more).
 */
async function sumTodaysTransfers(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<Prisma.Decimal> {
  const accounts = await tx.account.findMany({
    where: { userId },
    select: { id: true },
  });
  if (accounts.length === 0) return new Prisma.Decimal(0);
  const accountIds = accounts.map((a) => a.id);

  const since = startOfUtcDay(new Date());
  const rows = await tx.transfer.findMany({
    where: {
      fromAccountId: { in: accountIds },
      createdAt: { gte: since },
      // Intentional defect #2: includes 'reversed'.
      status: { in: ['pending', 'posted', 'reversed'] },
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
 * INTENTIONAL DEFECT #1: the spec requires us to reject when the
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
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'SAME_ACCOUNT',
        message: 'Source and destination accounts must differ',
      },
    };
  }
  const from = await tx.account.findUnique({ where: { id: plan.fromAccountId } });
  if (!from) {
    return {
      ok: false,
      rejection: {
        status: 404,
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Source account not found',
      },
    };
  }
  if (from.userId !== userId) {
    return {
      ok: false,
      rejection: {
        status: 403,
        code: 'FORBIDDEN',
        message: 'Source account does not belong to you',
      },
    };
  }
  if (from.status !== 'active') {
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'SOURCE_ACCOUNT_NOT_ACTIVE',
        message: 'Source account is not active',
      },
    };
  }

  const to = await tx.account.findUnique({ where: { id: plan.toAccountId } });
  if (!to) {
    return {
      ok: false,
      rejection: {
        status: 404,
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Destination account not found',
      },
    };
  }
  // Intentional defect #1: destination-status check intentionally omitted.

  if (from.balance.lessThan(plan.amount)) {
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'INSUFFICIENT_FUNDS',
        message: 'Insufficient funds',
      },
    };
  }

  if (alreadyConsumed.plus(plan.amount).greaterThan(DAILY_LIMIT)) {
    return {
      ok: false,
      rejection: {
        status: 409,
        code: 'DAILY_LIMIT_EXCEEDED',
        message: 'Daily transfer limit of $10,000 reached',
      },
    };
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
  await tx.account.update({
    where: { id: plan.fromAccountId },
    data: { balance: { decrement: plan.amount } },
  });
  await tx.account.update({
    where: { id: plan.toAccountId },
    data: { balance: { increment: plan.amount } },
  });
  return transfer;
}

export async function createTransfer(userId: string, body: unknown) {
  const parsed = singleSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid transfer body');
  }
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
    if (!from) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Source account not found');
    }
    if (from.userId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the from-owner can reverse a transfer');
    }
    if (t.status !== 'posted') {
      throw new AppError(409, 'NOT_REVERSIBLE', 'Transfer is not in posted status');
    }
    if (!t.postedAt) {
      throw new AppError(409, 'NOT_REVERSIBLE', 'Transfer has no postedAt');
    }
    if (Date.now() - t.postedAt.getTime() > REVERSE_WINDOW_MS) {
      throw new AppError(410, 'REVERSE_WINDOW_EXPIRED', 'Reverse window of 24 hours has expired');
    }

    const updated = await tx.transfer.update({
      where: { id: t.id },
      data: { status: 'reversed' },
    });

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
    await tx.account.update({
      where: { id: t.toAccountId },
      data: { balance: { decrement: t.amount } },
    });
    await tx.account.update({
      where: { id: t.fromAccountId },
      data: { balance: { increment: t.amount } },
    });

    return serializeTransfer(updated);
  });
}

type BatchResult = {
  transferId: string | null;
  status: 'posted' | 'rejected';
  error: { code: string; message: string } | null;
};

export async function createBatch(userId: string, body: unknown) {
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid batch body');
  }
  if (parsed.data.transfers.length > 50) {
    throw new AppError(413, 'BATCH_TOO_LARGE', 'Maximum 50 transfers per batch');
  }
  const items = parsed.data.transfers;
  const atomicity = parsed.data.atomicity;
  const batchId = randomUUID();

  const plans: SinglePlan[] = [];
  for (const it of items) {
    const amount = parsePositive(it.amount);
    plans.push({
      fromAccountId: it.fromAccountId,
      toAccountId: it.toAccountId,
      amount,
      description: it.metadata?.memo ?? null,
    });
  }

  if (atomicity === 'all-or-nothing') {
    return prisma.$transaction(async (tx) => {
      let consumed = await sumTodaysTransfers(tx, userId);
      const validations: PlanResult[] = [];
      for (const plan of plans) {
        const v = await validateSingle(tx, userId, plan, consumed);
        validations.push(v);
        if (v.ok) consumed = consumed.plus(plan.amount);
      }
      const anyFail = validations.some((v) => !v.ok);
      const results: BatchResult[] = [];
      if (anyFail) {
        for (const v of validations) {
          if (v.ok) {
            results.push({
              transferId: null,
              status: 'rejected',
              error: {
                code: 'BATCH_ROLLED_BACK',
                message:
                  'Another transfer in this all-or-nothing batch failed; nothing applied',
              },
            });
          } else {
            results.push({
              transferId: null,
              status: 'rejected',
              error: { code: v.rejection.code, message: v.rejection.message },
            });
          }
        }
        return {
          batchId,
          summary: { succeeded: 0, failed: results.length, total: results.length },
          results,
        };
      }
      for (const plan of plans) {
        const t = await applySingle(tx, plan, { batchId });
        results.push({ transferId: t.id, status: 'posted', error: null });
      }
      return {
        batchId,
        summary: { succeeded: results.length, failed: 0, total: results.length },
        results,
      };
    });
  }

  const results: BatchResult[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const plan of plans) {
    try {
      const t = await prisma.$transaction(async (tx) => {
        const consumed = await sumTodaysTransfers(tx, userId);
        const v = await validateSingle(tx, userId, plan, consumed);
        if (!v.ok) {
          throw new AppError(v.rejection.status, v.rejection.code, v.rejection.message);
        }
        return applySingle(tx, plan, { batchId });
      });
      results.push({ transferId: t.id, status: 'posted', error: null });
      succeeded++;
    } catch (e) {
      if (e instanceof AppError) {
        results.push({
          transferId: null,
          status: 'rejected',
          error: { code: e.code, message: e.message },
        });
      } else {
        results.push({
          transferId: null,
          status: 'rejected',
          error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' },
        });
      }
      failed++;
    }
  }
  return {
    batchId,
    summary: { succeeded, failed, total: results.length },
    results,
  };
}
