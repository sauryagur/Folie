// Persistence ports. The service and controller depend on these, never on SQL.
import type {
  AgentInfo,
  EventQuery,
  InboxQuery,
  Message,
  MessageQuery,
  Outcome,
  Report,
  SendResult,
  SessionEvent,
  SessionEventInput,
  SessionUsage,
  TopicInfo,
  WorkItem,
  WorkItemState,
} from "../shared/types";

/** A W3C trace context as stored on rows. */
export interface StoredTrace {
  traceparent: string | null;
  tracestate: string | null;
}

export interface MessageRepo {
  /** With `requestId`, delivery is at-most-once per (sender, recipient): a repeat returns the original, flagged `duplicate`. */
  send(m: { from: string; to: string; body: string; workItemId?: number; requestId?: string; trace?: StoredTrace }): Promise<SendResult>;
  /** Unread mail, oldest first. `q.workItem` narrows it to what a session for that work item may take. */
  unacked(to: string, q?: InboxQuery): Promise<Message[]>;
  /** Acks exactly the given unacked messages of `to`; returns those actually acked. */
  ack(to: string, ids: number[]): Promise<Message[]>;
  /** The audit log, ascending by id, capped at `limit` (default 100, max 500). See MessageQuery. */
  list(q: MessageQuery): Promise<Message[]>;
}

export interface WorkItemRepo {
  create(goal: string, state: WorkItemState, trace?: StoredTrace): Promise<WorkItem>;
  get(id: number): Promise<WorkItem | null>;
  setState(ids: number[], state: WorkItemState): Promise<void>;
  /** Oldest work item still waiting for an agent. */
  oldestQueued(): Promise<WorkItem | null>;
  /** Newest report from a session that consumed any message of this work item. */
  latestReport(id: number): Promise<Report | null>;
}

/** An agent with mail waiting, and the trace context of its oldest unread message (what woke it). */
export interface WakeDemand extends StoredTrace {
  name: string;
}

export interface AgentRepo {
  /** Creates the agent if missing and records activity now (mail in, report out). */
  touch(name: string): Promise<void>;
  list(): Promise<AgentInfo[]>;
  /** Agents with at least one unacked message: the wake demand, in name order. */
  wakeDemand(): Promise<WakeDemand[]>;
  /** Re-parents an agent's unread mail onto `trace` (the wake that is bringing the agent up), so its session joins that span. */
  retrace(name: string, trace: StoredTrace): Promise<void>;
  /** Names in `state` with no unread mail and no activity for at least `seconds`. */
  idle(state: string, seconds: number): Promise<string[]>;
  setState(name: string, state: string): Promise<void>;
}

export interface ReportRepo {
  record(r: { agent: string; startedAt: string; outcome: Outcome; summary: string; messageIds: number[]; usage?: SessionUsage }): Promise<Report>;
  /** Newest first. */
  list(q: { agent?: string; limit?: number }): Promise<Report[]>;
}

export interface TopicRepo {
  /** Idempotent. The agent must exist. Subscriptions outlive suspension and retirement: delivery is durable, not live. */
  subscribe(topic: string, agent: string): Promise<void>;
  unsubscribe(topic: string, agent: string): Promise<void>;
  /**
   * Copies the message into the inbox of every subscriber except `from`. With `requestId`, a repeat delivers nothing
   * and returns the original copies with `duplicate` set.
   */
  publish(topic: string, from: string, body: string, opts?: { requestId?: string; trace?: StoredTrace }): Promise<{ copies: Message[]; duplicate: boolean }>;
  /** Topics that have at least one subscriber. */
  list(): Promise<TopicInfo[]>;
}

export interface EventRepo {
  /** Appends events, ignoring any (sessionId, seq) already stored; returns the seqs that were new. */
  append(b: { agent: string; sessionId: string; scope: string; traceId: string | null; events: SessionEventInput[] }): Promise<number[]>;
  /** Ascending by id; default limit 200, max 1000. */
  list(q: EventQuery): Promise<SessionEvent[]>;
  /** tool_start / tool_end events at a scope, optionally leaving out one session, oldest first. */
  toolEvents(agent: string, scope: string, excludeSession?: string): Promise<SessionEvent[]>;
}

export interface Repos {
  messages: MessageRepo;
  workItems: WorkItemRepo;
  agents: AgentRepo;
  reports: ReportRepo;
  topics: TopicRepo;
  events: EventRepo;
}

export interface Store extends Repos {
  /** Runs fn with repos bound to one atomic unit of work. */
  transaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T>;
}
