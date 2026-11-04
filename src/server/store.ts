// Persistence ports. The service and controller depend on these, never on SQL.
import type { AgentInfo, Message, Outcome, Report, TopicInfo, WorkItem, WorkItemState } from "../shared/types";

export interface MessageRepo {
  send(m: { from: string; to: string; body: string; workItemId?: number }): Promise<Message>;
  unacked(to: string): Promise<Message[]>;
  /** Acks exactly the given unacked messages of `to`; returns those actually acked. */
  ack(to: string, ids: number[]): Promise<Message[]>;
}

export interface WorkItemRepo {
  create(goal: string, state: WorkItemState): Promise<WorkItem>;
  get(id: number): Promise<WorkItem | null>;
  setState(ids: number[], state: WorkItemState): Promise<void>;
  /** Oldest work item still waiting for an agent. */
  oldestQueued(): Promise<WorkItem | null>;
  /** Newest report from a session that consumed any message of this work item. */
  latestReport(id: number): Promise<Report | null>;
}

export interface AgentRepo {
  /** Creates the agent if missing and records activity now (mail in, report out). */
  touch(name: string): Promise<void>;
  list(): Promise<AgentInfo[]>;
  /** Names of agents with at least one unacked message: the wake demand. */
  withUnread(): Promise<string[]>;
  /** Names in `state` with no unread mail and no activity for at least `seconds`. */
  idle(state: string, seconds: number): Promise<string[]>;
  setState(name: string, state: string): Promise<void>;
}

export interface ReportRepo {
  record(r: { agent: string; startedAt: string; outcome: Outcome; summary: string; messageIds: number[] }): Promise<Report>;
}

export interface TopicRepo {
  /** Idempotent. The agent must exist. Subscriptions outlive suspension and retirement: delivery is durable, not live. */
  subscribe(topic: string, agent: string): Promise<void>;
  unsubscribe(topic: string, agent: string): Promise<void>;
  /** Copies the message into the inbox of every subscriber except `from`; returns the copies. */
  publish(topic: string, from: string, body: string): Promise<Message[]>;
  /** Topics that have at least one subscriber. */
  list(): Promise<TopicInfo[]>;
}

export interface Repos {
  messages: MessageRepo;
  workItems: WorkItemRepo;
  agents: AgentRepo;
  reports: ReportRepo;
  topics: TopicRepo;
}

export interface Store extends Repos {
  /** Runs fn with repos bound to one atomic unit of work. */
  transaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T>;
}
