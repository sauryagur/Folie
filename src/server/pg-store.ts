import type { AgentInfo, Message, Report, WorkItem, WorkItemState } from "../shared/types";
import type { Database, Queryable, Row } from "./db";
import type { AgentRepo, MessageRepo, Repos, ReportRepo, Store, WorkItemRepo } from "./store";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

const toMessage = (r: Row): Message => ({
  id: r.id as number,
  from: r.sender as string,
  to: r.recipient as string,
  body: r.body as string,
  workItemId: (r.work_item_id as number | null) ?? null,
  createdAt: iso(r.created_at),
  ackedAt: r.acked_at ? iso(r.acked_at) : null,
});

const toWorkItem = (r: Row): WorkItem => ({
  id: r.id as number,
  goal: r.goal as string,
  state: r.state as WorkItemState,
  createdAt: iso(r.created_at),
});

const toReport = (r: Row): Report => ({
  id: r.id as number,
  agent: r.agent as string,
  outcome: r.outcome as Report["outcome"],
  summary: r.summary as string,
  messageIds: r.message_ids as number[],
  createdAt: iso(r.created_at),
});

const MESSAGE_COLS = "id, sender, recipient, body, work_item_id, created_at, acked_at";

const messages = (q: Queryable): MessageRepo => ({
  async send({ from, to, body, workItemId }) {
    const { rows } = await q.query(
      `INSERT INTO messages (sender, recipient, body, work_item_id) VALUES ($1,$2,$3,$4) RETURNING ${MESSAGE_COLS}`,
      [from, to, body, workItemId ?? null],
    );
    return toMessage(rows[0]!);
  },
  async unacked(to) {
    const { rows } = await q.query(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE recipient = $1 AND acked_at IS NULL ORDER BY id`,
      [to],
    );
    return rows.map(toMessage);
  },
  async ack(to, ids) {
    const { rows } = await q.query(
      `UPDATE messages SET acked_at = now()
       WHERE recipient = $1 AND acked_at IS NULL AND id = ANY($2::int[]) RETURNING ${MESSAGE_COLS}`,
      [to, ids],
    );
    return rows.map(toMessage);
  },
});

const workItems = (q: Queryable): WorkItemRepo => ({
  async create(goal, state) {
    const { rows } = await q.query(
      "INSERT INTO work_items (goal, state) VALUES ($1,$2) RETURNING id, goal, state, created_at",
      [goal, state],
    );
    return toWorkItem(rows[0]!);
  },
  async get(id) {
    const { rows } = await q.query("SELECT id, goal, state, created_at FROM work_items WHERE id = $1", [id]);
    return rows[0] ? toWorkItem(rows[0]) : null;
  },
  async oldestQueued() {
    const { rows } = await q.query("SELECT id, goal, state, created_at FROM work_items WHERE state = 'queued' ORDER BY id LIMIT 1");
    return rows[0] ? toWorkItem(rows[0]) : null;
  },
  async setState(ids, state) {
    await q.query("UPDATE work_items SET state = $2 WHERE id = ANY($1::int[])", [ids, state]);
  },
  async latestReport(id) {
    const { rows } = await q.query(
      `SELECT r.id, s.agent, r.outcome, r.summary, s.message_ids, r.created_at
       FROM reports r JOIN sessions s ON s.id = r.session_id
       WHERE s.message_ids && ARRAY(SELECT id FROM messages WHERE work_item_id = $1)
       ORDER BY r.id DESC LIMIT 1`,
      [id],
    );
    return rows[0] ? toReport(rows[0]) : null;
  },
});

const agents = (q: Queryable): AgentRepo => ({
  async touch(name) {
    await q.query(
      "INSERT INTO agents (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET last_active_at = now()",
      [name],
    );
  },
  async list() {
    const { rows } = await q.query(
      `SELECT a.name, a.state, a.wake_epoch, count(m.id)::int AS unread
       FROM agents a LEFT JOIN messages m ON m.recipient = a.name AND m.acked_at IS NULL
       GROUP BY a.name ORDER BY a.name`,
    );
    return rows.map((r): AgentInfo => ({
      name: r.name as string,
      state: r.state as string,
      wakeEpoch: r.wake_epoch as number,
      unread: r.unread as number,
    }));
  },
  async withUnread() {
    const { rows } = await q.query("SELECT DISTINCT recipient FROM messages WHERE acked_at IS NULL ORDER BY recipient");
    return rows.map((r) => r.recipient as string);
  },
  async idle(state, seconds) {
    const { rows } = await q.query(
      `SELECT a.name FROM agents a
       WHERE a.state = $1 AND a.last_active_at < now() - make_interval(secs => $2)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.recipient = a.name AND m.acked_at IS NULL)
       ORDER BY a.name`,
      [state, seconds],
    );
    return rows.map((r) => r.name as string);
  },
  async setState(name, state) {
    // Epoch counts wakes: it advances only on the transition into 'running'.
    await q.query(
      "UPDATE agents SET wake_epoch = wake_epoch + (state <> 'running' AND $2 = 'running')::int, state = $2 WHERE name = $1",
      [name, state],
    );
  },
});

const reports = (q: Queryable): ReportRepo => ({
  async record({ agent, startedAt, outcome, summary, messageIds }) {
    const s = await q.query(
      "INSERT INTO sessions (agent, started_at, message_ids) VALUES ($1,$2,$3::int[]) RETURNING id",
      [agent, startedAt, messageIds],
    );
    const { rows } = await q.query(
      `INSERT INTO reports (session_id, outcome, summary) VALUES ($1,$2,$3)
       RETURNING id, $4::text AS agent, outcome, summary, $5::int[] AS message_ids, created_at`,
      [s.rows[0]!.id, outcome, summary, agent, messageIds],
    );
    return toReport(rows[0]!);
  },
});

const bind = (q: Queryable): Repos => ({
  messages: messages(q),
  workItems: workItems(q),
  agents: agents(q),
  reports: reports(q),
});

export function pgStore(db: Database): Store {
  return { ...bind(db), transaction: (fn) => db.transaction((tx) => fn(bind(tx))) };
}
