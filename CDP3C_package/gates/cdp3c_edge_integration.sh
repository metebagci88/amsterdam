#!/usr/bin/env bash
# =====================================================================
# CDP-3C · Edge ENTEGRASYON kabul testi (GERÇEK HTTP + GERÇEK DB RPC)
# Ephemeral Supabase (supabase start) + supabase functions serve ile gerçek birleşik
# email-api + admin-api handler'larını çalıştırır; kopyalanmış helper DEĞİL, HTTP yüzeyini test eder.
# Ortam değişkenleri (workflow tarafından set edilir):
#   API_URL          -> http://127.0.0.1:54321
#   ANON_KEY         -> supabase status'tan
#   SERVICE_KEY      -> supabase status'tan
#   FN_EMAIL         -> $API_URL/functions/v1/email-api
#   FN_ADMIN         -> $API_URL/functions/v1/admin-api
#   MEMBER_JWT       -> normal üye access_token
#   ADMIN_JWT        -> super_admin access_token
#   TARGET_UID       -> q_member_consent için hedef üye uid (members'ta var)
#   DBURL            -> psql bağlantı dizesi (yan-etki doğrulaması için)
# Çıkış: tüm testler geçerse "CDP3C_EDGE_INTEGRATION_PASS", aksi ilk hatada exit 1.
# =====================================================================
set -uo pipefail
ORIGIN_OK="https://www.asalocal.club"
ORIGIN_BAD="https://evil.example"
pass=0; fail=0
note(){ printf '  %s\n' "$*"; }
die(){ echo "GATE_FAILED:$1"; echo "  detay: $2"; exit 1; }
okk(){ pass=$((pass+1)); }

# curl yardımcıları: gövde + status ayrı; başlıkları da yakala
req(){ # method url origin authbearer json  -> STATUS\nBODY (HDRS ayrı dosyada)
  local m="$1" url="$2" origin="$3" auth="$4" body="${5:-}"
  local hdr=(-s -o /tmp/ci_body -D /tmp/ci_hdr -w '%{http_code}' -X "$m" "$url" -H "Content-Type: application/json")
  [ -n "$origin" ] && hdr+=(-H "Origin: $origin")
  [ -n "$auth" ] && hdr+=(-H "Authorization: Bearer $auth")
  [ -n "$body" ] && hdr+=(--data "$body")
  curl "${hdr[@]}"
}
body(){ cat /tmp/ci_body; }
hdrs(){ cat /tmp/ci_hdr; }
count_consent_events(){ psql "$DBURL" -tAc "select count(*) from public.member_consent_events;" 2>/dev/null | tr -d '[:space:]'; }

echo "== CDP-3C EDGE ENTEGRASYON (gerçek HTTP/RPC) =="

# --- 1) bilinmeyen origin: OPTIONS -> 403, ACAO yok ---
s=$(req OPTIONS "$FN_EMAIL" "$ORIGIN_BAD" "" ""); [ "$s" = "403" ] || die "unknown_origin_options" "beklenen 403, gelen $s"
grep -qi "access-control-allow-origin" /tmp/ci_hdr && die "unknown_origin_options_acao" "ACAO yazılmış (olmamalı)"; okk; note "OPTIONS bilinmeyen origin -> 403, ACAO yok"

# --- 2) bilinmeyen origin: POST -> 403, DB yan etkisi yok ---
before=$(count_consent_events)
s=$(req POST "$FN_EMAIL" "$ORIGIN_BAD" "$MEMBER_JWT" '{"action":"consent_get"}'); [ "$s" = "403" ] || die "unknown_origin_post" "beklenen 403, gelen $s"
after=$(count_consent_events); [ "$before" = "$after" ] || die "unknown_origin_side_effect" "consent_events değişti $before->$after"; okk; note "POST bilinmeyen origin -> 403, yan etki yok"

# --- 3) allowlist origin OPTIONS düzgün (204/200 + ACAO=origin) ---
s=$(req OPTIONS "$FN_EMAIL" "$ORIGIN_OK" "" ""); { [ "$s" = "200" ] || [ "$s" = "204" ]; } || die "allow_origin_options" "beklenen 200/204, gelen $s"
grep -qi "access-control-allow-origin: $ORIGIN_OK" /tmp/ci_hdr || die "allow_origin_acao" "ACAO=origin yok"; okk; note "OPTIONS allowlist origin -> $s + ACAO"

# --- 4) token yok -> 401 ---
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "" '{"action":"consent_get"}'); [ "$s" = "401" ] || die "no_token_401" "beklenen 401, gelen $s"; okk; note "token yok -> 401"
# --- 4b) geçersiz token -> 401 ---
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "not.a.jwt" '{"action":"consent_get"}'); [ "$s" = "401" ] || die "bad_token_401" "beklenen 401, gelen $s"; okk; note "geçersiz token -> 401"

# --- 5) normal üye consent_get -> 200 + Cache-Control: no-store ---
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" '{"action":"consent_get"}'); [ "$s" = "200" ] || die "member_consent_get" "beklenen 200, gelen $s ($(body))"
grep -qi "cache-control: no-store" /tmp/ci_hdr || die "consent_get_no_store" "no-store yok"; okk; note "üye consent_get -> 200 + no-store"

# --- 6) normal üye email-admin 'list' -> 403 ---
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" '{"action":"list"}'); [ "$s" = "403" ] || die "member_admin_list_403" "beklenen 403, gelen $s ($(body))"; okk; note "üye email-admin list -> 403"

# --- 7) boolean tipi: "false" / "0" / sayı -> 422, grant yok ---
before=$(count_consent_events)
for badbool in '"false"' '"0"' '1'; do
  s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" "{\"action\":\"consent_set\",\"purpose\":\"email_marketing\",\"grant\":$badbool,\"request_id\":\"r1\",\"idem\":\"11111111-1111-1111-1111-111111111111\"}")
  [ "$s" = "422" ] || die "bool_422" "grant=$badbool beklenen 422, gelen $s ($(body))"
done
after=$(count_consent_events); [ "$before" = "$after" ] || die "bool_side_effect" "consent_events değişti"; okk; note "\"false\"/\"0\"/1 boolean -> 422, grant yok"

# --- 8) bilinmeyen alan -> 400 ---
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" '{"action":"consent_get","evil":1}'); [ "$s" = "400" ] || die "unknown_field_400" "beklenen 400, gelen $s"; okk; note "bilinmeyen alan -> 400"

# --- 9) service_pref_set: ilk yazım 200 ---
IDEM_A="22222222-2222-2222-2222-222222222222"
P1='{"action":"service_pref_set","key":"trip_created_confirmation","enabled":true,"request_id":"r-sp","idem":"'$IDEM_A'"}'
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" "$P1"); [ "$s" = "200" ] || die "svc_pref_first" "beklenen 200, gelen $s ($(body))"; okk; note "service_pref_set ilk yazım -> 200"
# --- 9b) aynı idem + aynı payload -> aynı sonuç (idempotent replay, 200) ---
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" "$P1"); [ "$s" = "200" ] || die "svc_pref_replay" "beklenen 200, gelen $s ($(body))"; okk; note "aynı idem+payload -> aynı sonuç 200"
# --- 9c) aynı idem + FARKLI payload -> 409 ---
P2='{"action":"service_pref_set","key":"trip_created_confirmation","enabled":false,"request_id":"r-sp","idem":"'$IDEM_A'"}'
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" "$P2"); [ "$s" = "409" ] || die "svc_pref_conflict" "beklenen 409, gelen $s ($(body))"; okk; note "aynı idem+farklı payload -> 409"

# --- 10) save sonrası reopen gerçek sunucu durumunu gösterir ---
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" '{"action":"consent_get"}'); [ "$s" = "200" ] || die "reopen_get" "beklenen 200, gelen $s"
echo "$(body)" | grep -q '"trip_created_confirmation":true' || die "reopen_state" "kaydedilen tercih durumda görünmüyor: $(body)"; okk; note "save->reopen gerçek durum (trip_created_confirmation:true)"

# --- 11) marketing grant -> 409 (aktif controller/metin/capture yok) + consent satırı yok ---
before=$(count_consent_events)
MG='{"action":"consent_set","purpose":"email_marketing","grant":true,"request_id":"r-mk","idem":"33333333-3333-3333-3333-333333333333"}'
s=$(req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" "$MG"); [ "$s" = "409" ] || die "marketing_grant_409" "beklenen 409, gelen $s ($(body))"
after=$(count_consent_events); [ "$before" = "$after" ] || die "marketing_grant_side_effect" "consent_events değişti (grant yazılmamalı)"; okk; note "marketing grant -> 409, consent satırı yok"

# --- 12) mevcut kullanıcılar için otomatik backfill/popup/yazım YOK ---
# (statik + davranışsal): consent_events yalnız yukarıdaki AÇIK service_pref_set kadar; marketing/otomatik yazım yok.
# member_consent_events'te yalnız beklenen kayıt(lar); otomatik giriş olmadığını kanıtlamak için
# hiçbir GET/oturum çağrısı consent_events üretmemeli. Bir consent_get daha at, sayaç artmasın.
before=$(count_consent_events); req POST "$FN_EMAIL" "$ORIGIN_OK" "$MEMBER_JWT" '{"action":"consent_get"}' >/dev/null; after=$(count_consent_events)
[ "$before" = "$after" ] || die "no_auto_write" "consent_get consent_events üretti (backfill/otomatik yazım olmamalı)"; okk; note "otomatik backfill/yazım yok (consent_get yan etkisiz)"

# --- 13) admin-api q_member_consent: super_admin -> 200 + yalnız allowlist alanlar ---
QMC='{"action":"q_member_consent","params":{"user_id":"'$TARGET_UID'"}}'
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" "$QMC"); [ "$s" = "200" ] || die "admin_qmc_200" "beklenen 200, gelen $s ($(body))"
B=$(body)
echo "$B" | grep -q '"consent"' && echo "$B" | grep -q '"consent_timeline"' && echo "$B" | grep -q '"service_prefs"' || die "admin_qmc_allowlist" "allowlist alanları eksik: $B"
echo "$B" | grep -Eiq 'hmac|fingerprint|idempotency|evidence|request_id' && die "admin_qmc_leak" "yasak alan sızdı: $B"; okk; note "admin q_member_consent super_admin -> 200 allowlist, sızıntı yok"

# --- 14) admin-api q_member_consent: normal üye -> 403 ---
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$MEMBER_JWT" "$QMC"); { [ "$s" = "403" ]; } || die "admin_qmc_member_403" "beklenen 403, gelen $s ($(body))"; okk; note "admin q_member_consent normal üye -> 403"

# --- 15) marketing_readiness_check -> ready:false ---
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" '{"action":"marketing_readiness_check"}'); [ "$s" = "200" ] || die "readiness_200" "beklenen 200, gelen $s ($(body))"
echo "$(body)" | grep -q '"ready":false' || die "readiness_false" "ready:false değil: $(body)"; okk; note "marketing_readiness_check -> ready:false"

# --- 16) admin üzerinden consent/opt-in YAZMA action'ı yok (bilinmeyen action reddi) ---
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" '{"action":"consent_set","params":{}}'); [ "$s" = "400" ] || die "admin_no_optin" "admin consent_set kabul edilmemeli, gelen $s"; okk; note "admin opt-in/consent yazma action'ı yok -> 400"

echo "==============================="
echo "CDP3C_EDGE_INTEGRATION pass=$pass fail=$fail"
echo "CDP3C_EDGE_INTEGRATION_PASS"
