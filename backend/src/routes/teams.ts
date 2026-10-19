import { Router } from 'express';
import { z } from 'zod';
import { h } from '../auth';
import { requireTeamAccess, ROLES } from '../authz';
import { pool } from '../db';
import { badRequest, notFound } from '../errors';

export const teamsRouter = Router();

teamsRouter.get(
  '/',
  h(async (req, res) => {
    const user = req.user!;
    const { rows: teams } = await pool.query<{ id: string; name: string; role: string }>(
      `SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = $1 ORDER BY t.name`,
      [user.id],
    );
    const { rows: members } = await pool.query<{ teamId: string; id: string; name: string; email: string; role: string }>(
      `SELECT m.team_id AS "teamId", u.id, u.name, u.email, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ANY($1::uuid[]) ORDER BY u.name`,
      [teams.map((t) => t.id)],
    );
    res.json({
      data: teams.map((t) => ({
        id: t.id,
        name: t.name,
        myRole: t.role,
        members: members.filter((m) => m.teamId === t.id).map(({ teamId: _t, ...m }) => m),
      })),
    });
  }),
);

const paramsSchema = z.object({ teamId: z.string().uuid(), userId: z.string().uuid() });
const roleSchema = z.object({ role: z.enum(ROLES) }).strict();

// Team management (ADMIN only): add a user to the team or change their role.
teamsRouter.put(
  '/:teamId/members/:userId',
  h(async (req, res) => {
    const actor = req.user!;
    const { teamId, userId } = paramsSchema.parse(req.params);
    const { role } = roleSchema.parse(req.body);
    await requireTeamAccess(pool, actor.id, teamId, 'team:manage');
    if (userId === actor.id) throw badRequest('CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role');
    const target = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!target.rowCount) throw notFound('User not found');
    await pool.query(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
      [userId, teamId, role],
    );
    res.json({ teamId, userId, role });
  }),
);
