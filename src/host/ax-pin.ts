// The Substrate release Folie's vendored proto (proto/substrate/) speaks. The ax checkout `folie up` installs
// decides which Substrate the cluster gets (its go.mod); a mismatch makes folie-server's Substrate calls fail at
// wake time, which leaves agents created but never started. Bump together with proto/ (see proto/README.md).
import { join } from "node:path";

export const SUBSTRATE_VERSION = "v1.0.0";

/** The `go.ate.dev/substrate` version an ax go.mod requires, or null when it names none. */
export function substrateVersionOf(goMod: string): string | null {
  return goMod.match(/^\s*go\.ate\.dev\/substrate\s+(v\S+)/m)?.[1] ?? null;
}

/** A warning when the ax checkout installs a different Substrate than Folie speaks, else null. */
export function axPinWarning(
  goMod: string | null,
  axDir: string,
  expected = SUBSTRATE_VERSION,
): string | null {
  if (goMod === null)
    return `no go.mod in ${axDir}; cannot check which Substrate it installs (Folie expects ${expected})`;
  const found = substrateVersionOf(goMod);
  if (found === expected) return null;
  return (
    `ax at ${axDir} installs Substrate ${found ?? "(unknown)"}, but Folie's vendored Substrate proto is ${expected}. ` +
    `Agent wakes may fail at the egress-policy call. Check out a matching ax, or re-vendor proto/ (proto/README.md).`
  );
}

export async function checkAxPin(axDir: string): Promise<string | null> {
  const f = Bun.file(join(axDir, "go.mod"));
  return axPinWarning((await f.exists()) ? await f.text() : null, axDir);
}
