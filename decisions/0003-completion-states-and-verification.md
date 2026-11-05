# ADR 0003: Four completion claims; verification as an enforced-independence contract

Status: proposed 2026-11-04. Extends Decision 19. Specification: [`../spec/domain-model.md`](../spec/domain-model.md) §7, [`../spec/protocols.md`](../spec/protocols.md) §8, §10; architecture: [`../architecture/work-and-coordination.md`](../architecture/work-and-coordination.md#verification-subsystem).

## Context

Today `done` means the agent reported done (D5), and any `done` report settles every work item it acked. For autonomous work over arbitrary domains that is the largest correctness gap: an agent can be wrong, lazy, or dishonest, and the system would not know.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Trust the report (today) | Trivial | Unsound |
| B. One universal verifier agent | One mechanism | An LLM grading an LLM; no domain grounding; one failure mode for everything |
| C. Deterministic checks only | Strong where available | Cannot judge a literature review or an informal proof |
| D. **Contract with deterministic and independent-review and human checks, independence enforced by the runtime, confidence reported** | Domain-appropriate; auditable; degrades honestly | More machinery; reviewers cost tokens |

## Decision

Option D, with four distinct claims that are never conflated: **agent-reported** (`submitted`), **runtime-accepted** (`completed`: fence valid, outputs present and hashed, inputs not stale), **verified** (`verified`: all required checks passed), **goal-level success** (`achieved`, by goal evaluation, not by "all tasks verified").

- The **contract is fixed at acceptance**; only supersession changes it, so a producer cannot lower its own bar.
- A goal sets a **verification floor**; `level: none` is legal only if the floor allows, and ends at `completed`, displayed as unverified.
- **Independence is enforced**: producer and participants cannot claim the verify task; code-running checks run in a separate verification execution from an immutable artifact snapshot; reviewers do not see the producer's transcript by default.
- Where no deterministic verifier exists, the contract names a substitute (independent re-derivation with a comparator, evidence audit, human sample); pure judgment is capped at confidence 0.7 unless corroborated; a goal may demand a non-LLM check.
- Verifiers are audited with canary artifacts and re-verification samples; false-accept rate is a metric.

## Consequences

- Dependents promote on `completed` or `verified` per edge, defaulting to `verified` when the upstream contract requires verification.
- Verification reuses tasks (claims, leases, budgets), not a second scheduler; verify tasks have their own budget slice.
- Evaluation measures **verified** success, not reported success.
- The migration marks existing `done` work items as `completed` with `verification: none`, shown as unverified, never as verified.
- Cost to accept: verification spend is a real fraction of total cost; the evaluation must show it pays for itself in correctness. Review confidence is only as good as the reviewer ([OQ5](README.md#open-architectural-questions)).
