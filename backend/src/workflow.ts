import type { Role } from './authz';

export const STATUSES = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const ITEM_TYPES = ['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface TransitionRule {
  from: Status;
  to: Status;
  /** Lowest team role allowed to perform this transition. */
  minRole: Role;
  /** A MEMBER may only do this on items assigned to them (LEAD and ADMIN are exempt). */
  assigneeOnlyForMember?: boolean;
  /** The item must already have an assignee. */
  requiresAssignee?: boolean;
}

/**
 * The ONLY place workflow rules are defined. Anything not listed here is rejected, and the
 * server never trusts a status sent by the client except as the requested target.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'OPEN', to: 'IN_PROGRESS', minRole: 'MEMBER', assigneeOnlyForMember: true, requiresAssignee: true },
  { from: 'IN_PROGRESS', to: 'AWAITING_APPROVAL', minRole: 'MEMBER', assigneeOnlyForMember: true },
  { from: 'IN_PROGRESS', to: 'OPEN', minRole: 'LEAD' },
  { from: 'AWAITING_APPROVAL', to: 'RESOLVED', minRole: 'LEAD' }, // approval
  { from: 'AWAITING_APPROVAL', to: 'IN_PROGRESS', minRole: 'LEAD' }, // rejection
  { from: 'RESOLVED', to: 'CLOSED', minRole: 'LEAD' },
  { from: 'RESOLVED', to: 'IN_PROGRESS', minRole: 'LEAD' }, // reopen
];

export const findTransition = (from: Status, to: Status) => TRANSITIONS.find((t) => t.from === from && t.to === to);
export const allowedTargets = (from: Status) => TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
