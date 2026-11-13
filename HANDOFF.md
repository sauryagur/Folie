# Handoff

## Active goal

Build Folie as a small, adaptable agent runtime through coherent end-to-end iterations. The first target is a usable **local-first research application** (iteration 1 in [`docs/architecture/build-plan.md`](docs/architecture/build-plan.md)): configure on one machine, submit research work, persist sessions and outputs across restarts, inspect history, steer, cancel, and retrieve artifacts—without Kubernetes, AX, or a separate database service. Later iterations add reusable composition primitives, optional AX/Substrate, and a second application only when this path is reproducible. Complexity must earn its maintenance cost.

Authoritative process docs: root [`AGENTS.md`](AGENTS.md), proposal [`DESIGN.md`](DESIGN.md), navigation [`docs/architecture/README.md`](docs/architecture/README.md). Treat `spec/`, `decisions/`, and the old E1–E6 queue as historical unless explicitly requested.

## Current checkout

- **Branch:** `build/local-runtime`
- **Worktree:** inspect `git status -sb` before editing and preserve existing changes. `folie/config.yaml` is local configuration; do not stage or share it.
- **Recent commits (newest first):**
  - `e846f6a` — test: local Strands steer and cli config typo
  - `a9cb98d` — test(cli): local folie up/down persistence gate
  - `3f916fd` — feat(local): default profile, PGlite, Strands, and artifact fetch
- **Major change themes (not a file list):** default `local` execution profile and `folie up`/`down` dispatch; file-backed PGlite behind the existing PostgreSQL-shaped store; persisted agent sessions and idempotent report settlement; authenticated artifact upload/fetch; `ExecutionProvider` local child-process launcher; Strands harness adapter (`@strands-agents/sdk`); CLI/TUI artifact inspection; expanded vitest coverage for local stack, PGlite persistence, and Strands adapter.

## Implemented in the current worktree

### Local profile and setup

- New config defaults to `execution_profile: local` and `runtime: strands` (Pi and Echo remain selectable; version-1 config still loads as AX for backward compatibility). Config init no longer requires a running server; Kubernetes/image prompts apply only to AX.
- `folie up` / `folie down` dispatch by profile. Local mode starts the server with file-backed PGlite, logs, and workspaces under `FOLIE_HOME/local`, waits for `/healthz`, and records process identity. Stop checks identity before signaling. Local CLI uses loopback; the local server binds `127.0.0.1`.
- Local trust limits are disclosed at startup (operator UID, host FS/network, no enforced CPU/memory limits, in-memory process registry, possible orphan workers on abrupt crash, no suspension on Windows).
- Key paths: [`src/config/index.ts`](src/config/index.ts), [`src/cli/config.ts`](src/cli/config.ts), [`src/cli.ts`](src/cli.ts), [`src/host/local.ts`](src/host/local.ts), [`src/server/config.ts`](src/server/config.ts), [`src/server/main.ts`](src/server/main.ts).

### Persistence, sessions, artifacts, and execution

- PGlite adapter implements the existing `Database` port ([`src/server/pglite-db.ts`](src/server/pglite-db.ts)); one owner process per data directory.
- Agent loop creates/leases a persisted server session before running; transcript and reports key to that session; settlement is retry-idempotent for identical settled payloads; `sessions.message_ids` reflects the full consumed set including mid-session steer mail ([`src/agent/loop.ts`](src/agent/loop.ts), [`src/server/service.ts`](src/server/service.ts), [`src/server/pg-store.ts`](src/server/pg-store.ts)).
- Bounded authenticated artifact upload; producer identity from bearer principal; content-addressed storage; Pi/Strands artifact tools upload and emit refs.
- Local `ExecutionProvider` runs trusted children in per-agent workspaces with POSIX suspend/resume where available ([`src/server/local-provider.ts`](src/server/local-provider.ts)); registry is in-memory only—no reattach after server restart.
- Artifact retrieval: `GET /v1/artifacts?ref=…`, `folie artifact`, TUI `[d]` / `artifact` ([`src/server/http.ts`](src/server/http.ts), TUI model).

### Strands research runtime

- In-repo adapter: [`src/agent/runtimes/strands.ts`](src/agent/runtimes/strands.ts) — workspace read, artifact write/upload, report submit; inbox steering via Folie; transcript/tool events; cancellation wiring. OpenRouter Chat Completions path in the factory ([`src/agent/runtimes/index.ts`](src/agent/runtimes/index.ts)).
- Narrow isolated spike (fake model) passed under Node/Bun before adoption; spike tree lives outside the repo (`/tmp/folie-strands-spike` in the dev environment where it was run).
- `test/e2e.test.ts` still exercises Pi/Echo over the cluster-shaped HTTP path, not live Strands/OpenRouter.

## Verification completed

Run before claiming “done” on this branch:

- `./node_modules/.bin/tsc -p . --noEmit` — **passes** (verified 2026-11-13).
- `./node_modules/.bin/vitest run` — **509 passed, 11 skipped** (52 files passed, 1 skipped; verified 2026-11-13). The steering test now synchronizes on the completed `workspace_read` event before sending mail, avoiding a startup-delay race.

**Backed by existing tests:**

| Area | Tests |
|------|--------|
| Typecheck | `tsc --noEmit` |
| Strands adapter (unit) | `test/agent/strands-runtime.test.ts` |
| Persisted session / settle message ids | `test/e2e.test.ts` (steering), `test/server/service.persisted-session.test.ts` |
| PGlite file-backed gate (partial) | `test/server/pglite-persistence.test.ts` |
| Local lifecycle (in-process stack) | `test/local-lifecycle.test.ts`, `test/support/local-stack.ts` |
| CLI `up`/`down` + echo persistence | `test/cli/local-up-down.test.ts` |
| CLI Strands operator journey | `test/cli/local-strands-journey.test.ts` |
| HTTP artifacts + auth | `test/server/http.test.ts` |
| Local Strands steer (HTTP + fake model) | `test/local-strands-steer.test.ts` |

**Not run / still open:** PGlite concurrency/crash stress, clean-install packaging from empty `node_modules`, PostgreSQL logical export/import, live OpenRouter smoke, full operator path `folie config init` → inspect transcript/history after restart, Strands on real CLI stack with live model.

## Highest-priority next work

Stay on **iteration 1**; do not start AX profile work or the coding application until build-plan acceptance gaps close.

1. **partial — local operator journey:** `folie config init --defaults` + Strands (`FOLIE_FAKE_TURNS` via `agent_env`) are covered in `test/cli/local-strands-journey.test.ts` (`folie status`, transcript across restart). Still open: interactive wizard in automation and live OpenRouter on the CLI stack.
2. **partial — PGlite gate:** Close production-shaped concurrency, crash recovery, footprint metrics, clean Bun/Node install, and export/import to PostgreSQL per build-plan; until then, PGlite remains **provisional** for local mode.
3. **partial — iteration 1 evidence sync:** Update [`docs/architecture/build-plan.md`](docs/architecture/build-plan.md) acceptance bullets and this handoff when counts or gates change.
4. **open — model smoke:** Optional live OpenRouter run (credentials only); never required for CI.

## How to work here

1. Read [`AGENTS.md`](AGENTS.md) and skim [`DESIGN.md`](DESIGN.md) + build-plan iteration 1 acceptance.
2. **Do not** `git reset --hard` or discard unrelated work; preserve the user's tree.
3. **Do not** treat `spec/`, ADRs, or E1–E6 docs as active implementation queues.
4. Reuse existing patterns (pg store port, HTTP client, harness factory); smallest diff that closes a gap.
5. Before claiming a behavior is done: `./node_modules/.bin/vitest run` and `./node_modules/.bin/tsc -p . --noEmit`; update this file if evidence changes.

## Handoff checklist for incoming agent (first hour)

1. Read `AGENTS.md`, `DESIGN.md` (principles only), `docs/architecture/build-plan.md` iteration 1 + acceptance section.
2. `git status -sb` && `git log -5 --oneline` — confirm branch and cleanliness.
3. `./node_modules/.bin/tsc -p . --noEmit` then `./node_modules/.bin/vitest run` — note pass/skip/fail; if steering regresses, run `vitest run test/local-strands-steer.test.ts` first.
4. `git show --stat 3f916fd` (and follow-ups) — understand scope without reading every hunk.
5. Pick **one** item from [Highest-priority next work](#highest-priority-next-work); prefer fixing the steer test or closing a single build-plan acceptance gap.
6. After changes, re-run vitest + tsc; update build-plan/handoff evidence lines if gates move.
7. Do not enable AX/Substrate or Pi removal without explicit user direction and evidence.

## Important limitations and open edges

- Session creation idempotency depends on retrying the same `clientRequestId`; the loop does not persist/reuse that ID if the agent exits between server commit and receiving the response.
- Local server crash can orphan workers; restart does not reattach; orderly `down` only stops processes tracked by the current server.
- PGlite is single-owner local storage—not multi-host HA; do not share a data directory across processes.
- Strands tools use Zod; Pi tools use TypeBox—no generic schema layer until composition proves need. Tool cancellation is cooperative.
- Strands adapter is research-oriented (workspace/artifact/report), not repo-editing; Pi remains selectable.
- No established claim for AX/Substrate isolation, enforced local resource limits, benchmark performance, or live model behavior from current automated checks.

## Historical material

`spec/`, `decisions/`, and most pages under `architecture/` describe the previous target. Their old normative requirements, ADRs, E1–E6 gates, and implementation queue are not active coding instructions unless explicitly requested. [`architecture/current-system.md`](architecture/current-system.md) is a dated as-built snapshot; inspect current code before relying on it. `docs/research/folie-architecture-reset-draft.md` is superseded by `docs/architecture/`.
