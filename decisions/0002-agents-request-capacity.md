# ADR 0002: Agents request capacity; they do not create agents

Status: proposed 2026-11-04. Closes finding D2. Specification: [`../spec/protocols.md`](../spec/protocols.md) §15.

## Context

Today any `send`, `subscribe` or `publish` to an unknown name creates an agent row, and the controller creates an ax task for every agent with unread mail. `FOLIE_MAX_AGENTS` bounds only the pool (`agent-<n>`). An agent, or any caller (D1), can create unbounded executions by messaging new names. The vision wants agents to obtain help without hierarchy, and also wants budgets that cannot be evaded by spawning.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Free creation (today) | No friction | Unbounded cost and sandboxes; evades any budget; identity sprawl |
| B. Creation with a budget carve-out | Bounded cost | Agents define arbitrary configs (harness, tools, grants); privilege escalation by constructing a stronger agent |
| C. **Capacity request** against human-managed profiles | Bounded by policy, budget and caps; no escalation (grants subset of requester's); registration stays a runtime act | Less flexible than free-form creation; profiles must be curated |
| D. No spawning at all; fixed fleet | Simplest | A goal that needs more parallelism than the fleet cannot get it |

## Decision

Option C. An agent calls `capacity.request({scope, profile, count, reason, budget_ask, ttl})`. The runtime checks the `capacity.request` grant, swarm `max_executions`, goal `max_agents`, the requester's budget headroom, spawn depth (≤ 2) and live descendants (≤ 4). It assigns idle agents of the profile first, else registers new agents from the profile with `created_by` and lineage, carves the budget from the requester, and sets `retire_at`. **Grants delegate downward only.** Any other creation path returns `404 unknown_agent`; operators register agents by `POST /v1/agents`; pool agents are registered by the scheduler from the `default` profile.

## Consequences

- Total spend is bounded by the root budget regardless of spawning.
- Profiles are the unit of curation (harness, model, tool grants, limits); changing what an agent can do is a human act.
- `message_send` to a new name no longer works as an implicit spawn. The existing "emergence: delegating wakes a peer that did not exist" slice test (`test/slice.test.ts`) is rewritten to use a capacity request or a registered agent.
- A coordination pattern that wants "spawn a specialist" is available and metered; one that wants arbitrary new configurations is not, by design.
