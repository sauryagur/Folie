// Local profile over a temp FOLIE_HOME: file-backed PGlite, real HTTP, echo agents as child processes.
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FolieClient } from "../src/shared/client";
import { startLocalStack } from "./support/local-stack";

const operatorToken = "local-lifecycle-operator-token";

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

const home = await mkdtemp(join(tmpdir(), "folie-local-e2e-home-"));
const port = await freePort();

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

afterAll(() => rm(home, { recursive: true, force: true }));

describe("local server lifecycle", () => {
  it("persists a completed work item across stop and restart", async () => {
    const first = await startLocalStack(home, port, operatorToken);
    const { workItem } = await first.client.submitGoal({
      goal: "prove persistence",
    });
    const settled = await waitForDone(first.client, workItem.id, 25_000);
    expect(settled.workItem.state).toBe("done");
    expect(settled.report?.summary).toMatch(/^echo:/);
    await first.stop();

    const second = await startLocalStack(home, port, operatorToken);
    const after = await second.client.workItem(workItem.id);
    expect(after.workItem).toMatchObject({ id: workItem.id, state: "done" });
    expect(after.report?.outcome).toBe("done");
    expect(after.report?.summary).toBe(settled.report?.summary);
    await second.stop();
  }, 60_000);
});
