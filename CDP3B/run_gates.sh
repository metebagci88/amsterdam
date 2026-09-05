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
EXPECT="11490786a1d5de4f685c0db25f9555af56cc95611c5e2f6ea09fc8cf15592bf9"
GOT="$(sha256sum edge/email-api/email_sanitizer.js | cut -d' ' -f1)"
[ "$GOT" = "$EXPECT" ] || fail "sanitizer_sha"

# ---- GATE 1/2: Deno (check + sanitizer test) ----
GATE="deno"; command -v deno >/dev/null 2>&1 || fail "deno_missing"
deno --version >>"$LOGF" 2>&1 || true   # teşhis: kurulu Deno sürümü (secret içermez)
GATE="deno_check";  deno check edge/email-api/index.ts               >>"$LOGF" 2>&1 || fail "deno_check"
GATE="deno_test";   deno test --allow-net edge/email-api/test_sanitizer_deno.ts >>"$LOGF" 2>&1 || fail "deno_test"
# NOT: eski 'deno bundle' gate'i KALDIRILDI. Deno 1.46.3 'bundle' alt-komutu node: specifier'larını
# desteklemiyor (deno#15960) ve Supabase istemci grafiği node:buffer kullanıyor -> yanıltıcı hata.
# Edge derleme/çalışma kanıtı artık aşağıdaki authenticated 'edge_runtime' gate'idir (serve edilen
# gerçek email-api'ye 200 taxonomy çağrısı). Tip/derleme denetimi zaten 'deno check' ile yapılır.

# ---- GATE db_url: gerekli ----
GATE="db_url"; [ -n "${SUPABASE_DB_URL:-}" ] || { echo "GATE_FAILED:gate9_blocked_no_db_url"; exit 1; }

# ---- GATE baseline: admin altyapısı + email şeması gerçekten mevcut mu (yoksa baseline_missing) ----
GATE="baseline"
BMISS="$(psql "$SUPABASE_DB_URL" -tA -c "select count(*) from (values ('admin_users'),('admin_roles'),('admin_write_ops'),('admin_write_log'),('admin_settings'),('email_templates'),('email_template_versions'),('email_assets'),('email_version_assets')) t(n) where to_regclass('public.'||n) is null" 2>>"$LOGF" || echo 99)"
[ "$(echo "$BMISS" | tr -d '[:space:]')" = "0" ] || { echo "GATE_FAILED:baseline_missing"; exit 1; }

# ---- GATE 9: rollback dry-run (GERÇEK psql; geçici DB, ayrı transaction) ----
GATE="gate9"
G9="$(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -qAt <<SQL 2>>"$LOGF"
begin;
\\i CDP3B_up.sql
\\i CDP3B_patch_asset_preview_up.sql
\\i CDP3B_patch_asset_preview_down.sql
\\i CDP3B_down.sql
select '__CDP3B_GATE9_LEFTOVER__=' || (
    (select count(*) from information_schema.tables where table_schema='public' and table_name like 'email\\_%')
   +(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%email%' and p.proname ~ '^(_email|admin_[qw]_email)')
   +(select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgname like 'trg_email%')
 );
rollback;
SQL
)" || fail "gate9_psql"
printf '%s\n' "$G9" >> "$LOGF"   # ham psql çıktısı teşhis için; başarıda YALNIZ parse edilen sonuç kullanılır
# Benzersiz sentinel ile fail-closed: yalnız '^__CDP3B_GATE9_LEFTOVER__=[0-9]+$' satırı kabul (genel sayı arama / tail / varsayılan 0 YOK).
G9_RE='^__CDP3B_GATE9_LEFTOVER__=[0-9]+$'
G9_N="$(printf '%s\n' "$G9" | grep -Ec "$G9_RE" || true)"
if [ "$G9_N" -eq 0 ]; then fail "gate9_result_missing"; fi
if [ "$G9_N" -gt 1 ]; then fail "gate9_result_ambiguous"; fi
G9_SENT="$(printf '%s\n' "$G9" | grep -E "$G9_RE")"
G9_VAL="${G9_SENT#__CDP3B_GATE9_LEFTOVER__=}"
[ "$G9_VAL" = "0" ] || fail "gate9_leftover_${G9_VAL}"

# ---- GATE 4-9(e2e): gerçek Edge/Storage/DB assertion testleri ----
GATE="staging_env"
if [ -z "${EMAIL_API_URL:-}" ] || [ -z "${SUPER_JWT:-}" ] || [ -z "${CRM_JWT:-}" ]; then fail "staging_env"; fi

# ---- GATE edge_runtime: serve edilen GERÇEK email-api'ye authenticated taxonomy (Edge derleme/çalışma kanıtı) ----
# Başarı: HTTP tam 200 + geçerli JSON + 'error' alanı YOK. 401/400/500/parse edilemeyen -> PASS DEĞİL.
# Token/JWT ASLA loglanmaz; body maskelenir. (Anonim readiness loop yalnız 'port ayağa kalktı' beklemesidir.)
GATE="edge_runtime"
ER_CODE="$(curl -s -o /tmp/edge_probe_body.json -w '%{http_code}' -X POST "$EMAIL_API_URL" \
  -H 'content-type: application/json' -H "Authorization: Bearer ${SUPER_JWT}" \
  -d '{"action":"taxonomy"}' || echo 000)"
edge_fail(){
  { echo "== edge_runtime FAIL: $1 http=$ER_CODE =="
    echo "-- response body (maskelenmiş) --"
    sed -E 's/[A-Za-z0-9._-]{24,}/<redacted>/g' /tmp/edge_probe_body.json 2>/dev/null | head -c 800; echo
    echo "-- serve.log kuyruğu --"; tail -n 30 /tmp/serve.log 2>/dev/null; } >>"$LOGF" 2>&1
  fail "edge_runtime"
}
[ "$ER_CODE" = "200" ] || edge_fail "http_not_200"
# geçerli JSON + 'error' alanı YOK (node parse; exit 3=parse hatası, 4='error' var, 0=ok)
if node -e 'const fs=require("fs");let b;try{b=JSON.parse(fs.readFileSync("/tmp/edge_probe_body.json","utf8"))}catch(e){process.exit(3)}process.exit(b&&typeof b==="object"&&Object.prototype.hasOwnProperty.call(b,"error")?4:0)' 2>>"$LOGF"; then
  echo "edge_runtime OK (http=200, geçerli JSON, error yok)" >>"$LOGF"
else
  ER_RC=$?
  case "$ER_RC" in 3) edge_fail "invalid_json";; 4) edge_fail "response_has_error";; *) edge_fail "probe_unknown_${ER_RC}";; esac
fi

GATE="e2e"
deno test --allow-net --allow-env gates/e2e_gates.ts >>"$LOGF" 2>&1 || fail "gate_e2e"

# ---- GATE 8b: admin.html emOpen/_emAssets/emSave (jsdom, gerçek fonksiyonlar) ----
GATE="admin_reopen"; command -v node >/dev/null 2>&1 || fail "node_missing"
node gates/admin_reopen_test.mjs >>"$LOGF" 2>&1 || fail "admin_reopen"

# ---- GATE 8c: admin.html emSerializeCanonical/emSwapToPreview GERÇEK GrapesJS component modeli (jsdom) ----
# Kanıt: kaydet serileştirmesi source_html+builder_json'da signed/draft/token/data-asa-id=0; STATE KAYBI YOK
# (aynı component kimliği); reopen project/component/style korur; deterministik; TTL refresh; foreign img laundering YOK.
GATE="gjs_serialize"
node gates/gjs_serialize_test.mjs >>"$LOGF" 2>&1 || fail "gjs_serialize"

trap - ERR
echo "LOCAL_GATES_PASS_STAGING_PENDING"
exit 0
