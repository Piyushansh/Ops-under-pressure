import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { api, createFixture, eventCount, itemRow, makeItem, PASSWORD, raceBehindRowLock, resetDb } from './helpers';

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let f: Fixture;

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  f = await createFixture();
});
afterAll(async () => {
  await pool.end();
});

describe('1. authentication', () => {
  it('logs in with valid credentials and never exposes the password hash', async () => {
    const res = await api('post', '/api/auth/login').send({ email: 'm1@test.dev', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'm1@test.dev' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$/i);

    const me = await api('get', '/api/auth/me', res.body.token);
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([expect.objectContaining({ teamName: 'Team A', role: 'MEMBER' })]);
  });

  it('rejects a wrong password and an unknown email with the same 401', async () => {
    const wrong = await api('post', '/api/auth/login').send({ email: 'm1@test.dev', password: 'nope' });
    const unknown = await api('post', '/api/auth/login').send({ email: 'ghost@test.dev', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('returns 400 for a malformed login body', async () => {
    const res = await api('post', '/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('stores only bcrypt hashes, never plaintext passwords', async () => {
    const { rows } = await pool.query('SELECT password_hash FROM users');
    for (const r of rows) {
      expect(r.password_hash).toMatch(/^\$2[aby]\$/);
      expect(r.password_hash).not.toContain(PASSWORD);
    }
  });
});

describe('2. unauthorized requests', () => {
  it('rejects missing, malformed and tampered tokens with 401', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    expect((await api('get', '/api/items')).status).toBe(401);
    expect((await api('get', `/api/items/${id}`)).status).toBe(401);
    expect((await api('post', '/api/items')).status).toBe(401);
    expect((await api('get', '/api/items', 'garbage')).status).toBe(401);
    expect((await api('get', '/api/items', f.tokens.m1 + 'x')).status).toBe(401);
    expect((await api('get', '/api/dashboard/summary')).status).toBe(401);
  });

  it('keeps /api/health public', async () => {
    const res = await api('get', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('3. team isolation and roles', () => {
  it('hides another team\'s items from a user outside the team on every route', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { title: 'Secret A item' });
    const t = f.tokens.outsider;

    expect((await api('get', `/api/items/${id}`, t)).status).toBe(404);
    expect((await api('get', `/api/items/${id}/activity`, t)).status).toBe(404);
    expect((await api('post', `/api/items/${id}/claim`, t)).status).toBe(404);
    expect((await api('post', `/api/items/${id}/comments`, t).send({ body: 'hi' })).status).toBe(404);
    expect((await api('patch', `/api/items/${id}`, t).send({ version: 1, title: 'hacked' })).status).toBe(404);
    expect((await api('post', `/api/items/${id}/transition`, t).send({ to: 'IN_PROGRESS', version: 1 })).status).toBe(404);
    expect((await api('get', `/api/items?teamId=${f.teamA}`, t)).status).toBe(403);
    expect((await api('post', '/api/items', t).send({ title: 'x', type: 'TASK', teamId: f.teamA })).status).toBe(403);

    const list = await api('get', '/api/items', t);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);
    expect(JSON.stringify(list.body)).not.toContain('Secret A item');

    const dash = await api('get', '/api/dashboard/summary', t);
    expect(dash.body.unassignedUrgent.count).toBe(0);

    expect((await itemRow(id)).title).toBe('Secret A item');
    expect(await eventCount(id)).toBe(0);
  });

  it('lets a VIEWER read but not create, edit, claim, comment or transition', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    const t = f.tokens.viewer;
    expect((await api('get', `/api/items/${id}`, t)).status).toBe(200);
    expect((await api('get', '/api/items', t)).body.total).toBe(1);
    expect((await api('post', '/api/items', t).send({ title: 'x', type: 'TASK', teamId: f.teamA })).status).toBe(403);
    expect((await api('patch', `/api/items/${id}`, t).send({ version: 1, title: 'x' })).status).toBe(403);
    expect((await api('post', `/api/items/${id}/claim`, t)).status).toBe(403);
    expect((await api('post', `/api/items/${id}/comments`, t).send({ body: 'x' })).status).toBe(403);
    expect((await api('post', `/api/items/${id}/transition`, t).send({ to: 'IN_PROGRESS', version: 1 })).status).toBe(403);
    expect(await eventCount(id)).toBe(0);
  });

  it('only a team ADMIN can change memberships', async () => {
    const asLead = await api('put', `/api/teams/${f.teamA}/members/${f.users.outsider}`, f.tokens.lead).send({ role: 'MEMBER' });
    expect(asLead.status).toBe(403);
    const asAdmin = await api('put', `/api/teams/${f.teamA}/members/${f.users.outsider}`, f.tokens.admin).send({ role: 'MEMBER' });
    expect(asAdmin.status).toBe(200);
    const id = await makeItem(f.teamA, f.users.lead);
    expect((await api('get', `/api/items/${id}`, f.tokens.outsider)).status).toBe(200);
  });
});

describe('4. atomic claiming', () => {
  it('lets exactly one of five simultaneous claimers win, in every round', async () => {
    const claimers = ['m1', 'm2', 'm3', 'lead', 'admin'];
    for (let round = 0; round < 5; round++) {
      const id = await makeItem(f.teamA, f.users.lead, { title: `Race ${round}` });
      const results = await Promise.all(claimers.map((c) => api('post', `/api/items/${id}/claim`, f.tokens[c])));

      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const winnerIdx = results.findIndex((r) => r.status === 200);
      const winnerId = f.users[claimers[winnerIdx]];
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('ALREADY_CLAIMED');

      const row = await itemRow(id);
      expect(row.assignee_id).toBe(winnerId);
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.version).toBe(2); // bumped exactly once
      // exactly one assignment event and one status event: the losers wrote nothing
      expect(await eventCount(id)).toBe(2);
    }
  });

  it('rejects claiming an already-assigned item with 409', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { status: 'IN_PROGRESS', assigneeId: f.users.m1 });
    const res = await api('post', `/api/items/${id}/claim`, f.tokens.m2);
    expect(res.status).toBe(409);
    expect((await itemRow(id)).assignee_id).toBe(f.users.m1);
    expect(await eventCount(id)).toBe(0);
  });
});

describe('5. optimistic concurrency', () => {
  it('rejects a stale update with 409 and does not overwrite newer data', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { title: 'Original', priority: 'LOW' });

    const first = await api('patch', `/api/items/${id}`, f.tokens.m1).send({ version: 1, title: 'First edit' });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    const stale = await api('patch', `/api/items/${id}`, f.tokens.m2).send({ version: 1, title: 'Stale overwrite', priority: 'URGENT' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');
    expect(stale.body.error.details.currentVersion).toBe(2);

    const row = await itemRow(id);
    expect(row).toMatchObject({ title: 'First edit', priority: 'LOW', version: 2 });
    expect(await eventCount(id)).toBe(1); // only the successful edit was recorded
  });

  it('lets exactly one of two simultaneous edits with the same version win', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    const [a, b] = await Promise.all([
      api('patch', `/api/items/${id}`, f.tokens.m1).send({ version: 1, title: 'From m1' }),
      api('patch', `/api/items/${id}`, f.tokens.m2).send({ version: 1, title: 'From m2' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await itemRow(id);
    expect(row.version).toBe(2);
    expect(row.title).toBe(a.status === 200 ? 'From m1' : 'From m2');
  });

  it('requires a version and rejects a client-supplied status', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    expect((await api('patch', `/api/items/${id}`, f.tokens.m1).send({ title: 'no version' })).status).toBe(400);
    const withStatus = await api('patch', `/api/items/${id}`, f.tokens.m1).send({ version: 1, status: 'RESOLVED' });
    expect(withStatus.status).toBe(400);
    expect((await itemRow(id)).status).toBe('OPEN');
  });

  it('only leads can assign others; assignees must belong to the team', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    expect((await api('patch', `/api/items/${id}`, f.tokens.m1).send({ version: 1, assigneeId: f.users.m2 })).status).toBe(403);
    const outsider = await api('patch', `/api/items/${id}`, f.tokens.lead).send({ version: 1, assigneeId: f.users.outsider });
    expect(outsider.status).toBe(400);
    expect(outsider.body.error.code).toBe('INVALID_ASSIGNEE');
    const ok = await api('patch', `/api/items/${id}`, f.tokens.lead).send({ version: 1, assigneeId: f.users.m2 });
    expect(ok.status).toBe(200);
    expect(ok.body.assignee.id).toBe(f.users.m2);
  });
});

describe('6. idempotent creation', () => {
  const body = () => ({ title: 'Idempotent item', type: 'PAYMENT', priority: 'HIGH', teamId: f.teamA });
  const count = async (title: string) =>
    (await pool.query('SELECT count(*)::int AS n FROM work_items WHERE title = $1', [title])).rows[0].n as number;

  it('does not duplicate the item when the same key is repeated', async () => {
    const first = await api('post', '/api/items', f.tokens.m1).set('Idempotency-Key', 'key-1').send(body());
    const second = await api('post', '/api/items', f.tokens.m1).set('Idempotency-Key', 'key-1').send(body());
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await count('Idempotent item')).toBe(1);
    expect(await eventCount(first.body.id)).toBe(1); // one CREATED event, not two
  });

  it('creates exactly one item when five identical requests race', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api('post', '/api/items', f.tokens.m1).set('Idempotency-Key', 'race-key').send(body())),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await count('Idempotent item')).toBe(1);
  });

  it('rejects reusing a key with a different body (409) and scopes keys per user', async () => {
    await api('post', '/api/items', f.tokens.m1).set('Idempotency-Key', 'key-2').send(body());
    const reuse = await api('post', '/api/items', f.tokens.m1).set('Idempotency-Key', 'key-2').send({ ...body(), title: 'Different' });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await count('Different')).toBe(0);

    const otherUser = await api('post', '/api/items', f.tokens.m2).set('Idempotency-Key', 'key-2').send(body());
    expect(otherUser.status).toBe(201);
    expect(await count('Idempotent item')).toBe(2);
  });

  it('creates separate items when no key is sent, and a failed create stores no key', async () => {
    await api('post', '/api/items', f.tokens.m1).send(body());
    await api('post', '/api/items', f.tokens.m1).send(body());
    expect(await count('Idempotent item')).toBe(2);

    const bad = await api('post', '/api/items', f.tokens.m1).set('Idempotency-Key', 'key-3').send({ ...body(), type: 'NOPE' });
    expect(bad.status).toBe(400);
    const retry = await api('post', '/api/items', f.tokens.m1).set('Idempotency-Key', 'key-3').send(body());
    expect(retry.status).toBe(201);
  });
});

describe('7. workflow enforcement', () => {
  it('rejects invalid transitions and leaves the item and its history untouched', async () => {
    const open = await makeItem(f.teamA, f.users.lead, { status: 'OPEN' });
    const inProgress = await makeItem(f.teamA, f.users.lead, { status: 'IN_PROGRESS', assigneeId: f.users.m1 });
    const resolved = await makeItem(f.teamA, f.users.lead, { status: 'RESOLVED', assigneeId: f.users.m1 });
    const closed = await makeItem(f.teamA, f.users.lead, { status: 'CLOSED', assigneeId: f.users.m1 });
    const t = f.tokens.lead;

    const cases: [string, string, string][] = [
      [open, 'RESOLVED', 'INVALID_TRANSITION'],
      [open, 'CLOSED', 'INVALID_TRANSITION'],
      [open, 'OPEN', 'INVALID_TRANSITION'],
      [inProgress, 'RESOLVED', 'INVALID_TRANSITION'], // cannot skip approval
      [inProgress, 'CLOSED', 'INVALID_TRANSITION'],
      [resolved, 'OPEN', 'INVALID_TRANSITION'],
      [closed, 'IN_PROGRESS', 'INVALID_TRANSITION'],
      [closed, 'OPEN', 'INVALID_TRANSITION'],
    ];
    for (const [id, to, code] of cases) {
      const before = await itemRow(id);
      const res = await api('post', `/api/items/${id}/transition`, t).send({ to, version: before.version });
      expect(res.status, `${before.status} -> ${to}`).toBe(409);
      expect(res.body.error.code).toBe(code);
      expect(await itemRow(id)).toEqual(before);
      expect(await eventCount(id)).toBe(0);
    }

    const unknown = await api('post', `/api/items/${open}/transition`, t).send({ to: 'DONE', version: 1 });
    expect(unknown.status).toBe(400);
    const noVersion = await api('post', `/api/items/${open}/transition`, t).send({ to: 'IN_PROGRESS' });
    expect(noVersion.status).toBe(400);
  });

  it('requires an assignee to start work, and walks the happy path end to end', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    const noAssignee = await api('post', `/api/items/${id}/transition`, f.tokens.lead).send({ to: 'IN_PROGRESS', version: 1 });
    expect(noAssignee.status).toBe(409);
    expect(noAssignee.body.error.code).toBe('ASSIGNEE_REQUIRED');

    const claim = await api('post', `/api/items/${id}/claim`, f.tokens.m1); // OPEN -> IN_PROGRESS, v2
    expect(claim.body.status).toBe('IN_PROGRESS');
    const submit = await api('post', `/api/items/${id}/transition`, f.tokens.m1).send({ to: 'AWAITING_APPROVAL', version: 2 });
    expect(submit.status).toBe(200);
    const approve = await api('post', `/api/items/${id}/transition`, f.tokens.lead).send({ to: 'RESOLVED', version: 3 });
    expect(approve.status).toBe(200);
    const close = await api('post', `/api/items/${id}/transition`, f.tokens.lead).send({ to: 'CLOSED', version: 4 });
    expect(close.status).toBe(200);
    expect(close.body.version).toBe(5);

    const edit = await api('patch', `/api/items/${id}`, f.tokens.admin).send({ version: 5, title: 'edit closed' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('ITEM_CLOSED');
  });

  it('only the assignee (or a lead) can submit work for approval', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { status: 'IN_PROGRESS', assigneeId: f.users.m1 });
    const other = await api('post', `/api/items/${id}/transition`, f.tokens.m2).send({ to: 'AWAITING_APPROVAL', version: 1 });
    expect(other.status).toBe(403);
    expect((await itemRow(id)).status).toBe('IN_PROGRESS');
  });
});

describe('8. approval needs a LEAD of the item\'s team', () => {
  it('rejects approval by non-leads and by leads of other teams; allows the team lead', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { status: 'AWAITING_APPROVAL', assigneeId: f.users.m1 });
    const approve = (who: string) => api('post', `/api/items/${id}/transition`, f.tokens[who]).send({ to: 'RESOLVED', version: 1 });

    for (const who of ['m1' /* the assignee */, 'm2', 'viewer']) {
      const res = await approve(who);
      expect(res.status, who).toBe(403);
    }
    expect((await approve('bLead')).status).toBe(404); // LEAD of another team: no access at all
    expect((await itemRow(id)).status).toBe('AWAITING_APPROVAL');
    expect(await eventCount(id)).toBe(0);

    const ok = await approve('lead');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('RESOLVED');
    expect(await eventCount(id)).toBe(1);
  });

  it('shows awaiting items only on the dashboard of that team\'s leads', async () => {
    await makeItem(f.teamA, f.users.lead, { status: 'AWAITING_APPROVAL', assigneeId: f.users.m1 });
    expect((await api('get', '/api/dashboard/summary', f.tokens.lead)).body.awaitingMyApproval.count).toBe(1);
    expect((await api('get', '/api/dashboard/summary', f.tokens.m1)).body.awaitingMyApproval.count).toBe(0);
    expect((await api('get', '/api/dashboard/summary', f.tokens.bLead)).body.awaitingMyApproval.count).toBe(0);
  });
});

describe('9. activity history', () => {
  it('records events for successful changes, in order, with actors', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { priority: 'LOW' });
    await api('post', `/api/items/${id}/claim`, f.tokens.m1); // ASSIGNEE + STATUS
    await api('patch', `/api/items/${id}`, f.tokens.m1).send({ version: 2, priority: 'HIGH' }); // PRIORITY
    await api('post', `/api/items/${id}/transition`, f.tokens.m1).send({ to: 'AWAITING_APPROVAL', version: 3 }); // STATUS
    const comment = await api('post', `/api/items/${id}/comments`, f.tokens.lead).send({ body: 'Looks fine' }); // COMMENT
    expect(comment.status).toBe(201);
    expect(comment.body.author.id).toBe(f.users.lead);
    expect(comment.body.createdAt).toEqual(expect.any(String));

    const res = await api('get', `/api/items/${id}/activity`, f.tokens.viewer);
    expect(res.status).toBe(200);
    const events = res.body.data as { type: string; field: string | null; fromValue: string | null; toValue: string | null; actorId: string; commentBody: string | null; toLabel: string | null }[];
    expect(events.map((e) => e.type)).toEqual(['COMMENT_ADDED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'STATUS_CHANGED', 'ASSIGNEE_CHANGED']); // newest first
    expect(events[0]).toMatchObject({ actorId: f.users.lead, commentBody: 'Looks fine' });
    expect(events[1]).toMatchObject({ fromValue: 'IN_PROGRESS', toValue: 'AWAITING_APPROVAL' });
    expect(events[2]).toMatchObject({ fromValue: 'LOW', toValue: 'HIGH', actorId: f.users.m1 });
    expect(events[4]).toMatchObject({ fromValue: null, toValue: f.users.m1, toLabel: 'm1' });
  });

  it('writes nothing for failed changes', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { status: 'IN_PROGRESS', assigneeId: f.users.m1, version: 3 });
    const attempts = [
      api('patch', `/api/items/${id}`, f.tokens.m2).send({ version: 1, title: 'stale' }), // 409
      api('patch', `/api/items/${id}`, f.tokens.m2).send({ version: 3, status: 'RESOLVED' }), // 400
      api('post', `/api/items/${id}/transition`, f.tokens.lead).send({ to: 'RESOLVED', version: 3 }), // 409 invalid
      api('post', `/api/items/${id}/transition`, f.tokens.m2).send({ to: 'AWAITING_APPROVAL', version: 3 }), // 403
      api('post', `/api/items/${id}/claim`, f.tokens.m2), // 409 already claimed
      api('post', `/api/items/${id}/comments`, f.tokens.viewer).send({ body: 'x' }), // 403
      api('post', `/api/items/${id}/comments`, f.tokens.m1).send({ body: '   ' }), // 400
      api('post', `/api/items/${id}/comments`, f.tokens.outsider).send({ body: 'x' }), // 404
    ];
    const statuses = (await Promise.all(attempts)).map((r) => r.status);
    expect(statuses).toEqual([409, 400, 409, 403, 409, 403, 400, 404]);
    expect(await eventCount(id)).toBe(0);
    expect(await itemRow(id)).toMatchObject({ title: 'Test item', status: 'IN_PROGRESS', version: 3 });
    expect((await pool.query('SELECT count(*)::int AS n FROM comments')).rows[0].n).toBe(0);
  });

  it('rolls back the item change when the activity write fails (same transaction)', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    // Make the audit insert fail for the next transition, then verify the status did not move.
    await pool.query('ALTER TABLE activity_events ADD CONSTRAINT test_block CHECK (type <> \'ASSIGNEE_CHANGED\') NOT VALID');
    try {
      const res = await api('post', `/api/items/${id}/claim`, f.tokens.m1);
      expect(res.status).toBe(500);
      expect(await itemRow(id)).toMatchObject({ status: 'OPEN', assignee_id: null, version: 1 });
    } finally {
      await pool.query('ALTER TABLE activity_events DROP CONSTRAINT test_block');
    }
  });

  it('is append-only at the database level', async () => {
    const id = await makeItem(f.teamA, f.users.lead);
    await api('post', `/api/items/${id}/comments`, f.tokens.m1).send({ body: 'hello' });
    await expect(pool.query('UPDATE activity_events SET type = $1 WHERE item_id = $2', ['CREATED', id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM activity_events WHERE item_id = $1', [id])).rejects.toThrow(/append-only/);
    expect(await eventCount(id)).toBe(1);
  });
});

describe('server-side search, filters and pagination', () => {
  it('pages deterministically with no duplicates or gaps and a stable total', async () => {
    for (let i = 0; i < 25; i++) await makeItem(f.teamA, f.users.lead, { title: `Item ${String(i).padStart(2, '0')}` });
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await api('get', `/api/items?pageSize=10&page=${page}`, f.tokens.m1);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 25, totalPages: 3, page, pageSize: 10 });
      seen.push(...res.body.data.map((i: { id: string }) => i.id));
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    const again = await api('get', '/api/items?pageSize=10&page=2', f.tokens.m1);
    expect(again.body.data.map((i: { id: string }) => i.id)).toEqual(seen.slice(10, 20));
    expect((await api('get', '/api/items?page=9&pageSize=10', f.tokens.m1)).body.data).toEqual([]);
  });

  it('filters by status, priority, assignee and search text in the database', async () => {
    await makeItem(f.teamA, f.users.lead, { title: 'Payment gateway timeout', description: 'EU acquirer', priority: 'URGENT' });
    await makeItem(f.teamA, f.users.lead, { title: 'Refund stuck', status: 'IN_PROGRESS', assigneeId: f.users.m1 });
    await makeItem(f.teamA, f.users.lead, { title: '100% off coupon', priority: 'LOW' });
    const get = async (qs: string) => (await api('get', `/api/items?${qs}`, f.tokens.m1)).body;

    expect((await get('q=gateway')).total).toBe(1);
    expect((await get('q=ACQUIRER')).total).toBe(1); // case-insensitive, searches description too
    expect((await get('q=100%25')).total).toBe(1); // % is escaped, not a wildcard
    expect((await get('q=%25')).total).toBe(1);
    expect((await get('status=IN_PROGRESS')).total).toBe(1);
    expect((await get('priority=URGENT')).total).toBe(1);
    expect((await get('assigneeId=me')).data[0].title).toBe('Refund stuck');
    expect((await get('assigneeId=unassigned')).total).toBe(2);
    expect((await get(`assigneeId=${f.users.m1}&status=IN_PROGRESS`)).total).toBe(1);
  });

  it('validates query parameters', async () => {
    for (const qs of ['pageSize=1000', 'page=0', 'status=BOGUS', 'priority=x', 'assigneeId=nobody', 'teamId=abc']) {
      const res = await api('get', `/api/items?${qs}`, f.tokens.m1);
      expect(res.status, qs).toBe(400);
    }
  });

  it('builds the dashboard sections from the caller\'s own data', async () => {
    await makeItem(f.teamA, f.users.lead, { title: 'Mine', status: 'IN_PROGRESS', assigneeId: f.users.m1 });
    await makeItem(f.teamA, f.users.lead, { title: 'Urgent free', priority: 'URGENT' });
    await makeItem(f.teamA, f.users.lead, { title: 'Urgent taken', priority: 'URGENT', status: 'IN_PROGRESS', assigneeId: f.users.m2 });
    await makeItem(f.teamB, f.users.bLead, { title: 'Other team urgent', priority: 'URGENT' });
    const res = await api('get', '/api/dashboard/summary', f.tokens.m1);
    expect(res.body.assignedToMe.items.map((i: { title: string }) => i.title)).toEqual(['Mine']);
    expect(res.body.unassignedUrgent.items.map((i: { title: string }) => i.title)).toEqual(['Urgent free']);
    expect(res.body.awaitingMyApproval.count).toBe(0);
  });
});

describe('item access hints for the UI', () => {
  it('reports what each role may do (the server still enforces every action)', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { status: 'IN_PROGRESS', assigneeId: f.users.m1 });
    const get = async (who: string) => (await api('get', `/api/items/${id}`, f.tokens[who])).body.access;
    expect(await get('viewer')).toMatchObject({ role: 'VIEWER', canEdit: false, canClaim: false, canComment: false, transitions: [] });
    expect(await get('m1')).toMatchObject({ role: 'MEMBER', canEdit: true, canAssign: false, transitions: ['AWAITING_APPROVAL'] });
    expect((await get('m2')).transitions).toEqual([]); // not the assignee
    expect((await get('lead')).transitions.sort()).toEqual(['AWAITING_APPROVAL', 'OPEN']);
    const waiting = await makeItem(f.teamA, f.users.lead, { status: 'AWAITING_APPROVAL', assigneeId: f.users.m1 });
    const asM1 = (await api('get', `/api/items/${waiting}`, f.tokens.m1)).body.access;
    const asLead = (await api('get', `/api/items/${waiting}`, f.tokens.lead)).body.access;
    expect(asM1.transitions).toEqual([]);
    expect(asLead.transitions.sort()).toEqual(['IN_PROGRESS', 'RESOLVED']);
  });
});

describe('error format', () => {
  it('returns JSON errors for bad ids, bad JSON, and unknown routes', async () => {
    expect((await api('get', '/api/items/not-a-uuid', f.tokens.m1)).status).toBe(400);
    expect((await api('get', '/api/items/00000000-0000-4000-8000-000000000000', f.tokens.m1)).status).toBe(404);
    expect((await api('get', '/api/nope', f.tokens.m1)).body.error.code).toBe('NOT_FOUND');
    const badJson = await api('post', '/api/auth/login').set('Content-Type', 'application/json').send('{broken');
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('INVALID_JSON');
  });
});

describe('deterministic races (all competitors forced to overlap at the UPDATE)', () => {
  it('claim: five claimers blocked on the same row -> exactly one wins (OPEN and unassigned IN_PROGRESS)', async () => {
    const claimers = ['m1', 'm2', 'm3', 'lead', 'admin'];
    // An unassigned IN_PROGRESS item keeps its status when claimed, so only the
    // "assignee_id IS NULL" condition (not a status change) can stop a second claimer.
    for (const status of ['OPEN', 'IN_PROGRESS', 'OPEN', 'IN_PROGRESS']) {
      const id = await makeItem(f.teamA, f.users.lead, { status });
      const results = await raceBehindRowLock(id, claimers.map((c) => () => api('post', `/api/items/${id}/claim`, f.tokens[c])));
      expect(results.map((r) => r.status), status).toEqual(expect.arrayContaining([200]));
      expect(results.map((r) => r.status).sort(), status).toEqual([200, 409, 409, 409, 409]);
      const winner = f.users[claimers[results.findIndex((r) => r.status === 200)]];
      expect(await itemRow(id)).toMatchObject({ assignee_id: winner, status: 'IN_PROGRESS', version: 2 });
      expect(await eventCount(id)).toBe(status === 'OPEN' ? 2 : 1); // assignee (+ status when starting from OPEN)
    }
  });

  it('edit: two edits with the same version blocked on the same row -> one 200, one 409, no lost update', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { title: 'Original' });
    const results = await raceBehindRowLock(id, [
      () => api('patch', `/api/items/${id}`, f.tokens.m1).send({ version: 1, title: 'From m1' }),
      () => api('patch', `/api/items/${id}`, f.tokens.m2).send({ version: 1, title: 'From m2' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((r) => r.status === 200) === 0 ? 'From m1' : 'From m2';
    expect(await itemRow(id)).toMatchObject({ title: winner, version: 2 });
    expect(await eventCount(id)).toBe(1); // the loser's change was not recorded
  });

  it('transition: approve and reject racing on the same version -> only one applies', async () => {
    const id = await makeItem(f.teamA, f.users.lead, { status: 'AWAITING_APPROVAL', assigneeId: f.users.m1 });
    const results = await raceBehindRowLock(id, [
      () => api('post', `/api/items/${id}/transition`, f.tokens.lead).send({ to: 'RESOLVED', version: 1 }),
      () => api('post', `/api/items/${id}/transition`, f.tokens.admin).send({ to: 'IN_PROGRESS', version: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const applied = results.findIndex((r) => r.status === 200) === 0 ? 'RESOLVED' : 'IN_PROGRESS';
    expect(await itemRow(id)).toMatchObject({ status: applied, version: 2 });
    expect(await eventCount(id)).toBe(1);
  });
});
