import { randomInt } from 'node:crypto';

export function generateAccountNumber(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += randomInt(0, 10).toString();
  return out;
}
