-- =====================================================================
-- CDP-3C · SOFT-DOWN sonrası GÜÇLENDİRİLMİŞ assertion (yalnız varlık DEĞİL)
-- down_soft UYGULANDIKTAN sonra koşar. Enforcement/immutability/veri KORUNUR mu?
-- Zero-footprint (BEGIN...ROLLBACK). Başarısızlık → RAISE.
-- =====================================================================
\set ON_ERROR_STOP on
begin;
do $$
declare v_rls boolean; v_force boolean; v_hmac text; v_ctrl uuid := gen_random_uuid(); v_txt uuid := gen_random_uuid(); t text; v_ev uuid; sig text;
begin
  -- 1) TÜM dış write RPC'leri (kullanıcı+flow+admin+config+approval+internal) allowlist ile GERÇEKTEN gitti (düzeltme #3)
  foreach sig in array array[
    'public.consent_get_my_state()',
    'public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid)',
    'public.service_pref_set(public.service_pref_key,boolean,text,uuid)',
    'public.consent_set_via_flow(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid)',
    'public.legal_notice_record(public.legal_subject_kind,uuid,public.consent_doc_type,uuid,public.consent_source,text,uuid)',
    'public.anon_subject_create(text,uuid)',
    'public.anon_consent_set(uuid,public.consent_purpose,boolean,uuid,text,uuid)',
    'public.anon_merge_into_user(uuid,uuid,text,uuid)',
    'public.admin_q_member_consent(uuid,uuid)',
    'public.admin_w_apply_suppression(uuid,text,public.suppression_channel,public.suppression_scope,public.suppression_reason,text,text,uuid)',
    'public.iys_supersede_red(uuid,text,public.suppression_channel,public.suppression_scope,text,text,uuid)',
    'public.admin_w_set_marketing_enabled(uuid,boolean,text,text,uuid)',
    'public.admin_w_set_marketing_capture_enabled(uuid,boolean,text,text,uuid)',
    'public.admin_w_add_readiness_attestation(uuid,public.readiness_domain,public.readiness_condition,text,timestamptz,text,text,uuid)',
    'public.admin_w_revoke_readiness_attestation(uuid,uuid,text,text,uuid)',
    'public.admin_w_set_service_pref_default(uuid,public.service_pref_key,boolean,text,text,uuid)',
    'public.admin_w_set_anon_ttl(uuid,int,text,text,uuid)',
    'public.admin_w_approve_consent_text(uuid,uuid,text,text,text,uuid)',
    'public.admin_w_publish_controller_version(uuid,uuid,boolean,text,text,uuid)',
    'public.admin_w_publish_consent_text(uuid,uuid,boolean,text,text,uuid)',
    'public._consent_set_internal(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid)'] loop
    if to_regprocedure(sig) is not null then raise exception 'DS: RPC hala var: %', sig; end if;
  end loop;

  -- 2) İş tabloları + RLS enabled+forced KORUNDU (veri düşmedi)
  foreach t in array array['member_consent_events','member_consent_current','contact_suppression_current','marketing_config','readiness_attestations','consent_text_versions','controller_identity_versions'] loop
    if to_regclass('public.'||t) is null then raise exception 'DS: % tablosu düşürülmüş', t; end if;
    select relrowsecurity, relforcerowsecurity into v_rls, v_force from pg_class where relname=t and relnamespace='public'::regnamespace;
    if not (v_rls and v_force) then raise exception 'DS: % RLS enable/force kaybetti', t; end if;
  end loop;
  if not exists(select 1 from public.marketing_config where id=1) then raise exception 'DS: marketing_config satırı kayıp'; end if;

  -- 3) Vault pepper + _contact_hmac KORUNDU ve çalışıyor
  if not exists(select 1 from vault.secrets where name='cdp3c_contact_pepper_v1') then raise exception 'DS: pepper silinmiş'; end if;
  v_hmac := public._contact_hmac('a@b.test',1);
  if v_hmac !~ '^[0-9a-f]{64}$' then raise exception 'DS: _contact_hmac bozuk'; end if;

  -- 4) published immutability trigger'ları HALA enforce ediyor (deactivate→mutate KAPALI)
  insert into public.controller_identity_versions(id,controller_type,version,display_name,natural_person_fields,is_published)
    values (v_ctrl,'natural_person',777,'DS Kişi', jsonb_build_object('full_name','DS','contact_channel','k@e.test'), true);
  begin
    update public.controller_identity_versions set display_name='HACK' where id=v_ctrl;
    raise exception 'DS: controller published mutate edildi (immutability kaybolmuş)';
  exception when others then if sqlerrm !~ 'controller_published_immutable' then raise exception 'DS controller wrong: %', sqlerrm; end if; end;
  insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body,is_published)
    values (v_txt,'gizlilik_politikasi',777,'tr',v_ctrl,'DS immutable gövde yeterince uzun metin.', true);
  begin
    update public.consent_text_versions set body='HACK' where id=v_txt;
    raise exception 'DS: consent_text published mutate edildi';
  exception when others then if sqlerrm !~ 'consent_text_published_immutable' then raise exception 'DS text wrong: %', sqlerrm; end if; end;

  -- 5) append-only guard HALA aktif
  insert into public.member_consent_events(user_id,purpose,action,consent_epoch,source,request_id,idempotency_key,fingerprint)
    values (gen_random_uuid(),'email_marketing','granted',1,'system','r',gen_random_uuid(),'fp') returning id into v_ev;
  begin
    update public.member_consent_events set source='pref_center' where id=v_ev;
    raise exception 'DS: append-only kayboldu';
  exception when others then if sqlerrm !~ 'append_only_member_consent_events' then raise exception 'DS append wrong: %', sqlerrm; end if; end;

  -- 6) marketing hard-gate guard HALA doğrudan enable'ı engelliyor (readiness eksik)
  begin
    update public.marketing_config set marketing_enabled=true where id=1;
    raise exception 'DS: marketing_enabled doğrudan açıldı (hard-gate kayboldu)';
  exception when others then if sqlerrm !~ 'marketing_enable_readiness_incomplete' then raise exception 'DS gate wrong: %', sqlerrm; end if; end;

  raise notice 'CDP3C_DOWNSOFT_ASSERT_PASS';
end $$;
rollback;
\echo 'CDP3C_DOWNSOFT_ASSERT_PASS'
