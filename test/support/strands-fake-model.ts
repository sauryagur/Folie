import {
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  type BaseModelConfig,
  type ModelStreamEvent,
  type StreamOptions,
} from "@strands-agents/sdk";
import type { Message, StopReason } from "@strands-agents/sdk";

export type FakeTurn =
  | { kind: "text"; text: string; stopReason?: StopReason; holdMs?: number }
  | { kind: "tools"; calls: { name: string; input: Record<string, unknown> }[]; holdMs?: number };

/** Deterministic Strands Model for adapter tests; one queue entry per model invocation. */
export class FakeStrandsModel extends Model {
  private config: BaseModelConfig = { modelId: "folie-fake" };
  private queue: FakeTurn[] = [];
  private nextToolId = 0;
  readonly prompts: string[] = [];

  setTurns(...turns: FakeTurn[]) {
    this.queue = [...turns];
    this.nextToolId = 0;
    this.prompts.length = 0;
  }

  updateConfig(modelConfig: BaseModelConfig) {
    this.config = { ...this.config, ...modelConfig };
  }

  getConfig() {
    return this.config;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (options?.cancelSignal?.aborted) {
      yield new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" });
      yield new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "cancelled" });
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      const text = lastUser.content
        .flatMap((b) => (b.type === "textBlock" && "text" in b ? [String(b.text)] : []))
        .join("\n");
      this.prompts.push(text);
    }

    const turn = this.queue.shift();
    yield new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" });
    if (!turn) {
      yield new ModelMetadataEvent({
        type: "modelMetadataEvent",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      yield new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "endTurn" });
      return;
    }

    if (turn.holdMs) await new Promise((r) => setTimeout(r, turn.holdMs));

    if (turn.kind === "text") {
      yield new ModelContentBlockStartEvent({ type: "modelContentBlockStartEvent" });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: turn.text },
      });
      yield new ModelContentBlockStopEvent({ type: "modelContentBlockStopEvent" });
      yield new ModelMetadataEvent({
        type: "modelMetadataEvent",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      yield new ModelMessageStopEvent({
        type: "modelMessageStopEvent",
        stopReason: turn.stopReason ?? "endTurn",
      });
      return;
    }

    for (const call of turn.calls) {
      const toolUseId = `tu-${++this.nextToolId}`;
      yield new ModelContentBlockStartEvent({
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: call.name, toolUseId },
      });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "toolUseInputDelta",
          input: JSON.stringify(call.input),
        },
      });
      yield new ModelContentBlockStopEvent({ type: "modelContentBlockStopEvent" });
    }
    yield new ModelMetadataEvent({
      type: "modelMetadataEvent",
      usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
    });
    yield new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "toolUse" });
  }
}

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
