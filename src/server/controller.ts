// Controller: keeps the ax Task pool matched to demand.
//   wake   — agents with unread mail get a running task (create if missing, resume if suspended)
//   sweep  — quiet running agents are suspended (memory kept), long-quiet suspended ones are retired
//            (task deleted: memory gone), and dead ones are deleted
import type { Logger } from "../shared/logger";
import type { AxClient } from "./ax";
import type { AgentRepo } from "./store";
import type { EgressPolicies } from "./substrate";

export interface ControllerConfig {
  atespace: string;
  image: string;
  command: string[];
  /** Env every agent task starts with (server URL, LLM key, ...). The agent name is added per task. */
  env: Record<string, string>;
  /** Quiet period before a running agent is suspended. */
  suspendAfterSec: number;
  /** Quiet period before a suspended agent is retired. Counts from last activity, so it must exceed suspendAfterSec. */
  deleteAfterSec: number;
}

export type ControllerAgents = Pick<AgentRepo, "withUnread" | "idle" | "setState">;

export class Controller {
  constructor(
    private readonly ax: AxClient,
    private readonly egress: EgressPolicies,
    private readonly agents: ControllerAgents,
    private readonly cfg: ControllerConfig,
    private readonly log: Logger = console,
  ) {}

  /** One pass. A failure on one agent never stops the others. */
  async reconcileOnce(): Promise<void> {
    for (const name of await this.agents.withUnread()) await this.guard("wake", name, () => this.wake(name));
    for (const name of await this.agents.idle("running", this.cfg.suspendAfterSec)) {
      await this.guard("suspend", name, () => this.suspend(name));
    }
    for (const name of await this.agents.idle("suspended", this.cfg.deleteAfterSec)) {
      await this.guard("retire", name, () => this.retire(name));
    }
  }

  private async guard(what: string, name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.log.error(`controller: ${what} ${name} failed:`, e);
    }
  }

  private async wake(name: string): Promise<void> {
    const { atespace } = this.cfg;
    let task = await this.ax.getTask(atespace, name);
    if (task?.phase === "Running") return;
    if (!task) {
      this.log.log(`controller: creating ${atespace}/${name}`);
      await this.ax.createTask({
        atespace,
        name,
        image: this.cfg.image,
        command: this.cfg.command,
        env: { ...this.cfg.env, FOLIE_AGENT: name },
      });
      task = await this.ax.getTask(atespace, name);
      if (!task) throw new Error(`ax created ${atespace}/${name} but cannot find it`);
    } else if (task.phase !== "Suspended") {
      // Failed/transitional tasks: leave visible rather than guess. Only the idle sweep deletes dead tasks.
      this.log.log(`controller: ${atespace}/${name} is ${task.phase}; not waking`);
      return;
    }
    // Substrate denies all egress until the actor has a policy and ax sets none. Granting it before resume is
    // idempotent, so a crash between create and resume heals on the next pass instead of waking a mute agent.
    await this.egress.ensureAllowAll(atespace, task.actor);
    this.log.log(`controller: resuming ${atespace}/${name}`);
    await this.ax.resumeTask(atespace, name);
    await this.agents.setState(name, "running");
  }

  /** A quiet agent whose task is Running is checkpointed; one whose task is gone or dead is reconciled instead. */
  private async suspend(name: string): Promise<void> {
    const { atespace } = this.cfg;
    const task = await this.ax.getTask(atespace, name);
    if (!task) return this.agents.setState(name, "retired");
    if (task.phase === "Suspended") return this.agents.setState(name, "suspended");
    if (task.phase === "Failed") return this.retire(name);
    if (task.phase !== "Running") return; // transitional: look again next pass
    this.log.log(`controller: suspending ${atespace}/${name} (quiet)`);
    await this.ax.suspendTask(atespace, name);
    await this.agents.setState(name, "suspended");
  }

  /** Deleting destroys /workspace, so only a task that is not running is ever deleted. */
  private async retire(name: string): Promise<void> {
    const { atespace } = this.cfg;
    const task = await this.ax.getTask(atespace, name);
    if (task && task.phase !== "Suspended" && task.phase !== "Failed") return;
    if (task) {
      this.log.log(`controller: retiring ${atespace}/${name} (${task.phase})`);
      await this.ax.deleteTask(atespace, name);
    }
    await this.agents.setState(name, "retired");
  }
}
