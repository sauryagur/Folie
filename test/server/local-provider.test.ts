// Local process provider: a crashed agent's own reason becomes the execution's failure detail.
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProcessProvider } from "../../src/server/local-provider";
import type { ExecutionSpec, ExecutionState } from "../../src/server/provider";

let root: string;
let provider: LocalProcessProvider;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "folie-local-provider-"));
  provider = new LocalProcessProvider({ workspaceRoot: root, terminateGraceMs: 500 });
});
afterEach(async () => {
  await provider.close();
  await rm(root, { recursive: true, force: true });
});

const spec = (script: string): ExecutionSpec => ({
  key: "a",
  namespace: "folie",
  image: "local-process",
  command: [process.execPath, "-e", script],
  env: {},
  workspace: { ref: "a-ws" },
  network: { profile: "full-trust" },
});
const ref = { key: "a", namespace: "folie" };

async function settled(): Promise<ExecutionState | null> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const st = await provider.inspect(ref);
    if (st?.phase === "failed" || Date.now() > deadline) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const fatalFiles = async () =>
  (await readdir(root)).filter((f) => f.endsWith(".fatal"));

describe("LocalProcessProvider failure reasons", () => {
  it("reports the reason the agent left in FOLIE_FATAL_FILE when it exits non-zero", async () => {
    await provider.ensure(
      spec(
        `require("node:fs").writeFileSync(process.env.FOLIE_FATAL_FILE, "OpenAI API key is required.\\n  at createRuntime"); process.exit(1)`,
      ),
    );
    await provider.start(ref);
    const st = await settled();
    expect(st?.phase).toBe("failed");
    expect(st?.detail).toBe(
      "process exited with code 1: OpenAI API key is required. at createRuntime",
    );
  });

  it("keeps the fatal file beside the workspace, never inside it, and removes it with the workspace", async () => {
    await provider.ensure(
      spec(`require("node:fs").writeFileSync(process.env.FOLIE_FATAL_FILE, "x"); process.exit(1)`),
    );
    await provider.start(ref);
    await settled();
    const [workspace] = (await readdir(root)).filter((f) => !f.endsWith(".fatal"));
    expect(await readdir(join(root, workspace!))).toEqual([]);
    expect(await fatalFiles()).toEqual([`${workspace}.fatal`]);

    await provider.terminate(ref, { destroyWorkspace: true });
    expect(existsSync(join(root, workspace!))).toBe(false);
    expect(await fatalFiles()).toEqual([]);
  });

  it("does not report a reason left by an earlier run", async () => {
    await provider.ensure(spec("process.exit(3)"));
    const [workspace] = await readdir(root);
    await writeFile(join(root, `${workspace}.fatal`), "stale reason from last time");
    await provider.start(ref);
    expect((await settled())?.detail).toBe("process exited with code 3");
  });
});
