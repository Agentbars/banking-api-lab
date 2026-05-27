import { z } from 'zod';
import type { Account, AccountStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { generateAccountNumber } from '../lib/accountNumber.js';

const createSchema = z.object({ type: z.enum(['checking', 'savings']) });
const patchSchema = z.object({
  status: z.enum(['active', 'frozen', 'closed']).optional(),
});

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
  const accounts = await prisma.account.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return accounts.map(serialize);
}

export async function createAccount(userId: string, body: unknown) {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid account type', {
      type: 'must be "checking" or "savings"',
    });
  }
  for (let i = 0; i < 5; i++) {
    try {
      const created = await prisma.account.create({
        data: {
          userId,
          type: parsed.data.type,
          number: generateAccountNumber(),
        },
      });
      return serialize(created);
    } catch (e) {
      if (i === 4) throw e;
    }
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Failed to create account');
}

async function loadOwnedAccount(userId: string, accountId: string): Promise<Account> {
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (acc.userId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');
  }
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
    throw new AppError(
      409,
      'INVALID_STATUS_TRANSITION',
      'Use DELETE to close an account; cannot transition via PATCH',
    );
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
  if (acc.status === 'closed') return; // idempotent
  await prisma.account.update({
    where: { id: acc.id },
    data: { status: 'closed' },
  });
}
