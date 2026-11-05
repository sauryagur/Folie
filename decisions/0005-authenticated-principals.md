# ADR 0005: Per-execution bearer tokens; identity comes from the token only

Status: proposed 2026-11-04. Closes finding D1; qualifies Decision 2. Specification: [`../spec/protocols.md`](../spec/protocols.md) §1.

## Context

folie-server's HTTP API is unauthenticated (D1). `from`, `agent` and the agent path segment are caller-supplied, so any process that can reach the server can send as any agent, ack another agent's mail, report for it, and suspend or delete any agent. Fencing tokens, budgets, grants and audit all assume the caller is who it says it is; without authentication none of them means anything. The previous text called the message table "forge-proof", which it is not.

## Options

| Option                                                                                          | For                                                                                                                            | Against                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| A. Network trust (today)                                                                        | Nothing to build                                                                                                               | Any pod or sandbox can impersonate anyone; unacceptable for a general-purpose system      |
| B. Workload identity from Substrate/atenet (mTLS or injected source-actor header)               | No secret in the sandbox                                                                                                       | Not verified to exist ([OQ1](README.md#open-architectural-questions)); couples auth to AX |
| C. **Opaque bearer token per execution, injected through `spec.env`, stored hashed, revocable** | Works with what ax offers (the LLM key already travels this way); instant revocation by generation bump; no new infrastructure | A secret in the sandbox environment; revocation latency from the resolution cache         |
| D. Signed JWT per execution                                                                     | Stateless verification                                                                                                         | Revocation needs a deny list anyway; key management                                       |

## Decision

Option C. The controller mints a token per execution and injects `FOLIE_AGENT_TOKEN` (hash stored in `api_tokens`, bound to `agent`, `execution_id` and the agent's `credential_generation`). The server resolves the token on every request (cache ≤ 5 s) and derives the principal from it; body fields naming a caller must match or are rejected. Operators use API keys with roles; extensions use their own principal. Operator routes reject agent tokens. Rotating `credential_generation` or retiring the agent invalidates every token of the agent.

## Consequences

- A compromised sandbox can act as _its own agent_ until revoked, and as no other agent. This is the honest bound of option C.
- Revocation latency is stated (≤ 5 s) wherever kill-switch behaviour is described.
- Fencing and the execution epoch now mean something: tokens bind an execution, so a zombie process from a lost execution is rejected once the execution is marked `lost`.
- If workload identity (OQ1) proves available, it replaces token resolution behind the same `Principal` type; nothing above the auth layer changes.
- Migration: tokens are optional behind a flag for one release (bodies still accepted and checked); then required; API v2 drops the body fields.
