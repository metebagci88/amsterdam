#!/usr/bin/env bash
# Yerel/geçici Supabase stack üzerinde CDP-3B gate ortamını hazırlar (PRODUCTION DEĞİL).
# psql çıktısı stdout'a KARIŞMAZ (log dosyasına). Yalnız $1 dosyasına KEY=value env satırları yazar (GITHUB_ENV uyumlu).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL gerekli}"
: "${JWT_SECRET:?JWT_SECRET gerekli}"
: "${EMAIL_API_URL:?EMAIL_API_URL gerekli}"
OUT="${1:-/tmp/gate_env}"; LOG="/tmp/ci_setup_psql.log"; : > "$LOG"
SUP="11111111-0000-0000-0000-0000000000a1"   # super_admin
CRM="11111111-0000-0000-0000-0000000000c1"   # crm

# 1) baseline (admin altyapısı) + CDP3B_up.sql — sessiz, çıktı log'a
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/gates/baseline_fixture.sql" >>"$LOG" 2>&1
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/CDP3B_up.sql"                 >>"$LOG" 2>&1
# 2) test kullanıcıları + roller + iki bucket (sessiz)
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q >>"$LOG" 2>&1 <<SQL
insert into auth.users(id,instance_id,aud,role,email,created_at,updated_at) values
 ('$SUP','00000000-0000-0000-0000-000000000000','authenticated','authenticated','sup@e2e.test',now(),now()),
 ('$CRM','00000000-0000-0000-0000-000000000000','authenticated','authenticated','crm@e2e.test',now(),now())
 on conflict do nothing;
insert into public.admin_users(user_id) values ('$SUP'),('$CRM') on conflict do nothing;
insert into public.admin_roles(user_id,role) values ('$SUP','super_admin'),('$CRM','crm') on conflict do nothing;
insert into storage.buckets(id,name,public) values
 ('email-assets-draft','email-assets-draft',false),('email-assets-public','email-assets-public',true)
 on conflict (id) do nothing;
SQL

# 3) baseline PREFLIGHT: gerekli nesneler var mı? yoksa GATE_FAILED:baseline_missing
MISS="$(psql "$SUPABASE_DB_URL" -tA -c "select count(*) from (values ('admin_users'),('admin_roles'),('admin_write_ops'),('admin_write_log'),('admin_settings'),('email_templates'),('email_template_versions'),('email_assets'),('email_version_assets')) t(n) where to_regclass('public.'||n) is null")"
if [ "${MISS//[[:space:]]/}" != "0" ]; then echo "GATE_FAILED:baseline_missing"; exit 3; fi
FNMISS="$(psql "$SUPABASE_DB_URL" -tA -c "select count(*) from (values ('_admin_active'),('_admin_has_role'),('_admin_writes_enabled'),('_email_fp'),('admin_w_email_publish')) t(n) where to_regproc('public.'||n) is null")"
if [ "${FNMISS//[[:space:]]/}" != "0" ]; then echo "GATE_FAILED:baseline_missing"; exit 3; fi

# 4) yalnız KEY=value env satırları (psql çıktısı YOK)
{
  echo "SUPABASE_DB_URL=$SUPABASE_DB_URL"
  echo "EMAIL_API_URL=$EMAIL_API_URL"
  echo "SUPER_JWT=$(deno run "$ROOT/gates/mint_jwt.ts" "$SUP" "$JWT_SECRET")"
  echo "CRM_JWT=$(deno run "$ROOT/gates/mint_jwt.ts" "$CRM" "$JWT_SECRET")"
  echo "SERVICE_KEY=${SERVICE_KEY:-}"
} > "$OUT"
echo "ci_setup OK (env -> $OUT; psql log -> $LOG)" 1>&2
