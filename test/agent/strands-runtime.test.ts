import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrandsRuntime } from "../../src/agent/runtimes/strands";
import type { Message } from "../../src/shared/types";
import {
  FakeStrandsModel,
  reportTurn,
  textTurn,
  toolTurn,
} from "../support/strands-fake-model";
import { fakeSession } from "../support/session";

const mail = (id: number, body: string): Message => ({
  id,
  from: "human",
  to: "a",
  body,
  workItemId: 1,
  topic: null,
  createdAt: "",
  ackedAt: null,
});
const inbox = [mail(7, "summarize the notes")];

let dir: string;
let model: FakeStrandsModel;
let uploads: { bytes: number; name?: string }[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "folie-strands-"));
  model = new FakeStrandsModel();
  uploads = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function runtime() {
  return new StrandsRuntime({
    agentName: "a",
    model,
    workdir: dir,
    server: {
      uploadArtifact: async (bytes, metadata) => {
        uploads.push({ bytes: bytes.byteLength, name: metadata?.name });
        return {
          sha256: "ab".repeat(32),
          ref: `sha256/${"ab".repeat(32)}`,
          bytes: bytes.byteLength,
        };
      },
    },
  });
}

function run(messages: Message[], opts: Parameters<typeof fakeSession>[0] = {}) {
  const s = fakeSession(opts);
  return { s, result: runtime().run(messages, s.session) };
}

describe("results", () => {
  it("returns what the model submits through report_submit", async () => {
    model.setTurns(reportTurn("done", "wrote it"));
    expect(await run(inbox).result).toMatchObject({
      outcome: "done",
      summary: "wrote it",
    });
  });

  it("falls back to the model's final text when it never calls report_submit", async () => {
    model.setTurns(textTurn("all finished"));
    expect(await run(inbox).result).toMatchObject({
      outcome: "done",
      summary: "all finished",
    });
  });

  it("records usage from model metrics", async () => {
    model.setTurns(
      toolTurn("workspace_read", { path: "notes.txt" }),
      reportTurn("done", "s"),
    );
    await writeFile(join(dir, "notes.txt"), "data");
    const { usage } = await run(inbox).result;
    expect(usage).toMatchObject({ toolCalls: 2, toolFailures: 0 });
    expect(usage!.promptTokens).toBeGreaterThan(0);
    expect(usage!.completionTokens).toBeGreaterThan(0);
  });
});

describe("research tools", () => {
  it("reads a workspace file and uploads an artifact with transcript metadata", async () => {
    model.setTurns(
      toolTurn("artifact_write", { path: "out.md", content: "# find", description: "d" }),
      reportTurn("done", "saved"),
    );
    const { s, result } = run(inbox);
    await result;
    expect(uploads).toMatchObject([{ bytes: 6, name: "out.md" }]);
    expect((await s.all()).find((e) => e.type === "artifact")!.data).toMatchObject({
      path: "out.md",
      ref: expect.stringContaining("sha256/"),
    });
  });

  it("rejects paths outside the workspace", async () => {
    model.setTurns(
      toolTurn("artifact_write", { path: "../escape", content: "x", description: "" }),
      reportTurn("failed", "gave up"),
    );
    const { s, result } = run(inbox);
    await result;
    expect((await s.all()).find((e) => e.type === "artifact")).toBeUndefined();
    const ends = (await s.all()).filter((e) => e.type === "tool_end");
    expect(ends.find((e) => e.data.tool === "artifact_write")!.data.isError).toBe(true);
  });
});

describe("mid-session steering", () => {
  it("injects mail that arrives after a turn into the next model call", async () => {
    model.setTurns(
      toolTurn("workspace_read", { path: "notes.txt" }),
      reportTurn("done", "adjusted"),
    );
    await writeFile(join(dir, "notes.txt"), "v1");
    const { s, result } = run(inbox, {
      mail: [[mail(8, "actually use the second dataset")]],
    });
    await result;

    expect(model.prompts[0]).not.toContain("second dataset");
    expect(model.prompts[1]).toContain("New human message(s) received while you were working");
    expect(model.prompts[1]).toContain("#8 from human");
    expect((await s.all()).find((e) => e.type === "steer")!.data).toEqual({
      messageIds: [8],
    });
  });

  it("does not let a report stand when new instructions arrive after it", async () => {
    model.setTurns(
      reportTurn("done", "premature"),
      reportTurn("failed", "redirected"),
    );
    const { result } = run(inbox, { mail: [[mail(8, "stop, new direction")]] });
    expect(await result).toMatchObject({
      outcome: "failed",
      summary: "redirected",
    });
    expect(model.prompts[1]).toContain("stop, new direction");
  });
});

describe("tool transcript events", () => {
  it("tags research tools with the expected replay policy", async () => {
    await writeFile(join(dir, "f.txt"), "x");
    model.setTurns(
      toolTurn("workspace_read", { path: "f.txt" }),
      toolTurn("artifact_write", { path: "g.txt", content: "y", description: "" }),
      reportTurn("done", "s"),
    );
    const { s, result } = run(inbox);
    await result;
    const tags = Object.fromEntries(
      (await s.all())
        .filter((e) => e.type === "tool_start")
        .map((e) => [e.data.tool, e.data.replayable]),
    );
    expect(tags).toEqual({
      workspace_read: true,
      artifact_write: true,
      report_submit: true,
    });
  });
});

describe("cancellation", () => {
  it("stops cooperatively when the session aborts", async () => {
    model.setTurns(reportTurn("done", "never"));
    const s = fakeSession();
    const ac = new AbortController();
    ac.abort("operator cancelled");
    s.session.signal = ac.signal;
    expect(await runtime().run(inbox, s.session)).toMatchObject({
      outcome: "failed",
      summary: expect.stringContaining("cancelled"),
    });
  });
});
