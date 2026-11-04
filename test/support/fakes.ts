import type { AxClient, AxTaskSpec } from "../../src/server/ax";
import type { EgressPolicies } from "../../src/server/substrate";
import type { Logger } from "../../src/shared/logger";

export const silent: Logger = { log: () => {}, error: () => {} };

/** In-memory ax: tasks by "<atespace>/<name>", phase as ax reports it. New tasks start Suspended, like ax. */
export class FakeAx implements AxClient {
  readonly tasks = new Map<string, { spec: AxTaskSpec; phase: string; actor: string }>();
  readonly calls: string[] = [];
  failFor = new Set<string>();

  private key = (atespace: string, name: string) => `${atespace}/${name}`;

  async getTask(atespace: string, name: string) {
    const t = this.tasks.get(this.key(atespace, name));
    return t ? { phase: t.phase, actor: t.actor } : null;
  }

  async createTask(spec: AxTaskSpec) {
    if (this.failFor.has(spec.name)) throw new Error(`ax refused ${spec.name}`);
    this.calls.push(`create ${spec.name}`);
    this.tasks.set(this.key(spec.atespace, spec.name), { spec, phase: "Suspended", actor: spec.name });
  }

  async resumeTask(atespace: string, name: string) {
    this.calls.push(`resume ${name}`);
    const t = this.tasks.get(this.key(atespace, name));
    if (!t) throw new Error("no such task");
    t.phase = "Running";
  }

  async suspendTask(atespace: string, name: string) {
    this.calls.push(`suspend ${name}`);
    const t = this.tasks.get(this.key(atespace, name));
    if (!t) throw new Error("no such task");
    t.phase = "Suspended";
  }

  async deleteTask(atespace: string, name: string) {
    this.calls.push(`delete ${name}`);
    if (!this.tasks.delete(this.key(atespace, name))) throw new Error("no such task");
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
