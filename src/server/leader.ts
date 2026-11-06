// Leader election for the background loops (dispatch + reconcile).
// Additional API replicas must not double-dispatch, so exactly one replica runs
// the loops; the rest serve reads. A single-row lease with a heartbeat TTL
// (`leader_state`, see schema.ts): expiry is computed in Postgres (`now()`), so
// app clock skew does not matter and a crashed leader's lease frees itself.
import type { Database } from "./db";

export class LeaderElection {
  constructor(
    private readonly db: Database,
    private readonly instanceId: string,
    private readonly ttlMs: number,
  ) {}

  /** Try to become (or remain) leader. True iff this instance holds the lease. */
  async tryAcquire(): Promise<boolean> {
    const ms = Math.max(1, Math.trunc(this.ttlMs));
    const { rows } = await this.db.query(
      `UPDATE leader_state
          SET holder = $1,
              expires_at = now() + (INTERVAL '1 ms' * $2::int)
        WHERE id = 1 AND (holder = $1 OR expires_at <= now())
        RETURNING holder`,
      [this.instanceId, ms],
    );
    return rows.length > 0;
  }
}
