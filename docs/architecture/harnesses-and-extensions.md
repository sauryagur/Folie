# Agent harnesses and extensions

Status: proposed with the architecture reset, 2026-11-12.

## Decision in brief

For a clean-slate implementation, prefer **Strands TypeScript SDK as the first harness candidate**, subject to a short integration and workload evaluation. Keep Pi as a comparison implementation and possible coding-oriented harness. Do not build Folie's own model/tool loop unless neither SDK can meet a concrete requirement.

This is a preference, not a claim that Strands is proven superior for Folie. The deciding measure is total Folie-specific code and operational complexity after integrating the SDK—not package size, popularity, or feature count.

## Comparison

| Dimension | Pi (`pi-agent-core` / `pi-coding-agent`) | Strands (TypeScript SDK / Harness) | Folie implication |
|---|---|---|---|
| Core shape | Small, stateful agent loop; Pi's broader project is a minimal, extensible coding harness. | SDK for assembling an agent plus an optional batteries-included harness. | Strands is a stronger general-purpose candidate; Pi is a smaller loop. |
| Existing primitives | Tool execution, streaming events, context transforms, provider API; coding-agent adds shell/file tools and its own extensions. | The TypeScript SDK provides the model loop, tools, streaming, structured output, and model providers; the broader Strands ecosystem documents additional harness, session, hook/plugin, MCP, and multi-agent features. Verify each feature against the exact TS package before depending on it. | Prefer existing primitives where Folie would otherwise build equivalents, but do not assume Python or harness features are present in the SDK package. Avoid adopting redundant state owners. |
| Editability | Low-level loop is approachable; higher-level coding tools/extensions are tailored to Pi's API. | Many composition points and reusable components; broader API takes more surface area to understand. | Prototype actual integration; don't infer editability from LOC alone. |
| Coding tools | Purpose-built read, bash, edit, write, grep, find, ls, and PowerShell tools; mature coding-oriented defaults. | Harness supplies shell, read/write/edit, web tools, and configurable built-ins. | Strands is capable for repository work; Pi has the more explicitly coding-specific default toolset. Compare on real coding tasks. |
| Extension model | Extensions are available in Pi's higher-level coding-agent package and may register tools and intercept behavior. | SDK plugins can contribute tools and lifecycle hooks; hooks and middleware compose around agent stages. | Both support powerful in-process code. Neither plugin API is a security boundary. |
| Multi-agent | Pi core does not require a multi-agent topology; add packages/extensions as needed. | The broader Strands ecosystem documents graph/workflow/swarm, agents-as-tools, and A2A features; verify availability in the selected TypeScript package. | Use those only where Folie does not need per-child durable identity/claims. A child invisible to Folie cannot receive Folie-level governance. |
| Persistence ownership | Pi coding-agent has session persistence features; `pi-agent-core` itself is the loop. | Strands provides session and memory options across its ecosystem; TypeScript package compatibility and persistence semantics need verification. | Reuse a session primitive if it fits, but select one authoritative transcript store. Folie remains authority for durable work. |

Sources: [Pi agent core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md), [Pi coding tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/index.ts), [Pi extension package model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), [Strands SDK](https://github.com/strands-agents/harness-sdk), [Strands harness configuration](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/README.md), [Strands TypeScript hook/plugin model](https://github.com/strands-agents/harness-sdk/blob/main/site/src/content/docs/user-guide/sdk/agents/hooks.mdx).

The current source of the Strands TypeScript SDK and harness is the [Strands Harness SDK monorepo](https://github.com/strands-agents/harness-sdk). The spike must record the exact npm package names and versions it evaluates; feature descriptions for Strands generally do not guarantee parity across Python, TypeScript SDK, and harness packages.

## Coding suitability

Strands Harness supplies shell and file read/write/edit tools and can be configured with its built-ins disabled or selectively enabled. That is a sound general coding baseline: inspect a repository, modify files, invoke tests/builds, and use web tools for documentation. Pi supplies more focused repository navigation tools (`grep`, `find`, `ls`) and is explicitly coding-oriented.

No Folie-specific head-to-head evaluation currently establishes which produces better code. Quality depends on the model, tool design, prompts, and execution environment as well as the harness. Use a fixed coding task set to compare completion, correctness, tool errors, wall time, cost, and reviewer findings.

Neither harness's local shell should be mistaken for isolation. Strands documents its shell inside a separate Box; Pi likewise requires a container or sandbox for stronger process/filesystem/network boundaries. Folie must run either harness through the selected execution backend and state the trust profile clearly. [Strands Box guide](https://strandsagents.com/docs/user-guide/box/guides/run-strands-harness/), [Pi security/quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md).

## Extension policy

Use three distinct terms:

- **Tool:** an action the model may invoke. This is the normal application extension point. Folie owns identity and permissions for Folie-managed effects.
- **Harness plugin:** trusted code that can modify prompts, hooks, middleware, context, or tool execution inside the worker process. Useful to application developers; not a safe marketplace unit.
- **Folie extension:** a separately operated provider with its own identity and grants. Defer this until an integration requires it.

Do not add a generic plugin catalog to the first runtime. Application authors may use the chosen harness's native plugin API in trusted application code. Shared or third-party capabilities should initially be exposed as typed tools, with sensitive effects mediated by Folie. In-process plugins can change behavior and must be treated as trusted executable code.

## Ownership rules

1. Folie owns durable work, authenticated identity, claims/fences, authorization, and accepted outcomes.
2. The harness owns the model loop and per-run conversation mechanics.
3. A session manager may persist conversation state if it satisfies the chosen profile; do not write a second competing authoritative transcript.
4. Tool calls that mutate Folie state use Folie's API and authenticated principal. Tool calls outside Folie are not governed merely because a harness plugin observed them.
5. Harness multi-agent features may be used inside one run for local reasoning. If child agents need independent Folie identity, budget, cancellation, or audit, represent them as Folie-managed work/runs instead.

## Evaluation before adoption

Run a small adapter spike for Strands and Pi against the same Folie-managed workload. Record exact package names and pinned versions (including `@strands-agents/sdk` if selected) and compare:

- adapter code required for tools, cancellation, steering, usage, and event capture;
- whether cancellation stops in-flight model and tool operations;
- compatibility of hooks/middleware with Folie's event and replay instrumentation;
- ability to use Folie-selected context and tools without duplicating durable state;
- one non-coding application and one repository-editing task;
- restart and lost-worker behavior when the harness process is terminated.

Adopt Strands if it lets Folie remove more code than it adds and preserves Folie's authority boundaries. Retain Pi as a supported alternative only if a concrete application benefits enough to justify maintaining it.
