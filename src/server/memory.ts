// Scoped immutable memory + content-addressed artifacts (ADR 0008, R-4).
// Pure domain logic only: the Postgres adapter lives in pg-store.ts.
// Memberships on a Principal are server-resolved grants (from claims/grants),
// never client-supplied; query() enforces them inside the SQL, not by trust.
import { createHash } from "node:crypto";

export type MemoryScope = "agent" | "team" | "goal" | "swarm";
export type MemoryKind =
  "semantic" | "episodic" | "procedural" | "claim" | "handoff";
export type MemoryStatus = "active" | "contested" | "superseded";
export type MemoryLinkKind =
  "contradicts" | "corroborates" | "supersedes" | "derived_from";

export interface MemoryLink {
  id: number;
  kind: MemoryLinkKind;
  direction: "out" | "in";
}

export interface MemoryEntry {
  id: number;
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  data: Record<string, unknown>;
  provenance: Record<string, unknown>;
  originGoalId: string | null;
  portable: boolean;
  status: MemoryStatus;
  confidence: number;
  supersededBy: number | null;
  taskId: number | null;
  createdBy: string;
  createdAt: string;
  links: MemoryLink[];
}

export interface NewMemory {
  /** Defaults to "goal": agent scope is always an explicit choice (ADR 0008). */
  scope?: MemoryScope;
  scopeId: string;
  kind?: MemoryKind;
  content: string;
  data?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  originGoalId?: string;
  portable?: boolean;
  confidence?: number;
  taskId?: number;
  createdBy: string;
  /** Writes contradicts links and marks both entries contested; nothing is deleted or picked. */
  contradicts?: number[];
  /** Resolution: this new entry supersedes an older one, with evidence in provenance. */
  supersedes?: number;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  scopeId?: string;
  text?: string;
  kinds?: MemoryKind[];
  /** Cross-goal retrieval (R-4.3): only agent-scope entries marked portable. */
  portableOnly?: boolean;
  limit?: number;
}

/** Server-resolved principal for memory reads. Operators with viewer see all. */
export interface MemoryPrincipal {
  name: string;
  kind?: "agent" | "operator";
  /** Team scope_ids this principal belongs to. */
  teams?: string[];
  /** Goal scope_ids this principal participates in. */
  goals?: string[];
  /** Swarm read grant (memory.read:swarm). */
  swarm?: boolean;
}

export function canRead(entry: MemoryEntry, as: MemoryPrincipal): boolean {
  if (as.kind === "operator") return true;
  switch (entry.scope) {
    case "agent":
      return entry.scopeId === as.name;
    case "team":
      return (as.teams ?? []).includes(entry.scopeId);
    case "goal":
      return (as.goals ?? []).includes(entry.scopeId);
    case "swarm":
      return as.swarm === true;
  }
}

// --- Artifacts (R-4.4) ---

export interface ArtifactPutInput {
  bytes: Uint8Array;
  mediaType?: string;
  name?: string;
  description?: string;
  producer: string;
  goalId?: string;
  taskId?: number;
  provenance?: Record<string, unknown>;
}

export interface StoredArtifact {
  sha256: string;
  ref: string;
  bytes: number;
  name: string;
  mediaType: string;
  description: string;
  producer: string;
  goalId: string | null;
  taskId: number | null;
  provenance: Record<string, unknown>;
  createdAt: string;
  data: Uint8Array;
}

export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Stable ref: refs must survive a storage swap, so they never encode a path. */
export const artifactRef = (sha256: string): string => `sha256/${sha256}`;

export const artifactHash = (refOrHash: string): string =>
  refOrHash.startsWith("sha256/") ? refOrHash.slice(7) : refOrHash;
