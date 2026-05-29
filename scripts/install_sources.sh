#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v coral >/dev/null; then
  echo "✗ coral CLI not found. Install: brew install withcoral/tap/coral"
  exit 1
fi

if [[ ! -d coral/data/github ]]; then
  echo "→ generating synthetic fixtures..."
  python3 scripts/generate_fixtures.py
fi

for f in coral/manifests/*.yaml; do
  name=$(basename "$f" .yaml)
  echo "→ installing $name"
  coral source remove "$name" 2>/dev/null || true
  coral source add --file "$f"
done

echo
echo "✓ Spyglass sources installed. Try:"
echo '  coral sql "SELECT COUNT(*) FROM reefline_github.pulls"'
