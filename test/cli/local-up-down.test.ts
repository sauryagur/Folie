// Spawns the real CLI: local profile `up` / `down` with temp FOLIE_HOME + XDG config.
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FolieClient } from "../../src/shared/client";
import {
  freePort,
  isolatedCliHome,
  runCli,
  writeLocalConfig,
} from "../support/local-cli-harness";

const operatorToken = "cli-local-up-down-token";

describe("folie up/down (local CLI)", () => {
  it("persists a completed work item across down and up", async () => {
    const { base, env, xdgHome } = await isolatedCliHome(operatorToken);
    try {
      const port = await freePort();
      await writeLocalConfig(xdgHome, port, { operatorToken });

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
      expect(view.workItem).toMatchObject({
        id: Number(workItemId),
        state: "done",
      });
      expect(view.report?.outcome).toBe("done");
      expect(view.report?.summary).toMatch(/^echo:/);
    } finally {
      await runCli(env, ["down"], 30_000).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});
