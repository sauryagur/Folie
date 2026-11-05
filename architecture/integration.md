# Capabilities, tools and extensions

Status: **target architecture**. Today Folie has six built-in swarm tools plus pi's coding tools and no capability or extension concept ([`current-system.md`](current-system.md#agent-image)). Authority: [`../DESIGN.md`](../DESIGN.md) §11, §19. Contracts: [`../spec/interfaces.md`](../spec/interfaces.md) §6, §8. Governance of use: [`governance-and-resources.md`](governance-and-resources.md).

**Four words, four things.** Conflating them is the commonest design error in agent platforms.

| Term | Answers | Example | Stored as | Proof |
| --- | --- | --- | --- | --- |
| **Capability** | What can this agent meaningfully do? | `software.dev@1`, `research.literature@1` | `capabilities`, `agent_capabilities` (level, evidence) | Track record of verified work; probes |
| **Tool** | Through which concrete interface does an action happen? | `github.pr.read@1`, `github.pr.merge@1` | `tools` (typed definition) | Schema, tests |
| **Permission** | What is this principal authorized to do? | `tool.invoke` on `github.pr.read@1` for `org/a` | `grants`, `policies` | Policy decision record |
| **Execution provider** | Where and how does it run? | gateway → GitHub extension; sandbox shell; AX | provider registry | Provider contract suite |

Worked example: an agent holds capability `software.dev@1` at level `verified` (its code tasks pass independent tests), the tool `github.pr.read@1` is granted for `org/a`, and `github.pr.merge@1` (class R4/R6) exists but the grant is absent and policy requires approval for the protected branch. The agent is *able* to merge; it is *not allowed to*; and the call would run in the GitHub extension via the gateway with a scoped credential the agent never sees.

## Capabilities

**Registry.** A capability definition is data: `id`, `version`, description, optional `requires` (tools, grants it presupposes), optional `probe` (a calibration procedure). Humans and extensions register them; agents cannot define new capabilities that gate others' work, though an agent may *propose* one, which is a human decision.

| Aspect | Design |
| --- | --- |
| **Advertisement** | An agent profile lists `declared` capabilities. Declaration is a claim, not proof. |
| **Levels** | `declared` → `assessed` (passed a probe or human assessment) → `verified` (track record). Levels are per (agent, capability, major version). |
| **Requirements** | A task states `required_capabilities: [{id: "research.literature@^1", min_level: "assessed"}]`. A goal policy sets `declared_ok_below` (risk class under which `declared` suffices). Eligibility checks level, never self-description. |
| **Discovery** | `agent.find(capability, min_level, available)` returns identity, level, idle/busy, load and verified pass rate; the scheduler uses the same query for nomination. |
| **Versioning and compatibility** | Semver. Tasks pin ranges. A major bump is a new capability line; holders must be re-assessed. Minor bumps carry levels. Tools a capability `requires` are version-checked at assignment. |
| **Assignment and revocation** | Humans assign or revoke; policy revokes automatically (streak rule). Revocation takes effect at the next eligibility check and does not cancel a running claim unless the goal policy says so. |
| **Profile** | An agent's capability profile is the set of (capability, level, evidence, last verified). Evidence points at verification rows. |

**Validating claims** (Question 6). Self-declaration admits an agent only to **low-risk** tasks. Everything stronger comes from observation:

1. **Probes** (`assessed`): runtime-generated calibration tasks with deterministic or held-out checks, hidden from the agent as calibration where the domain allows.
2. **Track record** (`verified`): for each verified task that required capability *C*, evidence accrues to *C*. The level is `verified` when the agent has at least 5 verified tasks in 90 days and the lower bound of the 95 % Wilson interval on its verification pass rate is ≥ 0.6 (defaults, configurable, tuned in evaluation). Failed verification counts against.
3. **Decay and revocation**: evidence ages out of the window; three consecutive verification failures on *C* demote `verified` → `assessed` and notify operators.
4. **Gaming resistance**: evidence counts only from verification with enforced independence; tasks the agent proposed *for itself* and self-assigned do not count; a capability claimed in a task contract but never required of the work earns nothing.

Reputation is a **view** over these results, never a field an agent writes. Whether the weighting helps is an experiment ([`../DESIGN.md` §23](../DESIGN.md#23-testing-and-evaluation)); it ships behind a switch ([OQ11](../decisions/README.md#open-architectural-questions)).

## Tools

**Two kinds** ([`ToolDefinition.kind`](../spec/interfaces.md#6-tools-verifiers-capabilities)):

- **Local tools** run in the sandbox (pi's `read`, `bash`, `edit`, `write`, search). They are not mediated by the gateway; their power is the sandbox's trust profile. They are journaled, traced and replay-tagged by the shim like any tool.
- **Gateway tools** have effects outside the sandbox. They are the only way to touch an external account and always pass the execution gateway.

Folie's own swarm operations (`message_send`, `task_claim`, …) are neither: they are typed calls to the runtime API under the agent's principal, authorized by grants and the state machines.

| Requirement | How it is met |
| --- | --- |
| **Typed inputs and outputs, schema validation** | JSON Schema in the definition; the gateway validates before policy; results validated, invalid results are `provider_error` |
| **Versioning** | `id@semver`; tasks and capabilities pin ranges; old majors served while pins exist |
| **Authentication** | to the gateway by the agent's token; to the target by a vaulted account credential held by the gateway or provider |
| **Authorization** | grant + policy + risk class ([governance](governance-and-resources.md#risk-classification)) |
| **Execution isolation** | local: sandbox; gateway: provider process (built-in in-server, or out-of-process); never the agent's process |
| **Timeouts** | `timeoutMs` enforced by abort at the gateway and at the shim; timeout leaves `idempotency = none` calls `unknown` |
| **Resource accounting** | `costModel` estimate at reserve, provider-reported `usage` at commit, basis recorded |
| **Audit** | `tool_invocations` row, ledger event, span, redacted result |
| **Idempotency** | `natural` / `key` / `none`; deterministic key from `(task, tool, args, ordinal)` (today's `RequestIds` scheme, extended) |
| **Retry semantics** | The gateway retries only `idempotency != none`, retryable errors, within the deadline, with the same key, at most 3 times with backoff. It never retries `none`. An agent that repeats a call reproduces the same key (ordinal scheme), so a replay cannot create a second effect |

**Error taxonomy** returned to the agent: `invalid_args` (never retry), `denied`, `approval_required`, `stale_fence`, `insufficient_budget`, `timeout` (outcome unknown, check before repeating), `provider_unavailable` (retry later), `provider_error{retryable}`. The agent sees what happened and what is safe to do next.

**Discovery.** `GET /v1/tools` (and the shim's `host.tools.list()`) returns the tools **the principal is granted**, so tools an agent could not use never cost context. The shim supplies definitions to the harness in the harness's own tool format.

**MCP.** Tools exposed through MCP fit as either local tools (an MCP server inside the sandbox via ax `Workspace.spec.mcp.servers`, trusted as the sandbox is) or gateway tools (an MCP-backed `ToolProvider` adapter registered by an admin who declares each tool's risk class and idempotency, since MCP servers do not). The MCP adapter is not required.

## Extensions

**Smallest stable contracts** (Question 19; the full list of what is promised stable, and nothing else): a **manifest**, a **typed invocation protocol** (JSON-RPC 2.0), a **ledger cursor** for events, **grants** as the only authority, and the **lifecycle and isolation rules** in [interfaces §8](../spec/interfaces.md#8-extension-manifest-and-lifecycle). There is no in-process plugin API for third parties, no hook into the scheduler or policy engine, and no UI extension point yet. A plugin framework is deliberately not built: these five contracts are enough to express the integrations listed in the vision, and every additional hook is a compatibility burden.

| Extension point | What it is | Where it runs | Requirement |
| --- | --- | --- | --- |
| **Tool provider** | `ToolProvider` | out of process (or built-in, in-server, first-party) | R-12.4, R-10.5 |
| **Verifier adapter** | `VerifierAdapter` | out of process or built-in; code-executing ones in a verification execution | R-11.4, R-10.5 |
| **Capability provider** | definitions plus optional probes | data; probes via tool-like calls | R-10.1 |
| **Event subscriber** | ledger cursor consumer | out of process | R-10.5 |
| **Harness** | `Harness` | in the agent image (in-process) or stdio JSON-RPC | R-5.1, R-10.5 |
| **Execution provider** | `ExecutionProvider` | server-side adapter | R-6.1 |
| **UI/TUI extension** | not specified | — | excluded; [open](../DESIGN.md#25-risks-open-questions-and-trade-offs) |

**Server-side and user-side.** *Server-side* extensions are deployed next to folie-server and registered by an admin (an HTTP endpoint with mTLS or a cluster-internal service). *User-side* integrations run where the user is (a laptop, a firewalled network) and cannot accept inbound connections, so the provider protocol has a second transport: `endpoint.type: "pull"`. The provider long-polls `GET /v1/providers/:id/work`, executes, and posts the result; Folie never needs to reach in. The same manifest, grants and isolation apply. The extension runs as principal `ext:<id>` holding only the grants approved at registration.

**Shared collaboration module, worked example (Kanban).** A Kanban board extension is a tool provider (`kanban.card.create`, `kanban.card.move`, class R3, idempotent by card key), an event subscriber that mirrors `task.*` events to cards, and an inbound path where a human moving a card calls `task.propose` or `task.cancel` as a *human* principal through the API (the extension forwards the human's own credential, it does not impersonate). No new core concept was needed.

**Failure isolation.** Timeouts, concurrency caps, circuit breaker, health, result size limits ([interfaces §8](../spec/interfaces.md#8-extension-manifest-and-lifecycle)); an extension failure makes its tools undiscoverable and the tasks that need them unclaimable, not failed; an extension can never block the ledger, the gateway of another tool, or a state transition.

**Compatibility.** The API carries a version; manifests state `folie_api` ranges; the server supports the current and previous major concurrently; breaking changes follow a deprecation period recorded in the changelog and surfaced by `enabled` refusal with a precise message.

## Requirements

Required: R-10.1–10.6 (capability definitions and evidence, eligibility enforcement, versioned tool definitions, a bounded model-visible surface, the five extension contracts and their isolation), R-11.4 (deterministic verifier adapters), R-10.4 (tool listing by grant).

Not required: the MCP adapter, pull transport, capability probes as a separate mechanism (an `assessed` level may be assigned by a human), UI extensions.

## Tests

Contract suites per provider kind ([interfaces §12](../spec/interfaces.md#12-conformance-and-contract-tests)); capability evidence tests (independence is required for evidence, self-proposed tasks earn nothing, Wilson bound edge cases, decay); tool pipeline tests (schema failure, timeout → `unknown`, key honoured on retry, redaction); extension isolation tests (slow provider trips the breaker without delaying other tools; manifest requesting more than approved is refused).
