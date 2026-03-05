#!/usr/bin/env bash
# Fetch fresh Asset Hub Paseo runtime metadata via papi.
#
# Updates the metadata file used by the gateway resolver for
# SCALE encoding/decoding of ReviveApi_call parameters.
#
# Usage: npm run update-metadata

set -euo pipefail

echo "Updating Asset Hub Paseo metadata..."
npx papi update ah --skip-codegen

METADATA_FILE=".papi/metadata/ah.scale"
if [ ! -f "$METADATA_FILE" ]; then
  echo "ERROR: Metadata file not found at $METADATA_FILE"
  exit 1
fi

SIZE=$(wc -c < "$METADATA_FILE" | tr -d ' ')
echo "  Metadata updated: $(echo "scale=1; $SIZE / 1024" | bc) KB"
echo ""
echo "Done. Rebuild the app to use the new metadata."
