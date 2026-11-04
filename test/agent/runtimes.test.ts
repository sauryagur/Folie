import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/agent/runtimes";
import type { Message } from "../../src/shared/types";

const env = { agentName: "a", runtime: "echo", model: "anthropic/x", workdir: "/tmp" };
const server = {
  send: async () => { throw new Error("unused"); },
  subscribe: async () => { throw new Error("unused"); },
  unsubscribe: async () => { throw new Error("unused"); },
  publish: async () => { throw new Error("unused"); },
};
const m = (id: number, from: string, body: string): Message => ({ id, from, to: "a", body, workItemId: null, topic: null, createdAt: "", ackedAt: null });

describe("createRuntime", () => {
  it("echo summarizes every message deterministically", async () => {
    const rt = await createRuntime(env, server);
    expect(await rt.run([m(1, "human", "hi"), m(2, "bob", "yo")])).toEqual({ outcome: "done", summary: "echo: [human] hi | [bob] yo" });
  });

  it("rejects unknown runtimes, naming the choices", async () => {
    await expect(createRuntime({ ...env, runtime: "claude" }, server)).rejects.toThrow(/unknown FOLIE_RUNTIME.*pi\|echo/);
  });

  it.each(["noslash", "/model", ""])("rejects malformed FOLIE_MODEL %j", async (model) => {
    await expect(createRuntime({ ...env, runtime: "pi", model }, server)).rejects.toThrow(/FOLIE_MODEL/);
  });

  it("rejects a model pi does not know", async () => {
    await expect(createRuntime({ ...env, runtime: "pi", model: "anthropic/definitely-not-a-model" }, server)).rejects.toThrow(/unknown model/);
  });
});
