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
  if (isNaN(dt.getTime())) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid date');
  }
  return dt;
}

export async function getStatement(userId: string, accountId: string, query: unknown) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.join('.') || '_'] = issue.message;
    }
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
  if (acc.userId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Account does not belong to you');
  }

  const priorCredits = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      accountId,
      createdAt: { lt: fromDate },
      type: { in: ['deposit', 'transfer_in'] },
      status: 'posted',
    },
  });
  const priorDebits = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      accountId,
      createdAt: { lt: fromDate },
      type: { in: ['withdrawal', 'transfer_out'] },
      status: 'posted',
    },
  });
  const openingBalance = (priorCredits._sum.amount ?? new Prisma.Decimal(0)).minus(
    priorDebits._sum.amount ?? new Prisma.Decimal(0),
  );

  const items = await prisma.transaction.findMany({
    where: { accountId, createdAt: { gte: fromDate, lte: toDate } },
    orderBy: { createdAt: 'asc' },
  });

  const cpIds = Array.from(
    new Set(items.map((i) => i.counterpartyAccountId).filter((x): x is string => !!x)),
  );
  const cpAccounts = cpIds.length
    ? await prisma.account.findMany({
        where: { id: { in: cpIds } },
        include: { user: true },
      })
    : [];
  const cpMap = new Map(
    cpAccounts.map((a) => [a.id, { accountId: a.id, ownerName: a.user.name }]),
  );

  let running = openingBalance;
  let totalDeposits = new Prisma.Decimal(0);
  let totalWithdrawals = new Prisma.Decimal(0);

  const lines = items.map((t) => {
    const isCredit = t.type === 'deposit' || t.type === 'transfer_in';
    if (t.status === 'posted') {
      if (isCredit) {
        running = running.plus(t.amount);
        totalDeposits = totalDeposits.plus(t.amount);
      } else {
        running = running.minus(t.amount);
        totalWithdrawals = totalWithdrawals.plus(t.amount);
      }
    }
    return {
      id: t.id,
      date: t.createdAt.toISOString(),
      type: t.type,
      amount: t.amount.toFixed(2),
      balanceAfter: running.toFixed(2),
      counterparty: t.counterpartyAccountId
        ? cpMap.get(t.counterpartyAccountId) ?? null
        : undefined,
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
