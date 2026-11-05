# ADR 0007: Execution gateway, vaulted credentials, trust profiles, hierarchical budgets, LLM proxy

Status: proposed 2026-11-04. Narrows Decision 6 (full trust); extends Decision 19 ("policy outside the sandbox"). Specification: [`../architecture/governance-and-resources.md`](../architecture/governance-and-resources.md); protocols §11–§12.

## Context

Decision 6 chose full-trust egress and tools for the first slice, with the brakes being delete, suspend, rotate and quiesce. That is defensible for a prototype that holds nothing valuable. A general-purpose system will hold real accounts and spend real money, and it must not let an agent grant itself authority or evade a limit. "Enforcement below the LLM" has to live somewhere agents cannot reach, without making the sandbox unusable. Today budgets are recorded, not enforced (D11), and the LLM key lives in the sandbox env.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Keep full trust everywhere | Zero friction | Exfiltration, key abuse and unmediated external effects are possible; not acceptable beyond a prototype |
| B. Restrict sandbox tools by prompt or per-tool wrappers inside the sandbox | Cheap | Enforcement inside the thing being constrained; prompts are not a boundary |
| C. **Keep the sandbox permissive by profile; route external effects and model calls through server-side gateways that hold credentials and enforce policy and budgets** | Enforcement outside agent reach; agents keep their autonomy over the sandbox; credentials never enter it | Gateway is on the path of every external effect; model streaming through a proxy is work |
| D. Fully deny-by-default sandbox for everything | Strongest | Breaks most useful work (package installs, web reads) |

## Decision

Option C.

- **Trust profiles** (`dev-full-trust`, `restricted`, `gateway-only`) select the sandbox network policy and gateway behaviour; today's behaviour is `dev-full-trust`, explicitly named and explicitly unsafe for anything of value.
- **Execution gateway** for every effect outside the sandbox: authenticate, check claim and fence (again at dispatch), validate, policy, approval, budget reserve, write-ahead journal, dispatch with a scoped short-lived credential and an idempotency key, reconcile `unknown` outcomes, audit.
- **Risk classes R0–R7** are properties of tool definitions; R4+ require approval by default; R7 is prohibited without an independent safety attestation. A model's output is never an authorization.
- **Credentials** live in a vault; sandboxes hold only the agent token (and the LLM key until the proxy exists). The LLM key is the one long-lived secret in the sandbox, and a **Folie LLM proxy** that holds it is the step that gives model spend an enforcement point and removes it from the sandbox.
- **Budgets** are hierarchical per dimension with delegation as carve-out; reservations pre-authorize known costs; actual usage commits and may overrun, with the overrun bounded and recorded. Enforcement tiers are stated per dimension (E0 record, E1 cooperative per-turn cutoff, E2 gateway-enforced) and no document says "enforced" without the tier.
- Spawning and delegating both require a carve-out ([ADR 0002](0002-agents-request-capacity.md)).

## Consequences

- Until the gateway and egress boundary are in force, no conforming deployment may provide an external account credential or external-write tool to an agent.
- The `dev-full-trust` profile preserves the prototype's unrestricted egress but is explicitly nonconforming; conforming deployments use `restricted` or `gateway-only` and deny direct sandbox writes. The gateway is the only route for external writes and account credentials.
- Honest limits: effects already dispatched cannot be recalled; the model-provider key may remain in the sandbox only under the recorded R-12.5 deviation and then model-spend enforcement is E1; Substrate's egress is hostname rules on web ports only, so private-destination filtering and the in-cluster Folie exception require deployment-specific verification ([egress notes](../architecture/current-system.md#sandbox-egress-a-substrate-dependency), [OQ3](README.md#open-architectural-questions)).
- Stopping the server is explicitly not a kill switch; the real stop mechanisms and their latencies are specified ([protocols §13](../spec/protocols.md#13-human-intervention)).
