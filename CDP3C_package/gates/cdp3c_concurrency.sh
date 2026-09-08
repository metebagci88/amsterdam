#!/usr/bin/env bash
# CDP-3C · GERÇEK iki-bağlantı (iki backend) concurrency kanıtı.
# Kullanım: cdp3c_concurrency.sh "<PSQL_URI>"   (baseline+up UYGULANMIŞ olmalı)
# Ephemeral CI'da committed fixture kullanır (stack sonda yıkılır). Zero-footprint
# gerekliliği PRODUCTION hosted testler içindir; bu ephemeral stack tamamen silinir.
set -uo pipefail
URI="${1:?PSQL_URI gerekli}"
# YAZAN harness → production'da çalışmasın: iki-katman + ephemeral sentinel (düzeltme #2)
source "$(cd "$(dirname "$0")" && pwd)/_ephemeral_guard.sh"
require_ephemeral "$URI"
Q(){ psql "$URI" -v ON_ERROR_STOP=1 -qtA -c "$1"; }
fail(){ echo "CONCURRENCY_FAIL:$1"; exit 1; }

# ---- committed fixture: super_admin + aktif legal_entity controller + pointer + onaylı/yayımlı metinler + ttl ----
SUPER="$(Q "insert into public.admin_users(user_id,active) values (gen_random_uuid(),true) returning user_id")"
Q "insert into public.admin_roles(user_id,role) values ('$SUPER','super_admin')" >/dev/null
# controller DRAFT olarak ekle, sonra ATOMİK publish (activate=true → pointer aynı txn; deferred constraint tutarlı)
CTRL="$(Q "insert into public.controller_identity_versions(controller_type,version,display_name,legal_entity_fields) values ('legal_entity',900,'C',jsonb_build_object('legal_name','C','mersis','0000000000000900')) returning id")"
Q "select public.admin_w_publish_controller_version('$SUPER','$CTRL',true,'r','r',gen_random_uuid())" >/dev/null
# cerez metni (anon grant için) — approve+publish
CZ="$(Q "insert into public.consent_text_versions(doc_type,version,locale,controller_version_id,body) values ('cerez_politikasi',900,'tr','$CTRL','Cerez metni yeterince uzun govde metni.') returning id")"
Q "select public.admin_w_approve_consent_text('$SUPER','$CZ','ev:cz','r','r',gen_random_uuid())" >/dev/null
Q "select public.admin_w_publish_consent_text('$SUPER','$CZ',true,'r','r',gen_random_uuid())" >/dev/null
Q "select public.admin_w_set_anon_ttl('$SUPER',180,'r','r',gen_random_uuid())" >/dev/null

# =====================================================================
# Senaryo 1 (#11): AYNI idem + AYNI payload paralel → iki exit 0, aynı JSON, audit=1, write_ops=1, state=1
# =====================================================================
IDEM="$(Q "select gen_random_uuid()")"
CALL="select public.admin_w_set_service_pref_default('$SUPER','plan_reminder',true,'conc','req','$IDEM')"
psql "$URI" -qtA -c "$CALL" >/tmp/s1a.out 2>&1 & P1=$!
psql "$URI" -qtA -c "$CALL" >/tmp/s1b.out 2>&1 & P2=$!
wait $P1; R1=$?; wait $P2; R2=$?
[ "$R1" = 0 ] && [ "$R2" = 0 ] || { echo "s1 exits: $R1/$R2"; cat /tmp/s1a.out /tmp/s1b.out; fail "same_payload_exit"; }
J1="$(tr -d '[:space:]' </tmp/s1a.out)"; J2="$(tr -d '[:space:]' </tmp/s1b.out)"
[ "$J1" = "$J2" ] || { echo "j1=$J1 j2=$J2"; fail "same_payload_json_differ"; }
N_AUD="$(Q "select count(*) from public.admin_write_log where action='set_service_pref_default' and idempotency_key='$IDEM'")"
N_OPS="$(Q "select count(*) from public.consent_write_ops where idempotency_key='$IDEM'")"
N_ST="$(Q "select count(*) from public.service_pref_defaults where pref_key='plan_reminder' and default_enabled")"
[ "$N_AUD" = 1 ] && [ "$N_OPS" = 1 ] && [ "$N_ST" = 1 ] || fail "same_payload_state(audit=$N_AUD ops=$N_OPS st=$N_ST)"

# =====================================================================
# Senaryo 2 (#11): AYNI idem + FARKLI payload → tam bir başarı + tam bir idempotency_conflict; duplicate-key = KUSUR
# =====================================================================
IDEM2="$(Q "select gen_random_uuid()")"
psql "$URI" -qtA -c "select public.admin_w_set_service_pref_default('$SUPER','plan_reminder',true,'A','req','$IDEM2')" >/tmp/s2a.out 2>&1 & PA=$!
psql "$URI" -qtA -c "select public.admin_w_set_service_pref_default('$SUPER','plan_reminder',false,'B','req','$IDEM2')" >/tmp/s2b.out 2>&1 & PB=$!
wait $PA; RA=$?; wait $PB; RB=$?
SUCC=$(( (RA==0?1:0) + (RB==0?1:0) ))
N2="$(Q "select count(*) from public.admin_write_log where action='set_service_pref_default' and idempotency_key='$IDEM2'")"
[ "$SUCC" = 1 ] && [ "$N2" = 1 ] || { cat /tmp/s2a.out /tmp/s2b.out; fail "diff_payload(succ=$SUCC audit=$N2)"; }
if grep -qiE 'duplicate key|consent_write_ops_pkey' /tmp/s2a.out /tmp/s2b.out; then cat /tmp/s2a.out /tmp/s2b.out; fail "diff_payload_duplicate_key_is_0C_defect"; fi
grep -qi 'idempotency_conflict' /tmp/s2a.out /tmp/s2b.out || { cat /tmp/s2a.out /tmp/s2b.out; fail "diff_payload_no_conflict"; }

# =====================================================================
# Senaryo 3 (#4): anon merge vs consent_set AYNI subject paralel — DETERMİNİSTİK (timestamp kanıt DEĞİL)
#   Yalnız iki sonuçtan biri kabul: (A) merge kazanır → consent yalnız anon_subject_merged ile düşer, event=0;
#   (B) consent kazanır → tam 1 event + merge tamamlanır + merge SONRASI yeni consent anon_subject_merged ile reddedilir.
#   Başka hata / boş çıktı / permission / generic SQL hatası → KIRMIZI.
# =====================================================================
U="$(Q "insert into auth.users(id,email) values (gen_random_uuid(),'conc@example.test') returning id")"
Q "insert into public.members(user_id,email) values ('$U','conc@example.test')" >/dev/null
SUBJ="$(Q "select (public.anon_subject_create('r',gen_random_uuid()))->>'subject_id'")"
psql "$URI" -qtA -c "select public.anon_merge_into_user('$SUBJ','$U','r',gen_random_uuid())" >/tmp/s3m.out 2>&1 & PM=$!
psql "$URI" -qtA -c "select public.anon_consent_set('$SUBJ','analytics_storage',true,'$CZ','r',gen_random_uuid())" >/tmp/s3c.out 2>&1 & PC=$!
wait $PM; RM=$?; wait $PC; RC=$?
MERGED="$(Q "select merged_user_id from public.anon_consent_subject where subject_id='$SUBJ'")"
NEV="$(Q "select count(*) from public.anon_consent_events where subject_id='$SUBJ'")"
[ "$MERGED" = "$U" ] || { cat /tmp/s3m.out /tmp/s3c.out; fail "anon_race_subject_not_merged(merged=$MERGED)"; }
if [ "$RM" = 0 ] && [ "$RC" != 0 ]; then
  # (A) merge kazandı → consent yalnız anon_subject_merged; event=0
  grep -qi 'anon_subject_merged' /tmp/s3c.out || { cat /tmp/s3c.out; fail "anon_race_A_wrong_error"; }
  grep -qiE 'permission|does not exist|violates|syntax' /tmp/s3c.out && { cat /tmp/s3c.out; fail "anon_race_A_unexpected_error"; }
  [ "$NEV" = 0 ] || fail "anon_race_A_event_created(NEV=$NEV)"
elif [ "$RC" = 0 ] && [ "$RM" = 0 ]; then
  # (B) consent kazandı → tam 1 event; merge tamamlandı; SONRAKİ consent reddedilir
  [ "$NEV" = 1 ] || fail "anon_race_B_event_count(NEV=$NEV)"
  psql "$URI" -qtA -c "select public.anon_consent_set('$SUBJ','analytics_storage',false,null,'r',gen_random_uuid())" >/tmp/s3d.out 2>&1; RD=$?
  [ "$RD" != 0 ] || { cat /tmp/s3d.out; fail "anon_race_B_post_merge_consent_allowed"; }
  grep -qi 'anon_subject_merged' /tmp/s3d.out || { cat /tmp/s3d.out; fail "anon_race_B_post_merge_wrong_error"; }
  NEV2="$(Q "select count(*) from public.anon_consent_events where subject_id='$SUBJ'")"
  [ "$NEV2" = 1 ] || fail "anon_race_B_event_grew(NEV2=$NEV2)"
else
  cat /tmp/s3m.out /tmp/s3c.out; fail "anon_race_invalid_outcome(RM=$RM RC=$RC)"
fi

# =====================================================================
# Senaryo 4 (#6): iki FARKLI hedef consent-text aktivasyonu paralel (aynı doc_type/locale) → deadlock YOK, tam 1 aktif
# =====================================================================
V2="$(Q "insert into public.consent_text_versions(doc_type,version,locale,controller_version_id,body) values ('acik_riza_marketing',901,'tr','$CTRL','Mkt v901 yeterince uzun govde.') returning id")"
V3="$(Q "insert into public.consent_text_versions(doc_type,version,locale,controller_version_id,body) values ('acik_riza_marketing',902,'tr','$CTRL','Mkt v902 yeterince uzun govde.') returning id")"
Q "select public.admin_w_approve_consent_text('$SUPER','$V2','ev:v2','r','r',gen_random_uuid())" >/dev/null
Q "select public.admin_w_approve_consent_text('$SUPER','$V3','ev:v3','r','r',gen_random_uuid())" >/dev/null
psql "$URI" -qtA -c "select public.admin_w_publish_consent_text('$SUPER','$V2',true,'r','r',gen_random_uuid())" >/tmp/s4a.out 2>&1 & PX=$!
psql "$URI" -qtA -c "select public.admin_w_publish_consent_text('$SUPER','$V3',true,'r','r',gen_random_uuid())" >/tmp/s4b.out 2>&1 & PY=$!
wait $PX; RX=$?; wait $PY; RY=$?
[ "$RX" = 0 ] && [ "$RY" = 0 ] || { cat /tmp/s4a.out /tmp/s4b.out; fail "text_switch_exit($RX/$RY)"; }
if grep -qiE 'deadlock' /tmp/s4a.out /tmp/s4b.out; then cat /tmp/s4a.out /tmp/s4b.out; fail "text_switch_deadlock"; fi
NACT="$(Q "select count(*) from public.consent_text_versions where doc_type='acik_riza_marketing' and locale='tr' and is_active")"
[ "$NACT" = 1 ] || fail "text_switch_active_count=$NACT"

# =====================================================================
# Senaryo 5 (#6): legal_notice_record vs anon_merge AYNI subject paralel — DETERMİNİSTİK
#   (A) notice kazanır → tam 1 notice event + merge tamamlanır (aynı idem replay = aynı sonuç);
#   (B) merge kazanır → notice YALNIZ notice_anon_subject_invalid ile reddedilir, event=0.
#   generic/permission/boş hata KABUL EDİLMEZ.
# =====================================================================
U5="$(Q "insert into auth.users(id,email) values (gen_random_uuid(),'ln@example.test') returning id")"
Q "insert into public.members(user_id,email) values ('$U5','ln@example.test')" >/dev/null
S5="$(Q "select (public.anon_subject_create('r',gen_random_uuid()))->>'subject_id'")"
NIDEM="$(Q "select gen_random_uuid()")"
psql "$URI" -qtA -c "select public.legal_notice_record('anon_subject','$S5','cerez_politikasi','$CZ','cookie_banner','r','$NIDEM')" >/tmp/s5n.out 2>&1 & PN=$!
psql "$URI" -qtA -c "select public.anon_merge_into_user('$S5','$U5','r',gen_random_uuid())" >/tmp/s5g.out 2>&1 & PG=$!
wait $PN; RN=$?; wait $PG; RG=$?
MG="$(Q "select merged_user_id from public.anon_consent_subject where subject_id='$S5'")"
NOTE="$(Q "select count(*) from public.legal_notice_events where subject_id='$S5'")"
[ "$MG" = "$U5" ] || { cat /tmp/s5n.out /tmp/s5g.out; fail "ln_race_not_merged"; }
if [ "$RN" = 0 ] && [ "$RG" = 0 ]; then
  # (A) notice kazandı
  [ "$NOTE" = 1 ] || fail "ln_race_A_note_count($NOTE)"
  # aynı idem replay = aynı sonuç (subject artık merged olsa da)
  psql "$URI" -qtA -c "select public.legal_notice_record('anon_subject','$S5','cerez_politikasi','$CZ','cookie_banner','r','$NIDEM')" >/tmp/s5r.out 2>&1; RR=$?
  [ "$RR" = 0 ] || { cat /tmp/s5r.out; fail "ln_race_A_replay_failed"; }
  NOTE2="$(Q "select count(*) from public.legal_notice_events where subject_id='$S5'")"
  [ "$NOTE2" = 1 ] || fail "ln_race_A_replay_dup($NOTE2)"
elif [ "$RN" != 0 ] && [ "$RG" = 0 ]; then
  # (B) merge kazandı → notice yalnız tanımlı hata
  grep -qi 'notice_anon_subject_invalid' /tmp/s5n.out || { cat /tmp/s5n.out; fail "ln_race_B_wrong_error"; }
  grep -qiE 'permission|does not exist|violates|syntax' /tmp/s5n.out && { cat /tmp/s5n.out; fail "ln_race_B_generic_error"; }
  [ "$NOTE" = 0 ] || fail "ln_race_B_note_created($NOTE)"
else
  cat /tmp/s5n.out /tmp/s5g.out; fail "ln_race_invalid_outcome(RN=$RN RG=$RG)"
fi

echo "CDP3C_CONCURRENCY_PASS"
