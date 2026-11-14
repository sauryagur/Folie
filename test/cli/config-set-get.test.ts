// `folie config set|get|view` through the real CLI: argument positions, secret masking, refusals.
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from "../../src/config";
import { isolatedCliHome, runCli } from "../support/local-cli-harness";

const SECRET = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

describe("folie config set/get (CLI)", () => {
  let base: string | undefined;
  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
    base = undefined;
  });

  async function freshConfig() {
    const home = await isolatedCliHome("config-cli-token");
    base = home.base;
    // Bun auto-loads the repo's .env for the CLI; pin the key variable so a developer's .env cannot leak in.
    const env = { ...home.env, FOLIE_AGENT_ENV_OPENROUTER_API_KEY: "" };
    const path = join(home.xdgHome, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
    const init = await runCli(env, ["config", "init", "--defaults"], 15_000);
    expect(init.code, init.out).toBe(0);
    return { env, path };
  }

  it("stores model_api_key under its own field and never prints it unless revealed", async () => {
    const { env, path } = await freshConfig();

    const set = await runCli(env, ["config", "set", "model_api_key", SECRET]);
    expect(set.code, set.out).toBe(0);
    expect(set.out).not.toContain(SECRET);
    expect(set.out).toMatch(/Set model_api_key = sk\*+ef/);

    const yaml = await readFile(path, "utf8");
    expect(yaml).toMatch(new RegExp(`^model_api_key: "?${SECRET}"?$`, "m"));
    expect(yaml).not.toMatch(/^set:/m);

    const get = await runCli(env, ["config", "get", "model_api_key"]);
    expect(get.code, get.out).toBe(0);
    expect(get.out).not.toContain(SECRET);

    const reveal = await runCli(env, ["config", "get", "model_api_key", "--reveal"]);
    expect(reveal.code, reveal.out).toBe(0);
    expect(reveal.out.trim()).toBe(SECRET);
  });

  it("converts numbers, and refuses unknown keys and invalid values without changing the file", async () => {
    const { env, path } = await freshConfig();

    const port = await runCli(env, ["config", "set", "server_port", "9191"]);
    expect(port.code, port.out).toBe(0);
    expect(await readFile(path, "utf8")).toMatch(/^server_port: 9191$/m);

    const before = await readFile(path, "utf8");
    for (const [args, message] of [
      [["server_port", "abc"], /whole number required/],
      [["agent_runtime", "nope"], /agent_runtime must be/],
      [["bogus", "x"], /unknown or read-only key: bogus/],
      [["config_version", "3"], /unknown or read-only key: config_version/],
    ] as const) {
      const r = await runCli(env, ["config", "set", ...args]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(message);
    }
    expect(await readFile(path, "utf8")).toBe(before);

    const unknown = await runCli(env, ["config", "get", "bogus"]);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toMatch(/Unknown key: bogus/);
  });

  it("refuses to replace a config file it cannot read with defaults", async () => {
    const { env, path } = await freshConfig();
    const unreadable = "config_version: 2\noperator_token: keep-me\n";
    await writeFile(path, unreadable, { mode: 0o600 });

    const r = await runCli(env, ["config", "set", "atespace", "other"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/Refusing to overwrite it with defaults/);
    expect(await readFile(path, "utf8")).toBe(unreadable);
  });

  it("view warns about a stray field left by the old set bug without printing it", async () => {
    const { env, path } = await freshConfig();
    await appendFile(path, `set: "model_api_key ${SECRET}"\n`);

    const view = await runCli(env, ["config", "view"]);
    expect(view.code, view.out).toBe(0);
    expect(view.out).toMatch(/unknown field 'set'/);
    expect(view.out).not.toContain(SECRET);
  });
});
