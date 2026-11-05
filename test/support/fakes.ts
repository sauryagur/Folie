import type { EgressPolicies } from "../../src/server/substrate";
import type { ExecutionProvider, ExecutionSpec, ExecutionState, NetworkPolicy, ProviderRef } from "../../src/server/provider";
import type { Logger } from "../../src/shared/logger";

export const silent: Logger = { log: () => {}, error: () => {} };

/** ax phase names as the control plane reports them. */
function executionPhase(raw: string): ExecutionState["phase"] {
  const m: Record<string, ExecutionState["phase"]> = { Running: "running", Suspended: "suspended", Failed: "failed", Pending: "provisioning", Terminating: "unknown", Completed: "unknown" };
  return m[raw] ?? "unknown";
}

/** In-memory ax: tasks keyed "<namespace>/<name>", phase exactly as ax reports it. Created tasks start Pending, like ax. */
export class FakeAx implements ExecutionProvider {
  readonly tasks = new Map<string, { spec: ExecutionSpec; phase: string; actor: string }>();
  readonly calls: string[] = [];
  readonly egress: EgressPolicies & { failFor: Set<string> };
  failFor = new Set<string>();
  readonly capabilities = { suspend: true, checkpoint: true, list: true, resourceLimits: true, network: "allowlist" as const, logs: false, inFlightCancel: false };

  constructor(egress?: EgressPolicies) {
    // The grant shares this call log so create/egress/resume ordering stays assertable through ax.calls alone.
    this.egress = (egress as EgressPolicies & { failFor: Set<string> }) ?? new FakeEgress(this.calls);
  }

  private key = (ref: ProviderRef) => `${ref.namespace}/${ref.key}`;
  private state(ref: ProviderRef): ExecutionState | null {
    const t = this.tasks.get(this.key(ref));
    return t ? { ref, phase: executionPhase(t.phase), since: new Date().toISOString() } : null;
  }

  async inspect(ref: ProviderRef) {
    return this.state(ref);
  }

  async *list(namespace: string) {
    for (const [k, t] of this.tasks) {
      const i = k.indexOf("/");
      if (k.slice(0, i) !== namespace) continue;
      yield { ref: { namespace, key: k.slice(i + 1) }, phase: executionPhase(t.phase), since: new Date().toISOString() };
    }
  }

  async ensure(spec: ExecutionSpec): Promise<ExecutionState> {
    const ref = { key: spec.key, namespace: spec.namespace };
    if (this.failFor.has(spec.key)) throw new Error(`provider refused ${spec.key}`);
    const existing = this.state(ref);
    if (existing) return existing;
    if (!spec.workspace) throw new Error(`task ${spec.key} binds no workspace (R-6.2)`);
    this.calls.push(`workspace ${spec.workspace.ref}`);
    this.calls.push(`create ${spec.key}`);
    this.tasks.set(this.key(ref), { spec, phase: "Pending", actor: spec.key });
    return { ref, phase: "provisioning", since: new Date().toISOString() };
  }

  async start(ref: ProviderRef) {
    this.calls.push(`resume ${ref.key}`);
    const t = this.tasks.get(this.key(ref));
    if (!t) throw new Error("no such task");
    t.phase = "Running";
    return this.state(ref)!;
  }

  async suspend(ref: ProviderRef) {
    this.calls.push(`suspend ${ref.key}`);
    const t = this.tasks.get(this.key(ref));
    if (!t) throw new Error("no such task");
    t.phase = "Suspended";
    return this.state(ref)!;
  }

  async terminate(ref: ProviderRef, o: { destroyWorkspace: boolean }) {
    this.calls.push(`delete ${ref.key}`);
    if (!o.destroyWorkspace) throw new Error("refusing: no destroy");
    if (!this.tasks.delete(this.key(ref))) throw new Error("no such task");
  }

  async setNetworkPolicy(ref: ProviderRef, policy: NetworkPolicy) {
    if (policy.profile !== "full-trust") throw new Error(`policy ${policy.profile} not supported`);
    const actor = this.tasks.get(this.key(ref))?.actor ?? ref.key;
    await this.egress.ensureAllowAll(ref.namespace, actor);
  }
}

/** Records grants into the same call log as FakeAx so ordering against create/resume is assertable. */
export class FakeEgress implements EgressPolicies {
  failFor = new Set<string>();
  constructor(private readonly calls: string[]) {}

  async ensureAllowAll(atespace: string, actor: string) {
    if (this.failFor.has(actor)) throw new Error(`substrate refused ${actor}`);
    this.calls.push(`egress ${atespace}/${actor}`);
  }
}
