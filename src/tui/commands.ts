// The TUI's command line: parsing (pure) and execution against folie-server.
import type { FolieClient } from "../shared/client";
import type { AgentOp } from "../shared/types";
import { VIEWS, type View } from "./model";

export type Command =
  | { kind: "submit"; goal: string; to?: string }
  | { kind: "send"; to: string; body: string }
  | { kind: "publish"; topic: string; body: string }
  | { kind: "subscribe" | "unsubscribe"; topic: string; agent: string }
  | { kind: "op"; op: AgentOp; agent: string }
  | { kind: "view"; view: View }
  | { kind: "help" }
  | { kind: "quit" };

export type Parsed = Command | { kind: "error"; message: string };

export const HELP =
  "submit [@agent] <goal> | send [@agent] <text> | publish <topic> <text> | subscribe|unsubscribe <topic> [agent] | suspend|resume|delete [agent] | view <stream|inbox|topics|reports> | quit";

const err = (message: string): Parsed => ({ kind: "error", message });

/** An optional leading `@agent`, else the selected agent (for commands that need a target). */
function target(words: string[], selected: string | null): { agent: string | null; rest: string[] } {
  const first = words[0];
  if (first?.startsWith("@") && first.length > 1) return { agent: first.slice(1), rest: words.slice(1) };
  return { agent: selected, rest: words };
}

/** Parses one line. A leading ":" is allowed. `selected` is the agent commands default to. */
export function parseCommand(input: string, selected: string | null): Parsed {
  const words = input.trim().replace(/^:/, "").split(/\s+/).filter(Boolean);
  const [verb, ...args] = words;
  if (!verb) return err("type a command (help lists them)");

  switch (verb) {
    case "help":
    case "?":
      return { kind: "help" };
    case "quit":
    case "q":
    case "exit":
      return { kind: "quit" };

    case "submit": {
      // Unlike send, an unaddressed goal is queued for the pool, so there is no default target.
      const first = args[0];
      const to = first?.startsWith("@") && first.length > 1 ? first.slice(1) : undefined;
      const goal = (to ? args.slice(1) : args).join(" ");
      return goal ? { kind: "submit", goal, to } : err("usage: submit [@agent] <goal>");
    }
    case "send": {
      const { agent, rest } = target(args, selected);
      if (!agent) return err("send: no agent selected (use @agent)");
      return rest.length ? { kind: "send", to: agent, body: rest.join(" ") } : err("usage: send [@agent] <text>");
    }
    case "publish": {
      const [topic, ...rest] = args;
      return topic && rest.length ? { kind: "publish", topic, body: rest.join(" ") } : err("usage: publish <topic> <text>");
    }
    case "subscribe":
    case "unsubscribe": {
      const [topic, agent = selected ?? undefined] = args;
      if (!topic) return err(`usage: ${verb} <topic> [agent]`);
      if (!agent) return err(`${verb}: no agent selected`);
      return { kind: verb, topic, agent };
    }
    case "suspend":
    case "resume":
    case "delete": {
      const agent = args[0] ?? selected;
      return agent ? { kind: "op", op: verb, agent } : err(`${verb}: no agent selected`);
    }
    case "view": {
      const v = args[0] as View | undefined;
      return v && VIEWS.includes(v) ? { kind: "view", view: v } : err(`usage: view <${VIEWS.join("|")}>`);
    }
    default:
      return err(`unknown command "${verb}" (help lists them)`);
  }
}

export type CommandApi = Pick<FolieClient, "submitGoal" | "send" | "publish" | "subscribe" | "unsubscribe" | "agentOp">;

/** Runs a server-side command and returns the one-line result to show. Throws on server errors. */
export async function execute(cmd: Exclude<Command, { kind: "help" | "quit" | "view" }>, api: CommandApi): Promise<string> {
  switch (cmd.kind) {
    case "submit": {
      const { workItem, message } = await api.submitGoal({ goal: cmd.goal, to: cmd.to });
      return message ? `work item #${workItem.id} sent to ${message.to}` : `work item #${workItem.id} queued`;
    }
    case "send": {
      const m = await api.send({ from: "human", to: cmd.to, body: cmd.body });
      return `message #${m.id} sent to ${cmd.to}`;
    }
    case "publish": {
      const { delivered } = await api.publish(cmd.topic, { from: "human", body: cmd.body });
      return `delivered to ${delivered} subscriber(s) of ${cmd.topic}`;
    }
    case "subscribe":
      await api.subscribe(cmd.topic, { agent: cmd.agent });
      return `${cmd.agent} subscribed to ${cmd.topic}`;
    case "unsubscribe":
      await api.unsubscribe(cmd.topic, { agent: cmd.agent });
      return `${cmd.agent} unsubscribed from ${cmd.topic}`;
    case "op": {
      const { agent, state } = await api.agentOp(cmd.op, cmd.agent);
      return `${agent}: ${state}`;
    }
  }
}
