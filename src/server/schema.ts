// Idempotent schema. folie-server is the only process that ever runs this.
import type { Database } from "./db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  name       text PRIMARY KEY,
  state      text NOT NULL DEFAULT 'pending',
  wake_epoch int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Added after the first release, so an ALTER keeps existing databases (and their agents) intact.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_active_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS work_items (
  id         serial PRIMARY KEY,
  goal       text NOT NULL,
  state      text NOT NULL DEFAULT 'queued'
             CHECK (state IN ('queued','assigned','blocked','done','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id           serial PRIMARY KEY,
  sender       text NOT NULL,
  recipient    text NOT NULL REFERENCES agents(name),
  body         text NOT NULL,
  work_item_id int  REFERENCES work_items(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  acked_at     timestamptz
);
CREATE INDEX IF NOT EXISTS messages_unacked ON messages (recipient, id) WHERE acked_at IS NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS topic text;
CREATE TABLE IF NOT EXISTS topic_subscriptions (
  topic      text NOT NULL,
  agent      text NOT NULL REFERENCES agents(name),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic, agent)
);
CREATE TABLE IF NOT EXISTS sessions (
  id          serial PRIMARY KEY,
  agent       text NOT NULL REFERENCES agents(name),
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL DEFAULT now(),
  message_ids int[] NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id         serial PRIMARY KEY,
  session_id int  NOT NULL REFERENCES sessions(id),
  outcome    text NOT NULL CHECK (outcome IN ('done','failed')),
  summary    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

// Arbitrary constant: "folie" in ASCII. Old and new server pods overlap during a rollout and
// CREATE TABLE IF NOT EXISTS is not race-free, so migrations take a transaction-scoped lock.
const MIGRATION_LOCK = 0x666f6c6965;

export function migrate(db: Database): Promise<void> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.query(SCHEMA);
  });
}
