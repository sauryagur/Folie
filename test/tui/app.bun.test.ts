// Exercises the OpenTUI edge with the in-memory test renderer. The native core needs Bun, so under Node
// (plain `vitest run`) these are skipped; `bun run test:tui` runs them.
import { createTestRenderer } from "@opentui/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/shared/types";
import { createApp, type App, type AppDeps } from "../../src/tui/app";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const msg = (id: number): Message => ({
  id,
  from: "human",
  to: "agent-1",
  body: `goal ${id}`,
  workItemId: id,
  topic: null,
  createdAt: "2026-11-04T11:59:00Z",
  ackedAt: null,
});

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

describe.skipIf(!process.versions.bun)("TUI app", () => {
  let setup: Setup;
  let app: App;
  let calls: string[];
  let quits: number;
  let failing: boolean;

  const api: AppDeps["api"] = {
    agents: async () => {
      if (failing) throw new Error("ECONNREFUSED");
      return [
        {
          name: "agent-1",
          state: "running",
          wakeEpoch: 1,
          unread: 2,
          lastActiveAt: "2026-11-04T11:59:50Z",
        },
        {
          name: "agent-2",
          state: "suspended",
          wakeEpoch: 3,
          unread: 0,
          lastActiveAt: "2026-11-04T11:50:00Z",
        },
      ];
    },
    messages: async () => [msg(1), msg(2)],
    topics: async () => [{ topic: "news", subscribers: ["agent-1"] }],
    inbox: async (a) => (calls.push(`inbox ${a}`), []),
    reports: async (q) => (calls.push(`reports ${q?.agent}`), []),
    stream: async () => [],
    listBudgets: async () => [],
    submitGoal: async (r) => (
      calls.push(`submit ${r.to ?? "-"} ${r.goal}`),
      {
        workItem: {
          id: 9,
          goal: r.goal,
          state: "queued",
          paused: false,
          createdAt: "",
        },
        message: null,
      }
    ),
    send: async (r) => (
      calls.push(`send ${r.to} ${r.body}`),
      {
        id: 5,
        ...r,
        workItemId: null,
        topic: null,
        createdAt: "",
        ackedAt: null,
      }
    ),
    publish: async () => ({ delivered: 1 }),
    subscribe: async (t, r) => ({ topic: t, agent: r.agent }),
    unsubscribe: async (t, r) => ({ topic: t, agent: r.agent }),
    agentOp: async (op, agent) => (
      calls.push(`${op} ${agent}`),
      { agent, state: "suspended" }
    ),
    queueCancel: async (agent, reason) => (
      calls.push(`cancel ${agent} ${reason}`),
      { cursor: 1 }
    ),
    fetchArtifact: async (ref) => (
      calls.push(`fetch ${ref}`),
      {
        bytes: new Uint8Array([0x61]),
        mediaType: "text/plain",
        ref,
        sha256: "",
        name: "out.txt",
      }
    ),
  };

  /** Key handlers start promise chains (poll, command). The fakes resolve at once, so draining and painting is enough. */
  async function settle() {
    await setup.flush();
    await setup.flush();
  }
  const screen = () => setup.captureCharFrame();

  beforeEach(async () => {
    calls = [];
    quits = 0;
    failing = false;
    // Kitty keyboard encoding makes a lone Escape unambiguous, so it is delivered at once instead of after a hold-back timer.
    setup = await createTestRenderer({
      width: 110,
      height: 24,
      kittyKeyboard: true,
    });
    app = createApp(setup.renderer, {
      api,
      onQuit: () => void quits++,
      now: () => NOW,
      intervalMs: 60_000,
    });
    await app.refresh();
    await settle();
  });
  afterEach(() => {
    app.stop();
    setup.renderer.destroy();
  });

  it("draws the fleet, the stream and the connection state", () => {
    const frame = screen();
    expect(frame).toContain("[1:stream]");
    expect(frame).toContain("● connected");
    expect(frame).toContain("agent-1");
    expect(frame).toContain("working");
    expect(frame).toContain("agent-2");
    expect(frame).toContain("suspended");
    expect(frame).toContain("#1 human > agent-1 (work item 1)  goal 1");
  });

  it("tab cycles the pane and reads only what that view needs", async () => {
    setup.mockInput.pressTab();
    await settle();
    expect(screen()).toContain("[2:inbox]");
    expect(screen()).toContain("inbox: agent-1");
    expect(calls).toContain("inbox agent-1");

    setup.mockInput.pressKey("3");
    await settle();
    expect(screen()).toContain("news  ←  agent-1");
  });

  it("arrow keys move the selection and the per-agent pane follows", async () => {
    setup.mockInput.pressKey("2");
    await settle();
    setup.mockInput.pressArrow("down");
    await settle();
    expect(app.state().selected).toBe("agent-2");
    expect(calls).toContain("inbox agent-2");
  });

  it("':' opens the command line without typing the colon, Enter runs it and reports the result", async () => {
    setup.mockInput.pressArrow("down");
    await settle();
    setup.mockInput.pressKey(":");
    await setup.mockInput.typeText("send hello there");
    await settle();
    expect(screen()).toContain("send hello there");
    expect(screen()).not.toContain(":send");

    setup.mockInput.pressEnter();
    await settle();
    expect(calls).toContain("send agent-2 hello there");
    expect(screen()).toContain("message #5 sent to agent-2");
  });

  it("an unaddressed 'submit' queues a goal", async () => {
    setup.mockInput.pressKey(":");
    await setup.mockInput.typeText("submit write the docs");
    setup.mockInput.pressEnter();
    await settle();
    expect(calls).toContain("submit - write the docs");
    expect(screen()).toContain("work item #9 queued");
  });

  it("s suspends and r resumes the selected agent", async () => {
    setup.mockInput.pressKey("s");
    await settle();
    setup.mockInput.pressKey("r");
    await settle();
    expect(calls).toEqual(
      expect.arrayContaining(["suspend agent-1", "resume agent-1"]),
    );
  });

  it("Escape abandons a half-typed command, and keys work again afterwards", async () => {
    setup.mockInput.pressKey(":");
    await setup.mockInput.typeText("delete agent-1");
    await setup.waitForFrame((f) => f.includes("delete agent-1")); // painted, so its disappearance below means something
    setup.mockInput.pressEscape();
    // The terminal holds a lone Escape back to tell it from an escape sequence, so wait for its effect: the typed text goes.
    await setup.waitForFrame((f) => !f.includes("delete agent-1"));
    expect(calls.some((c) => c.startsWith("delete"))).toBe(false);

    setup.mockInput.pressKey("4");
    await settle();
    expect(screen()).toContain("[4:reports]");
  });

  it("keys typed into the command line are not taken as shortcuts", async () => {
    setup.mockInput.pressKey(":");
    await setup.mockInput.typeText("q");
    await settle();
    expect(quits).toBe(0);
    setup.mockInput.pressEscape();
  });

  it("an error from a command is shown, not thrown", async () => {
    setup.mockInput.pressKey(":");
    await setup.mockInput.typeText("frobnicate");
    setup.mockInput.pressEnter();
    await settle();
    expect(screen()).toContain('unknown command "frobnicate"');
  });

  it("q and the quit command ask the caller to quit", async () => {
    setup.mockInput.pressKey("q");
    await settle();
    expect(quits).toBe(1);
    setup.mockInput.pressKey(":");
    await setup.mockInput.typeText("quit");
    setup.mockInput.pressEnter();
    await settle();
    expect(quits).toBe(2);
  });

  it("shows the server as offline when a poll fails, keeping what was on screen, and recovers", async () => {
    failing = true;
    await app.refresh();
    await settle();
    expect(screen()).toContain("○ offline");
    expect(screen()).toContain("server unreachable: ECONNREFUSED");
    expect(screen()).toContain("agent-1");

    failing = false;
    await app.refresh();
    await settle();
    expect(screen()).toContain("● connected");
  });
});
