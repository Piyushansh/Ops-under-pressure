import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Repo-root .env is optional (Docker and CI pass real environment variables).
// dotenv never overrides variables that are already set.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  PORT: z.coerce.number().int().default(4000),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(10),
  CORS_ORIGIN: z.string().optional(),
  FRONTEND_DIST: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${problems}`);
}
export const config = parsed.data;
