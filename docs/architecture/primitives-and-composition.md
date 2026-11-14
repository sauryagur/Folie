# Primitives and application composition

Status: proposed with the architecture reset, 2026-11-12.

## Product boundary

Folie is a programmable runtime, not a finished assistant or a required organizational chart. Developers should be able to build different agent applications using a small set of shared primitives. The first application demonstrates that the primitives are useful; it does not define the whole product.

The programming model is the key unresolved design choice. The first version should choose one primary composition path—preferably a TypeScript library over Folie's local runtime API—with the HTTP API as the transport boundary and a CLI for operators. Avoid simultaneously promising a declarative application DSL, arbitrary plugins, and multiple SDKs.

## Minimum runtime primitives

Start with only the following concepts:

### Principal

A human, worker, or system component authenticated by the runtime. Identity comes from credentials, not request fields. A worker cannot impersonate another worker or grant itself authority.

### Work record

A durable unit of intent and result. Begin with the fields demanded by the first application: description/input, state, owner, attempt, output/evidence, and timestamps. Add parent/child work, dependencies, revisions, deadlines, and acceptance contracts only as the application requires them.

Do not unify goals and tasks simply to reduce nouns. A generic record with many optional fields and conditional state rules can be more complex than two small types. Model the first workload and choose the simpler representation from that evidence.

### Claim

At most one active owner per work item. If runs may overlap or restart, claims need expiry and a monotonically increasing fence so stale work cannot settle after reassignment. This is core because it prevents a concrete coordination failure.

### Run

One cancellable execution of a worker against a work item. Agent identity outlives a run; the process does not. Folie records the run's outcome and enough events to explain what occurred. The harness may manage its internal conversation, but must not become the authority for Folie's work state.

### Tool and output

A tool is an operation available to an agent. An output is a durable result or evidence item associated with work. Tools are typed, and external effects requiring Folie permissions go through Folie's authenticated API. Use filesystem outputs locally first; add remote artifact storage when shared deployment requires it.

Messages, schedules, teams, memory services, and verification workflows may be useful. Add them when the first application establishes their semantics; do not make them universal runtime machinery preemptively.

## Authority and extension boundary

Folie owns identity, work transitions, ownership/fencing, cancellation requests, and durable settlement. A harness owns model interaction and local orchestration inside one run. An execution backend owns process/container placement. These are responsibilities, not a mandate to create one interface per noun.

Maintain only the seam justified by multiple execution backends (local and AX/Substrate) and the seam needed to run a harness inside those backends. Other interfaces should be introduced when a second real implementation or a necessary isolation boundary exists.

## Composition shape

A first application should be expressible as ordinary code that:

1. registers or selects an agent configuration;
2. submits durable work;
3. supplies a harness, toolset, and execution profile;
4. observes run events and outputs;
5. handles completion, failure, or human intervention.

The runtime should not require application authors to understand Kubernetes, AX, database schemas, or internal worker loops. Advanced applications may configure those components explicitly.

## Deferred until a workload proves need

- Goal/task graph semantics beyond a parent and child.
- Teams, voting, bidding, offers, reputation, and capability ratings.
- General policy languages and large risk taxonomies.
- Vector stores, knowledge graphs, and automatic memory consolidation.
- Generic third-party extension lifecycle or marketplace.
- Multiple simultaneous database and messaging implementations.
