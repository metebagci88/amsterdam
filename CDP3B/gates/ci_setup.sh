#!/usr/bin/env bash
# Yerel/geçici Supabase stack üzerinde CDP-3B gate ortamını hazırlar (PRODUCTION DEĞİL).
# GERÇEK GoTrue kullanıcıları + gerçek password-session access_token'ları üretir (elle JWT YOK).
# Sırlar (parola/token/anon/service) LOGLANMAZ; GitHub'da ::add-mask:: ile maskelenir. curl -v / set -x YOK.
# Yalnız $1 dosyasına KEY=value env satırları yazar (GITHUB_ENV uyumlu); bu dosya ARTIFACT'a dahil edilmez.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL gerekli}"
: "${EMAIL_API_URL:?EMAIL_API_URL gerekli}"
: "${API_URL:?API_URL gerekli}"
: "${ANON_KEY:?ANON_KEY gerekli}"
: "${SERVICE_KEY:?SERVICE_KEY (service_role) gerekli}"
OUT="${1:-/tmp/gate_env}"; LOG="/tmp/ci_setup_psql.log"; : > "$LOG"
GT="$API_URL/auth/v1"
TMP_CREATE_SUP=/tmp/gt_sup_create.json; TMP_CREATE_CRM=/tmp/gt_crm_create.json
TMP_TOK_SUP=/tmp/gt_sup_tok.json;       TMP_TOK_CRM=/tmp/gt_crm_tok.json
TMP_USER_SUP=/tmp/gt_sup_user.json;     TMP_USER_CRM=/tmp/gt_crm_user.json
# save-draft yetki matrisi: MEMBER (GoTrue kullanıcısı, admin_users satırı YOK) + ANALYST (admin, salt-okunur rol)
TMP_CREATE_MEM=/tmp/gt_mem_create.json; TMP_CREATE_ANA=/tmp/gt_ana_create.json
TMP_TOK_MEM=/tmp/gt_mem_tok.json;       TMP_TOK_ANA=/tmp/gt_ana_tok.json
TMP_USER_MEM=/tmp/gt_mem_user.json;     TMP_USER_ANA=/tmp/gt_ana_user.json
cleanup(){ rm -f "$TMP_CREATE_SUP" "$TMP_CREATE_CRM" "$TMP_TOK_SUP" "$TMP_TOK_CRM" "$TMP_USER_SUP" "$TMP_USER_CRM" \
  "$TMP_CREATE_MEM" "$TMP_CREATE_ANA" "$TMP_TOK_MEM" "$TMP_TOK_ANA" "$TMP_USER_MEM" "$TMP_USER_ANA"; }
trap cleanup EXIT

# node ile güvenli JSON alan çıkarımı (fd 0'dan okur)
jget(){ node -e 'const fs=require("fs");let o;try{o=JSON.parse(fs.readFileSync(0,"utf8"))}catch(e){process.exit(0)}let v=o;for(const k of process.argv[1].split(".")){v=v&&v[k]}process.stdout.write(v==null?"":String(v))' "$1"; }

# 1) Şema: baseline (admin altyapısı) + CDP3B_up.sql — sessiz, çıktı log'a
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/gates/baseline_fixture.sql" >>"$LOG" 2>&1
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/CDP3B_up.sql"                 >>"$LOG" 2>&1
# CDP-3B PATCH: taslak görsel önizleme yetki-kapısı RPC'si (additive; asset_preview e2e için gerekli)
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/CDP3B_patch_asset_preview_up.sql" >>"$LOG" 2>&1

# 2) Benzersiz e-postalar + güçlü geçici parolalar (loglanmaz; maskeli)
SUFFIX="ci$(date +%s)$$${RANDOM}"
SUP_EMAIL="super_${SUFFIX}@e2e.local"
CRM_EMAIL="crm_${SUFFIX}@e2e.local"
MEM_EMAIL="member_${SUFFIX}@e2e.local"
ANA_EMAIL="analyst_${SUFFIX}@e2e.local"
SUP_PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 22)Aa1!"
CRM_PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 22)Bb2!"
MEM_PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 22)Cc3!"
ANA_PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 22)Dd4!"
printf '::add-mask::%s\n' "$SUP_PW"
printf '::add-mask::%s\n' "$CRM_PW"
printf '::add-mask::%s\n' "$MEM_PW"
printf '::add-mask::%s\n' "$ANA_PW"

# 3) GoTrue Admin API ile kullanıcıları oluştur (email_confirm=true). auth.users SQL insert YOK.
create_user(){ # $1 email $2 pw $3 out.json -> HTTP code (fail-closed)
  curl -s -o "$3" -w '%{http_code}' -X POST "$GT/admin/users" \
    -H "Authorization: Bearer ${SERVICE_KEY}" -H "apikey: ${SERVICE_KEY}" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\",\"email_confirm\":true}"
}
C1="$(create_user "$SUP_EMAIL" "$SUP_PW" "$TMP_CREATE_SUP" || echo 000)"
{ [ "$C1" = "200" ] || [ "$C1" = "201" ]; } || { echo "GATE_FAILED:auth_user_create_super_${C1}"; exit 1; }
C2="$(create_user "$CRM_EMAIL" "$CRM_PW" "$TMP_CREATE_CRM" || echo 000)"
{ [ "$C2" = "200" ] || [ "$C2" = "201" ]; } || { echo "GATE_FAILED:auth_user_create_crm_${C2}"; exit 1; }
C3="$(create_user "$MEM_EMAIL" "$MEM_PW" "$TMP_CREATE_MEM" || echo 000)"
{ [ "$C3" = "200" ] || [ "$C3" = "201" ]; } || { echo "GATE_FAILED:auth_user_create_member_${C3}"; exit 1; }
C4="$(create_user "$ANA_EMAIL" "$ANA_PW" "$TMP_CREATE_ANA" || echo 000)"
{ [ "$C4" = "200" ] || [ "$C4" = "201" ]; } || { echo "GATE_FAILED:auth_user_create_analyst_${C4}"; exit 1; }
SUP_ID="$(jget id < "$TMP_CREATE_SUP")"; CRM_ID="$(jget id < "$TMP_CREATE_CRM")"
MEM_ID="$(jget id < "$TMP_CREATE_MEM")"; ANA_ID="$(jget id < "$TMP_CREATE_ANA")"
[ -n "$SUP_ID" ] || { echo "GATE_FAILED:auth_user_create_super_no_id"; exit 1; }
[ -n "$CRM_ID" ] || { echo "GATE_FAILED:auth_user_create_crm_no_id"; exit 1; }
[ -n "$MEM_ID" ] || { echo "GATE_FAILED:auth_user_create_member_no_id"; exit 1; }
[ -n "$ANA_ID" ] || { echo "GATE_FAILED:auth_user_create_analyst_no_id"; exit 1; }
[ "$(printf '%s\n' "$SUP_ID" "$CRM_ID" "$MEM_ID" "$ANA_ID" | sort -u | wc -l | tr -d ' ')" = "4" ] || { echo "GATE_FAILED:auth_user_ids_not_distinct"; exit 1; }

# 4) admin_users/admin_roles seed'i GERÇEK GoTrue UUID'leriyle + iki bucket + admin yazımları açık (sessiz)
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q >>"$LOG" 2>&1 <<SQL
insert into public.admin_users(user_id) values ('$SUP_ID'),('$CRM_ID'),('$ANA_ID') on conflict do nothing;
insert into public.admin_roles(user_id,role) values ('$SUP_ID','super_admin'),('$CRM_ID','crm'),('$ANA_ID','analyst') on conflict do nothing;
-- MEMBER ($MEM_ID) bilerek admin_users'a EKLENMEZ (normal üye; email-api admin action'larına 403 almalı)
insert into public.admin_settings(key,bool_value) values ('admin_writes_enabled', true)
  on conflict (key) do update set bool_value=excluded.bool_value;
insert into storage.buckets(id,name,public) values
 ('email-assets-draft','email-assets-draft',false),('email-assets-public','email-assets-public',true)
 on conflict (id) do nothing;
SQL

# 5) Password grant ile GERÇEK access_token (apikey: ANON_KEY). Fail-closed.
get_token(){ # $1 email $2 pw $3 out.json -> HTTP code
  curl -s -o "$3" -w '%{http_code}' -X POST "$GT/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}
T1="$(get_token "$SUP_EMAIL" "$SUP_PW" "$TMP_TOK_SUP" || echo 000)"
[ "$T1" = "200" ] || { echo "GATE_FAILED:auth_token_super_${T1}"; exit 1; }
T2="$(get_token "$CRM_EMAIL" "$CRM_PW" "$TMP_TOK_CRM" || echo 000)"
[ "$T2" = "200" ] || { echo "GATE_FAILED:auth_token_crm_${T2}"; exit 1; }
T3="$(get_token "$MEM_EMAIL" "$MEM_PW" "$TMP_TOK_MEM" || echo 000)"
[ "$T3" = "200" ] || { echo "GATE_FAILED:auth_token_member_${T3}"; exit 1; }
T4="$(get_token "$ANA_EMAIL" "$ANA_PW" "$TMP_TOK_ANA" || echo 000)"
[ "$T4" = "200" ] || { echo "GATE_FAILED:auth_token_analyst_${T4}"; exit 1; }
SUPER_JWT="$(jget access_token < "$TMP_TOK_SUP")"; CRM_JWT="$(jget access_token < "$TMP_TOK_CRM")"
MEMBER_JWT="$(jget access_token < "$TMP_TOK_MEM")"; ANALYST_JWT="$(jget access_token < "$TMP_TOK_ANA")"
[ -n "$SUPER_JWT" ]   || { echo "GATE_FAILED:auth_token_super_no_access_token"; exit 1; }
[ -n "$CRM_JWT" ]     || { echo "GATE_FAILED:auth_token_crm_no_access_token"; exit 1; }
[ -n "$MEMBER_JWT" ]  || { echo "GATE_FAILED:auth_token_member_no_access_token"; exit 1; }
[ -n "$ANALYST_JWT" ] || { echo "GATE_FAILED:auth_token_analyst_no_access_token"; exit 1; }
printf '::add-mask::%s\n' "$SUPER_JWT"
printf '::add-mask::%s\n' "$CRM_JWT"
printf '::add-mask::%s\n' "$MEMBER_JWT"
printf '::add-mask::%s\n' "$ANALYST_JWT"
[ "$(printf '%s\n' "$SUPER_JWT" "$CRM_JWT" "$MEMBER_JWT" "$ANALYST_JWT" | sort -u | wc -l | tr -d ' ')" = "4" ] || { echo "GATE_FAILED:auth_tokens_not_distinct"; exit 1; }

# 6) /auth/v1/user ile token doğrula: HTTP 200 + user.id == oluşturulan id (fail-closed)
verify_user(){ # $1 token $2 out.json -> HTTP code
  curl -s -o "$2" -w '%{http_code}' "$GT/user" -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer $1"
}
V1="$(verify_user "$SUPER_JWT" "$TMP_USER_SUP" || echo 000)"
[ "$V1" = "200" ] || { echo "GATE_FAILED:auth_user_verify_super_${V1}"; exit 1; }
V2="$(verify_user "$CRM_JWT" "$TMP_USER_CRM" || echo 000)"
[ "$V2" = "200" ] || { echo "GATE_FAILED:auth_user_verify_crm_${V2}"; exit 1; }
V3="$(verify_user "$MEMBER_JWT" "$TMP_USER_MEM" || echo 000)"
[ "$V3" = "200" ] || { echo "GATE_FAILED:auth_user_verify_member_${V3}"; exit 1; }
V4="$(verify_user "$ANALYST_JWT" "$TMP_USER_ANA" || echo 000)"
[ "$V4" = "200" ] || { echo "GATE_FAILED:auth_user_verify_analyst_${V4}"; exit 1; }
VID1="$(jget id < "$TMP_USER_SUP")"; VID2="$(jget id < "$TMP_USER_CRM")"
VID3="$(jget id < "$TMP_USER_MEM")"; VID4="$(jget id < "$TMP_USER_ANA")"
[ "$VID1" = "$SUP_ID" ] || { echo "GATE_FAILED:auth_user_verify_super_id_mismatch"; exit 1; }
[ "$VID2" = "$CRM_ID" ] || { echo "GATE_FAILED:auth_user_verify_crm_id_mismatch"; exit 1; }
[ "$VID3" = "$MEM_ID" ] || { echo "GATE_FAILED:auth_user_verify_member_id_mismatch"; exit 1; }
[ "$VID4" = "$ANA_ID" ] || { echo "GATE_FAILED:auth_user_verify_analyst_id_mismatch"; exit 1; }

# 7) Baseline PREFLIGHT: gerekli nesneler + fonksiyonlar var mı? yoksa GATE_FAILED:baseline_missing
MISS="$(psql "$SUPABASE_DB_URL" -tA -c "select count(*) from (values ('admin_users'),('admin_roles'),('admin_write_ops'),('admin_write_log'),('admin_settings'),('email_templates'),('email_template_versions'),('email_assets'),('email_version_assets')) t(n) where to_regclass('public.'||n) is null")"
[ "${MISS//[[:space:]]/}" = "0" ] || { echo "GATE_FAILED:baseline_missing"; exit 1; }
FNMISS="$(psql "$SUPABASE_DB_URL" -tA -c "select count(*) from (values ('_admin_active'),('_admin_has_role'),('_admin_writes_enabled'),('_email_fp'),('admin_w_email_publish'),('admin_q_email_asset_preview')) t(n) where to_regproc('public.'||n) is null")"
[ "${FNMISS//[[:space:]]/}" = "0" ] || { echo "GATE_FAILED:baseline_missing"; exit 1; }

# 8) Yalnız KEY=value env satırları ($OUT; ARTIFACT'a dahil DEĞİL). Token değerleri stdout'a YAZILMAZ.
{
  echo "SUPABASE_DB_URL=$SUPABASE_DB_URL"
  echo "EMAIL_API_URL=$EMAIL_API_URL"
  echo "SUPER_JWT=$SUPER_JWT"
  echo "CRM_JWT=$CRM_JWT"
  echo "SERVICE_KEY=$SERVICE_KEY"
  # save-draft kapıları (e2e_save_draft.ts + admin_save_draft_ui.mjs); parola/token'lar yukarıda ::add-mask:: edildi
  echo "MEMBER_JWT=$MEMBER_JWT"
  echo "ANALYST_JWT=$ANALYST_JWT"
  echo "CRM_UID=$CRM_ID"
  echo "MEMBER_UID=$MEM_ID"
  echo "ANALYST_UID=$ANA_ID"
  echo "CRM_EMAIL=$CRM_EMAIL"
  echo "CRM_PW=$CRM_PW"
} > "$OUT"
echo "ci_setup OK (gerçek GoTrue token'ları; env -> $OUT; psql log -> $LOG)" 1>&2
