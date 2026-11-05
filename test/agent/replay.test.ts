import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  AUTO_REPLAY,
  RequestIds,
  attemptNotice,
  replayPolicy,
} from "../../src/agent/replay";
import type { ToolAttempt } from "../../src/shared/types";

const tool = (name: string, replay?: "safe" | "never") =>
  ({ name, replay }) as unknown as AgentTool;

describe("replayPolicy", () => {
  it("honours a tool's own declaration over any default", () => {
    expect(replayPolicy(tool("anything", "safe"))).toBe("safe");
    expect(replayPolicy(tool("read", "never"))).toBe("never");
  });

  it("knows pi's coding tools: reads are safe, shell and writes are not", () => {
    expect(
      ["read", "grep", "find", "ls"].map((n) => replayPolicy(tool(n))),
    ).toEqual(["safe", "safe", "safe", "safe"]);
    expect(["bash", "edit", "write"].map((n) => replayPolicy(tool(n)))).toEqual(
      ["never", "never", "never"],
    );
  });

  it("treats an undeclared, unknown tool as unsafe to repeat", () => {
    expect(replayPolicy(tool("launch_cluster"))).toBe("never");
  });

  it("only auto-replays idempotent state setters", () => {
    expect([...AUTO_REPLAY].sort()).toEqual([
      "artifact_register",
      "topic_subscribe",
      "topic_unsubscribe",
    ]);
  });
});

describe("RequestIds", () => {
  it("is deterministic: a restarted session computes the same keys", () => {
    const a = new RequestIds("wi:3");
    const b = new RequestIds("wi:3");
    expect(a.next("message_send", { to: "bob", body: "hi" })).toBe(
      b.next("message_send", { to: "bob", body: "hi" }),
    );
  });

  it("ignores argument key order", () => {
    const ids = new RequestIds("wi:3");
    expect(ids.next("t", { a: 1, b: { c: 2, d: 3 } })).toBe(
      new RequestIds("wi:3").next("t", { b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("differs by scope, tool and args", () => {
    const keys = [
      new RequestIds("wi:3").next("message_send", { x: 1 }),
      new RequestIds("wi:4").next("message_send", { x: 1 }),
      new RequestIds("wi:3").next("topic_publish", { x: 1 }),
      new RequestIds("wi:3").next("message_send", { x: 2 }),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("numbers repeats of an identical call so deliberate repetition is not swallowed, yet stays reproducible", () => {
    const first = new RequestIds("wi:3");
    const [one, two] = [first.next("t", {}), first.next("t", {})];
    expect(one).not.toBe(two);
    const restarted = new RequestIds("wi:3");
    expect([restarted.next("t", {}), restarted.next("t", {})]).toEqual([
      one,
      two,
    ]);
  });
});

describe("attemptNotice", () => {
  const at = (over: Partial<ToolAttempt>): ToolAttempt => ({
    sessionId: "s",
    callId: "1",
    tool: "message_send",
    replayable: false,
    args: { to: "bob" },
    state: "done",
    ...over,
  });

  it("is empty when the earlier attempt made no state-changing call", () => {
    expect(attemptNotice([])).toBe("");
    expect(attemptNotice([at({ tool: "read", replayable: true })])).toBe("");
  });

  it("lists each non-replayable call with its state, flagging the interrupted one", () => {
    const text = attemptNotice([
      at({}),
      at({
        callId: "2",
        tool: "bash",
        args: { command: "make" },
        state: "failed",
      }),
      at({ callId: "3", state: "interrupted", args: { to: "carol" } }),
    ]);
    expect(text).toContain('message_send {"to":"bob"}: done');
    expect(text).toContain('bash {"command":"make"}: failed');
    expect(text).toContain(
      'message_send {"to":"carol"}: STARTED BUT NEVER FINISHED',
    );
  });

  it("shortens huge arguments", () => {
    expect(
      attemptNotice([at({ args: { blob: "x".repeat(5000) } })]).length,
    ).toBeLessThan(500);
  });
});
