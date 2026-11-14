// The operator commands are reachable from the `folie` binary, not only as functions.
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedCliHome, runCli } from "../support/local-cli-harness";

let base: string;
let env: Record<string, string>;
beforeAll(async () => ({ base, env } = await isolatedCliHome("dispatch-token")));
afterAll(() => rm(base, { recursive: true, force: true }));

describe("folie command table", () => {
  it("lists every operator command in the usage line", async () => {
    const r = await runCli(env, ["no-such-command"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain(
      "usage: folie [up|down|config|submit|status|agents|topics|subscribe|unsubscribe|publish|cancel|pause|resume|artifact]",
    );
  });

  // Each of these checks its arguments before contacting the server, so reaching that check proves dispatch.
  it.each([
    ["subscribe", /usage: folie subscribe <topic> <agent>/],
    ["unsubscribe", /usage: folie unsubscribe <topic> <agent>/],
    ["publish", /usage: folie publish <topic>/],
    ["cancel", /usage: folie cancel <agent>/],
    ["pause", /usage: folie pause <agent>/],
    ["resume", /usage: folie resume <agent>/],
  ])("dispatches `folie %s` to its command", async (verb, usage) => {
    const r = await runCli(env, [verb as string]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(usage as RegExp);
  });
});
