# Ops Desk — "Operations Under Pressure" MVP

Internal work-management app for operational teams: incidents, customer issues, payments, compliance and tasks, with per-team roles, a server-enforced workflow, an approval step, and an append-only activity history.

## Features
- Login/logout (bcrypt + JWT); every `/api` route except login and health requires a valid token.
- Create, list, view, edit items; claim unassigned items; comments; activity history.
- Workflow with server-enforced transitions; only a LEAD (or ADMIN) of the item's team can approve `AWAITING_APPROVAL → RESOLVED`.
- Dashboard: Assigned to me, Unassigned urgent, Awaiting my approval.
- Server-side search, status/priority/assignee filters and pagination.
- Loading, empty, validation, permission (403), conflict (409) and server-error states in the UI.

## Architecture
```
frontend/  React + Vite + TypeScript (hash routing, no UI library)
backend/   Node + Express + TypeScript, raw SQL via `pg`, Zod validation
  src/authz.ts      central role/permission table + resource-level checks
  src/workflow.ts   the only definition of allowed status transitions
  src/routes/       auth, teams, items, dashboard
  migrations/       plain SQL, applied by src/migrate.ts
  tests/            Vitest + Supertest against a real PostgreSQL database
```
PostgreSQL holds all state. See `ENGINEERING_DECISIONS.md` for the reasoning.

## Prerequisites
Node 20+ (tested on 22), PostgreSQL 14+ (tested on 16; the `pg_trgm` extension must be available, it ships with the standard contrib package), optionally Docker.

## Run locally
```bash
npm run install:all
cp .env.example .env            # then edit DATABASE_URL, TEST_DATABASE_URL, JWT_SECRET
# create the two databases once, e.g.:
#   createdb ops_dev && createdb ops_test
npm run migrate                 # applies backend/migrations/*.sql
npm run seed                    # demo users/teams/items; no-op if data exists
npm run dev:api                 # API on http://localhost:4000
npm run dev:web                 # UI  on http://localhost:5173 (proxies /api)
```
`npm --prefix backend run seed -- --reset` wipes and reseeds (destructive, dev only).

## Run with Docker Compose
```bash
cp .env.example .env            # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build       # UI + API on http://localhost:4000
```
The container migrates, seeds only if the database is empty, then starts.

## Demo credentials
All demo accounts share the password `Demo#Pass123` (stored only as bcrypt hashes).

| Email | Role(s) |
|---|---|
| alice.admin@demo.test | ADMIN — Payments Ops |
| lena.lead@demo.test | LEAD — Payments Ops; VIEWER — Compliance |
| mark.member@demo.test | MEMBER — Payments Ops and Customer Support |
| mia.member@demo.test | MEMBER — Payments Ops |
| victor.viewer@demo.test | VIEWER — Payments Ops |
| sara.support@demo.test | LEAD — Customer Support |
| noah.member@demo.test | MEMBER — Customer Support and Compliance |
| carlos.compliance@demo.test | ADMIN — Compliance |

## Roles
VIEWER read only · MEMBER create/edit/comment/claim, submit own work for approval · LEAD also approve/reject/close/reopen, assign others · ADMIN also manage team memberships (`PUT /api/teams/:teamId/members/:userId`). Roles are per team.

Workflow: `OPEN → IN_PROGRESS → AWAITING_APPROVAL → RESOLVED → CLOSED`, plus LEAD-only `AWAITING_APPROVAL → IN_PROGRESS` (send back), `RESOLVED → IN_PROGRESS` (reopen), `IN_PROGRESS → OPEN`.

## API overview
All errors: `{ "error": { "code", "message", "details?" } }` with 400/401/403/404/409.

| Method | Path | Notes |
|---|---|---|
| POST | /api/auth/login | `{email,password}` → `{token,user}` |
| GET | /api/auth/me | user + memberships |
| GET | /api/teams | my teams and members |
| GET | /api/items | `q,status,priority,type,teamId,assigneeId(me/unassigned/uuid),page,pageSize` |
| POST | /api/items | optional `Idempotency-Key` header |
| GET/PATCH | /api/items/:id | PATCH requires `version` |
| POST | /api/items/:id/claim | atomic; 409 if taken |
| POST | /api/items/:id/transition | `{to, version}` |
| GET | /api/items/:id/activity | newest first |
| POST | /api/items/:id/comments | `{body}` |
| GET | /api/dashboard/summary | three sections |
| GET | /api/health | public |

A non-member gets **404** for another team's item (its existence is not revealed); a member lacking the role gets **403**.

## Tests
```bash
npm test      # = npm --prefix backend test; needs TEST_DATABASE_URL (name must contain "test")
npm run build # backend tsc + frontend typecheck and production build
```
The suite truncates the test database; it refuses to run against a database whose name lacks "test".

## Known limitations
- No background job/outbox worker (deliberately omitted, see decisions).
- No refresh tokens or logout revocation: logout discards the token client-side; tokens expire after `JWT_EXPIRES_IN`.
- No rate limiting or account lockout on login.
- Token kept in `localStorage` (XSS-exposed); httpOnly cookies + CSRF protection would be stronger.
- Activity history shows the newest 500 events; no comment edit/delete.
- Substring search uses `ILIKE` with trigram indexes, not ranked full-text search.
- No frontend automated tests; the UI was only build-checked and API-smoke-tested, not exercised in a browser.
- Docker files were written but not built or run in the development sandbox (no Docker daemon).
- Offset pagination can skip or repeat rows if items are created during paging.

## Publishing to GitHub
```bash
git init && git add -A
git status            # confirm .env and node_modules are NOT listed
git commit -m "Ops Desk MVP"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
