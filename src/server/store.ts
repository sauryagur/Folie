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
  GoalEvaluation,
  VerificationRecord,
  BudgetRecord,
  TaskRecord,
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
  /** Leases unacked messages of `to` to a session; returns those actually leased. */
  lease(to: string, ids: number[], sessionId: number): Promise<Message[]>;
  /** The audit log, ascending by id, capped at `limit` (default 100, max 500). See MessageQuery. */
  list(q: MessageQuery): Promise<Message[]>;
}

export interface SessionRecord {
  id: number;
  sessionId: string;
  agent: string;
  state: string;
  outcome: string | null;
  workItemId: number | null;
  startedAt: string;
  endedAt: string | null;
  clientRequestId: string | null;
}

export interface SessionRepo {
  /** Creates a running session; returns it. Server-generated id is the session id. */
  create(b: { agent: string; startedAt: string; messageIds: number[]; workItemId?: number; clientRequestId?: string; publicId?: string }): Promise<SessionRecord>;
  get(id: number): Promise<SessionRecord | null>;
  getByPublicId(publicId: string): Promise<SessionRecord | null>;
  getByClientRequest(agent: string, clientRequestId: string): Promise<SessionRecord | null>;
  settle(id: number, outcome: string): Promise<SessionRecord | null>;
}
export interface TaskRepo {
  propose(b: { workItemId: number; title: string; spec: Record<string, unknown> }): Promise<TaskRecord>;
  get(id: number): Promise<TaskRecord | null>;
  /** Single conditional claim: available -> claimed with fence+1. Returns null on conflict. */
  claim(taskId: number, agent: string, leaseMs: number): Promise<{ task: TaskRecord; fence: number } | null>;
  start(taskId: number, fence: number): Promise<TaskRecord | null>;
  submit(taskId: number, fence: number, result: Record<string, unknown>): Promise<TaskRecord | null>;
}

export interface ExecutionRegistryRepo {
  record(r: { id: string; agent: string; generation: number; state: string; providerRef?: unknown }): Promise<void>;
  get(id: string): Promise<{ id: string; agent: string; state: string; epoch: number } | null>;
  listLive(): Promise<{ id: string; agent: string; state: string }[]>;
  setState(id: string, state: string): Promise<void>;
  markLostForAgent(agent: string): Promise<void>;
}
export interface BudgetRepo {
  create(b: { parentId?: number; name: string; limitAmount: number; dim: string }): Promise<BudgetRecord>;
  get(id: number): Promise<BudgetRecord | null>;
  /** Carve-out: single conditional reservation of parent headroom. */
  carveOut(parentId: number, name: string, limitAmount: number): Promise<BudgetRecord | null>;
  /** Commit usage; flips exhausted on overrun. */
  commit(budgetId: number, amount: number, basis: "estimated" | "measured" | "external_charge"): Promise<BudgetRecord | null>;
  /** Close: return unspent to parent and mark closed. */
  close(budgetId: number): Promise<BudgetRecord | null>;
}
export interface VerificationRepo {
  request(b: { taskId: number; check: string; verifier: string; required: boolean }): Promise<VerificationRecord>;
  get(id: number): Promise<VerificationRecord | null>;
  recordVerdict(b: { verificationId: number; verdict: string; confidence: number; evidence: string[] }): Promise<VerificationRecord | null>;
  listForTask(taskId: number): Promise<VerificationRecord[]>;
}

export interface GoalEvaluationRepo {
  record(b: { workItemId: number; verdict: string; caveats: string[] }): Promise<GoalEvaluation>;
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
  /** Explicit operator registration: creates the agent row (or returns the existing one). */
  register(name: string): Promise<AgentInfo>;
  /** Returns the agent row or null. */
  get(name: string): Promise<AgentInfo | null>;
  /** Returns the agent row or null. */
  find(name: string): Promise<AgentInfo | null>;
  list(): Promise<AgentInfo[]>;
  /** Agents with at least one unacked message: the wake demand, in name order. */
  wakeDemand(): Promise<WakeDemand[]>;
  /** Re-parents an agent's unread mail onto `trace` (the wake that is bringing the agent up), so its session joins that span. */
  retrace(name: string, trace: StoredTrace): Promise<void>;
  /** Names in `state` with no unread mail and no activity for at least `seconds`. */
  idle(state: string, seconds: number): Promise<string[]>;
  setState(name: string, state: string): Promise<void>;
  bumpCredentialGeneration(name: string): Promise<void>;
}

// --- Auth ports ---

export interface AuthPrincipal {
  kind: "agent" | "operator";
  /** For agents: the agent name. For operators: "operator". */
  name: string;
  /** Agent credential generation the token is bound to, if any. */
  generation?: number;
  /** Execution id this token is bound to, if any. */
  executionId?: string;
}

export interface AuthRepo {
  /** Hashes and stores a new bearer token; returns the opaque token to give to the caller/execution. */
  mintAgentToken(agent: string, executionId: string, generation: number): Promise<string>;
  /** Set the operator token (hash only). */
  setOperatorToken(token: string): Promise<void>;
  /** Find a token by hash; returns the token row fields or null. */
  findByHash(hash: string): Promise<{ principal: string; kind: "agent" | "operator"; agentName: string | null; executionId: string | null; generation: number; revokedAt: string | null } | null>;
  /** Revoke all agent tokens for an agent (revocation bumps generation, caller decides). */
  revokeAgentTokens(agent: string): Promise<void>;
  /** Revoke a single token by hash. */
  revokeByHash(hash: string): Promise<void>;
  /** Upsert the execution binding and generation. */
  upsertExecution(agent: string, executionId: string, generation: number, state?: string): Promise<void>;
  /** Mark an execution terminated/lost/etc. */
  setExecutionState(executionId: string, state: string): Promise<void>;
  /** Read an execution. */
  getExecution(executionId: string): Promise<{ agentName: string; state: string; generation: number } | null>;
  /** Read an agent's credential generation and status. */
  getAgentCredential(agent: string): Promise<{ generation: number; status: string } | null>;
}

export interface ReportRepo {
  record(r: { agent: string; startedAt: string; outcome: Outcome; summary: string; messageIds: number[]; usage?: SessionUsage; sessionId?: number }): Promise<Report>;
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
  auth: AuthRepo;
  sessions: SessionRepo;
  registry: ExecutionRegistryRepo;
  tasks: TaskRepo;
  budgets: BudgetRepo;
  verifications: VerificationRepo;
  goalEvaluations: GoalEvaluationRepo;
}

export interface Store extends Repos {
  /** Runs fn with repos bound to one atomic unit of work. */
  transaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T>;
}
