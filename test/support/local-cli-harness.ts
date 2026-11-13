// Shared helpers for subprocess CLI tests (`folie up` / `down` with temp FOLIE_HOME).
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE_NAME, CONFIG_DIR_NAME } from "../../src/config";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const CLI = join(REPO, "src/cli.ts");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

export function runCli(
  env: Record<string, string>,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`cli timed out: folie ${args.join(" ")}\n${out}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

export interface LocalConfigOptions {
  runtime?: "echo" | "strands" | "pi";
  agentEnv?: { key: string; value: string }[];
  reconcileMs?: number;
  operatorToken?: string;
}

export async function writeLocalConfig(
  xdgHome: string,
  port: number,
  options: LocalConfigOptions = {},
) {
  const configDir = join(xdgHome, CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const runtime = options.runtime ?? "echo";
  const agentEnv = options.agentEnv ?? [];
  const envLine =
    agentEnv.length === 0
      ? "agent_env: []"
      : `agent_env: [${agentEnv.map((e) => JSON.stringify(`${e.key}=${e.value}`)).join(", ")}]`;
  const yaml = [
    "config_version: 2",
    "execution_profile: local",
    `operator_token: ${options.operatorToken ?? "cli-local-token"}`,
    "default_model: openrouter/deepseek/deepseek-chat",
    'model_api_key: ""',
    "atespace: folie",
    `agent_runtime: ${runtime}`,
    envLine,
    `server_port: ${port}`,
    `reconcile_ms: ${options.reconcileMs ?? 250}`,
    "",
  ].join("\n");
  await writeFile(join(configDir, CONFIG_FILE_NAME), yaml, { mode: 0o600 });
}

export async function isolatedCliHome(token: string) {
  const base = await mkdtemp(join(tmpdir(), "folie-cli-"));
  const folieHome = join(base, "folie-home");
  const xdgHome = join(base, "xdg-config");
  return {
    base,
    env: {
      FOLIE_HOME: folieHome,
      XDG_CONFIG_HOME: xdgHome,
      FOLIE_OPERATOR_TOKEN: token,
    },
    xdgHome,
  };
}
