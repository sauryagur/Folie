#!/usr/bin/env bash
# Capture one E1-E6 run into docs/runs/<date>-eN/. Usage:
#   FOLIE_SERVER_URL=http://127.0.0.1:8080 FOLIE_OPERATOR_TOKEN=... ./docs/runs/capture.sh E1
# Writes config.yaml (git SHA + server now) and ledger.jsonl (full stream dump).
set -euo pipefail
N="${1:?usage: capture.sh <E1..E6>}"
DATE="$(date +%F)"
DIR="docs/runs/${DATE}-e${N#E}"
mkdir -p "$DIR"
GIT_SHA="$(git rev-parse --short HEAD)"
cat > "$DIR/config.yaml" <<YAML
run: ${DATE}-e${N#E}
demo: ${N}
git_sha: ${GIT_SHA}
server_image: "<fill FOLIE_SERVER_IMAGE>"
agent_image: "<fill FOLIE_AGENT_IMAGE>"
substrate: "<fill ax/substrate commit>"
model_provider: "<fill provider/model>"
seed_agents: 2
budget: { dim: usd, limit: 0 }
goal:
  acceptance: "<fill criteria>"
  held_out: "<fill goal id>"
YAML
: > "$DIR/ledger.jsonl"
if [ -n "${FOLIE_SERVER_URL:-}" ] && [ -n "${FOLIE_OPERATOR_TOKEN:-}" ]; then
  curl -sH "Authorization: Bearer $FOLIE_OPERATOR_TOKEN" "$FOLIE_SERVER_URL/v1/stream?limit=100000" >> "$DIR/ledger.jsonl"
else
  echo "no FOLIE_SERVER_URL/TOKEN: ledger left empty, fill config by hand" >&2
fi
echo "captured to $DIR"
