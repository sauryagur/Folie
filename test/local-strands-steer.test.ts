// Human mail steers an in-flight Strands session over real HTTP and local child processes.
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { FolieClient } from "../src/shared/client";
import { reportTurn, toolTurn } from "./support/strands-fake-model";
import { startLocalStack } from "./support/local-stack";

const operatorToken = "local-strands-steer-token";
const FAKE_AGENT = fileURLToPath(
  new URL("./support/agent-strands-fake.ts", import.meta.url),
);

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

const home = await mkdtemp(join(tmpdir(), "folie-strands-steer-home-"));
const port = await freePort();

afterAll(() => rm(home, { recursive: true, force: true }));

async function waitForDone(client: FolieClient, id: number, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const view = await client.workItem(id);
    if (view.workItem.state === "done" && view.report?.outcome === "done")
      return view;
    await new Promise((r) => setTimeout(r, 200));
  }
  return client.workItem(id);
}

describe("local Strands steering", () => {
  it("injects human mail mid-session over HTTP and acks it on settle", async () => {
    const turns = [
      { ...toolTurn("workspace_read", { path: "notes.txt" }), holdMs: 2_000 },
      reportTurn("done", "focused on 2024"),
    ];
    const stack = await startLocalStack(home, port, operatorToken, 250, {
      agentMain: FAKE_AGENT,
      extraEnv: { FOLIE_FAKE_TURNS: JSON.stringify(turns) },
      periodicReconcile: false,
    });
    try {
      await stack.client.registerAgent("steered");
      const { workItem } = await stack.client.submitGoal({
        goal: "survey the literature",
        to: "steered",
      });
      const correctionBody = "focus on 2024 papers";
      const scope = `wi:${workItem.id}`;

      const sendMidTurn = (async () => {
        await stack.tick();
        // session_start is flushed only at session end; time the send from dispatch instead.
        await new Promise((r) => setTimeout(r, 700));
        await stack.client.send({
          from: "human",
          to: "steered",
          body: correctionBody,
        });
      })();

      const deadline = Date.now() + 30_000;
      let settled = await stack.client.workItem(workItem.id);
      while (Date.now() < deadline) {
        await stack.tick();
        settled = await waitForDone(stack.client, workItem.id, 0);
        if (
          settled.workItem.state === "done" &&
          settled.report?.summary === "focused on 2024"
        )
          break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await sendMidTurn;

      expect(settled.workItem.state).toBe("done");
      expect(settled.report?.summary).toBe("focused on 2024");

      const correction = (await stack.client.messages({ agent: "steered" })).find(
        (m) => m.body === correctionBody,
      )!;
      expect(correction.ackedAt).not.toBeNull();
      expect(settled.report!.messageIds).toEqual(
        expect.arrayContaining([correction.id]),
      );

      const steer = (
        await stack.client.readEvents({ scope, type: "steer" })
      )[0]!;
      expect(steer.data).toEqual({ messageIds: [correction.id] });
    } finally {
      await stack.stop();
    }
  }, 60_000);
});
