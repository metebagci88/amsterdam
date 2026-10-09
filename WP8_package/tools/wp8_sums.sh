#!/usr/bin/env bash
# Regenerates WP8_package/SHA256SUMS (every file in WP8_package except SHA256SUMS and node_modules).
# Verify with: (cd WP8_package && sha256sum -c SHA256SUMS)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
find . -type f ! -name SHA256SUMS ! -path '*/node_modules/*' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS
echo "WP8_SUMS_OK files=$(wc -l < SHA256SUMS)"
