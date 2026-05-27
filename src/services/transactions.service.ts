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

async function loadOwnedAccountForMutation(
  tx: Prisma.TransactionClient,
  userId: string,
  accountId: string,
): Promise<Account> {
  const acc = await tx.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acc.userId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');
  }
  return acc;
}

function parseAmountBody(body: unknown): { amount: Prisma.Decimal; description: string | null } {
  const parsed = amountSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid amount body');
  }
  let d: Prisma.Decimal;
  try {
    d = toDecimal(parsed.data.amount);
  } catch {
    throw new AppError(400, 'INVALID_AMOUNT', 'Amount is not a valid decimal');
  }
  if (d.lessThanOrEqualTo(0)) {
    throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be > 0');
  }
  if (d.decimalPlaces() > 2) {
    throw new AppError(400, 'INVALID_AMOUNT', 'Amount must have at most 2 decimal places');
  }
  return { amount: d, description: parsed.data.description ?? null };
}

export async function listTransactions(userId: string, accountId: string, query: unknown) {
  const parsed = listSchema.safeParse(query);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid query');
  }
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acc.userId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');
  }

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
  const { amount, description } = parseAmountBody(body);
  return prisma.$transaction(async (tx) => {
    const acc = await loadOwnedAccountForMutation(tx, userId, accountId);
    if (acc.status !== 'active') {
      throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
    }
    const created = await tx.transaction.create({
      data: {
        accountId: acc.id,
        type: 'deposit',
        amount,
        status: 'posted',
        description,
      },
    });
    await tx.account.update({
      where: { id: acc.id },
      data: { balance: { increment: amount } },
    });
    return serializeTx(created);
  });
}

export async function withdraw(userId: string, accountId: string, body: unknown) {
  const { amount, description } = parseAmountBody(body);
  return prisma.$transaction(async (tx) => {
    const acc = await loadOwnedAccountForMutation(tx, userId, accountId);
    if (acc.status !== 'active') {
      throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
    }
    if (acc.balance.lessThan(amount)) {
      throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
    }
    const created = await tx.transaction.create({
      data: {
        accountId: acc.id,
        type: 'withdrawal',
        amount,
        status: 'posted',
        description,
      },
    });
    await tx.account.update({
      where: { id: acc.id },
      data: { balance: { decrement: amount } },
    });
    return serializeTx(created);
  });
}
