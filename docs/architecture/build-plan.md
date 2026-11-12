# Implementation program

Status: proposed program for building Folie through coherent end-to-end iterations. This plan is implementation guidance derived from the architecture reset; the evidence gates below decide whether a choice graduates into a supported promise.

## Product goal

Build Folie as a small, adaptable runtime and set of primitives for agent applications. Each iteration must leave a usable product state: a person can install or run it, complete a representative workload, inspect what happened, and recover from ordinary failures. The iterations are complete product-shaped outcomes, not independent tickets. Later iterations extend the same contracts instead of replacing the product underneath them.

Design the destination once, implement it through these working states, and keep every state usable. Do not build a large framework before the first application demonstrates which primitives need to be general.

## Program defaults

These defaults establish a direction for implementation. They are not all claims about the existing code.

| Status | Choice | Rationale / boundary |
|---|---|---|
| **Committed for this program** | First application: a long-running research assistant that accepts a question and source material, works across sessions, writes durable findings, and lets a human inspect, steer, stop, and resume it. | Exercises persistence and composition without requiring a team, task graph, or marketplace. Start with supplied sources and a small explicit retrieval toolset; grow web discovery only as an application requirement. |
| **Committed for this program** | Default local execution is a trusted process running as the operator. | It removes cluster setup from the common path. It is not a sandbox; Folie must say so plainly and must not claim filesystem, process, network, or credential containment. |
| **Committed for the first usable state** | Prefer Strands as the clean-slate harness candidate, but choose it only after the narrow TypeScript integration gate at the start of iteration 1. If it passes, use Strands for the research app; otherwise retain the current Pi adapter as the fallback. | Pi is available during evaluation, not an automatic permanent second harness. Reuse current service/client code where it fits. Do not treat either harness's defaults as Folie's universal tool policy. |
| **Committed for sequencing** | Make AX/Substrate a first-party optional profile after the local path works. Then build a second application to test composability. | Keep the same work and run contract across local and AX. Kubernetes is not a prerequisite for local use. |
| **Provisional, gated** | Use embedded PGlite for local persistence while retaining PostgreSQL semantics. | The current store is PostgreSQL-specific and the test suite already exercises it through PGlite. Its single-connection model may fit one local Folie server, but packaging, persistence/recovery, required SQL features, write contention, and resource use must pass the local-store gate before this becomes the default. If it fails, keep the existing PostgreSQL store and choose a low-friction local distribution; do not add SQLite merely to avoid a service. |
| **Provisional, evidence-led** | Evaluate the current Strands TypeScript SDK against the existing Pi adapter before selecting the first harness. | Start with the smallest adapter spike needed to verify required integration behavior and compare Folie-specific code. Do not assume Python or harness features exist in the TypeScript SDK, and do not add both as permanent supported dependencies without evidence. |
| **Provisional** | Use the existing TypeScript client/API as the first composition path; refine it into a small app-facing library only where the first application exposes friction. | Avoid launching a DSL, multiple SDKs, and a generic plugin system together. |

PGlite feasibility is an explicit gate, not an assumed fact. Folie's test fixture already constructs PGlite, runs `migrate`, and passes it through the production `pgStore` (`test/support/db.ts`). Upstream documents filesystem persistence in Node and Bun, and lists PGlite as single-user/single-connection; these facts make it a plausible one-server local store but do not prove Folie's production requirements are met. [PGlite overview and limitations](https://github.com/electric-sql/pglite#readme), [filesystem support](https://pglite.dev/docs/filesystems). It still needs a production-shaped persistence and concurrency evaluation. PostgreSQL remains the shared-deployment option if the workload needs multiple database clients or higher concurrent write throughput.

## Iterations

### 1. Local research product

**Outcome:** A user can configure Folie on one machine, submit a research question with source material, let one agent work across multiple sessions, and retrieve a durable report and cited artifacts. The user can inspect status and history, send a correction, cancel, resume, or retry. The default does not require kind, Kubernetes, AX, Substrate, or a separately operated broker.

**Local limits to disclose:** Execution runs as the operator with host filesystem and network access; CPU and memory limits are not enforced. Process ownership is in memory, so an abrupt server crash can leave an orphaned worker that a restarted server cannot reattach to. Process suspension is unavailable on Windows. These are explicit first-iteration trade-offs, not sandbox claims; later work must improve or retain them with clear evidence and user-facing disclosure.

**Harness selection gate (before committing to the app adapter):** Build a narrow Strands TypeScript spike around the research run. Confirm the selected package can provide the required model call, typed research tools, streaming/events Folie needs, cancellation and failure propagation, and can run inside the chosen local execution process. Verify that durable work and authorization remain Folie-owned. Compare the Folie-specific adapter code with the existing Pi adapter. Select Strands for iteration 1 if all required behaviors work and its adapter needs less Folie-specific code; otherwise use the existing Pi adapter and record the specific failed requirement. The spike is a pass/fail integration gate, not a full benchmark or a commitment to support both harnesses.

**Gate result (2026-11-12):** `@strands-agents/sdk@1.24.0` passed a narrow isolated TypeScript spike under Node 26 and Bun 1.4. It compiled and demonstrated a typed Zod tool, async stream lifecycle/tool events, inbox-style correction through an `afterModelCall` intervention, and `AbortSignal` cancellation returning `stopReason: "cancelled"`. The test used a fake model and mailbox; it did not exercise live OpenRouter or Folie's HTTP client. The adapter direction is therefore Strands, with Folie retaining message/session persistence and tool authorization. Keep the production adapter minimal and compare its Folie-specific code with the existing Pi adapter before removing Pi. The SDK's OpenAI provider requires a compatible `openai` peer, tool cancellation is cooperative, and Strands uses Zod while existing Folie schemas use TypeBox. Those are real maintenance costs. The isolated spike remains available at `/tmp/folie-strands-spike` in the development environment; this repository does not include its test harness.

**Implementation shape:** Reuse the current authenticated HTTP service, work-item flow, session loop, report/output handling, and CLI/TUI surfaces where practical, along with the harness selected by the gate. Add only the local process launcher and research-specific typed tools needed for the application. Keep the model loop in the harness and work authority in Folie. Use a single embedded PGlite instance with file-backed persistence only if the gate below passes; otherwise ship a managed local PostgreSQL path for this iteration and retain the PGlite investigation as open.

**Acceptance evidence (status 2026-11-12):**

- **Automated suite:** `./node_modules/.bin/vitest run` — **506 passed, 11 skipped**; `./node_modules/.bin/tsc -p . --noEmit` passes. Skips include Bun-only TUI harness tests.
- **Strands harness (partial):** `@strands-agents/sdk@1.24.0` adapter in-tree; `test/agent/strands-runtime.test.ts` covers report/workspace/artifact tools, inbox steering, replay flags, pre-run cancellation. `test/e2e.test.ts` remains Pi/Echo over HTTP cluster—not Strands. No live OpenRouter smoke.
- **Sessions and reports (partial):** Persisted sessions lease at start; settlement stores the **full consumed `message_ids`** (including mid-session steer) in `sessions` so operator views match acks (`test/e2e.test.ts` steering case; `test/server/service.persisted-session.test.ts`).
- **Artifact retrieval (HTTP/CLI/TUI):** `GET /v1/artifacts?ref=…`, `folie artifact`, TUI `[d]` / `artifact` command; covered in `test/server/http.test.ts` and TUI unit tests.
- **PGlite gate (partial):** `test/server/pglite-persistence.test.ts` — file-backed migrate, writes, close, reopen, remigrate, rows preserved. Still open: concurrent/transaction stress, crash recovery, footprint/latency recording, clean packaging from install, PostgreSQL export/import.
- **Local lifecycle (partial):** `test/local-lifecycle.test.ts` + `test/support/local-stack.ts` — temp `FOLIE_HOME`, file-backed PGlite, local provider, echo agents; completed work item and report survive server stop/restart. Still open: `folie config init` → `up`/`down` CLI path, full inspect transcript/history after restart, Strands on local stack, steer-under-load.
- **Still open — trust UI / cancel invariants / model smoke:** Local trust limits disclosed at startup; cancel/stale-settlement invariants have deterministic unit/e2e coverage but not the full operator CLI journey or live model verification.

**PGlite local-store gate:**

- Required migrations, SQL operations, transactions, timestamps, conflict handling, and locking behavior work in file-backed mode.
- The database closes cleanly and reopens with work, output metadata, and history intact; interruption and recovery behavior is documented.
- Representative single-user concurrent runs have acceptable latency and no lost writes; memory, disk footprint, startup time, and shutdown time are recorded.
- Supported Bun/Node packaging works from a clean install and does not require a compiler, Docker, or network database service.
- A logical export/import path to PostgreSQL exists before local data is described as portable.

If any of these fail materially, keep PostgreSQL as the first supported store and revisit packaging rather than silently introducing a second SQL dialect.

### 2. Reusable application primitives

**Outcome:** The research application remains usable, and a developer can build a small variant by composing Folie's public work/run APIs, harness choice, typed tools, and output handling without editing the server or importing its database schema.

**Implementation shape:** Stabilize only the interface already exercised by the first application. Keep one operator CLI/TUI and one app-facing TypeScript API. Separate the harness's session mechanics from Folie's durable state. Keep events/history compact and useful to an application developer. Add custom in-process tools as trusted application code; do not create a package marketplace or a remote plugin lifecycle.

**Acceptance evidence:**

- A small example app submits work, selects tools, observes lifecycle/output, and handles cancellation using public contracts only.
- The same service and store contract remains the authority for identity, work transitions, ownership, and settlement.
- Restart recovery, duplicate submission, worker loss, and stale settlement behavior have deterministic tests.
- The application author does not need to know internal database tables, leader loops, or Kubernetes.

### 3. Harness evaluation and decision record

**Outcome:** The research application continues to work, and Folie records whether the iteration 1 harness remains the only supported choice or whether evidence justifies a change. The iteration 1 gate already chooses Strands when it meets requirements with lower Folie-specific code; this stage supplies broader workload evidence before making any longer-term compatibility promise.

**Implementation shape:** If the iteration 1 gate selected Pi, compare it with the short-lived Strands spike against the same model, research tasks, tool permissions, execution environment, and Folie-facing contract. If the gate selected Strands, validate the chosen integration on the same workload and compare against Pi only where needed to test the decision. Pin exact package versions. Evaluate one non-coding research workload and one repository-editing workload. Include cancellation and worker termination. Do not keep the fallback as a permanent second dependency unless an application requires it.

**Acceptance evidence:** Record completion/correctness, tool failures, cancellation behavior, latency, token/cost where available, restart/lost-worker behavior, adapter-specific code, dependency/packaging cost, and review findings. Decide to keep Pi, replace it with Strands, or support a second harness only if the measured workload justifies the ongoing compatibility burden. No harness is entitled to own Folie's durable work or identity.

### 4. Optional AX/Substrate profile

**Outcome:** The research product can run through AX/Substrate when explicitly selected, while the local path still starts without cluster infrastructure.

**Implementation shape:** Put provider provisioning behind the existing execution-provider seam where it fits; narrow it if the local/AX comparison proves it too broad. Add explicit profile setup and validation. Do not claim equivalent trust boundaries: local execution is trusted; AX is intended to isolate work but every capability is version- and configuration-dependent.

**Acceptance evidence:** Run the same application and API contract through AX. Record supported versions and validate resource limits, workspace durability, cancellation, egress, process loss/recovery, cleanup, and operator-visible failures against a live cluster. A fake provider test is useful for logic but does not establish these guarantees.

### 5. Second application: coding workflow

**Outcome:** A developer can build and run a repository-editing application through Folie's public composition path, using the selected harness and either the local trusted process or optional AX profile.

**Implementation shape:** Supply a coding recipe and a deliberate toolset for read/search/edit/test operations. Keep repository tools out of the research app's defaults. State the local trust boundary before enabling shell or repository writes. Use the harness evaluation evidence from iteration 3; do not maintain both Pi and Strands merely to preserve choice.

**Acceptance evidence:** Complete a fixed repository task set with correctness checks, report tool errors and reviewer findings, and demonstrate that the same Folie work/run APIs apply. Compare the recipe with the research app to identify genuinely shared primitives; remove abstractions that exist only to make the two examples look uniform.

## Completion bar for the program

Folie is ready to be called a useful, adaptable foundation when a developer can:

1. Start a local instance without a cluster and understand its trust boundary.
2. Build and use the research application across sessions with durable outputs and inspectable history.
3. Compose a small application through a documented public API without depending on internal schemas.
4. Select AX explicitly and understand its verified limits.
5. Build a second, materially different application without importing its domain-specific policy into the kernel.

Scale claims, generalized teams, negotiation, reputation, broad policy languages, memory graphs, external plugin catalogs, and multiple SQL dialects are outside this completion bar. Add them only after a workload and evidence justify their complexity.

## Migration and delivery rules

- Map current modules and behaviors to the agreed contracts before replacing them. `src/server/pg-store.ts`, `src/server/service.ts`, `src/shared/client.ts`, `src/agent/loop.ts`, and `src/agent/runtimes/pi.ts` are existing assets to evaluate, not rewrite targets by name.
- Keep the existing Postgres semantics where possible. If PGlite is adopted, it is a local engine behind the existing database port, not a new SQL dialect. Keep an explicit logical backup/restore path to PostgreSQL.
- Treat current `spec/`, ADRs, E1–E6 documents, and the previous target architecture as migration material. Do not recreate their backlog as the delivery plan.
- Each iteration ends with a usable application state, updated operator/developer docs, deterministic verification, and a short record of remaining risks. Start the next iteration only after the current state is reproducible.
- No rewrite is justified solely by terminology changes. Replace behavior when it blocks a chosen product outcome, violates a tested invariant, or costs more to preserve than to remove.
