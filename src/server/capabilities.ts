// Capabilities (R-10): versioned definitions with declared -> assessed -> verified evidence.
// Conservative default: self-declared admits only low-risk work.
import type { Store, CapabilityRecord, CapabilityLevel } from "./store";
import { ValidationError } from "./errors";

export const LEVELS: CapabilityLevel[] = ["declared", "assessed", "verified"];

export const LEVEL_RANK: Record<CapabilityLevel, number> = {
  declared: 0,
  assessed: 1,
  verified: 2,
};

export const RISK_RANK: Record<string, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
  R5: 5,
  R6: 6,
  R7: 7,
};

/** Highest risk class a level may touch without approval. Conservative: declared = low-risk only. */
export const MAX_RISK_BY_LEVEL: Record<CapabilityLevel, number> = {
  declared: 1, // R0-R1 autonomous
  assessed: 3, // R2-R3 with grant, audited
  verified: 6, // R4-R6 need approval on top; level alone never clears R7
};

export function riskRank(riskClass: string): number {
  const r = RISK_RANK[riskClass];
  if (r === undefined) throw new ValidationError(`riskClass: unknown ${riskClass}`);
  return r;
}

export function maxRiskForLevel(level: CapabilityLevel): number {
  return MAX_RISK_BY_LEVEL[level];
}

/** Eligibility: level gate + risk gate. R7 requires independent safety attestation (never level-only). */
export function isEligible(
  actual: CapabilityLevel | null,
  required: CapabilityLevel,
  riskClass: string,
): boolean {
  if (!actual) return false;
  if (LEVEL_RANK[actual] < LEVEL_RANK[required]) return false;
  const risk = riskRank(riskClass);
  if (risk >= 7) return false; // R7 refused without attestation
  return risk <= maxRiskForLevel(actual);
}

export async function defineCapability(
  store: Store,
  b: { name: string; version?: string; description?: string; riskClass?: string },
): Promise<CapabilityRecord> {
  const name = b.name.trim();
  if (!name) throw new ValidationError("name: non-empty required");
  if (b.riskClass !== undefined) riskRank(b.riskClass);
  const existing = await store.capabilities.getByName(name);
  if (existing) return existing; // versioned definitions: same name is same definition in this slice
  return store.capabilities.define(b);
}

export async function declareCapability(
  store: Store,
  agent: string,
  capabilityName: string,
): Promise<{ level: CapabilityLevel }> {
  const cap = await store.capabilities.getByName(capabilityName);
  if (!cap) throw new ValidationError(`capability: unknown ${capabilityName}`);
  const ac = await store.capabilities.declare(agent, cap.id);
  return { level: ac.level };
}

export async function assessCapability(
  store: Store,
  agent: string,
  capabilityName: string,
  probeResult: unknown,
  verifier: string,
): Promise<{ level: CapabilityLevel }> {
  // Evidence only from independence-enforced verification: verifier != subject.
  if (verifier === agent) {
    throw new ValidationError("independence: verifier cannot be the subject");
  }
  const cap = await store.capabilities.getByName(capabilityName);
  if (!cap) throw new ValidationError(`capability: unknown ${capabilityName}`);
  const ac = await store.capabilities.assess(agent, cap.id, probeResult, verifier);
  if (!ac) {
    throw new ValidationError("invalid_transition: assess requires declared level");
  }
  return { level: ac.level };
}

export async function verifyCapability(
  store: Store,
  agent: string,
  capabilityName: string,
  probeResult: unknown,
  verifier: string,
): Promise<{ level: CapabilityLevel }> {
  if (verifier === agent) {
    throw new ValidationError("independence: verifier cannot be the subject");
  }
  const cap = await store.capabilities.getByName(capabilityName);
  if (!cap) throw new ValidationError(`capability: unknown ${capabilityName}`);
  const ac = await store.capabilities.verify(agent, cap.id, probeResult, verifier);
  if (!ac) {
    throw new ValidationError("invalid_transition: verify requires assessed level");
  }
  return { level: ac.level };
}

export async function levelFor(
  store: Store,
  agent: string,
  capabilityName: string,
): Promise<CapabilityLevel | null> {
  const cap = await store.capabilities.getByName(capabilityName);
  if (!cap) return null;
  return store.capabilities.getLevel(agent, cap.id);
}
