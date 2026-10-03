#!/usr/bin/env bash
# Run a command with the project environment:
#   - load .env if present (built servers and CLI runs do not load it themselves)
#   - fall back to $OPENROUTER_FLUE when no OPENROUTER_API_KEY is configured
set -euo pipefail

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${OPENROUTER_FLUE:-}" ]; then
  export OPENROUTER_API_KEY="$OPENROUTER_FLUE"
fi

exec "$@"
