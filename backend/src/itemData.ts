import type { Db } from './db';
import type { ItemType, Priority, Status } from './workflow';

/** One shared SELECT so list, detail and dashboard always return the same item shape. */
export const ITEM_SELECT = `
  SELECT i.id, i.title, i.description, i.type, i.priority, i.status,
         i.team_id AS "teamId", i.assignee_id AS "assigneeId", i.created_by_id AS "createdById",
         i.due_date AS "dueDate", i.version, i.created_at AS "createdAt", i.updated_at AS "updatedAt",
         t.name AS "teamName", a.name AS "assigneeName", c.name AS "creatorName"
  FROM work_items i
  JOIN teams t ON t.id = i.team_id
  LEFT JOIN users a ON a.id = i.assignee_id
  JOIN users c ON c.id = i.created_by_id`;

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: Status;
  teamId: string;
  assigneeId: string | null;
  createdById: string;
  dueDate: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  team: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapItem(r: any): WorkItem {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    type: r.type,
    priority: r.priority,
    status: r.status,
    teamId: r.teamId,
    assigneeId: r.assigneeId,
    createdById: r.createdById,
    dueDate: r.dueDate,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    team: { id: r.teamId, name: r.teamName },
    assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName } : null,
    createdBy: { id: r.createdById, name: r.creatorName },
  };
}

export async function getItem(db: Db, id: string): Promise<WorkItem | null> {
  const { rows } = await db.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  return rows[0] ? mapItem(rows[0]) : null;
}

export interface NewEvent {
  itemId: string;
  actorId: string;
  type: 'CREATED' | 'STATUS_CHANGED' | 'PRIORITY_CHANGED' | 'ASSIGNEE_CHANGED' | 'FIELDS_UPDATED' | 'COMMENT_ADDED';
  field?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  commentId?: number | null;
}

/** Callers pass the transaction client, so the event commits or rolls back with the change. */
export async function recordEvent(db: Db, e: NewEvent): Promise<void> {
  await db.query(
    `INSERT INTO activity_events (item_id, actor_id, type, field, from_value, to_value, comment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.itemId, e.actorId, e.type, e.field ?? null, e.fromValue ?? null, e.toValue ?? null, e.commentId ?? null],
  );
}
