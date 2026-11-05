# Handoff

## Goal

Continue implementing Folie against [`spec/requirements.md`](spec/requirements.md). It is the normative spec; [`DESIGN.md`](DESIGN.md) is the architectural overview. Do not recreate a phased roadmap; the user explicitly requested one spec that must be met. (The implementation code has since changed — trust the "Current state" section below, not any earlier version of this file.)

## Current state (as of 2026-11-06, commits a75a641 / 961f577)

- The architecture/spec/ADR documents were rewritten for a general-purpose autonomous swarm. Read `DESIGN.md` first, then the requirements relevant to the code being changed.
- **Implemented and verified**: authenticated identity (R-1.1–R-1.5, per-execution hash-stored tokens, operator routes, 404s); persisted sessions (R-3.2, server-owned `running` rows, message leases, terminal settle); ExecutionRegistry (durable workspace binding, epoch, ghost → `lost`); task claims (single conditional claim, fence-checked start/submit, one active owner); budgets (headroom-guarded carve-outs, usage records, exhaustion, close returns unspent; R-12 E0); verification contracts (independent verdicts, producer ≠ verifier, `not_achieved` gate). D6 closed, D8 partially closed in [`architecture/current-system.md`](architecture/current-system.md#verified-discrepancies).
- Last full check: `bunx vitest run --maxWorkers=2` (406 passed, 11 skipped), `bunx tsc -p .` clean. No cluster/live-provider check was run in the review.
- Working tree is clean at `a75a641` (pushed). No runtime changes are pending.

## Next slice (priority order)

1. **Cheap enforcement (days, per peer letter 2)**: default `ResourcesSpec` (R-6.11), `spec.debug: false` test (R-6.7). Close the "unlimited agent" and backdoor holes.
2. **Cancellation** (R-2.4/R-2.5): cooperative-then-forced cancel through `ExecutionProvider` → agent shim → `Agent.abort()`. The kill switch is the teeth.
3. **Interaction layer** (TUI Inspector + Trace first, then Approvals/Alerts, Budgets): session theatre, episode chain, attention queue. Pure view-models; no business logic in the renderer.
4. **Gateway** (ADR 0007): E2 before any money/shared-credential goal; model key out of the sandbox.
5. **Artifact store + memory service** (ADR 0008, R-4.x): content-addressed bytes outside the workspace; scoped memory with provenance; makes retirement survivable (R-3.7).
6. **Coordination, capabilities, governance** (R-9, R-10, R-12): teams, offers, capacity, stalls; `declared|assessed|verified`; R0–R7 with approvals.
7. **Live runs** (E1–E6): recorded, failures included. Only then is the spec met.

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

## Acceptance for the head of the queue (cheap enforcement)

Add behavior tests proving: every manifest/adapter defaults `spec.debug: false` (fail if true); default `ResourcesSpec` is set per agent and unlimited is impossible. Then run `bunx vitest run --maxWorkers=2` and `bunx tsc -p .`. Do not report live AX or Substrate verification unless actually run.
