#!/usr/bin/env bash
# Fetch fresh chain specs from live RPC nodes and merge into local specs.
#
# Each relay chain spec gets a fresh lightSyncState checkpoint, which
# reduces smoldot sync time from ~12s to ~1-3s on repeat builds.
#
# Usage: npm run update-chain-specs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SPECS_DIR="$PROJECT_DIR/packages/resolver/src/chain-specs"

# Merge inline script: takes fresh sync_state_genSyncSpec result on stdin,
# argv[1] = path to local spec file to merge into.
# PASEO_RAW / previewnet response can be ~17MB so we pipe via stdin instead
# of passing as a CLI argument.
MERGE_JS='
const fs = require("fs");
const net = require("net");

const skipBootnodeCheck = process.env.SKIP_BOOTNODE_CHECK === "true";

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
  const specPath = process.argv[1];
  const specName = specPath.split("/").pop();
  const currentSpec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const freshResult = JSON.parse(stdin);
  const freshSpec = freshResult.result || freshResult;

  currentSpec.lightSyncState = freshSpec.lightSyncState;

  if (skipBootnodeCheck) {
    console.log("  Bootnode health check SKIPPED — keeping existing bootnodes.");
    console.log("  Boot nodes (unchanged): " + currentSpec.bootNodes.length);
  } else {
    const newBootNodes = freshSpec.bootNodes || [];
    if (newBootNodes.length === 0) {
      console.log("  Fresh spec returned no bootnodes — keeping existing.");
      console.log("  Boot nodes (unchanged): " + currentSpec.bootNodes.length);
    } else {
      console.log("  Testing " + newBootNodes.length + " bootnodes (5s timeout each)...");
      const results = await Promise.all(newBootNodes.map((bn) => testBootnode(bn)));
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
      console.log("  Healthy: " + healthy.length + "/" + newBootNodes.length);
      if (healthy.length === 0) {
        console.log("  WARNING: No healthy bootnodes found — keeping original.");
      } else {
        currentSpec.bootNodes = healthy;
      }
    }
  }

  fs.writeFileSync(specPath, JSON.stringify(currentSpec));
  const size = fs.statSync(specPath).size;
  console.log("  Updated " + specName + ": " + (size / 1024).toFixed(1) + " KB");
  console.log("  Boot nodes: " + currentSpec.bootNodes.length);
});
'

refresh_spec() {
  local spec_file="$1"
  local timeout="$2"
  shift 2

  echo "Fetching fresh $spec_file..."
  local raw=""
  for rpc in "$@"; do
    echo "  Trying $rpc ..."
    raw=$(curl -s --max-time "$timeout" \
      -H "Content-Type: application/json" \
      -d '{"id":1, "jsonrpc":"2.0", "method":"sync_state_genSyncSpec", "params":[true]}' \
      "$rpc" 2>/dev/null || true)

    if echo "$raw" | jq -e '.result.lightSyncState' >/dev/null 2>&1; then
      echo "  Success from $rpc"
      break
    else
      echo "  Failed or no lightSyncState from $rpc"
      raw=""
    fi
  done

  if [ -z "$raw" ]; then
    echo "ERROR: Could not fetch $spec_file from any RPC endpoint."
    return 1
  fi

  echo "$raw" | bun -e "$MERGE_JS" "$SPECS_DIR/$spec_file"
  echo ""
}

refresh_spec "paseo.smol.json" 15 \
  "https://paseo.dotters.network" \
  "https://paseo.rpc.amforc.com" \
  "https://rpc.ibp.network/paseo"

refresh_spec "previewnet.smol.json" 60 \
  "https://previewnet.substrate.dev/relay/alice"

echo "Done. Chain specs updated in packages/resolver/src/chain-specs/"
echo "Rebuild the app to use the new specs."
