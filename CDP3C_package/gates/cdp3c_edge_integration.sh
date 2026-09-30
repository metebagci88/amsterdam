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
# Çıkış: tüm HTTP testleri geçerse "CDP3C_EDGE_HTTP_SUITE_PASS", aksi ilk hatada exit 1.
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

# --- 13) admin-api q_member_consent: super_admin -> 200 + YALNIZ .data allowlist ---
# NOT: Üst seviye {request_id,data} MEŞRU admin sözleşmesidir; leak kontrolü YALNIZ .data üzerinde yapılır.
QMC='{"action":"q_member_consent","params":{"user_id":"'$TARGET_UID'"}}'
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" "$QMC"); [ "$s" = "200" ] || die "admin_qmc_200" "beklenen 200, gelen $s ($(body))"
B=$(body); DATA=$(echo "$B" | jq -c '.data' 2>/dev/null)
[ -n "$DATA" ] && [ "$DATA" != "null" ] || die "admin_qmc_data" ".data yok: $B"
# .data üst seviye anahtarları YALNIZ consent, consent_timeline, service_prefs
TOPKEYS=$(echo "$DATA" | jq -r 'keys_unsorted | sort | join(",")')
[ "$TOPKEYS" = "consent,consent_timeline,service_prefs" ] || die "admin_qmc_topkeys" "beklenen 3 anahtar; gelen: $TOPKEYS"
# consent[] yalnız: purpose,state,text_version_id,epoch,updated_at
CBAD=$(echo "$DATA" | jq -r '[.consent[]?|keys_unsorted[]]|unique - ["purpose","state","text_version_id","epoch","updated_at"]|join(",")')
[ -z "$CBAD" ] || die "admin_qmc_consent_keys" "consent fazla anahtar: $CBAD"
# consent_timeline[] yalnız: purpose,action,text_version_id,source,occurred_at
TBAD=$(echo "$DATA" | jq -r '[.consent_timeline[]?|keys_unsorted[]]|unique - ["purpose","action","text_version_id","source","occurred_at"]|join(",")')
[ -z "$TBAD" ] || die "admin_qmc_timeline_keys" "consent_timeline fazla anahtar: $TBAD"
# service_prefs[] yalnız: key,enabled,updated_at
SBAD=$(echo "$DATA" | jq -r '[.service_prefs[]?|keys_unsorted[]]|unique - ["key","enabled","updated_at"]|join(",")')
[ -z "$SBAD" ] || die "admin_qmc_prefs_keys" "service_prefs fazla anahtar: $SBAD"
# .data İÇİNDE yasak alan (üst seviye request_id hariç): hmac/fingerprint/idempotency/evidence/request_id
echo "$DATA" | grep -Eiq 'hmac|fingerprint|idempotency|evidence|request_id' && die "admin_qmc_leak" ".data içinde yasak alan: $DATA"
okk; note "admin q_member_consent -> 200; .data yalnız allowlist (üst seviye request_id meşru)"

# --- 14) admin-api q_member_consent: normal üye -> 403 ---
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$MEMBER_JWT" "$QMC"); { [ "$s" = "403" ]; } || die "admin_qmc_member_403" "beklenen 403, gelen $s ($(body))"; okk; note "admin q_member_consent normal üye -> 403"

# --- 15) marketing_readiness_check -> ready:false ---
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" '{"action":"marketing_readiness_check"}'); [ "$s" = "200" ] || die "readiness_200" "beklenen 200, gelen $s ($(body))"
echo "$(body)" | grep -q '"ready":false' || die "readiness_false" "ready:false değil: $(body)"; okk; note "marketing_readiness_check -> ready:false"

# --- 16) admin üzerinden consent/opt-in YAZMA action'ı yok (bilinmeyen action reddi) ---
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" '{"action":"consent_set","params":{}}'); [ "$s" = "400" ] || die "admin_no_optin" "admin consent_set kabul edilmemeli, gelen $s"; okk; note "admin opt-in/consent yazma action'ı yok -> 400"

# --- 17) media_upload: JSON kalır 8KB; action JSON'da 415; multipart ephemeral storage + teardown ---
# Ephemeral stack only. Does not apply admin_rate_check.APPLY_NO.sql (CI double returns true).
# Bucket insert is local to this database. No production policy change.
BIG=$(python3 -c 'print("{" + (" " * 8200) + "}")')
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" "$BIG"); [ "$s" = "413" ] || die "admin_json_413" "JSON >8KB beklenen 413, gelen $s"; okk; note "JSON body >8192 -> 413 (MAX_BODY unchanged)"
s=$(req POST "$FN_ADMIN" "$ORIGIN_OK" "$ADMIN_JWT" '{"action":"media_upload"}'); [ "$s" = "415" ] || die "admin_json_media_415" "JSON media_upload beklenen 415, gelen $s ($(body))"; okk; note "JSON media_upload -> 415"
s=$(curl -s -o /tmp/ci_body -D /tmp/ci_hdr -w '%{http_code}' -X POST "$FN_ADMIN" -H "Origin: $ORIGIN_OK" -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: text/plain" --data 'hello')
[ "$s" = "415" ] || die "admin_ctype_415" "text/plain beklenen 415, gelen $s"; okk; note "Content-Type text/plain -> 415"
psql "$DBURL" -v ON_ERROR_STOP=1 -c "insert into storage.buckets(id,name,public) values ('media','media',true) on conflict (id) do nothing;" >/tmp/media_bucket.out 2>&1 || die "media_bucket" "ephemeral media bucket insert failed"
count_media(){ psql "$DBURL" -tAc "select count(*) from storage.objects where bucket_id='media';" | tr -d '[:space:]'; }
BEFORE=$(count_media)
python3 - <<'PY'
from pathlib import Path
boundary = "----asaMedia"
def form(parts):
    chunks = []
    for part in parts:
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="{part["name"]}"'
        if "filename" in part:
            head += f'; filename="{part["filename"]}"'
        head += "\r\n"
        if part.get("type"):
            head += f'Content-Type: {part["type"]}\r\n'
        head += "\r\n"
        chunks.append(head.encode())
        chunks.append(part.get("file") if part.get("file") is not None else part.get("value", "").encode())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks)
jpeg = bytes([0xFF, 0xD8, 0xFF, 0x00])
gif = bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
base = [{"name": "action", "value": "media_upload"}, {"name": "prefix", "value": "venues"}]
Path("/tmp/mu_jpeg.bin").write_bytes(form([*base, {"name": "file", "file": jpeg, "filename": "client-secret.jpg", "type": "image/gif"}]))
Path("/tmp/mu_gif.bin").write_bytes(form([*base, {"name": "file", "file": gif, "filename": "x.png", "type": "image/png"}]))
Path("/tmp/mu_counts.bin").write_bytes(form([{"name": "action", "value": "counts"}, {"name": "prefix", "value": "venues"}, {"name": "file", "file": jpeg}]))
Path("/tmp/mu_path.bin").write_bytes(form([*base, {"name": "path", "value": "venues/evil.jpg"}, {"name": "file", "file": jpeg}]))
PY
mpost(){ # $1 file $2 jwt -> status
  curl -s -o /tmp/ci_body -D /tmp/ci_hdr -w '%{http_code}' -X POST "$FN_ADMIN" \
    -H "Origin: $ORIGIN_OK" -H "Authorization: Bearer $2" \
    -H "Content-Type: multipart/form-data; boundary=----asaMedia" \
    --data-binary @"$1"
}
s=$(mpost /tmp/mu_counts.bin "$ADMIN_JWT"); [ "$s" = "415" ] || die "media_counts_415" "multipart counts beklenen 415, gelen $s ($(body))"; okk; note "multipart action=counts -> 415"
s=$(mpost /tmp/mu_path.bin "$ADMIN_JWT"); [ "$s" = "400" ] || die "media_client_path" "client path beklenen 400, gelen $s ($(body))"
echo "$(body)" | grep -q '"client_path_rejected"' || die "media_client_path_code" "client_path_rejected yok: $(body)"; okk; note "multipart path field -> 400 client_path_rejected"
s=$(mpost /tmp/mu_jpeg.bin "$MEMBER_JWT"); [ "$s" = "403" ] || die "media_member_403" "üye upload beklenen 403, gelen $s ($(body))"
MID=$(count_media); [ "$MID" = "$BEFORE" ] || die "media_member_delta" "üye upload nesne üretti $BEFORE->$MID"; okk; note "üye multipart -> 403, object delta 0"
s=$(mpost /tmp/mu_gif.bin "$ADMIN_JWT"); [ "$s" = "400" ] || die "media_gif_400" "GIF beklenen 400, gelen $s ($(body))"
echo "$(body)" | grep -q '"bad_mime_content"' || die "media_gif_code" "bad_mime_content yok: $(body)"
MID=$(count_media); [ "$MID" = "$BEFORE" ] || die "media_gif_delta" "GIF upload nesne üretti $BEFORE->$MID"; okk; note "GIF magic -> 400, uploader yazmadı"
s=$(mpost /tmp/mu_jpeg.bin "$ADMIN_JWT"); [ "$s" = "200" ] || die "media_jpeg_200" "JPEG beklenen 200, gelen $s ($(body))"
B=$(body)
echo "$B" | grep -q 'service_role' && die "media_secret" "yanıtta service_role"
echo "$B" | grep -Eq 'eyJ[A-Za-z0-9_-]{6,}\.' && die "media_jwt" "yanıtta jwt"
PATH1=$(echo "$B" | jq -r '.data.path')
URL1=$(echo "$B" | jq -r '.data.public_url')
MIME1=$(echo "$B" | jq -r '.data.mime')
BYTES1=$(echo "$B" | jq -r '.data.bytes')
BUCKET1=$(echo "$B" | jq -r '.data.bucket')
echo "$PATH1" | grep -Eq '^venues/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' || die "media_path" "path sözleşmesi değil: $PATH1"
echo "$URL1" | grep -F -q "/storage/v1/object/public/media/$PATH1" || die "media_public_url" "public url değil: $URL1"
echo "$URL1" | grep -q 'token=' && die "media_signed" "signed url"
echo "$PATH1" | grep -q 'client-secret' && die "media_filename" "client filename path'e girdi"
[ "$MIME1" = "image/jpeg" ] && [ "$BYTES1" = "4" ] && [ "$BUCKET1" = "media" ] || die "media_meta" "mime/bytes/bucket: $MIME1 $BYTES1 $BUCKET1"
okk; note "super_admin JPEG multipart -> 200 public url"
s=$(mpost /tmp/mu_jpeg.bin "$ADMIN_JWT"); [ "$s" = "200" ] || die "media_jpeg_2" "ikinci JPEG beklenen 200, gelen $s ($(body))"
PATH2=$(echo "$(body)" | jq -r '.data.path')
[ "$PATH2" != "$PATH1" ] || die "media_uuid" "iki yükleme aynı path"
echo "$PATH2" | grep -Eq '^venues/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' || die "media_path_2" "ikinci path sözleşmesi değil"
okk; note "iki başarı farklı uuid"
psql "$DBURL" -v ON_ERROR_STOP=1 -c "delete from storage.objects where bucket_id='media' and name in ('$PATH1','$PATH2');" >/tmp/media_rm.out 2>&1 || die "media_teardown" "ephemeral object delete failed"
AFTER=$(count_media); [ "$AFTER" = "$BEFORE" ] || die "media_delta" "object delta $BEFORE->$AFTER"; okk; note "harness teardown object delta 0"

echo "==============================="
echo "CDP3C_EDGE_HTTP_SUITE pass=$pass fail=$fail"
# Bu YALNIZ HTTP-suite sonucudur. Nihai başarı sentinel'i (LOCAL_CDP3C_EDGE_INTEGRATION_PASS)
# workflow'da secret-scan + teardown'dan SONRA ayrı if:success adımında basılır.
echo "CDP3C_EDGE_HTTP_SUITE_PASS"
