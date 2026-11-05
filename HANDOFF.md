# OpenCode handoff

## Goal

Continue implementing Folie against [`spec/requirements.md`](spec/requirements.md). It is the normative spec; [`DESIGN.md`](DESIGN.md) is the architectural overview. No implementation code has been changed yet. Do not recreate a phased roadmap; the user explicitly requested one spec that must be met.

## Current state

- The architecture/spec/ADR documents were rewritten for a general-purpose autonomous swarm. Read `DESIGN.md` first, then the requirements relevant to the code being changed.
- The repository still implements the earlier unauthenticated, message-driven runtime. Evidence and D1–D12 are in [`architecture/current-system.md`](architecture/current-system.md#verified-discrepancies).
- Existing checks last run before this implementation handoff: `bun run test` (383 passed, 11 skipped), `bun run test:tui` (11 passed), `bunx tsc -p .` (clean). No cluster/live-provider check was run in that review.
- Working tree contains the documentation changes; preserve them. `HANDOFF.md` is new. No runtime changes are present.

## First implementation slice: authenticated identity and agent registration

Start with R-1.1–R-1.5, including all affected callers and tests. This is the highest-risk gap: the current API trusts body fields `from` and `agent`, has no `Authorization` handling, and lets `send`, `subscribe`, and topic operations create arbitrary agents. `FolieClient` sends only JSON and trace headers. The controller injects `FOLIE_AGENT` but no credential. `AgentRepo` has no credential operations. `httpServer` is composed in `src/server/main.ts` and test fixtures.

Target behavior:

- Derive every principal from `Authorization: Bearer …`; never trust a caller name in a body or path. Reject mismatches with `403`.
- Give each agent execution its own opaque bearer token; persist only a hash, bind it to the agent/execution generation, and reject it after revocation or execution loss. Use a constant-time comparison for operator credentials.
- Require operator authority for operator routes, goal submission, fleet-wide reads and agent registration. Agent calls may act only as that agent and read only its authorized data.
- Add an operator registration path. Pool creation remains an internal server action. Sending, subscribing or publishing to an unknown agent must return `404`; do not implicitly create it.
- Authenticate OTLP ingestion as an agent request; keep `/healthz` public.
- Carry credentials through `FolieClient`, agent startup/controller task environment, CLI/TUI, `folie up` configuration and tests. Do not add an unauthenticated fallback.

## Code map to inspect

- API and identity enforcement: `src/server/http.ts`, `src/server/service.ts`, `src/server/errors.ts`, `src/server/ops.ts`.
- Persistence: `src/server/store.ts`, `src/server/pg-store.ts`, `src/server/schema.ts`.
- Execution credentials: `src/server/controller.ts`, `src/server/config.ts`, `src/server/main.ts`, `src/agent/main.ts`.
- API callers: `src/shared/client.ts`, `src/cli.ts`, `src/tui/run.ts`, `src/host/cluster.ts`, deployment manifests.
- Tests and fixtures: `test/server/http.test.ts`, `test/server/service.test.ts`, `test/server/config.test.ts`, `test/server/controller.test.ts`, `test/slice.test.ts`, `test/e2e.test.ts`, `test/support/cluster.ts`, `test/support/fakes.ts`.

Before changing an exported port or constructor, find every caller and update them together. Preserve useful existing APIs only where the target spec requires them; no compatibility shim for unauthenticated identity.

## Migration risk

AX tasks are immutable. Existing agent tasks have no bearer token; recreating a task deletes its `/workspace`. Do not silently delete or recreate existing tasks or claim workspace data is preserved. Implement fail-closed authentication for new executions and document the precise operator migration prerequisite. If a live deployment contains workspace data that would be destroyed, stop before destructive migration and surface that risk for an explicit operator decision. No such live deployment was inspected during the documentation work.

## Acceptance for this slice

Add behavior tests proving: unauthenticated requests fail; forged `from`/`agent` and cross-agent inbox/report/event access fail; agent tokens cannot call operator routes; operator access works; revoked/stale agent tokens fail; a valid agent can send/report/ingest its own events; unknown-agent send/subscribe/publish returns `404`; only explicit registration or internal pool dispatch creates agent rows. Then run `bun run test`, `bun run test:tui`, and `bunx tsc -p .`; exercise one authenticated HTTP flow using the test server. Do not report live AX or Substrate verification unless actually run.
