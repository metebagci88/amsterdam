#!/usr/bin/env bash
# WP8 mutation suite wrapper (local throwaway PostgreSQL must be running: wp8_pg.sh start).
# Refuses production hosts. Sentinel WP8_MUTATION_PASS (printed by wp8_mutation.mjs).
set -uo pipefail
if [[ "${DATABASE_URL:-}${SUPABASE_DB_URL:-}${PGHOST:-}" == *supabase.co* ]]; then echo "REFUSED_PRODUCTION"; exit 1; fi
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wp8_mutation.mjs" "$@"
