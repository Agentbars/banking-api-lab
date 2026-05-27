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
  if (existing) {
    throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'Email already registered');
  }

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, name, password: hash },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function loginUser(body: unknown) {
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.authToken.create({ data: { userId: user.id, token, expiresAt } });

  return { token, expiresAt: expiresAt.toISOString() };
}
