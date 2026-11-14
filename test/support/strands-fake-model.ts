// Test helpers and re-exports for the deterministic Strands fake model.
export {
  FakeStrandsModel,
  type FakeTurn,
} from "../../src/agent/runtimes/fake-strands-model";
import type { FakeTurn } from "../../src/agent/runtimes/fake-strands-model";
import type { StopReason } from "@strands-agents/sdk";

export const toolTurn = (name: string, input: Record<string, unknown>): FakeTurn => ({
  kind: "tools",
  calls: [{ name, input }],
});

export const textTurn = (text: string, stopReason: StopReason = "endTurn"): FakeTurn => ({
  kind: "text",
  text,
  stopReason,
});

export const reportTurn = (outcome: "done" | "failed", summary: string): FakeTurn =>
  toolTurn("report_submit", { outcome, summary });
