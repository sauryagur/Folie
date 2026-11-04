// CLI commands over FolieClient. Pure of process state so they can be tested with a fake client and sink.
import { parseArgs } from "node:util";
import type { FolieClient } from "../shared/client";
import type { WorkItemView } from "../shared/types";

export type Api = Pick<FolieClient, "submitGoal" | "workItem" | "agents">;
export type Out = (line: string) => void;

export interface Options {
  /** Delay between polls of `submit --wait`. */
  pollMs?: number;
}

const SETTLED: Record<string, true> = { done: true, blocked: true, failed: true };

export function formatWorkItem({ workItem, report }: WorkItemView): string[] {
  const lines = [`work item #${workItem.id}: ${workItem.state}`, `goal: ${workItem.goal}`];
  if (report) lines.push(`report (${report.agent}, ${report.outcome}): ${report.summary}`);
  return lines;
}

export async function submit(api: Api, args: string[], out: Out, opts: Options = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { to: { type: "string" }, wait: { type: "boolean" }, timeout: { type: "string", default: "600" } },
  });
  const goal = positionals.join(" ").trim();
  if (!goal) throw new Error('usage: folie submit "<goal>" [--to <agent>] [--wait [--timeout <seconds>]]');

  const { workItem, message } = await api.submitGoal({ goal, to: values.to });
  out(message ? `submitted work item #${workItem.id} to ${message.to}` : `queued work item #${workItem.id}`);
  if (!values.wait) return 0;

  const deadline = Date.now() + Number(values.timeout) * 1000;
  for (;;) {
    const view = await api.workItem(workItem.id);
    if (SETTLED[view.workItem.state]) {
      for (const line of formatWorkItem(view)) out(line);
      return view.workItem.state === "done" ? 0 : 1;
    }
    if (Date.now() > deadline) throw new Error(`work item #${workItem.id} still ${view.workItem.state} after ${values.timeout}s`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
  }
}

export async function status(api: Api, args: string[], out: Out): Promise<number> {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) throw new Error("usage: folie status <work-item-id>");
  for (const line of formatWorkItem(await api.workItem(id))) out(line);
  return 0;
}

export async function agents(api: Api, _args: string[], out: Out): Promise<number> {
  const list = await api.agents();
  if (list.length === 0) out("no agents yet");
  for (const a of list) out(`${a.name.padEnd(24)} ${a.state.padEnd(10)} unread=${a.unread} wakes=${a.wakeEpoch}`);
  return 0;
}
