#!/usr/bin/env bash
set -euo pipefail

if ! { [ -f .env ] && grep -q '^OPENROUTER_API_KEY=' .env; }; then
  if [ -n "${OPENROUTER_FLUE:-}" ]; then
    export OPENROUTER_API_KEY="$OPENROUTER_FLUE"
  fi
fi

exec npx flue "$@"
