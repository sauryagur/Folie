# Handoff

## Active goal

Build Folie as a small, adaptable agent runtime through coherent end-to-end iterations. The first target is a usable local-first research application; later work should add reusable composition primitives, optional AX/Substrate execution, and a second application only when the first path is reproducible. Complexity must earn its maintenance cost.

The working plan and its evidence gates are in [`docs/architecture/build-plan.md`](docs/architecture/build-plan.md). Follow the root [`AGENTS.md`](AGENTS.md), especially its instruction to preserve code that fits and to treat the old specs/ADRs/E1–E6 queue as historical. Read [`DESIGN.md`](DESIGN.md) and [`docs/architecture/README.md`](docs/architecture/README.md) for the current proposal. The proposal is not proof that a behavior is implemented.

## Current checkout

- Branch: `build/local-runtime`.
- Worktree may be dirty after handoff edits. Do not reset or discard unrelated changes. Latest implementation commit on this branch: local profile / PGlite / Strands (`git log -1 --oneline`).
- The previous active goal was explicitly paused by the user. The latest instruction was to prioritize this handoff document; continue project implementation only when the user resumes/requests it.
- Latest verification in this worktree: full `vitest run` (506 passed, 11 skipped), `tsc --noEmit`, and the focused checks listed below.

## Implemented in the current worktree

### Local profile and setup

- New config defaults to `execution_profile: local`; version-1 config loads as AX to preserve existing behavior. Config init no longer requires a running server and only asks for Kubernetes/image values for AX.
- `folie up` / `folie down` dispatch by profile. Local mode starts the server with file-backed PGlite, logs, and workspaces under `FOLIE_HOME/local`, waits for `/healthz`, and records a PID/process identity. Stop checks identity before signaling and preserves database/workspaces. Local CLI requests use loopback; local server binds `127.0.0.1`.
- AX setup remains selectable, and legacy v1 configs retain AX. No live AX/Substrate deployment was checked.
- Local trust limits are shown on startup: workers run as the operator with host filesystem/network access, no enforced CPU/memory limits, in-memory process tracking, possible orphaning on abrupt server crash, and no suspension on Windows. This is trusted execution, not a sandbox.

### Persistence, sessions, artifacts, and execution

- Added a PGlite adapter behind the existing PostgreSQL-shaped `Database` port and promoted PGlite to runtime dependency. It uses a persistent directory with restrictive permissions. The adapter documents one owner process per directory.
- The agent loop now asks the server to create/lease a persisted session before running, keys transcript events and reports to that server session, and submits the report with the session ID. Report settlement is retry-idempotent for an identical settled-session payload. On settle, `sessions.message_ids` is updated to the full consumed set (mid-session steer mail included), so `workItem`/`report` views match what was acked (`src/server/service.ts`, `src/server/pg-store.ts`).
- Added authenticated bounded artifact upload. Producer identity is derived from the bearer principal; uploads go to the existing content-addressed artifact table. The Pi artifact tool uploads bytes and emits the stored ref/hash.
- Added a local `ExecutionProvider` implementation and profile selection in server startup. The local provider runs trusted child processes in persistent per-agent workspaces and supports POSIX suspend/resume, but execution registry/process ownership remains in memory and workers cannot be reattached after server restart.

### Strands research runtime

- The narrow isolated Strands TypeScript SDK spike passed under Node 26 and Bun 1.4 with a fake model: typed tools, stream events, async `afterModelCall` inbox correction, and `AbortSignal` cancellation. Its source is in `/tmp/folie-strands-spike` in this development environment; it is not checked into the repository.
- Based on that gate, `@strands-agents/sdk@1.24.0`, Zod, and a compatible OpenAI SDK peer were added. New configs default to `strands`; Pi and Echo remain selectable. The factory currently configures Strands for OpenRouter Chat Completions.
- [`src/agent/runtimes/strands.ts`](src/agent/runtimes/strands.ts) adds a transient Strands agent with workspace read, artifact write/upload, and report-submit tools; sequential tool execution; Folie inbox steering; Folie transcript/tool events; and cancellation wiring. It leaves session/memory persistence and authorization with Folie. Provider-neutral Strands usage records token/tool counts and omits unknown dollar cost.
- The Strands spike did **not** run against live OpenRouter or Folie's actual HTTP client. The production adapter has focused unit tests (`test/agent/strands-runtime.test.ts`) but no Strands HTTP e2e in `test/e2e.test.ts` (Pi/Echo only).

## Verification completed

- `./node_modules/.bin/tsc -p . --noEmit` passes on the current tree.
- Full suite: `./node_modules/.bin/vitest run` — **506 passed, 11 skipped** (49 files; Bun-only TUI app tests among the skips).
- `git diff --check` passed (when last run).
- Persisted-session settlement: mid-session consumed message ids appear on reports after settle (regression covered in `test/e2e.test.ts` steering case).
- File-backed PGlite gate (partial): `test/server/pglite-persistence.test.ts` — migrate, parallel inserts, close, reopen, remigrate, rows intact.
- Deterministic local lifecycle (partial): `test/local-lifecycle.test.ts` with `test/support/local-stack.ts` — temp `FOLIE_HOME`, file-backed PGlite, in-process HTTP + echo agents; work item/report survive server stop and restart. CLI path: `test/cli/local-up-down.test.ts` — real `folie up` / `submit --wait` / `down` / `up` with temp `FOLIE_HOME` + `XDG_CONFIG_HOME` and echo runtime. Does **not** exercise `folie config init` or Strands on the CLI stack.
- Focused Strands adapter tests (`test/agent/strands-runtime.test.ts`): report_submit mapping, workspace/artifact tools, inbox steering, tool replay flags, and pre-run cancellation.
- Authenticated artifact retrieval: HTTP/CLI (`test/server/http.test.ts`) and TUI inspector fetch (`[d]` / `artifact` command).
- **Not run / still open:** concurrency/load PGlite stress, crash-kill recovery, clean-install packaging from empty `node_modules`, PostgreSQL logical export/import, OpenRouter live smoke, steer-while-running Strands on local stack.

## Highest-priority next work

Continue the **same first product iteration**; do not begin the optional AX profile or coding application yet.

1. ~~Inspect the full diff and fix integration issues; add focused Strands/session tests~~ **largely done:** full vitest green; Strands adapter + persisted-session + loop/e2e steering coverage; settle persists full `message_ids`. Remaining: occasional re-run after large diffs; Strands HTTP e2e still absent.
2. Verify a clean local setup flow (`config init` → `up` → submit → inspect → `down`) on a clean temporary home. **partial:** `test/local-lifecycle.test.ts` + `test/cli/local-up-down.test.ts` prove restart persistence via in-process stack and real CLI up/down; still need `config init` wizard path, transcript/history inspection assertions, steer-while-running Strands, and optional OpenRouter smoke (credentials only).
3. ~~Artifact retrieval surface~~ **done:** `GET /v1/artifacts?ref=…` + `folie artifact` + TUI inspector (`[d]` / `artifact` command via `fetchArtifact`).
4. Finish the PGlite gate before calling it a supported default. **partial:** `test/server/pglite-persistence.test.ts` covers file-backed close/reopen + remigrate; still open: production-shaped transactions/concurrency under load, abrupt crash recovery, resource metrics, clean Bun/Node packaging, logical PostgreSQL export/import. Until closed, describe PGlite as provisional for local mode.
5. Update the architecture/build-plan evidence status and this handoff when these checks change. Keep AX/Substrate explicitly optional and unverified until run against a live deployment.

## Important limitations and open edges

- A lost response to session creation is idempotent only when the same `clientRequestId` is retried; the loop currently does not persist/reuse that request ID if the process exits between server commit and receiving the response. Leased messages may then need recovery work.
- A local server crash can leave workers running without an owner; server restart does not reattach them. `down` only stops workers tracked by the current server process during orderly shutdown.
- Artifact bytes are retrievable via authenticated `GET /v1/artifacts?ref=…`, `folie artifact`, and the TUI inspector (`[d]` or `artifact <ref>`).
- PGlite is single-owner local persistence. Do not share a data directory between server processes or present it as multi-host/high-availability storage.
- Strands tools use Zod while existing Pi tools use TypeBox. Do not create a generic schema framework until app composition demonstrates that need. Tool cancellation is cooperative.
- The Strands adapter currently supports research-oriented workspace/artifact/report tools; it is not the repository-editing application. Pi remains in the dependency tree and is still selectable; reassess the cost of keeping it after the first app is validated.
- No claim of AX/Substrate isolation, local resource enforcement, benchmark performance, or live model behavior is established by the checks above.

## Historical material

`spec/`, `decisions/`, and most pages under `architecture/` describe the previous target. Their old normative requirements, ADRs, E1–E6 gates, and implementation queue are not active coding instructions unless explicitly requested. [`architecture/current-system.md`](architecture/current-system.md) is a dated as-built snapshot; inspect current code before relying on it. `docs/research/folie-architecture-reset-draft.md` is superseded by `docs/architecture/`.
