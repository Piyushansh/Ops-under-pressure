-- Initial schema. Applied by src/migrate.ts (each file runs in one transaction).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-team role: one user can hold different roles in different teams.
CREATE TABLE memberships (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('VIEWER', 'MEMBER', 'LEAD', 'ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX memberships_team_idx ON memberships (team_id);

CREATE TABLE work_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         varchar(200) NOT NULL CHECK (length(btrim(title)) > 0),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  type          text NOT NULL CHECK (type IN ('INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK')),
  priority      text NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED')),
  team_id       uuid NOT NULL REFERENCES teams(id),
  assignee_id   uuid REFERENCES users(id),
  created_by_id uuid NOT NULL REFERENCES users(id),
  due_date      timestamptz,
  -- Optimistic concurrency token, incremented by every successful change.
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Default list order is (created_at DESC, id DESC): immutable keys, so pages never shift
-- when an item is edited, and the id tiebreaker makes the order total/deterministic.
CREATE INDEX work_items_team_created_idx  ON work_items (team_id, created_at DESC, id DESC);
CREATE INDEX work_items_team_status_prio_idx ON work_items (team_id, status, priority);
CREATE INDEX work_items_assignee_status_idx ON work_items (assignee_id, status);
-- Dashboard: "Unassigned urgent" and "Awaiting approval" are small hot subsets.
CREATE INDEX work_items_unassigned_urgent_idx ON work_items (team_id, created_at DESC, id DESC)
  WHERE assignee_id IS NULL AND priority = 'URGENT' AND status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX work_items_awaiting_approval_idx ON work_items (team_id, created_at DESC, id DESC)
  WHERE status = 'AWAITING_APPROVAL';
-- Case-insensitive substring search (ILIKE '%q%') can use trigram GIN indexes.
CREATE INDEX work_items_title_trgm_idx ON work_items USING gin (title gin_trgm_ops);
CREATE INDEX work_items_description_trgm_idx ON work_items USING gin (description gin_trgm_ops);

CREATE TABLE comments (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES work_items(id),
  author_id  uuid NOT NULL REFERENCES users(id),
  body       varchar(5000) NOT NULL CHECK (length(btrim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_item_idx ON comments (item_id, id);

-- Append-only audit trail. The identity column gives a strict insertion order even for
-- several events written in the same transaction (now() would be identical for them).
CREATE TABLE activity_events (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES work_items(id),
  actor_id   uuid NOT NULL REFERENCES users(id),
  type       text NOT NULL CHECK (type IN
             ('CREATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNEE_CHANGED', 'FIELDS_UPDATED', 'COMMENT_ADDED')),
  field      text,
  from_value text,
  to_value   text,
  comment_id integer REFERENCES comments(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_events_item_idx ON activity_events (item_id, id);

CREATE FUNCTION activity_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_events_no_update_delete
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION activity_events_append_only();

-- Durable idempotency records for POST /api/items. The UNIQUE constraint is what makes
-- concurrent retries with the same key safe: the second INSERT waits, then fails.
CREATE TABLE idempotency_keys (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           varchar(255) NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  request_hash  text NOT NULL,
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_user_key UNIQUE (user_id, key)
);
