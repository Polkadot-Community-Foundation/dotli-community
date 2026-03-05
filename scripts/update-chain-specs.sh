#!/usr/bin/env bash
# Fetch fresh chain specs from live RPC nodes and merge into local specs.
#
# The Paseo relay chain spec gets a fresh lightSyncState checkpoint,
# which reduces smoldot sync time from ~12s to ~1-3s on repeat builds.
#
# Usage: npm run update-chain-specs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SPECS_DIR="$PROJECT_DIR/src/chain-specs"

# RPC endpoints (fallback order)
PASEO_RPCS=(
  "https://paseo.dotters.network"
  "https://paseo.rpc.amforc.com"
  "https://rpc.ibp.network/paseo"
)

echo "Fetching fresh Paseo relay chain spec..."

PASEO_RAW=""
for rpc in "${PASEO_RPCS[@]}"; do
  echo "  Trying $rpc ..."
  PASEO_RAW=$(curl -s --max-time 15 \
    -H "Content-Type: application/json" \
    -d '{"id":1, "jsonrpc":"2.0", "method":"sync_state_genSyncSpec", "params":[true]}' \
    "$rpc" 2>/dev/null || true)

  if echo "$PASEO_RAW" | jq -e '.result.lightSyncState' >/dev/null 2>&1; then
    echo "  Success from $rpc"
    break
  else
    echo "  Failed or no lightSyncState from $rpc"
    PASEO_RAW=""
  fi
done

if [ -z "$PASEO_RAW" ]; then
  echo "ERROR: Could not fetch Paseo chain spec from any RPC endpoint."
  exit 1
fi

# Merge: take current local spec (compact genesis), update lightSyncState + bootNodes from fresh
node -e '
const fs = require("fs");
const currentSpec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const freshResult = JSON.parse(process.argv[2]);
const freshSpec = freshResult.result || freshResult;

currentSpec.lightSyncState = freshSpec.lightSyncState;
currentSpec.bootNodes = freshSpec.bootNodes;

fs.writeFileSync(process.argv[1], JSON.stringify(currentSpec));
const size = fs.statSync(process.argv[1]).size;
console.log("  Updated paseo.json: " + (size / 1024).toFixed(1) + " KB");
console.log("  Boot nodes: " + currentSpec.bootNodes.length);
' "$SPECS_DIR/paseo.json" "$PASEO_RAW"

echo ""
echo "Done. Chain specs updated in src/chain-specs/"
echo "Rebuild the app to use the new specs."
