import type {
  AgentInfo,
  Message,
  Report,
  SessionEvent,
  SessionEventType,
  SessionUsage,
  TopicInfo,
  WorkItem,
  WorkItemState,
} from "../shared/types";
import type { Database, Queryable, Row } from "./db";
import type { AgentRepo, EventRepo, MessageRepo, Repos, ReportRepo, Store, StoredTrace, TopicRepo, WorkItemRepo } from "./store";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const NO_TRACE: StoredTrace = { traceparent: null, tracestate: null };

const toMessage = (r: Row): Message => ({
  id: r.id as number,
  from: r.sender as string,
  to: r.recipient as string,
  body: r.body as string,
  workItemId: (r.work_item_id as number | null) ?? null,
  topic: (r.topic as string | null) ?? null,
  createdAt: iso(r.created_at),
  ackedAt: r.acked_at ? iso(r.acked_at) : null,
  traceparent: (r.traceparent as string | null) ?? null,
  tracestate: (r.tracestate as string | null) ?? null,
});

const WORK_ITEM_COLS = "id, goal, state, created_at, traceparent, tracestate";

const toWorkItem = (r: Row): WorkItem => ({
  id: r.id as number,
  goal: r.goal as string,
  state: r.state as WorkItemState,
  createdAt: iso(r.created_at),
  traceparent: (r.traceparent as string | null) ?? null,
  tracestate: (r.tracestate as string | null) ?? null,
});

const toUsage = (r: Row): SessionUsage | null =>
  r.prompt_tokens === null || r.prompt_tokens === undefined
    ? null
    : {
        promptTokens: r.prompt_tokens as number,
        completionTokens: r.completion_tokens as number,
        costUsd: r.cost_usd as number,
        toolCalls: r.tool_calls as number,
        toolFailures: r.tool_failures as number,
      };

const toReport = (r: Row): Report => ({
  id: r.id as number,
  agent: r.agent as string,
  outcome: r.outcome as Report["outcome"],
  summary: r.summary as string,
  messageIds: r.message_ids as number[],
  createdAt: iso(r.created_at),
  usage: toUsage(r),
});

const REPORT_COLS =
  "r.id, s.agent, r.outcome, r.summary, s.message_ids, r.created_at, r.prompt_tokens, r.completion_tokens, r.cost_usd, r.tool_calls, r.tool_failures";

const toEvent = (r: Row): SessionEvent => ({
  id: r.id as number,
  agent: r.agent as string,
  sessionId: r.session_id as string,
  scope: r.scope as string,
  seq: r.seq as number,
  type: r.type as SessionEventType,
  data: (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>,
  traceId: (r.trace_id as string | null) ?? null,
  createdAt: iso(r.created_at),
});

const EVENT_COLS = "id, agent, session_id, scope, seq, type, data, trace_id, created_at";
const MESSAGE_COLS = "id, sender, recipient, body, work_item_id, topic, created_at, acked_at, traceparent, tracestate";
const ON_DUPLICATE_REQUEST = "ON CONFLICT (sender, request_id, recipient) WHERE request_id IS NOT NULL DO NOTHING";

const messages = (q: Queryable): MessageRepo => ({
  async send({ from, to, body, workItemId, requestId, trace = NO_TRACE }) {
    const args = [from, to, body, workItemId ?? null, requestId ?? null, trace.traceparent, trace.tracestate];
    const insert = `INSERT INTO messages (sender, recipient, body, work_item_id, request_id, traceparent, tracestate)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)`;
    if (requestId === undefined) {
      const { rows } = await q.query(`${insert} RETURNING ${MESSAGE_COLS}`, args);
      return toMessage(rows[0]!);
    }
    const inserted = await q.query(`${insert} ${ON_DUPLICATE_REQUEST} RETURNING ${MESSAGE_COLS}`, args);
    if (inserted.rows[0]) return toMessage(inserted.rows[0]);
    const { rows } = await q.query(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE sender = $1 AND recipient = $2 AND request_id = $3`,
      [from, to, requestId],
    );
    return { ...toMessage(rows[0]!), duplicate: true };
  },
  async unacked(to, query = {}) {
    // A session may take its own work item's mail plus mail that belongs to no work item (peer and topic mail).
    const scope =
      query.workItem === undefined ? "" : query.workItem === "none" ? "AND work_item_id IS NULL" : "AND (work_item_id IS NULL OR work_item_id = $2)";
    const args = typeof query.workItem === "number" ? [to, query.workItem] : [to];
    const { rows } = await q.query(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE recipient = $1 AND acked_at IS NULL ${scope} ORDER BY id`,
      args,
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
  async list({ after, limit, topic, agent }) {
    const n = Math.min(Math.max(limit ?? 100, 1), 500);
    const filter = "($1::text IS NULL OR topic = $1) AND ($2::text IS NULL OR recipient = $2 OR sender = $2)";
    if (after !== undefined) {
      const { rows } = await q.query(
        `SELECT ${MESSAGE_COLS} FROM messages WHERE id > $3 AND ${filter} ORDER BY id LIMIT $4`,
        [topic ?? null, agent ?? null, after, n],
      );
      return rows.map(toMessage);
    }
    // No cursor: the newest n, handed back oldest first so callers can append in order.
    const { rows } = await q.query(
      `SELECT * FROM (SELECT ${MESSAGE_COLS} FROM messages WHERE ${filter} ORDER BY id DESC LIMIT $3) t ORDER BY id`,
      [topic ?? null, agent ?? null, n],
    );
    return rows.map(toMessage);
  },
});

const workItems = (q: Queryable): WorkItemRepo => ({
  async create(goal, state, trace = NO_TRACE) {
    const { rows } = await q.query(
      `INSERT INTO work_items (goal, state, traceparent, tracestate) VALUES ($1,$2,$3,$4) RETURNING ${WORK_ITEM_COLS}`,
      [goal, state, trace.traceparent, trace.tracestate],
    );
    return toWorkItem(rows[0]!);
  },
  async get(id) {
    const { rows } = await q.query(`SELECT ${WORK_ITEM_COLS} FROM work_items WHERE id = $1`, [id]);
    return rows[0] ? toWorkItem(rows[0]) : null;
  },
  async oldestQueued() {
    const { rows } = await q.query(`SELECT ${WORK_ITEM_COLS} FROM work_items WHERE state = 'queued' ORDER BY id LIMIT 1`);
    return rows[0] ? toWorkItem(rows[0]) : null;
  },
  async setState(ids, state) {
    await q.query("UPDATE work_items SET state = $2 WHERE id = ANY($1::int[])", [ids, state]);
  },
  async latestReport(id) {
    const { rows } = await q.query(
      `SELECT ${REPORT_COLS}
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
    await q.query("INSERT INTO agents (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET last_active_at = now()", [name]);
  },
  async retrace(name, trace) {
    await q.query("UPDATE messages SET traceparent = $2, tracestate = $3 WHERE recipient = $1 AND acked_at IS NULL", [name, trace.traceparent, trace.tracestate]);
  },
  async list() {
    const { rows } = await q.query(
      `SELECT a.name, a.state, a.wake_epoch, a.last_active_at, count(m.id)::int AS unread
       FROM agents a LEFT JOIN messages m ON m.recipient = a.name AND m.acked_at IS NULL
       GROUP BY a.name ORDER BY a.name`,
    );
    return rows.map((r): AgentInfo => ({
      name: r.name as string,
      state: r.state as string,
      wakeEpoch: r.wake_epoch as number,
      unread: r.unread as number,
      lastActiveAt: iso(r.last_active_at),
    }));
  },
  async wakeDemand() {
    const { rows } = await q.query(
      `SELECT DISTINCT ON (recipient) recipient, traceparent, tracestate
       FROM messages WHERE acked_at IS NULL ORDER BY recipient, id`,
    );
    return rows.map((r) => ({
      name: r.recipient as string,
      traceparent: (r.traceparent as string | null) ?? null,
      tracestate: (r.tracestate as string | null) ?? null,
    }));
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
  async record({ agent, startedAt, outcome, summary, messageIds, usage }) {
    const s = await q.query(
      "INSERT INTO sessions (agent, started_at, message_ids) VALUES ($1,$2,$3::int[]) RETURNING id",
      [agent, startedAt, messageIds],
    );
    const { rows } = await q.query(
      `INSERT INTO reports (session_id, outcome, summary, prompt_tokens, completion_tokens, cost_usd, tool_calls, tool_failures)
       VALUES ($1,$2,$3,$6,$7,$8,$9,$10)
       RETURNING id, $4::text AS agent, outcome, summary, $5::int[] AS message_ids, created_at,
                 prompt_tokens, completion_tokens, cost_usd, tool_calls, tool_failures`,
      [
        s.rows[0]!.id,
        outcome,
        summary,
        agent,
        messageIds,
        usage?.promptTokens ?? null,
        usage?.completionTokens ?? null,
        usage?.costUsd ?? null,
        usage?.toolCalls ?? null,
        usage?.toolFailures ?? null,
      ],
    );
    return toReport(rows[0]!);
  },
  async list({ agent, limit }) {
    const { rows } = await q.query(
      `SELECT ${REPORT_COLS}
       FROM reports r JOIN sessions s ON s.id = r.session_id
       WHERE $1::text IS NULL OR s.agent = $1
       ORDER BY r.id DESC LIMIT $2`,
      [agent ?? null, Math.min(Math.max(limit ?? 50, 1), 500)],
    );
    return rows.map(toReport);
  },
});

const topics = (q: Queryable): TopicRepo => ({
  async subscribe(topic, agent) {
    await q.query("INSERT INTO topic_subscriptions (topic, agent) VALUES ($1,$2) ON CONFLICT DO NOTHING", [topic, agent]);
  },
  async unsubscribe(topic, agent) {
    await q.query("DELETE FROM topic_subscriptions WHERE topic = $1 AND agent = $2", [topic, agent]);
  },
  async publish(topic, from, body, { requestId, trace = NO_TRACE } = {}) {
    if (requestId !== undefined) {
      // A repeated request id replays nothing: it reports what the first publish delivered.
      const prior = await q.query(
        `SELECT ${MESSAGE_COLS} FROM messages WHERE sender = $1 AND request_id = $2 AND topic = $3 ORDER BY id`,
        [from, requestId, topic],
      );
      if (prior.rows.length > 0) return { copies: prior.rows.map(toMessage), duplicate: true };
    }
    // One statement fans out to every subscriber but the publisher, and counts the mail as their activity.
    const { rows } = await q.query(
      `WITH sent AS (
         INSERT INTO messages (sender, recipient, body, topic, request_id, traceparent, tracestate)
         SELECT $2::text, s.agent, $3::text, $1::text, $4::text, $5::text, $6::text
         FROM topic_subscriptions s WHERE s.topic = $1::text AND s.agent <> $2::text
         ${ON_DUPLICATE_REQUEST}
         RETURNING ${MESSAGE_COLS}
       ), touched AS (
         UPDATE agents SET last_active_at = now() WHERE name IN (SELECT recipient FROM sent)
       )
       SELECT * FROM sent ORDER BY id`,
      [topic, from, body, requestId ?? null, trace.traceparent, trace.tracestate],
    );
    return { copies: rows.map(toMessage), duplicate: false };
  },
  async list() {
    const { rows } = await q.query(
      "SELECT topic, array_agg(agent ORDER BY agent) AS subscribers FROM topic_subscriptions GROUP BY topic ORDER BY topic",
    );
    return rows.map((r): TopicInfo => ({ topic: r.topic as string, subscribers: r.subscribers as string[] }));
  },
});

const events = (q: Queryable): EventRepo => ({
  async append({ agent, sessionId, scope, traceId, events: batch }) {
    if (batch.length === 0) return [];
    const args: unknown[] = [agent, sessionId, scope, traceId];
    const values = batch.map((e) => {
      args.push(e.seq, e.type, JSON.stringify(e.data));
      const n = args.length;
      return `($1,$2,$3,$${n - 2},$${n - 1},$${n}::jsonb,$4)`;
    });
    const { rows } = await q.query(
      `INSERT INTO session_events (agent, session_id, scope, seq, type, data, trace_id)
       VALUES ${values.join(",")} ON CONFLICT (session_id, seq) DO NOTHING RETURNING seq`,
      args,
    );
    return rows.map((r) => Number(r.seq));
  },
  async list({ agent, sessionId, scope, type, after, limit }) {
    const { rows } = await q.query(
      `SELECT ${EVENT_COLS} FROM session_events
       WHERE ($1::text IS NULL OR agent = $1) AND ($2::text IS NULL OR session_id = $2)
         AND ($3::text IS NULL OR scope = $3) AND ($6::text IS NULL OR type = $6) AND id > $4
       ORDER BY id LIMIT $5`,
      [agent ?? null, sessionId ?? null, scope ?? null, after ?? 0, Math.min(Math.max(limit ?? 200, 1), 1000), type ?? null],
    );
    return rows.map(toEvent);
  },
  async toolEvents(agent, scope, excludeSession) {
    const { rows } = await q.query(
      `SELECT ${EVENT_COLS} FROM session_events
       WHERE agent = $1 AND scope = $2 AND type IN ('tool_start','tool_end') AND ($3::text IS NULL OR session_id <> $3)
       ORDER BY id`,
      [agent, scope, excludeSession ?? null],
    );
    return rows.map(toEvent);
  },
});

const bind = (q: Queryable): Repos => ({
  messages: messages(q),
  workItems: workItems(q),
  agents: agents(q),
  reports: reports(q),
  topics: topics(q),
  events: events(q),
});

export function pgStore(db: Database): Store {
  return { ...bind(db), transaction: (fn) => db.transaction((tx) => fn(bind(tx))) };
}
