#!/usr/bin/env bash
# =====================================================================
# SEC-MEDIA · STAGE 2 · gates/s2_psql_gate.sh
# Gerçek (yerel, geçici) Postgres sunucusu + psql ile S2 paketini production'daki
# çalıştırma biçimiyle (psql -1 -v ON_ERROR_STOP=1) test eder. PGlite gate'ini tamamlar:
# psql yolunu, -c "set local ..." + -f arming kalıbını ve hosted SQL dosyalarını gerçek
# sunucuda koşturur. Supabase host'larını reddeder; ağ/production yok; secret okumaz.
# Satır 20 (storage.objects dışı tüm policy'ler) production literaliyle yerelde eşleşemez (25 uygulama
# policy'si burada yok) -> "env satırı": yerel PRE değeri kaydedilir, her POST'ta PRE ile birebir
# karşılaştırılır. Satır 21 (bucket öznitelikleri) fixture ile production literaline birebir eşit olmalı.
# Ön koşul: yerel cluster (CI: apt postgresql + `sudo pg_ctlcluster 16 main start`).
# Sentinel: S2_PSQL_GATE_PASS
# =====================================================================
set -euo pipefail

if [[ "${DATABASE_URL:-}${SUPABASE_DB_URL:-}${PGHOST:-}" == *supabase.co* ]]; then
  echo "REFUSED_PRODUCTION"; exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOCK="${S2_PG_SOCKET:-/var/run/postgresql}"
DB="s2_sec_media_gate_$$"
TMPD="$(mktemp -d)"
PROD_BASELINE_MD5="677c0f6b0f4fd37bb8b4fb7959a495fb"
PROD_OTHER_POLICIES="25:45f0c3ac7e466783e9e3fa3702183b28"   # satır 20 beklenen (production PRE, 2026-10-07)
PROD_BUCKET_ATTRS="3:e112c7b7523616c45bd38bf2c8c45064"      # satır 21 beklenen (production PRE, 2026-10-07)
ARM_DOWN="set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE'"
ARM_FIX="set local sec_media.s2_fixture = 'EPHEMERAL_ONLY'"

if ! sudo -u postgres pg_isready -h "$SOCK" -q; then
  sudo pg_ctlcluster 16 main start
fi
cleanup() { sudo -u postgres psql -h "$SOCK" -d postgres -qtA -c "drop database if exists ${DB};" >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
sudo -u postgres psql -h "$SOCK" -d postgres -v ON_ERROR_STOP=1 -qtA -c "drop database if exists ${DB};" >/dev/null
sudo -u postgres createdb -h "$SOCK" "$DB"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1"; }
# psql -1 (tek transaction) + ON_ERROR_STOP; dosya stdin'den (postgres kullanıcısı checkout'u gezmez)
runf() { local f="$1"; shift; sudo -u postgres psql -h "$SOCK" -d "$DB" -X -q -v ON_ERROR_STOP=1 -1 "$@" -f - < "$f"; }
val()  { sudo -u postgres psql -h "$SOCK" -d "$DB" -X -qtA -v ON_ERROR_STOP=1 -c "$1"; }
MD5_SQL="select coalesce(md5(string_agg(policyname||'|'||cmd||'|'||roles::text||'|'||permissive||'|'||coalesce(qual,'<null>')||'|'||coalesce(with_check,'<null>'), E'\n' order by policyname)),'<none>') from pg_policies where schemaname='storage' and tablename='objects'"
POST_MD5="$(val "select md5('media anon read|SELECT|{public}|PERMISSIVE|(bucket_id = ''media''::text)|<null>')")"
# assert satırları US (0x1f) ayraçlı: actual/expected '|' içerebilir. Kolonlar: ord,check,expected,actual,result
US=$'\037'
failset() { runf "$1" -tA -F "$US" | awk -F"$US" '$5=="FAIL"{printf "%s%s", s, $1; s=","}'; }
rowcol()  { runf "$1" -tA -F "$US" | awk -F"$US" -v o="$2" -v c="$3" '$1==o{print $c}'; }
# production'daki S2_*_ASSERT_PASS'ın yerel karşılığı: FAIL kümesi yalnız env satırı 20, değeri == PRE, satır 21 == prod literali
pass_mod_env() { [ "$(failset "$1")" = "20" ] && [ "$(rowcol "$1" 20 4)" = "$PRE20" ] && [ "$(rowcol "$1" 20 3)" = "$PROD_OTHER_POLICIES" ] \
                 && [ "$(rowcol "$1" 21 4)" = "$PROD_BUCKET_ATTRS" ]; }

echo "-- engine: $(val 'select version()' | cut -d' ' -f1-2)"

runf "$ROOT/gates/s2_fixture_storage_model.sql" >/dev/null
if runf "$ROOT/gates/s2_fixture_baseline.sql" >"$TMPD"/s2_fx.out 2>&1; then bad "fixture arming olmadan çalıştı"; else
  grep -q S2_FIXTURE_NOT_ARMED "$TMPD"/s2_fx.out && ok "fixture arming olmadan reddedildi" || bad "fixture yanlış hata"; fi
runf "$ROOT/gates/s2_fixture_baseline.sql" -c "$ARM_FIX" >/dev/null
[ "$(val "$MD5_SQL")" = "$PROD_BASELINE_MD5" ] && ok "baseline md5 == production" || bad "baseline md5"

# başka tabloda kanarya policy: "diğer policy" kümesi boş olmasın (S2 buna dokunmamalı)
val "create table public.s2_canary(id int); alter table public.s2_canary enable row level security; create policy \"s2 canary read\" on public.s2_canary for select to anon using (true);" >/dev/null
PRE20="$(rowcol "$ROOT/gates/s2_pre_assert.sql" 20 4)"
[[ "$PRE20" =~ ^1:[0-9a-f]{32}$ ]] && ok "pre_assert satır 20 PRE kaydı ($PRE20)" || bad "pre_assert satır 20 PRE ($PRE20)"
pass_mod_env "$ROOT/gates/s2_pre_assert.sql" && ok "pre_assert baseline: env satırı 20 dışında PASS; satır 21 == production" \
  || { bad "pre_assert baseline (failset=$(failset "$ROOT/gates/s2_pre_assert.sql"))"; }

if runf "$ROOT/S2_down_INSECURE.sql" >"$TMPD"/s2_dn.out 2>&1; then bad "down silahsız çalıştı"; else
  grep -q S2_DOWN_INSECURE_NOT_ARMED "$TMPD"/s2_dn.out && ok "down silahsız reddedildi" || bad "down yanlış hata"; fi
[ "$(val "$MD5_SQL")" = "$PROD_BASELINE_MD5" ] && ok "silahsız down sonrası değişiklik yok" || bad "silahsız down değiştirdi"

zf() { runf "$ROOT/gates/s2_zero_footprint_test.sql" >"$TMPD"/s2_zf.out 2>&1 && echo "NO_ERROR" || true; grep -o 'S2_ZF_VERDICT=[A-Z]*' "$TMPD"/s2_zf.out | head -1; }
[ "$(zf)" = "S2_ZF_VERDICT=FAIL" ] && grep -q "FAIL anon.insert ALLOWED" "$TMPD"/s2_zf.out && ok "zf baseline: açığı yakaladı (FAIL)" || bad "zf baseline"
[ "$(val "select count(*) from storage.objects")" = "0" ] && ok "zf baseline residue 0" || bad "zf baseline residue"

runf "$ROOT/S2_up.sql" >"$TMPD"/s2_up.out 2>&1 && ok "up (psql -1) uygulandı" || { bad "up"; cat "$TMPD"/s2_up.out; }
grep -q S2_UP_OK "$TMPD"/s2_up.out && ok "up NOTICE S2_UP_OK" || bad "up notice"
[ "$(val "$MD5_SQL")" = "$POST_MD5" ] && ok "up POST matris" || bad "up POST matris"
val "insert into supabase_migrations.schema_migrations(version,name) values ('20990101000000','sec_media_close_anon_write')" >/dev/null
pass_mod_env "$ROOT/gates/s2_prod_assert.sql" && ok "prod_assert: env satırı 20 dışında PASS; satır 20 POST == PRE; satır 21 PASS" \
  || { bad "prod_assert"; runf "$ROOT/gates/s2_prod_assert.sql" -tA | grep FAIL || true; }

# satır 20/21 duyarlılık negatifleri (her biri geri alınır)
sens() { # $1 label $2 mutate $3 revert $4 expected failset
  val "$2" >/dev/null
  local fs; fs="$(failset "$ROOT/gates/s2_prod_assert.sql")"
  if [ "$fs" = "$4" ] && { [ "$4" != "20" ] || [ "$(rowcol "$ROOT/gates/s2_prod_assert.sql" 20 4)" != "$PRE20" ]; }; then ok "neg: $1 -> yakalandı (FAIL=$fs)"; else bad "neg: $1 (FAIL=$fs)"; fi
  val "$3" >/dev/null
  pass_mod_env "$ROOT/gates/s2_prod_assert.sql" && ok "neg: $1 geri alındı -> PRE" || bad "neg: $1 geri alma"
}
sens "başka tabloda yeni policy" "create policy \"s2 stray write\" on public.s2_canary for insert to anon with check (true)" \
     "drop policy \"s2 stray write\" on public.s2_canary" "20"
sens "başka tablodaki policy ifadesi" "alter policy \"s2 canary read\" on public.s2_canary using (false)" \
     "alter policy \"s2 canary read\" on public.s2_canary using (true)" "20"
sens "media file_size_limit" "update storage.buckets set file_size_limit = 5242880 where id = 'media'" \
     "update storage.buckets set file_size_limit = null where id = 'media'" "20,21"
sens "email-assets-draft versioning_status" "update storage.buckets set versioning_status = 'ENABLED' where id = 'email-assets-draft'" \
     "update storage.buckets set versioning_status = 'DISABLED' where id = 'email-assets-draft'" "20,21"

[ "$(zf)" = "S2_ZF_VERDICT=PASS" ] && grep -q "fails=0" "$TMPD"/s2_zf.out && ok "zf after up: PASS" || { bad "zf after up"; cat "$TMPD"/s2_zf.out; }
[ "$(val "select count(*) from storage.objects")" = "0" ] && ok "zf residue 0" || bad "zf residue"
[ "$(val "$MD5_SQL")" = "$POST_MD5" ] && ok "zf policy değiştirmedi" || bad "zf policy"

runf "$ROOT/S2_up.sql" >/dev/null 2>&1 && [ "$(val "$MD5_SQL")" = "$POST_MD5" ] && ok "up x2 idempotent" || bad "up x2"

runf "$ROOT/S2_down_INSECURE.sql" -c "$ARM_DOWN" >"$TMPD"/s2_dn2.out 2>&1 && ok "down(armed) uygulandı" || { bad "down armed"; cat "$TMPD"/s2_dn2.out; }
[ "$(val "$MD5_SQL")" = "$PROD_BASELINE_MD5" ] && ok "down(armed) == production baseline md5" || bad "down md5"
[ "$(failset "$ROOT/gates/s2_pre_assert.sql")" = "13,20" ] && [ "$(rowcol "$ROOT/gates/s2_pre_assert.sql" 20 4)" = "$PRE20" ] \
  && ok "down(armed): pre_assert yalnız 13 (ledger=1, beklenen) + env 20 (== PRE) farklı" || bad "down(armed) pre_assert ($(failset "$ROOT/gates/s2_pre_assert.sql"))"
runf "$ROOT/S2_down_INSECURE.sql" -c "$ARM_DOWN" >/dev/null 2>&1 && [ "$(val "$MD5_SQL")" = "$PROD_BASELINE_MD5" ] && ok "down x2 idempotent" || bad "down x2"

runf "$ROOT/S2_up.sql" >/dev/null 2>&1 && pass_mod_env "$ROOT/gates/s2_prod_assert.sql" && ok "re-up + prod_assert (env satırı dışında) PASS, satır 20 == PRE" || bad "re-up"
[ "$(zf)" = "S2_ZF_VERDICT=PASS" ] && ok "final zf PASS" || bad "final zf"

echo "RESULT pass=$PASS fail=$FAIL"
if [ "$FAIL" = "0" ]; then echo "S2_PSQL_GATE_PASS"; else echo "S2_PSQL_GATE_FAIL"; exit 1; fi
