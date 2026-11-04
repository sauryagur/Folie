// Pool policy: which agent takes the next unaddressed goal. Pure so it is trivially testable.
import { POOL_AGENT_PREFIX, type AgentInfo } from "../shared/types";

const POOL_NAME = new RegExp(`^${POOL_AGENT_PREFIX}(\\d+)$`);

// Cheapest to hand work to first: already running, then suspended (a resume), then retired (a fresh task).
const WARMTH: Record<string, number> = { running: 0, pending: 1, suspended: 1, retired: 2 };

const poolNumber = (name: string) => Number(POOL_NAME.exec(name)?.[1]);

/**
 * Picks the agent for the next queued goal: an idle pool agent (warmest first, then lowest number),
 * else a new one while fewer than `maxAgents` are alive, else null (the goal stays queued).
 * Agents addressed by name (`--to lead`) are never drafted into the pool.
 */
export function choosePoolAgent(agents: AgentInfo[], maxAgents: number): string | null {
  const pool = agents.filter((a) => POOL_NAME.test(a.name));
  const idle = pool
    .filter((a) => a.unread === 0)
    .sort((a, b) => (WARMTH[a.state] ?? 1) - (WARMTH[b.state] ?? 1) || poolNumber(a.name) - poolNumber(b.name));
  if (idle[0]) return idle[0].name;

  if (pool.filter((a) => a.state !== "retired").length >= maxAgents) return null;
  const used = new Set(pool.map((a) => poolNumber(a.name)));
  let n = 1;
  while (used.has(n)) n++;
  return `${POOL_AGENT_PREFIX}${n}`;
}
