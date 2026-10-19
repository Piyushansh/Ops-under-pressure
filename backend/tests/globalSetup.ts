import { runMigrations } from '../src/migrate';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/test/i.test(new URL(url).pathname)) {
    throw new Error('Refusing to run: TEST_DATABASE_URL must point to a database whose name contains "test".');
  }
  await runMigrations(url);
}
