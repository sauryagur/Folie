import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import type {
  ExecutionCapabilities,
  ExecutionProvider,
  ExecutionSpec,
  ExecutionState,
  NetworkPolicy,
  ProviderRef,
} from "./provider";

interface LocalExecution {
  ref: ProviderRef;
  spec: ExecutionSpec;
  workspacePath: string;
  phase: ExecutionState["phase"];
  since: string;
  detail?: string;
  child?: ChildProcess;
  stopping?: boolean;
}

export interface LocalProcessProviderOptions {
  /** Persistent directory containing one workspace directory per provider workspace reference. */
  workspaceRoot?: string;
  /** Grace period between SIGTERM and SIGKILL when stopping an execution. */
  terminateGraceMs?: number;
}

const supportsSuspend = process.platform !== "win32";
const keyOf = (ref: ProviderRef) => `${ref.namespace}\0${ref.key}`;

function now(): string {
  return new Date().toISOString();
}

function fullTrustOnly(policy: NetworkPolicy): void {
  if (policy.profile !== "full-trust")
    throw new Error(
      `local process provider cannot enforce ${policy.profile} networking; local processes have full host network access`,
    );
}

function requestedResources(spec: ExecutionSpec): boolean {
  return !!spec.resources && Object.values(spec.resources).some((v) => v);
}

function workspaceName(namespace: string, ref: string): string {
  const digest = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(ref)
    .digest("hex")
    .slice(0, 16);
  const label = `${namespace}-${ref}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  return `${label || "workspace"}-${digest}`;
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return;
    throw error;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once("exit", onExit);
    if (hasExited(child)) finish(true);
  });
}

/**
 * Runs trusted local child processes as the Folie server's operating-system user.
 * The image field is not used; the command runs directly on the host. Process handles and
 * execution state live only in this instance: a server crash can leave a child running
 * without an owner, and after restart it cannot be discovered or reattached. Workspace
 * files remain on disk, but process recovery is not implemented.
 * This is not a sandbox; children share the host user's filesystem, environment, and network access.
 */
export class LocalProcessProvider implements ExecutionProvider {
  readonly capabilities: ExecutionCapabilities = {
    suspend: supportsSuspend,
    checkpoint: false,
    list: true,
    resourceLimits: false,
    network: "full-trust-only",
    logs: false,
    inFlightCancel: true,
  };

  private readonly workspaceRoot: string;
  private readonly terminateGraceMs: number;
  private readonly executions = new Map<string, LocalExecution>();

  constructor(options: LocalProcessProviderOptions = {}) {
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? join(homedir(), ".folie", "workspaces"),
    );
    this.terminateGraceMs = Math.max(0, options.terminateGraceMs ?? 5_000);
  }

  async ensure(spec: ExecutionSpec): Promise<ExecutionState> {
    fullTrustOnly(spec.network);
    if (requestedResources(spec))
      throw new Error(
        "local process provider cannot enforce requested CPU or memory limits",
      );
    if (spec.command.length === 0 || !spec.command[0])
      throw new Error("local process provider requires a command");

    const ref = { key: spec.key, namespace: spec.namespace };
    const id = keyOf(ref);
    const existing = this.executions.get(id);
    const workspaceRef = spec.workspace?.ref ?? spec.key;
    const workspacePath = join(
      this.workspaceRoot,
      workspaceName(spec.namespace, workspaceRef),
    );
    if (existing) {
      if (existing.workspacePath !== workspacePath)
        throw new Error(
          `execution ${spec.namespace}/${spec.key} already uses a different workspace`,
        );
      return this.state(existing);
    }

    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    await chmod(this.workspaceRoot, 0o700);
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    await this.assertWorkspaceContained(workspacePath);
    await chmod(workspacePath, 0o700);

    const execution: LocalExecution = {
      ref,
      spec: { ...spec, workspace: { ref: workspaceRef } },
      workspacePath,
      phase: "provisioning",
      since: now(),
      detail: "workspace prepared; process not started",
    };
    this.executions.set(id, execution);
    return this.state(execution);
  }

  async start(ref: ProviderRef): Promise<ExecutionState> {
    const execution = this.requireExecution(ref);
    if (execution.phase === "running" && execution.child)
      return this.state(execution);
    if (
      execution.phase === "provisioning" &&
      execution.child &&
      !hasExited(execution.child)
    )
      return this.state(execution);

    if (execution.phase === "suspended" && execution.child) {
      if (!supportsSuspend)
        throw new Error("suspend/resume is unavailable on this platform");
      signalProcess(execution.child, "SIGCONT");
      execution.phase = "running";
      execution.since = now();
      execution.detail = undefined;
      return this.state(execution);
    }

    await mkdir(execution.workspacePath, { recursive: true, mode: 0o700 });
    await this.assertWorkspaceContained(execution.workspacePath);
    await chmod(execution.workspacePath, 0o700);
    const [command, ...args] = execution.spec.command;
    if (!command) throw new Error("local process provider requires a command");
    const child = spawn(command, args, {
      cwd: execution.workspacePath,
      // Do not inherit server credentials (operator token, database paths, etc.).
      // The local profile is not a sandbox, but it still passes workers only the
      // variables explicitly selected by Folie's execution spec.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? homedir(),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...execution.spec.env,
        FOLIE_WORKDIR: execution.workspacePath,
      },
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    execution.child = child;
    execution.stopping = false;
    execution.phase = "provisioning";
    execution.since = now();
    execution.detail = "starting local process";

    child.once("error", (error) => {
      if (execution.child !== child) return;
      execution.child = undefined;
      execution.phase = "failed";
      execution.since = now();
      execution.detail = `spawn failed: ${error.message}`;
    });
    child.once("exit", (code, signal) => {
      if (execution.child !== child) return;
      execution.child = undefined;
      execution.since = now();
      if (execution.stopping) {
        execution.phase = "absent";
        execution.detail = undefined;
      } else if (code === 0) {
        // A completed command is absent from the provider; the workspace remains available for another start.
        execution.phase = "absent";
        execution.detail = undefined;
        this.executions.delete(keyOf(ref));
      } else {
        execution.phase = "failed";
        execution.detail = `process exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
      }
    });

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onSpawn = () => {
        child.off("error", onError);
        execution.phase = "running";
        execution.since = now();
        execution.detail = undefined;
        resolveSpawn();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        rejectSpawn(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return this.state(execution);
  }

  async suspend(ref: ProviderRef): Promise<ExecutionState> {
    if (!supportsSuspend)
      throw new Error("suspend is unavailable on this platform");
    const execution = this.requireExecution(ref);
    if (!execution.child || execution.phase !== "running")
      throw new Error(`execution ${ref.namespace}/${ref.key} is not running`);
    signalProcess(execution.child, "SIGSTOP");
    execution.phase = "suspended";
    execution.since = now();
    execution.detail = undefined;
    return this.state(execution);
  }

  async terminate(
    ref: ProviderRef,
    options: { destroyWorkspace: boolean },
  ): Promise<void> {
    const id = keyOf(ref);
    const execution = this.executions.get(id);
    if (!execution) return;

    const child = execution.child;
    if (child && !hasExited(child)) {
      execution.stopping = true;
      // A stopped process cannot handle SIGTERM until it is continued.
      if (execution.phase === "suspended" && supportsSuspend)
        signalProcess(child, "SIGCONT");
      signalProcess(child, "SIGTERM");
      if (!(await waitForExit(child, this.terminateGraceMs))) {
        signalProcess(child, "SIGKILL");
        await waitForExit(child, this.terminateGraceMs || 1_000);
      }
    }

    this.executions.delete(id);
    if (options.destroyWorkspace) {
      await this.assertWorkspaceContained(execution.workspacePath);
      await rm(execution.workspacePath, { recursive: true, force: true });
    }
  }

  async inspect(ref: ProviderRef): Promise<ExecutionState | null> {
    const execution = this.executions.get(keyOf(ref));
    if (!execution || execution.phase === "absent") return null;
    return this.state(execution);
  }

  async *list(namespace: string): AsyncIterable<ExecutionState> {
    for (const execution of this.executions.values())
      if (execution.ref.namespace === namespace && execution.phase !== "absent")
        yield this.state(execution);
  }

  async setNetworkPolicy(
    ref: ProviderRef,
    policy: NetworkPolicy,
  ): Promise<void> {
    this.requireExecution(ref);
    fullTrustOnly(policy);
  }

  /** Gracefully stops owned processes on orderly shutdown but leaves all workspaces intact. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.executions.keys()].map(async (id) => {
        const execution = this.executions.get(id);
        if (!execution) return;
        await this.terminate(execution.ref, { destroyWorkspace: false });
      }),
    );
  }

  private requireExecution(ref: ProviderRef): LocalExecution {
    const execution = this.executions.get(keyOf(ref));
    if (!execution)
      throw new Error(`execution ${ref.namespace}/${ref.key} was not ensured`);
    return execution;
  }

  private state(execution: LocalExecution): ExecutionState {
    return {
      ref: execution.ref,
      phase: execution.phase,
      since: execution.since,
      ...(execution.detail ? { detail: execution.detail } : {}),
    };
  }

  private async assertWorkspaceContained(workspacePath: string): Promise<void> {
    const root = await realpath(this.workspaceRoot);
    let actual: string;
    try {
      actual = await realpath(workspacePath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return; // A trusted child may already have removed its own workspace.
      throw error;
    }
    if (!actual.startsWith(`${root}${sep}`))
      throw new Error("local workspace resolves outside the configured root");
  }
}
