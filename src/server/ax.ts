// The ax adapter: ExecutionProvider over ax's gRPC API (pkg/apis/v1alpha1/ax.proto, bundled in proto/).
// Network policy is delegated to the Substrate EgressPolicies port; ax tasks carry no network spec.
// API notes verified against current ax: UpdateWorkspace upserts (no CreateWorkspace RPC);
// created tasks start in Pending; TaskStatus.phase is one of Suspended|Pending|Running|Terminating|Failed|Completed.
import * as grpc from "@grpc/grpc-js";
import { callUnary, isGrpcStatus, loadService } from "./grpc";
import type {
  ExecutionCapabilities,
  ExecutionPhase,
  ExecutionProvider,
  ExecutionSpec,
  ExecutionState,
  NetworkPolicy,
  ProviderRef,
} from "./provider";
import type { EgressPolicies } from "./substrate";

interface TaskLike {
  metadata?: { name?: string; atespace?: string };
  status?: { phase?: string; actor?: string };
}

function toExecutionState(t: TaskLike): ExecutionState | null {
  const name = t.metadata?.name;
  const namespace = t.metadata?.atespace;
  if (!name || !namespace) return null;
  const phaseMap: Record<string, ExecutionPhase> = {
    Running: "running",
    Suspended: "suspended",
    Failed: "failed",
    Pending: "provisioning",
    // Transitional out of Folie's control; the controller logs and leaves them alone.
    Terminating: "unknown",
    Completed: "unknown",
    "": "provisioning",
  };
  const ref: ProviderRef = { key: name, namespace };
  return { ref, phase: phaseMap[t.status?.phase ?? ""] ?? "unknown", since: new Date().toISOString() };
}

export function grpcAxClient(address: string, egress: EgressPolicies, protoDir?: string): ExecutionProvider {
  const AX = loadService("ax.proto", ["ax", "v1alpha1", "AX"], protoDir);
  const c = new AX(address, grpc.credentials.createInsecure());
  const capabilities: ExecutionCapabilities = {
    suspend: true,
    checkpoint: true,
    list: true,
    resourceLimits: true,
    network: "allowlist",
    logs: false,
    inFlightCancel: false,
  };

  const inspectLike = async (ref: ProviderRef): Promise<ExecutionState | null> => {
    try {
      const t = await callUnary<TaskLike, { atespace: string; name: string }>(c, "GetTask", { atespace: ref.namespace, name: ref.key });
      return toExecutionState(t as unknown as TaskLike);
    } catch (err) {
      if (isGrpcStatus(err, grpc.status.NOT_FOUND)) return null;
      throw err;
    }
  };

  return {
    capabilities,
    async ensure(spec: ExecutionSpec) {
      const ref: ProviderRef = { key: spec.key, namespace: spec.namespace };
      const existing = await inspectLike(ref);
      if (existing) return existing;
      // A bound workspace must exist before the task that uses it, and it survives task delete.
      if (spec.workspace) {
        try {
          await callUnary(c, "GetWorkspace", { atespace: spec.namespace, name: spec.workspace.ref });
        } catch (err) {
          if (!isGrpcStatus(err, grpc.status.NOT_FOUND)) throw err;
          // Upsert creates when absent; empty spec gives an empty workspace.
          await callUnary(c, "UpdateWorkspace", { workspace: { apiVersion: "ax.io/v1alpha1", kind: "Workspace", metadata: { name: spec.workspace.ref, atespace: spec.namespace }, spec: {} } });
        }
      }
      const limits = spec.resources ? Object.fromEntries(Object.entries({ cpu: spec.resources.cpu, memory: spec.resources.memory }).filter(([, v]) => v !== undefined)) : undefined;
      await callUnary(c, "CreateTask", {
        task: {
          apiVersion: "ax.io/v1alpha1",
          kind: "Task",
          metadata: { name: spec.key, atespace: spec.namespace },
          spec: {
            image: spec.image,
            command: spec.command,
            env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
            ...(spec.resources ? { resources: { limits } } : {}),
            ...(spec.workspace ? { workspace: { name: spec.workspace.ref } } : {}),
          },
        },
      });
      return { ref, phase: "provisioning", since: new Date().toISOString() };
    },
    async start(ref) {
      await callUnary(c, "ResumeTask", { atespace: ref.namespace, name: ref.key });
      const st = await inspectLike(ref);
      // Never null right after ResumeTask: ax created the task or rejected the call.
      return st ?? { ref, phase: "running", since: new Date().toISOString() };
    },
    async suspend(ref) {
      await callUnary(c, "SuspendTask", { atespace: ref.namespace, name: ref.key });
      return (await inspectLike(ref)) ?? { ref, phase: "suspended", since: new Date().toISOString() };
    },
    /** ax DeleteTask always destroys a bound workspace's task-local state; never called with destroyWorkspace:false today. */
    async terminate(ref, { destroyWorkspace }) {
      if (!destroyWorkspace) throw new Error("ax cannot terminate without destroying the task workspace");
      try {
        await callUnary(c, "DeleteTask", { atespace: ref.namespace, name: ref.key });
      } catch (err) {
        if (!isGrpcStatus(err, grpc.status.NOT_FOUND)) throw err; // already gone: termination is idempotent
      }
    },
    inspect: inspectLike,
    async *list(namespace) {
      const LIMIT = 100;
      for (let offset = 0; ; offset += LIMIT) {
        const res = await callUnary<{ tasks?: TaskLike[] }, { atespace: string; limit: number; offset: number }>(c, "ListTasks", { atespace: namespace, limit: LIMIT, offset });
        for (const t of res.tasks ?? []) {
          const st = toExecutionState(t);
          if (st) yield st;
        }
        if (!res.tasks || res.tasks.length < LIMIT) break;
      }
    },
    async setNetworkPolicy(ref, policy: NetworkPolicy) {
      if (policy.profile !== "full-trust") throw new Error(`substrate policy ${policy.profile} not implemented yet`);
      // The actor is the Substrate identity behind the task; policies attach to it, not the task name.
      const actor = (await (async () => {
        try {
          const t = await callUnary<TaskLike, { atespace: string; name: string }>(c, "GetTask", { atespace: ref.namespace, name: ref.key });
          return t.status?.actor || ref.key;
        } catch {
          return ref.key;
        }
      })());
      await egress.ensureAllowAll(ref.namespace, actor);
    },
  };
}
