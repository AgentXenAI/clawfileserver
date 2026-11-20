#!/usr/bin/env bash
# release-bump.sh — the ONLY sanctioned way to bump ClawFileServer versions.
# Sets the version in package.json AND openclaw.plugin.json together, then runs
# the harness (which includes manifest-consistency guards). Version drift
# between the two files has shipped three times; never hand-edit versions again.
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:?usage: scripts/release-bump.sh X.Y.Z}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z"; exit 1; }
node -e "
const fs = require('fs');
for (const f of ['package.json', 'openclaw.plugin.json']) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = '$V';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log(f + ' -> $V');
}
"
node test/harness.mjs | tail -1
echo "bump to $V complete — review, commit, and only then publish."
