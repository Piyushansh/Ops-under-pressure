import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AuthUser, h } from '../auth';
import { getTeamRole, requireItemAccess, requireTeamAccess, roleAtLeast, roleCan, Action, Role } from '../authz';
import { Db, isUniqueViolation, pool, withTx } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { getItem, ITEM_SELECT, mapItem, NewEvent, recordEvent, WorkItem } from '../itemData';
import { allowedTargets, findTransition, ITEM_TYPES, PRIORITIES, STATUSES, TRANSITIONS } from '../workflow';

export const itemsRouter = Router();

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const isoDate = z.string().datetime({ offset: true });
const titleField = z.string().trim().min(1).max(200);
const descriptionField = z.string().max(10000);

/** Loads an item and applies the resource-level permission check in one step. */
async function loadAuthorizedItem(db: Db, user: AuthUser, id: string, action: Action) {
  const item = await getItem(db, id);
  if (!item) throw notFound('Work item not found');
  const role = await requireItemAccess(db, user.id, item.teamId, action);
  return { item, role };
}

const staleVersion = (currentVersion: number) =>
  conflict('STALE_VERSION', 'This item was changed by someone else. Reload it and try again.', { currentVersion });

/**
 * What the current user may do with this item. Sent to the UI so it can show the right buttons
 * without duplicating the rules. It is a convenience only: every route re-checks on the server.
 */
function withAccess(item: WorkItem, role: Role, userId: string) {
  const isLead = roleAtLeast(role, 'LEAD');
  const transitions = TRANSITIONS.filter(
    (t) =>
      t.from === item.status &&
      roleAtLeast(role, t.minRole) &&
      (!t.assigneeOnlyForMember || isLead || item.assigneeId === userId) &&
      (!t.requiresAssignee || item.assigneeId !== null),
  ).map((t) => t.to);
  const open = item.status !== 'CLOSED';
  return {
    ...item,
    access: {
      role,
      canEdit: open && roleCan(role, 'item:edit'),
      canAssign: open && roleCan(role, 'item:assign'),
      canClaim: !item.assigneeId && (item.status === 'OPEN' || item.status === 'IN_PROGRESS') && roleCan(role, 'item:claim'),
      canComment: roleCan(role, 'item:comment'),
      transitions,
    },
  };
}

const short = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

// ---------------------------------------------------------------- list

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(ITEM_TYPES).optional(),
  teamId: uuid.optional(),
  assigneeId: z.union([z.literal('me'), z.literal('unassigned'), uuid]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

itemsRouter.get(
  '/',
  h(async (req, res) => {
    const user = req.user!;
    const query = listQuery.parse(req.query);

    // Authorization is part of the WHERE clause: only teams the caller belongs to.
    const { rows: memberships } = await pool.query<{ team_id: string }>(
      'SELECT team_id FROM memberships WHERE user_id = $1',
      [user.id],
    );
    let teamIds = memberships.map((m) => m.team_id);
    if (query.teamId) {
      if (!teamIds.includes(query.teamId)) throw forbidden('You are not a member of this team');
      teamIds = [query.teamId];
    }

    const params: unknown[] = [teamIds];
    const where: string[] = ['i.team_id = ANY($1::uuid[])'];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (query.status) add((n) => `i.status = $${n}`, query.status);
    if (query.priority) add((n) => `i.priority = $${n}`, query.priority);
    if (query.type) add((n) => `i.type = $${n}`, query.type);
    if (query.assigneeId === 'unassigned') where.push('i.assignee_id IS NULL');
    else if (query.assigneeId === 'me') add((n) => `i.assignee_id = $${n}`, user.id);
    else if (query.assigneeId) add((n) => `i.assignee_id = $${n}`, query.assigneeId);
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      add((n) => `(i.title ILIKE $${n} OR i.description ILIKE $${n})`, like);
    }
    const whereSql = where.join(' AND ');

    const offset = (query.page - 1) * query.pageSize;
    const [count, rows] = await Promise.all([
      pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM work_items i WHERE ${whereSql}`, params),
      pool.query(
        // (created_at, id) are immutable and unique together: stable, deterministic paging.
        `${ITEM_SELECT} WHERE ${whereSql} ORDER BY i.created_at DESC, i.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.pageSize, offset],
      ),
    ]);
    const total = count.rows[0].n;
    res.json({
      data: rows.rows.map(mapItem),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    });
  }),
);

// ---------------------------------------------------------------- create (idempotent)

const createSchema = z
  .object({
    title: titleField,
    description: descriptionField.default(''),
    type: z.enum(ITEM_TYPES),
    priority: z.enum(PRIORITIES).default('MEDIUM'),
    teamId: uuid,
    dueDate: isoDate.nullable().optional(),
  })
  .strict();

const idempotencyKeySchema = z.string().trim().min(1).max(255);

itemsRouter.post(
  '/',
  h(async (req, res) => {
    const user = req.user!;
    const input = createSchema.parse(req.body);
    const rawKey = req.header('idempotency-key');
    const key = rawKey === undefined ? null : idempotencyKeySchema.parse(rawKey);
    await requireTeamAccess(pool, user.id, input.teamId, 'item:create');

    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify([input.teamId, input.title, input.description, input.type, input.priority, input.dueDate ?? null]))
      .digest('hex');

    try {
      const body = await withTx(async (db) => {
        // The key row is inserted FIRST, in the same transaction as the item. A concurrent
        // request with the same key blocks on the unique index until this one commits,
        // then fails with a unique violation and replays the stored response instead.
        if (key) {
          await db.query('INSERT INTO idempotency_keys (key, user_id, request_hash) VALUES ($1, $2, $3)', [
            key,
            user.id,
            requestHash,
          ]);
        }
        const ins = await db.query<{ id: string }>(
          `INSERT INTO work_items (title, description, type, priority, team_id, created_by_id, due_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [input.title, input.description, input.type, input.priority, input.teamId, user.id, input.dueDate ? new Date(input.dueDate) : null],
        );
        const id = ins.rows[0].id;
        await recordEvent(db, { itemId: id, actorId: user.id, type: 'CREATED' });
        const item = await getItem(db, id);
        const json = JSON.parse(JSON.stringify(item)); // exactly what the client receives
        if (key) {
          await db.query('UPDATE idempotency_keys SET status_code = 201, response_body = $3::jsonb WHERE user_id = $1 AND key = $2', [
            user.id,
            key,
            JSON.stringify(json),
          ]);
        }
        return json;
      });
      res.status(201).json(body);
    } catch (err) {
      if (!key || !isUniqueViolation(err, 'idempotency_keys_user_key')) throw err;
      const { rows } = await pool.query<{ request_hash: string; status_code: number | null; response_body: unknown }>(
        'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [user.id, key],
      );
      const record = rows[0];
      if (!record || record.status_code === null) {
        throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed. Retry shortly.');
      }
      if (record.request_hash !== requestHash) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body.');
      }
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(record.status_code).json(record.response_body);
    }
  }),
);

// ---------------------------------------------------------------- read

itemsRouter.get(
  '/:id',
  h(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { item, role } = await loadAuthorizedItem(pool, req.user!, id, 'item:read');
    res.json(withAccess(item, role, req.user!.id));
  }),
);

itemsRouter.get(
  '/:id/activity',
  h(async (req, res) => {
    const { id } = idParams.parse(req.params);
    await loadAuthorizedItem(pool, req.user!, id, 'item:read');
    const { rows } = await pool.query(
      `SELECT e.id, e.type, e.field, e.from_value AS "fromValue", e.to_value AS "toValue",
              e.created_at AS "createdAt", e.actor_id AS "actorId", u.name AS "actorName",
              e.comment_id AS "commentId", c.body AS "commentBody",
              fu.name AS "fromLabel", tu.name AS "toLabel"
       FROM activity_events e
       JOIN users u ON u.id = e.actor_id
       LEFT JOIN comments c ON c.id = e.comment_id
       LEFT JOIN users fu ON e.type = 'ASSIGNEE_CHANGED' AND fu.id::text = e.from_value
       LEFT JOIN users tu ON e.type = 'ASSIGNEE_CHANGED' AND tu.id::text = e.to_value
       WHERE e.item_id = $1
       ORDER BY e.id DESC
       LIMIT 500`,
      [id],
    );
    res.json({ data: rows });
  }),
);

// ---------------------------------------------------------------- edit (optimistic concurrency)

const patchSchema = z
  .object({
    version: z.number().int().min(1),
    title: titleField.optional(),
    description: descriptionField.optional(),
    type: z.enum(ITEM_TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: isoDate.nullable().optional(),
    assigneeId: uuid.nullable().optional(),
  })
  .strict(); // a client-sent "status" (or any unknown field) is rejected with 400

itemsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const user = req.user!;
    const { id } = idParams.parse(req.params);
    const body = patchSchema.parse(req.body);

    const updated = await withTx(async (db) => {
      const { item, role } = await loadAuthorizedItem(db, user, id, 'item:edit');
      if (item.status === 'CLOSED') throw conflict('ITEM_CLOSED', 'Closed items cannot be edited');
      if (body.version !== item.version) throw staleVersion(item.version);

      const sets: string[] = [];
      const vals: unknown[] = [];
      const events: Omit<NewEvent, 'itemId' | 'actorId'>[] = [];
      const set = (column: string, value: unknown) => {
        vals.push(value);
        sets.push(`${column} = $${vals.length}`);
      };

      if (body.title !== undefined && body.title !== item.title) {
        set('title', body.title);
        events.push({ type: 'FIELDS_UPDATED', field: 'title', fromValue: item.title, toValue: body.title });
      }
      if (body.description !== undefined && body.description !== item.description) {
        set('description', body.description);
        events.push({ type: 'FIELDS_UPDATED', field: 'description', fromValue: short(item.description), toValue: short(body.description) });
      }
      if (body.type !== undefined && body.type !== item.type) {
        set('type', body.type);
        events.push({ type: 'FIELDS_UPDATED', field: 'type', fromValue: item.type, toValue: body.type });
      }
      if (body.dueDate !== undefined) {
        const next = body.dueDate ? new Date(body.dueDate) : null;
        if ((next?.getTime() ?? null) !== (item.dueDate?.getTime() ?? null)) {
          set('due_date', next);
          events.push({ type: 'FIELDS_UPDATED', field: 'dueDate', fromValue: item.dueDate?.toISOString() ?? null, toValue: next?.toISOString() ?? null });
        }
      }
      if (body.priority !== undefined && body.priority !== item.priority) {
        set('priority', body.priority);
        events.push({ type: 'PRIORITY_CHANGED', field: 'priority', fromValue: item.priority, toValue: body.priority });
      }
      if (body.assigneeId !== undefined && body.assigneeId !== item.assigneeId) {
        // Self-service is the claim endpoint; assigning/unassigning others needs LEAD+.
        if (!roleCan(role, 'item:assign')) throw forbidden('Only a lead or admin can assign or unassign items. Use claim for yourself.');
        if (body.assigneeId) {
          const assigneeRole = await getTeamRole(db, body.assigneeId, item.teamId);
          if (!assigneeRole || !roleCan(assigneeRole, 'item:claim')) {
            throw badRequest('INVALID_ASSIGNEE', 'Assignee must be a MEMBER or higher in the item\'s team');
          }
        }
        set('assignee_id', body.assigneeId);
        events.push({ type: 'ASSIGNEE_CHANGED', field: 'assignee', fromValue: item.assigneeId, toValue: body.assigneeId });
      }

      if (sets.length === 0) return { item, role }; // nothing changed: no write, no event, no version bump

      vals.push(id, body.version);
      const result = await db.query(
        `UPDATE work_items SET ${sets.join(', ')}, version = version + 1, updated_at = now()
         WHERE id = $${vals.length - 1} AND version = $${vals.length}`,
        vals,
      );
      if (result.rowCount === 0) {
        // Lost a race between our read and this write: someone else bumped the version.
        const { rows } = await db.query<{ version: number }>('SELECT version FROM work_items WHERE id = $1', [id]);
        throw staleVersion(rows[0]?.version ?? item.version);
      }
      for (const e of events) await recordEvent(db, { itemId: id, actorId: user.id, ...e });
      return { item: (await getItem(db, id)) as WorkItem, role };
    });
    res.json(withAccess(updated.item, updated.role, user.id));
  }),
);

// ---------------------------------------------------------------- claim (atomic)

itemsRouter.post(
  '/:id/claim',
  h(async (req, res) => {
    const user = req.user!;
    const { id } = idParams.parse(req.params);

    const claimed = await withTx(async (db) => {
      const { item, role } = await loadAuthorizedItem(db, user, id, 'item:claim');
      if (item.assigneeId) throw conflict('ALREADY_CLAIMED', 'This item has already been claimed');
      if (item.status !== 'OPEN' && item.status !== 'IN_PROGRESS') {
        throw conflict('NOT_CLAIMABLE', `Items in status ${item.status} cannot be claimed`);
      }
      const nextStatus = item.status === 'OPEN' ? 'IN_PROGRESS' : item.status;

      // The atomic step: a single conditional UPDATE. If two users race, Postgres makes the
      // second one wait for the row lock, re-check "assignee_id IS NULL" against the
      // committed row, and match zero rows -> 409. No frontend check is involved.
      const result = await db.query(
        `UPDATE work_items
            SET assignee_id = $1, status = $2, version = version + 1, updated_at = now()
          WHERE id = $3 AND assignee_id IS NULL AND status = $4`,
        [user.id, nextStatus, id, item.status],
      );
      if (result.rowCount === 0) throw conflict('ALREADY_CLAIMED', 'This item was just claimed or changed by someone else');

      await recordEvent(db, { itemId: id, actorId: user.id, type: 'ASSIGNEE_CHANGED', field: 'assignee', fromValue: null, toValue: user.id });
      if (nextStatus !== item.status) {
        await recordEvent(db, { itemId: id, actorId: user.id, type: 'STATUS_CHANGED', field: 'status', fromValue: item.status, toValue: nextStatus });
      }
      return { item: (await getItem(db, id)) as WorkItem, role };
    });
    res.json(withAccess(claimed.item, claimed.role, user.id));
  }),
);

// ---------------------------------------------------------------- workflow transition

const transitionSchema = z.object({ to: z.enum(STATUSES), version: z.number().int().min(1) }).strict();

itemsRouter.post(
  '/:id/transition',
  h(async (req, res) => {
    const user = req.user!;
    const { id } = idParams.parse(req.params);
    const body = transitionSchema.parse(req.body);

    const moved = await withTx(async (db) => {
      const { item, role } = await loadAuthorizedItem(db, user, id, 'item:transition');
      if (body.version !== item.version) throw staleVersion(item.version);

      const rule = findTransition(item.status, body.to);
      if (!rule) {
        throw conflict('INVALID_TRANSITION', `Cannot move from ${item.status} to ${body.to}`, { allowed: allowedTargets(item.status) });
      }
      if (!roleAtLeast(role, rule.minRole)) {
        throw forbidden(`Moving ${item.status} -> ${body.to} requires the ${rule.minRole} role in this team`);
      }
      if (rule.assigneeOnlyForMember && !roleAtLeast(role, 'LEAD') && item.assigneeId !== user.id) {
        throw forbidden('Only the assignee or a lead can make this change');
      }
      if (rule.requiresAssignee && !item.assigneeId) {
        throw conflict('ASSIGNEE_REQUIRED', 'Claim or assign the item before starting work on it');
      }

      const result = await db.query(
        `UPDATE work_items SET status = $1, version = version + 1, updated_at = now()
          WHERE id = $2 AND version = $3 AND status = $4`,
        [body.to, id, body.version, item.status],
      );
      if (result.rowCount === 0) {
        const { rows } = await db.query<{ version: number }>('SELECT version FROM work_items WHERE id = $1', [id]);
        throw staleVersion(rows[0]?.version ?? item.version);
      }
      await recordEvent(db, { itemId: id, actorId: user.id, type: 'STATUS_CHANGED', field: 'status', fromValue: item.status, toValue: body.to });
      return { item: (await getItem(db, id)) as WorkItem, role };
    });
    res.json(withAccess(moved.item, moved.role, user.id));
  }),
);

// ---------------------------------------------------------------- comments

const commentSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();

itemsRouter.post(
  '/:id/comments',
  h(async (req, res) => {
    const user = req.user!;
    const { id } = idParams.parse(req.params);
    const input = commentSchema.parse(req.body);

    const comment = await withTx(async (db) => {
      await loadAuthorizedItem(db, user, id, 'item:comment');
      const { rows } = await db.query<{ id: number; createdAt: Date }>(
        'INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, created_at AS "createdAt"',
        [id, user.id, input.body],
      );
      await recordEvent(db, { itemId: id, actorId: user.id, type: 'COMMENT_ADDED', commentId: rows[0].id });
      return { id: rows[0].id, itemId: id, body: input.body, author: { id: user.id, name: user.name }, createdAt: rows[0].createdAt };
    });
    res.status(201).json(comment);
  }),
);
