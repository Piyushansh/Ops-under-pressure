import { Router } from 'express';
import { z } from 'zod';
import { authenticate, h, hashPassword, signToken, verifyPassword } from '../auth';
import { pool } from '../db';
import { unauthorized } from '../errors';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }).strict();

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
let dummyHash: Promise<string> | undefined;

authRouter.post(
  '/login',
  h(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const { rows } = await pool.query<{ id: string; email: string; name: string; password_hash: string }>(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email],
    );
    const user = rows[0];
    dummyHash ??= hashPassword('not-a-real-password');
    const ok = await verifyPassword(password, user ? user.password_hash : await dummyHash);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    res.json({ token: signToken(user.id), user: { id: user.id, email: user.email, name: user.name } });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  h(async (req, res) => {
    const user = req.user!;
    const { rows } = await pool.query(
      `SELECT m.team_id AS "teamId", t.name AS "teamName", m.role
       FROM memberships m JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = $1 ORDER BY t.name`,
      [user.id],
    );
    res.json({ user, memberships: rows });
  }),
);
