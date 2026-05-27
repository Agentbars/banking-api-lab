import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
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

    const found = await prisma.authToken.findUnique({
      where: { token },
      include: { user: true },
    });
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
