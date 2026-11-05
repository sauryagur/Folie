# Protocols

Status: **target specification**. State and transitions: [`domain-model.md`](domain-model.md). Contracts: [`interfaces.md`](interfaces.md). Rationale: [`../decisions/`](../decisions/README.md).

Every protocol below follows the same discipline: agents *propose and negotiate* over messages; the runtime *decides* with one conditional database update; correctness never depends on an agent obeying a message. Failure behaviour is stated per protocol.

Contents: [1 Authentication](#1-authentication-and-the-request-envelope) · [2 Messaging](#2-messaging-delivery-wake-steering-interrupt) · [3 Task operations](#3-task-operations) · [4 Leases and stale holders](#4-leases-and-stale-holders) · [5 Discovery](#5-discovery) · [6 Negotiation](#6-negotiation-offers-bids-help-handoff) · [7 Team formation](#7-team-formation) · [8 Verification](#8-verification) · [9 Revision and supersession](#9-revision-dependency-change-and-supersession) · [10 Goal evaluation](#10-goal-evaluation) · [11 Gateway and approvals](#11-gateway-invocation-and-approvals) · [12 Budgets](#12-budgets) · [13 Human intervention](#13-human-intervention) · [14 Execution loss](#14-execution-lifecycle-loss-and-reconciliation) · [15 Capacity requests](#15-capacity-requests) · [16 Progress and runaway limits](#16-progress-stall-detection-and-runaway-limits)

## 1. Authentication and the request envelope

**Problem (D1).** Today the caller names itself in the body. Fencing, budgets and permissions are meaningless if identity is forgeable.

**Mechanism.**

1. Every caller holds a **bearer token** bound to one principal: an agent execution, a human operator, or an extension. Tokens are opaque 256-bit secrets, stored hashed in `api_tokens(principal, kind, hash, execution_id, generation, scopes, expires_at, revoked_at)`.
2. The controller mints an **agent token** when it creates an execution and injects it with the other per-task env (`FOLIE_AGENT_TOKEN`; ax already carries the LLM key the same way, so this adds no new class of secret in the sandbox). The token carries the agent's `credential_generation` and the execution id. An execution is immutable in ax, so the token lives for the execution.
3. On each request the server resolves the token, then requires `agents.credential_generation = token.generation`, `executions.state IN ('running','suspended')` for that execution (a suspended execution is being resumed), and `agents.status = 'active'`. Resolution is cached up to 5 s; **revocation latency is therefore ≤ 5 s** and the doc, the TUI and the kill-switch table state it.
4. The principal comes **only** from the token. During migration `from`/`agent` in a body, if present, must equal the principal or the call is `403`; the field is removed in API v2.
5. **Humans**: operator API keys created by `folie up` (stored in `~/.folie/credentials`, mode 0600), with roles `viewer`, `operator`, `admin`. OIDC is a later adapter behind the same `Principal` type.
6. **Authorization of routes** is by principal kind and grant: an agent may read its own inbox, act on its own claims and sessions, call tools it is granted, and read what its goals' visibility allows. Operator routes (`/agents/:n/{suspend,resume,delete}`, policy, budgets) require `operator`. Today's open operator routes become `403` for agent tokens.

**Request envelope.** `Authorization: Bearer …`, `traceparent`, `tracestate`, optional `Idempotency-Key` (alias of body `request_id`). Errors: `{ "error": { "code", "message", "details" } }`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `unauthenticated` | 401 | No or unknown token. |
| `token_revoked` | 401 | Credential generation, execution or agent status no longer valid. The shim stops. |
| `forbidden`, `policy_denied` | 403 | Grant missing, or policy denied (details: rule id). |
| `invalid_transition` | 409 | State machine does not allow it. |
| `stale_fence`, `already_claimed` | 409 | Fencing or claim conflict; details carry the current owner and fence. |
| `insufficient_budget` | 402 | Reservation or carve-out failed. |
| `quota_exceeded` | 429 | Proposal, message or fan-out limits. |
| `approval_required` | 202 | Accepted for approval; body has `approval_id`. |

**Failure behaviour.** A `401 token_revoked` is terminal for that process: the shim cancels the harness, flushes what it can, and idles (it does not exit; ax does not read exit codes, [`current-system.md`](../architecture/current-system.md#agent-image)). It cannot be woken until a new execution with a new token exists.

**Security note.** The token is in the sandbox environment. In `dev-full-trust` a compromised agent can use its *own* token (that is what an agent is); what it cannot do is act as another agent, outlive revocation, or reach credentials, which never enter the sandbox ([§11](#11-gateway-invocation-and-approvals)).

## 2. Messaging: delivery, wake, steering, interrupt

**Entities.** `publications` (the sender-side event) → `messages` (one delivery per recipient). Channels: `dm:<agent>`, `topic:<name>`, `goal:<id>`, `task:<id>`, `team:<id>`. The last three are system-managed: membership follows participation, and `subscribe` to them is a runtime decision, not a free action.

**Envelope** (additive over today's columns): `kind` (`mail`, `goal_assigned`, `task_assigned`, `task_available`, `task_offer`, `help_request`, `team_invite`, `verification_request`, `approval_result`, `control`, `system_notice`), `priority` (`urgent` 0, `normal` 1, `low` 2), `expires_at`, `correlation_id`, `causation_id`, `channel`, plus the existing `sender`, `body`, `trace`. `sender` is the authenticated principal; **provenance is therefore part of the envelope, not the body**.

**Publication and delivery are independent.** A publish always writes a `publications` row with `delivered = n`. `n = 0` is recorded (closing today's one audit gap), raises `folie.publication.undelivered`, and is returned to the publisher. Late subscribers do not receive old mail in their inbox. Goal, task and team channels keep their history and a joining participant reads it by cursor (`GET /v1/channels/:c/history?after=`), which is replay without flooding the inbox.

**Delivery semantics.** At-least-once. A delivery moves `pending → leased → acked` ([domain model §4.5](domain-model.md#45-message-delivery)). A session consumes (leases) deliveries; the session's settlement acks them; an `abandoned` session returns them to `pending`, up to `max_deliveries` (default 3), then `dead_lettered`. Consumer idempotency is by delivery id. Ordering within an inbox: `priority`, then id; ordering across senders is not guaranteed beyond id order.

**What wakes an idle agent.** Invariant 3 stays: *a delivery in the inbox is the only wake*, so every wake is logged. Rules that keep it from becoming a storm:

| Delivery | Wakes a suspended or retired agent? |
| --- | --- |
| `urgent` (any kind) | Immediately. |
| `normal` | Yes, at the next controller pass. |
| `low` | No. It waits for the next wake (or a 15 min digest flush). |
| `expires_at` passed | Never; swept to `expired`. |

System events that agents must react to (offers, nominations, approval results, verification requests, lease warnings) are deliveries of the matching `kind`. There are no hidden timers or side channels.

**Reaching an active session (steering and interrupt).** The agent shim runs a **control watcher** independent of the model loop: a long-poll (`GET /v1/agents/me/control?after=`; SSE when available) that returns within ~1 s of an `urgent` delivery or a control signal. It is the shim's code, not a model tool, so it works while the model is mid-generation or a tool runs for hours (today's limit: steering lands only at turn boundaries and cannot interrupt a long tool; D10).

| Arrives | Shim action |
| --- | --- |
| `normal`/`low` mail for the session's scope | Hold until the next turn boundary, then `harness.deliver(msgs, "steer")` (today's mechanism). If the harness lacks `deliver`, queue it for the next session. |
| `urgent` mail | `harness.deliver(msgs, "steer")` at the next safe point; if the harness cannot, `cancel` with reason `urgent_mail` and let the next session consume it. |
| `control: cancel`, `pause`, `lease_lost`, `stop` | `harness.cancel(reason, grace)`. |

`cancel` is **cooperative, then forced**: (1) set the session's abort signal and abort the in-flight model request; (2) signal running tools (`bash`: SIGTERM to the process group); (3) after `grace` (default 20 s) SIGKILL what remains; (4) settle the session `cancelled` with the partial usage and mark in-flight `replay: never` journal entries `interrupted`; the next attempt is told, as today ([Replay safety](../architecture/current-system.md#replay-safety)). A shim that does not heartbeat is handled by the runtime, not by messages: [§4](#4-leases-and-stale-holders) and [§14](#14-execution-lifecycle-loss-and-reconciliation). **Safe interruption therefore means: the transcript and workspace are intact, the outcome is recorded, no effect is claimed to be undone.**

**Limits.** Per-principal token bucket (default 60 messages/min, burst 20); fan-out cap per publish (default 100 recipients; more needs a `broadcast` grant); body ≤ 64 KiB (as events today).

**Failure behaviour.** A lost HTTP response is recovered by `request_id`. A crashed session returns its mail. A server outage stops wakes (quiescence, as today) and loses nothing.

## 3. Task operations

All calls are authenticated ([§1](#1-authentication-and-the-request-envelope)), idempotent by `request_id`, and write one ledger event.

| Operation | Caller | Notes |
| --- | --- | --- |
| `task.propose(goal, spec, contract, deps, budget_ask, dedup_key?, parent?)` | agent, human | → T1. Returns `{task, similar: [...]}`; `similar` lists live tasks with the same `dedup_key` or text similarity above `similar_threshold`. |
| `task.accept` / `task.reject` | owner, human; runtime in `auto` mode | → T2/T3. |
| `task.claim(task)` | agent | → T6. |
| `task.start(task, fence)` | shim | → T7; sent automatically when the session for the task begins. |
| `task.heartbeat(task, fence, progress)` | shim only | Extends the lease. Not a model tool. |
| `task.submit(task, fence, result)` | holder | → T11. |
| `task.block(task, fence, blocked_on)`, `task.release(task, fence)`, `task.fail(task, fence, class, reason)` | holder | → T9, T8, T17. |
| `task.cancel`, `task.supersede`, `task.reopen` | owner, human | → T18–T20. |
| `task.list(filter)`, `task.get(id)`, `task.history(id)` | agent, human | Indexed reads ([§5](#5-discovery)). |

**Claim** (the whole protocol; one statement decides):

```sql
UPDATE tasks t
   SET status = 'claimed', owner = $agent, fence = t.fence + 1,
       lease_expires_at = now() + make_interval(secs => $lease_s)
 WHERE t.id = $task AND t.status = 'available' AND NOT t.stale_revision
   AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.id = t.goal_id AND g.hold)
RETURNING t.fence, t.lease_expires_at;        -- 0 rows => 409 already_claimed
-- same transaction: INSERT task_claims (role 'owner', fence, source); ledger task.claimed;
-- eligibility was checked first (below); a concurrent loser sees 0 rows.
```

**Eligibility** (checked in the same transaction, before the update; any failure is `403 policy_denied` with the rule): agent `active` and executable; grant `task.claim` on the goal; every `required_capabilities` entry held at `level >= claim_policy.min_level` (`declared` is enough only when the task's `risk_cap` is below the goal's `declared_ok_below`); the agent is under its concurrency limit (default 1 owner claim); the agent's and the task's budgets have headroom; independence constraints hold (an agent cannot claim a `verify` task for work it produced or joined).

**Heartbeat**:

```sql
UPDATE tasks SET lease_expires_at = now() + make_interval(secs => $lease_s)
 WHERE id = $task AND owner = $agent AND fence = $fence AND status IN ('claimed','running')
   AND lease_expires_at >= now()
RETURNING lease_expires_at;                   -- 0 rows => 409 stale_fence; shim cancels the harness
```

Defaults: lease TTL 90 s, heartbeat every 30 s. Heartbeats are sent by the shim from its own timer, so a long model call or a long tool cannot lapse a lease. Each carries a monotonically increasing `progress` counter bumped by harness events (stream chunks, tool output, tool start or end); a counter that does not move is the stall signal ([§16](#16-progress-stall-detection-and-runaway-limits)).

**Submit**:

```sql
UPDATE tasks SET status = 'submitted', lease_expires_at = NULL
 WHERE id = $task AND owner = $agent AND fence = $fence AND status IN ('claimed','running')
RETURNING id;                                 -- 0 rows => 409 stale_fence
-- same transaction: claim -> completed, artifacts attach (only those uploaded with this fence),
-- ledger task.submitted, enqueue acceptance job
```

**Acceptance** (T12, deterministic): fence was valid at submit; every `required` output exists, is stored, hashed and matches its schema; no `tool_invocation` of this task is in `pending_approval`; input artifacts' producers are not superseded; not `stale_revision`. Pass → `completed` and verification rows are created ([§8](#8-verification)). Fail → T13 with machine-readable reasons attached to the next attempt.

**Failure behaviour.** Every operation is a single transaction that either commits state, claim and event together or none. A lost response is replayed by `request_id`. A holder that crashed after submit but before seeing the response finds the task `submitted`/`completed` on its next start and does not redo it.

## 4. Leases and stale holders

The **sweeper** (leader-only, every 5 s; [deployment](../DESIGN.md#24-deployment-architecture)):

1. *Expire*: `SELECT … WHERE lease_expires_at < now() AND status IN ('claimed','running') FOR UPDATE SKIP LOCKED` → T8 with `end_reason = 'lease_expired'`. `attempt` increments if the task had started; at `max_attempts` the transition is T17 with class `environment`.
2. *Warn*: at 2/3 of the TTL without a heartbeat, a `system_notice` to the holder (diagnostic, not relied on).
3. *Abandonment*: tasks `available` for longer than `abandon_after` (default 24 h) emit `task.abandoned` to the goal owner; `blocked` tasks past `blocked_ttl` likewise.
4. *Stalls*, *drift* (`open_deps`, `satisfied` recomputed), *abandoned sessions*, expired offers and deliveries ([§16](#16-progress-stall-detection-and-runaway-limits)).

**A stale holder is harmless because every write is fenced, not because it is told to stop.** What a holder whose lease lapsed (or was revoked) can and cannot do:

| Action by the stale holder | Result |
| --- | --- |
| `heartbeat` | `409 stale_fence` → shim cancels the harness. |
| `submit`, `block`, `fail`, `release` | `409 stale_fence`. |
| Upload artifacts with the old fence | Accepted into **quarantine** (`state = 'quarantined'`), never attached to the task, deleted after `quarantine_ttl`. The new holder can be offered them by a human, not automatically. |
| Gateway invocation | `denied stale_fence`; an `authorized`-but-undispatched invocation is **re-checked at dispatch** and cancelled. |
| Messages | Delivered (communication is not a state mutation). Marked `fence_valid = false` in the ledger when sent within a task scope. |
| Effects already dispatched by sandbox-local tools | Not stoppable by Folie ([§13](#13-human-intervention) states this limit). |

**Duplicate-work prevention** is the sum of: one conditional claim; `dedup_key` unique index; `similar` returned on propose; `claimed_by` visible in every discovery result; and the above fencing for the case where two executions both believe they hold the task.

## 5. Discovery

**Decision ([ADR 0001](../decisions/0001-hybrid-discovery-runtime-claims.md)): hybrid.** The runtime *pushes summaries to a small ranked set of eligible agents*; agents *pull* by indexed query at any time. Nobody polls everything and nobody is woken en masse.

**Push: nomination.** On T4 (`available`) and on T8 (task freed):

```
nominate(task, round):
  candidates = agents where status=active AND goal visible AND eligible(task)
               AND (interests match OR round >= 2)            # interests: capability tags, goals, min priority
  rank by score(task, agent) = w_cap*capability_level + w_aff*(worked on goal/parent)
                              + w_warm*(running > suspended > retired) + w_fair*aging(agent)
                              - w_load*current_load            # fixed small weights, in config
  notify top K (default 3) not already notified: delivery kind=task_available, priority from task priority
        body = { task_id, title, goal, required_capabilities, priority, budget, deadline }   # summary only
  record nominated_at, round
  if no claim within nominate_ttl (default 120 s) and round < max_rounds (4): nominate(task, round+1)
  at max_rounds: publish to channel goal:<id> and topic cap:<capability>; if goal.auto_assign: assign (below)
```

`low`-priority tasks notify with `low` delivery priority (they do not wake suspended agents). **Assignment** (`claim` source `assignment`) is the scheduler claiming on behalf of an eligible idle agent: used when `claim_mode = assigned_only`, when `auto_assign` is set and nomination rounds are exhausted, and for human assignment. It is today's pool dispatch, generalised: `choosePoolAgent` becomes the scoring function above restricted to idle agents.

**Pull** (tools and API): `task.list(goal?, status?, capability?, claimable_by_me?, age_gt?, limit)` hits the partial index `tasks_available`; `goal.list(needs_attention)` returns goals that have available tasks with no claimant, are stalled, await evaluation, or await approval; `agent.find(capability, min_level?, available?)` returns identity, capability levels, idle/busy, load and verified-pass rate (never memory); `channel.history`.

**Blocked and abandoned work** is found through `task.list(status = blocked|available, age_gt = …)` and through `task.abandoned` events, which the goal owner and any subscriber to `goal:<id>` receive.

**Cost bounds.** A new available task costs at most `K × max_rounds` notification deliveries (each at most one wake), regardless of swarm size.

**Failure behaviour.** A lost nomination is harmless: the task stays `available` and the next round or any pull finds it. A nominated agent that is gone simply never claims.

## 6. Negotiation: offers, bids, help, handoff

**Principle.** Negotiation is messages with TTLs. The only authoritative outcomes are conditional updates. Waiting is never done while holding a lock or a lease that depends on a peer's answer.

| Mechanism | Who | Authoritative effect |
| --- | --- | --- |
| **Claim** | any eligible agent | T6, first writer wins. Default. |
| **Offer** (`task.offer(task, to, ttl)`) | goal owner on an `available` task; holder of a claimed task (handoff) | Target `accept` runs one transaction: for an `available` task it is a claim with source `offer`; for a held task it atomically sets `owner = target, fence = fence + 1`, supersedes the old owner claim and all non-owner claims. `decline` or TTL closes the offer. The offerer keeps ownership until acceptance, so there is never a gap or a double owner. |
| **Help request** (`task.request_help(task, role, capability, count, ttl)`) | holder | Nominates like [§5](#5-discovery); each `accept` creates a `contributor` or `reviewer` claim (capped by `max_participants`, default 4). The owner can `dismiss`. |
| **Bid** (`claim_mode = "bid"`) | any eligible agent | During `bid_window` (default 30 s) agents `task.bid(task, estimate, note)`; at close the runtime picks the best score ([§5](#5-discovery)); ties broken by `hash(task_id, agent)` so the result is deterministic and reproducible. Losers are notified. |

**Rules that prevent deadlock and livelock.**

1. **No wait-while-holding.** An agent that cannot continue without a peer's answer calls `task.block` and releases the lease; it does not sit on it.
2. **Every negotiation object has a TTL** and expiry restores the previous state.
3. **Ownership is single and transfers are atomic.**
4. An agent may have at most `max_open_offers` (5) pending offers or help requests.
5. **Circular help** (A asks B, B asks A) resolves because a request never blocks the requester's own work.
6. A task may be handed off at most `max_handoffs` (3) times; the next one returns it to `available` and notifies the goal owner.

**Content disagreement** (how to do the work, not who owns it): the owner decides inside the task. A contributor may attach a `dissent` note, which is recorded in task history and passed to verification as context. Disputes the owner cannot settle go to the goal owner, then an independent reviewer, then a human. The ladder is the only conflict-resolution mechanism; there is no voting engine.

**Multi-agent task ownership** (Question 4): **one owner, any number of participants** ([ADR 0001](../decisions/0001-hybrid-discovery-runtime-claims.md)). Only the owner submits. Participants post to the task channel and register artifacts attributed to themselves; the owner includes their outputs in the result and attribution is stored on the artifact. Splitting into subtasks is the default recommendation; participation is for tightly coupled work.

## 7. Team formation

A team is a scoped set of agents with a channel, a budget slice and a context pack. It exists because a goal or task benefits from it; most tasks have no team.

1. **Propose.** `team.propose({scope: goal|task, purpose, charter, roles: [{label, capability?, agent?, count}], min_members, form_by, budget_ask})`. The convener must be the task owner or a participant of the goal and hold `team.form`. The runtime checks: active teams per goal ≤ `max_teams` (3), `max_team_size` (8), per-agent concurrent memberships ≤ 2, and a budget carve-out from the scope. It creates the team in `forming` with channel `team:<id>`.
2. **Discover and invite.** Named agents get `team_invite`; capability roles are nominated by [§5](#5-discovery).
3. **Accept.** `team.join(team, label)` / `team.decline`. A join succeeds if the team is `forming`/`active`, not full, and the agent is eligible. Joining subscribes the agent to the channel and, for a task scope, creates a `contributor` claim. The team becomes `active` at `min_members` or on convener `activate`. At `form_by` with too few members the team is dissolved and the budget returned.
4. **Divide responsibility.** The charter records `responsibilities` per member in text. When the work separates cleanly the convener proposes **subtasks assigned to members** (`task.propose` with `assign_to`; the member's join is the consent). A shared task is for tightly coupled work only.
5. **Share context without a shared transcript.** The team **context pack** is: the charter; **team notes** (`memories` with `scope = team`: decisions, findings, open questions, each with provenance); the team's artifacts; and channel history by cursor. A session's context assembler includes the charter and a token-budgeted selection of notes ([agents-and-execution](../architecture/agents-and-execution.md#context-assembly)). Notes are periodically compacted by `team.digest` (a note that `supersedes` older ones; the older ones are kept). The channel is for conversation, the notes for what must be remembered.
6. **Disagree.** Same ladder as [§6](#6-negotiation-offers-bids-help-handoff). A *decision* is a note with `status: proposed | ratified | overruled`; the convener ratifies; any member may escalate.
7. **Dissolve.** On `team.dissolve` by the convener, on the scope reaching a terminal state, on `idle_dissolve` (24 h without activity), or when members fall below `min_members` for longer than a grace period. Participation claims are released; the budget remainder returns to the scope; the team record, channel history and notes are retained read-only. Notes worth keeping are **promoted** to goal knowledge with provenance, by the convener or by the dissolution job (default: notes marked `keep`).

**Failure behaviour.** A convener that vanishes: a member may take convener role by `team.convene` after the convener's session has been `abandoned` for a lease TTL; otherwise the team dissolves at `idle_dissolve`. Members that vanish lose their participation claim on lease expiry; the team continues if `min_members` holds.

## 8. Verification

Contracts are defined in [`domain-model.md` §7](domain-model.md#7-completion-is-four-different-claims). Protocol:

1. **The contract is fixed at acceptance (T2).** After acceptance only `supersede` changes it, so a producing agent cannot lower the bar it is judged by.
2. **On T12 the runtime creates one `verifications` row per check** and an internal job per deterministic check.
3. **Deterministic checks** run in a `VerifierAdapter` ([`interfaces.md`](interfaces.md)). An adapter that executes code (a test suite, a proof checker) runs it in a **separate verification execution** created from an immutable snapshot of the task's artifacts (by hash) and a declared image, not in the producer's sandbox. Result: `passed | failed | errored` with evidence refs.
4. **Review checks** create a `verify` task (`kind = verify`, parent = the task). It is claimable only by agents satisfying the check's independence rule (default: not the producer, not a participant, required capability); its input is the artifact snapshot, the rubric and the contract, **not the producer's transcript** unless `include_transcript` is set (reduces anchoring). Its output is a verdict envelope `{verdict: pass|fail|inconclusive, confidence 0..1, evidence_refs, findings[]}`. It has its own budget carved from the task's `verification_budget`, so verification can be neither starved nor unbounded.
5. **Quorum.** `quorum {n, pass}` runs `n` independent verify tasks; the check passes at `pass` passes. A check's confidence is the minimum over its passing verdicts.
6. **Inconclusive** follows `on_inconclusive`: one more reviewer, then a human check (an approval-center item). A required check left `inconclusive` never becomes `passed`.
7. **Aggregation.** T14 when every `required` check is `passed`; T15/T16 when any required check is `failed` (per `on_fail`). Findings are attached to the next attempt.
8. **No deterministic verifier exists** ([Question 15](../decisions/README.md)). The contract must still say what substitutes, and the confidence is capped: `independent_rederivation` (two isolated replicas, outputs compared by a comparator, with an LLM judge only as last resort); `evidence_audit` (every claim cites a stored source; a deterministic step fetches or re-hashes the sources, a reviewer judges support); `human_sample`. A check with `method: judgment` has `max_confidence` 0.7 unless corroborated by one of the others. A goal can require at least one non-LLM check (`require_non_llm_check`); otherwise a human approval is the final gate.
9. **Auditing the verifiers.** The runtime re-verifies a random sample of passed tasks with a different verifier and seeds known-bad **canary artifacts** into review queues; the false-accept rate per verifier and per capability is a metric ([`../architecture/observability-and-clients.md`](../architecture/observability-and-clients.md#metrics)).

**Failure behaviour.** A verifier that dies leaves a verify task that follows the ordinary lease protocol and is reassigned. A deterministic job that errors twice marks the check `errored`; `errored` blocks `verified` and raises an alert (it is not a pass and not a failure of the work).

## 9. Revision, dependency change and supersession

**Goal revision.** `goal.revise(expected_revision, new_text, new_criteria, reason)` → [domain model §4.1](domain-model.md#41-goal). On commit every non-terminal task of an older revision gets `stale_revision = true`. Effects: stale tasks cannot be *newly claimed*; a holder is messaged (`control: revision_changed`) and must `task.confirm_revision` (still valid, optionally with a revised contract through supersede) or `task.supersede`; a stale `submitted` task is not accepted (T12 guard). `reconcile_by` (default 2 h) after which unresolved stale tasks surface to the goal owner as `task.stale_unresolved`.

**Dependency changes** (scenario: dependencies change during execution). `task.add_dependency` / `task.remove_dependency` are allowed to the task owner or goal owner and re-run the acyclicity check (recursive CTE, depth bound 64) in the transaction.

| Change | Effect on a `running` task |
| --- | --- |
| New hard dependency, already satisfied | None. Recorded. |
| New hard dependency, not satisfied | `on_dep_change` on the task: `block` (default; T9 with `blocked_on dependency`) or `continue` (owner accepts the risk; the acceptance guard refuses submission until the dependency is satisfied). |
| An upstream task is superseded or reopened | Edge `satisfied = false`; downstream `available` tasks go back to `accepted` (T5); a running downstream task gets `control: input_changed` and its acceptance guard (inputs' producers not superseded) refuses submission until the owner re-confirms. |
| Upstream replaced by `{T'}` | If the supersede call said `rewire: true`, edges are rewritten to `T'` in the same transaction, else downstream tasks are flagged and the owner decides. |

**Supersession.** `task.supersede(task, replacements[])` is T19. Non-terminal descendants are *not* cascaded automatically; they are listed in the response and flagged `orphaned`, and the owner or a human cancels, re-parents or keeps them. Cascades are a choice, never a side effect.

**Plan change bundle.** `plan.change({supersede[], propose[], edges[]})` is applied atomically with a net budget check, under the goal's `acceptance_mode` for the bundle as a whole. This is how an agent replans without leaving the graph half-edited.

## 10. Goal evaluation

Trigger: the owner or an agent with grant calls `goal.request_evaluation`, or the runtime does when no non-terminal task remains. `evaluating`, then:

1. **Coverage (deterministic).** Acceptance criteria carry ids; tasks declare `satisfies: [criterion ids]`; each criterion needs at least one `verified` task, or direct evidence.
2. **Goal checks.** The goal's `acceptance` contract (same shape as a task contract) creates verification rows with `subject_kind = goal`; deterministic adapters, verify tasks and human checks run as in [§8](#8-verification), with independence excluding *every* agent that produced a task of the goal if `independence.strict` is set.
3. **Verdict** (`goal_evaluations`): `achieved` | `partially` | `not_achieved` | `inconclusive`, with `caveats` and `unmet_criteria`.
4. `achieved` → goal `achieved` (human approval first if `approval.final`). Otherwise the goal returns to `active` and the runtime proposes one low-priority `reconcile` task per unmet criterion (a mechanical gap listing, not planning), which any agent may claim or supersede.

## 11. Gateway invocation and approvals

In a conforming deployment the execution gateway is the only path for external reads (except immutable package mirrors), external writes and use of external-account credentials ([governance](../architecture/governance-and-resources.md#execution-gateway)). Sandboxes may contact only the Folie API, the configured model endpoint/proxy and immutable package mirrors under R-12.4. Local tools (file, bash, search) do not pass through the gateway; network egress is constrained by the trust profile.

```
invoke(principal, tool, args, idempotency_key?)                          # POST /v1/gateway/invoke
 1 authenticate principal; resolve session and task; reject if task claim is not active
   or fence is stale                                                      → 409 stale_fence
 2 resolve tool definition (id@version, risk_class, schema, idempotency); validate args → 400
 3 idempotency_key = given | sha256(task, tool, canonical(args), ordinal); existing row → return its state
 4 INSERT tool_invocations (state=requested)                              # write-ahead journal
 5 policy.evaluate(principal, delegation chain, action=tool.invoke, resource, risk_class, context)
      → deny: state=denied, ledger, return policy_denied (rule id)
      → require_approval: INSERT approvals(subject_hash = hash(task, tool, args)), state=pending_approval,
        return approval_required (agent continues or blocks; the gateway does not hold the connection)
      → allow(limits)
 6 budget.reserve(task|agent, estimated_cost)                             → 402 insufficient_budget
 7 state=authorized; re-check claim and fence ("at dispatch"); state=dispatched
 8 provider.invoke(ctx{ scoped short-lived credential, idempotency_key, deadline }, args)
 9 succeeded|failed → commit/release reservation, store redacted result_ref, ledger, return
   timeout or provider unknown → state=unknown → provider.reconcile(invocation) → reconciled_* | needs_human
```

**Approval.** An approval is bound to `(task, tool, args hash)`, single use, expiring (default 24 h). When it is `approved` and the requesting claim is **still active**, the gateway dispatches (step 7 onward) and delivers the result as an `approval_result` message that wakes the holder. If the claim ended meanwhile, the approval becomes `expired (claim_ended)` and the new owner must re-request; an approval never authorizes a different agent. While approvals are outstanding the holder may keep working or `task.block(approval)`, which suspends lease expiry until the approval's own expiry.

**Credentials.** Accounts (`ext:github/acct-7`) hold references into the vault; the provider receives a short-lived scoped credential at step 8. A credential never appears in a tool result, a transcript event, an env var or a span (results pass the tool's `redact` rules). Sandboxes hold no long-lived third-party credential.

**Idempotency and reconciliation** (Question 14). Tools declare `idempotency`: `natural` (repeat is harmless), `key` (the provider honours `idempotency_key`; the gateway passes it), or `none`. For `none`, an `unknown` outcome is never retried automatically: the adapter's `reconcile` queries external state; if it cannot decide, the invocation is `needs_human`. Tools that can be undone declare `compensate`; compensation is itself a gateway invocation with its own approval requirement.

**Revocation.** Bumping `credential_generation`, revoking a grant, or changing the policy version takes effect at the next step 1 or step 5 (≤ the 5 s cache). A `dispatched` invocation is not recalled; its provider may support `cancel`.

**Failure behaviour.** A gateway crash between 4 and 8 leaves a `requested|authorized|dispatched` row; startup recovery marks `dispatched` rows `unknown` and runs reconciliation. It never re-dispatches.

## 12. Budgets

Model: [`domain-model.md`](domain-model.md#5-logical-schema-illustrative-ddl) (`budgets`, `budget_reservations`, `usage_records`); one tree per dimension.

| Operation | Rule |
| --- | --- |
| **Carve-out** (delegation) | A child budget's limit is taken from the parent's headroom: `UPDATE parent SET reserved = reserved + $n WHERE limit_amount - reserved - spent >= $n`. A task's budget is carved from the goal's at acceptance (T2); a subtask's from its parent task's; a team's from its scope's; a verify task's from the task's `verification_budget`; a spawned agent's from the requester's ([§15](#15-capacity-requests)). `task.propose.budget_ask` exceeding the parent's headroom fails `insufficient_budget`. |
| **Reserve** | For a cost knowable in advance (a gateway call with a declared maximum, a model request's `max_tokens × price`): `reserved += n` on the leaf only if headroom allows. |
| **Commit** | Actual usage arrives as a `usage_record` (basis `measured`, `estimated` or `external_charge`): `spent += actual`, release the hold. Actual may exceed the hold (we learn the cost afterwards): the overrun is recorded, the budget flips `exhausted`, and `control: stop` is queued. |
| **Close** | When the owner scope ends: `parent.reserved -= child.limit; parent.spent += child.spent`. Unspent is thereby returned. |

**Evasion is closed structurally.** Spawning agents or delegating work requires a carve-out from the requester's own budget, so total spend is bounded by the root goal budget. Agents are created only through registration or a capacity grant ([§15](#15-capacity-requests); today they are created by any `send`, D2).

**Enforcement tiers.** Stated per dimension so no one over-claims:

| Tier | How | Overshoot bound | Applies to |
| --- | --- | --- | --- |
| **E0** record only | Usage is stored | unbounded | Today. |
| **E1** cooperative cutoff | The harness reports usage per turn (`usage` events); the server updates `spent` and, on exhaustion, queues `control: stop`; the shim cancels | one model turn plus one tool call | LLM tokens and cost (required); compute seconds; tool calls. |
| **E2** gateway-enforced | Pre-authorization at the choke point before the cost occurs | the reservation | Gateway tools; LLM spend once model calls pass through a Folie LLM proxy that holds the key ([ADR 0007](../decisions/0007-gateway-credentials-budgets.md)). |

**Estimated vs measured vs external.** `estimated` (catalog price × tokens, today's `cost.total`), `measured` (provider-reported usage or metered compute) and `external_charge` (a third-party invoice line reported by a tool adapter) are stored separately in `usage_records.basis`. Dashboards show them separately; enforcement uses the best available basis per dimension and the budget record says which.

## 13. Human intervention

Humans are principals, may hold claims, and use the same transitions as agents, so intervention cannot corrupt ownership or execution state.

| Action | Mechanism | What it guarantees | What it does not |
| --- | --- | --- | --- |
| **Message an agent or task channel** | normal or `urgent` delivery | Delivered; steered in at the next safe point (≤ ~1 s for `urgent` via the control watcher) | That the model acts on it |
| **Pause goal** | `goal.pause` → `hold` | No new claims (sub-second). Holders receive `control: pause`; those that do not release within `pause_grace` have their lease revoked (T8) | That an effect already dispatched stops |
| **Cancel task/goal** | T18, claims revoked with fence bump | Stale holder can never commit; gateway rejects its invocations at the next check | Rollback of anything it did |
| **Take over** | `task.revoke` then `assign human` (T8, T6 with fence + 1) | Agent writes rejected immediately; the human's writes are fenced the same way | Anything the agent's sandbox did |
| **Edit plan** | `plan.change` as a human principal (accepted immediately) | Atomic graph edit with budget check | — |
| **Approve / reject** | approval decision | Single use, bound to args, expiring | — |
| **Suspend / delete agent** | operator route → execution provider | Process frozen (suspend) or destroyed (delete); leases revoked; token invalid | That the provider acts instantly; external effects already made |
| **Revoke capability / grant** | revoke row | Next authorization decision (≤ 5 s) | Effects in flight |
| **Freeze swarm** | server mode `frozen` | Gateway denies everything, scheduler stops, no wakes, no claims; reads still work | Running sandboxes keep running |
| **Revoke egress** | delete the actor's egress policy (Substrate API) | The sandbox loses its network; the one control that works against a sandbox ignoring Folie | Immediate effect (Substrate propagation) |

**What a kill switch guarantees.** Stopping folie-server stops *new authorized* effects, new claims and wakes. It does **not** terminate a running sandbox process, cut full-trust egress, recall a dispatched call, or reverse an external effect. The mechanisms that act on a running sandbox are execution-provider `suspend`/`terminate` and egress revocation, each with a latency and a failure mode ([§14](#14-execution-lifecycle-loss-and-reconciliation)).

## 14. Execution lifecycle, loss and reconciliation

The **reconciler** (leader-only) compares three sets every pass: desired (agents needing an execution: unread deliveries, assigned tasks), recorded (`executions`), and actual (`provider.list()`; today there is no `ListTasks` call, D8).

| Observation | Action |
| --- | --- |
| Desired, none recorded or `terminated` | `provider.ensure` (create), grant egress per trust profile, mint token, retrace deliveries, `resume`. New `executions` row; `epoch` 1. |
| Desired, `suspended` | Grant egress (idempotent), `resume`; `epoch + 1`. |
| Recorded `running`, provider reports missing or `Failed` | Mark `lost` / `failed`. **Immediately** revoke the agent's leases (T8, `execution_lost`), mark its running session `abandoned` (returning leased deliveries), leave `dispatched` invocations `unknown` for reconciliation. Do not wait for the lease TTL. |
| Provider has an execution, no row | Orphan. Alert; terminate after `orphan_grace` (default 10 min) unless an operator adopts it. |
| Provider phase transitional | Look again next pass (as today). |
| Quiet `running` agent | `suspend` after `suspend_after` (as today). |
| Long-quiet `suspended` agent | Retire the *execution* after `delete_after`: requires `workspace.archived` when the agent's `workspace_policy` is `archive`; `scratch` (the default) retires without it. The agent identity stays `active`. |

**Recovery of a lost execution.** A new execution starts with the workspace restored from the latest provider checkpoint if one exists, else the last archive, else empty; the restore source is recorded (`workspaces.restored_from`) and an empty restore emits `workspace.memory_lost`. The agent's identity, memory service entries, claims and deliveries are untouched. The next session's context pack says the workspace was restored from an older state.

**Provider cancellation limits.** ax has no in-flight cancel and immutable tasks (ax `DESIGN.md:44`); cancellation is therefore Folie's: cooperative at the shim, forced by `suspend` or `terminate`. A provider that lies about success is bounded by the reconciler's actual-vs-recorded comparison on the next pass.

## 15. Capacity requests

**Decision ([ADR 0002](../decisions/0002-agents-request-capacity.md)): agents request capacity; they do not create agents.**

```
capacity.request({scope: goal|task, profile, count, reason, budget_ask, ttl})
  policy: grant capacity.request; swarm max_executions; goal max_agents; requester's carve-out >= budget_ask;
          profile exists (human-managed agent_profiles); spawn depth <= max_spawn_depth (2);
          requester's live descendants <= max_descendants (4)
  granted:  idle agents of the profile are assigned first (their next wake serves the scope);
            else new agents are registered from the profile (created_by = agent:<requester>, lineage recorded),
            budget carved from the requester, retire_at = ttl or scope end
  queued:   at a cap; retried by the scheduler as capacity frees
  denied:   policy_denied with the rule
```

New agents are ordinary principals with their own token, budget and grants (a subset of the requester's, never a superset: **grants delegate downward only**). Creating an agent by any other route (today: any `send` to an unknown name) is `404 unknown_agent`.

## 16. Progress, stall detection and runaway limits

**Stall and loop detectors** (deterministic; thresholds are goal-level policy, defaults shown):

| Signal | Default | Action |
| --- | --- | --- |
| Lease active, heartbeat `progress` counter unchanged | 15 min | `task.stalled` event, `system_notice` to holder and owner |
| Stalled and still unchanged | 60 min | Revoke lease (T8, `stalled`) |
| Same tool + same canonical args repeated | 8 consecutive | `loop_suspected` event, `control: stop` after 16 |
| Spend with no new artifact or verification result | 25 % of task budget | `task.burning` event, notice; at 60 % pause the task |
| Goal: no task reached `verified` in the window while spend exceeds the window's pace | 24 h or 20 % of goal budget | `goal.stalled` event; owner and operators notified; policy may auto-pause |
| Message ping-pong (≥ 20 messages between two agents on a channel with no artifact or state change) | 20 | notice to both and the goal owner; channel rate-limited |

An optional LLM reviewer may judge "meaningful progress" for operators, but no action depends on it.

**Runaway task-generation limits** (per goal; `quota_exceeded` when hit; raising them is an owner or human decision):

| Limit | Default |
| --- | --- |
| Max task depth | 4 |
| Max children per parent | 8 |
| Frontier WIP: non-terminal, unverified tasks per goal | 32 |
| Total tasks per goal | 500 |
| Proposals per agent per hour | 20 |
| Dedup | `dedup_key` unique index plus similarity warning; similar-above-threshold proposals need acceptance by the owner even under `auto` |
| Budget | A proposal that needs a carve-out the parent cannot give is rejected |

**Endless recursion** is closed by three independent mechanisms: depth cap, budget monotonically shrinking down the tree (a child's budget is a share of its parent's), and the frontier WIP cap, which forces agents to finish and verify work before generating more.
