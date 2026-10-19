export const STATUSES = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const ITEM_TYPES = ['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK'] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type ItemType = (typeof ITEM_TYPES)[number];
export type Role = 'VIEWER' | 'MEMBER' | 'LEAD' | 'ADMIN';

export interface User { id: string; email: string; name: string }
export interface Membership { teamId: string; teamName: string; role: Role }

export interface Item {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: Status;
  teamId: string;
  assigneeId: string | null;
  createdById: string;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  team: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
  access?: {
    role: Role;
    canEdit: boolean;
    canAssign: boolean;
    canClaim: boolean;
    canComment: boolean;
    transitions: Status[];
  };
}

export interface Team {
  id: string;
  name: string;
  myRole: Role;
  members: { id: string; name: string; email: string; role: Role }[];
}

export interface Paged<T> { data: T[]; page: number; pageSize: number; total: number; totalPages: number }

export interface Section { count: number; items: Item[] }
export interface DashboardSummary { assignedToMe: Section; unassignedUrgent: Section; awaitingMyApproval: Section }

export interface ActivityEvent {
  id: number;
  type: 'CREATED' | 'STATUS_CHANGED' | 'PRIORITY_CHANGED' | 'ASSIGNEE_CHANGED' | 'FIELDS_UPDATED' | 'COMMENT_ADDED';
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
  actorId: string;
  actorName: string;
  commentBody: string | null;
  fromLabel: string | null;
  toLabel: string | null;
}
