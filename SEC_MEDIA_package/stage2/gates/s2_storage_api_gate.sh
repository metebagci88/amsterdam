#!/usr/bin/env bash
# =====================================================================
# SEC-MEDIA · STAGE 2 · gates/s2_storage_api_gate.sh
#
#   !!! YEREL OLARAK ÇALIŞTIRILMADI / UNTESTED LOCALLY !!!
#   Bu paket hazırlanırken Docker daemon yoktu; bu script yalnız CI'daki ephemeral
#   `supabase start` job'ında (sec-media-stage2-gates.yml -> storage-api) koşar.
#   İlk CI koşusu bu script'in kendisinin de ilk doğrulamasıdır.
#
# Amaç: PGlite modelinin göremediği iki şeyi GERÇEK Supabase stack'inde kanıtlamak:
#   (1) S2 SQL'leri gerçek storage şemasında (gerçek trigger'lar, postgres rolü + supautils)
#       psql -1 ile çalışır; pre/prod assert + zero-footprint testi geçer.
#   (2) Storage API (HTTP) davranışı: S2 sonrası anon upload RLS ile reddedilir; anon
#       overwrite/upsert/delete/move/copy hiçbir şeyi değiştiremez; service_role upload
#       (admin-api Edge yolunun Storage karşılığı) ve public URL okuma çalışır; INSECURE
#       rollback anon upload'u gerçekten geri açar; yeniden up tekrar kapatır.
#   (3) CI pin paritesi: yerel storage şeması production ile aynı (storage.migrations listesi
#       birebir; protect_objects_delete mevcut). Farklıysa KIRMIZI (CLI pin'i güncellenmeli).
#   Satır 20 (storage.objects dışı policy'ler) yerelde production literaline eşit olamaz ->
#   "env satırı": yerel PRE kaydedilir, her POST'ta PRE ile birebir karşılaştırılır.
#   Satır 21 (bucket öznitelikleri) gerçek storage şemasında production literaline eşit olmalı.
#
# Girdi (env, LOGLANMAZ): API_URL DB_URL ANON_KEY SERVICE_KEY  — yalnız 127.0.0.1/localhost.
# Production/supabase.co hedefi reddedilir. Test objeleri yalnız media/s2-ci/ altında;
# sonunda service_role ile silinir ve media object sayısı 0 doğrulanır.
# Sentinel: S2_STORAGE_API_GATE_PASS
# =====================================================================
set -euo pipefail
: "${API_URL:?API_URL gerekli}"; : "${DB_URL:?DB_URL gerekli}"
: "${ANON_KEY:?ANON_KEY gerekli}"; : "${SERVICE_KEY:?SERVICE_KEY gerekli}"
case "$API_URL $DB_URL" in *supabase.co*|*tosqsabuaomgqjtogdrn*) echo "REFUSED_PRODUCTION"; exit 1;; esac
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "REFUSED_NON_LOCAL_API"; exit 1;; esac
case "$DB_URL" in *@127.0.0.1:*|*@localhost:*) ;; *) echo "REFUSED_NON_LOCAL_DB"; exit 1;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
ARM_DOWN="set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE'"
ARM_FIX="set local sec_media.s2_fixture = 'EPHEMERAL_ONLY'"
PROD_BASELINE_MD5="677c0f6b0f4fd37bb8b4fb7959a495fb"
PROD_OTHER_POLICIES="25:45f0c3ac7e466783e9e3fa3702183b28"     # satır 20 beklenen (production PRE, 2026-10-07)
PROD_BUCKET_ATTRS="3:e112c7b7523616c45bd38bf2c8c45064"        # satır 21 beklenen (production PRE, 2026-10-07)
PROD_STORAGE_MIGRATIONS="73:824c7cc22b2d773ff697a047f1ce5c70" # production storage.migrations count:md5(id:name), 2026-10-07
ST="$API_URL/storage/v1"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1"; }
runf() { local f="$1"; shift; psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -1 "$@" -f "$f"; }
val()  { psql "$DB_URL" -X -qtA -v ON_ERROR_STOP=1 -c "$1"; }
# assert satırları US (0x1f) ayraçlı: actual/expected '|' içerebilir. Kolonlar: ord,check,expected,actual,result
US=$'\037'
failset() { runf "$1" -tA -F "$US" | awk -F"$US" '$5=="FAIL"{printf "%s%s", s, $1; s=","}'; }
rowcol()  { runf "$1" -tA -F "$US" | awk -F"$US" -v o="$2" -v c="$3" '$1==o{print $c}'; }
# production'daki S2_*_ASSERT_PASS'ın yerel karşılığı: FAIL kümesi yalnız env satırı 20, değeri == PRE, satır 21 == prod literali
pass_mod_env() { [ "$(failset "$1")" = "20" ] && [ "$(rowcol "$1" 20 4)" = "$PRE20" ] && [ "$(rowcol "$1" 20 3)" = "$PROD_OTHER_POLICIES" ] \
                 && [ "$(rowcol "$1" 21 4)" = "$PROD_BUCKET_ATTRS" ]; }
MD5_SQL="select coalesce(md5(string_agg(policyname||'|'||cmd||'|'||roles::text||'|'||permissive||'|'||coalesce(qual,'<null>')||'|'||coalesce(with_check,'<null>'), E'\n' order by policyname)),'<none>') from pg_policies where schemaname='storage' and tablename='objects'"
cnt() { val "select count(*) from storage.objects where bucket_id='media' and name='$1'"; }
# HTTP: anahtar yalnız header'da; çıktı dosyaya; durum kodu stdout'a. Gövdeler secret içermez.
http() { # $1 method $2 url $3 role(anon|service) $4 outfile [curl args...]
  local m="$1" u="$2" r="$3" o="$4"; shift 4
  local k="$ANON_KEY"; [ "$r" = "service" ] && k="$SERVICE_KEY"
  curl -s -o "$o" -w '%{http_code}' -X "$m" "$u" -H "apikey: $k" -H "Authorization: Bearer $k" "$@" || echo "000"
}
is2xx() { case "$1" in 2??) return 0;; *) return 1;; esac; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
body() { head -c 300 "$1" | tr -d '\n'; }

# test dosyaları (1x1 PNG + farklı baytlı ikinci sürüm)
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMPD/a.png"
cp "$TMPD/a.png" "$TMPD/b.png"; printf 'S2' >> "$TMPD/b.png"

echo "-- storage_migration_last=$(val "select name from storage.migrations order by id desc limit 1" 2>/dev/null || echo '?')"
echo "-- storage.objects triggers=$(val "select coalesce(string_agg(tgname::text, ',' order by tgname),'<none>') from pg_trigger where tgrelid='storage.objects'::regclass and not tgisinternal")"
echo "-- runner role=$(val 'select current_user') superuser=$(val "select rolsuper from pg_roles where rolname=current_user")"

# ---- CI pin paritesi: bu job'ın kanıtı ancak storage şeması production ile aynıysa geçerlidir
SM="$(val "select count(*)::text || ':' || md5(string_agg(id::text || ':' || name, E'\n' order by id)) from storage.migrations" 2>/dev/null || echo '?')"
echo "-- storage_migrations=$SM (production 2026-10-07: $PROD_STORAGE_MIGRATIONS)"
[ "$SM" = "$PROD_STORAGE_MIGRATIONS" ] && ok "storage şeması == production (storage.migrations birebir)" \
  || bad "storage şeması production'dan farklı ($SM) — supabase/setup-cli pin'i production storage sürümüne göre güncellenmeli"
[ "$(val "select count(*) from pg_trigger where tgrelid='storage.objects'::regclass and tgname='protect_objects_delete' and not tgisinternal")" = "1" ] \
  && ok "protect_objects_delete trigger mevcut (production ile aynı)" || bad "protect_objects_delete trigger yok"

# ---- baseline fixture (gerçek storage şeması üzerinde; model fixture KULLANILMAZ)
runf "$ROOT/gates/s2_fixture_baseline.sql" -c "$ARM_FIX" >/dev/null
# ledger tablosu: boş `supabase start` (migration dosyası yok) supabase_migrations.schema_migrations'ı
# OLUŞTURMAZ; pre_assert satır 13 onu okur -> ilk assert'ten ÖNCE (CLI'nin CreateMigrationTable şekli)
val "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);" >/dev/null
[ "$(val "$MD5_SQL")" = "$PROD_BASELINE_MD5" ] && ok "baseline md5 == production" || bad "baseline md5"
[ "$(val "select count(*) from storage.objects where bucket_id='media'")" = "0" ] || bad "media başlangıçta boş değil"
PRE20="$(rowcol "$ROOT/gates/s2_pre_assert.sql" 20 4)"
echo "-- pre_assert satır 20 (yerel PRE)=$PRE20"
PRE20_RE='^[0-9]+:([0-9a-f]{32}|<none>)$'
[[ "$PRE20" =~ $PRE20_RE ]] && ok "pre_assert satır 20 PRE kaydı" || bad "pre_assert satır 20 PRE ($PRE20)"
pass_mod_env "$ROOT/gates/s2_pre_assert.sql" && ok "pre_assert baseline (gerçek şema): env satırı 20 dışında PASS; satır 21 == production" \
  || { bad "pre_assert baseline (FAIL=$(failset "$ROOT/gates/s2_pre_assert.sql"))"; runf "$ROOT/gates/s2_pre_assert.sql" -tA | grep -E 'FAIL|INFO' || true; }

# ---- baseline HTTP: açık gerçekten açık mı (harness duyarlılığı)
s=$(http POST "$ST/object/media/s2-ci/anon-baseline.png" anon "$TMPD/r" -H 'Content-Type: image/png' --data-binary @"$TMPD/a.png")
is2xx "$s" && [ "$(cnt s2-ci/anon-baseline.png)" = "1" ] && ok "baseline: anon upload İZİNLİ ($s) — açık modellendi" || bad "baseline anon upload beklenen 2xx, gelen $s $(body "$TMPD/r")"
s=$(http DELETE "$ST/object/media/s2-ci/anon-baseline.png" service "$TMPD/r")
[ "$(cnt s2-ci/anon-baseline.png)" = "0" ] && ok "baseline temizlendi (service delete $s)" || bad "baseline cleanup $s"

# ---- S2_up
runf "$ROOT/S2_up.sql" >"$TMPD/up.out" 2>&1 && ok "S2_up (psql -1, gerçek şema) uygulandı" || { bad "S2_up"; cat "$TMPD/up.out"; }
[ "$(val "select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname='storage' and tablename='objects'")" = "media anon read" ] \
  && ok "policy kümesi = media anon read" || bad "policy kümesi"

anon_denied_checks() { # $1 label
  local L="$1" s before
  s=$(http POST "$ST/object/media/s2-ci/anon-$L.png" anon "$TMPD/r" -H 'Content-Type: image/png' --data-binary @"$TMPD/a.png")
  if ! is2xx "$s" && grep -qi 'row-level security' "$TMPD/r" && [ "$(cnt "s2-ci/anon-$L.png")" = "0" ]; then ok "$L: anon upload reddedildi ($s, RLS)"; else bad "$L: anon upload $s $(body "$TMPD/r")"; fi

  s=$(http POST "$ST/object/media/s2-ci/svc.png" service "$TMPD/r" -H 'Content-Type: image/png' --data-binary @"$TMPD/a.png")
  is2xx "$s" && [ "$(cnt s2-ci/svc.png)" = "1" ] && ok "$L: service_role upload ($s)" || bad "$L: service upload $s $(body "$TMPD/r")"
  before="$(val "select coalesce(version,'')||'|'||coalesce(metadata->>'eTag','')||'|'||coalesce(metadata->>'size','') from storage.objects where bucket_id='media' and name='s2-ci/svc.png'")"

  s=$(curl -s -o "$TMPD/pub" -w '%{http_code}' "$ST/object/public/media/s2-ci/svc.png" || echo 000)
  [ "$s" = "200" ] && [ "$(sha "$TMPD/pub")" = "$(sha "$TMPD/a.png")" ] && ok "$L: public URL 200 + bayt eşit" || bad "$L: public GET $s"

  s=$(http PUT "$ST/object/media/s2-ci/svc.png" anon "$TMPD/r" -H 'Content-Type: image/png' --data-binary @"$TMPD/b.png")
  ! is2xx "$s" && ok "$L: anon overwrite(PUT) reddedildi ($s)" || bad "$L: anon PUT $s $(body "$TMPD/r")"
  s=$(http POST "$ST/object/media/s2-ci/svc.png" anon "$TMPD/r" -H 'Content-Type: image/png' -H 'x-upsert: true' --data-binary @"$TMPD/b.png")
  ! is2xx "$s" && ok "$L: anon upsert reddedildi ($s)" || bad "$L: anon upsert $s $(body "$TMPD/r")"
  http DELETE "$ST/object/media/s2-ci/svc.png" anon "$TMPD/r" >"$TMPD/ds"
  http POST "$ST/object/move" anon "$TMPD/r" -H 'Content-Type: application/json' \
    --data '{"bucketId":"media","sourceKey":"s2-ci/svc.png","destinationKey":"s2-ci/moved.png"}' >"$TMPD/ms"
  http POST "$ST/object/copy" anon "$TMPD/r" -H 'Content-Type: application/json' \
    --data '{"bucketId":"media","sourceKey":"s2-ci/svc.png","destinationKey":"s2-ci/copied.png"}' >"$TMPD/cs"
  if [ "$(cnt s2-ci/svc.png)" = "1" ] && [ "$(cnt s2-ci/moved.png)" = "0" ] && [ "$(cnt s2-ci/copied.png)" = "0" ] \
     && [ "$(val "select coalesce(version,'')||'|'||coalesce(metadata->>'eTag','')||'|'||coalesce(metadata->>'size','') from storage.objects where bucket_id='media' and name='s2-ci/svc.png'")" = "$before" ]; then
    ok "$L: anon delete/move/copy hiçbir şey değiştirmedi (delete=$(cat "$TMPD/ds") move=$(cat "$TMPD/ms") copy=$(cat "$TMPD/cs"))"
  else bad "$L: anon delete/move/copy durumu değiştirdi"; fi
  s=$(curl -s -o "$TMPD/pub" -w '%{http_code}' "$ST/object/public/media/s2-ci/svc.png" || echo 000)
  [ "$s" = "200" ] && [ "$(sha "$TMPD/pub")" = "$(sha "$TMPD/a.png")" ] && ok "$L: public bayt değişmedi" || bad "$L: public bayt/kod $s"

  s=$(http POST "$ST/object/list/media" anon "$TMPD/r" -H 'Content-Type: application/json' --data '{"prefix":"s2-ci","limit":100,"offset":0}')
  [ "$s" = "200" ] && grep -q '"svc.png"' "$TMPD/r" && ok "$L: anon list (public read policy) 200" || bad "$L: anon list $s $(body "$TMPD/r")"

  s=$(http DELETE "$ST/object/media/s2-ci/svc.png" service "$TMPD/r")
  [ "$(cnt s2-ci/svc.png)" = "0" ] && ok "$L: service_role delete (cleanup yolu) ($s)" || bad "$L: service delete $s"
}
anon_denied_checks "after_up"

# zero-footprint testi gerçek şemada
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/gates/s2_zero_footprint_test.sql" >"$TMPD/zf.out" 2>&1 || true
grep -q 'S2_ZF_VERDICT=PASS' "$TMPD/zf.out" && ok "zero-footprint (gerçek şema) PASS" || { bad "zero-footprint"; cat "$TMPD/zf.out"; }
[ "$(val "select count(*) from storage.objects where name like 'zz-sec-media-s2-zf/%'")" = "0" ] && ok "zf residue 0" || bad "zf residue"

# ledger kaydını apply_migration gibi simüle et (tablo baseline'dan hemen sonra oluşturuldu), sonra prod_assert
val "insert into supabase_migrations.schema_migrations(version,name) values ('20990101000000','sec_media_close_anon_write') on conflict do nothing" >/dev/null
pass_mod_env "$ROOT/gates/s2_prod_assert.sql" && ok "prod_assert (gerçek şema): env satırı 20 dışında PASS; satır 20 POST == PRE; satır 21 PASS" \
  || { bad "prod_assert (FAIL=$(failset "$ROOT/gates/s2_prod_assert.sql"))"; runf "$ROOT/gates/s2_prod_assert.sql" -tA | grep -E 'FAIL|INFO' || true; }

# idempotent
runf "$ROOT/S2_up.sql" >/dev/null 2>&1 && pass_mod_env "$ROOT/gates/s2_prod_assert.sql" && ok "S2_up x2 idempotent" || bad "S2_up x2"

# INSECURE rollback: silahsız red, armed baseline + anon upload gerçekten geri açılır
if runf "$ROOT/S2_down_INSECURE.sql" >"$TMPD/dn.out" 2>&1; then bad "down silahsız çalıştı"; else
  grep -q S2_DOWN_INSECURE_NOT_ARMED "$TMPD/dn.out" && ok "down silahsız reddedildi" || bad "down yanlış hata"; fi
runf "$ROOT/S2_down_INSECURE.sql" -c "$ARM_DOWN" >/dev/null 2>&1 && [ "$(val "$MD5_SQL")" = "$PROD_BASELINE_MD5" ] && ok "down(armed) == production baseline md5" || bad "down armed"
[ "$(failset "$ROOT/gates/s2_pre_assert.sql")" = "13,20" ] && [ "$(rowcol "$ROOT/gates/s2_pre_assert.sql" 20 4)" = "$PRE20" ] \
  && ok "down(armed): pre_assert yalnız 13 (ledger=1, beklenen) + env 20 (== PRE) farklı" || bad "down(armed) pre_assert (FAIL=$(failset "$ROOT/gates/s2_pre_assert.sql"))"
s=$(http POST "$ST/object/media/s2-ci/anon-after-down.png" anon "$TMPD/r" -H 'Content-Type: image/png' --data-binary @"$TMPD/a.png")
is2xx "$s" && ok "after_down: anon upload yeniden İZİNLİ ($s) — rollback gerçekten geri açıyor" || bad "after_down anon upload $s $(body "$TMPD/r")"
http DELETE "$ST/object/media/s2-ci/anon-after-down.png" service "$TMPD/r" >/dev/null
[ "$(cnt s2-ci/anon-after-down.png)" = "0" ] && ok "after_down temizlendi" || bad "after_down cleanup"

# yeniden up
runf "$ROOT/S2_up.sql" >/dev/null 2>&1 && ok "re-up uygulandı" || bad "re-up"
anon_denied_checks "after_reup"

# son residue + diğer policy/bucket'lar tüm döngü sonunda PRE ile aynı
[ "$(val "select count(*) from storage.objects where bucket_id='media'")" = "0" ] && ok "final: media object count 0 (residue 0)" || bad "final residue"
pass_mod_env "$ROOT/gates/s2_prod_assert.sql" && ok "final: prod_assert env satırı dışında PASS; satır 20 == PRE; satır 21 PASS" || bad "final prod_assert (FAIL=$(failset "$ROOT/gates/s2_prod_assert.sql"))"

echo "RESULT pass=$PASS fail=$FAIL"
if [ "$FAIL" = "0" ]; then echo "S2_STORAGE_API_GATE_PASS"; else echo "S2_STORAGE_API_GATE_FAIL"; exit 1; fi
