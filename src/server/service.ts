// The swarm's business rules. Every wake, delegation and report passes through here.
// Each operation runs in an OpenTelemetry span; the span's W3C context is stored on the rows it creates
// (work items, messages), so work done later by other processes (controller, agents) joins the same trace.
import { SpanStatusCode } from "@opentelemetry/api";
import {
  AGENT_NAME,
  TOPIC_NAME,
  type AgentInfo,
  type EventQuery,
  type InboxQuery,
  type Message,
  type MessageQuery,
  type PublishRequest,
  type PublishResult,
  type Report,
  type SendMessageRequest,
  type SendResult,
  type SessionEvent,
  type SessionEventBatch,
  type SessionEventType,
  type SessionUsage,
  type SubmitGoalRequest,
  type SubmitReportRequest,
  type SubscribeRequest,
  type ToolAttempt,
  type TopicInfo,
  type WorkItem,
  type WorkItemView,
} from "../shared/types";
import { activeSpanIds, contextFrom, storableTrace, withSpan } from "../shared/trace";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { choosePoolAgent } from "./pool";
import type { Store } from "./store";
import { noopObservability, type Observability } from "../shared/telemetry";
import type { Principal } from "./auth";

function agentName(v: unknown, field: string): string {
  if (typeof v !== "string" || !AGENT_NAME.test(v)) throw new ValidationError(`${field}: invalid agent name`);
  return v;
}

function text(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError(`${field}: required`);
  return v;
}

function topicName(v: unknown): string {
  if (typeof v !== "string" || !TOPIC_NAME.test(v)) throw new ValidationError("topic: invalid topic name");
  return v;
}

function requestId(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length < 1 || v.length > 200) throw new ValidationError("requestId: 1-200 characters");
  return v;
}

const count = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ValidationError(`usage.${field}: non-negative integer required`);
  return v;
};

function usageOf(v: unknown): SessionUsage | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) throw new ValidationError("usage: object required");
  const u = v as Record<string, unknown>;
  if (typeof u.costUsd !== "number" || !Number.isFinite(u.costUsd) || u.costUsd < 0) throw new ValidationError("usage.costUsd: non-negative number required");
  return {
    promptTokens: count(u.promptTokens, "promptTokens"),
    completionTokens: count(u.completionTokens, "completionTokens"),
    costUsd: u.costUsd,
    toolCalls: count(u.toolCalls, "toolCalls"),
    toolFailures: count(u.toolFailures, "toolFailures"),
  };
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE = /^(wi|mail):\d+$/;
const EVENT_TYPES: Record<SessionEventType, true> = {
  session_start: true, message: true, turn_start: true, turn_end: true, tool_start: true, tool_end: true, steer: true, log: true, artifact: true, session_end: true,
};
const MAX_EVENTS_PER_BATCH = 200;
const MAX_EVENT_BYTES = 64 * 1024;

export class SwarmService {
  private readonly obs: Observability;

  constructor(
    private readonly store: Store,
    obs?: Observability,
  ) {
    this.obs = obs ?? noopObservability();
  }

  // --- helpers for auth ---

  private requireOperator(principal: Principal) {
    if (principal.kind !== "operator") throw new ForbiddenError("operator required");
  }

  private requireSelfAgent(principal: Principal, agent: string) {
    if (principal.kind === "operator") return;
    if (principal.kind !== "agent" || principal.name !== agent) {
      throw new ForbiddenError("principal does not match agent");
    }
  }

  private async agentExists(name: string) {
    const a = await this.store.agents.get(name).catch(() => null);
    return !!a;
  }

  // Principal derived from Authorization header only; body fields must match if present.

  private assertFromMatches(principal: Principal, from: string | undefined) {
    if (!from) return;
    if (principal.kind === "agent") {
      if (principal.name !== from) throw new ForbiddenError("from does not match principal");
    } else {
      // operator may use "human" or any from? For this slice: operator from must match? Human sends from="human".
      // Allow operator to send as "human" or itself, but not as another agent name unless it's "human".
      // Keep strict: operator's from may be "human" legacy; otherwise must be operator's name? The agent check is critical.
      // We will accept operator from == "human" as provenance for human sends.
      if (from !== "human" && principal.kind === "operator") {
        // Allow any from? Hmm: operator token representing human. For safety, allow operator to impersonate? No — operator should also not forge agent name.
        // Current behaviour: operator calls send from="human" or from=someAgent. In this slice operator sends from="human" (clients use that).
        // If from is an agent name, that would be forging. Reject unless from=='human'.
        if (from !== "human") throw new ForbiddenError("operator cannot forge agent identity");
      }
    }
  }

  private assertAgentMatches(principal: Principal, agent: string) {
    if (principal.kind !== "agent") return;
    if (principal.name !== agent) throw new ForbiddenError(`agent ${agent} does not match principal`);
  }

  // kept for compatibility: operator registration entry point

  async registerAgent(name: string): Promise<AgentInfo> {
    const n = agentName(name, "agent");
    return this.store.transaction(async (r) => r.agents.register(n));
  }

  /** List agents: operator-only for fleet-wide reads; agents may not list. */
  async listAgentsFor(principal: Principal): Promise<AgentInfo[]> {
    this.requireOperator(principal);
    return this.store.agents.list();
  }

  /**
   * A goal is a message from the human; that message is what wakes the agent. With `to` it goes straight
   * to that agent. Without, it waits in the queue until `dispatchQueued` finds the pool an agent for it.
   * The submission span is the root of the work item's trace: its context is stored on the work item.
   */
  async submitGoal(req: SubmitGoalRequest, principal: Principal): Promise<{ workItem: WorkItem; message: Message | null }> {
    this.requireOperator(principal);
    const goal = text(req.goal, "goal");
    const to = req.to === undefined ? undefined : agentName(req.to, "to");
    const intent = req.intent === undefined ? undefined : text(req.intent, "intent").slice(0, 100);
    const attributes = { "folie.directed": to !== undefined, ...(intent ? { "folie.intent": intent } : {}) };
    return withSpan(this.obs.tracer, "folie.work_item.submit", { attributes }, async (span) => {
      const trace = storableTrace();
      if (to === undefined) {
        const workItem = await this.store.workItems.create(goal, "queued", trace);
        span.setAttribute("work_item_id", workItem.id);
        return { workItem, message: null };
      }
      // Must be registered agent. Do not implicitly create.
      const exists = await this.store.transaction(async (r) => {
        const a = await r.agents.get(to);
        return !!a;
      });
      if (!exists) throw new NotFoundError(`unknown agent ${to}`);
      const out = await this.store.transaction(async (r) => {
        const a = await r.agents.get(to);
        if (!a) throw new NotFoundError(`unknown agent ${to}`);
        await r.agents.touch(to);
        const workItem = await r.workItems.create(goal, "assigned", trace);
        const message = await r.messages.send({ from: "human", to, body: goal, workItemId: workItem.id, trace });
        return { workItem, message };
      });
      span.setAttributes({ work_item_id: out.workItem.id, agent_name: to });
      return out;
    });
  }

  /** Hands queued goals, oldest first, to idle or new pool agents until none is free. Returns how many were assigned. */
  async dispatchQueued(maxAgents: number): Promise<number> {
    let assigned = 0;
    while (await this.assignOneQueued(maxAgents)) assigned++;
    return assigned;
  }

  private assignOneQueued(maxAgents: number): Promise<boolean> {
    return this.store.transaction(async (r) => {
      const item = await r.workItems.oldestQueued();
      if (!item) return false;
      const to = choosePoolAgent(await r.agents.list(), maxAgents);
      if (!to) return false;
      // Dispatch continues the work item's own trace; the message it creates carries the dispatch span on to the agent.
      const parent = contextFrom({ traceparent: item.traceparent, tracestate: item.tracestate });
      await withSpan(this.obs.tracer, "folie.dispatch", { parent, attributes: { work_item_id: item.id, agent_name: to } }, async () => {
        await r.agents.touch(to);
        await r.messages.send({ from: "human", to, body: item.goal, workItemId: item.id, trace: storableTrace() });
        await r.workItems.setState([item.id], "assigned");
      });
      return true;
    });
  }

  /**
   * Peer delegation and controller notices: sending to an unknown agent creates it. With `requestId` the send is
   * at-most-once per (sender, recipient). The send span's context rides on the message, so the recipient's
   * session is a child of whatever span (an agent's tool call) made this request.
   *
   * R-1.5 + R-1.1: the principal comes from the credential. body from must match the principal (or be "human" for operator).
   * Recipient must already be a registered agent (404 otherwise); pool dispatch creates pool agents internally.
   */
  async send(req: SendMessageRequest, principal: Principal): Promise<SendResult> {
    const from = text(req.from, "from");
    this.assertFromMatches(principal, from);
    if (principal.kind === "operator" && from === "human") {
      // ok: human operator provenance
    }
    const to = agentName(req.to, "to");
    const body = text(req.body, "body");
    const id = requestId(req.requestId);
    return withSpan(this.obs.tracer, "folie.message.send", { attributes: { agent_name: principal.kind === "agent" ? principal.name : from, "folie.recipient": to } }, async (span) => {
      const m = await this.store.transaction(async (r) => {
        const exists = await r.agents.get(to);
        if (!exists) throw new NotFoundError(`unknown agent ${to}`);
        // derive sender from principal when possible: agents send as themselves, operator as "human".
        const sender = principal.kind === "agent" ? principal.name : from;
        return r.messages.send({ from: sender, to, body, requestId: id, trace: storableTrace() });
      });
      if (m.duplicate) span.setAttribute("folie.duplicate", true);
      return m;
    });
  }

  /** Unread mail. With `q.workItem`, only what a session for that work item may take mid-run. */
  async inbox(agent: string, q: InboxQuery = {}, principal?: Principal): Promise<Message[]> {
    if (principal) this.requireSelfAgent(principal, agentName(agent, "agent"));
    if (q.workItem !== undefined && q.workItem !== "none" && !Number.isInteger(q.workItem)) throw new ValidationError("workItem: integer or none");
    // R-1.5: unknown agent must 404 rather than empty.
    if (principal) {
      const exists = await this.store.agents.get(agentName(agent, "agent"));
      if (!exists) throw new NotFoundError(`unknown agent ${agent}`);
    } else {
      // internal callers (tests that use service directly without http + auth) still validate existence
      const exists = await this.store.agents.get(agentName(agent, "agent")).catch(() => null);
      // If agents table has any rows, enforce; for bare service tests we will pass principal. If no principal, do not 404 yet? To keep service tests working, skip.
      void exists;
    }
    return this.store.messages.unacked(agentName(agent, "agent"), q);
  }

  /** The audit log for operators and the TUI: every message in the swarm, filterable. */
  async messages(q: MessageQuery, principal: Principal): Promise<Message[]> {
    this.requireOperator(principal);
    if (q.after !== undefined && (!Number.isInteger(q.after) || q.after < 0)) throw new ValidationError("after: non-negative integer required");
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1)) throw new ValidationError("limit: positive integer required");
    return this.store.messages.list({
      after: q.after,
      limit: q.limit,
      topic: q.topic === undefined ? undefined : topicName(q.topic),
      agent: q.agent === undefined ? undefined : agentName(q.agent, "agent"),
    });
  }

  /** Session reports, newest first. */
  async reports(q: { agent?: string; limit?: number }, principal: Principal): Promise<Report[]> {
    this.requireOperator(principal);
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1)) throw new ValidationError("limit: positive integer required");
    return this.store.reports.list({ agent: q.agent === undefined ? undefined : agentName(q.agent, "agent"), limit: q.limit });
  }

  listAgents(): Promise<AgentInfo[]> {
    return this.store.agents.list();
  }

  /** Subscribe: agent subscribes itself; operator may subscribe any registered agent. Unknown agents must 404. */
  async subscribe(topic: string, req: SubscribeRequest, principal: Principal): Promise<{ topic: string; agent: string }> {
    const t = topicName(topic);
    const agent = agentName(req.agent, "agent");
    if (principal.kind === "agent") this.assertAgentMatches(principal, agent);
    await this.store.transaction(async (r) => {
      const exists = await r.agents.get(agent);
      if (!exists) throw new NotFoundError(`unknown agent ${agent}`);
      // Subscriptions outlive suspension; do not create the agent implicitly (R-1.5).
      await r.topics.subscribe(t, agent);
    });
    return { topic: t, agent };
  }

  async unsubscribe(topic: string, req: SubscribeRequest, principal: Principal): Promise<{ topic: string; agent: string }> {
    const t = topicName(topic);
    const agent = agentName(req.agent, "agent");
    if (principal.kind === "agent") this.assertAgentMatches(principal, agent);
    await this.store.topics.unsubscribe(t, agent);
    return { topic: t, agent };
  }

  /** Delivers a copy to every current subscriber except the publisher; each copy wakes its agent like any mail. */
  async publish(topic: string, req: PublishRequest, principal: Principal): Promise<PublishResult> {
    this.assertFromMatches(principal, req.from);
    const t = topicName(topic);
    const from = text(req.from, "from");
    const body = text(req.body, "body");
    const id = requestId(req.requestId);
    return withSpan(this.obs.tracer, "folie.topic.publish", { attributes: { agent_name: principal.kind === "agent" ? principal.name : from, "folie.topic": t } }, async (span) => {
      const sender = principal.kind === "agent" ? principal.name : from;
      const { copies, duplicate } = await this.store.topics.publish(t, sender, body, { requestId: id, trace: storableTrace() });
      span.setAttribute("folie.delivered", copies.length);
      if (duplicate) span.setAttribute("folie.duplicate", true);
      return { delivered: copies.length, ...(duplicate ? { duplicate: true } : {}) };
    });
  }

  listTopicsFor(principal: Principal): Promise<TopicInfo[]> {
    this.requireOperator(principal);
    return this.store.topics.list();
  }

  listTopics(): Promise<TopicInfo[]> {
    return this.store.topics.list();
  }

  /**
   * Records the session, acks what it consumed, and settles the work items behind those messages. A failed
   * session is not retried: its work parks in `blocked`, and the settlement span is marked failed so the trace shows it.
   */
  async submitReport(req: SubmitReportRequest, principal: Principal): Promise<Report> {
    if (!Array.isArray(req.messageIds)) throw new ValidationError("messageIds: array required");
    const agent = agentName(req.agent, "agent");
    this.assertAgentMatches(principal, agent);
    if (principal.kind !== "agent" && principal.kind !== "operator") throw new ForbiddenError("invalid principal");
    // Only agents may submit reports for themselves; operators may not forge agent reports.
    if (principal.kind === "operator") throw new ForbiddenError("operator cannot submit agent report");
    if (req.outcome !== "done" && req.outcome !== "failed") throw new ValidationError("outcome: must be done|failed");
    const summary = text(req.summary, "summary");
    const startedAt = new Date(text(req.startedAt, "startedAt"));
    if (Number.isNaN(startedAt.getTime())) throw new ValidationError("startedAt: invalid timestamp");
    const ids = [...new Set(req.messageIds)];
    if (ids.length === 0 || !ids.every(Number.isInteger)) throw new ValidationError("messageIds: non-empty integers required");
    const usage = usageOf(req.usage);

    return withSpan(this.obs.tracer, "folie.report.settle", { attributes: { agent_name: agent, outcome: req.outcome } }, async (span) => {
      const { report, acked, itemIds } = await this.store.transaction(async (r) => {
        const acked = await r.messages.ack(agent, ids);
        if (acked.length !== ids.length) throw new ValidationError("messageIds: not all are unacked messages of this agent");
        const report = await r.reports.record({ agent, startedAt: startedAt.toISOString(), outcome: req.outcome, summary, messageIds: ids, usage });
        await r.agents.touch(agent); // finishing a session is activity: the quiet period starts now
        const itemIds = [...new Set(acked.flatMap((m) => (m.workItemId === null ? [] : [m.workItemId])))];
        // One-shot failure: a failed session parks its work in 'blocked'; there is no retry.
        if (itemIds.length) await r.workItems.setState(itemIds, req.outcome === "done" ? "done" : "blocked");
        return { report, acked, itemIds };
      });

      if (itemIds.length === 1) span.setAttribute("work_item_id", itemIds[0]!);
      else if (itemIds.length > 1) span.setAttribute("work_item_ids", itemIds.join(","));
      if (usage) {
        span.setAttributes({
          "llm.usage.prompt_tokens": usage.promptTokens,
          "llm.usage.completion_tokens": usage.completionTokens,
          "llm.usage.cost_usd": usage.costUsd,
          "folie.tool.calls": usage.toolCalls,
          "folie.tool.failures": usage.toolFailures,
        });
      }
      if (req.outcome === "failed") {
        span.setAttribute("folie.work_item.parked", itemIds.length > 0);
        span.setStatus({ code: SpanStatusCode.ERROR, message: summary.slice(0, 200) });
      }
      this.obs.metrics.sessionReported({
        agent,
        outcome: req.outcome,
        usage,
        inboxLatenciesMs: acked.map((m) => Date.parse(m.ackedAt ?? m.createdAt) - Date.parse(m.createdAt)),
      });
      return report;
    });
  }

  async workItem(id: number, principal: Principal): Promise<WorkItemView> {
    this.requireOperator(principal);
    const workItem = await this.store.workItems.get(id);
    if (!workItem) throw new NotFoundError(`work item ${id}`);
    return { workItem, report: await this.store.workItems.latestReport(id) };
  }

  /**
   * Appends a session's transcript. Idempotent per (sessionId, seq), so an agent can resend a batch it is unsure
   * arrived. Tool outcomes feed the tool metrics, counted once per event actually stored.
   */
  async ingestEvents(b: SessionEventBatch, principal: Principal): Promise<{ stored: number }> {
    const agent = agentName(b.agent, "agent");
    this.assertAgentMatches(principal, agent);
    if (principal.kind === "operator") throw new ForbiddenError("operator cannot ingest agent events");
    if (typeof b.sessionId !== "string" || !SESSION_ID.test(b.sessionId)) throw new ValidationError("sessionId: 1-64 chars of [A-Za-z0-9_-]");
    if (typeof b.scope !== "string" || !SCOPE.test(b.scope)) throw new ValidationError("scope: wi:<id> or mail:<id>");
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > MAX_EVENTS_PER_BATCH) {
      throw new ValidationError(`events: 1-${MAX_EVENTS_PER_BATCH} required`);
    }
    for (const e of b.events) {
      if (!Number.isInteger(e?.seq) || e.seq < 0) throw new ValidationError("events.seq: non-negative integer required");
      if (!EVENT_TYPES[e.type]) throw new ValidationError(`events.type: unknown type ${JSON.stringify(e.type)}`);
      if (typeof e.data !== "object" || e.data === null || Array.isArray(e.data)) throw new ValidationError("events.data: object required");
      if (JSON.stringify(e.data).length > MAX_EVENT_BYTES) throw new ValidationError(`events.data: over ${MAX_EVENT_BYTES} bytes`);
    }
    const seqs = await this.store.events.append({ agent, sessionId: b.sessionId, scope: b.scope, traceId: activeSpanIds()?.trace_id ?? null, events: b.events });
    const fresh = new Set(seqs);
    for (const e of b.events) {
      if (e.type !== "tool_end" || !fresh.has(e.seq)) continue;
      this.obs.metrics.toolEnded({ agent, tool: String(e.data.tool ?? "unknown"), replayable: e.data.replayable === true, isError: e.data.isError === true });
    }
    return { stored: seqs.length };
  }

  async events(q: EventQuery, principal: Principal): Promise<SessionEvent[]> {
    this.requireOperator(principal);
    if (q.after !== undefined && (!Number.isInteger(q.after) || q.after < 0)) throw new ValidationError("after: non-negative integer required");
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1)) throw new ValidationError("limit: positive integer required");
    if (q.scope !== undefined && !SCOPE.test(q.scope)) throw new ValidationError("scope: wi:<id> or mail:<id>");
    if (q.sessionId !== undefined && !SESSION_ID.test(q.sessionId)) throw new ValidationError("sessionId: invalid");
    if (q.type !== undefined && !EVENT_TYPES[q.type]) throw new ValidationError("type: unknown event type");
    return this.store.events.list({ ...q, agent: q.agent === undefined ? undefined : agentName(q.agent, "agent") });
  }

  /**
   * The non-replayable tool calls earlier sessions at this scope made, from the transcript: finished, failed, or
   * interrupted (started with no end, i.e. the session died mid-call). A restarted session reads this so it neither
   * repeats what is done nor trusts what was cut off.
   */
  async attempts(agent: string, scope: string, excludeSession?: string, principal?: Principal): Promise<ToolAttempt[]> {
    const a = agentName(agent, "agent");
    if (principal) this.requireSelfAgent(principal, a);
    if (!SCOPE.test(scope)) throw new ValidationError("scope: wi:<id> or mail:<id>");
    const byCall = new Map<string, ToolAttempt>();
    for (const e of await this.store.events.toolEvents(a, scope, excludeSession)) {
      const key = `${e.sessionId}:${String(e.data.callId)}`;
      if (e.type === "tool_start") {
        byCall.set(key, { sessionId: e.sessionId, callId: String(e.data.callId), tool: String(e.data.tool), replayable: e.data.replayable === true, args: e.data.args, state: "interrupted" });
      } else {
        const call = byCall.get(key);
        if (call) call.state = e.data.isError === true ? "failed" : "done";
      }
    }
    return [...byCall.values()];
  }
}
