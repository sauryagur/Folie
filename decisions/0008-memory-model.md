# ADR 0008: Scoped immutable memory with provenance; goal knowledge distinct from agent memory

Status: proposed 2026-11-04. Revises Decision 11 (memory is files) and Decision 16 (artifact bytes stay in `/workspace`). Architecture: [`../architecture/agents-and-execution.md`](../architecture/agents-and-execution.md#memory).

## Context

Today an agent's memory is files in `/workspace`, which `DeleteTask` destroys; artifact registration stores a hash and path while the bytes stay in that directory (a known cost of Decision 16). There is no provenance, no scoping, no sharing, no contradiction handling, and nothing prevents context from leaking between goals except that sessions start empty. Long-running, multi-goal, multi-agent work needs durable memory with ownership and access control that is not a growing transcript.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Files in the workspace (today) | Simple; agents already use them | Destroyed on retirement or loss; no provenance, ACL or sharing |
| B. Summarize transcripts into a rolling memory | Easy to build | Compounding summarization loss; no provenance; contamination across goals |
| C. A vector store only | Good semantic recall | Opaque; poor provenance and ACL; contradiction handling absent |
| D. **Scoped, immutable entries with provenance and links, in Postgres (full-text first), plus a content-addressed artifact store** | Auditable; scope and ACL enforced in one query path; consistent with the single-writer design | Retrieval quality is only as good as full-text until embeddings are justified ([OQ4](README.md#open-architectural-questions)) |

## Decision

Option D.

- **Scopes**: `agent` (owner only), `task`/`goal` (participants), `team` (members), `swarm` (grant). The **default scope of a write is the goal**; writing to agent scope is explicit.
- **Boundary**: agent memory is about the agent (skills, lessons, preferences); goal knowledge is about the world of one goal. **Cross-goal retrieval returns only agent entries marked `portable`.** Promotion upward needs provenance and, at swarm scope, a passed verification or a human approval.
- **Entries are immutable.** Contradiction writes a `contradicts` link, sets both `contested`, and the runtime proposes a `reconcile` task; resolution is a new `supersedes` entry with evidence. Retrieval never silently picks a side.
- **Artifacts**: bytes go to the artifact store (content-addressed; a filesystem volume first, S3-compatible later) through `artifact_put`; the workspace becomes scratch space.
- **Access control** is enforced inside `MemoryStore.query`; there is no unfiltered read.
- **The transcript is not memory.** It is evidence and a debugging record and is never replayed to a model.

## Consequences

- Retiring an execution no longer loses outputs; losing a workspace loses scratch only.
- Memory poisoning (an agent writing persuasive falsehoods) is a recognised risk ([OQ10](README.md#open-architectural-questions)); provenance, contested links, promotion gates and independent verification are the controls, not prevention.
- `artifact_register` is replaced by `artifact_put`; existing `artifact` events remain readable as history.
- Cost: the artifact store is new infrastructure for `folie up` (a volume on the server pod).
