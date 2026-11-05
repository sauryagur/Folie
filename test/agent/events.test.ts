import { describe, expect, it } from "vitest";
import { EventSink } from "../../src/agent/events";
import type { SessionEventInput } from "../../src/shared/types";

function sink(send: (e: SessionEventInput[]) => Promise<unknown>) {
  const errors: unknown[] = [];
  return { sink: new EventSink(send, (e) => errors.push(e)), errors };
}

describe("EventSink", () => {
  it("numbers events from zero and delivers them in order", async () => {
    const got: SessionEventInput[][] = [];
    const { sink: s } = sink(async (e) => void got.push(e));
    s.emit("session_start", {});
    s.emit("message", { n: 1 });
    await s.flush();
    expect(got.flat().map((e) => [e.seq, e.type])).toEqual([
      [0, "session_start"],
      [1, "message"],
    ]);
  });

  it("splits large backlogs into bounded batches", async () => {
    const sizes: number[] = [];
    const { sink: s } = sink(async (e) => void sizes.push(e.length));
    for (let i = 0; i < 250; i++) s.emit("log", { i });
    await s.flush();
    expect(sizes).toEqual([100, 100, 50]);
  });

  it("keeps events after a failed delivery and resends them with the same seq on the next flush", async () => {
    let fail = true;
    const got: SessionEventInput[] = [];
    const { sink: s, errors } = sink(async (e) => {
      if (fail) throw new Error("server down");
      got.push(...e);
    });
    s.emit("message", {});
    await s.flush();
    expect(errors).toHaveLength(1);
    expect(got).toEqual([]);

    fail = false;
    s.emit("message", {});
    await s.flush();
    expect(got.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("gives up on a batch after repeated failures so one bad batch cannot block the log forever", async () => {
    let rejected = 0;
    const got: SessionEventInput[] = [];
    const { sink: s } = sink(async (e) => {
      if (e[0]!.seq === 0 && rejected < 99) {
        rejected++;
        throw new Error("400 invalid");
      }
      got.push(...e);
    });
    s.emit("message", {});
    await s.flush();
    await s.flush();
    await s.flush(); // third failure: dropped
    s.emit("message", {});
    await s.flush();

    expect(got.map((e) => e.seq)).toEqual([1]);
  });

  it("clips an event over the size limit instead of sending something the server would reject", async () => {
    const got: SessionEventInput[] = [];
    const { sink: s } = sink(async (e) => void got.push(...e));
    s.emit("tool_end", { output: "x".repeat(100_000) });
    await s.flush();
    expect(got[0]!.data).toMatchObject({ truncated: true });
    expect(JSON.stringify(got[0]!.data).length).toBeLessThan(40_000);
  });

  it("never runs two deliveries at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const { sink: s } = sink(async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
    });
    s.emit("log", {});
    const a = s.flush();
    s.emit("log", {});
    const b = s.flush();
    await Promise.all([a, b]);
    expect(peak).toBe(1);
  });
});
