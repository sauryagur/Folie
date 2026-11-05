// Wraps a tool so every call is traced and journaled: a span (`tool.name`, `tool.replayable`, duration,
// `tool.exit_code`) and tool_start/tool_end events shipped to folie-server.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context } from "@opentelemetry/api";
import { failSpan, withSpan } from "../shared/trace";
import { replayPolicy } from "./replay";
import type { Session } from "./runtime";

export interface ToolStats {
  toolCalls: number;
  toolFailures: number;
}

/** pi's bash tool reports an exit code in its result details; other tools have none. */
const exitCodeOf = (details: unknown): number | undefined =>
  typeof details === "object" &&
  details !== null &&
  "exitCode" in details &&
  typeof details.exitCode === "number"
    ? details.exitCode
    : undefined;

/**
 * `parent` is read per call: tool spans hang under the turn that requested them.
 * A side-effecting (non-replayable) call is flushed to the server BEFORE it runs, and again after: if the process
 * dies in between, the log shows a start with no end, which is how a restarted session knows the call is of unknown outcome.
 */
export function instrument(
  tool: AgentTool,
  session: Session,
  parent: () => Context,
  stats: ToolStats,
): AgentTool {
  const replayable = replayPolicy(tool) === "safe";
  return {
    ...tool,
    replay: replayable ? "safe" : "never",
    execute: (callId, params, signal, onUpdate) =>
      withSpan(
        session.tracer,
        `folie.tool.${tool.name}`,
        {
          parent: parent(),
          attributes: {
            "tool.name": tool.name,
            "tool.replayable": replayable,
            "tool.call_id": callId,
          },
        },
        async (span) => {
          const startedAt = performance.now();
          const base = { callId, tool: tool.name, replayable };
          session.events.emit("tool_start", { ...base, args: params });
          if (!replayable) await session.events.flush();
          stats.toolCalls++;
          try {
            const result = await tool.execute(callId, params, signal, onUpdate);
            const exitCode = exitCodeOf(result.details) ?? 0;
            span.setAttribute("tool.exit_code", exitCode);
            session.events.emit("tool_end", {
              ...base,
              isError: false,
              exitCode,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return result;
          } catch (e) {
            stats.toolFailures++;
            failSpan(span, e);
            span.setAttribute(
              "tool.exit_code",
              (e instanceof Error && "details" in e
                ? exitCodeOf(e.details)
                : undefined) ?? 1,
            );
            session.events.emit("tool_end", {
              ...base,
              isError: true,
              error: e instanceof Error ? e.message : String(e),
              durationMs: Math.round(performance.now() - startedAt),
            });
            throw e;
          } finally {
            if (!replayable) await session.events.flush();
          }
        },
      ),
  };
}
