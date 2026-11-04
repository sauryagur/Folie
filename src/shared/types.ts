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
}

export interface WorkItem {
  id: number;
  goal: string;
  state: WorkItemState;
  createdAt: string;
}

export interface Report {
  id: number;
  agent: string;
  outcome: Outcome;
  summary: string;
  messageIds: number[];
  createdAt: string;
}

export interface AgentInfo {
  name: string;
  state: string;
  wakeEpoch: number;
  unread: number;
}

export interface SubmitGoalRequest {
  goal: string;
  to?: string;
}

export interface SendMessageRequest {
  from: string;
  to: string;
  body: string;
}

export interface SubmitReportRequest {
  agent: string;
  startedAt: string;
  outcome: Outcome;
  summary: string;
  messageIds: number[];
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
}

export interface PublishResult {
  /** Copies delivered: one per subscriber other than the publisher. */
  delivered: number;
}
