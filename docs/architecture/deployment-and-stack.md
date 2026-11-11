# Deployment profiles and stack choices

Status: proposed with the architecture reset, 2026-11-12.

## Profiles

### `local` — default candidate

One operator, one machine, one Folie server, one store, and a local worker executor. Starting Folie must not require kind, Kubernetes, AX, Substrate, PostgreSQL as a separately operated service, or a message broker.

The default's trust boundary must be explicit. A local process running as the user is trusted local execution, not a sandbox. If the product wants a safer local default, it must provide real OS/container isolation rather than implying that configuration or tool grants contain a process.

### `ax` — first-class optional execution profile

AX/Substrate and kind remain intended first-party options for users who need isolated execution and network controls. Folie should make configuration and setup straightforward (`folie configure execution ax`, `folie up --profile ax`) and expose version compatibility and limitations before work starts. Treat the actual isolation, resource, cancellation, and egress guarantees as unverified until exercised against supported versions.

Do not make AX a side path: run the same work contract through local and AX profiles. At the same time, the default install must not set up Kubernetes for users who do not choose it.

## Stack disposition

| Component | Proposal | Reason / evidence required |
|---|---|---|
| TypeScript | Keep provisionally for the Folie control API and first SDK. | Current codebase and Pi/Strands TS options make it practical. Reconsider only if the chosen application needs a different host language. |
| Bun | Keep only where needed for current CLI/TUI or build. Do not make it a kernel constraint. | Separate server/worker runtime requirements from developer UX. Revisit if local distribution remains difficult. |
| PostgreSQL | Do not mandate universally yet. Choose one store for the first implementation after naming its deployment target. | Current store is heavily PG-specific. SQLite could simplify a local profile, but one-writer contention must be benchmarked on event-heavy workloads. Supporting both adds a second implementation and conformance cost. |
| SQLite | Candidate local store, not a committed decision. | Works behind a single application server and is light to operate; it serializes writes. [SQLite guidance](https://www.sqlite.org/whentouse.html), [WAL behavior](https://www.sqlite.org/wal.html). |
| AX/Substrate | Keep as first-party optional execution backend. | It is intended to provide a meaningful isolation/execution boundary. Verify resource limits, cancellation, workspace behavior, network controls, and recovery live before promising them. |
| kind/Kubernetes | Optional deployment mechanism for AX and advanced environments; not local prerequisite. | The current `folie up` path provisions the full cluster. Make cluster dependencies opt-in. |
| Pi | Keep as a harness comparison/possible coding harness, not the definition of a Folie agent. | Existing integration is convenient; the coding-agent package biases defaults toward repository work. |
| Strands | Preferred clean-slate harness candidate, contingent on the adapter evaluation. | Reuses more agent-loop, tool, lifecycle, hook, and plugin primitives. Avoid duplicating its session/memory/multi-agent features. |
| OpenTelemetry | Keep as optional diagnostics. | Useful across worker boundaries, but never authoritative state. Do not make collector setup mandatory locally. |
| OpenTUI | Keep as an optional thin operator client if users validate its value. | Not a core runtime dependency. A CLI/API path must remain usable without its native renderer. |
| Object storage/vector database/message broker | Defer. | Begin with durable local files, basic context retrieval, and database-backed work. Add each only when a demonstrated workload needs it. |

The SQLite rationale is not that SQLite is categorically faster. It is that removing a separately operated database service may be valuable for one-machine use. The choice turns on write concurrency, physical placement, recovery, and deployment—not conventional preference. SQLite itself recommends client/server databases for high concurrent writes and network-separated database files, while describing application-server/local-file usage as a valid pattern. [SQLite selection guidance](https://www.sqlite.org/whentouse.html).

## Operating constraints

- One application server is the logical authority initially. Do not add a separate queue or microservices without measured pressure.
- Workers never connect directly to Folie's database.
- A profile declares which capabilities it actually provides: isolation, persistence, resource limits, network access, and cancellation.
- A local profile must not imply AX-equivalent containment. External account credentials and write tools must have explicit configuration and authority.
- Configuration should describe chosen components, not enumerate every future extension point. `folie init` should create a valid local setup; advanced profile setup should guide cluster, image, model, and trust requirements.

## Current implementation facts to re-check during rewrite

- `src/server/main.ts` hardwires Postgres, AX gRPC, Substrate egress, telemetry, leader election, and HTTP.
- `src/server/pg-store.ts` depends on PostgreSQL-specific SQL and schema features; SQLite requires deliberate porting.
- `src/server/provider.ts` is an execution-provider seam with AX as the only production adapter. Narrow it to demonstrated responsibilities while retaining the local/AX distinction.
- `src/host/cluster.ts` provisions the full kind/AX/Postgres/Folie environment and should move behind the optional AX profile.
- `src/agent/runtimes/pi.ts` imports coding tools. A general-purpose default should assemble tools per application instead.
- Current code has authentication. Older as-built notes are snapshots; verify code before carrying forward status claims.
