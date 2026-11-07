# Handoff

## Goal

Continue implementing Folie against [`spec/requirements.md`](spec/requirements.md). It is the normative spec; [`DESIGN.md`](DESIGN.md) is the architectural overview. Do not recreate a phased roadmap; the user explicitly requested one spec that must be met. (The implementation code has since changed — trust the "Current state" section below, not any earlier version of this file.)

## Current state (as of 2026-11-07, commit `ebc9287` + uncommitted latency metrics)

- The architecture/spec/ADR documents were rewritten for a general-purpose autonomous swarm. Read `DESIGN.md` first, then the requirements relevant to the code being changed.
- **Implemented and verified**: authenticated identity (R-1.1–R-1.5); persisted sessions (R-3.2); ExecutionRegistry (R-6.2/6.3); task claims (R-8.2, single conditional claim, fence-checked start/submit); budgets (R-13.1/13.2, headroom carve-outs, E0/E1); verification (R-11.1–11.3, independent verdicts, submitted→verified aggregation, goal evaluation from verified coverage); cancellation (R-2.4/R-2.5, durable control signals, cooperative shim); cheap enforcement (R-6.7 `spec.debug:false`, R-6.11 default `ResourcesSpec` 500m/512Mi); gateway E2 (ADR 0007, credential scrubbing, budget reserve/commit); scoped memory + content-addressed artifacts (ADR 0008, R-4.1/4.2/4.4); teams + capabilities (R-9.5 contracts-only, R-10.1/10.2 levels/risk gates); leader election (R-6.6, single-row lease); event ledger (ADR 0004, 16 event types in the same transaction, `GET /v1/stream` SSE with Last-Event-ID); OTel metrics catalog (R-15.4, no ids as labels, incl. `task.claim.latency` + `task.time_to_verified` via task timestamps); TUI Inspector/Alerts/Budgets views + `cancel`/`pause`/`resume` CLI parity (R-15.6).
- D6 closed, D8 partially closed in [`architecture/current-system.md`](architecture/current-system.md#verified-discrepancies).
- Last full check: `bunx vitest run --maxWorkers=2` (470 passed, 11 skipped at `95695d6`; 475 passed at `ebc9287`), `bunx tsc -p .` clean. No cluster/live-provider check was run in the review.
- Working tree: latency-metric timestamps (tasks `claimed_at`/`submitted_at`/`verified_at`) + `docs/e1-e6-close-out.md` uncommitted.
- **E1–E6 are not met.** No live run recorded. See [`docs/e1-e6-close-out.md`](docs/e1-e6-close-out.md) for per-demonstration preconditions and gaps (sweeper, revoke/pause, verifier adapter, contributor path, adversarial suite, baselines).

## Next slice (priority order)

1. **Sweeper + revoke/pause (E2/E4 gate)**: lease-expiry sweeper (R-8.4), claim revoke with fence bump (R-8.3), goal pause (R-7.3). Highest leverage: unblocks fenced recovery and oversight.
2. **Deterministic verifier adapter + retry** (R-11.4, E3 gate): code-running checks in a separate execution from an immutable snapshot; findings attached to next attempt.
3. **Contributor path + discovery** (R-8.10, E1 gate): `addContributor` with per-artifact attribution; indexed pull for tasks/goals (R-9.2).
4. **Adversarial governance suite** (R-1.4/R-12, E5 gate): five denial attacks denied + recorded; gateway tool-list gating (R-10.4).
5. **Baselines harness** (E6 gate): single-agent / manager-worker / centrally-planned on held-out goals, measured from ledger + DB (R-15.7).
6. **Live runs** (E1–E6): recorded, failures included. Only then is the spec met. See [`docs/e1-e6-close-out.md`](docs/e1-e6-close-out.md).

Also: Substrate grant narrowing (global bootstrap owner → atespace-scoped editor) and Substrate #2086 owner/re-test cadence are deployment risks with names and dates, not paragraphs — track them until they land.

## Code map to inspect

- API and identity enforcement: `src/server/http.ts`, `src/server/service.ts`, `src/server/errors.ts`, `src/server/ops.ts`.
- Persistence: `src/server/store.ts`, `src/server/pg-store.ts`, `src/server/schema.ts`.
- Execution credentials: `src/server/controller.ts`, `src/server/config.ts`, `src/server/main.ts`, `src/agent/main.ts`.
- API callers: `src/shared/client.ts`, `src/cli.ts`, `src/tui/run.ts`, `src/host/cluster.ts`, deployment manifests.
- Tests and fixtures: `test/server/http.test.ts`, `test/server/service.test.ts`, `test/server/controller.test.ts`, `test/server/service.task-claims.test.ts`, `test/server/service.budgets.test.ts`, `test/server/service.verification.test.ts`, `test/slice.test.ts`, `test/e2e.test.ts`, `test/support/cluster.ts`, `test/support/fakes.ts`.

Before changing an exported port or constructor, find every caller and update them together. Preserve useful existing APIs only where the target spec requires them; no compatibility shim for unauthenticated identity.

## Migration risk

AX tasks are immutable. Existing agent tasks have no bearer token; recreating a task deletes its `/workspace`. Do not silently delete or recreate existing tasks or claim workspace data is preserved. If a live deployment contains workspace data that would be destroyed, stop before destructive migration and surface that risk for an explicit operator decision. No such live deployment was inspected during the documentation work.

## Acceptance for the head of the queue (sweeper + revoke/pause)

Add behavior tests proving: expired leases are reclaimed with a higher fence and stale-holder submits are rejected (R-8.4/R-8.3); pause stops new claims immediately (R-7.3); revoke bumps fence and revokes. Then run `bunx vitest run --maxWorkers=2` and `bunx tsc -p .`. Do not report live AX or Substrate verification unless actually run.
