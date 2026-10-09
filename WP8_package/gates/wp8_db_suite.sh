#!/usr/bin/env bash
# Wraps wp8_db_suite.mjs with a fresh local database (CI chain normalized + fixture + WP8 applied).
set -uo pipefail
source "$(dirname "$0")/wp8_lib.sh"
DB="wp8_db_$$"
trap 'wp8_dropdb "$DB"; rm -rf "$WP8_TMP"' EXIT
set -e
wp8_newdb "$DB"; wp8_load_chain "$DB" norm; wp8_fixture "$DB"; wp8_apply "$DB" >/dev/null
set +e
DBURL="postgresql://postgres@127.0.0.1:${WP8_PG_PORT}/${DB}" node "$WP8_GATES/wp8_db_suite.mjs"
