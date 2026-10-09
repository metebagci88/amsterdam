#!/usr/bin/env bash
# WP8 gate helpers (sourced). Local throwaway PostgreSQL only; refuses Supabase hosts.
# WP8_ROOT overrides the repo root (the mutation suite points it at a patched copy).
if [[ "${DATABASE_URL:-}${SUPABASE_DB_URL:-}${PGHOST:-}" == *supabase.co* ]]; then
  echo "REFUSED_PRODUCTION"; exit 1
fi
WP8_GATES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WP8_ROOT="${WP8_ROOT:-$(cd "$WP8_GATES/../.." && pwd)}"
WP8_PG_PORT="${WP8_PG_PORT:-55432}"
WP8_TMP="${WP8_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/wp8gate.XXXXXX")}"
export WP8_ROOT WP8_PG_PORT WP8_TMP
PSQLX=(psql -h 127.0.0.1 -p "$WP8_PG_PORT" -U postgres -X -v ON_ERROR_STOP=1 -q)

wp8_psql() { local db="$1"; shift; PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning" "${PSQLX[@]}" -d "$db" "$@"; }
wp8_psql_notice() { local db="$1"; shift; "${PSQLX[@]}" -d "$db" "$@"; }
wp8_newdb() { wp8_psql postgres -c "drop database if exists $1 with (force)" -c "create database $1" >/dev/null; }
wp8_dropdb() { wp8_psql postgres -c "drop database if exists $1 with (force)" >/dev/null 2>&1 || true; }

# usage: wp8_load_chain <db> <raw|norm>
wp8_load_chain() {
  local db="$1" mode="$2" cdp3d="$WP8_ROOT/CDP3D_package/CDP3D_up.sql"
  if [[ "$mode" == "norm" ]]; then
    python3 -I "$WP8_ROOT/WP8_package/tools/wp8_normalize.py" "$cdp3d" > "$WP8_TMP/cdp3d_norm.sql"
    cdp3d="$WP8_TMP/cdp3d_norm.sql"
  fi
  python3 -I "$WP8_GATES/wp8_cdp3c_fns.py" "$WP8_ROOT" > "$WP8_TMP/cdp3c_fns.sql"
  wp8_psql "$db" -1 -f "$WP8_ROOT/CDP3D_package/gates/cdp3d_prereq_stub.sql" >/dev/null
  wp8_psql "$db" -1 -f "$cdp3d" >/dev/null
  wp8_psql "$db" -1 -f "$WP8_ROOT/WSE_DEFAULT_package/gates/wse_prereq_extra.sql" >/dev/null
  wp8_psql "$db" -1 -f "$WP8_ROOT/WSE_DEFAULT_package/WSE_up.sql" >/dev/null
  wp8_psql "$db" -1 -f "$WP8_GATES/wp8_ci_baseline.sql" >/dev/null
  wp8_psql "$db" -1 -f "$WP8_TMP/cdp3c_fns.sql" >/dev/null
}
wp8_fixture() { wp8_psql "$1" -1 -f "$WP8_GATES/wp8_fixture_pre.sql" >/dev/null; }
# usage: wp8_apply <db>  -> prints the apply output; fails unless WP8_UP_OK is reported
wp8_apply() {
  local out
  out="$(wp8_psql_notice "$1" -1 -f "$WP8_ROOT/WP8_package/db/WP8_DB_up.sql" 2>&1)" || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out" | grep -q 'WP8_UP_OK' || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out" | grep -o 'WP8_UP_OK[^"]*' | head -1
}

# Behaviour suite in one transaction that is rolled back. Prints PASS/FAIL lines and BEHAVIOR_COUNT.
WP8_BEHAVIOR_EXPECTED=179
wp8_behavior() {
  { echo "begin;"; echo "\\o /dev/null"; cat "$WP8_GATES/wp8_behavior.sql"; echo "\\o";
    echo "select (case when pass then 'PASS ' else 'FAIL ' end) || name || coalesce(' :: ' || info, '') from wp8_t order by seq;";
    echo "select 'BEHAVIOR_COUNT pass=' || count(*) filter (where pass) || ' fail=' || count(*) filter (where not pass) from wp8_t;";
    echo "rollback;"; } | wp8_psql "$1" -tA 2>&1
}
# Read-only single-SELECT asserts.
wp8_ro() { PGOPTIONS="-c default_transaction_read_only=on" wp8_psql "$1" -tA -f "$2"; }
# Owner setup template with placeholders replaced (CI rehearsal only).
wp8_setup_file() {
  local step="$1" label="${2:-NONE}" user="${3:-00000000-0000-0000-0000-000000000000}" out="$WP8_TMP/setup_${1}_${2:-x}.sql"
  sed -e 's/@@ARM_YES@@/YES/' -e "s/@@STEP@@/$step/" -e 's/@@SUPER_ADMIN_UUID@@/0000000a-0000-4000-8000-00000000a001/' \
      -e "s/@@QA_LABEL@@/$label/" -e "s/@@QA_USER_UUID@@/$user/" "$WP8_ROOT/WP8_package/db/WP8_DB_owner_setup.sql" > "$out"
  echo "$out"
}
