import path from 'path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL must be set (see .env.example)');

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    fileParallelism: false, // all files share one test database
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testUrl, // the app under test only ever sees the test database
      JWT_SECRET: 'test-secret-test-secret-0123456789',
      BCRYPT_ROUNDS: '4',
    },
  },
});
