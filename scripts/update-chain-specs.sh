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

# Merge: take current local spec (compact genesis), update lightSyncState + bootNodes from fresh.
# Tests each bootnode via TCP connect and only keeps healthy ones.
# Note: PASEO_RAW is too large for a CLI argument, so we pipe it via stdin.
echo "$PASEO_RAW" | node -e '
const fs = require("fs");
const net = require("net");

function parseMultiaddr(ma) {
  const parts = ma.split("/").filter(Boolean);
  let host = null, port = null;
  for (let i = 0; i < parts.length; i++) {
    if (["dns", "dns4", "dns6"].includes(parts[i]) && parts[i + 1]) {
      host = parts[i + 1];
    } else if (parts[i] === "ip4" && parts[i + 1]) {
      host = parts[i + 1];
    } else if (parts[i] === "tcp" && parts[i + 1]) {
      port = parseInt(parts[i + 1], 10);
    }
  }
  return { host, port };
}

function testBootnode(ma, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const { host, port } = parseMultiaddr(ma);
    if (!host || !port) {
      resolve({ ma, healthy: false, reason: "unparseable" });
      return;
    }
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve({ ma, healthy: true });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ma, healthy: false, reason: "timeout" });
    });
    socket.on("error", (err) => {
      socket.destroy();
      resolve({ ma, healthy: false, reason: err.code || err.message });
    });
  });
}

let stdin = "";
process.stdin.on("data", (chunk) => stdin += chunk);
process.stdin.on("end", async () => {
  const currentSpec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const freshResult = JSON.parse(stdin);
  const freshSpec = freshResult.result || freshResult;

  currentSpec.lightSyncState = freshSpec.lightSyncState;

  const bootNodes = freshSpec.bootNodes || [];
  console.log("  Testing " + bootNodes.length + " bootnodes (5s timeout each)...");

  const results = await Promise.all(bootNodes.map((bn) => testBootnode(bn)));
  const healthy = [];
  for (const r of results) {
    const short = r.ma.length > 80 ? r.ma.substring(0, 77) + "..." : r.ma;
    if (r.healthy) {
      console.log("    ✓ " + short);
      healthy.push(r.ma);
    } else {
      console.log("    ✗ " + short + " (" + r.reason + ")");
    }
  }

  console.log("  Healthy: " + healthy.length + "/" + bootNodes.length);

  if (healthy.length === 0) {
    console.log("  WARNING: No healthy bootnodes found — keeping all original bootnodes.");
    currentSpec.bootNodes = bootNodes;
  } else {
    currentSpec.bootNodes = healthy;
  }

  fs.writeFileSync(process.argv[1], JSON.stringify(currentSpec));
  const size = fs.statSync(process.argv[1]).size;
  console.log("  Updated paseo.json: " + (size / 1024).toFixed(1) + " KB");
  console.log("  Boot nodes: " + currentSpec.bootNodes.length);
});
' "$SPECS_DIR/paseo.json"

echo ""
echo "Done. Chain specs updated in src/chain-specs/"
echo "Rebuild the app to use the new specs."
