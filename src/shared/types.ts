// Wire and domain types shared by folie-server, the agent program and the CLI.

export type Outcome = "done" | "failed";
export type WorkItemState = "queued" | "assigned" | "blocked" | "done" | "failed";

export interface Message {
  id: number;
  from: string;
  to: string;
  body: string;
  workItemId: number | null;
  /** Set when the message was delivered by a topic publish. */
  topic: string | null;
  createdAt: string;
  ackedAt: string | null;
  /** W3C trace context of whatever produced this message (the work item's dispatch, or a peer's tool call). */
  traceparent?: string | null;
  tracestate?: string | null;
}

export interface WorkItem {
  id: number;
  goal: string;
  state: WorkItemState;
  createdAt: string;
  /** W3C trace context of the work item's root span: everything done for it joins this trace. */
  traceparent?: string | null;
  tracestate?: string | null;
}

export interface Report {
  id: number;
  agent: string;
  outcome: Outcome;
  summary: string;
  messageIds: number[];
  createdAt: string;
  usage?: SessionUsage | null;
}

export interface AgentInfo {
  name: string;
  state: string;
  wakeEpoch: number;
  unread: number;
  /** Last mail in or report out; the quiet period that suspension counts from. */
  lastActiveAt: string;
}

export interface SubmitGoalRequest {
  goal: string;
  to?: string;
  /** What kind of work this is (math, research, training, ...). Recorded on the work item's root span. */
  intent?: string;
}

export interface SendMessageRequest {
  from: string;
  to: string;
  body: string;
  /** At-most-once key per sender: a repeat returns the original message instead of delivering twice. */
  requestId?: string;
}

/** A sent message; `duplicate` is set only when `requestId` matched an earlier send. */
export type SendResult = Message & { duplicate?: boolean };

/** What one session cost: model tokens and dollars (catalog estimate), and how its tools fared. */
export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  toolCalls: number;
  toolFailures: number;
}

export interface SubmitReportRequest {
  agent: string;
  startedAt: string;
  outcome: Outcome;
  summary: string;
  messageIds: number[];
  usage?: SessionUsage;
}

/** Which mail a session may pick up mid-run: its own work item's, plus mail that belongs to no work item. */
export interface InboxQuery {
  workItem?: number | "none";
}

export type SessionEventType =
  | "session_start" | "message" | "turn_start" | "turn_end" | "tool_start" | "tool_end" | "steer" | "log" | "artifact" | "session_end";

export interface SessionEventInput {
  /** Position within the session; unique per session, so a resent batch never duplicates. */
  seq: number;
  type: SessionEventType;
  data: Record<string, unknown>;
}

export interface SessionEventBatch {
  agent: string;
  sessionId: string;
  /** `wi:<id>` for a work item's session, `mail:<id>` for a session over messages that belong to none. */
  scope: string;
  events: SessionEventInput[];
}

export interface SessionEvent extends SessionEventInput {
  id: number;
  agent: string;
  sessionId: string;
  scope: string;
  traceId: string | null;
  createdAt: string;
}

export interface EventQuery {
  agent?: string;
  sessionId?: string;
  scope?: string;
  type?: SessionEventType;
  after?: number;
  limit?: number;
}

/** A tool call an earlier attempt at the same scope made, as the event log recorded it. */
export interface ToolAttempt {
  sessionId: string;
  callId: string;
  tool: string;
  replayable: boolean;
  args: unknown;
  /** `done`: finished. `failed`: finished with an error. `interrupted`: started, never finished (crash). */
  state: "done" | "failed" | "interrupted";
}

export interface WorkItemView {
  workItem: WorkItem;
  report: Report | null;
}

/** Agents and work items are named for what the controller turns into ax Task names (DNS-1123 label). */
export const AGENT_NAME = /^[a-z0-9]([-a-z0-9]{0,60}[a-z0-9])?$/;
/** Agents the pool creates for unaddressed goals are named `agent-<n>`. */
export const POOL_AGENT_PREFIX = "agent-";

/** Topics are named like agents: short DNS-1123 labels. */
export const TOPIC_NAME = AGENT_NAME;

export interface TopicInfo {
  topic: string;
  subscribers: string[];
}

export interface SubscribeRequest {
  agent: string;
}

export interface PublishRequest {
  from: string;
  body: string;
  /** At-most-once key per sender: a repeat delivers nothing new and reports the original fan-out. */
  requestId?: string;
}

export interface PublishResult {
  /** Copies delivered: one per subscriber other than the publisher. */
  delivered: number;
  /** Set only when `requestId` matched an earlier publish. */
  duplicate?: boolean;
}

/** Filters for reading the message log. Without `after` it returns the newest `limit` messages, oldest first. */
export interface MessageQuery {
  after?: number;
  limit?: number;
  topic?: string;
  /** Messages sent to or from this agent. */
  agent?: string;
}

export type AgentOp = "suspend" | "resume" | "delete";

export interface AgentOpResult {
  agent: string;
  /** The agent's state after the operation. */
  state: string;
}
