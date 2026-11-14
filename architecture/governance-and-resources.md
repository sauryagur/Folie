# Governance, safety, scheduling and resources

> **Historical target document:** This page describes the previous design and is retained for migration context. Its requirements and links to the old specs are not current mandates. See the [architecture reset proposal](../docs/architecture/README.md) for the current direction and [as-built snapshot](current-system.md) for implementation notes.

Historical status: target architecture at the time of writing.

Principle: **a model's output is a request, never an authorization.** Nothing an agent says, reasons or is prompted to do changes what it is allowed to do. Authority comes from grants held by authenticated principals, evaluated by deterministic code outside the sandbox.

## Trust profiles

The prototype's full-trust decision (Decision 6) is kept as one named profile and stops being the only one. A profile is a per-agent (default per-swarm) setting that the execution provider adapter turns into a network policy and the gateway uses as a policy input.

| Profile                                  | Sandbox egress                                                                     | External effects                                                                 | Credentials in sandbox                                        | Use                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `dev-full-trust` (**today's behaviour**) | any hostname on web ports (`*` on 80, 8080, 443)                                   | anything the sandbox can reach, unmediated                                       | test-only model key and agent token                           | Explicitly nonconforming development only; never for a conforming deployment |
| `restricted`                             | Folie API, configured model endpoint/proxy and immutable read-only package mirrors | external reads (except package mirrors), writes and accounts through the gateway | agent token; model key only under a recorded R-12.5 deviation | Conforming profile for ordinary use                                          |
| `gateway-only`                           | Folie API and model proxy only                                                     | all external reads and writes through the gateway                                | agent token only                                              | Conforming profile for sensitive environments                                |

**What full trust costs, stated plainly.** In `dev-full-trust` a prompt-injected or malfunctioning agent can exfiltrate any data it can read to any web host, spend the LLM key without limit, and act on any external system whose credentials appear in its environment or files. Folie's controls there are after-the-fact (audit, delete, suspend, rotate). This profile is explicitly nonconforming and MUST NOT be used for a deployment claiming this specification. Conforming deployments MUST select `restricted` or `gateway-only` and MUST provide no external account credential directly to a sandbox (R-12.4–12.8).

**Mechanics and limits.** Profiles map to Substrate `EgressPolicy` rules (hostname patterns on HTTP and TLS-passthrough ports). A conforming sandbox can reach only Folie, its configured model endpoint (or proxy) and immutable package mirrors; its network policy denies all other direct destinations. Package mirrors MUST be immutable/read-only. Substrate filters only web ports and does not yet filter private destinations (Substrate #2086), so named rules or an explicit in-cluster exception are required to reach `folie-server.folie.svc` ([egress notes](current-system.md#sandbox-egress-a-substrate-dependency)). Re-test on every Substrate bump. ax issue #449 would simplify this.

## Authority model

| Concept        | Meaning                                                                                                                 | Created by                                                                        | Notes                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Principal**  | an authenticated agent execution, human, system component or extension                                                  | credential issuance                                                               | Identity comes only from the token ([protocols §1](../spec/protocols.md#1-authentication-and-the-request-envelope))                                |
| **Grant**      | positive authorization: `(principal, action, resource pattern, limits, expiry)`                                         | a human, or a principal delegating a subset of what it holds, flagged `delegable` | Delegation is downward only; a grant never exceeds its source; revoking a source revokes descendants; an agent can never create a grant for itself |
| **Policy**     | constraint or obligation that applies regardless of grants: risk-class rules, approval requirements, prohibitions, caps | humans with `admin`                                                               | Versioned; each decision records the version                                                                                                       |
| **Capability** | competence (what the agent can meaningfully do)                                                                         | assessment and track record                                                       | Not authority ([integration](integration.md#capabilities))                                                                                         |
| **Approval**   | a human (or designated approver) decision about one specific action                                                     | the gateway, on a `require_approval` decision                                     | Single use, bound to `(task, tool, args hash)`, expiring                                                                                           |

**Decision procedure** (`PolicyEngine.evaluate`, a pure function): explicit `deny` wins; otherwise `require_approval` if any applicable rule demands it; otherwise `allow` if some grant covers `(action, resource)` within its limits; otherwise `deny` for gateway actions. Inside the sandbox under `dev-full-trust` the default is `allow` for sandbox-local tools. **Fail closed:** an engine error is a denial, and the failure is a metric.

**Scoping** — one grant model across all subjects:

| Subject                     | Examples of `action` / `resource`                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Agents                      | `agent.pause` on `agent:*`; `capacity.request` on `profile:researcher`                         |
| Goals                       | `goal.create`; `task.propose` on `goal:42`; `task.claim` on `goal:42`                          |
| Tasks                       | `task.cancel` on `task:*` where `goal.owner = self`                                            |
| Tools                       | `tool.invoke` on `github.pr.read@1`; with `limits: {repos: ["org/a"], max_calls_per_day: 50}`  |
| Resources and files         | `artifact.read` on `goal:42`; `memory.read` on `swarm`                                         |
| External accounts           | `credential.use` on `account:github/org-a` (gateway only; the agent never sees the credential) |
| Integrations and extensions | `event.read` on `goal:*` (a subscriber); `extension.enable`                                    |
| Execution environments      | `execution.start` on `profile:gpu`; trust profile selection                                    |

**Temporary permissions** are grants with `expires_at` and, optionally, a task binding (`bound_task`) so they die with the claim. **Least privilege by default:** a new agent holds only the baseline grants of its profile (read its own goals, message, claim eligible tasks, call its profile's tools).

**Requests for more authority** (an agent that needs a tool it lacks) are a `grant.request` that creates an approval. The model can ask; only an approver can answer.

**Hard prohibitions** (code invariants, not policy a human can toggle by accident): an agent cannot create, modify or delete grants, policies, budgets or credentials; cannot read credentials; cannot disable the ledger or the gateway; cannot exceed its root budget; and R7 actions are refused without a valid safety attestation ([below](#physical-world-execution)).

## Risk classification

Classification is a property of the **tool definition** (and of the specific arguments where it varies), set by whoever registers the tool and reviewed at approval; an agent cannot lower it. The runtime evaluates the _higher_ of the declared class and what the arguments imply.

| Class                            | Description                                             | Examples                                                 | Default autonomy (profile `restricted`)                                                                                                                         |
| -------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0** read-only                 | No external effect                                      | read workspace, search the public web, query Folie state | Autonomous                                                                                                                                                      |
| **R1** reversible local          | Effects confined to the sandbox                         | write files, run scripts, `bash` in sandbox              | Autonomous                                                                                                                                                      |
| **R2** external read             | Reads from an authenticated external system             | private repo, CRM, mailbox                               | Autonomous with grant; logged; **`sensitive` data raises to approval or restricts onward use**                                                                  |
| **R3** reversible external write | Idempotent or easily undone                             | open a draft PR, comment, create a branch, add a card    | Autonomous with grant, budget and rate limit; audited                                                                                                           |
| **R4** commitment                | Financial, contractual or hard-to-retract communication | send an email, place an order, sign, publish             | **Approval required**; spend caps; compensation declared where possible                                                                                         |
| **R5** destructive               | Data loss or irreversible deletion                      | delete records, force-push, drop a table                 | **Approval required**, with a dry-run diff attached; two approvers for production data                                                                          |
| **R6** production infrastructure | Changes a live system                                   | deploy, scale, change DNS/IAM                            | **Approval required**; change window; post-change verification (health check) required to settle; rollback plan in the request                                  |
| **R7** physical                  | Moves matter or energy                                  | actuators, machinery                                     | **Prohibited from the gateway** unless the device provider presents a valid safety attestation ([below](#physical-world-execution)); never autonomous; excluded |

`sensitive_data` is an orthogonal flag (personal data, credentials-adjacent, confidential): it blocks egress of the flagged data to any R3+ tool without approval and is part of the audit record. **Prohibited by policy** regardless of grants: exfiltrating credentials, acting outside the task's goal scope, circumventing the gateway, and anything in the hard-prohibition list above.

## Execution gateway

In a conforming deployment the gateway is the only path for external writes and use of external-account credentials. Read-only model and fetch traffic may use the explicitly allowlisted endpoints in R-12.4; all other sandbox egress is denied. Protocol: [protocols §11](../spec/protocols.md#11-gateway-invocation-and-approvals). Responsibilities and why each is here:

| Responsibility         | Mechanism                                                                                     | Closes                                    |
| ---------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Identity and scope     | principal from the token; claim and fence verified at call and re-verified at dispatch        | impersonation, stale holders              |
| Typed, validated calls | JSON Schema input validation; versioned `ToolDefinition`                                      | model-fabricated arguments                |
| Policy                 | `PolicyEngine.evaluate` with the delegation chain, risk class, trust profile, budget headroom | unauthorized and over-broad actions       |
| Approval               | single-use, bound to args hash, expiring; holder not blocked on the HTTP call                 | irreversible actions without a human      |
| Budget                 | reserve before dispatch, commit actual after                                                  | spend overrun (E2)                        |
| Credentials            | vault reference; short-lived scoped credential given to the provider only                     | long-lived secrets in sandboxes           |
| Idempotency            | deterministic key, passed to the provider where honoured                                      | duplicate effects on retry or replay      |
| Journal                | write-ahead row before dispatch; states through `reconciled_*`                                | lost or unknown outcomes                  |
| Reconciliation         | provider `reconcile`, human on `indeterminate`                                                | uncertain external state                  |
| Audit                  | invocation row, decision with policy version, ledger event, trace                             | unattributable actions                    |
| Revocation             | generation and grant changes take effect at the next evaluation (≤ 5 s)                       | continued access after a decision to stop |
| Failure handling       | crash recovery marks `dispatched` as `unknown` and reconciles; never re-dispatches            | double execution                          |

**Credentials and accounts.** An **account** is a named external identity (`github/org-a`) whose secret lives in the vault (interim: envelope-encrypted columns with a master key from a Kubernetes Secret; later a KMS). Accounts have owners, allowed tools and allowed goals. The vault returns a credential only to a `ToolProvider.invoke` in the gateway process or an out-of-process provider over mTLS, scoped and time-limited where the target supports it (OAuth downscoping, short-lived tokens). **The LLM key is the one long-lived secret still in the sandbox** under `dev-full-trust` and `restricted`; the LLM proxy ([ADR 0007](../decisions/0007-gateway-credentials-budgets.md)) removes it and gives model spend an enforcement point.

## Human oversight and the kill switch

Operations and their guarantees are tabulated in [protocols §13](../spec/protocols.md#13-human-intervention). The architectural statements:

- Humans are principals and may hold claims; intervention uses the same fenced transitions as agents, so it cannot corrupt ownership.
- **Stopping folie-server is not a kill switch.** It halts new authorized effects, claims and wakes. It does not terminate running processes, cut full-trust egress, recall dispatched calls, or reverse external effects. Operators must not rely on it as one, and the TUI must not present it as one.
- What does act on a running sandbox: `suspend`/`terminate` through the execution provider (seconds, can fail), egress revocation (Substrate API, propagation delay), and credential revocation (≤ 5 s for Folie access; the LLM key needs the proxy or rotation plus recreation).
- **Freeze** (`swarm.freeze`) is the operator's first move: gateway denies all, scheduler stops, no wakes, claims not renewed. It is instantaneous for Folie-controlled paths and says nothing about what sandboxes already running do.
- Every oversight action is a ledger event with the human principal.

## Physical-world execution

Excluded from this specification. Stated so that nothing here forecloses it:

1. **An LLM is never the final safety authority for an actuator.** Deterministic interlocks, emergency stops, physical operating limits and an independent safety controller live **outside** agent reasoning and outside Folie's control path.
2. **Folie sends requests, not commands to hardware.** A physical `ToolProvider` (kind `device`) forwards a _setpoint request_ to the device's safety controller, which validates it against its own limits and may refuse. The controller is the actuation authority.
3. **Loss of Folie must fail safe.** A stopped server, a lost heartbeat or a revoked lease puts the controller in its safe state by its own watchdog, not by Folie sending a stop.
4. **R7 calls require** a valid `safety_attestation` from the controller (current state, limits, e-stop status) within a short validity window, an explicit human enablement for the session, and verification by **independent sensor feedback** confirmed by the controller before a task can settle.
5. Verification of physical outcomes never accepts an agent's report; it needs sensor evidence the agent cannot write.
6. Hazard analysis, applicable standards and a safety case are prerequisites to enabling a device provider; they are outside this document and outside any LLM.

## Resources

### Budgets

Model, dimensions and operations: [protocols §12](../spec/protocols.md#12-budgets), [domain model](../spec/domain-model.md#5-logical-schema-illustrative-ddl). Summary: hierarchical per dimension; delegation is a carve-out from the parent's headroom (so total spend is bounded by the root); reservations pre-authorize known costs; actual usage commits and may overrun; closing returns the unspent.

**Allocation.** A human sets the goal budget (the goal cannot become `active` in a governed profile without one; the dev profile applies the swarm default). Task budgets are carved at acceptance; the `budget_ask` on a proposal is the proposer's estimate; an owner or a policy default fills it if absent. Agent-level quotas (daily cost, concurrent executions, messages per minute) are independent limits on the principal, so an agent cannot evade them by hopping goals.

### Enforcement tiers

| Tier                      | Mechanism                                                                                 | Overshoot bound          | Required for                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| **E0** record only        | usage stored                                                                              | unbounded                | not acceptable; today's behaviour                            |
| **E1** cooperative cutoff | per-turn usage events update `spent`; exhaustion queues `control: stop`; the shim cancels | one turn + one tool call | R-13.3: LLM tokens, compute seconds, tool calls              |
| **E2** gateway-enforced   | reserve before the cost occurs at a choke point we control                                | the reservation          | R-13.3: gateway tools; model spend once the LLM proxy exists |

The documents never say "budget enforced" without saying which tier. **LLM spend is only as enforceable as the path to the model**: until the LLM proxy exists, a determined agent in `dev-full-trust` holding the key can spend outside the budget, and the budget catches only honest harness-reported usage.

### Quotas, fairness and backpressure

| Control                        | Default                                                                                  | Effect                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `max_executions` (swarm)       | `FOLIE_MAX_AGENTS` (8)                                                                   | wakes beyond it queue; deliveries wait                          |
| `max_concurrent_claims` (goal) | 4                                                                                        | extra tasks stay `available`                                    |
| per-agent concurrency          | 1 owner claim                                                                            | one session at a time                                           |
| proposals, messages, fan-out   | [protocols §2, §16](../spec/protocols.md#16-progress-stall-detection-and-runaway-limits) | `429 quota_exceeded`                                            |
| `max_wakes_per_pass`           | 4                                                                                        | bounds sandbox creation bursts (each create is slow and costly) |

**Fairness**: nomination and assignment scores include an aging term per goal (`wait_time / goal_weight`), so a low-priority goal is not starved forever and a high-priority one gets proportionally more, without preemption. **Backpressure** is structural: when caps bind, tasks simply remain `available`, proposals are throttled, and wake demand queues; nothing is dropped.

### Scheduling

The scheduler is a **pure scoring function plus the nomination and assignment steps** in [protocols §5](../spec/protocols.md#5-discovery), not a global optimizer. Inputs: agent availability and warmth (running before suspended before none, today's `choosePoolAgent` ordering), capability level, affinity (worked on this goal or parent), load, task priority, goal weight and age, and constraints (budget headroom, concurrency, grants, goal hold). It is deterministic (stable tie-break by hash) so it is unit-testable and its decisions are reproducible from the ledger.

Excluded: preemption of running claims (humans and policy can revoke; the scheduler does not), cost-aware bin packing, predictive scaling, cross-goal gang scheduling, multi-node placement.

**Idle suspension and reclamation** are today's controller behaviour (suspend after quiet, retire after longer quiet) with the retire gate on archive ([agents-and-execution](agents-and-execution.md#workspace-and-checkpoint-lifecycle)).

## Audit

Three independent records: the **ledger** (what happened and who decided), `tool_invocations` and `approvals` (what was requested, decided and executed, with policy version and args hash), and `session_events` (what the agent saw and did). Traces correlate them ([observability](observability-and-clients.md)) but are not evidence. Audit rows are append-only at the database role level (no `UPDATE`/`DELETE` for the application role on ledger tables; a trigger rejects them). Tamper-evidence against a database administrator (hash chain, external anchoring) is [OQ6](../decisions/README.md#open-architectural-questions): not claimed.

## Threat model

| Threat                                   | Control                                                                              | Residual risk                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Forged identity (D1)                     | per-execution tokens; principal from the token only                                  | Token theft inside a sandbox impersonates that agent only, until revocation (≤ 5 s) |
| Unbounded agent creation (D2)            | registration and capacity grants only; spawn depth and descendant caps               | None within the root budget                                                         |
| Stale or duplicate holder                | fencing on every write, gateway re-check at dispatch                                 | Effects dispatched by sandbox-local tools before revocation are unrecoverable       |
| Prompt injection → harmful tool use      | gateway policy and approvals; least-privilege grants; R4+ approval; `sensitive` flag | Injection can still steer R0–R3 actions the agent is granted                        |
| Data exfiltration                        | `restricted`/`gateway-only` profiles                                                 | None under `dev-full-trust`, which is explicitly unsafe                             |
| Budget evasion by spawning or delegating | carve-out from the requester's budget; no implicit agent creation                    | None: total spend bounded by the root                                               |
| LLM key abuse                            | LLM proxy; rotation                                                                  | Until the proxy exists, bounded only by trust; E1 catches honest usage              |
| Verifier collusion or laziness           | enforced independence, canaries, audit sampling, non-LLM check requirement           | LLM reviewers share model biases (OQ5)                                              |
| Malicious or buggy extension             | out-of-process, approved permissions, circuit breaker, no database access            | A granted permission is a granted permission                                        |
| Operator error or insider                | roles, approvals for policy changes, ledgered actions                                | An admin can change policy; tamper-evidence not claimed (OQ6)                       |
| Server compromise                        | vault with the master key outside the database; least-privilege database role        | A compromised server is game over                                                   |
| Runaway cost or loops                    | budgets, WIP and depth caps, stall and loop detectors                                | Detection latency of one sweep interval                                             |

## Requirements

Required: R-1.1–1.5 (principals, revocation, route authorization, hard prohibitions, registration-only agents), R-12.1–12.9 (policy order and fail-closed, downward delegation, risk classes, the gateway, credentials, approvals, reconciliation, trust profiles, kill paths with measured latencies), R-13.1–13.5 (budgets, no evasion, E1/E2 enforcement, quotas, deterministic fair scheduling), R-8.9 (runaway limits), R-9.7 (stalls).

Not required: physical-world execution and R7 providers; accounts and the vault beyond the interim envelope encryption; the LLM proxy (a `SHOULD`, with the deviation recorded while the key remains in the sandbox and E1 is the only model-spend control); preemption, bin packing and multi-node placement.

## Tests

Scenario 9 (unauthorized access) as deterministic tests against the runtime API: agent calls an operator route → 403; agent acts as another (body `from` mismatch) → 403; agent claims a task it lacks capability or grant for → 403; agent submits with a stale fence → 409; agent creates an agent by messaging an unknown name → 404; agent attempts to create a grant for itself → 403. Scenario 10 (budget exceeded): E1 cutoff stops a session within one turn of exhaustion and the goal pauses. Policy engine: table-driven decision tests (deny > approval > allow; delegation never exceeds source; expiry; revocation; fail-closed on engine error). Gateway (R-12.7): crash between journal and dispatch leaves `unknown`, never a second dispatch; approval bound to args and claim; stale fence at dispatch cancels.
