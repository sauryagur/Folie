// Controller: keeps the ax Task pool matched to demand.
//   wake   — agents with unread mail get a running task (create if missing, resume if suspended)
//   sweep  — quiet running agents are suspended (memory kept), long-quiet suspended ones are retired
//            (task deleted: memory gone), and dead ones are deleted
import type { Logger } from "../shared/logger";
import type { AxClient } from "./ax";
import type { AgentRepo } from "./store";
import type { EgressPolicies } from "./substrate";
import { AGENT_NAME, type AgentOp, type AgentOpResult } from "../shared/types";
import { contextFrom, storableTrace, withSpan } from "../shared/trace";
import { NotFoundError, ValidationError } from "./errors";
import type { AgentOps } from "./ops";
import { noopObservability, type Observability } from "../shared/telemetry";

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

export type ControllerAgents = Pick<AgentRepo, "wakeDemand" | "retrace" | "idle" | "setState" | "touch">;

export class Controller implements AgentOps {
  constructor(
    private readonly ax: AxClient,
    private readonly egress: EgressPolicies,
    private readonly agents: ControllerAgents,
    private readonly cfg: ControllerConfig,
    private readonly log: Logger = console,
    private readonly obs: Observability = noopObservability(),
  ) {}

  /** One pass. A failure on one agent never stops the others. */
  async reconcileOnce(): Promise<void> {
    for (const d of await this.agents.wakeDemand()) await this.guard("wake", d.name, () => this.wake(d.name, d));
    for (const name of await this.agents.idle("running", this.cfg.suspendAfterSec)) {
      await this.guard("suspend", name, () => this.suspend(name));
    }
    for (const name of await this.agents.idle("suspended", this.cfg.deleteAfterSec)) {
      await this.guard("retire", name, () => this.retire(name));
    }
  }

  /** Operator steering. Every op leaves the agent's recorded state matching ax, so the sweep does not fight it. */
  async run(op: AgentOp, name: string): Promise<AgentOpResult> {
    if (!AGENT_NAME.test(name)) throw new ValidationError("agent: invalid agent name");
    const { atespace } = this.cfg;
    const task = await this.ax.getTask(atespace, name);

    if (op === "delete") {
      if (task) await this.ax.deleteTask(atespace, name);
      await this.agents.setState(name, "retired");
      return { agent: name, state: "retired" };
    }
    if (op === "suspend") {
      if (!task) throw new NotFoundError(`${name} has no task`);
      if (task.phase === "Running") await this.ax.suspendTask(atespace, name);
      else if (task.phase !== "Suspended") throw new ValidationError(`${name} is ${task.phase}; cannot suspend`);
      await this.agents.setState(name, "suspended");
      return { agent: name, state: "suspended" };
    }
    // resume: restart the quiet period first, or the idle sweep would suspend the agent again on the next pass.
    await this.agents.touch(name);
    await this.wake(name);
    return { agent: name, state: "running" };
  }

  private async guard(what: string, name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.log.error(`controller: ${what} ${name} failed:`, e);
    }
  }

  /**
   * Brings the agent's task to Running. The span joins the trace of the mail that woke it (when known), so the trace
   * reads submission → wake → sandbox init → agent session even though suspend/resume spans processes.
   */
  private wake(name: string, cause?: { traceparent: string | null; tracestate: string | null }): Promise<void> {
    const parent = cause ? contextFrom(cause) : undefined;
    return withSpan(this.obs.tracer, "folie.controller.wake", { parent, attributes: { agent_name: name } }, () => this.bringUp(name));
  }

  private async bringUp(name: string): Promise<void> {
    const { atespace } = this.cfg;
    let task = await this.ax.getTask(atespace, name);
    if (task?.phase === "Running") return;
    await withSpan(this.obs.tracer, "folie.sandbox.init", { attributes: { agent_name: name } }, async () => {
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
      // Unread mail now points at this init span; the session the agent starts on resume becomes its child.
      await this.agents.retrace(name, storableTrace());
      this.log.log(`controller: resuming ${atespace}/${name}`);
      await this.ax.resumeTask(atespace, name);
      await this.agents.setState(name, "running");
    });
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
