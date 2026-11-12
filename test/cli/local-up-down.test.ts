// Spawns the real CLI: local profile `up` / `down` with temp FOLIE_HOME + XDG config.
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, CONFIG_DIR_NAME } from "../../src/config";
import { FolieClient } from "../../src/shared/client";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(REPO, "src/cli.ts");
const operatorToken = "cli-local-up-down-token";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function runCli(
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
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
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

async function writeLocalConfig(xdgHome: string, port: number) {
  const configDir = join(xdgHome, CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const yaml = [
    "config_version: 2",
    "execution_profile: local",
    `operator_token: ${operatorToken}`,
    "default_model: openrouter/deepseek/deepseek-chat",
    'model_api_key: ""',
    "atespace: folie",
    "agent_runtime: echo",
    "agent_env: []",
    `server_port: ${port}`,
    "reconcile_ms: 250",
    "",
  ].join("\n");
  await writeFile(join(configDir, CONFIG_FILE_NAME), yaml, { mode: 0o600 });
}

const base = await mkdtemp(join(tmpdir(), "folie-cli-up-down-"));
const folieHome = join(base, "folie-home");
const xdgHome = join(base, "xdg-config");
const env = {
  FOLIE_HOME: folieHome,
  XDG_CONFIG_HOME: xdgHome,
  FOLIE_OPERATOR_TOKEN: operatorToken,
};
let port = 0;

afterAll(async () => {
  await runCli(env, ["down"], 30_000).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

describe("folie up/down (local CLI)", () => {
  it("persists a completed work item across down and up", async () => {
    port = await freePort();
    await writeLocalConfig(xdgHome, port);

    const up1 = await runCli(env, ["up"], 45_000);
    expect(up1.code, up1.out).toBe(0);
    expect(up1.out).toMatch(/local Folie server/);

    const submit = await runCli(
      env,
      ["submit", "cli persistence gate", "--wait", "--timeout", "45"],
      60_000,
    );
    expect(submit.code, submit.out).toBe(0);
    expect(submit.out).toMatch(/report \(.*done\): echo:/);
    const idMatch = submit.out.match(/work item #(\d+)/);
    expect(idMatch).not.toBeNull();
    const workItemId = idMatch![1]!;

    const down = await runCli(env, ["down"], 30_000);
    expect(down.code, down.out).toBe(0);

    const up2 = await runCli(env, ["up"], 45_000);
    expect(up2.code, up2.out).toBe(0);

    const client = new FolieClient(
      `http://127.0.0.1:${port}`,
      fetch,
      operatorToken,
    );
    const view = await client.workItem(Number(workItemId));
    expect(view.workItem).toMatchObject({ id: Number(workItemId), state: "done" });
    expect(view.report?.outcome).toBe("done");
    expect(view.report?.summary).toMatch(/^echo:/);
  }, 120_000);
});
