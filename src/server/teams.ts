// Teams (R-9.5) + coordination contracts: discovery, negotiation ladder, quotas.
// Contracts only; no leader election, no stall/loop detection beyond counters, no live thread UI.
import type { TaskRecord } from "../shared/types";
import type { Store, TeamRecord } from "./store";
import { ValidationError } from "./errors";

export const MAX_TEAMS_PER_GOAL = 3;
export const MAX_TEAM_SIZE = 8;
export const MAX_TEAM_MEMBERSHIPS = 2;

export const TEAM_TRANSITIONS: Record<string, string[]> = {
  forming: ["active", "dissolved"],
  active: ["dissolving", "dissolved"],
  dissolving: ["dissolved"],
  dissolved: [],
};

export function assertTransition(from: string, to: string): void {
  if (!TEAM_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError(`invalid_transition: ${from} -> ${to}`);
  }
}

export async function formTeam(
  store: Store,
  b: {
    name: string;
    scopeKind: "goal" | "task";
    scopeId: string;
    purpose: string;
    convener: string;
    budgetId?: number;
    budgetAsk?: number;
    dim?: string;
    minMembers?: number;
    charter?: Record<string, unknown>;
  },
): Promise<TeamRecord> {
  const name = b.name.trim();
  if (!name) throw new ValidationError("name: non-empty required");
  if (b.scopeKind !== "goal" && b.scopeKind !== "task") {
    throw new ValidationError("scopeKind: goal|task required");
  }
  if (!b.scopeId) throw new ValidationError("scopeId: non-empty required");
  if (!b.convener) throw new ValidationError("convener: non-empty required");
  if (
    b.budgetAsk !== undefined &&
    (!Number.isFinite(b.budgetAsk) || b.budgetAsk <= 0)
  ) {
    throw new ValidationError("budgetAsk: positive number required");
  }
  const dupe = await store.teams.getByName(name);
  if (dupe) throw new ValidationError(`name: team ${name} already exists`);

  // Per-scope cap: contracts-only enforcement via list scan.
  const scoped = (await store.teams.list()).filter(
    (t) =>
      t.scopeKind === b.scopeKind &&
      t.scopeId === b.scopeId &&
      t.status !== "dissolved",
  );
  if (scoped.length >= MAX_TEAMS_PER_GOAL) {
    throw new ValidationError("quota_exceeded: max_teams per scope");
  }

  // Budget slice carve-out: team's budget comes from the scope's budget via carveOut.
  // If budgetId already names the slice, attach it; if budgetAsk given, carve from scope budget.
  let budgetId = b.budgetId;
  if (b.budgetAsk !== undefined) {
    if (!b.budgetId)
      throw new ValidationError(
        "budgetId: scope budget required for carve-out",
      );
    const child = await store.budgets.carveOut(
      b.budgetId,
      `team:${name}`,
      b.budgetAsk,
    );
    if (!child)
      throw new ValidationError(
        "insufficient_budget: scope headroom cannot cover team slice",
      );
    budgetId = child.id;
  }

  return store.teams.create({
    name,
    scopeKind: b.scopeKind,
    scopeId: b.scopeId,
    purpose: b.purpose,
    convener: b.convener,
    budgetId,
    minMembers: b.minMembers ?? 1,
    charter: b.charter ?? {},
  });
}

export async function joinTeam(
  store: Store,
  teamId: number,
  agent: string,
  label = "",
  responsibilities = "",
): Promise<void> {
  const team = await store.teams.get(teamId);
  if (!team) throw new ValidationError(`teamId: unknown ${teamId}`);
  if (team.status !== "forming" && team.status !== "active") {
    throw new ValidationError(`invalid_transition: join in ${team.status}`);
  }
  const members = await store.teams.members(teamId);
  if (!members.some((m) => m.agent === agent)) {
    if (members.length >= MAX_TEAM_SIZE) {
      throw new ValidationError("quota_exceeded: max_team_size");
    }
    const all = (await store.teams.list()).filter(
      (t) => t.status !== "dissolved",
    );
    let memberships = 0;
    for (const t of all) {
      const ms = await store.teams.members(t.id);
      if (ms.some((m) => m.agent === agent)) memberships++;
    }
    if (memberships >= MAX_TEAM_MEMBERSHIPS) {
      throw new ValidationError("quota_exceeded: max_team_memberships");
    }
  }
  await store.teams.addMember(teamId, agent, label, responsibilities);
}

export async function setResponsibility(
  store: Store,
  teamId: number,
  agent: string,
  responsibilities: string,
): Promise<void> {
  if (typeof responsibilities !== "string") {
    throw new ValidationError("responsibilities: string required");
  }
  const members = await store.teams.members(teamId);
  if (!members.some((m) => m.agent === agent)) {
    throw new ValidationError(`agent: ${agent} is not a team member`);
  }
  await store.teams.setResponsibility(teamId, agent, responsibilities);
}

export async function activateTeam(
  store: Store,
  teamId: number,
): Promise<TeamRecord> {
  const team = await store.teams.get(teamId);
  if (!team) throw new ValidationError(`teamId: unknown ${teamId}`);
  assertTransition(team.status, "active");
  const members = await store.teams.members(teamId);
  if (members.length < team.minMembers) {
    throw new ValidationError("min_members not reached");
  }
  const out = await store.teams.setStatus(teamId, "active");
  if (!out) throw new ValidationError(`teamId: unknown ${teamId}`);
  return out;
}

export async function dissolveTeam(
  store: Store,
  teamId: number,
): Promise<TeamRecord> {
  const team = await store.teams.get(teamId);
  if (!team) throw new ValidationError(`teamId: unknown ${teamId}`);
  assertTransition(team.status, "dissolving");
  return store.transaction(async (r) => {
    const dissolving = await r.teams.setStatus(teamId, "dissolving");
    if (!dissolving) throw new ValidationError(`teamId: unknown ${teamId}`);
    // Dissolution returns unspent budget to scope via Budgets.close (reserved -= limit, spent += spent).
    if (dissolving.budgetId !== null) {
      await r.budgets.close(dissolving.budgetId);
    }
    const out = await r.teams.setStatus(teamId, "dissolved");
    if (!out) throw new ValidationError(`teamId: unknown ${teamId}`);
    return out;
  });
}

export async function addTeamNote(
  store: Store,
  teamId: number,
  createdBy: string,
  content: string,
  kind:
    "semantic" | "episodic" | "procedural" | "claim" | "handoff" = "semantic",
): Promise<number> {
  const team = await store.teams.get(teamId);
  if (!team) throw new ValidationError(`teamId: unknown ${teamId}`);
  if (!content.trim()) throw new ValidationError("content: non-empty required");
  return store.memories.write({
    scope: "team",
    scopeId: team.name,
    kind,
    content,
    createdBy,
  });
}

export async function listTeamNotes(
  store: Store,
  teamId: number,
  as: { name: string; kind?: "agent" | "operator"; teams?: string[] },
) {
  const team = await store.teams.get(teamId);
  if (!team) throw new ValidationError(`teamId: unknown ${teamId}`);
  return store.memories.query({ scope: "team", scopeId: team.name }, as);
}

// --- Discovery (hybrid push/pull, targeted notification) ---

export interface DiscoveryCandidate {
  agent: string;
  capabilityLevel: number; // 0-2 (declared/assessed/verified)
  affinity: number; // worked on goal/parent
  load: number; // current claims
  warmed: boolean; // running
}

export function scoreCandidate(c: DiscoveryCandidate): number {
  return (
    c.capabilityLevel * 10 + c.affinity * 5 + (c.warmed ? 3 : 0) - c.load * 2
  );
}

/** Push: top-K ranked eligible agents; never broadcast. Pull is the indexed query below. */
export function nominate(
  candidates: DiscoveryCandidate[],
  k: number,
): string[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      scoreCandidate(b) - scoreCandidate(a) || a.agent.localeCompare(b.agent),
  );
  return ranked.slice(0, Math.max(0, k)).map((c) => c.agent);
}

/** Pull: discoverable tasks via indexed tasks_available query (task.list contract). */
export async function discoverTasks(
  store: Store,
  filter: { goalId?: number; status?: string; limit?: number } = {},
): Promise<TaskRecord[]> {
  // Contracts-only: the pull endpoint lands with the task.list slice; callers depend on the shape here.
  void store;
  void filter;
  return [];
}

// --- Negotiation ladder: owner decides in-task; dissent to verification; goal owner -> reviewer -> human ---

export type EscalationLevel = 0 | 1 | 2 | 3; // 0 in-task, 1 goal owner, 2 reviewer, 3 human

export function nextEscalation(level: EscalationLevel): EscalationLevel | null {
  return level >= 3 ? null : ((level + 1) as EscalationLevel);
}

export async function recordDissent(
  store: Store,
  taskId: number,
  contributor: string,
  note: string,
): Promise<number> {
  if (!note.trim()) throw new ValidationError("note: non-empty required");
  const t = await store.tasks.get(taskId);
  if (!t) throw new ValidationError(`taskId: unknown ${taskId}`);
  // Dissent notes go to verification as context: persisted on the task's verification rows' side.
  return store.coordination.recordDissent(taskId, contributor, note);
}

// --- Runaway quotas (counters only; stall/loop detection excluded) ---

export const QUOTA_EXCEEDED = "quota_exceeded";

export interface QuotaCounters {
  depth: number;
  fanOut: number;
  wip: number;
  proposalsLastHour: number;
}

export const DEFAULT_QUOTAS: {
  maxDepth: number;
  maxFanOut: number;
  maxWip: number;
  maxProposalsPerHour: number;
} = {
  maxDepth: 4,
  maxFanOut: 8,
  maxWip: 32,
  maxProposalsPerHour: 20,
};

export function checkQuota(
  c: QuotaCounters,
  limits: {
    maxDepth: number;
    maxFanOut: number;
    maxWip: number;
    maxProposalsPerHour: number;
  } = DEFAULT_QUOTAS,
): string | null {
  if (c.depth > limits.maxDepth) return "depth";
  if (c.fanOut >= limits.maxFanOut) return "fan-out";
  if (c.wip >= limits.maxWip) return "wip";
  if (c.proposalsLastHour >= limits.maxProposalsPerHour)
    return "proposals/hour";
  return null;
}
