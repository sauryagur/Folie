# Instructions for coding agents

## Start here

1. Read [`DESIGN.md`](DESIGN.md) for the current architecture proposal.
2. Read [`docs/architecture/README.md`](docs/architecture/README.md) to find the relevant proposal document.
3. Read [`HANDOFF.md`](HANDOFF.md) for repository status and the distinction between the proposal and the existing code.

## Which documents are authoritative

- The architecture reset is the current design direction. The user's active request authorizes building toward it, but it is not a command to rewrite every existing module. Use `docs/architecture/build-plan.md` for the approved implementation path and decision defaults once that plan is added.
- [`architecture/current-system.md`](architecture/current-system.md) is a dated as-built snapshot, not a live audit. Inspect the current code before making claims about implementation behavior.
- [`spec/`](spec/), [`decisions/`](decisions/), and the other files under [`architecture/`](architecture/) are historical descriptions of the previous target. Their old `MUST` requirements, ADRs, E1–E6 gates, and implementation queue are not active instructions unless the user explicitly asks to work on that legacy design.
- [`docs/research/folie-architecture-reset-draft.md`](docs/research/folie-architecture-reset-draft.md) is superseded. Use the organized proposal under [`docs/architecture/`](docs/architecture/) instead.

## Working rules

- Follow the user's current request. The active project-build request authorizes implementation. Resolve open proposal choices using the implementation plan's defaults and evidence gates; ask only if a decision changes the user's stated direction or causes an irreversible external effect.
- Build in coherent end-to-end iterations: each iteration should leave an integrated, usable product state. Plan the whole destination, but do not split work into disconnected framework layers or revive the old E1–E6 ticket queue.
- Prefer the smallest useful primitive and the simplest implementation that satisfies a demonstrated need. Complexity, extra services, interfaces, profiles, and dependencies must justify their maintenance cost.
- Reuse existing libraries and code when their semantics fit; do not rebuild a primitive merely to match a preferred architecture.
- Keep proposals distinct from facts. Label assumptions, unresolved decisions, and unverified behavior. Do not claim AX/Substrate isolation guarantees, performance, or live validation without evidence.
- Do not implement a candidate option solely because it appears in the proposal. Follow the implementation plan's choices and evidence gates; keep alternatives out of the shipped path until they earn their maintenance cost.
- Before editing, inspect the relevant code and the working tree. Preserve unrelated user changes. Do not run tests unless the user asks for verification or the task requires it.

## Current design direction

Folie is being reconsidered as a programmable runtime and set of primitives for building agent applications, starting with the simplest useful application. Sensible defaults and optional advanced/research paths matter; optional execution through AX/Substrate should not make cluster infrastructure mandatory by default. See [`DESIGN.md`](DESIGN.md) and the architecture proposal for nuance and unresolved decisions.
