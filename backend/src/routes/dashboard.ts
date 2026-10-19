import { Router } from 'express';
import { h } from '../auth';
import { roleAtLeast, Role } from '../authz';
import { pool } from '../db';
import { ITEM_SELECT, mapItem } from '../itemData';

export const dashboardRouter = Router();

async function section(where: string, params: unknown[]) {
  const [count, rows] = await Promise.all([
    pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM work_items i WHERE ${where}`, params),
    pool.query(`${ITEM_SELECT} WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT 10`, params),
  ]);
  return { count: count.rows[0].n, items: rows.rows.map(mapItem) };
}

dashboardRouter.get(
  '/summary',
  h(async (req, res) => {
    const user = req.user!;
    const { rows } = await pool.query<{ team_id: string; role: Role }>(
      'SELECT team_id, role FROM memberships WHERE user_id = $1',
      [user.id],
    );
    const teamIds = rows.map((m) => m.team_id);
    const leadTeamIds = rows.filter((m) => roleAtLeast(m.role, 'LEAD')).map((m) => m.team_id);

    const [assignedToMe, unassignedUrgent, awaitingMyApproval] = await Promise.all([
      section(`i.assignee_id = $1 AND i.team_id = ANY($2::uuid[]) AND i.status IN ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL')`, [user.id, teamIds]),
      section(`i.assignee_id IS NULL AND i.priority = 'URGENT' AND i.status IN ('OPEN', 'IN_PROGRESS') AND i.team_id = ANY($1::uuid[])`, [teamIds]),
      section(`i.status = 'AWAITING_APPROVAL' AND i.team_id = ANY($1::uuid[])`, [leadTeamIds]),
    ]);
    res.json({ assignedToMe, unassignedUrgent, awaitingMyApproval });
  }),
);
