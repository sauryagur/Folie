# Runs harness — E1–E6 evidence

No E1–E6 has been run (see `../e1-e6-close-out.md`). Every run lands here first, as
`docs/runs/<date>-e<N>/` — never in a pastebin, never uncommitted. A recording
that cannot be reproduced is not evidence.

## Layout (create each dir by copying this template)

```
docs/runs/<date>-e<N>/
  config.yaml   # recorded configuration (the only way to claim E1–E6)
  ledger.jsonl  # full event ledger dump, failures included
  notes.md      # what happened, what broke, what was fixed after
```

## `config.yaml` (required fields)

```yaml
run: 2026-11-08-e1
demo: E1
git_sha: <commit>
server_image: <FOLIE_SERVER_IMAGE>
agent_image: <FOLIE_AGENT_IMAGE>
substrate: <ax/substrate versions or commit>
model_provider: <provider/model>
seed_agents: <n>
budget: { dim: usd, limit: ... }
goal:
  acceptance: <criteria text or hash>
  held_out: <goal id>
```

## Rules

- Record failures, retries, and overrides. A run with failures, honestly recorded,
  still counts as a run; it does not count as a pass.
- `ledger.jsonl` is the source of truth for claims (goal evaluation comes from
  verified coverage, not from prose).
- Do not mark an E-demonstration met until its required config fields are
  present and the ledger shows the acceptance path end to end.

## Starting a run

1. `folie up` (live cluster), seed the goal/budget, run the scenario.
2. `./docs/runs/capture.sh E<N>` — writes `config.yaml` (git SHA prefilled) and
   `ledger.jsonl` (event stream dump) into `docs/runs/<date>-e<N>/`.
3. Fill the `<fill ...>` fields in `config.yaml` and the `notes.md` template.
4. Commit the directory. No directory committed, no claim.

Ready-to-copy templates live in `docs/runs/_template-e{1..6}/`.
