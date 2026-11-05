# ADR 0004: A transactional event ledger beside relational state; not event sourcing

Status: proposed 2026-11-04. Replaces "event-sourced ledger: not adopted" in the 2026-11-04 gap analysis. Specification: [`../spec/domain-model.md`](../spec/domain-model.md) §1, §5–§6.

## Context

The vision wants an append-only history of important transitions and decisions, reconstructable state, replay and provenance. Folie already has append-only audit tables (`messages`, `session_events`, `reports`) and current-state tables. Making _every_ read reconstruct from events is costly and unnecessary; having no unified history makes "who decided what and why" a join across many tables.

## Options

| Option                                                                                                                                                                                  | For                                                                                            | Against                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A. State tables plus the existing audit tables (today)                                                                                                                                  | Simple                                                                                         | No cross-aggregate history; no decision records; no feed for clients and extensions              |
| B. Full event sourcing: events are the truth, tables are projections                                                                                                                    | Complete replay; temporal queries                                                              | Rewrites every module; projection lag in correctness paths; heavy operational and testing burden |
| C. **Relational state is authoritative for _current state_; an append-only ledger, written in the same transaction as each state change, is authoritative for _history and decisions_** | Atomic with the change; one feed for SSE, extensions and audit; no read path depends on replay | Two representations to keep consistent; the ledger can drift if a code path forgets to write     |

## Decision

Option C.

- Every transition in the state machines and every policy, approval, budget and capability decision appends one row to `events` in the **same transaction** (`type`, `aggregate`, `aggregate_id`, `actor`, `payload`, `correlation_id`, `causation_id`, trace context).
- High-volume streams stay in their own tables (`session_events`, `messages`); the ledger references them and never copies them.
- **Replay** means rebuilding _projections_ (TUI read models, metrics backfills, extension state) from the ledger by cursor, and re-deriving counters for verification. Normal reads use the tables.
- Consistency is checked, not hoped for: a verifier job recomputes selected invariants from the ledger (for example task status from the last `task.*` event, `open_deps` from edges) and alerts on drift; a test asserts every state-machine transition appends exactly one event.
- Append-only is enforced by database role and trigger. Tamper-evidence is not claimed ([OQ6](README.md#open-architectural-questions)).
- The ledger is the **client feed**: `GET /v1/stream` is a cursor over it (`id` = ledger id).

## Consequences

- Provenance questions ("why is this task `failed`", "who approved this call") are one indexed query.
- Extensions subscribe by durable cursor without touching tables.
- A forgotten ledger write is a bug class; the transition test and the drift job are the guard.
- Storage grows with transitions, not tokens; retention is a policy (ledger forever by default, session events summarised after a period).
