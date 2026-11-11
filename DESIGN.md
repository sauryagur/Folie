# Folie

**Design proposal, 2026-11-12.** This reset reframes Folie as a programmable runtime for building applications with persistent agents. It is a proposal for review, not a claim that the described system is implemented. The code as it exists is documented in [`architecture/current-system.md`](architecture/current-system.md).

Folie should make a useful local agent system easy to start, while exposing dependable primitives that applications can compose into research teams, coding systems, assistants, automations, and experiments. A default deployment should not require Kubernetes. AX/Substrate and kind remain supported execution options for users who choose them.

## Design principles

1. **Reuse before rebuilding.** Prefer an existing SDK primitive when its behavior and ownership model fit Folie's requirements. Build only Folie-specific control and durable coordination.
2. **Start with the smallest useful application.** Add a concept, service, or abstraction only when a real workload needs it or it protects a concrete invariant.
3. **Keep durable authority outside the model loop.** Folie owns authenticated identity, work ownership, permission checks, and durable outcomes. A harness runs the model and tools; its hooks are not security controls.
4. **Make optional infrastructure first-class.** Local execution is the default candidate; AX/Substrate is a native, documented option. Both use the same Folie work contract.
5. **Allow research without making research a promise.** Experiments may use adapters or recipes with clear limitations. Stable compatibility is earned by use and evidence.

## Proposed shape

```text
Applications and recipes
        ↓
Folie primitives: identity · work · run · tools · outputs
        ↓
Adapters: harness · execution · storage · model · client
```

The minimum core is an authenticated principal, a durable work record, a single expiring/fenced owner claim, a cancellable run, and durable outputs with enough history to explain settlement. Begin with one application; do not make teams, negotiation, reputation, policy languages, vector memory, or a generic plugin catalog universal requirements.

The harness choice is open to implementation evidence. From a clean-slate rewrite, **Strands is the preferred candidate** because its TypeScript SDK already provides model loops, tools, cancellation, hooks, middleware, and composable plugins. Pi remains a valid simpler alternative and a coding-focused comparison. Folie should reuse Strands primitives where they fit, without duplicating durable state or delegation that Folie must govern. Details: [`docs/architecture/harnesses-and-extensions.md`](docs/architecture/harnesses-and-extensions.md).

## Deployment and evidence

The proposed `local` profile starts without a cluster; its exact trust boundary must be explicit. The `ax` profile provides the AX/Substrate path when sandboxing and cluster execution are wanted. Storage choice (SQLite versus PostgreSQL) remains open pending a real workload and a representative concurrency test. See [`docs/architecture/deployment-and-stack.md`](docs/architecture/deployment-and-stack.md).

The first implementation proof should be one useful multi-session application on `local`, then the same work contract on `ax`, plus worker-loss recovery and stale-owner rejection. No agent-count or throughput claim is made until measured. The staged proposal is in [`docs/architecture/roadmap-and-validation.md`](docs/architecture/roadmap-and-validation.md).

## Document status

This proposal replaces the previous target direction for discussion. The existing `spec/`, `decisions/`, and architecture documents describe the prior design and code snapshot; they are retained for audit and migration context, not as a checklist for implementing this proposal. Their normative status is suspended until the new design is reviewed and the required specifications are rewritten.
