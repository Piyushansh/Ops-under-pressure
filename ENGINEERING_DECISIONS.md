# Engineering decisions

## Assumptions
- Roles are per team; a user may belong to several teams with different roles. Non-members get 404 for a team's items.
- Claiming moves an `OPEN` item to `IN_PROGRESS`; an unassigned `IN_PROGRESS` item can also be claimed (status unchanged).
- ADMIN is a superset of LEAD within its own team, and additionally manages memberships. There is no global super-admin.
- "Approval" = `AWAITING_APPROVAL → RESOLVED` by a LEAD/ADMIN of the item's team. Approvers may be the assignee or creator; four-eyes separation was not requested.
- **Stack deviation:** the brief's default was Prisma. Prisma's engine download was blocked (HTTP 403) in the build sandbox, so I used `pg` with plain SQL migrations. This also made the concurrency-critical statements explicit.

## 1. Data model and activity history
**Context:** every important change needs an auditable trail that cannot be silently altered or lost.
**Alternatives:** (a) a JSON "history" column on the item; (b) updating `updated_by`/diff columns; (c) a separate event table; (d) full event sourcing.
**Choice:** a separate `activity_events` table, written in the same transaction as the change, with a database trigger that rejects `UPDATE` and `DELETE`. Comments are their own table, and each comment also produces an event. Event ids come from an identity column, so ordering is exact even for several events in one transaction.
**Trade-offs:** append-only is enforced at the database level, not just by convention; a superuser can still drop the trigger. Events store old/new values as text, which is simple to read but not strongly typed. Not full event sourcing: current state lives on the item row.

## 2. Concurrency and atomic claiming
**Context:** two people must not both claim an item, and stale edits must not overwrite newer ones.
**Alternatives:** frontend checks only; `SELECT … FOR UPDATE` then update; serializable transactions; conditional `UPDATE`.
**Choice:** conditional single-statement updates. Claim: `UPDATE … WHERE id=$ AND assignee_id IS NULL AND status=$`; zero rows ⇒ 409. Edits/transitions: `… WHERE id=$ AND version=$` then `version = version + 1`; zero rows ⇒ 409 with the current version. The first check is a friendly early read; the `WHERE` clause is the real guard under races.
**Trade-offs:** clients must send `version` and handle 409 (the UI reloads the item after a conflict). Verified by tests that hold a row lock so all competitors are blocked on the same `UPDATE` before releasing it; removing a guard makes those tests fail.

## 3. Authorization
**Context:** permissions must be enforced server-side and be easy to audit.
**Alternatives:** per-route ad hoc checks; a policy library (CASL/Casbin); hide buttons in the UI.
**Choice:** a small central module (`authz.ts`) with a role-rank table and `requireItemAccess/requireTeamAccess`, called by every item route after loading the item (resource-level, not just "is logged in"). Transition rules (including the LEAD requirement for approval and "assignee only" rules) live in the one `workflow.ts` table. The API returns an `access` object so the UI shows only valid buttons; the server re-checks everything. Unknown or client-sent `status` in `PATCH` is rejected by a strict schema.
**Trade-offs:** roles are cumulative and coarse; no custom per-item ACLs. Non-members see 404 rather than 403 to avoid revealing which items exist, at the cost of slightly less explicit errors.

## 4. Idempotency and transactions
**Context:** network retries must not create duplicate items.
**Alternatives:** dedupe in application memory; a unique business key; a stored key checked before insert; key insert inside the creating transaction.
**Choice:** `idempotency_keys(user_id, key)` with a UNIQUE constraint. The key row is inserted first, inside the same transaction as the item and its CREATED event, and the response is stored on commit. A concurrent duplicate blocks on the unique index, then fails and replays the stored response (`Idempotent-Replayed: true`). Same key with a different body ⇒ 409. Keys are scoped per user. A failed create rolls back the key, so a corrected retry works.
**Trade-offs:** keys are never expired (a cleanup job would be the next step). The request hash covers the creation fields only.

## 5. Pagination, async processing, and deliberate omissions
**Pagination:** server-side, filtered in SQL, ordered by `(created_at DESC, id DESC)`, which is immutable and unique, so ordering is deterministic. Indexes: team+created, team+status+priority, assignee+status, partial indexes for the dashboard's hot subsets, and trigram GIN indexes for search. Offset paging was chosen for page-number UI; keyset paging would avoid skips under heavy inserts.
**Async processing:** **not implemented.** The brief says to document rather than fake it. Nothing in the MVP requires background work (no email/webhooks), and a half-working outbox would be worse than none. Next step: an `outbox` table written in the same transaction as events, a worker using `FOR UPDATE SKIP LOCKED`, attempt limits with backoff, and idempotent handlers.
**Omitted on purpose:** public sign-up, SSO, email, file uploads, websockets, refresh tokens, rate limiting, frontend tests.
