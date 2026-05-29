#!/usr/bin/env bash
# Concise wrapper around install_sources.sh — emits one summary line per source
# so the full output fits inside the install-demo terminal recording.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d coral/data/github ]]; then
  python3 scripts/generate_fixtures.py >/dev/null
fi

for f in coral/manifests/*.yaml; do
  name=$(basename "$f" .yaml)
  coral source remove "$name" >/dev/null 2>&1 || true
  tables=$(coral source add --file "$f" 2>&1 | grep -oE '\([0-9]+ tables?\)' | head -1)
  echo "  ✓ ${name} connected ${tables}"
done
echo "✓ 5 sources ready."
