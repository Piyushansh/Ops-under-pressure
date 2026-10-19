# 5-minute demo script
Password for all accounts: `Demo#Pass123`. Use two browser windows (one private) to show two users.

1. **Login (30s)** — sign in as `mark.member@demo.test` (MEMBER). Wrong password shows an inline error. Dashboard shows Assigned to me / Unassigned urgent / Awaiting my approval (empty: Mark is not a lead).
2. **Create (45s)** — Items → New item (Payments Ops, type PAYMENT, priority URGENT). It appears in "Unassigned urgent". Double-submitting the form reuses one `Idempotency-Key`, so no duplicate.
3. **Claim race (60s)** — in window 2 sign in as `mia.member@demo.test`; both open the same unassigned item. Click Claim in both: one succeeds, the other gets a "Conflict" banner (409) and the page reloads.
4. **Stale edit (30s)** — both open the same item; save an edit in window 1, then in window 2 (409, newer data kept).
5. **Workflow + approval (60s)** — assignee clicks "Move to Awaiting approval". As Mark, no Approve button exists. Sign in as `lena.lead@demo.test`: dashboard shows it under "Awaiting my approval"; click Approve → Resolved.
6. **Activity (20s)** — the item's Activity panel lists every change with actor and time, plus comments.
7. **Authorization (45s)** — `victor.viewer@demo.test` can read but sees no action buttons. `sara.support@demo.test` (Customer Support) cannot open Payments Ops items (404). Show with curl: `curl -i localhost:4000/api/items/<id>` without a token → 401.

## Where to look in the code
- Atomic claim: `backend/src/routes/items.ts` (`/:id/claim`)
- Version check: same file (`PATCH /:id`, `/transition`)
- Idempotency: same file (`POST /`) and `migrations/001_init.sql`
- Permissions: `backend/src/authz.ts`; workflow: `backend/src/workflow.ts`
- Append-only trigger and indexes: `backend/migrations/001_init.sql`
- Race tests: `backend/tests/critical.test.ts` ("deterministic races")
