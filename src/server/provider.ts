// ExecutionProvider — the domain port to an execution provider (ax today, others later).
// Shapes are per spec/interfaces.md §5. Only this module and provider adapters may speak of
// provider concepts; the domain and app layers use these types only.
export type NetworkPolicy =
  | { profile: "full-trust" }
  | { profile: "allowlist"; allow: { hosts: string[]; ports: number[] }[] }
  | { profile: "deny-all" };

export interface ExecutionSpec {
  key: string;
  namespace: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  resources?: { cpu?: string; memory?: string };
  /** Durable provider-side workspace to bind (created if absent); it survives task termination. */
  workspace?: { ref: string };
  network: NetworkPolicy;
  /** Guest gRPC exec/file backdoor; must stay false. See R-6.7. */
  debug?: boolean;
}

/** Opaque handle to a provider-side execution. Carries the key it was created from. */
export interface ProviderRef {
  key: string;
  namespace: string;
}

export type ExecutionPhase = "provisioning" | "running" | "suspended" | "failed" | "absent" | "unknown";

export interface ExecutionState {
  ref: ProviderRef;
  phase: ExecutionPhase;
  since: string;
  detail?: string;
}

export interface ExecutionCapabilities {
  suspend: boolean;
  checkpoint: boolean;
  list: boolean;
  resourceLimits: boolean;
  network: "none" | "allowlist" | "full-trust-only";
  logs: boolean;
  inFlightCancel: boolean;
}

export interface ExecutionProvider {
  readonly capabilities: ExecutionCapabilities;
  /** Create if absent (idempotent by spec.key in spec.namespace); never starts the execution. */
  ensure(spec: ExecutionSpec): Promise<ExecutionState>;
  /** First start or resume from checkpoint/suspend. */
  start(ref: ProviderRef): Promise<ExecutionState>;
  /** Checkpoints the workspace when supported. */
  suspend(ref: ProviderRef): Promise<ExecutionState>;
  terminate(ref: ProviderRef, o: { destroyWorkspace: boolean }): Promise<void>;
  /** null: absent. */
  inspect(ref: ProviderRef): Promise<ExecutionState | null>;
  /** Actual state of the namespace, for reconciliation against desired state. */
  list(namespace: string): AsyncIterable<ExecutionState>;
  setNetworkPolicy(ref: ProviderRef, policy: NetworkPolicy): Promise<void>;
}
