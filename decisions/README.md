# Decisions

Status of everything here: **proposed 2026-11-04** with the swarm evolution of [`../DESIGN.md`](../DESIGN.md), for review. Existing decisions (1–19, recorded in [`../architecture/current-system.md`](../architecture/current-system.md#decisions-at-a-glance)) are carried forward or revised in the first table.

Format of an ADR: context, options considered, decision, consequences. One file per decision that is expensive to reverse; smaller choices live in the specification with their rationale.

## ADRs

| # | Decision | Supersedes / revises |
| --- | --- | --- |
| [0001](0001-hybrid-discovery-runtime-claims.md) | Hybrid task discovery; runtime-authoritative claims with fencing; one owner plus participants; negotiation as TTL'd messages | revises Decision 19 (assignment stays push; agents do not pull) |
| [0002](0002-agents-request-capacity.md) | Agents request capacity; only the runtime registers agents | closes D2 |
| [0003](0003-completion-states-and-verification.md) | Four completion claims; verification as a per-task and per-goal contract with enforced independence | extends Decision 19 |
| [0004](0004-event-ledger-scope.md) | A transactional event ledger beside relational state; not event sourcing | replaces "event-sourced ledger: not adopted" |
| [0005](0005-authenticated-principals.md) | Per-execution bearer tokens; identity from the token only | closes D1; qualifies Decision 2 |
| [0006](0006-harness-and-execution-boundaries.md) | Harness contract with hosted tool pipeline; agent, execution, workspace, session and claim are separate records; AX behind `ExecutionProvider` | revises Decision 3; extends Decisions 1, 11 |
| [0007](0007-gateway-credentials-budgets.md) | Execution gateway, vaulted credentials, trust profiles, hierarchical budgets with enforcement tiers, LLM proxy | narrows Decision 6; extends Decision 19 |
| [0008](0008-memory-model.md) | Scoped immutable memory with provenance; goal knowledge distinct from agent memory | revises Decisions 11, 16 |

## What happened to the existing decisions

| # | Existing decision | Fate |
| - | --- | --- |
| 1 | On top of ax, never inside it | **Kept.** Strengthened: ax is one `ExecutionProvider`. |
| 2 | Brokered messages | **Kept.** Authenticated sender added (ADR 0005). |
| 3 | pi first runtime via pi-agent-core | **Revised:** pi is the first `Harness` behind a contract with cancel and capabilities (ADR 0006). |
| 4 | TypeScript throughout | **Kept.** |
| 5 | Inbox-non-empty is the sole wake | **Kept, refined:** priority rules (`low` does not wake), `urgent` interrupts through the control watcher. |
| 6 | Full-trust egress and tools | **Narrowed:** becomes the `dev-full-trust` profile; production profiles add a gateway (ADR 0007). |
| 7 | One-shot failure | **Revised.** A *session* still fails once and is not retried. A *task* has an attempt policy: lease expiry and environment failures re-open the task for a new claim (up to `max_attempts`); agent-reported non-retryable failures and exhausted attempts park it `failed`. Invariant 6 is restated accordingly. |
| 8 | `folie up` owns the bootstrap | **Kept;** gains the collector and artifact volume. |
| 9 | Server is the sole Postgres writer | **Kept.** |
| 10 | Opaque work-item schema | **Kept in spirit:** the runtime interprets structure, never meaning of goals. |
| 11 | Fresh session per work item; memory is files | **Kept, extended:** fresh per scope, continuation sessions on the same claim, memory is the memory service and artifacts (ADR 0008). |
| 12 | Steering at turn boundaries by the runtime | **Kept; extended** by the control watcher for urgent mail and cancel. |
| 13 | Replay safety via `AgentTool.replay`, journal, keys | **Kept;** moves into the shim's hosted tool pipeline so every harness gets it. |
| 14 | Trace context stored on rows | **Kept;** extends to tasks, claims, invocations; episodes linked, not one giant trace. |
| 15 | Telemetry leaves a sandbox only through folie-server | **Kept.** |
| 16 | Artifact metadata in Postgres, bytes in `/workspace` | **Revised:** bytes move to the artifact store (ADR 0008). |
| 17 | Fail-fast covers work, not delivery | **Kept.** |
| 18 | No coding-specific isolation in the core | **Kept.** |
| 19 | Direction: push + fencing leases, verification contract, policy outside sandbox | **Superseded** by ADRs 0001, 0003, 0007. |

## The twenty questions

Each question from the evolution brief, the decision, and where it is specified. "ADR" means the alternatives and trade-offs are recorded there; otherwise the specification section states the rationale.

| # | Question | Decision | Specified |
| - | --- | --- | --- |
| 1 | Push, pull or hybrid discovery? | **Hybrid:** nomination pushes summaries to a small ranked set of eligible agents; agents pull by indexed query; neither polls everything nor wakes everyone. | ADR 0001; protocols §5 |
| 2 | What wakes an idle agent; how do active agents get urgent mail? | Only a delivery wakes (Invariant 3), by priority rules; urgent mail and control reach a running session in ~1 s through a shim-side control watcher independent of the model loop. | protocols §2 |
| 3 | Negotiation without races or deadlock? | Negotiation is messages with TTLs; every authoritative outcome is one conditional update; six rules (no wait-while-holding, TTLs, atomic single ownership, offer caps, non-blocking circular help, handoff cap). | protocols §6 |
| 4 | Multi-agent tasks without ambiguous ownership? | **One owner, any participants.** Only the owner submits; participants attribute artifacts; splitting into subtasks is the default recommendation. | ADR 0001; protocols §6 |
| 5 | May agents create agents? | **No. They request capacity** against budget and policy; the runtime registers agents from human-managed profiles; grants delegate downward only. | ADR 0002; protocols §15 |
| 6 | Validate capability claims? | Self-declaration admits only low-risk work; `assessed` by probes; `verified` by independent track record (Wilson bound, decay, revocation streak). | integration |
| 7 | Avoid duplicate, low-value, endless task generation? | Dedup key and similarity, depth, fan-out, frontier-WIP and rate caps, shrinking budgets. | protocols §16 |
| 8 | Dynamic graphs and superseded tasks? | Revisions flag stale tasks; supersession is explicit and non-cascading; `plan.change` is atomic; acceptance guards refuse stale submits. | protocols §9 |
| 9 | Team context without an unbounded transcript? | A context pack: charter, curated notes with digests, artifacts, channel history by cursor; sessions get a token-budgeted selection. | protocols §7; agents-and-execution |
| 10 | Persistent memory vs goal knowledge? | Agent memory is about the agent; goal knowledge is about one goal's world. Goal scope by default; cross-goal retrieval only for `portable` agent entries; promotion needs provenance and, at swarm scope, verification or approval. | ADR 0008 |
| 11 | Switch harnesses and keep identity and context? | Config fetched per session; context is neutral (memory, notes, artifacts, pack); no mid-session switch. | agents-and-execution; ADR 0006 |
| 12 | Execution provider loses a task? | The reconciler compares desired, recorded and actual state; `lost` revokes leases immediately, abandons the session, restores the workspace from the best source, leaves in-flight calls `unknown` for reconciliation. | protocols §14 |
| 13 | Budgets through delegation? | Carve-out from the parent's headroom in one statement; close returns the unspent; spawning and delegating both require a carve-out. | ADR 0007; protocols §12 |
| 14 | Idempotent or reconciled side effects? | Deterministic keys, provider idempotency where available, write-ahead journal, `unknown` state, provider `reconcile`, human on indeterminate; compensation declared per tool. | ADR 0007; protocols §11 |
| 15 | Verification without a deterministic verifier? | Contract names the substitute (independent re-derivation, evidence audit, human sample); confidence capped for pure judgment; goals may require a non-LLM check. | ADR 0003; protocols §8 |
| 16 | Detect no meaningful progress? | Heartbeat progress counters, loop detection, spend-without-output, goal-level verified-per-spend pace, message ping-pong; detection is deterministic, actions are notice, pause, revoke. | protocols §16 |
| 17 | Human intervention without corrupting ownership? | Humans are principals and may hold claims; every action is an ordinary fenced transition; control messages are advisory, fences are authoritative. | protocols §13 |
| 18 | What must be centralized for correctness; what can distribute? | See below. | DESIGN §24 |
| 19 | Minimum extension contracts? | Manifest, JSON-RPC invocation, ledger cursor, grants as sole authority, lifecycle and isolation rules. | integration; interfaces §8 |
| 20 | What stays outside the specification? | The explicit exclusions, with no staging. | requirements §3 |

**Question 18.** *Centralized for correctness* (single logical authority in one deployment, and the last things to distribute): arbitration of claims and fences (the task table's conditional updates, one Postgres writer); the ledger's order; the budget tree roots; policy snapshots and credential issuance; the lease sweeper and reconciler (leader-elected). *Distributable early*: API replicas (stateless behind a load balancer), harnesses and executions (already), verification workers and code-running verifiers, tool providers and extensions, event subscribers and SSE fan-out, artifact storage, nomination scoring (pure function, any replica). *Later path*: shard by swarm (all rows carry `swarm_id`); Postgres HA with a single primary writer; per-goal partitioning of the sweeper; multi-provider execution. Distributed consensus is not needed until a single Postgres primary is the proven bottleneck, which it is not at hundreds of agents.

## Open architectural questions

Not resolved responsibly yet; each has a default the specification assumes and what would change it.

| # | Question | Assumed default | What would change it |
| - | --- | --- | --- |
| OQ1 | Can Substrate/atenet give the server an authenticated source-actor identity, replacing env tokens? | Opaque bearer tokens (ADR 0005) | Verified workload identity at the destination |
| OQ2 | Can a suspended execution's workspace be archived or read from the provider checkpoint? | Best-effort archive at session end; important outputs are artifacts | ax or Substrate exposing checkpoint access |
| OQ3 | Can model calls be proxied (key custody, streaming, per-request budget) without breaking harnesses, including ax's `Model` object? | E1 cutoff until a proxy exists; proxy is an ADR 0007 item | A harness that supports a base URL override (pi does; verify) |
| OQ4 | Full-text only, or vector retrieval (pgvector) for memory? | Full-text, ranked by recency and confidence | Evaluation showing retrieval misses that cost verified outcomes |
| OQ5 | How is LLM-judged verification validated; how do evaluations avoid circularity? | Canary artifacts, audit samples, human sampling, benchmarks with deterministic ground truth | Measured false-accept rates |
| OQ6 | Is tamper-evidence of the ledger against a database administrator required? | Append-only by database role and trigger; not tamper-evident | A deployment with an adversarial operator |
| OQ7 | When do loops (sweeper, reconciler) leave the API process? | Leader-elected in-process via advisory lock | Sweeper latency or API load interference |
| OQ8 | When to migrate to the GenAI semantic conventions fully? | Dual-write attributes | Conventions reaching stable |
| OQ9 | Human identity provider (OIDC) and multi-swarm isolation (row-level security)? | Operator API keys; one swarm | Multi-user or multi-tenant deployment |
| OQ10 | Memory poisoning and consolidation safety (an agent writing persuasive false memory)? | Provenance, contested links, promotion gates, swarm scope needs verification or approval | Observed poisoning in evaluation |
| OQ11 | Reputation model: Wilson bound and decay, or something richer; gaming resistance in practice? | Wilson lower bound over verified tasks with independence | Evaluation of nomination quality |
| OQ12 | Hot-row contention on budget roots at hundreds of agents? | Leaf-level spending, carve-outs only touch parents | Contention in load tests; then slab reservations |
| OQ13 | Is a UI/TUI extension point needed? | None | Concrete extension demand |
