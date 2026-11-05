# Goals, tasks, coordination and verification

Status: **target architecture**; nothing here is built (today there are flat work items, [`current-system.md`](current-system.md)). Authority: [`../DESIGN.md`](../DESIGN.md) §8, §9, §14. State machines and schema: [`../spec/domain-model.md`](../spec/domain-model.md). Protocols: [`../spec/protocols.md`](../spec/protocols.md). Decisions: [ADR 0001](../decisions/0001-hybrid-discovery-runtime-claims.md), [ADR 0003](../decisions/0003-completion-states-and-verification.md).

## What the runtime understands about work

The runtime understands **structure**: which goal a task belongs to, which revision it was made under, what it depends on, who holds it under which fence, what budget it draws on, what its contract says must be checked, and what state it is in. It never interprets **meaning**: what a hypothesis is, whether a proof is sound, what a good sales report looks like. Meaning lives in the goal text, the task instructions, the agents' reasoning and the verifiers.

The same primitives serve unlike domains; nothing below is coding-specific:

| | Research | Software | Business workflow |
| --- | --- | --- | --- |
| **Goal** | "Is claim X supported by the literature since 2020? Deliver a cited report." | "Build and deploy service S to spec." | "Qualify these 200 leads and book meetings." |
| **Acceptance** | every claim cites a retrievable source; two independent reviewers agree support is adequate | tests pass; deploy health check green; human approves release | CRM state shows each lead qualified or rejected with reason; meeting count reconciles with the calendar |
| **Typical tasks** | search source clusters, read and extract, cross-check, synthesise, adversarial review | design, implement module, write tests, review, deploy | enrich, score, draft outreach (approval-gated send), reconcile |
| **Verifiers** | citation resolver (deterministic), reviewers (agents), human sample | test runner (deterministic), static analysis, reviewer, human release approval | external-state reconciler (deterministic), human approval for sends |
| **Tools** | search, fetch, file | repo, CI, deploy (gateway) | CRM, email, calendar (gateway) |

## Goals

A goal is a persistent objective with a **current revision** and a history.

- **Content** (per revision): natural-language `description`; `acceptance` (criteria with ids and a verification contract); `constraints` and `exclusions`; `refs` (artifacts, URLs, accounts); `approval` requirements; deadline and priority; a budget reference; free `metadata`. Nothing forces a universal schema: the structured parts are the ones the runtime acts on.
- **Revision and supersession.** Revising appends a revision, flags stale tasks, and never rewrites history. A goal can be superseded by another goal (link kept). See [protocols §9](../spec/protocols.md#9-revision-dependency-change-and-supersession).
- **Pause, resume, cancel.** Pause sets a `hold`: no new claims immediately, cooperative stop for holders, lease revocation after a grace period. Cancel is T18 for every non-terminal task with fence bumps.
- **Completion** is a *verdict*, never a flag set by an agent ([protocols §10](../spec/protocols.md#10-goal-evaluation)). A goal's acceptance contract can require a non-LLM check and a final human approval.
- **Where the first tasks come from.** On activation the runtime creates **one task of intent `plan`** ("decompose this goal; propose tasks"), available to anyone eligible. It is an ordinary task: claimed first-come, fenced, verified like any other (its contract can be as light as "a `plan.change` was proposed and accepted"). A goal owner may seed tasks directly. There is no standing planner or manager role; any agent can propose tasks at any time, and the plan task is just the first one.

## Tasks: an evolving graph, not a static DAG

The task graph of a goal changes while it runs. The runtime keeps enough structure for scheduling, observability and verification without freezing the plan:

- **Edges** (`hard` gates availability; `soft` is advisory context; `informs` passes artifacts) with a `needs` level (`completed` or `verified`). Acyclicity is checked on every edge insert. Availability is maintained by a counter (`open_deps`) updated in the transaction that completes the upstream task.
- **Dynamic creation and decomposition.** Any agent with `task.propose` may propose a task under a parent. Proposals carry a contract and a budget ask, and pass the runaway limits ([protocols §16](../spec/protocols.md#16-progress-stall-detection-and-runaway-limits)). Acceptance is `auto` within the caps, otherwise the goal owner or a human decides.
- **Replanning is a bundle.** `plan.change` applies supersede, propose and rewire atomically with a net budget check, so an agent can change its mind without leaving the graph half-edited.
- **Supersession is explicit and non-cascading.** Replaced work is linked (`superseded_by`), descendants are flagged `orphaned`, and the owner chooses.
- **Stale detection.** A task's inputs (dependency artifacts) and its goal revision are re-checked at acceptance; a stale task is not accepted until re-confirmed.
- **Multiple agents on a task:** one owner plus participants; usually better, split into subtasks ([protocols §6](../spec/protocols.md#6-negotiation-offers-bids-help-handoff)).
- **History and provenance:** the ledger holds every transition with actor, cause and trace; artifacts carry `produced_by` and input artifact ids, so "why does this number exist" is a query.

## Communication, coordination, organization

The vision's central claim is that *messaging does not by itself produce self-organization.* Folie today provides communication only. The three layers, who owns each, and what the mechanisms are:

| Layer | Question it answers | Mechanisms | Authority | Built today? |
| --- | --- | --- | --- | --- |
| **Communication** | Can agents tell each other things? | Durable inboxes, direct and topic mail, goal/task/team channels, urgent delivery, history replay, provenance by authenticated sender | Runtime stores and delivers; agents decide content | Inboxes, topics, steering: yes. Authenticated provenance, priority, channels: no |
| **Coordination** | Can agents align actions and avoid conflict? | Task graph and dependencies; claims with leases and fences; nomination and pull discovery; offers, bids, handoff; dedup and similarity; stall and loop detection; budgets as shared constraints | **Runtime decides outcomes** (conditional updates); agents propose and negotiate | No |
| **Organization** | Can agents form, change and dissolve structures around work? | Teams (convened, joined, divided, dissolved); capacity requests; delegation with budget carve-out; participation; handoff of ownership; reputation-weighted nomination | Runtime enforces bounds and budgets; agents decide structure | No |

**What makes self-organization possible** (as opposed to merely allowed):

1. **A shared, queryable representation of the work** (the task graph) that every agent reads and edits through bounded operations. Without it, agents coordinate only through free text, which does not compose.
2. **Cheap, safe commitment** (claims) and cheap, safe release (leases), so an agent can try work without locking others out or stranding it.
3. **Cheap discovery** (nomination, pull queries, `agent.find`) so agents find work and peers without reading everything.
4. **Resource accountability** (budget carve-outs) so spawning, delegating and forming teams cost something, which is what stops runaway structures.
5. **Verified outcomes feeding back** into who gets nominated next (reputation), so structure adapts to what actually works.

**What bounds it.** Every organizing act passes the runtime: proposals pass depth, fan-out, frontier and rate limits and budget carve-outs; teams pass size and count caps; capacity requests pass policy and caps; negotiation objects expire; ownership is single. An agent that "organizes" badly wastes its own budget, not the swarm's.

**Leadership, coordination and specialization are not roles.** A "coordinator" is whoever owns a parent task or convenes a team for the span of that scope. Specialization is a capability level earned through verified results plus an agent profile, not a position in a hierarchy. A fixed manager-worker structure remains *expressible* (a goal owner agent that proposes and assigns), which is what the evaluation uses as a baseline ([`../DESIGN.md` §23](../DESIGN.md#23-testing-and-evaluation)).

**How effectiveness is evaluated.** Not by message counts. Each coordination mechanism is switchable (`discovery: push|pull|off`, `offers: on|off`, `teams: on|off`, `reputation_weighting: on|off`), and the evaluation suite compares verified outcomes, cost, duplicate work and recovery with mechanisms on and off, and against single-agent, manager-worker and centrally planned baselines. A mechanism that does not improve measured outcomes is a candidate for removal.

## Verification subsystem

**Components.** The *contract* (data, on tasks and goals); the *orchestrator* (server module that creates verification rows at acceptance, dispatches jobs, aggregates, and drives T14–T16); *adapters* ([`VerifierAdapter`](../spec/interfaces.md#6-tools-verifiers-capabilities)) for deterministic checks; *verify tasks* (ordinary tasks of `kind = verify`, claimed under independence constraints); a *human review queue* (approval-center items); and an *audit loop* (re-verification samples and canary artifacts). Verification reuses the task machinery (claims, leases, budgets) rather than a second scheduler.

**Independence** is a property the runtime enforces, not a request to agents: the producer and all participants are excluded from review tasks of the same work; for goal evaluation an `independence.strict` setting excludes everyone who produced a task in the goal; a check may demand a different harness or model from the producer; the human check is independent by definition. Independence is recorded on the verification row.

**Different domains, different verifiers.** No universal verifier is claimed. The contract names what applies:

| Domain | Deterministic | Agent review | Human | Notes |
| --- | --- | --- | --- | --- |
| Software | tests, static analysis, integration and deploy health | design/code review | release approval | Strongest deterministic coverage |
| Mathematics | proof checker adapter, symbolic/numeric validation, independent derivation with comparator | review of informal steps | spot check | A formal checker beats review whenever the claim is formalisable |
| Research | citation resolution and re-hash of sources, provenance completeness, reproducibility re-run | claim-versus-source support (independent) | sample audit | Review is an LLM judging; confidence capped without corroboration |
| Business workflows | external-state reconciliation (CRM, ledger, calendar) | process review | approvals on irreversible steps | State in the external system is the evidence |
| Physical systems | independent sensor feedback; safety-controller confirmation | — | operator sign-off | The agent can never be the safety authority ([governance](governance-and-resources.md#physical-world-execution)) |

**Reporting uncertainty.** Each check stores `confidence`; the task stores the minimum over required checks; a goal evaluation reports `achieved | partially | not_achieved | inconclusive` with caveats. `verified` with `method: judgment` is shown as such. Dashboards never collapse "all checks passed" and "all checks passed but one was LLM judgment at 0.7".

## Failure modes and how they are handled

| Failure | Handling |
| --- | --- |
| Duplicate or low-value proposals | `dedup_key` index, similarity warning, owner acceptance above the threshold, proposal quotas |
| Endless recursion | depth cap, shrinking budgets, frontier WIP cap |
| Stale holder commits | fence on every write and at gateway dispatch |
| Agent claims everything and does nothing | concurrency limit, stall detector revokes, reputation decays |
| Two agents disagree | owner decides; reviewer; human |
| Plan invalidated mid-run | stale flags, `control` messages, acceptance guards |
| Verifier collusion or laziness | independence rules, canary artifacts, audit sampling, non-LLM check requirement |
| Coordination overhead exceeds value | measured (`folie.coordination.overhead`); mechanisms switchable; evaluation compares against baselines |

## Requirements

Required: R-7.1–7.4 (goals and revisions, `achieved` only by evaluation, pause and cancel, stale flagging), R-8.1–8.10 (the full task lifecycle, claims and fences, sweeper, dependencies, atomic `plan.change`, non-cascading supersession, stale guards, runaway limits, single ownership), R-9.1–9.9 (nomination, pull, offers, help, teams, capacity requests, stall detection, no deadlock, switchable mechanisms), R-11.1–11.7 (verification), R-15 (coordination observability).

Not required: bids (`MAY`), reputation weighting as a default (`MAY`, behind a switch), cascading supersession helpers, an LLM progress reviewer.

## Tests

Deterministic (fake harness, in-memory provider, real Postgres semantics): two concurrent claims → one winner; stale-fence submit rejected and its artifacts quarantined; lease expiry → reclaim with higher fence; dependency cycle rejected; dependency reopened → downstream demoted; revision → stale flags and guarded acceptance; plan-change atomicity (injected failure rolls back everything); quota and dedup limits; verification independence (producer cannot claim its own verify task); `completed` vs `verified` dependent promotion; goal evaluation coverage gap → reconcile tasks. Realistic experiments: [`../DESIGN.md` §23](../DESIGN.md#23-testing-and-evaluation).
