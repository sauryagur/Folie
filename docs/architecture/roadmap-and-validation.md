# Rewrite sequence and validation

Status: proposal, 2026-11-12. This is a sequence for reducing uncertainty, not a promise to implement every item.

## Before implementation

Name one first application that is general enough to validate reusable primitives but small enough to finish. A candidate is a long-running research task that spans several sessions, can produce durable files, can be interrupted and resumed, and has a human-inspectable result. Do not add a large team model to prove one worker can resume.

Choose the developer composition path and local execution trust level. Decide whether the local profile must avoid a database service. Those decisions determine SDK, storage, and packaging work.

## Proposed stages

### 1. Local vertical slice

Deliver one application using authenticated identity, durable work, one owner claim, a cancellable run, a harness, typed tools, durable output, and a compact history. No Kubernetes prerequisite. Choose one store and one harness; do not implement multiple alternatives by default.

### 2. AX profile

Run the same application and work contract through AX/Substrate. `folie up --profile ax` installs or validates kind/cluster prerequisites. Record what AX actually provides and test recovery, cancellation, resources, workspace, and egress rather than treating an interface as proof.

### 3. Harness comparison

Integrate Strands and Pi only far enough to compare the same workloads. If one harness clearly fits, keep it as default. Keep a second only if a user-facing application or experiment benefits enough to justify maintenance.

### 4. Applications and experiments

Build a second recipe (for example, a coding workflow) and try selected coordination patterns. Add schedules, teams, richer memory, verifiers, or extension processes only when an application needs them. Research adapters may be opt-in and explicitly unstable without requiring a formal maturity taxonomy.

## Initial acceptance evidence

1. A local user can install, configure a model, and complete the selected multi-session application without Kubernetes.
2. Server restart preserves work and outputs; worker termination cannot let stale work settle after a new claim.
3. The AX profile runs the same application and reports its trust and execution limits accurately.
4. A human can inspect work state, stop a run, and resume or retry without corrupting ownership.
5. The harness comparison reports correctness, tool errors, completion rate, latency, cost, and Folie-specific integration code for both a general task and a coding task.

Do not publish “hundreds of agents” or similar scale claims until a workload test defines active concurrency, write/event rate, latency, recovery time, and cost.

## Risks and unresolved decisions

- **Local trust:** is local execution intentionally trusted, or must Folie provide a real sandbox by default?
- **Store:** is a single SQLite store enough for the first deployment, or does the selected application require PostgreSQL concurrency now?
- **Work model:** does the first application need goal/task distinction, parentage, or dependencies?
- **Harness:** does Strands reduce Folie code without taking authority for durable state? Does Pi produce materially better coding results?
- **Sessions:** can Strands session persistence be reused as the conversation store, or does Folie need a small adapter to preserve one authoritative transcript?
- **SDK:** is TypeScript the simplest developer-facing composition path for the initial applications?

## Migration from current code and documents

Preserve code that implements these primitives correctly. Do not rewrite a module only to match new terminology. First map current services to the chosen work/run model and identify duplicated or unsupported machinery.

The old `spec/requirements.md`, protocols, interfaces, ADRs, and target architecture describe a larger prior design. After this proposal is reviewed, replace them with a small staged spec and keep an as-built reference. Until then, do not treat the old 96-requirement target as a rewrite checklist.
