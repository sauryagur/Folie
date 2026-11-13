// Operator path: config init --defaults, Strands with FOLIE_FAKE_TURNS, transcript across restart.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from "../../src/config";
import { FolieClient } from "../../src/shared/client";
import {
  freePort,
  isolatedCliHome,
  runCli,
  writeLocalConfig,
} from "../support/local-cli-harness";

const operatorToken = "cli-strands-operator-token";

describe("folie local Strands journey (CLI)", () => {
  it("config init --defaults, strands fake model, and transcript survive down/up", async () => {
    const { base, env, xdgHome } = await isolatedCliHome(operatorToken);
    try {
      const port = await freePort();
      const configPath = join(xdgHome, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
      await rm(configPath, { force: true }).catch(() => undefined);

      const init = await runCli(env, ["config", "init", "--defaults"], 15_000);
      expect(init.code, init.out).toBe(0);
      expect(init.out).toMatch(/Config written/);

      const turns = JSON.stringify([
        {
          kind: "tools",
          calls: [
            {
              name: "report_submit",
              input: { outcome: "done", summary: "cli strands persistence" },
            },
          ],
        },
      ]);
      await writeLocalConfig(xdgHome, port, {
        operatorToken,
        runtime: "strands",
        agentEnv: [{ key: "FOLIE_FAKE_TURNS", value: turns }],
        reconcileMs: 250,
      });

      const up1 = await runCli(env, ["up"], 45_000);
      expect(up1.code, up1.out).toBe(0);

      const submit = await runCli(
        env,
        ["submit", "survey sources for iteration 1", "--wait", "--timeout", "60"],
        90_000,
      );
      expect(submit.code, submit.out).toBe(0);
      expect(submit.out).toMatch(/report \(.*done\): cli strands persistence/);
      const idMatch = submit.out.match(/work item #(\d+)/);
      expect(idMatch).not.toBeNull();
      const workItemId = Number(idMatch![1]);

      const client = new FolieClient(
        `http://127.0.0.1:${port}`,
        fetch,
        operatorToken,
      );
      const beforeEvents = await client.readEvents({ scope: `wi:${workItemId}` });
      expect(beforeEvents.map((e) => e.type)).toEqual(
        expect.arrayContaining(["session_start", "session_end"]),
      );

      const down = await runCli(env, ["down"], 30_000);
      expect(down.code, down.out).toBe(0);

      const up2 = await runCli(env, ["up"], 45_000);
      expect(up2.code, up2.out).toBe(0);

      const status = await runCli(env, ["status", String(workItemId)], 15_000);
      expect(status.code, status.out).toBe(0);
      expect(status.out).toMatch(/done/);
      expect(status.out).toMatch(/cli strands persistence/);

      const afterEvents = await client.readEvents({ scope: `wi:${workItemId}` });
      expect(afterEvents).toEqual(beforeEvents);
    } finally {
      await runCli(env, ["down"], 30_000).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  }, 180_000);
});
