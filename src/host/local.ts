import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FolieConfig } from "../config";
import { HOME, REPO } from "./env";

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 200;
const SERVER_ENTRY = resolve(REPO, "src/server/main.ts");

interface LocalPaths {
  root: string;
  pidFile: string;
  logFile: string;
  databaseDir: string;
  workspaceDir: string;
}

interface LocalServerRecord {
  pid: number;
  serverEntry: string;
  processIdentity: string;
}

const paths = (): LocalPaths => {
  const root = join(HOME, "local");
  return {
    root,
    pidFile: join(root, "server.pid.json"),
    logFile: join(root, "server.log"),
    databaseDir: join(root, "database"),
    workspaceDir: join(root, "workspaces"),
  };
};

function processIdentity(pid: number): string | null {
  if (process.platform === "win32") {
    const script =
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
      `if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + '|' + $p.CommandLine }`;
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 2_000, windowsHide: true },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  }

  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "lstart=,command="],
    { encoding: "utf8", timeout: 2_000 },
  );
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function isFolieServerIdentity(identity: string, serverEntry: string): boolean {
  return identity.includes(serverEntry);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return false;
    throw error;
  }
}

async function readRecord(pidFile: string): Promise<LocalServerRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(pidFile, "utf8")) as Partial<LocalServerRecord>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.serverEntry !== "string" ||
      typeof parsed.processIdentity !== "string"
    )
      throw new Error("invalid local server PID record");
    return parsed as LocalServerRecord;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw new Error(`cannot read ${pidFile}: ${error instanceof Error ? error.message : error}`);
  }
}

function assertOwnedProcess(record: LocalServerRecord): string | null {
  const actual = processIdentity(record.pid);
  if (!actual) {
    if (processExists(record.pid))
      throw new Error(
        `cannot verify PID ${record.pid} from ${paths().pidFile}; refusing to signal or forget it`,
      );
    return null;
  }
  if (
    record.serverEntry !== SERVER_ENTRY ||
    !isFolieServerIdentity(actual, record.serverEntry) ||
    actual !== record.processIdentity
  )
    throw new Error(
      `PID file ${paths().pidFile} no longer identifies the Folie server; refusing to signal PID ${record.pid}`,
    );
  return actual;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(port)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
  return healthy(port);
}

async function waitForProcessExit(record: LocalServerRecord, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!assertOwnedProcess(record)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
  return !assertOwnedProcess(record);
}

function agentEnvironment(config: FolieConfig): Record<string, string> {
  const forwarded: Record<string, string> = {};
  if (config.model_api_key)
    forwarded.FOLIE_AGENT_ENV_OPENROUTER_API_KEY = config.model_api_key;
  for (const entry of config.agent_env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key))
      throw new Error(`invalid agent environment key: ${JSON.stringify(entry.key)}`);
    forwarded[`FOLIE_AGENT_ENV_${entry.key}`] = entry.value;
  }
  return forwarded;
}

function localServerEnvironment(config: FolieConfig, p: LocalPaths): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const env: Record<string, string> = {
    ...inherited,
    FOLIE_EXECUTION_PROFILE: "local",
    FOLIE_PGLITE_DATA_DIR: p.databaseDir,
    FOLIE_LOCAL_WORKSPACES_DIR: p.workspaceDir,
    PORT: String(config.server_port),
    FOLIE_OPERATOR_TOKEN: config.operator_token,
    FOLIE_MODEL: config.default_model,
    FOLIE_RUNTIME: config.agent_runtime,
    FOLIE_ATESPACE: config.atespace,
    FOLIE_RECONCILE_MS: String(config.reconcile_ms),
    ...agentEnvironment(config),
  };

  // The local provider cannot suspend a process on Windows. Avoid a repeated
  // failed auto-suspend loop; explicit stop still shuts the server down cleanly.
  if (process.platform === "win32") {
    const suspendAfter = 315_360_000;
    const requestedDeleteAfter = Number(process.env.FOLIE_DELETE_AFTER_S ?? suspendAfter + 1);
    env.FOLIE_SUSPEND_AFTER_S = String(suspendAfter);
    env.FOLIE_DELETE_AFTER_S = String(Math.max(suspendAfter + 1, requestedDeleteAfter));
  }
  return env;
}

async function tailLog(file: string): Promise<string> {
  try {
    return (await readFile(file, "utf8")).split("\n").slice(-30).join("\n").trim();
  } catch {
    return "";
  }
}

/** Starts the local Folie server once and waits until its public health endpoint responds. */
export async function startLocalServer(config: FolieConfig): Promise<void> {
  const p = paths();
  await mkdir(p.root, { recursive: true, mode: 0o700 });
  await mkdir(p.databaseDir, { recursive: true, mode: 0o700 });
  await mkdir(p.workspaceDir, { recursive: true, mode: 0o700 });
  await Promise.all([chmod(p.root, 0o700), chmod(p.databaseDir, 0o700), chmod(p.workspaceDir, 0o700)]);

  const existing = await readRecord(p.pidFile);
  if (existing) {
    const identity = assertOwnedProcess(existing);
    if (identity) {
      if (await waitForHealth(config.server_port, 1_000)) {
        console.log(`==> local Folie server is already running at http://127.0.0.1:${config.server_port}`);
        printLocalTrustNotice(p);
        return;
      }
      throw new Error(`local Folie server PID ${existing.pid} is running but /healthz is unavailable; inspect ${p.logFile}`);
    }
    // The PID no longer exists. Remove only this stale record; never signal a reused PID.
    await rm(p.pidFile, { force: true });
  }

  if (await healthy(config.server_port))
    throw new Error(
      `port ${config.server_port} already serves a healthy endpoint but is not owned by Folie's local PID file; refusing to adopt it`,
    );

  const logFd = openSync(p.logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: localServerEnvironment(config, p),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  await chmod(p.logFile, 0o600);
  child.unref();
  if (!child.pid) throw new Error(`failed to start local server; see ${p.logFile}`);

  const deadline = Date.now() + 3_000;
  let identity: string | null = null;
  while (!identity && Date.now() < deadline) {
    identity = processIdentity(child.pid);
    if (!identity) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!identity || !isFolieServerIdentity(identity, SERVER_ENTRY)) {
    try {
      child.kill("SIGTERM");
    } catch {}
    throw new Error(`could not verify the local Folie server process; inspect ${p.logFile}`);
  }

  const record: LocalServerRecord = {
    pid: child.pid,
    serverEntry: SERVER_ENTRY,
    processIdentity: identity,
  };
  await writeFile(p.pidFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(p.pidFile, 0o600);

  if (!(await waitForHealth(config.server_port, START_TIMEOUT_MS))) {
    const log = await tailLog(p.logFile);
    await stopLocalServer(false).catch(() => undefined);
    throw new Error(
      `local Folie server did not become healthy at http://127.0.0.1:${config.server_port}; log: ${p.logFile}${log ? `\n\n${log}` : ""}`,
    );
  }

  console.log(`==> local Folie server ready at http://127.0.0.1:${config.server_port}`);
  printLocalTrustNotice(p);
}

function printLocalTrustNotice(p: LocalPaths): void {
  console.log("==> local workers run as your OS user with host filesystem and network access; no CPU/memory limits or sandbox are enforced");
  console.log("==> worker tracking is in memory: a server crash may leave workers running without an owner; `folie down` stops tracked workers gracefully");
  console.log(`==> local workspaces and database are preserved under ${p.root} when Folie stops`);
  if (process.platform === "win32")
    console.log("==> Windows cannot suspend local workers; automatic idle suspension is deferred for about 10 years");
}

/** Stops only the server recorded by Folie. Graceful shutdown preserves database and workspace files. */
export async function stopLocalServer(announce = true): Promise<void> {
  const p = paths();
  const record = await readRecord(p.pidFile);
  if (!record) {
    if (announce) console.log("==> no local Folie server is recorded");
    return;
  }

  if (!assertOwnedProcess(record)) {
    await rm(p.pidFile, { force: true });
    if (announce) console.log("==> local Folie server is not running; removed stale PID record");
    return;
  }

  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ESRCH"
    )
      throw error;
  }

  if (!(await waitForProcessExit(record, STOP_TIMEOUT_MS))) {
    // Revalidate identity immediately before the force signal to avoid killing a reused PID.
    if (assertOwnedProcess(record)) process.kill(record.pid, "SIGKILL");
    if (!(await waitForProcessExit(record, 2_000)))
      throw new Error(`local Folie server PID ${record.pid} did not stop; refusing further signals`);
  }

  const current = await readRecord(p.pidFile);
  if (current?.pid === record.pid && current.processIdentity === record.processIdentity)
    await rm(p.pidFile, { force: true });
  if (announce) console.log(`==> local Folie server stopped; database and workspaces remain under ${p.root}`);
}
