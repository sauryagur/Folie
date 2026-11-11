# Folie architecture reset — discussion draft

> **Superseded discussion draft:** The current proposal is organized in [`../architecture/README.md`](../architecture/README.md). Keep this file as the record of the earlier discussion; its detailed proposals are not current design guidance.

Status: archived discussion draft, 2026-11-12.

## 1. Reframe the product

Folie is a **programmable runtime for building applications with persistent agents**. It is not itself one finished assistant, coding product, or prescribed organization chart. The runtime supplies a small set of dependable primitives; applications compose them into personal assistants, research teams, coding systems, automations, or other arrangements.

The design goal is:

> Make a useful local agent system easy to start. Make its primitives composable. Let more capable infrastructure be selected when a workload needs it.

The product therefore has three layers:

1. **Kernel:** durable work, identity, execution/session lifecycle, messages, artifacts, and authority.
2. **Adapters:** storage, model providers, harnesses, execution backends, tools, schedulers, verifiers, and clients.
3. **Applications and recipes:** policies and compositions that turn those primitives into a particular agent product.

Folie should keep the kernel small and the adapter contracts practical. It should not build a generic plugin framework merely to claim extensibility. First-party adapters ship with Folie and use the same public contracts as later external implementations. Experimental adapters can move faster, with their maturity and limitations visible.

## 2. What the current target gets wrong

The current target has strong instincts—durable state, explicit authority, replaceable execution, and clear separation between agent identity and process—but it promotes too many ideas to universal requirements before a first workload proves them.

### Over-specified before measured

The target defines 96 normative requirements and extensive protocols for teams, offers, bids, reputation, capability evidence, gateway risk classes, hierarchical budgets, memory promotion, and extension lifecycles. Yet there is no agreed workload envelope for concurrency, throughput, latency, or recovery, and E1–E6 have not been demonstrated live. This makes the architecture look more settled than its evidence supports.

### Too much organization in the kernel

Teams, channels, capability levels, nominations, offers, and negotiation are useful possible application patterns. They do not all need to be core runtime entities on day one. The kernel should provide work ownership, participants, messages, and permissions; richer organizations can be composed above those primitives when an application needs them.

### Abstraction multiplication

The target separates agent, execution, workspace, session, claim, memory, harness, provider, verifier, capability provider, tool provider, extension, event subscriber, and gateway. Some boundaries protect genuine invariants. Others are future-proofing without a second working implementation. Every interface has versioning, testing, and compatibility cost.

### Requirements without stages

The normative spec says every MUST applies to one conforming system, with no staging. That conflicts with the product direction of starting with a simple local runtime and adding advanced capability when needed. Requirements should be attached to profiles and maturity levels, not all imposed on the first useful deployment.

### “Emergent swarm” is not established by having primitives

Durable messages and tasks make coordination possible; they do not demonstrate that agents discover useful decomposition, collaborate efficiently, or produce better outcomes. The architecture needs one or two measured applications before it adds broad negotiation and reputation mechanisms.

### Security model is larger than the demonstrated implementation

The target includes a full execution gateway, vault, trust profiles, risk classes, per-agent budgets, approvals, and replay reconciliation. Those may be required for valuable external effects, but the current deployment is explicitly `dev-full-trust` and live E1–E6 validation is absent. The minimal secure baseline and the advanced policy system need separate stages.

### The default path is too infrastructure-heavy

The as-built deployment starts kind, Substrate, ax, Postgres, and Folie server. AX/Substrate should be a native, well-supported execution option, but should not be a prerequisite to trying Folie. The default and the advanced profile should share the same domain primitives.

## 3. Proposed core

The kernel should expose only the concepts that applications cannot safely or conveniently recreate.

### 3.1 Principal and authority

Every API action has an authenticated principal: a human, agent execution, or system component. The server derives identity from credentials, never from a request body. A principal may act only within explicit grants. Agents cannot grant themselves authority.

Keep authorization and revocation in the kernel because they are invariants, not application policy. Start with a small grant model. Do not introduce a general-purpose policy language or a large risk taxonomy until real tool integrations require one.

### 3.2 Work item

Use one durable `WorkItem` abstraction for objectives and units of work. A work item can have a parent, dependencies, an owner, participants, inputs, expected outputs, constraints, deadline, resource limits, and an acceptance/evaluation contract. A root work item is commonly called a goal; a child is commonly called a task. These can be API conveniences or typed views, not separate state machines by default.

Work items have a small lifecycle: `ready → claimed → running → submitted → accepted | rejected | blocked | cancelled`. A claim has an expiry and monotonically increasing fence. Only the current fenced owner may settle or write task-scoped outputs. A rejected result can be reopened with findings and an attempt limit.

Keep one owner and optional contributors initially. Defer voting councils, bidding, reputation-based scheduling, and complex negotiation. Agents may propose child work; the runtime validates limits and authorizes execution.

### 3.3 Run and session

An **agent identity** is persistent; a **run** is one execution of that agent; a **session** is one bounded unit of reasoning within a run. The server records the start, inputs, outcome, usage, and interruption of each session. A run may resume or start a fresh session according to its application policy.

Sessions should be bounded to manage context, spend, and cancellation. Continuity comes from explicit work state, artifacts, and selected memory—not an ever-growing transcript. A harness does not own durable work state.

### 3.4 Durable messages and events

Provide point-to-point durable messages and work-scoped history. Messages may wake an agent; no independent mechanism should cause hidden work. Start with polling or long-polling and idempotent delivery. Add push transport only when measured latency or scale requires it.

Persist important state changes and decisions transactionally with their records. Keep an audit/event feed for operators and clients, but do not make the whole database event-sourced. Telemetry remains a separate diagnostic projection.

### 3.5 Artifacts and context

Artifacts are durable outputs with content hashes and provenance. A local filesystem-backed store is a reasonable initial implementation; a remote object store is an adapter for shared or larger deployments.

Keep memory deliberately small at first: scoped notes and references that can be assembled into a bounded context. Distinguish agent preferences/skills from knowledge for a particular work item. Do not require immutable knowledge graphs, contradiction workflows, vector search, or memory reputation in the kernel until an application demonstrates the need.

### 3.6 Tools and capabilities

Tools are typed actions with declared inputs, outputs, and effects. A capability describes what an agent or application can do; it is not permission to do it. Permission remains an explicit grant.

Start with local harness tools and a small external tool gateway for effects that need server-held credentials or approval. MCP can be an adapter for tool interoperability; it is not the internal work protocol. Defer a marketplace and third-party plugin lifecycle until there is real demand.

## 4. Adapters and profiles

The kernel owns semantics; adapters provide implementations. An adapter must declare supported capabilities and failure behavior. Interfaces should be small enough to implement, and each supported adapter should pass the same contract suite. Do not create an abstraction until a second real implementation or a meaningful isolation boundary justifies it.

### Initial supported profiles

| Profile | Purpose | Default components | Declared limits |
|---|---|---|---|
| `local` | Start quickly on one machine; build and experiment | Local server, SQLite candidate, local process executor, one installed harness, local filesystem artifacts | Explicitly local trust model; no claim of Substrate-equivalent isolation or multi-host coordination |
| `ax` | Run work in AX/Substrate sandboxes | Same Folie work model and API, AX execution adapter, Substrate network controls, selected persistent store | Requires kind or a configured Kubernetes cluster; resource, workspace, cancellation, and egress guarantees must be verified against the selected AX/Substrate versions |

Profiles are configuration bundles, not separate products or forks. `folie init` should produce a usable local profile. `folie configure execution ax` and `folie up --profile ax` should make the advanced path discoverable and straightforward without installing Kubernetes for everyone.

### Storage choice

Do not mandate Postgres for every profile by default. SQLite is a serious candidate for the local profile because all database requests pass through Folie’s application server and the deployment is single-machine. Its one-writer limit is material for event-heavy concurrent agents and must be measured. Postgres is the candidate for shared/multi-host deployments and higher write concurrency.

Supporting both is justified only if the use cases warrant the extra implementation, migration, and test cost. If both are supported, define a narrow `Store` contract and run identical state-machine, concurrency, and recovery tests against both. Do not promise interchangeable stores if critical semantics differ.

The current store is PostgreSQL-specific (`jsonb`, arrays, advisory locks, partial indexes, and dialect-specific SQL). That is a migration fact, not a reason to preserve Postgres as a universal requirement.

### Harness and model choices

Keep Pi as the initial harness because it is already integrated. Keep it behind a Folie-owned harness boundary only if the boundary supports real harness diversity without mirroring every harness feature. Model providers should be selectable by configuration. A direct provider key is acceptable only in an explicitly local/trusted profile; a managed or restricted profile needs a server-side proxy if it promises credential isolation or hard spend enforcement.

## 5. Local-first operation and advanced execution

The local profile should not require kind, Substrate, AX, Postgres, or a separately operated message broker. One Folie server process owns the local database and starts/cancels worker processes. Workers communicate with it through the same authenticated API and durable message/work model used by the AX profile.

Local execution must state its trust boundary honestly. It can be convenient and suitable for a trusted developer workstation without being equivalent to a hardened sandbox. AX/Substrate remains a first-party supported option for users who need isolated execution and network controls.

AX support should be tested as a product path, not left as an architectural promise: context/config validation, version compatibility, resource limits, workspace persistence, cancellation, egress, recovery after worker loss, and human-readable failures all need evidence.

## 6. What belongs above the kernel

Implement these as recipes or optional components, driven by working applications:

- Hierarchical teams and role structures.
- Autonomous task nomination, bidding, offers, and handoff negotiation.
- Recurring schedules and event-triggered work.
- Specialist capability registries and evidence-based reputation.
- Rich approval workflows and policy/risk taxonomies.
- Verifier marketplaces and multi-stage review topologies.
- Vector memory, knowledge graphs, and automatic memory consolidation.
- Swarm dashboards, UI extensions, and agent marketplaces.

These are not rejected. The kernel should leave reasonable seams for them, but not bear their state machines and compatibility commitments before they are needed.

## 7. Research and maturity model

Support research without making experiments production promises. Every adapter or feature has one maturity label:

- **Supported:** documented, versioned, contract-tested, and included in compatibility expectations.
- **Experimental:** usable through an explicit opt-in; behavior may change; limitations and failure modes are stated.
- **Research:** isolated experiment, not part of normal installation or reliability claims.

An experimental scheduler may try decentralized allocation; an experimental harness may test a new agent stack; an execution adapter may use AX/Substrate. Experiments use the same work records and authority rules where they interact with the kernel. A breakthrough can graduate after measured utility and conformance, not by accumulating configuration flags in the core.

## 8. Defaults and operational promises

Defaults should make the common path easy without hiding trust or cost:

- Local profile, one operator, one server, no cluster prerequisite.
- One durable store and one execution backend per deployment initially.
- A small default harness/toolset; users can select another supported adapter.
- No agent self-registration or self-granting.
- No external account writes without an explicit tool grant; no credential-isolation claim unless credentials stay outside the worker.
- Visible resource and model usage. Hard limits only where the selected provider/backend can enforce them; otherwise label limits as advisory.
- SQLite vs Postgres, local vs AX, and direct vs proxied models are profile choices with capability descriptions and clear migration paths.

Folie should make no scale claim such as “hundreds of agents” until a published workload test defines concurrent active runs, event/write rate, p95 claim and message latency, failure rate, recovery time, and cost.

## 9. Evidence gates

Before calling the foundation useful, demonstrate:

1. A local installation starts without Kubernetes and can complete one useful multi-session goal.
2. The same work model runs through the AX profile without special application logic.
3. Killing a worker cannot let a stale run settle the task or overwrite accepted output.
4. A server restart preserves work, messages, artifacts, and audit history.
5. A human can pause, steer, and resume work and can inspect authority and spend.
6. A second harness or coordination recipe can use the core without importing Pi or AX concepts.
7. Storage and concurrency claims match measured tests on the selected backends.

These gates test the primitives. A coding swarm, research group, or personal assistant can then be an application-level demonstration rather than the architecture itself.

## 10. Decisions still open

1. Is `local` the default profile, and what precise trust guarantees does its executor provide?
2. Is SQLite the local default, with Postgres an optional shared deployment backend, or is Postgres sufficiently low-friction when automatically managed?
3. Is a generic work-item model simpler than separate goal/task records once acceptance, dependencies, and revisions are included?
4. What is the minimum authenticated API needed for a one-user local profile, and how does it transition to remote operators?
5. Which first application best exercises reusable primitives without overfitting them?
6. Which AX/Substrate capabilities are real and live-tested today, versus exposed by interface but not used?
7. Which adapter boundary is justified by a second implementation now, and which should wait?

## 11. Migration posture

This is a design reset, not a recommendation to discard working code. Preserve implementations that fit the smaller core. Reclassify existing requirements into kernel invariants, adapter contracts, application features, and deferred research. Remove or rewrite requirements that encode unsupported scale or abstractions without evidence.

Before changing authoritative docs or code, agree on the local profile, first workload, and core work/session model. Then update `DESIGN.md`, reduce the normative spec to staged conformance requirements, amend ADRs, and map the existing implementation to the new design. Avoid a broad rewrite until that mapping identifies code that cannot be carried forward.
