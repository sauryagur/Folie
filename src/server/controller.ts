// Controller: keeps the execution pool matched to demand, over an ExecutionProvider port (ax today).
//   wake   — agents with unread mail get a running execution (ensure if missing, start if suspended)
//   sweep  — quiet running agents are suspended (workspace stored at the provider when supported),
//            long-quiet suspended ones are retired, and dead ones are reconciled
// Reconciliation reads the provider's actual state via list() once per pass (R-6.2).
import type { Logger } from "../shared/logger";
import type {
  ExecutionProvider,
  ExecutionState,
  ExecutionSpec,
  NetworkPolicy,
  ProviderRef,
} from "./provider";
import type { AgentRepo, AuthRepo, ExecutionRegistryRepo } from "./store";
import { AGENT_NAME, type AgentOp, type AgentOpResult } from "../shared/types";
import { contextFrom, storableTrace, withSpan } from "../shared/trace";
import { NotFoundError, ValidationError } from "./errors";
import type { AgentOps } from "./ops";
import { noopObservability, type Observability } from "../shared/telemetry";
import { generateExecutionId } from "./auth";

export interface ControllerConfig {
  namespace: string;
  image: string;
  command: string[];
  /** Env every agent starts with (server URL, LLM key, ...). The agent name and token are added per execution. */
  env: Record<string, string>;
  /** Optional resource limits passed to the provider. */
  resources?: { cpu?: string; memory?: string };
  /** Quiet period before a running agent is suspended. */
  suspendAfterSec: number;
  /** Quiet period before a suspended agent is retired. Counts from last activity, so it must exceed suspendAfterSec. */
  deleteAfterSec: number;
}

export type ControllerAgents = Pick<
  AgentRepo,
  "wakeDemand" | "retrace" | "idle" | "setState" | "touch"
>;
export type ControllerAuth = Pick<
  AuthRepo,
  | "mintAgentToken"
  | "upsertExecution"
  | "setExecutionState"
  | "getAgentCredential"
  | "revokeAgentTokens"
>;
export type ControllerRegistry = Pick<
  ExecutionRegistryRepo,
  "record" | "listLive" | "setState" | "markLostForAgent" | "get"
>;

export class Controller implements AgentOps {
  constructor(
    private readonly provider: ExecutionProvider,
    private readonly agents: ControllerAgents,
    private readonly cfg: ControllerConfig,
    private readonly log: Logger = console,
    private readonly obs: Observability = noopObservability(),
    private readonly auth?: ControllerAuth,
    private readonly registry?: ControllerRegistry,
  ) {}

  /** One pass. A failure on one agent never stops the others. */
  async reconcileOnce(): Promise<void> {
    // Actual provider state, read once: the sweep and wakes reconcile against it instead of per-agent gets.
    const snapshot = new Map<string, ExecutionState>();
    for await (const st of this.provider.list(this.cfg.namespace))
      snapshot.set(st.ref.key, st);
    for (const d of await this.agents.wakeDemand())
      await this.guard("wake", d.name, () => this.wake(d.name, d, snapshot));
    const suspendAfter = await this.agents.idle(
      "running",
      this.cfg.suspendAfterSec,
    );
    for (const name of suspendAfter)
      await this.guard("suspend", name, async () =>
        this.suspend(
          name,
          snapshot.get(name) ?? (await this.inspectAgent(name)),
        ),
      );
    const deleteAfter = await this.agents.idle(
      "suspended",
      this.cfg.deleteAfterSec,
    );
    for (const name of deleteAfter)
      await this.guard("retire", name, async () =>
        this.retire(
          name,
          snapshot.get(name) ?? (await this.inspectAgent(name)),
        ),
      );
    // Ghost detection (R-6.3): a recorded running execution the provider no longer reports is lost.
    // Provisioning rows are excluded: ensure() may not have landed yet on this pass.
    if (this.registry) {
      for (const live of await this.registry.listLive().catch(() => [])) {
        if (!snapshot.has(live.agent) && live.state === "running") {
          await this.registry.setState(live.id, "lost").catch(() => undefined);
          this.log.log(
            `controller: ${live.agent} execution ${live.id} lost (not reported by provider)`,
          );
        }
      }
    }
  }

  /** Operator steering. Every op leaves the agent's recorded state matching the provider, so the sweep does not fight it. */
  async run(op: AgentOp, name: string): Promise<AgentOpResult> {
    if (!AGENT_NAME.test(name))
      throw new ValidationError("agent: invalid agent name");
    const ref = this.refOf(name);

    if (op === "delete") {
      // The agent may already be gone: delete of an absent execution still records it retired.
      const st = await this.inspectAgent(name);
      if (st) await this.provider.terminate(ref, { destroyWorkspace: true });
      await this.agents.setState(name, "retired");
      // Revoke execution token(s); agent identity remains but stale tokens must fail.
      if (this.auth)
        await this.auth.revokeAgentTokens(name).catch(() => undefined);
      return { agent: name, state: "retired" };
    }
    if (op === "suspend") {
      const st = await this.inspectAgent(name);
      if (!st) throw new NotFoundError(`${name} has no task`);
      if (st.phase === "running") await this.provider.suspend(ref);
      else if (st.phase !== "suspended")
        throw new ValidationError(`${name} is ${st.phase}; cannot suspend`);
      await this.agents.setState(name, "suspended");
      return { agent: name, state: "suspended" };
    }
    // resume: restart the quiet period first, or the idle sweep would suspend the agent again on the next pass.
    await this.agents.touch(name);
    await this.wake(name);
    return { agent: name, state: "running" };
  }

  private refOf(key: string): ProviderRef {
    return { key, namespace: this.cfg.namespace };
  }

  private inspectAgent(name: string): Promise<ExecutionState | null> {
    return this.provider.inspect(this.refOf(name));
  }

  private async guard(what: string, name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.log.error(`controller: ${what} ${name} failed:`, e);
    }
  }

  /**
   * Brings the agent's execution to running. The span joins the trace of the mail that woke it (when known), so the
   * trace reads submission → wake → sandbox init → agent session even though suspend/resume spans processes.
   * Nothing is traced when there is nothing to do: an agent with unread mail is seen on every pass while it works.
   */
  private async wake(
    name: string,
    cause?: { traceparent: string | null; tracestate: string | null },
    snapshot?: Map<string, ExecutionState>,
  ): Promise<void> {
    const st = snapshot?.get(name) ?? (await this.inspectAgent(name));
    if (st?.phase === "running") return;
    if (st && st.phase !== "suspended" && st.phase !== "provisioning") {
      // failed/unknown/transitional executions: leave visible rather than guess. Only the idle sweep deletes dead ones.
      this.log.log(
        `controller: ${this.cfg.namespace}/${name} is ${st.phase}; not waking`,
      );
      return;
    }
    const parent = cause ? contextFrom(cause) : undefined;
    await withSpan(
      this.obs.tracer,
      "folie.controller.wake",
      { parent, attributes: { agent_name: name } },
      () =>
        withSpan(
          this.obs.tracer,
          "folie.sandbox.init",
          { attributes: { agent_name: name } },
          async () => {
            const ref = this.refOf(name);
            let executionId: string | undefined;
            if (!st) {
              this.log.log(
                `controller: creating ${this.cfg.namespace}/${name}`,
              );
              // Mint a per-execution bearer token BEFORE creating the execution: it is injected via env so the new process authenticates.
              if (this.auth) {
                const cred = await this.auth
                  .getAgentCredential(name)
                  .catch(() => null);
                const generation = cred?.generation ?? 1;
                executionId = generateExecutionId();
                const token = await this.auth.mintAgentToken(
                  name,
                  executionId,
                  generation,
                );
                await this.auth.upsertExecution(
                  name,
                  executionId,
                  generation,
                  "running",
                );
                if (this.registry)
                  await this.registry
                    .record({
                      id: executionId,
                      agent: name,
                      generation,
                      state: "running",
                      providerRef: { key: name, namespace: this.cfg.namespace },
                    })
                    .catch(() => undefined);
                await this.provider.ensure(
                  this.specFor(name, token, executionId),
                );
              } else {
                await this.provider.ensure(this.specFor(name));
              }
            } else if (this.auth) {
              // Execution exists (suspended/provisioning): its env is fixed from creation, so the original token stays valid.
            }
            // The provider denies all egress until the actor has a policy. Granting it before start is idempotent, so a
            // crash between ensure and start heals on the next pass instead of waking a mute agent.
            await this.provider.setNetworkPolicy(ref, {
              profile: "full-trust",
            });
            // Unread mail now points at this init span; the session the agent starts on resume becomes its child.
            await this.agents.retrace(name, storableTrace());
            try {
              await this.provider.start(ref);
              await this.agents.setState(name, "running");
              if (this.registry && executionId)
                await this.registry
                  .setState(executionId, "running")
                  .catch(() => undefined);
              if (this.registry) {
                const live = await this.registry.listLive().catch(() => []);
                for (const e of live) {
                  if (e.agent === name)
                    await this.registry
                      .setState(e.id, "running")
                      .catch(() => undefined);
                }
              }
            } catch (e) {
              this.log.error(
                `controller: start ${this.cfg.namespace}/${name} failed:`,
                e,
              );
            }
            this.log.log(`controller: resumed ${this.cfg.namespace}/${name}`);
          },
        ),
    );
  }

  /** Execution spec for an agent; the key is stable so ensure stays idempotent across passes. Each agent is bound to
   *  a durable provider workspace `<key>-ws` (R-6.2): task termination then never destroys the agent's files. */
  private specFor(key: string, ...tokens: string[]): ExecutionSpec {
    const [agentToken, executionId] = tokens;
    return {
      key,
      namespace: this.cfg.namespace,
      image: this.cfg.image,
      command: this.cfg.command,
      env: {
        ...this.cfg.env,
        FOLIE_AGENT: key,
        ...(agentToken
          ? { FOLIE_AGENT_TOKEN: agentToken, FOLIE_EXECUTION_ID: executionId }
          : {}),
      },
      ...(this.cfg.resources ? { resources: this.cfg.resources } : {}),
      workspace: { ref: `${key}-ws` },
      network: { profile: "full-trust" },
    };
  }

  /** A quiet agent whose execution is running is checkpointed; one whose execution is gone or dead is reconciled instead. */
  private async suspend(
    name: string,
    st: ExecutionState | null,
  ): Promise<void> {
    if (!st) return this.agents.setState(name, "retired");
    if (st.phase === "suspended")
      return this.agents.setState(name, "suspended");
    if (st.phase === "failed") return this.retire(name, st);
    if (st.phase !== "running") return; // provisioning/unknown: transitional, look again next pass
    this.log.log(
      `controller: suspending ${this.cfg.namespace}/${name} (quiet)`,
    );
    await this.provider.suspend(this.refOf(name));
    await this.agents.setState(name, "suspended");
  }

  /** Terminating destroys the task workspace, so only an idle or failed execution is ever retired. */
  private async retire(name: string, st: ExecutionState | null): Promise<void> {
    if (st && st.phase !== "suspended" && st.phase !== "failed") return;
    if (st) {
      this.log.log(
        `controller: retiring ${this.cfg.namespace}/${name} (${st.phase})`,
      );
      await this.provider.terminate(this.refOf(name), {
        destroyWorkspace: true,
      });
    }
    await this.agents.setState(name, "retired");
  }
}
