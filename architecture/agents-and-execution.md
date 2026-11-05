# Agents, sessions, memory, harnesses and execution

Status: **target architecture**, with today's behaviour marked "today". Authority: [`../DESIGN.md`](../DESIGN.md) §7, §10, §12. Contracts: [`../spec/interfaces.md`](../spec/interfaces.md) §4–5. State: [`../spec/domain-model.md`](../spec/domain-model.md). Behaviour today: [`current-system.md`](current-system.md).

The organising rule: **six different things are six different records with six lifecycles.** Today several are one row (`agents.state` is an _execution_ state, `sessions` appears only at report time, memory is files in a sandbox that `DeleteTask` destroys).

| Concept        | Is                                                                      | Lifecycle                                                            | Stored in                                | Survives                                           |
| -------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| **Agent**      | a persistent participant: name, profile, config, grants, capabilities   | `active` ⇄ `paused` → `retired`                                      | `agents`                                 | everything below                                   |
| **Execution**  | one provider task/VM/container running the agent shim                   | `provisioning → running ⇄ suspended → terminated` (`failed`, `lost`) | `executions`                             | the agent                                          |
| **Workspace**  | the files visible at `/workspace`                                       | `active → archived → destroyed`                                      | provider + archive in the artifact store | suspend/resume; not execution loss unless archived |
| **Session**    | one bounded unit of reasoning: fresh context, one scope, one settlement | `running → settled \| abandoned`                                     | `sessions` + `session_events`            | forever (history), never as context                |
| **Task claim** | the agent's hold on a task                                              | `active → …`                                                         | `task_claims`                            | the session and the execution                      |
| **Memory**     | what the agent or swarm knows                                           | per entry                                                            | `memories`, artifacts                    | the workspace                                      |

## Identity

**What identity is.** The agent `name` (DNS-1123, the address `<atespace>/<name>` today) plus its `agents` row. It is independent of the process, session, harness, model, workspace and task assignment: model and harness are _configuration_ fetched per session ([below](#harness-and-model-switching)), not env baked into a task.

```json
{
  "name": "lit-review-3",
  "status": "active",
  "profile": {
    "description": "Reads and synthesises literature",
    "tags": ["research"]
  },
  "config": {
    "harness": "pi",
    "model": "anthropic/claude-sonnet-4-6",
    "trust_profile": "dev-full-trust",
    "workspace_policy": "scratch",
    "limits": { "concurrent_owner_claims": 1, "session_deadline_s": 21600 }
  },
  "owner": "human:saury",
  "created_by": "human:saury",
  "credential_generation": 0
}
```

**Lifecycle.**

| Step              | Rule                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Registration**  | `POST /v1/agents` by an operator, or by the runtime from an `agent_profile` when a capacity request is granted ([protocols §15](../spec/protocols.md#15-capacity-requests)). Today any `send`/`subscribe` to an unknown name creates the agent (D2); in the target that is `404 unknown_agent`. Pool agents (`agent-<n>`) are registered by the scheduler from the `default` profile, bounded by `max_executions`. |
| **Ownership**     | Every agent has an `owner` principal (human or the requesting agent). The owner's budget funds it; revoking the owner's grants cascades to descendants; an agent's grants never exceed its owner's.                                                                                                                                                                                                                |
| **Pause**         | `paused`: no claims, no wakes; mail accumulates. Operator or policy (for example repeated verification failures).                                                                                                                                                                                                                                                                                                  |
| **Retirement**    | `agent.retire`: pause, revoke tokens (generation bump), release claims (T8), settle or abandon the session, terminate the execution after archive. The `agents` row stays as a **tombstone**: the name is never reused, history keeps resolving.                                                                                                                                                                   |
| **Restoration**   | An admin can reactivate a retired identity: new credential generation, memory-service entries intact, workspace from the last archive if one exists. Reactivation is a ledger event, never an automatic effect of mail.                                                                                                                                                                                            |
| **Participation** | Derived, not stored: the goals an agent has claims, team memberships or subscriptions in (`goal_participants` is a view). Participation gives channel visibility, not authority; authority is grants.                                                                                                                                                                                                              |

**Reputation** is a view over verification results per (agent, capability) ([integration](integration.md#capabilities)), never a stored self-description.

## Sessions

**Today (kept).** A session is bounded: one scope, an empty conversation, one settlement; memory is not chat history (Invariant 4, Decision 11). What changes is that sessions become first-class records and gain hard limits and cancellation.

**Creation.** The shim picks the oldest eligible delivery (priority first), derives the scope (`task:<id>` when the delivery belongs to a task the agent holds, else `mail:<delivery id>`), calls `POST /v1/sessions`, receives the session id, the epoch and the **context pack**, and starts the harness. The server writes the `sessions` row **at start** (today at report: D6), so a crashed session is visible as `running` until the runtime marks it `abandoned`.

**Rescope.** A `mail:` session (for example one woken by a `task_available` notification) that claims a task is rescoped to `task:<id>` once (`POST /v1/sessions/:id/rescope`, transcript event `rescope`). This avoids a second wake and a context-free restart for a decision that took one tool call. A session never serves two tasks.

**Resumption** has no meaning for conversations (they are disposable). It means: _a new session on the same scope, with a context pack that reconstructs what matters._ The pack contains the task, the contract, the latest handoff note, findings from earlier attempts and verification, the interrupted-call notice (today's `attemptNotice`) and memory retrievals ([context assembly](#context-assembly)). **Same-claim continuation:** a `task:` session that ends with outcome `yielded` (the model decided it is out of room and wrote a handoff note via `memory_write(kind: handoff)`) keeps its claim; the shim opens a continuation session from the same claim. A `task:` session that ends `done` without `task_submit` is treated as `yielded` with a warning, never as completion.

**Limits (new).** Session deadline (default 6 h, shim-enforced), turn cap, and a usage budget (E1 cutoff, [`governance-and-resources.md`](governance-and-resources.md#enforcement-tiers)). A limit reached settles the session `cancelled` (reason `limit`), which the task treats like a yield.

**Termination.** `settled` (report/submit/yield recorded, deliveries acked), `abandoned` (execution ended or a new session began without settlement; leased deliveries return to `pending`), `cancelled` (control signal; partial usage recorded; in-flight `never` calls marked `interrupted`).

**Transcript persistence.** `session_events` (today) stays append-only, idempotent per `(session, seq)`, best-effort with known gaps, ≤ 64 KiB per event. Added: `rescope`, `usage` (per turn, so spend survives a crash, D11), `control`, `context` (the pack's hash). **Retention** is a policy (default: full events 30 days, then a summary row per session; reports and the ledger forever). The transcript is evidence and a debugging record; it is **never** replayed into a model as memory.

**Session ↔ execution ↔ task association.** `sessions.execution_id` + `epoch` tie a session to the process tree that ran it; `task_id` ties it to the claim; the shim attaches `task_id` and `fence` to every mutating call, which is how a session that outlives its claim is rejected.

**Session migration across harnesses.** Not live (a harness's in-process state is not portable). Between sessions it is free, because everything a session needs is in the context pack and memory, none of it in a harness format ([below](#harness-and-model-switching)). An exported `snapshot` is an optional harness feature used only to resume the _same_ harness after an interruption.

## Memory

**Problem.** An ever-growing transcript is not memory, and files in a destroyable sandbox are not durable. Memory needs provenance, scope, contradiction handling and access control.

**Layers** (the transcript is deliberately not one of them):

| Layer                   | What                                                                         | Scope / owner                                             | Store                                       | Lifetime                         |
| ----------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- | -------------------------------- |
| **Working context**     | what one session sees                                                        | the session                                               | the context pack (stored by hash for audit) | the session                      |
| **Agent memory**        | skills, preferences, lessons, notes about how to work; semantic and episodic | `agent`, owner-only                                       | `memories`                                  | the agent's life                 |
| **Task notes**          | handoff and attempt notes                                                    | `goal` plus `task_id` (visible only to goal participants) | `memories`                                  | the task, archived with the goal |
| **Team notes**          | decisions, findings, open questions of a team                                | `team`, members                                           | `memories`                                  | the team, promotable             |
| **Goal knowledge**      | claims, findings and sources about _this_ objective                          | `goal`, participants                                      | `memories` (`kind: claim`) + artifacts      | the goal, archived with it       |
| **Swarm knowledge**     | verified, reusable facts and procedures                                      | `swarm`, all principals with `memory.read:swarm`          | `memories`                                  | indefinite, with review          |
| **Artifacts**           | files, datasets, reports, proofs                                             | goal/task, immutable                                      | artifact store                              | per retention                    |
| **External references** | URLs, repositories, accounts                                                 | by id in `memories.data`                                  | —                                           | —                                |

**Boundary between persistent memory and goal-specific knowledge** (Question 10). _Agent memory is about the agent; goal knowledge is about the world of one goal._ An entry written during goal G defaults to `scope = goal, scope_id = G`. Writing to agent scope is an explicit choice, and an agent-scope entry carries `origin_goal_id`; **cross-goal retrieval returns only agent-scope entries marked `portable`**, set by the author at write time or by a post-goal consolidation session. A goal-scope entry is never retrieved outside its goal, which is the contamination boundary. Moving knowledge up a scope is `memory.promote`, which needs provenance, and for swarm scope needs a passed verification or a human approval.

**Provenance and contradiction.** Every entry stores `provenance` (source events, artifacts, sessions, tasks, external URLs with retrieval hash) and `confidence`. Entries are immutable. A new entry that conflicts with an existing one writes a `contradicts` link and sets both `status = contested`; the runtime then proposes a `reconcile` task for the goal (a mechanical consequence, not agent initiative). Resolution is a new entry that `supersedes` the loser, with evidence. Retrieval returns `contested` entries marked as such; it never silently picks one.

**Access control** (enforced in `MemoryStore.query`, no unfiltered read exists): agent scope is owner-only (other agents read it only through an explicit `memory.share`); goal and task scope require goal participation; team scope requires membership; swarm scope requires the grant; operators with `viewer` see all, and reads are ledgered.

**Retrieval** is by scope-filtered full-text search ranked by recency and `confidence`, bounded by a token budget. Vector retrieval is excluded from this specification (OQ4). **Update**: `memory_write` during a session; a consolidation session at goal end proposes promotions and portability.

## Context assembly

The runtime builds the **context pack** the harness receives ([`SessionStart.context`](../spec/interfaces.md#4-harness)). It is harness-neutral text and structured references; each harness renders it into its own prompt format.

```
assemble(agent, scope, budget = min(12k tokens, 15% of the model window)):
  fixed (always, ≈ 2k): agent one-liner, current goal revision summary + acceptance criteria + constraints and
        exclusions, the task spec + contract, limits, the interrupted-call notice, the session scope rules
  1: findings attached to this task (earlier attempts, verification feedback, dissent notes), latest handoff note,
     team charter and latest team digest
  2: memory retrievals: goal knowledge relevant to the task text and inputs; agent memory (portable or this goal)
  3: upstream outputs: for each `informs`/`hard` dependency, the artifact names, hashes, descriptions and summaries
     (bytes are fetched on demand by `artifact_get`, never inlined)
  4: a digest of the task channel's recent history
  fill by priority until the budget; every item carries a source id; overflow is truncated by priority, never silently
  store the pack (hash) so the session is auditable and reproducible
```

Priorities, budget and ranking are configuration, not code branches, so they can be tuned against the evaluation suite ([`../DESIGN.md` §23](../DESIGN.md#23-testing-and-evaluation)).

## Harness and model switching

**Question 11.** Identity and context survive a switch because neither is in the harness.

- `agents.config` names the harness and model. The shim fetches it at **each session start** (`GET /v1/agents/me/config`), so changing it needs no new execution. (Today `FOLIE_RUNTIME`/`FOLIE_MODEL` are env at `CreateTask`, and ax tasks are immutable, so a change means recreating the agent's task: D8-adjacent.) Only the token, server URL and agent name stay in env.
- A harness that is not in the image cannot be selected: the image is part of the execution spec, so installing a new harness is a new image and, for existing agents, a retire-and-recreate. Capabilities in the descriptor tell the runtime what the harness can do (a harness without `deliver` simply gets its urgent mail at session boundaries).
- Useful context carries over because it is memory, notes, artifacts and the pack, all stored by Folie in neutral form. What does _not_ carry over: provider-specific hidden state (prompt caches, reasoning tokens), which is lost and was never relied on.
- Switching mid-session is unsupported by design.

## New executions and the authenticated migration

A workspace is created only when an execution starts: pool dispatch or explicit registration → `CreateTask` (or provider start) → the provider allocates `/workspace`, initially empty; resume and recovery fill it from a provider checkpoint, an archive, or nothing (table above). No server code creates, snapshots or deletes workspace bytes; the lifecycle above is the contract.

**Operator migration prerequisite (upgrade to authenticated identity).** Existing agent tasks predate bearer tokens and are immutable: retrofitting credentials requires recreating each agent's task. A task created with _no bound workspace_ loses its `/workspace` on recreation (verified against ax: only task-local empty-dir workspaces are destroyed; `DeleteTask` does not touch a bound Workspace resource). The execution adapter now binds every new agent to a durable provider workspace `<key>-ws` that survives task recreation, so agents created after this upgrade never lose files to recreation. Therefore, for each live agent with valuable `/workspace` content, the operator MUST — before upgrading — either `artifact_put` the important outputs to the artifact store, run `memory_write` entries, or take an operator-managed copy of the workspace before the old task is deleted. This upgrade must not proceed silently: recreating an existing unbound task destroys workspace data irreversibly, so it is a destructive action needing explicit operator sign-off. If a live deployment holds workspace data that would be destroyed and cannot be archived first, stop and surface the risk for an explicit operator decision; any claims about preserving workspace data would be false without that step. New executions after the upgrade are unaffected: they receive tokens at start, and the authentication implementation is fail-closed (no unauthenticated fallback).

## Workspace and checkpoint lifecycle

**What survives what** is the table every operator and every agent author needs. Today's behaviour is in the "today" column; the target changes the last two rows.

| Event                            | `/workspace`                                                                                                                     | Memory service, artifacts, ledger | Claims                   | Today                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------ | ---------------------------------------------------- |
| Session ends                     | kept                                                                                                                             | kept                              | kept                     | same                                                 |
| Idle suspend → resume            | restored from the provider checkpoint (same files, new process tree)                                                             | kept                              | kept                     | same                                                 |
| Execution `lost` / `failed`      | restored from the last checkpoint if the provider has one, else the last archive, else **empty** (`workspace.memory_lost` event) | kept                              | revoked immediately (T8) | not detected beyond `Failed` phase for a known agent |
| Execution retired (`DeleteTask`) | **destroyed** unless `archived`                                                                                                  | kept                              | none (agent idle)        | destroyed; "retirement is forgetting"                |
| Agent retired                    | archived then destroyed                                                                                                          | kept (tombstone)                  | released                 | n/a                                                  |

**Durable by design.** The rule agents follow, stated in their prompt and enforced by tooling: _anything that must outlive the workspace is `artifact_put` (bytes upload, content-addressed) or `memory_write`._ `artifact_put` replaces today's `artifact_register`, which stores only a hash and path while the bytes stay in a directory ax can delete (Decision 16, a known cost). With bytes in the artifact store, retirement no longer loses outputs.

**Archive.** `workspace.archive`: the shim tars `/workspace` (ignore patterns, size cap) and uploads it as an artifact; the workspace becomes `archived`. Each agent has a `workspace_policy`: `archive` (the reconciler requires `archived` before `terminate(destroyWorkspace)`) or `scratch` (**the default**: the workspace is disposable, and the rule that important outputs are `artifact_put` or `memory_write` is what protects them). **Open limit:** a _suspended_ execution has no running shim to archive, and resuming it just to archive costs a wake, so `archive` is best-effort (archive at session end when the quiet period begins) and an `archive` agent whose archive is missing is not retired but flagged to operators. Reading the checkpoint from the provider if ax or Substrate expose it is not verified. This is [OQ2](../decisions/README.md#open-architectural-questions).

**Checkpointing** is the provider's `suspend`. ax offers no other checkpoint and no in-flight snapshot. Folie therefore does not promise point-in-time recovery of a running execution: recovery is by session boundary (bounded sessions, journal, idempotency keys), which is the design's existing answer.

**Resource reclamation.** Idle suspend (today), retire gated on archive, quarantined artifacts deleted after `quarantine_ttl`, stale executions past `max_execution_age` recycled at a session boundary, orphans terminated after `orphan_grace`, storage as a budget dimension.

**Timeouts, layered.** Model request (harness), tool call (`ToolDefinition.timeoutMs`, enforced by `host.tools.call` via the abort signal), session (shim deadline), task lease (server), execution age (reconciler). No single layer is trusted alone.

## Execution provider boundary

What belongs to AX and what to Folie (Question 12 and the boundary the requirement asks for):

| Responsibility                        | AX/Substrate                                              | Folie                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Isolation, resource enforcement       | container sandbox; limits via `ResourcesSpec`             | sets `resources` (today it does not, D8)                                                                              |
| Network egress                        | Substrate `EgressPolicy`, HTTP(S) only                    | decides the profile per agent ([governance](governance-and-resources.md#trust-profiles))                              |
| Checkpoint and resume of `/workspace` | yes                                                       | decides when, gates deletion on archive                                                                               |
| Task TTL, restart policy, spend caps  | none                                                      | all of it                                                                                                             |
| Cancellation of a running process     | SIGTERM to PID 1 on suspend/stop; no in-flight cancel API | cooperative cancel at the shim, then `suspend`/`terminate`                                                            |
| Task mutability                       | immutable                                                 | per-session config fetch; credentials by token generation                                                             |
| Listing                               | `ListTasks`                                               | reconciler uses it for orphan and ghost detection (new)                                                               |
| Execution loss                        | does not notify                                           | detects by comparison and acts ([protocols §14](../spec/protocols.md#14-execution-lifecycle-loss-and-reconciliation)) |

**Provider replacement.** The domain, the app layer and the agent shim see `ExecutionProvider` and `ProviderRef` only. A new provider implements the interface and the contract suite; capabilities it lacks (suspend, network allowlist, listing) are declared, and the reconciler plans without them. One provider per swarm is required; coexistence of several (`agents.config.provider`) is excluded from this specification.

## Requirements

Required: R-1 (principals), R-2.5 (cancel), R-3.1–3.6 (separate lifecycles, session at start, scope and rescope, limits, yield, per-session config), R-4.1–4.5 (scoped memory, provenance and contradictions, portability boundary, artifact bytes, context pack), R-5.1–5.4 (harness contract and conformance), R-6.1–6.6 (provider port, reconciliation, loss recovery, retirement gate, leader election), R-15.1–15.3 (correlation and propagation).

Not required: out-of-process harnesses, harness `snapshot`, embeddings, the swarm-scope memory promotion workflow, several execution providers per swarm, a workspace archive for suspended executions beyond the best-effort approach above, cross-agent memory sharing beyond explicit `memory.share` (all listed in [requirements §3](../spec/requirements.md#3-excluded-from-this-specification)).

## Tests

Harness conformance suite with `echo` and `pi` (cancel mid-tool, `deliver` at a boundary, usage totals); `ExecutionProvider` suite against an in-memory fake and one live smoke; reconciler scenarios (ghost, orphan, lost execution revokes leases immediately); session `abandoned` returns leased deliveries; memory ACL matrix (every scope × principal kind); contamination test (goal-scope entry never retrieved by a task of another goal); context assembly budget test (priority truncation is deterministic).
