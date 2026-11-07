#!/usr/bin/env bash
# Install folie for this machine: link the CLI onto PATH, install deps, init .env.
# Idempotent: safe to re-run. Run from the repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Bun required (the CLI runs via its bun shebang).
if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found. Install it: https://bun.sh/docs/installation" >&2
  exit 1
fi

# Install dependencies (needed before the CLI can run).
bun install

# Link the CLI onto PATH (no copy, no global package — package is private).
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/src/cli.ts" "$HOME/.local/bin/folie"
chmod +x "$ROOT/src/cli.ts" "$HOME/.local/bin/folie"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    echo "note: ~/.local/bin is not on PATH. Add to your shell rc:"
    echo '  export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac

# Init .env (gitignored) for the live run; never overwrites existing values.
if [ ! -f .env ]; then
  cat > .env <<'ENV'
FOLIE_AGENT_ENV_OPENROUTER_API_KEY=
FOLIE_AGENT_ENV_FOLIE_MODEL=openrouter/deepseek/deepseek-chat
ENV
  echo "wrote .env — fill in your OpenRouter key and model"
fi

# Verify.
hash -r 2>/dev/null || true
if command -v folie >/dev/null 2>&1; then
  echo "folie is on PATH: $(command -v folie)"
  folie __help__ 2>&1 | head -1 || true
  echo "next: fill .env, then  source .env && folie up"
else
  echo "folie linked at ~/.local/bin/folie — use it after updating PATH above"
fi
