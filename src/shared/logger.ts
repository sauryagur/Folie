import { format } from "node:util";
import { activeSpanIds } from "./trace";

export type Logger = Pick<Console, "log" | "error">;

/** A Logger that can carry fixed fields (agent_name, work_item_id, ...) into every line it writes. */
export interface StructuredLogger extends Logger {
  child(fields: Record<string, unknown>): StructuredLogger;
}

export interface LogSink {
  out(line: string): void;
  err(line: string): void;
}

const consoleSink: LogSink = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

/**
 * One JSON object per line: `ts`, `level`, `msg`, the fixed fields, and, when a span is active, its
 * `trace_id` and `span_id`, so a collector (or the TUI) can join log lines to traces without parsing text.
 * Stdout carries `info`, stderr carries `error`.
 */
export function jsonLogger(
  fields: Record<string, unknown> = {},
  sink: LogSink = consoleSink,
): StructuredLogger {
  const write = (level: "info" | "error", args: unknown[]) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: format(...args),
      ...fields,
      ...activeSpanIds(),
    });
    (level === "error" ? sink.err : sink.out)(line);
  };
  return {
    log: (...args: unknown[]) => write("info", args),
    error: (...args: unknown[]) => write("error", args),
    child: (more) => jsonLogger({ ...fields, ...more }, sink),
  };
}
