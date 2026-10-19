import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from './config';
import { pool } from './db';
import { unauthorized } from './errors';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Wraps an async route so rejected promises reach the Express error handler (Express 4). */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const hashPassword = (plain: string) => bcrypt.hash(plain, config.BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export const signToken = (userId: string) =>
  jwt.sign({}, config.JWT_SECRET, {
    subject: userId,
    algorithm: 'HS256',
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

/** Verifies the bearer JWT on the server and loads the user (so deleted users lose access). */
export const authenticate = h(async (req, _res, next) => {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized();
  let userId: string;
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) throw new Error('no subject');
    userId = payload.sub;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const { rows } = await pool.query<AuthUser>('SELECT id, email, name FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw unauthorized('Invalid or expired token');
  req.user = rows[0];
  next();
});
