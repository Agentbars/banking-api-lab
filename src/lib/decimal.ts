import { Prisma } from '@prisma/client';

export function toDecimal(input: unknown): Prisma.Decimal {
  if (input instanceof Prisma.Decimal) return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Number is not finite');
    return new Prisma.Decimal(input.toFixed(2));
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') throw new Error('Empty string is not a decimal');
    return new Prisma.Decimal(trimmed);
  }
  throw new Error('Cannot coerce value to Decimal');
}

export function formatDecimal(d: Prisma.Decimal): string {
  return d.toFixed(2);
}
