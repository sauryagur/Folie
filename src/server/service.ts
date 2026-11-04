// The swarm's business rules. Every wake, delegation and report passes through here.
import {
  AGENT_NAME,
  type AgentInfo,
  type Message,
  type Report,
  type SendMessageRequest,
  type SubmitGoalRequest,
  type SubmitReportRequest,
  type WorkItem,
  type WorkItemView,
} from "../shared/types";
import { NotFoundError, ValidationError } from "./errors";
import { choosePoolAgent } from "./pool";
import type { Store } from "./store";

function agentName(v: unknown, field: string): string {
  if (typeof v !== "string" || !AGENT_NAME.test(v)) throw new ValidationError(`${field}: invalid agent name`);
  return v;
}

function text(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError(`${field}: required`);
  return v;
}

export class SwarmService {
  constructor(private readonly store: Store) {}

  /**
   * A goal is a message from the human; that message is what wakes the agent. With `to` it goes straight
   * to that agent. Without, it waits in the queue until `dispatchQueued` finds the pool an agent for it.
   */
  async submitGoal(req: SubmitGoalRequest): Promise<{ workItem: WorkItem; message: Message | null }> {
    const goal = text(req.goal, "goal");
    if (req.to === undefined) {
      return { workItem: await this.store.workItems.create(goal, "queued"), message: null };
    }
    const to = agentName(req.to, "to");
    return this.store.transaction(async (r) => {
      await r.agents.touch(to);
      const workItem = await r.workItems.create(goal, "assigned");
      const message = await r.messages.send({ from: "human", to, body: goal, workItemId: workItem.id });
      return { workItem, message };
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
      await r.agents.touch(to);
      await r.messages.send({ from: "human", to, body: item.goal, workItemId: item.id });
      await r.workItems.setState([item.id], "assigned");
      return true;
    });
  }

  /** Peer delegation and controller notices: sending to an unknown agent creates it. */
  async send(req: SendMessageRequest): Promise<Message> {
    const from = text(req.from, "from");
    const to = agentName(req.to, "to");
    const body = text(req.body, "body");
    return this.store.transaction(async (r) => {
      await r.agents.touch(to);
      return r.messages.send({ from, to, body });
    });
  }

  async inbox(agent: string): Promise<Message[]> {
    return this.store.messages.unacked(agentName(agent, "agent"));
  }

  listAgents(): Promise<AgentInfo[]> {
    return this.store.agents.list();
  }

  /** Records the session, acks what it consumed, and settles the work items behind those messages. */
  async submitReport(req: SubmitReportRequest): Promise<Report> {
    if (!Array.isArray(req.messageIds)) throw new ValidationError("messageIds: array required");
    const agent = agentName(req.agent, "agent");
    if (req.outcome !== "done" && req.outcome !== "failed") throw new ValidationError("outcome: must be done|failed");
    const summary = text(req.summary, "summary");
    const startedAt = new Date(text(req.startedAt, "startedAt"));
    if (Number.isNaN(startedAt.getTime())) throw new ValidationError("startedAt: invalid timestamp");
    const ids = [...new Set(req.messageIds)];
    if (ids.length === 0 || !ids.every(Number.isInteger)) throw new ValidationError("messageIds: non-empty integers required");

    return this.store.transaction(async (r) => {
      const acked = await r.messages.ack(agent, ids);
      if (acked.length !== ids.length) throw new ValidationError("messageIds: not all are unacked messages of this agent");
      const report = await r.reports.record({ agent, startedAt: startedAt.toISOString(), outcome: req.outcome, summary, messageIds: ids });
      await r.agents.touch(agent); // finishing a session is activity: the quiet period starts now
      const itemIds = [...new Set(acked.flatMap((m) => (m.workItemId === null ? [] : [m.workItemId])))];
      // One-shot failure: a failed session parks its work in 'blocked'; there is no retry.
      if (itemIds.length) await r.workItems.setState(itemIds, req.outcome === "done" ? "done" : "blocked");
      return report;
    });
  }

  async workItem(id: number): Promise<WorkItemView> {
    const workItem = await this.store.workItems.get(id);
    if (!workItem) throw new NotFoundError(`work item ${id}`);
    return { workItem, report: await this.store.workItems.latestReport(id) };
  }
}
