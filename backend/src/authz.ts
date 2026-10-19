import type { Db } from './db';
import { forbidden, notFound } from './errors';

export const ROLES = ['VIEWER', 'MEMBER', 'LEAD', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Central permission table: the lowest per-team role that may perform each action.
 * Roles are cumulative (ADMIN > LEAD > MEMBER > VIEWER).
 *   ADMIN adds: team:manage (change team memberships/roles).
 * Workflow transitions carry their own minimum role in workflow.ts (approval needs LEAD).
 */
const MIN_ROLE = {
  'item:read': 'VIEWER',
  'item:create': 'MEMBER',
  'item:edit': 'MEMBER',
  'item:claim': 'MEMBER',
  'item:comment': 'MEMBER',
  'item:transition': 'MEMBER',
  'item:assign': 'LEAD', // assign/reassign/unassign someone else
  'team:manage': 'ADMIN',
} as const satisfies Record<string, Role>;

export type Action = keyof typeof MIN_ROLE;

const rank = (r: Role) => ROLES.indexOf(r);
export const roleAtLeast = (role: Role, min: Role) => rank(role) >= rank(min);
export const roleCan = (role: Role, action: Action) => roleAtLeast(role, MIN_ROLE[action]);

export async function getTeamRole(db: Db, userId: string, teamId: string): Promise<Role | null> {
  const { rows } = await db.query<{ role: Role }>('SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2', [
    userId,
    teamId,
  ]);
  return rows[0]?.role ?? null;
}

/**
 * Resource-level check used by every item route.
 * - Not a member of the item's team -> 404, so other teams' item ids are not revealed.
 * - Member without a sufficient role -> 403.
 */
export async function requireItemAccess(db: Db, userId: string, teamId: string, action: Action): Promise<Role> {
  const role = await getTeamRole(db, userId, teamId);
  if (!role) throw notFound('Work item not found');
  if (!roleCan(role, action)) throw forbidden(`Your role (${role}) cannot perform ${action}`);
  return role;
}

/** Team-level check where the caller named the team explicitly (create item, team admin). */
export async function requireTeamAccess(db: Db, userId: string, teamId: string, action: Action): Promise<Role> {
  const role = await getTeamRole(db, userId, teamId);
  if (!role) throw forbidden('You are not a member of this team');
  if (!roleCan(role, action)) throw forbidden(`Your role (${role}) cannot perform ${action}`);
  return role;
}
