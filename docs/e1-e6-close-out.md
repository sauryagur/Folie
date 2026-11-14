# E1–E6 close-out design note

> **Historical design note:** E1–E6 are demonstrations from the previous architecture target. Their gaps and ordering are not an active implementation backlog. The current proposal and validation direction are in [`architecture/README.md`](architecture/README.md).

Status: **not met**. No live run (real ax + Substrate + model provider) has been recorded for any of E1–E6. This note records what a live run would count as, what code must exist before it, and the gaps that block it. Do not quote this as passing.

## What E1–E6 require (spec/requirements.md §2)

| ID  | Demonstration                                                                                                                                                                    | Shows                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| E1  | Human submits research goal with acceptance criteria + budget; agents decompose, claim without central assigner; owner + contributor complete one task with attributed artifacts | Autonomous decomposition + coordination |
| E2  | Agent killed mid-task; lease/execution loss detected; another claims with higher fence; late submit rejected; goal continues                                                     | Fenced recovery                         |
| E3  | Complete-reported task rejected by independent verification, retried with findings, then verified; producer cannot claim own verify task                                         | Verification independence               |
| E4  | Human pauses, messages, edits plan, revokes claim, approves final mid-run without corrupting ownership                                                                           | Oversight                               |
| E5  | Agent attempts: act as another, operator route, ungranted gateway tool, self-grant, exceed budget — all denied + recorded                                                        | Governance                              |
| E6  | Same held-out goals under single-agent, manager-worker, centrally-planned baselines; outcomes reported with failures                                                             | Evaluation comparability                |

## Recorded configuration (required for any claim)

- Live ax (AX API), Substrate with named-host/per-port egress, one model provider, `folie up` deployment with collector.
- Reservoir of agents ≥2 (E1–E5), benchmark goals + baselines for E6.
- Every run recorded: ledger (`events`), traces, metrics snapshots, failures included (`docs/runs/<date>-e<N>/` — not yet created).

## Preconditions per demonstration vs current code

### E1 — autonomous decomposition

Need: goal with acceptance criteria/budget (goal exists as work item + budget exists), decomposition via `proposeTask`, discovery (`listForWorkItem`, task pull), claim/claimant, contributor attribution (`task_claims` contributor role exists in schema; `addContributor` service path **missing**), artifacts attributed to task.

**Gaps:** contributor add path, goal acceptance-criteria/budget fields on the goal record, discovery indexes beyond `tasks_available`. Blocked on: task graph deps (R-8.5).

### E2 — fenced recovery

Need: kill mid-task → lease expiry → reclaim with higher fence → stale submit rejected.

**Present:** single conditional claim, fence bump on claim, fence-checked start/submit, lease expiry timestamp (`lease_expires_at`), leader-elected reconciler (`leader.ts`).

**Gaps:** sweeper (R-8.4), revoke (R-8.3), and pause (R-7.3) are now implemented in the service and wired to HTTP (`/v1/admin/sweep-leases`, `/v1/tasks/:id/revoke`, `/v1/work-items/:id/pause`) plus the client and the leader tick. Live ax kill test still missing; ghost/`lost` execution → claim revoke path (R-6.4) still partial. Blocked on: live kill test.

### E3 — verification independence

Need: reject → retry with findings → verify; producer ≠ verifier enforced.

**Present:** independent verifier required, self-verify rejected, submitted→verified aggregation, goal evaluation from verified coverage.

**Gaps:** `completed` state (T12) never set — today submitted→verified directly, so T12/T14 separation is collapsed (single move serves both). No retry loop (no findings attached to next attempt, no `max_verification_rounds`). No deterministic adapter runner (R-11.4) — verdicts are recorded by operator, not produced by code. Blocked on: adapter runner + retry semantics.

### E4 — oversight

Need: pause, message, plan edit, revoke claim, approve final — mid-run, ownership intact.

**Present:** messaging, cancel (queueCancel), control poll.

**Gaps:** goal **pause** (R-7.3) and **revoke claim** (R-8.3) are now implemented and wired to HTTP (see E2); plan edit (`plan.change`, R-8.6) **missing**; approvals surface (R-12.6) **missing**. Blocked on: R-8.6/R-12.6.

### E5 — governance

Need: five denial attacks, each denied + recorded.

**Present:** R-1 (act-as → 403, operator routes reject agents), budget exhaustion, gateway credential scrubbing.

**Gaps:** ungranted gateway tool denial path exists in gateway but not wired into sandbox tool surface; self-grant (agent creating grant/policy/budget) — budget/grant mutations are operator-only, but there is **no adversarial test suite** proving all five; denial recording (ledger/audit) partial. Blocked on: adversarial test suite + gateway tool-list gating (R-10.4).

### E6 — baselines

Need: three baselines on held-out goals, measured incl. failures.

**Present:** metrics catalog (verified completion rate, claim latency, time-to-verified), ledger, evaluation from DB (R-15.7).

**Gaps:** no baseline harnesses, no benchmark goals, no evaluation harness script. Blocked on: harness + goals + E1–E3 primitives measured.

## Ordering

1. Sweeper + revoke + pause (E2, E4 gate) — highest leverage, unblocks two demonstrations.
2. Deterministic verifier adapter + retry (E3 gate).
3. Contributor path + discovery (E1 gate).
4. Adversarial suite (E5 gate).
5. Baselines (E6 gate).

## What this note does not claim

- No E1–E6 has been run. No live ax/Substrate/provider verification has occurred in this repo's history for these demonstrations.
- Passing unit/integration tests (400+ at last full run) prove seams, not end-to-end demonstrations.
