// SwarmService rules for the transcript, replay journal, usage and spans.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { ValidationError } from "../../src/server/errors";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
import type {
  SessionEventBatch,
  SessionEventInput,
} from "../../src/shared/types";
import { testStore } from "../support/db";
import { memoryTelemetry } from "../support/otel";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
const mem = memoryTelemetry();
let service: SwarmService;
const op = { kind: "operator", name: "operator" } as const;
const asAgent = (name: string) =>
  ({ kind: "agent", name, generation: 1, executionId: "test-exec" }) as const;
beforeAll(async () => {
  ({ db, store, reset } = await testStore());
  service = new SwarmService(store, mem.telemetry);
});
beforeEach(() => reset());
afterAll(() => db.close());

const batch = (
  events: SessionEventInput[],
  over: Partial<SessionEventBatch> = {},
): SessionEventBatch => ({
  agent: "a",
  sessionId: "s1",
  scope: "wi:1",
  events,
  ...over,
});
const ev = (
  seq: number,
  type: SessionEventInput["type"],
  data: Record<string, unknown> = {},
): SessionEventInput => ({ seq, type, data });

describe("ingestEvents validation", () => {
  const ok = [ev(0, "message")];
  it.each([
    ["session id with a slash", batch(ok, { sessionId: "a/b" })],
    ["empty session id", batch(ok, { sessionId: "" })],
    ["scope that is neither wi nor mail", batch(ok, { scope: "task:1" })],
    ["no events", batch([])],
    [
      "too many events",
      batch(Array.from({ length: 201 }, (_, i) => ev(i, "message"))),
    ],
    ["negative seq", batch([ev(-1, "message")])],
    ["fractional seq", batch([ev(0.5, "message")])],
    ["unknown type", batch([ev(0, "dance" as SessionEventInput["type"])])],
    [
      "array data",
      batch([
        {
          seq: 0,
          type: "message",
          data: [] as unknown as Record<string, unknown>,
        },
      ]),
    ],
    ["oversized data", batch([ev(0, "log", { line: "x".repeat(70_000) })])],
    ["bad agent name", batch(ok, { agent: "Not Valid" })],
  ])("rejects %s", async (_name, b) => {
    await expect(service.ingestEvents(b, asAgent(b.agent))).rejects.toThrow(
      ValidationError,
    );
  });

  it("accepts the artifact type", async () => {
    await expect(
      service.ingestEvents(
        batch([ev(0, "artifact", { path: "p" })]),
        asAgent("a"),
      ),
    ).resolves.toEqual({ stored: 1 });
  });

  it("validates event queries", async () => {
    await expect(
      service.events({ type: "dance" as SessionEventInput["type"] }, op),
    ).rejects.toThrow(ValidationError);
    await expect(service.events({ scope: "x" }, op)).rejects.toThrow(
      ValidationError,
    );
    await expect(service.events({ after: -1 }, op)).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("tool metrics from the transcript", () => {
  it("counts each tool_end once, even when the agent resends the batch", async () => {
    const b = batch(
      [
        ev(0, "tool_start", {
          callId: "1",
          tool: "message_send",
          replayable: false,
        }),
        ev(1, "tool_end", {
          callId: "1",
          tool: "message_send",
          replayable: false,
          isError: false,
        }),
        ev(2, "tool_end", {
          callId: "2",
          tool: "message_send",
          replayable: false,
          isError: true,
        }),
      ],
      { agent: "counted" },
    );
    await service.ingestEvents(b, asAgent(b.agent));
    await service.ingestEvents(b, asAgent(b.agent));

    const m = await mem.metrics();
    expect(
      m[
        "folie.tool.calls{agent_name=counted,tool.name=message_send,tool.replayable=false}"
      ],
    ).toBe(2);
    expect(
      m[
        "folie.tool.failures{agent_name=counted,tool.name=message_send,tool.replayable=false}"
      ],
    ).toBe(1);
  });
});

describe("attempts: what an earlier session did", () => {
  const start = (
    seq: number,
    callId: string,
    tool: string,
    replayable: boolean,
    args: unknown = {},
  ) => ev(seq, "tool_start", { callId, tool, replayable, args });
  const end = (seq: number, callId: string, isError = false) =>
    ev(seq, "tool_end", { callId, isError });

  it("pairs starts with ends: done, failed, or interrupted when the session died mid-call", async () => {
    await service.ingestEvents(
      batch(
        [
          start(0, "1", "message_send", false, { to: "bob" }),
          end(1, "1"),
          start(2, "2", "bash", false),
          end(3, "2", true),
          start(4, "3", "message_send", false, { to: "carol" }),
          start(5, "4", "topic_subscribe", true),
        ],
        { sessionId: "old" },
      ),
      asAgent("a"),
    );

    const attempts = await service.attempts(
      "a",
      "wi:1",
      undefined,
      asAgent("a"),
    );
    expect(
      attempts.map((x) => [x.callId, x.tool, x.replayable, x.state]),
    ).toEqual([
      ["1", "message_send", false, "done"],
      ["2", "bash", false, "failed"],
      ["3", "message_send", false, "interrupted"],
      ["4", "topic_subscribe", true, "interrupted"],
    ]);
    expect(attempts[0]!.args).toEqual({ to: "bob" });
  });

  it("keeps sessions apart (call ids repeat across sessions) and can leave the current one out", async () => {
    await service.ingestEvents(
      batch([start(0, "1", "write", false), end(1, "1")], { sessionId: "one" }),
      asAgent("a"),
    );
    await service.ingestEvents(
      batch([start(0, "1", "write", false)], { sessionId: "two" }),
      asAgent("a"),
    );

    expect(
      (await service.attempts("a", "wi:1", undefined, asAgent("a"))).map(
        (x) => [x.sessionId, x.state],
      ),
    ).toEqual([
      ["one", "done"],
      ["two", "interrupted"],
    ]);
    expect(
      (await service.attempts("a", "wi:1", "two", asAgent("a"))).map(
        (x) => x.sessionId,
      ),
    ).toEqual(["one"]);
  });

  it("is empty for a scope nothing ran at, and validates its inputs", async () => {
    expect(
      await service.attempts("a", "wi:99", undefined, asAgent("a")),
    ).toEqual([]);
    await expect(
      service.attempts("a", "bogus", undefined, asAgent("a")),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.attempts("NOPE", "wi:1", undefined, asAgent("NOPE")),
    ).rejects.toThrow(ValidationError);
  });
});

describe("report usage and settlement spans", () => {
  const usage = {
    promptTokens: 100,
    completionTokens: 20,
    costUsd: 0.01,
    toolCalls: 3,
    toolFailures: 1,
  };
  const report = async (over: Record<string, unknown> = {}, agent = "u") => {
    await store.agents.touch(agent);
    const m = await store.messages.send({ from: "h", to: agent, body: "x" });
    return {
      agent,
      startedAt: new Date().toISOString(),
      outcome: "done" as const,
      summary: "s",
      messageIds: [m.id],
      ...over,
    };
  };

  it("stores usage and puts it on the settlement span as llm.usage.* attributes", async () => {
    const r = await service.submitReport(
      await report({ usage }, "usage-ok"),
      asAgent("usage-ok"),
    );
    expect(r.usage).toEqual(usage);
    const span = mem
      .named("folie.report.settle")
      .find((s) => s.attributes.agent_name === "usage-ok")!;
    expect(span.attributes).toMatchObject({
      "llm.usage.prompt_tokens": 100,
      "llm.usage.completion_tokens": 20,
      "llm.usage.cost_usd": 0.01,
      "folie.tool.calls": 3,
      "folie.tool.failures": 1,
    });
  });

  it.each([
    ["negative tokens", { ...usage, promptTokens: -1 }],
    ["fractional tokens", { ...usage, completionTokens: 1.5 }],
    ["NaN cost", { ...usage, costUsd: Number.NaN }],
    ["negative cost", { ...usage, costUsd: -1 }],
    ["missing field", { promptTokens: 1 }],
    ["a string", "lots"],
  ])("rejects usage with %s", async (_n, bad) => {
    await expect(
      service.submitReport(await report({ usage: bad }), asAgent("u")),
    ).rejects.toThrow(ValidationError);
  });

  it("marks the settlement span failed and parks the work item when the session failed", async () => {
    await service.registerAgent("failing");
    const { workItem } = await service.submitGoal(
      { goal: "g", to: "failing" },
      op,
    );
    const [m] = await store.messages.unacked("failing");
    await service.submitReport(
      {
        agent: "failing",
        startedAt: new Date().toISOString(),
        outcome: "failed",
        summary: "API blocked",
        messageIds: [m!.id],
      },
      asAgent("failing"),
    );

    expect((await service.workItem(workItem.id, op)).workItem.state).toBe(
      "blocked",
    );
    const span = mem
      .named("folie.report.settle")
      .find((s) => s.attributes.agent_name === "failing")!;
    expect(span.status).toMatchObject({ code: 2, message: "API blocked" });
    expect(span.attributes["folie.work_item.parked"]).toBe(true);
  });

  it("settles every work item whose mail the session consumed, mid-session mail included", async () => {
    await store.agents.touch("multi");
    const w = await store.workItems.create("g", "assigned");
    const initial = await store.messages.send({
      from: "h",
      to: "multi",
      body: "goal",
      workItemId: w.id,
    });
    const injected = await store.messages.send({
      from: "h",
      to: "multi",
      body: "mid-session correction",
    });

    await service.submitReport(
      {
        agent: "multi",
        startedAt: new Date().toISOString(),
        outcome: "done",
        summary: "s",
        messageIds: [initial.id, injected.id],
      },
      asAgent("multi"),
    );

    expect(await store.messages.unacked("multi")).toEqual([]);
    expect((await service.workItem(w.id, op)).workItem.state).toBe("done");
  });
});

describe("request id and intent validation", () => {
  it.each(["", "x".repeat(201), 7 as unknown as string])(
    "rejects requestId %j",
    async (requestId) => {
      await expect(
        service.send(
          { from: "a", to: "b", body: "x", requestId },
          asAgent("a"),
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.publish("t", { from: "a", body: "x", requestId }, asAgent("a")),
      ).rejects.toThrow(ValidationError);
    },
  );

  it("send dedupes on requestId and marks the span", async () => {
    await service.registerAgent("b");
    const first = await service.send(
      { from: "dup-from", to: "b", body: "x", requestId: "r" },
      asAgent("dup-from"),
    );
    const again = await service.send(
      { from: "dup-from", to: "b", body: "x", requestId: "r" },
      asAgent("dup-from"),
    );
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    const spans = mem
      .named("folie.message.send")
      .filter((s) => s.attributes.agent_name === "dup-from");
    expect(spans.map((s) => s.attributes["folie.duplicate"])).toEqual([
      undefined,
      true,
    ]);
  });

  it("records the domain intent on the root span and rejects an empty one", async () => {
    const { workItem } = await service.submitGoal(
      { goal: "fold the protein", intent: "biology" },
      op,
    );
    expect(
      mem
        .named("folie.work_item.submit")
        .filter((s) => s.attributes.work_item_id === workItem.id)
        .at(-1)!.attributes["folie.intent"],
    ).toBe("biology");
    await expect(
      service.submitGoal({ goal: "g", intent: " " }, op),
    ).rejects.toThrow(ValidationError);
  });

  it("inbox rejects a non-integer work item scope", async () => {
    await expect(
      service.inbox("a", { workItem: 1.5 }, asAgent("a")),
    ).rejects.toThrow(ValidationError);
  });
});
