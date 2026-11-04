import type { Runtime } from "../runtime";

/** Deterministic, LLM-free runtime: proves wake -> session -> report wiring end to end. */
export const echoRuntime: Runtime = {
  async run(messages) {
    return { outcome: "done", summary: `echo: ${messages.map((m) => `[${m.from}] ${m.body}`).join(" | ")}` };
  },
};
