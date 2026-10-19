import type { PoolClient } from 'pg';
import { hashPassword } from './auth';
import { pool, withTx } from './db';
import { recordEvent } from './itemData';
import { ITEM_TYPES, STATUSES, type ItemType, type Priority, type Status } from './workflow';

/** Every demo account uses this password (documented in the README). Hashed before storing. */
export const DEMO_PASSWORD = 'Demo#Pass123';

const USERS = [
  { key: 'alice', name: 'Alice Admin', email: 'alice.admin@demo.test' },
  { key: 'lena', name: 'Lena Lead', email: 'lena.lead@demo.test' },
  { key: 'mark', name: 'Mark Member', email: 'mark.member@demo.test' },
  { key: 'mia', name: 'Mia Member', email: 'mia.member@demo.test' },
  { key: 'victor', name: 'Victor Viewer', email: 'victor.viewer@demo.test' },
  { key: 'sara', name: 'Sara Support-Lead', email: 'sara.support@demo.test' },
  { key: 'noah', name: 'Noah Member', email: 'noah.member@demo.test' },
  { key: 'carlos', name: 'Carlos Compliance-Admin', email: 'carlos.compliance@demo.test' },
] as const;
type UserKey = (typeof USERS)[number]['key'];

const TEAMS = ['Payments Ops', 'Customer Support', 'Compliance'] as const;
type TeamName = (typeof TEAMS)[number];

const MEMBERSHIPS: [UserKey, TeamName, 'VIEWER' | 'MEMBER' | 'LEAD' | 'ADMIN'][] = [
  ['alice', 'Payments Ops', 'ADMIN'],
  ['lena', 'Payments Ops', 'LEAD'],
  ['mark', 'Payments Ops', 'MEMBER'],
  ['mia', 'Payments Ops', 'MEMBER'],
  ['victor', 'Payments Ops', 'VIEWER'],
  ['lena', 'Compliance', 'VIEWER'],
  ['sara', 'Customer Support', 'LEAD'],
  ['mark', 'Customer Support', 'MEMBER'],
  ['noah', 'Customer Support', 'MEMBER'],
  ['carlos', 'Compliance', 'ADMIN'],
  ['noah', 'Compliance', 'MEMBER'],
];

/** Who approves work in each team (used to write realistic history for resolved items). */
const TEAM_LEAD: Record<TeamName, UserKey> = { 'Payments Ops': 'lena', 'Customer Support': 'sara', Compliance: 'carlos' };

interface SeedItem {
  team: TeamName;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: Status;
  assignee: UserKey | null;
  creator: UserKey;
  dueInDays: number | null;
}

const ITEMS: SeedItem[] = [
  // Payments Ops
  { team: 'Payments Ops', title: 'Card settlement file missing for EU acquirer', description: 'The 02:00 UTC settlement file from the EU acquirer did not arrive. Merchant payouts due today are blocked.', type: 'INCIDENT', priority: 'URGENT', status: 'OPEN', assignee: null, creator: 'lena', dueInDays: 0 },
  { team: 'Payments Ops', title: 'Duplicate charge reported on order #48213', description: 'Customer charged twice within 40 seconds. Check for a retry without idempotency key in the checkout worker.', type: 'PAYMENT', priority: 'URGENT', status: 'OPEN', assignee: null, creator: 'mark', dueInDays: 1 },
  { team: 'Payments Ops', title: 'Refund batch stuck in PENDING for 3 hours', description: 'Refund batch RB-2291 (212 refunds) has not been picked up by the payout scheduler.', type: 'PAYMENT', priority: 'HIGH', status: 'IN_PROGRESS', assignee: 'mark', creator: 'lena', dueInDays: 1 },
  { team: 'Payments Ops', title: 'Reconcile September chargebacks with bank report', description: 'Match 37 chargebacks against the bank dispute report and flag mismatches over 5.00.', type: 'TASK', priority: 'MEDIUM', status: 'IN_PROGRESS', assignee: 'mia', creator: 'lena', dueInDays: 5 },
  { team: 'Payments Ops', title: 'Rotate payment-gateway API credentials', description: 'Quarterly credential rotation for the primary gateway. Needs lead approval before the old key is revoked.', type: 'TASK', priority: 'HIGH', status: 'AWAITING_APPROVAL', assignee: 'mark', creator: 'alice', dueInDays: 2 },
  { team: 'Payments Ops', title: 'Fix rounding error in multi-currency fee report', description: 'JPY fees are rounded half-up instead of half-even, causing 0.01 drifts in the monthly report.', type: 'INCIDENT', priority: 'MEDIUM', status: 'AWAITING_APPROVAL', assignee: 'mia', creator: 'mark', dueInDays: 3 },
  { team: 'Payments Ops', title: 'Document manual payout override procedure', description: 'Write the runbook for overriding a failed payout, including approval requirements.', type: 'TASK', priority: 'LOW', status: 'RESOLVED', assignee: 'mia', creator: 'lena', dueInDays: null },
  { team: 'Payments Ops', title: 'Investigate latency spike on /authorize', description: 'p99 doubled between 14:00 and 14:20 UTC. Root cause was a slow DNS resolver; resolved with a TTL change.', type: 'INCIDENT', priority: 'HIGH', status: 'CLOSED', assignee: 'mark', creator: 'lena', dueInDays: null },
  { team: 'Payments Ops', title: 'Add alert for payout failures above 2%', description: 'Create a monitoring alert when hourly payout failure rate exceeds 2%.', type: 'TASK', priority: 'MEDIUM', status: 'OPEN', assignee: null, creator: 'alice', dueInDays: 7 },
  { team: 'Payments Ops', title: 'Wire transfer flagged by velocity rule', description: 'Transfer of 48,000 to a new beneficiary was held by the velocity rule. Needs manual review.', type: 'PAYMENT', priority: 'URGENT', status: 'IN_PROGRESS', assignee: 'mia', creator: 'mark', dueInDays: 0 },
  // Customer Support
  { team: 'Customer Support', title: 'Enterprise customer locked out after SSO change', description: 'Acme Corp admins cannot sign in since their IdP certificate rotated. 300 seats affected.', type: 'CUSTOMER_ISSUE', priority: 'URGENT', status: 'OPEN', assignee: null, creator: 'sara', dueInDays: 0 },
  { team: 'Customer Support', title: 'Customer cannot download March invoice PDF', description: 'Invoice download returns a blank page for one account. Reproduced on Chrome and Safari.', type: 'CUSTOMER_ISSUE', priority: 'MEDIUM', status: 'IN_PROGRESS', assignee: 'noah', creator: 'sara', dueInDays: 2 },
  { team: 'Customer Support', title: 'Refund request escalated by social media', description: 'Customer is asking for an out-of-policy refund publicly. Needs a lead decision on goodwill credit.', type: 'CUSTOMER_ISSUE', priority: 'HIGH', status: 'AWAITING_APPROVAL', assignee: 'mark', creator: 'noah', dueInDays: 1 },
  { team: 'Customer Support', title: 'Update macro for delayed shipment responses', description: 'The delayed-shipment macro still quotes the old 5-day SLA. Update to 7 days.', type: 'TASK', priority: 'LOW', status: 'OPEN', assignee: null, creator: 'sara', dueInDays: 10 },
  { team: 'Customer Support', title: 'Chat widget not loading on mobile Safari', description: 'Multiple reports since the last release. The widget script fails with a CSP error.', type: 'INCIDENT', priority: 'HIGH', status: 'OPEN', assignee: null, creator: 'noah', dueInDays: 2 },
  { team: 'Customer Support', title: 'Backlog review: tickets older than 14 days', description: 'Triage and close or escalate every ticket older than 14 days.', type: 'TASK', priority: 'MEDIUM', status: 'RESOLVED', assignee: 'noah', creator: 'sara', dueInDays: null },
  { team: 'Customer Support', title: 'Customer data export request (GDPR)', description: 'Verified data subject access request received. 30-day clock started on arrival.', type: 'COMPLIANCE', priority: 'HIGH', status: 'IN_PROGRESS', assignee: 'sara', creator: 'sara', dueInDays: 20 },
  // Compliance
  { team: 'Compliance', title: 'Quarterly AML transaction sample review', description: 'Review the 150-transaction sample drawn for Q3 and record findings.', type: 'COMPLIANCE', priority: 'HIGH', status: 'IN_PROGRESS', assignee: 'noah', creator: 'carlos', dueInDays: 6 },
  { team: 'Compliance', title: 'Sanctions list update not applied to screening', description: 'Latest sanctions list version has not been loaded into the screening service.', type: 'INCIDENT', priority: 'URGENT', status: 'OPEN', assignee: null, creator: 'carlos', dueInDays: 0 },
  { team: 'Compliance', title: 'Annual PCI-DSS evidence collection', description: 'Collect and file evidence for requirements 3, 8 and 10.', type: 'COMPLIANCE', priority: 'MEDIUM', status: 'OPEN', assignee: null, creator: 'carlos', dueInDays: 30 },
  { team: 'Compliance', title: 'Retention policy exception for legacy archive', description: 'Request to keep a legacy archive past the 7-year limit. Needs sign-off from compliance lead.', type: 'COMPLIANCE', priority: 'LOW', status: 'AWAITING_APPROVAL', assignee: 'noah', creator: 'noah', dueInDays: 14 },
];

/** Status path an item walks to reach its target status (used to write a believable history). */
const PATH: Status[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];

async function insertItem(db: PoolClient, s: SeedItem, ids: { user: Record<UserKey, string>; team: Record<TeamName, string> }) {
  const steps = PATH.slice(1, PATH.indexOf(s.status) + 1);
  const version = 1 + (s.assignee ? 1 : 0) + steps.length;
  const due = s.dueInDays === null ? null : new Date(Date.now() + s.dueInDays * 86_400_000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO work_items (title, description, type, priority, status, team_id, assignee_id, created_by_id, due_date, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [s.title, s.description, s.type, s.priority, s.status, ids.team[s.team], s.assignee ? ids.user[s.assignee] : null, ids.user[s.creator], due, version],
  );
  const itemId = rows[0].id;
  const base = { itemId };
  await recordEvent(db, { ...base, actorId: ids.user[s.creator], type: 'CREATED' });
  if (s.assignee) {
    await recordEvent(db, { ...base, actorId: ids.user[s.assignee], type: 'ASSIGNEE_CHANGED', field: 'assignee', fromValue: null, toValue: ids.user[s.assignee] });
  }
  let prev: Status = 'OPEN';
  for (const step of steps) {
    // Submitting work is done by the assignee; approval, closing and reopening by the team lead.
    const actor = step === 'IN_PROGRESS' || step === 'AWAITING_APPROVAL' ? (s.assignee ?? s.creator) : TEAM_LEAD[s.team];
    await recordEvent(db, { ...base, actorId: ids.user[actor], type: 'STATUS_CHANGED', field: 'status', fromValue: prev, toValue: step });
    prev = step;
  }
  return itemId;
}

export async function seed(opts: { reset: boolean }) {
  const existing = await pool.query('SELECT count(*)::int AS n FROM users');
  if (existing.rows[0].n > 0 && !opts.reset) {
    console.log('Database already has data; nothing seeded. Re-run with --reset to wipe and reseed (destructive).');
    return false;
  }
  const passwordHashes = await Promise.all(USERS.map(() => hashPassword(DEMO_PASSWORD)));

  await withTx(async (db) => {
    if (opts.reset) {
      await db.query(
        'TRUNCATE activity_events, comments, idempotency_keys, work_items, memberships, teams, users RESTART IDENTITY CASCADE',
      );
    }
    const user = {} as Record<UserKey, string>;
    for (const [i, u] of USERS.entries()) {
      const r = await db.query<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [u.email, u.name, passwordHashes[i]]);
      user[u.key] = r.rows[0].id;
    }
    const team = {} as Record<TeamName, string>;
    for (const name of TEAMS) {
      team[name] = (await db.query<{ id: string }>('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    }
    for (const [u, t, role] of MEMBERSHIPS) {
      await db.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)', [user[u], team[t], role]);
    }
    const ids = { user, team };
    const itemIds: string[] = [];
    for (const item of ITEMS) itemIds.push(await insertItem(db, item, ids));

    // A few comments, each with its activity event (same shape the API writes).
    const comments: [number, UserKey, string][] = [
      [0, 'mark', 'Acquirer support confirmed the file is delayed on their side. ETA unknown; asking for a manual resend.'],
      [2, 'lena', 'Scheduler logs show a lock timeout at 09:12. Please check the batch table for orphaned locks.'],
      [4, 'lena', 'Approving once the old key is confirmed unused in the last 24h logs.'],
      [10, 'sara', 'Customer success is already on a call with their IT admin. Please prioritise.'],
      [18, 'carlos', 'Vendor says the list publishes at 06:00 UTC. We should automate the pull.'],
    ];
    for (const [idx, who, body] of comments) {
      const c = await db.query<{ id: number }>('INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [itemIds[idx], user[who], body]);
      await recordEvent(db, { itemId: itemIds[idx], actorId: user[who], type: 'COMMENT_ADDED', commentId: c.rows[0].id });
    }
  });
  console.log(`Seeded ${USERS.length} users, ${TEAMS.length} teams, ${ITEMS.length} work items.`);
  return true;
}

// Referenced so the type lists stay in sync with the workflow definitions.
void [ITEM_TYPES, STATUSES];

if (require.main === module) {
  seed({ reset: process.argv.includes('--reset') })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
