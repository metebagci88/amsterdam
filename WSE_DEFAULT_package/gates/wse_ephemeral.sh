#!/usr/bin/env bash
# Throwaway local Postgres. Loads the inert migration, runs the matrix,
# rolls activation back, then applies the soft rollback for real.
# Refuses any Supabase host. Does not send mail.
set -euo pipefail

if [[ "${DATABASE_URL:-}${SUPABASE_DB_URL:-}${PGHOST:-}" == *supabase.co* ]]; then
  echo "REFUSED_PRODUCTION"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
SOCK="/var/run/postgresql"
DB="wse_ephemeral_suite_$$"
PSQL=(sudo -u postgres psql -h "$SOCK" -v ON_ERROR_STOP=1)

if ! sudo -u postgres pg_isready -h "$SOCK" -q; then
  sudo pg_ctlcluster 16 main start
fi

cleanup() {
  sudo -u postgres psql -h "$SOCK" -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists ${DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres psql -h "$SOCK" -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists ${DB};" >/dev/null
sudo -u postgres createdb -h "$SOCK" "$DB"

run() { "${PSQL[@]}" -d "$DB" "$@"; }
# Runner opens the SQL file. postgres never has to traverse the checkout.
runf() {
  local sql_file="$1"

  if [[ ! -r "$sql_file" ]]; then
    echo "GATE_FAILED:wse_sql_file_unreadable:$sql_file"
    return 1
  fi

  sudo -u postgres psql \
    -h "$SOCK" \
    -v ON_ERROR_STOP=1 \
    --single-transaction \
    -d "$DB" \
    -f - < "$sql_file"
}

runf "$REPO/CDP3D_package/gates/cdp3d_prereq_stub.sql" >/dev/null
runf "$REPO/CDP3D_package/CDP3D_up.sql" >/dev/null
runf "$ROOT/gates/wse_prereq_extra.sql" >/dev/null

before_read="$(run -qtA -c "select position('default_enabled' in pg_get_functiondef('public.consent_get_my_state()'::regprocedure))")"
if [[ "$before_read" == "0" ]]; then
  echo "EPHEMERAL_FAIL:old read path has no default fallback"
  exit 1
fi
before_decision="$(run -qtA -c "select md5(pg_get_functiondef('public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)'::regprocedure))")"

runf "$ROOT/gates/wse_fixture.sql" >/dev/null
runf "$ROOT/WSE_up.sql" >/dev/null
runf "$ROOT/WSE_up.sql" >/dev/null

after_decision="$(run -qtA -c "select md5(pg_get_functiondef('public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)'::regprocedure))")"
if [[ "$before_decision" != "$after_decision" ]]; then
  echo "EPHEMERAL_FAIL:send decision body changed"
  exit 1
fi
echo "PASS decision_function_unchanged"

inert="$(runf "$ROOT/gates/wse_inert_assert.sql")"
if [[ "$inert" != *WSE_INERT_PASS* ]]; then
  echo "EPHEMERAL_FAIL:inert"
  printf '%s\n' "$inert"
  exit 1
fi
echo "PASS WSE_INERT_PASS"

set +e
unarmed="$(runf "$ROOT/WSE_ACTIVATE.sql" 2>&1)"
unarmed_rc=$?
set -e
if [[ "$unarmed_rc" -eq 0 ]] || [[ "$unarmed" != *activation_refused_without_explicit_arm* ]]; then
  echo "EPHEMERAL_FAIL:unarmed"
  printf '%s\n' "$unarmed"
  exit 1
fi
fn="$(run -qtA -c "select to_regprocedure('public.admin_w_activate_welcome_service_email_default(uuid,text,text,uuid)') is null")"
pol="$(run -qtA -c "select default_enabled is null and effective_from is null from public.service_pref_defaults where pref_key='welcome_service_email'")"
if [[ "$fn" != "t" || "$pol" != "t" ]]; then
  echo "EPHEMERAL_FAIL:unarmed wrote state fn=$fn pol=$pol"
  exit 1
fi
echo "PASS activation_refused_without_arm"

armed="$(run <<SQL
begin;
$(cat "$ROOT/gates/wse_arm.sql")
$(cat "$ROOT/WSE_ACTIVATE.sql")
$(cat "$ROOT/gates/wse_behavior.sql")
$(cat "$ROOT/WSE_down_soft.sql")
$(cat "$ROOT/gates/wse_after_down.sql")
rollback;
SQL
)"
if [[ "$armed" != *WSE_BEHAVIOR_PASS* || "$armed" != *WSE_AFTER_DOWN_PASS* ]]; then
  echo "EPHEMERAL_FAIL:armed"
  printf '%s\n' "$armed"
  exit 1
fi
echo "PASS WSE_BEHAVIOR_PASS"
echo "PASS WSE_AFTER_DOWN_PASS"

still="$(run -qtA -c "select default_enabled is null and effective_from is null from public.service_pref_defaults where pref_key='welcome_service_email'")"
trig="$(run -qtA -c "select count(*) from pg_trigger where tgname='trg_members_seed_welcome_service_pref' and not tgisinternal")"
if [[ "$still" != "t" || "$trig" != "1" ]]; then
  echo "EPHEMERAL_FAIL:activation persisted still=$still trig=$trig"
  exit 1
fi
echo "PASS activation_not_persisted"

runf "$ROOT/WSE_down_soft.sql" >/dev/null
# This file has its own BEGIN/ROLLBACK probe, so it stays outside --single-transaction.
# stdin still keeps postgres from opening the checkout path.
if [[ ! -r "$ROOT/gates/wse_post_down_assert.sql" ]]; then
  echo "GATE_FAILED:wse_sql_file_unreadable:$ROOT/gates/wse_post_down_assert.sql"
  exit 1
fi
post="$(run -f - < "$ROOT/gates/wse_post_down_assert.sql")"
if [[ "$post" != *WSE_DOWN_PASS* ]]; then
  echo "EPHEMERAL_FAIL:post-down"
  printf '%s\n' "$post"
  exit 1
fi
echo "PASS WSE_DOWN_PASS"

set +e
late="$(run <<SQL 2>&1
begin;
$(cat "$ROOT/gates/wse_arm.sql")
$(cat "$ROOT/WSE_ACTIVATE.sql")
rollback;
SQL
)"
late_rc=$?
set -e
if [[ "$late_rc" -eq 0 ]] || [[ "$late" != *activation_requires_seed_trigger* ]]; then
  echo "EPHEMERAL_FAIL:trigger guard"
  printf '%s\n' "$late"
  exit 1
fi
clear="$(run -qtA -c "select bool_and(default_enabled is null and effective_from is null) from public.service_pref_defaults")"
if [[ "$clear" != "t" ]]; then
  echo "EPHEMERAL_FAIL:policy left set"
  exit 1
fi
echo "PASS activation_requires_seed_trigger"
echo "WSE_EPHEMERAL_GATES_PASS"
