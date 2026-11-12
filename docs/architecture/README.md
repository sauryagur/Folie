# Architecture reset proposal

These documents propose a smaller, local-first architecture for Folie as a programmable agent runtime. They supersede the previous target for design discussion, but do not describe implemented behavior or create implementation requirements by themselves.

| Document | Question answered |
|---|---|
| [`primitives-and-composition.md`](primitives-and-composition.md) | What must Folie own, and how does an application compose it? |
| [`harnesses-and-extensions.md`](harnesses-and-extensions.md) | Should Folie use Strands or Pi, and what is a tool versus a plugin? |
| [`deployment-and-stack.md`](deployment-and-stack.md) | What is the simple default, and how does AX/Substrate fit? |
| [`roadmap-and-validation.md`](roadmap-and-validation.md) | What is the first application and how do we validate the design? |
| [`build-plan.md`](build-plan.md) | What complete product states will the implementation deliver, and what choices gate each one? |

The as-built system remains described in [`../../architecture/current-system.md`](../../architecture/current-system.md). The older requirements, protocols, and ADRs are retained as prior-design material until this proposal is reviewed and a smaller normative specification is agreed.
