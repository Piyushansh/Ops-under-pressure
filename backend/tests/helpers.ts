import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth';
import { pool } from '../src/db';

export const app = createApp();
export const PASSWORD = 'Test#Pass123';

export type Method = 'get' | 'post' | 'patch' | 'put';
export const api = (method: Method, url: string, token?: string) => {
  const r = request(app)[method](url);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

export async function resetDb() {
  if (!/test/i.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error('Refusing to truncate a non-test database');
  await pool.query(
    'TRUNCATE activity_events, comments, idempotency_keys, work_items, memberships, teams, users RESTART IDENTITY CASCADE',
  );
}

export async function createFixture() {
  const hash = await hashPassword(PASSWORD);
  const users: Record<string, string> = {};
  for (const name of ['lead', 'admin', 'm1', 'm2', 'm3', 'viewer', 'outsider', 'bLead']) {
    const r = await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [`${name.toLowerCase()}@test.dev`, name, hash]);
    users[name] = r.rows[0].id;
  }
  const teamA = (await pool.query("INSERT INTO teams (name) VALUES ('Team A') RETURNING id")).rows[0].id as string;
  const teamB = (await pool.query("INSERT INTO teams (name) VALUES ('Team B') RETURNING id")).rows[0].id as string;
  const memberships: [string, string, string][] = [
    ['lead', teamA, 'LEAD'], ['admin', teamA, 'ADMIN'], ['m1', teamA, 'MEMBER'], ['m2', teamA, 'MEMBER'],
    ['m3', teamA, 'MEMBER'], ['viewer', teamA, 'VIEWER'], ['outsider', teamB, 'MEMBER'], ['bLead', teamB, 'LEAD'],
  ];
  for (const [u, t, role] of memberships) {
    await pool.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)', [users[u], t, role]);
  }
  const tokens: Record<string, string> = {};
  for (const name of Object.keys(users)) {
    const res = await api('post', '/api/auth/login').send({ email: `${name.toLowerCase()}@test.dev`, password: PASSWORD });
    if (res.status !== 200) throw new Error(`fixture login failed for ${name}: ${res.status}`);
    tokens[name] = res.body.token;
  }
  return { users, tokens, teamA, teamB };
}

export interface ItemOverrides {
  title?: string;
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  description?: string;
  type?: string;
  version?: number;
}

/** Inserts an item directly (bypassing the API) so tests can start from any state. */
export async function makeItem(teamId: string, createdById: string, o: ItemOverrides = {}) {
  const r = await pool.query(
    `INSERT INTO work_items (title, description, type, priority, status, team_id, assignee_id, created_by_id, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [o.title ?? 'Test item', o.description ?? '', o.type ?? 'TASK', o.priority ?? 'MEDIUM', o.status ?? 'OPEN', teamId, o.assigneeId ?? null, createdById, o.version ?? 1],
  );
  return r.rows[0].id as string;
}

export const eventCount = async (itemId: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM activity_events WHERE item_id = $1', [itemId])).rows[0].n as number;

export const itemRow = async (itemId: string) =>
  (await pool.query('SELECT status, priority, title, assignee_id, version FROM work_items WHERE id = $1', [itemId])).rows[0];

/**
 * Forces a genuine race. A separate connection locks the item row; every starter's request
 * passes its application-level read checks and then blocks on its UPDATE. Once all of them
 * are verifiably waiting in Postgres, the lock is released, so the only thing deciding the
 * outcome is the conditional UPDATE inside each request.
 */
export async function raceBehindRowLock(itemId: string, starters: Array<() => request.Test>) {
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM work_items WHERE id = $1 FOR UPDATE', [itemId]);
    const pending = starters.map((start) => start().then((r) => r));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'UPDATE work_items%'",
      );
      if (rows[0].n >= starters.length) break;
      if (Date.now() > deadline) throw new Error(`only ${rows[0].n}/${starters.length} requests reached the UPDATE`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await holder.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
}
