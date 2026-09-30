#!/usr/bin/env bash
# Ephemeral local Postgres, two real backends. Production host refused.
# Proves parallel member upsert / insert does not duplicate the welcome seed.
set -euo pipefail

if [[ "${DATABASE_URL:-}${SUPABASE_DB_URL:-}${PGHOST:-}" == *supabase.co* ]]; then
  echo "REFUSED_PRODUCTION"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
SOCK="/var/run/postgresql"
DB="wse_ephemeral_conc_$$"
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
    -f - < "$sql_file" >/dev/null
}

runf "$REPO/CDP3D_package/gates/cdp3d_prereq_stub.sql"
runf "$REPO/CDP3D_package/CDP3D_up.sql"
runf "$ROOT/gates/wse_prereq_extra.sql"
runf "$ROOT/gates/wse_fixture.sql"
runf "$ROOT/WSE_up.sql"
runf "$ROOT/WSE_up.sql"

set +e
unarmed="$(runf "$ROOT/WSE_ACTIVATE.sql" 2>&1)"
unarmed_rc=$?
set -e
if [[ "$unarmed_rc" -eq 0 ]] || [[ "$unarmed" != *activation_refused_without_explicit_arm* ]]; then
  echo "CONCURRENCY_FAIL:unarmed"
  printf '%s\n' "$unarmed"
  exit 1
fi

run <<SQL >/dev/null
begin;
$(cat "$ROOT/gates/wse_arm.sql")
$(cat "$ROOT/WSE_ACTIVATE.sql")
commit;
SQL

eff="$(run -qtA -c "select effective_from from public.service_pref_defaults where pref_key='welcome_service_email' and default_enabled is true")"
if [[ -z "$eff" ]]; then
  echo "CONCURRENCY_FAIL:not_activated"
  exit 1
fi

legacy="$(run -qtA -c "select count(*) from public.member_service_pref_current where user_id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444')")"
if [[ "$legacy" != "2" ]]; then
  echo "CONCURRENCY_FAIL:legacy_after_activation:$legacy"
  exit 1
fi

U1="18181818-1818-4818-8818-181818181818"
run -c "insert into auth.users(id,email,created_at) values ('$U1','conc-secret@example.test', timestamptz '$eff' + interval '1 second')" >/dev/null
upsert="insert into public.members(user_id,email) values ('$U1','conc-secret@example.test') on conflict (user_id) do update set updated_at=clock_timestamp()"
pids=()
for _ in $(seq 1 12); do
  run -c "$upsert" >/tmp/wse_upsert.out 2>&1 &
  pids+=($!)
done
ok=0
for pid in "${pids[@]}"; do
  if wait "$pid"; then ok=$((ok+1)); fi
done
if [[ "$ok" != "12" ]]; then
  echo "CONCURRENCY_FAIL:upsert_exits:$ok"
  cat /tmp/wse_upsert.out || true
  exit 1
fi
cur="$(run -qtA -c "select count(*) from public.member_service_pref_current where user_id='$U1'")"
ev="$(run -qtA -c "select count(*) from public.member_service_pref_events where user_id='$U1' and source='signup'")"
if [[ "$cur" != "1" || "$ev" != "1" ]]; then
  echo "CONCURRENCY_FAIL:upsert_seed cur=$cur ev=$ev"
  exit 1
fi

U2="19191919-1919-4919-8919-191919191919"
run -c "insert into auth.users(id,email,created_at) values ('$U2','conc2-secret@example.test', timestamptz '$eff' + interval '2 seconds')" >/dev/null
ins="insert into public.members(user_id,email) values ('$U2','conc2-secret@example.test')"
pids=()
for _ in $(seq 1 8); do
  run -c "$ins" >/tmp/wse_ins.out 2>&1 &
  pids+=($!)
done
ok=0
for pid in "${pids[@]}"; do
  if wait "$pid"; then ok=$((ok+1)); fi
done
if [[ "$ok" != "1" ]]; then
  echo "CONCURRENCY_FAIL:insert_winner:$ok"
  cat /tmp/wse_ins.out || true
  exit 1
fi
cur="$(run -qtA -c "select count(*) from public.member_service_pref_current where user_id='$U2'")"
ev="$(run -qtA -c "select count(*) from public.member_service_pref_events where user_id='$U2' and source='signup'")"
if [[ "$cur" != "1" || "$ev" != "1" ]]; then
  echo "CONCURRENCY_FAIL:insert_seed cur=$cur ev=$ev"
  exit 1
fi

U3="20202020-2020-4202-8202-202020202020"
run -c "insert into auth.users(id,email,created_at) values ('$U3','old-conc-secret@example.test', timestamptz '$eff' - interval '30 days')" >/dev/null
oldins="insert into public.members(user_id,email) values ('$U3','old-conc-secret@example.test') on conflict (user_id) do update set updated_at=clock_timestamp()"
pids=()
for _ in $(seq 1 6); do
  run -c "$oldins" >/tmp/wse_old.out 2>&1 &
  pids+=($!)
done
ok=0
for pid in "${pids[@]}"; do
  if wait "$pid"; then ok=$((ok+1)); fi
done
if [[ "$ok" != "6" ]]; then
  echo "CONCURRENCY_FAIL:old_upsert_exits:$ok"
  exit 1
fi
cur="$(run -qtA -c "select count(*) from public.member_service_pref_current where user_id='$U3'")"
if [[ "$cur" != "0" ]]; then
  echo "CONCURRENCY_FAIL:old_auth_seeded:$cur"
  exit 1
fi

leak="$(run -qtA -c "select count(*) from public.member_service_pref_events where request_id like '%@%' or fingerprint like '%@%'")"
outbox="$(run -qtA -c "select count(*) from public.email_outbox")"
mkt="$(run -qtA -c "select count(*) from public.marketing_config where marketing_enabled or marketing_capture_enabled")"
if [[ "$leak" != "0" || "$outbox" != "0" || "$mkt" != "0" ]]; then
  echo "CONCURRENCY_FAIL:leak=$leak outbox=$outbox marketing=$mkt"
  exit 1
fi

echo "WSE_CONCURRENCY_PASS"
