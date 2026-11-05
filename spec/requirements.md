# Requirements

Status: **normative**. This is the specification Folie must meet. Architecture and protocols explain *how*; where they disagree with this file, this file wins.

**Conformance.** `MUST`/`MUST NOT` are required, each verified by a named automated test unless marked *(live)*, which requires a recorded run against real ax, Substrate and a model provider. `SHOULD` is required unless a deviation is recorded with its reason in `decisions/`. `MAY` is optional. **The specification is met when every MUST has a passing conformance test, every live requirement has a recorded run, and demonstrations E1–E6 ([§2](#2-demonstrations)) pass.** There is no staging: all MUSTs are required of one system.

## 1. Requirements

### Identity and access ([`spec/protocols.md`](protocols.md) §1)

| # | Requirement | How verified |
| - | --- | --- |
| R-1.1 | The server MUST resolve the principal from a presented credential only; a body field naming a caller MUST match or the request MUST fail `403` | agents in different executions attempt to act as each other |
| R-1.2 | Each execution MUST hold a token bound to its agent, execution and credential generation; revocation, retirement or `lost` MUST invalidate it within 5 s | revoked token rejected after TTL; zombie process rejected |
| R-1.3 | Every route MUST be authorized by principal kind and grant; operator routes MUST reject agent tokens | matrix of agent token × operator routes → `403` |
| R-1.4 | No agent-reachable operation may create, modify or delete a grant, policy, budget or credential; the ledger and gateway MUST NOT be disableable by an agent | adversarial attempts → `403`, recorded |
| R-1.5 | Agents MUST be created only by operator registration or a granted capacity request; messaging or subscribing to an unknown name MUST return `404` | unknown-name send → `404` |

### Messaging ([`spec/protocols.md`](protocols.md) §2)

| # | Requirement | How verified |
| - | --- | --- |
| R-2.1 | A delivery MUST have exactly one recipient and a state `pending → leased → acked`; `abandoned`, `expired` and `dead_lettered` MUST be reachable and visible to operators | state machine tests |
| R-2.2 | Every publication MUST be recorded, including one with zero subscribers, and the zero-subscriber count MUST be returned to the publisher | publish to empty topic → row + metric |
| R-2.3 | Only a delivery MUST wake an agent; `low` priority MUST NOT wake a suspended agent; expired deliveries MUST NOT | wake-window tests |
| R-2.4 | `urgent` mail and control signals MUST reach the shim within 2 s of arrival, independent of the model loop; if the active harness cannot accept delivery, the shim MUST cancel it and start a session that includes the urgent delivery | slow-tool harness, measured |
| R-2.5 | Cancel MUST be cooperative then forced: abort the model request, signal running tools, kill after grace, settle `cancelled`, record partial usage, mark in-flight `never` calls `interrupted` | cancel during tool execution |
| R-2.6 | Goal, task and team channels MUST retain history readable by cursor by participants; late subscribers MUST NOT receive old mail in their inbox | channel history tests |
| R-2.7 | Sender MUST be recorded from the authenticated principal | spoof attempt rejected |
| R-2.8 | Sends and all mutations MUST be idempotent by `request_id` for 24 h | replay returns stored response |

### Agents, sessions, memory ([`architecture/agents-and-execution.md`](../architecture/agents-and-execution.md))

| # | Requirement | How verified |
| - | --- | --- |
| R-3.1 | Agent, execution, workspace, session, claim and memory entry MUST be separate records with the lifecycles in `spec/domain-model.md` §4.4 | schema and transition tests |
| R-3.2 | A session row MUST exist from session start; a crashed session MUST be detectable and marked `abandoned`, returning its leased deliveries | kill mid-session |
| R-3.3 | A session MUST serve one scope; one rescope from `mail:` to `task:` MUST be allowed, at most once | rescope tests |
| R-3.4 | A session MUST be bounded by deadline, turn cap and usage budget, and MUST settle `cancelled` at a limit | limit-reached session |
| R-3.5 | A `task:` session ending without submit MUST be treated as `yielded` with a handoff note, never as completion; its claim MUST survive | yield tests |
| R-3.6 | Harness, model and limits MUST be read per session so a change needs no new execution | config change between sessions *(live)* |
| R-4.1 | Memory MUST be scoped `agent|team|goal|swarm`, with task notes constrained to their goal and tagged by `task_id`; access control MUST be enforced inside the query, with no unfiltered read | ACL matrix |
| R-4.2 | Memory entries MUST be immutable with provenance; contradictions MUST be linked and surfaced, never silently resolved | contested-entry tests |
| R-4.3 | Cross-goal retrieval MUST return only agent-scope entries marked `portable`; goal knowledge MUST NOT cross goals | contamination test |
| R-4.4 | Artifact bytes MUST be stored content-addressed outside the workspace and MUST survive execution termination | retire then fetch |
| R-4.5 | The context pack MUST be assembled to a token budget, deterministic in truncation, and stored by hash | assembly budget test |

### Harness and execution ([`spec/interfaces.md`](interfaces.md) §4–§5)

| # | Requirement | How verified |
| - | --- | --- |
| R-5.1 | A harness MUST implement start, result, cancel and structured events, and MUST declare its capabilities; usage MUST be reported per session, and per turn whenever E1 model-spend enforcement applies | conformance suite |
| R-5.2 | Journaling, tracing, replay policy and fence attachment MUST be applied once by the host for hosted and native tools alike | two harnesses, same pipeline |
| R-5.3 | At least two harnesses MUST pass the conformance suite, one of them an LLM agent | `echo` + `pi` *(live)* |
| R-5.4 | Pi-specific concepts MUST NOT appear outside the Pi adapter | import-boundary test |
| R-6.1 | The controller MUST depend on an `ExecutionProvider` port; provider concepts MUST NOT appear in the domain or app layers | import-boundary test |
| R-6.2 | The AX adapter MUST set resource limits, workspace and network policy, and MUST use listing for reconciliation | provider contract suite *(live)* |
| R-6.3 | The reconciler MUST detect orphans, ghosts and `lost` executions from desired, recorded and actual state | injected divergence |
| R-6.4 | A `lost` execution MUST revoke its claims immediately, abandon its session, return deliveries, and restore the workspace from the best available source with an event when empty | kill execution *(live)* |
| R-6.5 | Execution retirement MUST respect `workspace_policy`; an execution MUST NOT be terminated while a required archive is missing | retire tests |
| R-6.6 | Background loops MUST be leader-elected so additional API replicas cannot double-dispatch | two instances, one database |
| R-6.7 | `spec.debug` MUST be `false` in every provider manifest; this MUST be enforced by a test that fails if any manifest or adapter defaults it to true | manifest test |
| R-6.8 | Every task MUST carry a `ResourcesSpec` (CPU/memory) set from per-agent policy, not left unlimited | task-spec test |
| R-6.9 | Egress MUST be profile-based (`dev-full-trust` for development; named-host/per-port production profiles), with a documented owner and re-test cadence for private-IP exceptions (Substrate #2086) | policy test + deployment note |
| R-6.10 | Retirement MUST NOT destroy the content-addressed artifact store or scoped memory service; workspace archive policy (`archive` vs `scratch`) MUST gate termination (see R-3.6, R-4.x) | retire tests |

### Goals and tasks ([`architecture/work-and-coordination.md`](../architecture/work-and-coordination.md), [`spec/domain-model.md`](domain-model.md) §4)

| # | Requirement | How verified |
| - | --- | --- |
| R-7.1 | Goals MUST carry description, acceptance criteria, constraints, exclusions, budget, deadline, priority, references and approval requirements, versioned by immutable revisions | goal tests |
| R-7.2 | `achieved` MUST be set only by goal evaluation, never by an agent report | report cannot achieve |
| R-7.3 | Pause MUST stop new claims immediately; cancel and supersede MUST revoke claims with a fence bump | pause/cancel tests |
| R-7.4 | A material revision MUST flag non-terminal tasks stale, and a stale task MUST NOT be accepted until re-confirmed or superseded | revision tests |
| R-8.1 | Tasks MUST implement the transitions in `spec/domain-model.md` §4.2 with the stated actor and guard for each | transition table test |
| R-8.2 | A claim MUST be one conditional update that increments the fence; heartbeat MUST require a matching fence and unexpired lease and MUST be shim-driven | concurrent claim race |
| R-8.3 | Every write by a holder MUST be fenced; a stale holder's artifacts MUST be quarantined and its gateway calls MUST be denied, including at dispatch | stale-holder suite |
| R-8.4 | A sweeper MUST expire leases, warn, and reclaim with a higher fence, bounded by `max_attempts` | lease expiry test |
| R-8.5 | Dependencies MUST be typed and `needs`-levelled, MUST be acyclic, and MUST gate availability through a transactionally maintained counter | cycle + promotion tests |
| R-8.6 | `plan.change` MUST apply propose, supersede and rewire atomically with a net budget check | injected failure rolls back |
| R-8.7 | Supersession MUST be explicit and MUST NOT cascade; descendants MUST be flagged `orphaned` | supersession tests |
| R-8.8 | Acceptance MUST refuse a result whose inputs or revision are stale, or whose approval-gated effect is pending | stale-submit tests |
| R-8.9 | Runaway limits MUST be enforced: depth, fan-out, frontier WIP, proposals per hour, `dedup_key` uniqueness | quota tests |
| R-8.10 | A task MUST have at most one active owner claim and any number of participants; only the owner MUST submit | participation tests |

### Coordination ([`spec/protocols.md`](protocols.md) §5–§7)

| # | Requirement | How verified |
| - | --- | --- |
| R-9.1 | On availability the runtime MUST notify a bounded ranked set of eligible agents and MUST widen in rounds, never broadcast to all | nomination tests |
| R-9.2 | Tasks, goals needing attention and capable agents MUST be discoverable by indexed query | pull tests |
| R-9.3 | Offers and handoff MUST transfer ownership atomically with a fence bump and MUST expire | offer race tests |
| R-9.4 | Help requests MUST admit contributors under a cap, with per-artifact attribution | participation tests |
| R-9.5 | Teams MUST be formable, joinable, digestible and dissolvable, scoped to a goal or task, with a channel, a budget slice and a context pack; dissolution MUST return the unspent budget | team lifecycle tests |
| R-9.6 | Capacity requests MUST be bounded by grant, policy, swarm cap, goal cap, spawn depth, descendant cap and a budget carve-out; grants delegated to new agents MUST be a subset | spawn-attack test |
| R-9.7 | Stalls and loops MUST be detected deterministically and MUST result in notice, pause or revoke, never silent retry | stall/loop tests |
| R-9.8 | No negotiation object may block its holder: offers, bids and help requests MUST expire and MUST never be waited on while holding a claim | deadlock scenario |
| R-9.9 | Self-organization MUST be comparable to baselines: each coordination mechanism MUST be switchable | [§2](#2-demonstrations) |

### Capabilities, tools, extensions ([`architecture/integration.md`](../architecture/integration.md))

| # | Requirement | How verified |
| - | --- | --- |
| R-10.1 | Capabilities MUST be versioned definitions with levels `declared|assessed|verified`, and evidence MUST come only from independence-enforced verification | evidence tests |
| R-10.2 | Claim eligibility MUST check required capability level, grants, budget, concurrency and independence; self-declared capability MUST NOT admit high-risk work | eligibility matrix |
| R-10.3 | Tools MUST be versioned typed definitions carrying risk class, idempotency, replay policy, timeout, cost model and redaction | registry tests |
| R-10.4 | An agent MUST see only tools it is granted; the model-visible surface MUST stay bounded (rare operations through the CLI) | tool listing test |
| R-10.5 | Extensions MUST be limited to the five contracts (manifest, JSON-RPC invocation, ledger cursor, grants as authority, lifecycle and isolation) and MUST run out of process unless first-party | manifest/lifecycle tests |
| R-10.6 | A provider that fails MUST trip a circuit breaker and MUST NOT block any other tool or state transition | slow-provider tests |

### Verification ([architecture/work-and-coordination.md](../architecture/work-and-coordination.md#verification-subsystem))

| # | Requirement | How verified |
| - | --- | --- |
| R-11.1 | The four claims (submitted, completed, verified, achieved) MUST be distinct states, and success MUST be reported only as verified | state tests |
| R-11.2 | The verification contract MUST be fixed at acceptance; after acceptance only supersession may change it | contract-immutability test |
| R-11.3 | Independence MUST be enforced by the runtime: the producer and participants MUST NOT claim a verify task for their own work | independence test |
| R-11.4 | Deterministic checks MUST run through adapters, and code-running checks in a separate verification execution from an immutable artifact snapshot | verifier tests |
| R-11.5 | Goal evaluation MUST check acceptance-criteria coverage and MUST record `achieved|partially|not_achieved|inconclusive` with caveats | evaluation tests |
| R-11.6 | Confidence MUST be stored and displayed per check and per task; judgment-only checks MUST be capped and labelled | confidence tests |
| R-11.7 | Verifiers MUST be audited with canary artifacts and re-verification samples; false-accept rate MUST be reported | audit tests |

### Governance ([`architecture/governance-and-resources.md`](../architecture/governance-and-resources.md))

| # | Requirement | How verified |
| - | --- | --- |
| R-12.1 | Policy decisions MUST follow explicit deny > require_approval > allow, default deny for gateway actions, fail closed, and MUST record the policy version | decision table |
| R-12.2 | Grants MUST be created by humans or delegated downward from a held grant, and MUST expire and revoke transitively | delegation tests |
| R-12.3 | Actions MUST be classified R0–R7 with the stated autonomy defaults; R4–R6 MUST require approval and R7 MUST be refused without an independent safety attestation | risk matrix |
| R-12.4 | Conforming deployments MUST default-deny sandbox egress. Direct connections MAY reach only the Folie API, the configured model endpoint (or LLM proxy), and immutable read-only package mirrors; all other external reads, every external write, and every use of an external account MUST pass the gateway, including policy, budget, journal and audit checks | egress write-probe and gateway tests *(live)* |
| R-12.5 | Credentials for external accounts MUST NOT enter a sandbox; providers MUST receive short-lived scoped credentials. The **model-provider key SHOULD** be held by a Folie LLM proxy; while it is not, the deviation MUST be recorded and the documentation MUST state that model spend is enforced at E1 only | sandbox environment audit *(live)* |
| R-12.6 | An approval MUST be single use, bound to task, tool and args hash, and expiring; it MUST NOT authorize another agent | approval tests |
| R-12.7 | An `unknown` outcome MUST be reconciled and MUST NEVER be re-dispatched automatically | crash between journal and dispatch |
| R-12.8 | Conforming deployments MUST use `restricted` or `gateway-only`. `dev-full-trust` MAY exist only as an explicitly nonconforming, isolated development profile with no valuable data, real external accounts or production reachability | deployment policy tests *(live)* |
| R-12.9 | A mandatory human kill path MUST exist per level — task revoke, agent suspend, credential revoke, swarm freeze — each measured | latency measurement |

### Budgets and scheduling ([`architecture/governance-and-resources.md`](../architecture/governance-and-resources.md#resources))

| # | Requirement | How verified |
| - | --- | --- |
| R-13.1 | Budgets MUST be hierarchical per dimension; delegation MUST be a carve-out from the parent's headroom; closing MUST return the unspent | budget tests |
| R-13.2 | Total spend MUST be bounded by the root budget regardless of spawning or delegation | spawn-spend test |
| R-13.3 | Enforcement MUST be stated as E0/E1/E2 and MUST bind: E1 MUST stop an E1-budgeted session within one model turn of exhaustion and record the overrun; turn-level usage MUST be available whenever E1 model-spend enforcement applies | budget-exceeded scenario |
| R-13.4 | Quotas MUST apply per principal and per goal, and backpressure MUST never drop work | quota tests |
| R-13.5 | Scheduling MUST be deterministic and score capability, affinity, warmth, load, priority, goal weight and age; fairness MUST prevent starvation | scoring tests |

### Data and ledger ([`spec/domain-model.md`](domain-model.md))

| # | Requirement | How verified |
| - | --- | --- |
| R-14.1 | Every state transition MUST append exactly one ledger event in the same transaction | per-transition test |
| R-14.2 | Aggregates and their invariants MUST hold as tabulated; concurrency MUST use the stated conditional updates and unique indexes | race suite, multi-connection |
| R-14.3 | All time comparisons MUST use the database clock | clock-skew test |
| R-14.4 | Migrations MUST be additive with add–backfill–switch–drop, and the existing data MUST migrate to goals, tasks and executions | migration tests |
| R-14.5 | Server crash MUST lose no committed state and MUST recover background loops from leadership election | restart test |

### Observability and clients ([`architecture/observability-and-clients.md`](../architecture/observability-and-clients.md))

| # | Requirement | How verified |
| - | --- | --- |
| R-15.1 | Spans MUST carry the correlation attributes for swarm, goal, task (attempt, fence), agent, session, execution, harness, tool, artifact | span assertions |
| R-15.2 | Traces MUST be bounded episodes joined by links and stored context; no span may outlive one bounded piece of work | trace tests |
| R-15.3 | Context MUST propagate over HTTP, gRPC, rows, harness and provider boundaries and SSE frames | propagation tests |
| R-15.4 | Metrics MUST include the required set and MUST NOT use task, goal or session ids as labels | metric assertions |
| R-15.5 | Telemetry MUST never be used as authoritative state | design review + no read path |
| R-15.6 | The TUI MUST use the same API and stream, hold no business logic, depend on no harness, and expose human intervention flows that also exist as CLI commands | view-model tests |
| R-15.7 | Evaluation numbers MUST come from the database and ledger, not from sampled traces | evaluation harness |

## 2. Demonstrations

The specification is met only if these pass, end to end, on the recorded configuration *(live unless marked)*.

| # | Demonstration | Shows |
| - | --- | --- |
| **E1** | A human submits a research goal with acceptance criteria and a budget. Agents dynamically decompose it, discover and claim work without a central assigner, and one task is completed by an owner plus a contributor with attributed artifacts | autonomous decomposition and coordination |
| **E2** | An agent is killed mid-task; its lease or execution loss is detected, another agent claims with a higher fence, the first process's late submit is rejected, and the goal continues without human action | fenced recovery |
| **E3** | A task reported complete is rejected by independent verification, retried with findings, then verified; a producer cannot claim its own verify task *(deterministic and live)* | verification independence |
| **E4** | A human pauses, messages, edits the plan, revokes a claim and approves the final result mid-run without corrupting ownership | oversight |
| **E5** | An agent attempts to act as another, to call an operator route, to invoke an ungranted gateway tool, to self-grant and to exceed its budget; every attempt is denied and recorded | governance |
| **E6** | The system is run against single-agent, manager-worker and centrally planned baselines on held-out benchmark goals and the measured outcomes are reported, including failures | evaluation |

## 3. Excluded from this specification

Not requirements. The architecture must not foreclose them, and no document may claim them.

Physical-world execution and any R7 provider; multi-node, multi-replica scheduling and distributed consensus beyond leader-elected loops; multiple swarms, tenant isolation and OIDC; embeddings or other vector retrieval; UI/TUI extension points; bid-based claim negotiation (MAY); reputation weighting as a default (MAY, behind a switch); in-process third-party extensions; model-output quality itself, which no architecture can guarantee.

Open questions with assumed defaults: [OQ1–OQ13](../decisions/README.md#open-architectural-questions).
