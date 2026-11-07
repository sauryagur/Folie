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
  paused     boolean NOT NULL DEFAULT false,
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
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
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
ALTER TABLE budget_reservations ADD COLUMN IF NOT EXISTS ref text;
CREATE INDEX IF NOT EXISTS budget_reservations_active ON budget_reservations (budget_id) WHERE state = 'active';
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
  claimed_at  timestamptz,
  submitted_at timestamptz,
  verified_at timestamptz,
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
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verified_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_leased ON messages (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_unleased ON messages (recipient, id) WHERE acked_at IS NULL AND session_id IS NULL;
-- Scoped memory (ADR 0008, R-4.1/4.2): immutable entries; ACL is enforced inside
-- MemoryRepo.query, never by callers. Identity columns are plain text with no FK
-- to agents, so retiring an execution cannot wipe memory (R-3.7).
CREATE TABLE IF NOT EXISTS memories (
  id             serial PRIMARY KEY,
  scope          text NOT NULL CHECK (scope IN ('agent','team','goal','swarm')),
  scope_id       text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('semantic','episodic','procedural','claim','handoff')),
  content        text NOT NULL,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance     jsonb NOT NULL DEFAULT '{}'::jsonb,
  origin_goal_id text,
  portable       boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','contested','superseded')),
  confidence     numeric NOT NULL DEFAULT 1,
  superseded_by  int REFERENCES memories(id),
  task_id        int,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope, scope_id, id DESC);
CREATE TABLE IF NOT EXISTS memory_links (
  from_id int NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id   int NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind    text NOT NULL CHECK (kind IN ('contradicts','corroborates','supersedes','derived_from')),
  PRIMARY KEY (from_id, to_id, kind)
);
-- Content-addressed artifacts (R-4.4): bytes live in PG bytea, outside any workspace,
-- with no FK to agents/executions, so termination or retirement cannot delete them.
-- (The volume/S3 adapter later replaces storage; sha256/ref stay unchanged.)
CREATE TABLE IF NOT EXISTS artifacts (
  id          serial PRIMARY KEY,
  sha256      text NOT NULL UNIQUE,
  ref         text NOT NULL UNIQUE,
  data        bytea NOT NULL,
  name        text NOT NULL DEFAULT '',
  media_type  text NOT NULL DEFAULT 'application/octet-stream',
  description text NOT NULL DEFAULT '',
  producer    text NOT NULL,
  goal_id     text,
  task_id     int,
  provenance  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_producer ON artifacts (producer, id);
-- Coordination: teams (R-9.5), capabilities (R-10), quotas/discovery/negotiation (R-9/R-8.9).
-- Contracts only: leader election, stall/loop detection beyond counters, live thread UI excluded.
CREATE TABLE IF NOT EXISTS teams (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  scope_kind    text NOT NULL CHECK (scope_kind IN ('goal','task')),
  scope_id      text NOT NULL,
  purpose       text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'forming' CHECK (status IN ('forming','active','dissolving','dissolved')),
  convener      text REFERENCES agents(name),
  budget_id     int REFERENCES budgets(id),
  min_members   int NOT NULL DEFAULT 1,
  charter       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  dissolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS teams_status ON teams (status, id);
CREATE INDEX IF NOT EXISTS teams_scope ON teams (scope_kind, scope_id, status);
CREATE TABLE IF NOT EXISTS team_members (
  team_id         int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent           text NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  label           text NOT NULL DEFAULT '',
  responsibilities text NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, agent)
);
CREATE INDEX IF NOT EXISTS team_members_agent ON team_members (agent);
CREATE TABLE IF NOT EXISTS capabilities (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  version     text NOT NULL DEFAULT '1',
  description text NOT NULL DEFAULT '',
  risk_class  text NOT NULL DEFAULT 'R0' CHECK (risk_class IN ('R0','R1','R2','R3','R4','R5','R6','R7')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_capabilities (
  id             serial PRIMARY KEY,
  agent          text NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  capability_id  int NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  level          text NOT NULL DEFAULT 'declared' CHECK (level IN ('declared','assessed','verified')),
  probe_result   jsonb,
  verifier       text REFERENCES agents(name),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent, capability_id)
);
CREATE INDEX IF NOT EXISTS agent_capabilities_agent ON agent_capabilities (agent);
CREATE INDEX IF NOT EXISTS agent_capabilities_cap ON agent_capabilities (capability_id, level);
CREATE TABLE IF NOT EXISTS coordination_proposals (
  id          serial PRIMARY KEY,
  goal_id     int NOT NULL,
  proposer    text NOT NULL REFERENCES agents(name),
  parent_id   int,
  depth       int NOT NULL DEFAULT 0,
  dedup_key   text,
  title       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_dedup ON coordination_proposals (goal_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposals_proposer ON coordination_proposals (proposer, created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_goal ON coordination_proposals (goal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_parent ON coordination_proposals (parent_id) WHERE parent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS negotiation_dissents (
  id          serial PRIMARY KEY,
  task_id     int NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  contributor text NOT NULL REFERENCES agents(name),
  note        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dissents_task ON negotiation_dissents (task_id, id);
-- Leader-election lease for the background loops (R-6.6): one row, holder + TTL expiry.
-- Only the holder runs dispatch/reconcile; replicas serve reads. Seeded idempotently here
-- (re-run on every migrate) so a fresh database starts leaderless.
CREATE TABLE IF NOT EXISTS leader_state (
  id         int PRIMARY KEY CHECK (id = 1),
  holder     text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO leader_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- Append-only event ledger (ADR 0004): one row per domain transition, written in the same
-- transaction as the state change it records. No FKs so migration order never matters.
CREATE TABLE IF NOT EXISTS events (
  id            serial PRIMARY KEY,
  type          text NOT NULL,
  aggregate     text NOT NULL,
  aggregate_id  text NOT NULL,
  actor         text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  causation_id  text,
  traceparent   text,
  tracestate    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_aggregate ON events (aggregate, aggregate_id, id);
CREATE INDEX IF NOT EXISTS events_id ON events (id);
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
