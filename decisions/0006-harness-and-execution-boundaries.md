# ADR 0006: Harness contract with a hosted tool pipeline; six separate lifecycles; AX behind `ExecutionProvider`

Status: proposed 2026-11-04. Revises Decision 3; extends Decisions 1 and 11. Specification: [`../spec/interfaces.md`](../spec/interfaces.md) §4–§5; architecture: [`../architecture/agents-and-execution.md`](../architecture/agents-and-execution.md).

## Context

`Runtime.run(messages, session)` ([`src/agent/runtime.ts`](../src/agent/runtime.ts)) is run-to-completion with no cancellation (D10); journaling, spans and replay tags are applied by `instrument()` around Pi's `AgentTool`, so they are Pi-shaped. `agents.state` is an execution state (`running`, `suspended`, `retired`), so identity and execution are one row; `sessions` rows exist only at report time (D6); the controller talks to ax directly. The vision needs interchangeable harnesses and execution providers, and an identity that survives both.

## Options

| Option                                                                                                     | For                                                                                   | Against                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A. Keep `Runtime` and `AxClient` as they are                                                               | No work                                                                               | No cancel; Pi concepts leak; AX concepts in the domain                                                         |
| B. Adopt an external agent protocol wholesale (for example MCP or ACP) as the harness contract             | Existing ecosystem                                                                    | None covers lease-aware cancel, usage granularity, replay policy, or session scoping; we would bend or fork it |
| C. **Own small contract with capability flags, tool dispatch hosted by the shim, bound to JSON-RPC later** | Exactly what Folie needs; every harness inherits journal, tracing, replay and fencing | We own and version it                                                                                          |
| D. Treat harness and execution as one "agent runtime"                                                      | Fewer interfaces                                                                      | Cannot change harness without changing execution                                                               |

## Decision

Option C for the harness. A `Harness` has `start → RunHandle { result, deliver?, cancel, snapshot? }` and a descriptor of capabilities (`deliver`, `cancel`, `usage` granularity, native tools with replay, `snapshot`, `mcpClient`). **Universal:** start, result, cancel (a harness with `cancel: none` is killed), events for tool calls and session boundaries, session-level usage. **Optional, with defined degradation:** mid-run delivery, turn-level usage, snapshot, replay declarations. Tool dispatch (journal, span, replay policy, fence, redaction) is implemented **once** in `HarnessHost.tools`. Out-of-process harnesses use the same contract over JSON-RPC.

Separately, **agent, execution, workspace, session, task claim and memory are six records with six lifecycles**, and the controller depends on an `ExecutionProvider` port; AX is its first adapter and the only place that knows `atespace`, `Task` or `actor`. The provider declares what it cannot do (suspend, list, network allowlist, in-flight cancel); the reconciler plans around the declaration.

## Consequences

- `PiRuntime` becomes `PiHarness`; `echo` becomes the conformance harness; both run the shared contract suite.
- Agent config (harness, model) is fetched per session, so changes need no new ax task (ax tasks are immutable).
- The `agents`/`executions` split and session-at-start are schema migrations with a defined path ([`../spec/domain-model.md`](../spec/domain-model.md#8-migration-from-the-current-schema)).
- Cancellation becomes possible: the shim's control watcher calls `cancel`, which maps to `Agent.abort()` for Pi.
- Cost to accept: a harness author implements more than `run()`; the descriptor makes the extra work optional where it can be.
