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
-- Added after the first releases: ALTERs keep existing databases (and their history) intact.
ALTER TABLE messages   ADD COLUMN IF NOT EXISTS request_id  text;
ALTER TABLE messages   ADD COLUMN IF NOT EXISTS traceparent text;
ALTER TABLE messages   ADD COLUMN IF NOT EXISTS tracestate  text;
-- At-most-once delivery: the same sender repeating a request id reaches the same recipient only once.
CREATE UNIQUE INDEX IF NOT EXISTS messages_request ON messages (sender, request_id, recipient) WHERE request_id IS NOT NULL;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS traceparent text;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS tracestate  text;
ALTER TABLE reports    ADD COLUMN IF NOT EXISTS prompt_tokens     int;
ALTER TABLE reports    ADD COLUMN IF NOT EXISTS completion_tokens int;
ALTER TABLE reports    ADD COLUMN IF NOT EXISTS cost_usd          double precision;
ALTER TABLE reports    ADD COLUMN IF NOT EXISTS tool_calls        int;
ALTER TABLE reports    ADD COLUMN IF NOT EXISTS tool_failures     int;
-- The session transcript, append-only. Written only by folie-server, on behalf of agents over HTTP.
CREATE TABLE IF NOT EXISTS session_events (
  id         serial PRIMARY KEY,
  agent      text NOT NULL,
  session_id text NOT NULL,
  scope      text NOT NULL,
  seq        int  NOT NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL,
  trace_id   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS session_events_scope ON session_events (agent, scope, id);

-- Authenticated principals: bearer tokens stored hashed, bound to an agent/execution generation or an operator.
-- Only the SHA-256 hash is persisted. Operator keys are configured via FOLIE_OPERATOR_TOKEN and compared
-- constant-time against the DB hash; agent tokens are minted per execution.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            serial PRIMARY KEY,
  principal     text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('agent','operator')),
  token_hash    text NOT NULL UNIQUE,
  agent_name    text,
  execution_id  text,
  generation    int  NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_agent ON api_tokens (agent_name) WHERE kind = 'agent';

-- Execution binding for agent tokens. A token is valid only while its execution row is 'running' or 'suspended'
-- and generations match the agent's credential generation. The controller owns these rows (no table yet in
-- the target Execution model in this slice: this is the minimal per-execution binding).
CREATE TABLE IF NOT EXISTS executions (
  id            text PRIMARY KEY,
  agent_name    text NOT NULL REFERENCES agents(name),
  state         text NOT NULL DEFAULT 'running' CHECK (state IN ('running','suspended','terminated','failed','lost')),
  generation    int  NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz
);
CREATE INDEX IF NOT EXISTS executions_agent ON executions (agent_name, created_at DESC);

-- Credential generations for agents: bumped on revocation/retire/delete/loss.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS credential_generation int NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE executions ADD COLUMN IF NOT EXISTS epoch int NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS provider_ref jsonb;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS generation int NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS executions_agent_state ON executions (agent_name, state);
-- Server-owned persisted sessions: a running row exists before any transcript event.
ALTER TABLE sessions ALTER COLUMN ended_at DROP DEFAULT;
ALTER TABLE sessions ALTER COLUMN ended_at DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'settled' CHECK (state IN ('running','settled','abandoned'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS work_item_id int REFERENCES work_items(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_request_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS public_id text;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions (public_id) WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_client_request ON sessions (agent, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_agent ON sessions (agent, id DESC);
CREATE TABLE IF NOT EXISTS budgets (
  id          serial PRIMARY KEY,
  parent_id   int REFERENCES budgets(id),
  name        text NOT NULL,
  dim         text NOT NULL CHECK (dim IN ('usd','tokens','tool_calls','compute_s','storage_b','tasks','executions')),
  limit_amount numeric NOT NULL,
  reserved    numeric NOT NULL DEFAULT 0,
  spent       numeric NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budgets_parent ON budgets (parent_id);
CREATE TABLE IF NOT EXISTS budget_reservations (
  id          serial PRIMARY KEY,
  budget_id   int NOT NULL REFERENCES budgets(id),
  amount      numeric NOT NULL,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active','released')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_records (
  id          serial PRIMARY KEY,
  budget_id   int NOT NULL REFERENCES budgets(id),
  amount      numeric NOT NULL,
  basis       text NOT NULL CHECK (basis IN ('estimated','measured','external_charge')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS control_signals (
  id          serial PRIMARY KEY,
  agent       text NOT NULL REFERENCES agents(name),
  type        text NOT NULL CHECK (type IN ('cancel','pause','stop','lease_lost')),
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS control_signals_agent ON control_signals (agent, id);
CREATE TABLE IF NOT EXISTS tasks (
  id          serial PRIMARY KEY,
  work_item_id int NOT NULL REFERENCES work_items(id),
  title       text NOT NULL,
  spec        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'available' CHECK (status IN ('proposed','accepted','available','claimed','running','blocked','submitted','completed','verified','failed','cancelled','superseded','rejected')),
  fence       bigint NOT NULL DEFAULT 0,
  owner       text REFERENCES agents(name),
  lease_expires_at timestamptz,
  attempt     int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verifications (
  id          serial PRIMARY KEY,
  task_id     int NOT NULL REFERENCES tasks(id),
  check_name  text NOT NULL,
  verifier    text NOT NULL REFERENCES agents(name),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed','errored')),
  required    boolean NOT NULL DEFAULT true,
  verdict     text CHECK (verdict IN ('pass','fail','inconclusive')),
  confidence  double precision,
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_available ON tasks (work_item_id, status, id) WHERE status IN ('proposed','available');
CREATE TABLE IF NOT EXISTS task_claims (
  id          serial PRIMARY KEY,
  task_id     int NOT NULL REFERENCES tasks(id),
  agent       text NOT NULL REFERENCES agents(name),
  role        text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','contributor','reviewer','verifier')),
  fence       bigint NOT NULL,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','released','expired','revoked','superseded')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  ended_at    timestamptz,
  end_reason  text
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active_owner ON task_claims (task_id) WHERE role = 'owner' AND state = 'active';
CREATE INDEX IF NOT EXISTS claims_task ON task_claims (task_id, state);
CREATE INDEX IF NOT EXISTS verifications_task ON verifications (task_id, status);
CREATE TABLE IF NOT EXISTS goal_evaluations (
  id          serial PRIMARY KEY,
  work_item_id int NOT NULL REFERENCES work_items(id),
  verdict     text NOT NULL CHECK (verdict IN ('achieved','partially','not_achieved','inconclusive')),
  caveats     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id int REFERENCES sessions(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS leased_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_leased ON messages (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_unleased ON messages (recipient, id) WHERE acked_at IS NULL AND session_id IS NULL;
-- (agents.state remains the execution view for compatibility; status is 'active' | 'retired' for token checks)
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
