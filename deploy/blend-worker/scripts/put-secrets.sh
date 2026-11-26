#!/usr/bin/env bash
set +x
set -euo pipefail
cd "$(dirname "$0")/.."
names=(ANTHROPIC_API_KEY XAI_API_KEY OPENCODE_API_KEY MUSE_API_KEY)
for name in "${names[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s\n' "$name" >&2
    exit 1
  fi
done
for name in "${names[@]}"; do
  printf '%s' "${!name}" | npx --no-install wrangler secret put "$name" --config wrangler.jsonc
done
