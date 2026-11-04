// Tool replay safety. Every tool the agent can call carries pi-agent-core's own `replay` policy:
//   "safe"  - running it twice is harmless (reads, idempotent setters). A restarted session may re-run it.
//   "never" - it has a side effect that must not be duplicated (messages, files, shell, external APIs).
//             It is never re-run automatically; the restarted session is told what the earlier attempt did.
// `replayable` on events and spans is `replay === "safe"`. The tool_start/tool_end events are a write-ahead log
// in Postgres (via folie-server), so "what did the last attempt do" survives a crash, suspend or restart.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import type { ToolAttempt } from "../shared/types";

/** Policies for pi's own coding tools, which do not declare one. Folie's native tools declare theirs inline. */
const CODING_TOOL_REPLAY: Record<string, "safe" | "never"> = {
  read: "safe",
  grep: "safe",
  find: "safe",
  ls: "safe",
  bash: "never",
  edit: "never",
  write: "never",
};

/** A tool with no declared policy is treated as unsafe to repeat. */
export const replayPolicy = (tool: AgentTool): "safe" | "never" => tool.replay ?? CODING_TOOL_REPLAY[tool.name] ?? "never";

/**
 * Idempotent native tools whose effect is a state change the session intended. When a crash interrupted one,
 * the restarted session re-runs it to restore that state. Pure reads have nothing to restore.
 */
export const AUTO_REPLAY = new Set(["topic_subscribe", "topic_unsubscribe", "artifact_register"]);

const stable = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * Deterministic idempotency keys for network side effects. The nth identical call (same tool, same args) at a
 * scope always gets the same key, in this session and in a restarted one, so folie-server's unique index drops
 * the duplicate a re-run would otherwise create.
 */
export class RequestIds {
  private readonly seen = new Map<string, number>();
  constructor(private readonly scope: string) {}

  next(tool: string, args: unknown): string {
    const base = `${this.scope}|${tool}|${stable(args)}`;
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32);
  }
}

const brief = (v: unknown) => {
  const s = stable(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/** The prompt section a restarted session starts with; empty when no earlier attempt made a state-changing call. */
export function attemptNotice(attempts: ToolAttempt[]): string {
  const rows = attempts.filter((a) => !a.replayable);
  if (rows.length === 0) return "";
  const line = (a: ToolAttempt) =>
    `- ${a.tool} ${brief(a.args)}: ${a.state === "interrupted" ? "STARTED BUT NEVER FINISHED (check whether it took effect before repeating)" : a.state}`;
  return (
    "An earlier attempt at this work was interrupted. It had already made these state-changing calls; " +
    "do not repeat the ones that are done:\n" +
    rows.map(line).join("\n")
  );
}
