#!/usr/bin/env bash
# ASALOCAL · CDP-3B · apply-öncesi ZORUNLU kapılar. FAIL-CLOSED.
# Çıktı YALNIZ: "LOCAL_GATES_PASS_STAGING_PENDING" (hepsi geçti) veya "GATE_FAILED:<gate>" (herhangi biri).
# Hiçbir zaman "ALL GATES PASS" yazmaz. Production'a DOKUNMAZ (yalnız yerel/geçici stack + geçici DB).
#
# Gerekli ortam değişkenleri:
#   SUPABASE_DB_URL  : geçici/yerel Postgres (rollback dry-run + baseline preflight + fault injection).
#   EMAIL_API_URL    : yerel serve edilen email-api
#   SUPER_JWT/CRM_JWT: test kullanıcılarının access_token'ları
#   SERVICE_KEY      : yerel service_role anahtarı (Gate6 fault injection / Gate9 reconcile fault için)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
GATE=""; LOGF="/tmp/cdp3b_gate_step.log"; : > "$LOGF"
run(){ GATE="$1"; shift; echo "== gate:$GATE ==" >>"$LOGF"; "$@" >>"$LOGF" 2>&1; }
fail(){ echo "GATE_FAILED:$1"; exit 1; }
# set -e + trap: beklenmedik hata da temiz "GATE_FAILED:<son-gate>" verir; log kuyruğu stderr'e.
trap 'rc=$?; if [ $rc -ne 0 ]; then echo "GATE_FAILED:${GATE:-unknown}"; echo "--- son 40 satır ($GATE) ---" 1>&2; tail -n 40 "$LOGF" 1>&2 || true; fi' ERR

# ---- GATE sha: paket bütünlüğü ----
GATE="sha256sums"
[ -f SHA256SUMS ] || fail "sha256sums_missing"
sha256sum -c SHA256SUMS >/dev/null 2>&1 || fail "sha256sums_mismatch"

# ---- GATE sanitizer: canonical SHA ----
GATE="sanitizer_sha"
EXPECT="bc60ffede60a2e64f905146be0e32f3bf375bf5824eb96d3734225eaa71493d2"
GOT="$(sha256sum edge/email-api/email_sanitizer.js | cut -d' ' -f1)"
[ "$GOT" = "$EXPECT" ] || fail "sanitizer_sha"

# ---- GATE 1/2/3: Deno ----
GATE="deno"; command -v deno >/dev/null 2>&1 || fail "deno_missing"
GATE="deno_check";  deno check edge/email-api/index.ts               >>"$LOGF" 2>&1 || fail "deno_check"
GATE="deno_test";   deno test --allow-net edge/email-api/test_sanitizer_deno.ts >>"$LOGF" 2>&1 || fail "deno_test"
GATE="deno_bundle"; deno bundle edge/email-api/index.ts >/dev/null 2>>"$LOGF"      || fail "deno_bundle"

# ---- GATE db_url: gerekli ----
GATE="db_url"; [ -n "${SUPABASE_DB_URL:-}" ] || { echo "GATE_FAILED:gate9_blocked_no_db_url"; exit 1; }

# ---- GATE baseline: admin altyapısı + email şeması gerçekten mevcut mu (yoksa baseline_missing) ----
GATE="baseline"
BMISS="$(psql "$SUPABASE_DB_URL" -tA -c "select count(*) from (values ('admin_users'),('admin_roles'),('admin_write_ops'),('admin_write_log'),('admin_settings'),('email_templates'),('email_template_versions'),('email_assets'),('email_version_assets')) t(n) where to_regclass('public.'||n) is null" 2>>"$LOGF" || echo 99)"
[ "$(echo "$BMISS" | tr -d '[:space:]')" = "0" ] || { echo "GATE_FAILED:baseline_missing"; exit 1; }

# ---- GATE 9: rollback dry-run (GERÇEK psql; geçici DB, ayrı transaction) ----
GATE="gate9"
G9="$(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -tA <<SQL 2>>"$LOGF"
begin;
\\i CDP3B_up.sql
\\i CDP3B_down.sql
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name like 'email\\_%')
 +(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%email%' and p.proname ~ '^(_email|admin_[qw]_email)')
 +(select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgname like 'trg_email%') as leftover;
rollback;
SQL
)" || fail "gate9_psql"
[ "$(echo "$G9" | tr -d '[:space:]')" = "0" ] || fail "gate9_leftover_${G9}"

# ---- GATE 4-9(e2e): gerçek Edge/Storage/DB assertion testleri ----
GATE="staging_env"
if [ -z "${EMAIL_API_URL:-}" ] || [ -z "${SUPER_JWT:-}" ] || [ -z "${CRM_JWT:-}" ]; then fail "staging_env"; fi
GATE="e2e"
deno test --allow-net --allow-env gates/e2e_gates.ts >>"$LOGF" 2>&1 || fail "gate_e2e"

# ---- GATE 8b: admin.html emOpen/_emAssets/emSave (jsdom, gerçek fonksiyonlar) ----
GATE="admin_reopen"; command -v node >/dev/null 2>&1 || fail "node_missing"
node gates/admin_reopen_test.mjs >>"$LOGF" 2>&1 || fail "admin_reopen"

trap - ERR
echo "LOCAL_GATES_PASS_STAGING_PENDING"
exit 0
