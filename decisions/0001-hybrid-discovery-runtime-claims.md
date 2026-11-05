# ADR 0001: Hybrid discovery, runtime-authoritative claims, one owner plus participants

Status: proposed 2026-11-04. Revises Decision 19 ("assignment stays server-push; agents do not pull or negotiate"). Specification: [`../spec/protocols.md`](../spec/protocols.md) §3–§7.

## Context

The vision requires agents to discover work, propose tasks, negotiate ownership and form teams, while the runtime stays authoritative over ownership. Today the server pushes every goal to a pool agent; the 2026-11-04 direction kept that and added fencing only, because it was the smallest change that closed the stale-writer hole. It does not let agents discover, negotiate or organize, which is the point of this evolution.

Constraints: agents cannot be trusted to follow conventions; waking an agent costs a sandbox resume and a model session; the swarm may have hundreds of agents; Postgres is the single authoritative writer; Invariant 3 (only a delivery wakes an agent) should survive.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Server push only (today) | Simple; deterministic; already built | No discovery, negotiation or self-organization; the server becomes the central planner the vision rejects |
| B. Pull only (agents poll a board) | Simple and decentralised | Wasteful polling (every idle agent wakes to look); no ranking; slow discovery; thundering-herd claims |
| C. Peer-to-peer negotiation with agent-run consensus | Maximally decentralised | Unenforceable (agents can lie or stall), race-prone, deadlock-prone, needs a trusted arbiter anyway |
| D. **Hybrid:** runtime nominates a small ranked set, agents pull any time, runtime arbitrates every outcome by a conditional update | Cheap discovery; agent autonomy; deterministic ownership; the push path generalises today's dispatch | More moving parts than A; scoring needs tuning |

## Decision

Option D.

1. **Discovery** is hybrid ([protocols §5](../spec/protocols.md#5-discovery)): on `available`, the runtime notifies the top K eligible agents (default 3) with a summary delivery, widening in rounds on silence, never broadcasting to all; agents can always `task.list` / `agent.find` by indexed query.
2. **Claims** are a single conditional `UPDATE` on `status = 'available'` that increments a per-task **fence**. First writer wins; the loser gets `409` with the owner.
3. **Three claim sources** (`self`, `offer`, `assignment`) all produce a fence; server-push assignment (today's `choosePoolAgent`) survives as `assignment`, so the migration is incremental.
4. **Negotiation is messages with TTLs**; offers, help requests, bids and handoffs resolve by atomic runtime transitions; six rules prevent deadlock and livelock ([protocols §6](../spec/protocols.md#6-negotiation-offers-bids-help-handoff)).
5. **Multi-agent tasks: exactly one owner, any number of participants.** Only the owner submits and holds the fence; participants post, attribute artifacts and are admitted by the owner or a help request. Teams are a thin convening structure (channel, budget slice, context pack), most tasks have none.
6. **Fences are checked on every write and at gateway dispatch**, so a stale holder's late commit is rejected whether or not it was told to stop.

## Consequences

- The scheduler becomes a scoring function used by nomination and assignment, deterministic and testable; no global optimizer.
- Cost is bounded: a new task causes at most `K × max_rounds` deliveries.
- Ownership is never ambiguous; "who is responsible for the result" has one answer.
- Self-organization is evaluated, not assumed: each mechanism can be switched off and compared ([`../DESIGN.md` §23](../DESIGN.md#23-testing-and-evaluation)).
- Cost to accept: nomination weights and defaults need tuning against the evaluation suite; bid mode is not required (first-claim plus offers cover the coordination requirements).
- Reversal cost: low for nomination (it only sends messages); claims and fences are structural.
