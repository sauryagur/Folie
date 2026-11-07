// CLI commands over FolieClient. Pure of process state so they can be tested with a fake client and sink.
import { parseArgs } from "node:util";
import type { FolieClient } from "../shared/client";
import type { WorkItemView } from "../shared/types";

export type Api = Pick<
  FolieClient,
  | "submitGoal"
  | "workItem"
  | "agents"
  | "topics"
  | "subscribe"
  | "unsubscribe"
  | "publish"
  | "queueCancel"
  | "agentOp"
>;
export type Out = (line: string) => void;

export interface Options {
  /** Delay between polls of `submit --wait`. */
  pollMs?: number;
}

const SETTLED: Record<string, true> = {
  done: true,
  blocked: true,
  failed: true,
};

export function formatWorkItem({ workItem, report }: WorkItemView): string[] {
  const lines = [
    `work item #${workItem.id}: ${workItem.state}`,
    `goal: ${workItem.goal}`,
  ];
  if (report)
    lines.push(
      `report (${report.agent}, ${report.outcome}): ${report.summary}`,
    );
  return lines;
}

export async function submit(
  api: Api,
  args: string[],
  out: Out,
  opts: Options = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      to: { type: "string" },
      wait: { type: "boolean" },
      timeout: { type: "string", default: "600" },
    },
  });
  const goal = positionals.join(" ").trim();
  if (!goal)
    throw new Error(
      'usage: folie submit "<goal>" [--to <agent>] [--wait [--timeout <seconds>]]',
    );

  const { workItem, message } = await api.submitGoal({ goal, to: values.to });
  out(
    message
      ? `submitted work item #${workItem.id} to ${message.to}`
      : `queued work item #${workItem.id}`,
  );
  if (!values.wait) return 0;

  const deadline = Date.now() + Number(values.timeout) * 1000;
  for (;;) {
    const view = await api.workItem(workItem.id);
    if (SETTLED[view.workItem.state]) {
      for (const line of formatWorkItem(view)) out(line);
      return view.workItem.state === "done" ? 0 : 1;
    }
    if (Date.now() > deadline)
      throw new Error(
        `work item #${workItem.id} still ${view.workItem.state} after ${values.timeout}s`,
      );
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
  }
}

export async function status(
  api: Api,
  args: string[],
  out: Out,
): Promise<number> {
  const id = Number(args[0]);
  if (!Number.isInteger(id))
    throw new Error("usage: folie status <work-item-id>");
  for (const line of formatWorkItem(await api.workItem(id))) out(line);
  return 0;
}

export async function agents(
  api: Api,
  _args: string[],
  out: Out,
): Promise<number> {
  const list = await api.agents();
  if (list.length === 0) out("no agents yet");
  for (const a of list)
    out(
      `${a.name.padEnd(24)} ${a.state.padEnd(10)} unread=${a.unread} wakes=${a.wakeEpoch}`,
    );
  return 0;
}

export async function topics(
  api: Api,
  _args: string[],
  out: Out,
): Promise<number> {
  const list = await api.topics();
  if (list.length === 0) out("no topics yet");
  for (const t of list)
    out(`${t.topic.padEnd(24)} ${t.subscribers.join(", ")}`);
  return 0;
}

function topicAndAgent(args: string[], verb: string): [string, string] {
  const [topic, agent, extra] = args;
  if (!topic || !agent || extra !== undefined)
    throw new Error(`usage: folie ${verb} <topic> <agent>`);
  return [topic, agent];
}

export async function subscribe(
  api: Api,
  args: string[],
  out: Out,
): Promise<number> {
  const [topic, agent] = topicAndAgent(args, "subscribe");
  await api.subscribe(topic, { agent });
  out(`${agent} subscribed to ${topic}`);
  return 0;
}

export async function unsubscribe(
  api: Api,
  args: string[],
  out: Out,
): Promise<number> {
  const [topic, agent] = topicAndAgent(args, "unsubscribe");
  await api.unsubscribe(topic, { agent });
  out(`${agent} unsubscribed from ${topic}`);
  return 0;
}

export async function publish(
  api: Api,
  args: string[],
  out: Out,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { from: { type: "string", default: "human" } },
  });
  const [topic, ...words] = positionals;
  const body = words.join(" ").trim();
  if (!topic || !body)
    throw new Error('usage: folie publish <topic> "<message>" [--from <name>]');
  const { delivered } = await api.publish(topic, { from: values.from, body });
  out(`delivered to ${delivered} subscriber(s) of ${topic}`);
  return 0;
}

export async function cancel(
  api: Api,
  args: string[],
  out: Out,
): Promise<number> {
  const [agent, ...words] = args;
  if (!agent) throw new Error("usage: folie cancel <agent> [reason]");
  const reason = words.join(" ").trim() || "cancelled from CLI";
  const { cursor } = await api.queueCancel(agent, reason);
  out(`cancel queued for ${agent} (cursor ${cursor})`);
  return 0;
}

async function op(
  api: Api,
  args: string[],
  out: Out,
  verb: "pause" | "resume",
): Promise<number> {
  const [agent] = args;
  if (!agent || args.length !== 1)
    throw new Error(`usage: folie ${verb} <agent>`);
  const { agent: name, state } = await api.agentOp(
    verb === "pause" ? "suspend" : "resume",
    agent,
  );
  out(`${name}: ${state}`);
  return 0;
}

export const pause = (api: Api, args: string[], out: Out) =>
  op(api, args, out, "pause");
export const resume = (api: Api, args: string[], out: Out) =>
  op(api, args, out, "resume");
