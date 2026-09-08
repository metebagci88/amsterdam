-- =====================================================================
-- ASALOCAL · CDP-3C · Çalıştırılabilir hosted test harness (zero-footprint) · v4
-- Geçici GERÇEK Postgres/Supabase stack (baseline + up.sql UYGULANMIŞ).
-- Her assertion başarısızlıkta RAISE → CI non-zero. Sonda isimli liste + 'CDP3C_TESTS_PASS'.
-- Tüm fixture tek transaction; SONDA ROLLBACK. İki-bağlantı concurrency AYRI dosyada
--   (gates/cdp3c_concurrency.sh) gerçek paralel psql ile koşar.
-- =====================================================================
\set ON_ERROR_STOP on
begin;
do $$
declare
  v_super uuid := gen_random_uuid();
  v_user uuid; v_user2 uuid;
  v_ctrl uuid := gen_random_uuid(); v_ctrl_imm uuid := gen_random_uuid(); v_ctrl2 uuid := gen_random_uuid();
  v_txt_kvkk uuid := gen_random_uuid(); v_txt_mkt uuid := gen_random_uuid(); v_txt_imm uuid := gen_random_uuid();
  v_txt_noappr uuid := gen_random_uuid(); v_txt_mkt2 uuid := gen_random_uuid();
  v_email text := 'cdp3c_'||substr(md5(random()::text),1,10)||'@example.test';
  v_hmac text; n int; ok boolean; r jsonb; v_anon uuid; v_idem uuid; v_iys_ev uuid;
  v_members_before int; v_auth_before int; passed text[] := array[]::text[];
  procedure_note text;
begin
  select count(*) into v_members_before from public.members;
  select count(*) into v_auth_before from auth.users;

  insert into auth.users(id,email,created_at) values (gen_random_uuid(), v_email, now()) returning id into v_user;
  insert into public.members(user_id,email,tier,points,created_at,updated_at) values (v_user, v_email,'bronze',0,now(),now());
  insert into auth.users(id,email,created_at) values (gen_random_uuid(), 'x_'||v_email, now()) returning id into v_user2;
  insert into public.members(user_id,email,tier,points,created_at,updated_at) values (v_user2, '','bronze',0,now(),now());
  insert into public.admin_users(user_id,active,created_at) values (v_super,true,now());
  insert into public.admin_roles(user_id,role,granted_at) values (v_super,'super_admin'::public.admin_role,now());

  -- aktif legal_entity controller + pointer
  insert into public.controller_identity_versions(id,controller_type,version,display_name,legal_entity_fields,published_address_form,is_active,is_published)
    values (v_ctrl,'legal_entity',1,'ASALOCAL Ltd', jsonb_build_object('legal_name','ASALOCAL Ltd','mersis','0123456789012345'),'Adres', true, true);
  update public.marketing_config set active_controller_version_id=v_ctrl where id=1;
  -- consent metin draft'ları → hukuk onayı → aktivasyon (RPC)
  insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body) values (v_txt_kvkk,'kvkk_aydinlatma',1,'tr',v_ctrl,'KVKK aydınlatma metni yeterince uzun gövde.');
  insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body) values (v_txt_mkt,'acik_riza_marketing',1,'tr',v_ctrl,'Pazarlama açık rıza metni yeterince uzun gövde.');
  perform public.admin_w_approve_consent_text(v_super, v_txt_kvkk, 'ev:kvkk', 'hukuk', 'r', gen_random_uuid());
  perform public.admin_w_approve_consent_text(v_super, v_txt_mkt, 'ev:mkt', 'hukuk', 'r', gen_random_uuid());
  perform public.admin_w_publish_consent_text(v_super, v_txt_kvkk, true, 'yayın', 'r', gen_random_uuid());
  perform public.admin_w_publish_consent_text(v_super, v_txt_mkt, true, 'yayın', 'r', gen_random_uuid());
  -- immutability fixture'ları (published-inactive)
  insert into public.controller_identity_versions(id,controller_type,version,display_name,natural_person_fields,is_active,is_published)
    values (v_ctrl_imm,'natural_person',1,'Imm Kişi', jsonb_build_object('full_name','Imm','contact_channel','k@e.test'), false, true);
  insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body,is_published)
    values (v_txt_imm,'gizlilik_politikasi',1,'tr',v_ctrl,'Gizlilik politikası immutable gövde yeterince uzun.', true);

  perform set_config('request.jwt.claims', json_build_object('sub',v_user,'role','authenticated')::text, true);

  r := public.consent_get_my_state();
  if (r->'consent') <> '{}'::jsonb then raise exception 'T01 FAIL: %', r; end if; passed:=array_append(passed,'T01_default_absent');

  begin perform public.consent_set_pref_center('email_marketing', true, v_txt_mkt, 'tr', 'r1', gen_random_uuid());
    raise exception 'T02 FAIL'; exception when others then if sqlerrm !~ 'marketing_capture_disabled' then raise exception 'T02 wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T02_capture_disabled');

  begin update public.marketing_config set marketing_capture_enabled=true where id=1;
    raise exception 'T18a FAIL'; exception when others then if sqlerrm !~ 'marketing_capture_readiness_incomplete' then raise exception 'T18a wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T18a_direct_capture_bypass_blocked');

  perform public.admin_w_add_readiness_attestation(v_super,'marketing_capture','legal_signoff','ev:signoff',null,'onay','rc1',gen_random_uuid());
  perform public.admin_w_set_marketing_capture_enabled(v_super, true, 'aç', 'rc2', gen_random_uuid());
  if not (select marketing_capture_enabled from public.marketing_config where id=1) then raise exception 'capture açılamadı'; end if;
  passed:=array_append(passed,'T02b_capture_enabled_via_rpc');

  begin perform public.consent_set_pref_center('email_marketing', true, v_txt_kvkk, 'tr', 'r2', gen_random_uuid());
    raise exception 'T03 FAIL'; exception when others then if sqlerrm !~ 'invalid_or_stale_consent_version' then raise exception 'T03 wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T03_invalid_version');

  r := public.consent_set_pref_center('email_marketing', true, v_txt_mkt, 'tr', 'r3', gen_random_uuid());
  select state='granted' into ok from public.member_consent_current where user_id=v_user and purpose='email_marketing';
  if not ok then raise exception 'T04 FAIL'; end if; passed:=array_append(passed,'T04_grant_ok');

  v_idem := gen_random_uuid();
  perform public.consent_set_pref_center('email_marketing', false, null, 'tr', 'r4', v_idem);
  perform public.consent_set_pref_center('email_marketing', false, null, 'tr', 'r4', v_idem);
  select count(*) into n from public.member_consent_events where user_id=v_user and purpose='email_marketing' and action='withdrawn' and idempotency_key=v_idem;
  if n<>1 then raise exception 'T05 FAIL n=%', n; end if; passed:=array_append(passed,'T05_idem_replay');

  v_idem := gen_random_uuid();
  perform public.consent_set_pref_center('sms_marketing', true, v_txt_mkt, 'tr', 'r5', v_idem);
  begin perform public.consent_set_pref_center('push_marketing', true, v_txt_mkt, 'tr', 'r5', v_idem);
    raise exception 'T06 FAIL'; exception when others then if sqlerrm !~ 'idempotency_conflict' then raise exception 'T06 wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T06_idem_conflict');

  v_hmac := public._contact_hmac(v_email,1);
  select count(*) into n from public.contact_suppression_current c join public.contact_suppression_events e on e.id=c.source_event_id
    where c.channel='email' and c.contact_hmac=v_hmac and c.scope='marketing' and c.reason='user_unsubscribe' and c.status='active' and e.reason='user_unsubscribe' and e.action='suppress';
  if n<>1 then raise exception 'T07 FAIL lineage n=%', n; end if; passed:=array_append(passed,'T07_withdraw_lineage');

  perform public.admin_w_apply_suppression(v_super, v_hmac, 'email','marketing','hard_bounce','bounce','rb',gen_random_uuid());
  select count(*) into n from public.contact_suppression_current where channel='email' and contact_hmac=v_hmac and scope='marketing' and status='active';
  if n<>2 then raise exception 'T08 FAIL n=%', n; end if; passed:=array_append(passed,'T08_multi_reason');

  perform public.consent_set_pref_center('email_marketing', true, v_txt_mkt, 'tr', 'r7', gen_random_uuid());
  select (c.status='superseded' and e.action='supersede' and e.reason='user_unsubscribe') into ok
    from public.contact_suppression_current c join public.contact_suppression_events e on e.id=c.superseded_by
    where c.reason='user_unsubscribe' and c.contact_hmac=v_hmac and c.scope='marketing';
  if not coalesce(ok,false) then raise exception 'T09a FAIL'; end if;
  if (select status from public.contact_suppression_current where reason='hard_bounce' and contact_hmac=v_hmac and scope='marketing')<>'active' then raise exception 'T09b FAIL'; end if;
  passed:=array_append(passed,'T09_grant_supersede_only_user_unsub');

  if has_function_privilege('authenticated','public.consent_set_via_flow(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid)','EXECUTE') then raise exception 'T10a FAIL'; end if;
  if not has_function_privilege('authenticated','public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid)','EXECUTE') then raise exception 'T10b FAIL'; end if;
  passed:=array_append(passed,'T10_source_not_forgeable');

  update public.consent_text_versions set is_active=false where id=v_txt_imm;
  begin update public.consent_text_versions set body='X' where id=v_txt_imm; raise exception 'T11a FAIL';
    exception when others then if sqlerrm !~ 'consent_text_published_immutable' then raise exception 'T11a wrong: %', sqlerrm; end if; end;
  begin update public.consent_text_versions set is_published=false where id=v_txt_imm; raise exception 'T11b FAIL';
    exception when others then if sqlerrm !~ 'consent_text_cannot_unpublish' then raise exception 'T11b wrong: %', sqlerrm; end if; end;
  begin update public.controller_identity_versions set display_name='H' where id=v_ctrl_imm; raise exception 'T11c FAIL';
    exception when others then if sqlerrm !~ 'controller_published_immutable' then raise exception 'T11c wrong: %', sqlerrm; end if; end;
  begin update public.controller_identity_versions set is_published=false where id=v_ctrl_imm; raise exception 'T11d FAIL';
    exception when others then if sqlerrm !~ 'controller_cannot_unpublish' then raise exception 'T11d wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T11_deactivate_mutate_closed');

  begin update public.member_consent_events set source='system' where user_id=v_user; raise exception 'T12 FAIL';
    exception when others then if sqlerrm !~ 'append_only_member_consent_events' then raise exception 'T12 wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T12_append_only');

  begin perform public.admin_w_apply_suppression(v_super, v_hmac, 'email','marketing','user_unsubscribe','x','r',gen_random_uuid());
    raise exception 'T13 FAIL'; exception when others then if sqlerrm !~ 'admin_cannot_set_user_reason' then raise exception 'T13 wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T13_admin_cannot_user_reason');

  select count(*) into n from public.admin_write_log where action='apply_suppression' and actor_uid=v_super;
  if n<1 then raise exception 'T14a FAIL'; end if;
  if exists(select 1 from public.admin_write_log where action='apply_suppression' and (before::text like '%'||v_hmac||'%' or after::text like '%'||v_hmac||'%' or coalesce(target_id,'') like '%'||v_hmac||'%')) then raise exception 'T14b FAIL'; end if;
  passed:=array_append(passed,'T14_admin_audit_no_raw_hmac');

  begin insert into public.controller_identity_versions(controller_type,version,display_name,natural_person_fields) values ('natural_person',10,'x', jsonb_build_object('full_name','a','contact_channel','b','extra','z'));
    raise exception 'T15a FAIL'; exception when others then if sqlerrm !~ 'controller_extra_key' then raise exception 'T15a wrong: %', sqlerrm; end if; end;
  begin insert into public.controller_identity_versions(controller_type,version,display_name,natural_person_fields) values ('natural_person',12,'x', jsonb_build_object('full_name','a'));
    raise exception 'T15c FAIL'; exception when others then if sqlerrm !~ 'controller_missing_key' then raise exception 'T15c wrong: %', sqlerrm; end if; end;
  begin insert into public.controller_identity_versions(controller_type,version,display_name,legal_entity_fields) values ('legal_entity',13,'x', jsonb_build_object('legal_name','a','mersis','123'));
    raise exception 'T15d FAIL'; exception when others then if sqlerrm !~ 'controller_mersis_invalid' then raise exception 'T15d wrong: %', sqlerrm; end if; end;
  begin insert into public.controller_identity_versions(controller_type,version,display_name,natural_person_fields,legal_entity_fields) values ('natural_person',14,'x', jsonb_build_object('full_name','a','contact_channel','b'), jsonb_build_object('legal_name','a','mersis','0123456789012345'));
    raise exception 'T15e FAIL'; exception when others then if sqlerrm !~ 'controller_exactly_one_fieldset|controller_mutual_exclusivity' then raise exception 'T15e wrong: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T15_controller_closed_schema');

  -- T16 iys lineage/scope + no fake
  insert into public.contact_suppression_events(channel,scope,contact_hmac,reason,action,source,request_id,idempotency_key,fingerprint)
    values ('email','marketing',v_hmac,'iys_red','suppress','iys_sync','r',gen_random_uuid(),'fp_iys') returning id into v_iys_ev;
  insert into public.contact_suppression_current(channel,contact_hmac,scope,reason,status,source_event_id) values ('email',v_hmac,'marketing','iys_red','active',v_iys_ev);
  begin perform public.iys_supersede_red(v_super, v_hmac, 'email','all_email','iys:1','r',gen_random_uuid());
    raise exception 'T16a FAIL'; exception when others then if sqlerrm !~ 'no_active_iys_red' then raise exception 'T16a wrong: %', sqlerrm; end if; end;
  perform public.iys_supersede_red(v_super, v_hmac, 'email','marketing','iys:2','r',gen_random_uuid());
  select (c.status='superseded' and e.reason='iys_red' and e.action='supersede') into ok from public.contact_suppression_current c join public.contact_suppression_events e on e.id=c.superseded_by where c.reason='iys_red' and c.contact_hmac=v_hmac and c.scope='marketing';
  if not coalesce(ok,false) then raise exception 'T16b FAIL'; end if; passed:=array_append(passed,'T16_iys_lineage_scope');

  -- T17 source×action×purpose matrisi
  begin perform public.consent_set_via_flow(v_user,'email_marketing',true,v_txt_mkt,'tr','unsubscribe','r',gen_random_uuid()); raise exception 'T17a FAIL';
    exception when others then if sqlerrm !~ 'unsubscribe_is_withdraw_only' then raise exception 'T17a: %', sqlerrm; end if; end;
  begin perform public.consent_set_via_flow(v_user,'email_marketing',true,v_txt_mkt,'tr','cookie_banner','r',gen_random_uuid()); raise exception 'T17b FAIL';
    exception when others then if sqlerrm !~ 'cookie_banner_purpose_only' then raise exception 'T17b: %', sqlerrm; end if; end;
  begin perform public.consent_set_via_flow(v_user,'email_marketing',true,v_txt_mkt,'tr','signup','r',gen_random_uuid()); raise exception 'T17c FAIL';
    exception when others then if sqlerrm !~ 'signup_cannot_grant_marketing' then raise exception 'T17c: %', sqlerrm; end if; end;
  begin perform public.consent_set_via_flow(v_user,'email_marketing',true,v_txt_mkt,'tr','system','r',gen_random_uuid()); raise exception 'T17d FAIL';
    exception when others then if sqlerrm !~ 'system_cannot_grant' then raise exception 'T17d: %', sqlerrm; end if; end;
  begin perform public.consent_set_via_flow(v_user,'email_marketing',false,null,'tr','import','r',gen_random_uuid()); raise exception 'T17e FAIL';
    exception when others then if sqlerrm !~ 'bad_flow_source' then raise exception 'T17e: %', sqlerrm; end if; end;
  begin perform public.consent_set_via_flow(v_user,'email_marketing',false,null,'tr','iys_sync','r',gen_random_uuid()); raise exception 'T17f FAIL';
    exception when others then if sqlerrm !~ 'bad_flow_source' then raise exception 'T17f: %', sqlerrm; end if; end;
  begin perform public.consent_set_pref_center('analytics_storage',true,null,'tr','r',gen_random_uuid()); raise exception 'T17g FAIL';
    exception when others then if sqlerrm !~ 'analytics_managed_by_cookie_flow' then raise exception 'T17g: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T17_source_action_purpose_matrix');

  begin update public.marketing_config set marketing_enabled=true where id=1; raise exception 'T18b FAIL';
    exception when others then if sqlerrm !~ 'marketing_enable_readiness_incomplete' then raise exception 'T18b: %', sqlerrm; end if; end;
  begin perform public.admin_w_set_marketing_enabled(v_super, true, 'aç', 'r', gen_random_uuid()); raise exception 'T18c FAIL';
    exception when others then if sqlerrm !~ 'marketing_readiness_incomplete' then raise exception 'T18c: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T18_marketing_enable_blocked');

  -- T19 admin 0C conflict (aynı idem farklı reason_text)
  v_idem := gen_random_uuid();
  perform public.admin_w_apply_suppression(v_super, v_hmac, 'sms','marketing','abuse','ilk','r',v_idem);
  begin perform public.admin_w_apply_suppression(v_super, v_hmac, 'sms','marketing','abuse','FARKLI','r',v_idem); raise exception 'T19 FAIL';
    exception when others then if sqlerrm !~ 'idempotency_conflict' then raise exception 'T19: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T19_admin_0c_conflict');

  -- T20 anon
  begin perform public.anon_subject_create('r', gen_random_uuid()); raise exception 'T20a FAIL';
    exception when others then if sqlerrm !~ 'anon_ttl_not_configured' then raise exception 'T20a: %', sqlerrm; end if; end;
  perform public.admin_w_set_anon_ttl(v_super, 180, 'ttl', 'r', gen_random_uuid());
  r := public.anon_subject_create('r', gen_random_uuid()); v_anon := (r->>'subject_id')::uuid;
  -- T20 stale anon text: yanlış text → red (düzeltme #8)
  begin perform public.anon_consent_set(v_anon,'analytics_storage',true, v_txt_mkt, 'r', gen_random_uuid()); raise exception 'T20stale FAIL';
    exception when others then if sqlerrm !~ 'invalid_or_stale_consent_version' then raise exception 'T20stale: %', sqlerrm; end if; end;
  -- cerez metni yoksa grant text null? gerekli; cerez metni oluştur+approve+activate
  insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body) values (gen_random_uuid(),'cerez_politikasi',1,'tr',v_ctrl,'Çerez politikası metni yeterince uzun gövde.');
  perform public.admin_w_approve_consent_text(v_super, (select id from public.consent_text_versions where doc_type='cerez_politikasi' and version=1 and locale='tr'), 'ev:cz','hukuk','r',gen_random_uuid());
  perform public.admin_w_publish_consent_text(v_super, (select id from public.consent_text_versions where doc_type='cerez_politikasi' and version=1 and locale='tr'), true, 'yayın','r',gen_random_uuid());
  perform public.anon_consent_set(v_anon,'analytics_storage',true, (select id from public.consent_text_versions where doc_type='cerez_politikasi' and version=1 and locale='tr'), 'r', gen_random_uuid());
  if (select state from public.anon_consent_current where subject_id=v_anon and purpose='analytics_storage')<>'granted' then raise exception 'T20b FAIL'; end if;
  begin perform public.anon_consent_set(v_anon,'email_marketing',true,null,'r',gen_random_uuid()); raise exception 'T23 FAIL';
    exception when others then if sqlerrm !~ 'anon_purpose_not_allowed' then raise exception 'T23: %', sqlerrm; end if; end;
  update public.anon_consent_subject set expires_at=now()-interval '1 day' where subject_id=v_anon;
  begin perform public.anon_consent_set(v_anon,'advertising_storage',true,null,'r',gen_random_uuid()); raise exception 'T20c FAIL';
    exception when others then if sqlerrm !~ 'anon_subject_expired' then raise exception 'T20c: %', sqlerrm; end if; end;
  r := public.anon_subject_create('r', gen_random_uuid()); v_anon := (r->>'subject_id')::uuid;
  perform public.anon_merge_into_user(v_anon, v_user, 'r', gen_random_uuid());
  if (select merged_user_id from public.anon_consent_subject where subject_id=v_anon)<>v_user then raise exception 'T20d FAIL'; end if;
  begin perform public.anon_merge_into_user(v_anon, v_user2, 'r', gen_random_uuid()); raise exception 'T20e FAIL';
    exception when others then if sqlerrm !~ 'anon_subject_merge_conflict' then raise exception 'T20e: %', sqlerrm; end if; end;
  -- merge hedef kullanıcı yok → red
  begin perform public.anon_merge_into_user((public.anon_subject_create('r', gen_random_uuid())->>'subject_id')::uuid, gen_random_uuid(), 'r', gen_random_uuid()); raise exception 'T20f FAIL';
    exception when others then if sqlerrm !~ 'target_user_not_found' then raise exception 'T20f: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T20_anon_set_merge_expiry_staletext');

  -- T21 legal_notice typed subject; consent üretmez
  perform public.legal_notice_record('member_uid', v_user, 'kvkk_aydinlatma', v_txt_kvkk, 'signup', 'r', gen_random_uuid());
  select count(*) into n from public.legal_notice_events where subject_id=v_user and subject_kind='member_uid';
  if n<>1 then raise exception 'T21a FAIL'; end if;
  if exists(select 1 from public.member_consent_current where user_id=v_user and purpose='analytics_storage') then raise exception 'T21b FAIL'; end if;
  passed:=array_append(passed,'T21_legal_notice_no_consent');

  -- T38 legal_notice idem-first: kayıt sonrası subject merge olsa bile aynı idem replay AYNI sonucu döner (düzeltme #2)
  declare v_s uuid; v_i uuid := gen_random_uuid(); v_cz uuid; begin
    v_cz := (select id from public.consent_text_versions where doc_type='cerez_politikasi' and version=1 and locale='tr');
    v_s := (public.anon_subject_create('r',gen_random_uuid())->>'subject_id')::uuid;
    perform public.legal_notice_record('anon_subject', v_s, 'cerez_politikasi', v_cz, 'cookie_banner', 'r', v_i);
    perform public.anon_merge_into_user(v_s, v_user, 'r', gen_random_uuid());   -- subject artık merged
    r := public.legal_notice_record('anon_subject', v_s, 'cerez_politikasi', v_cz, 'cookie_banner', 'r', v_i);  -- replay
    if (r->>'ok')<>'true' then raise exception 'T38a FAIL: replay hata döndü %', r; end if;
    select count(*) into n from public.legal_notice_events where subject_id=v_s;
    if n<>1 then raise exception 'T38b FAIL: mükerrer event n=%', n; end if;
    -- farklı payload aynı idem → conflict
    begin perform public.legal_notice_record('anon_subject', v_s, 'kvkk_aydinlatma', v_txt_kvkk, 'system', 'r', v_i);
      raise exception 'T38c FAIL'; exception when others then if sqlerrm !~ 'idempotency_conflict' then raise exception 'T38c: %', sqlerrm; end if; end;
  end;
  passed:=array_append(passed,'T38_legal_notice_idem_first');

  -- T39 approve 0C intent-based idem (düzeltme #5): same-hash replay / edit-eski-idem / edit-yeni-idem
  declare v_t uuid := gen_random_uuid(); v_ap uuid := gen_random_uuid(); r2 jsonb; h1 text; begin
    insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body) values (v_t,'uyelik_sartlari',9,'tr',v_ctrl,'Onay idem test govdesi yeterince uzun metin.');
    r := public.admin_w_approve_consent_text(v_super, v_t, 'ev:a','r','r', v_ap);
    r2 := public.admin_w_approve_consent_text(v_super, v_t, 'ev:a','r','r', v_ap);   -- (a) same-hash replay
    if (r->>'id') <> (r2->>'id') then raise exception 'T39a FAIL: replay farkli id'; end if;
    select count(*) into n from public.consent_text_approvals where text_version_id=v_t; if n<>1 then raise exception 'T39a FAIL: dup approval'; end if;
    h1 := r->>'approved_hash';
    update public.consent_text_versions set body='DUZENLENDI govde yeterince uzun metin.' where id=v_t;   -- draft edit → hash B
    r2 := public.admin_w_approve_consent_text(v_super, v_t, 'ev:a','r','r', v_ap);   -- (b) eski idem, aynı intent → ESKİ sonuç
    if (r2->>'approved_hash') <> h1 then raise exception 'T39b FAIL: eski idem yeni hash onayladi'; end if;
    select count(*) into n from public.consent_text_approvals where text_version_id=v_t; if n<>1 then raise exception 'T39b FAIL: yeni approval olustu'; end if;
    r2 := public.admin_w_approve_consent_text(v_super, v_t, 'ev:a','r','r', gen_random_uuid());   -- (c) yeni idem → yeni hash onayı
    if (r2->>'approved_hash') = h1 then raise exception 'T39c FAIL: yeni idem eski hash'; end if;
    select count(*) into n from public.consent_text_approvals where text_version_id=v_t; if n<>2 then raise exception 'T39c FAIL: approval sayisi %', n; end if;
  end;
  passed:=array_append(passed,'T39_approve_idem_intent');

  -- T22 attestation revoke + combo/expires reddi
  perform public.admin_w_add_readiness_attestation(v_super,'marketing','mersis_business','ev:m',null,'ekle','r',gen_random_uuid());
  if (public.marketing_readiness_check()->'missing') @> '["mersis_business"]'::jsonb then raise exception 'T22a FAIL'; end if;
  perform public.admin_w_revoke_readiness_attestation(v_super, (select id from public.readiness_attestations where domain='marketing' and condition='mersis_business' and revokes_attestation_id is null), 'revoke','r',gen_random_uuid());
  if not ((public.marketing_readiness_check()->'missing') @> '["mersis_business"]'::jsonb) then raise exception 'T22b FAIL'; end if;
  begin perform public.admin_w_add_readiness_attestation(v_super,'service_delivery','mersis_business','ev:x',null,'r','r',gen_random_uuid()); raise exception 'T22c FAIL';
    exception when others then if sqlerrm !~ 'readiness_combo_not_allowed' then raise exception 'T22c: %', sqlerrm; end if; end;
  begin perform public.admin_w_add_readiness_attestation(v_super,'marketing','iys_application','ev:y', now()-interval '1 day','r','r',gen_random_uuid()); raise exception 'T22d FAIL';
    exception when others then if sqlerrm !~ 'readiness_expires_in_past' then raise exception 'T22d: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T22_attestation_revoke_combo_expires');

  r := public.consent_get_my_state();
  if not ((r->'service_prefs'->>'plan_reminder')='config_pending') then raise exception 'T24 FAIL'; end if; passed:=array_append(passed,'T24_service_pref_config_pending');

  perform set_config('request.jwt.claims', json_build_object('sub',v_user2,'role','authenticated')::text, true);
  begin perform public.consent_set_pref_center('email_marketing', false, null, 'tr', 'r', gen_random_uuid()); raise exception 'T25 FAIL';
    exception when others then if sqlerrm !~ 'contact_email_unresolved_for_suppression' then raise exception 'T25: %', sqlerrm; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub',v_user,'role','authenticated')::text, true);
  passed:=array_append(passed,'T25_withdraw_fail_closed_no_email');

  begin update public.consent_purpose_doc set doc_type='cerez_politikasi' where purpose='email_marketing'; raise exception 'T26 FAIL';
    exception when others then if sqlerrm !~ 'consent_purpose_doc_immutable' then raise exception 'T26: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T26_purpose_doc_immutable');

  if has_table_privilege('authenticated','public.member_consent_current','SELECT') then raise exception 'T27a FAIL'; end if;
  if has_table_privilege('anon','public.contact_suppression_current','SELECT') then raise exception 'T27b FAIL'; end if;
  passed:=array_append(passed,'T27_privilege_matrix');

  -- T28 legal approval required for active
  insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body) values (v_txt_noappr,'uyelik_sartlari',1,'tr',v_ctrl,'Onaysız metin yeterince uzun gövde metni.');
  begin perform public.admin_w_publish_consent_text(v_super, v_txt_noappr, true, 'yayın', 'r', gen_random_uuid()); raise exception 'T28 FAIL';
    exception when others then if sqlerrm !~ 'legal_approval_required_for_active' then raise exception 'T28: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T28_legal_approval_required');

  -- T29 suppression combo matrisi (geçersiz kombinasyon reddi)
  begin perform public.admin_w_apply_suppression(v_super, v_hmac, 'push','marketing','hard_bounce','x','r',gen_random_uuid()); raise exception 'T29 FAIL';
    exception when others then if sqlerrm !~ 'suppression_combo_not_allowed' then raise exception 'T29: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T29_suppression_combo_matrix');

  -- T30 atomik controller/text aktivasyon switch + rollback
  insert into public.controller_identity_versions(id,controller_type,version,display_name,legal_entity_fields) values (v_ctrl2,'legal_entity',2,'ASALOCAL v2', jsonb_build_object('legal_name','ASALOCAL v2','mersis','0123456789012399'));
  perform public.admin_w_publish_controller_version(v_super, v_ctrl2, true, 'switch', 'r', gen_random_uuid());
  select count(*) into n from public.controller_identity_versions where is_active;
  if n<>1 then raise exception 'T30a FAIL: tek aktif değil n=%', n; end if;
  if (select active_controller_version_id from public.marketing_config where id=1)<>v_ctrl2 then raise exception 'T30b FAIL pointer'; end if;
  if (select is_active from public.controller_identity_versions where id=v_ctrl) then raise exception 'T30c FAIL eski aktif kaldı'; end if;
  -- rollback: SÜRESİ GEÇMİŞ controller aktive edilemez; state raise ÖNCESİ değişmez, eski aktif korunur
  insert into public.controller_identity_versions(id,controller_type,version,display_name,legal_entity_fields,valid_from,valid_to)
    values (gen_random_uuid(),'legal_entity',3,'expired', jsonb_build_object('legal_name','e','mersis','0123456789012301'), now()-interval '2 hours', now()-interval '1 hour');
  begin perform public.admin_w_publish_controller_version(v_super, (select id from public.controller_identity_versions where version=3), true, 'x','r',gen_random_uuid());
    raise exception 'T30rb FAIL: expired aktive oldu';
    exception when others then if sqlerrm !~ 'controller_cannot_activate_expired' then raise exception 'T30rb: %', sqlerrm; end if; end;
  if (select active_controller_version_id from public.marketing_config where id=1)<>v_ctrl2 then raise exception 'T30rb FAIL: pointer bozuldu'; end if;
  if not (select is_active from public.controller_identity_versions where id=v_ctrl2) then raise exception 'T30rb FAIL: aktif controller bozuldu'; end if;
  passed:=array_append(passed,'T30_atomic_switch_and_rollback');

  -- T31 marketing text atomik switch (v2 aktive → v1 pasif); pointer zaten v_ctrl2
  insert into public.consent_text_versions(id,doc_type,version,locale,controller_version_id,body) values (v_txt_mkt2,'acik_riza_marketing',2,'tr',v_ctrl2,'Pazarlama v2 açık rıza metni yeterince uzun.');
  perform public.admin_w_approve_consent_text(v_super, v_txt_mkt2, 'ev:m2','hukuk','r',gen_random_uuid());
  perform public.admin_w_publish_consent_text(v_super, v_txt_mkt2, true, 'switch','r',gen_random_uuid());
  select count(*) into n from public.consent_text_versions where doc_type='acik_riza_marketing' and locale='tr' and is_active;
  if n<>1 then raise exception 'T31a FAIL tek aktif değil n=%', n; end if;
  if (select is_active from public.consent_text_versions where id=v_txt_mkt) then raise exception 'T31b FAIL eski mkt aktif kaldı'; end if;
  passed:=array_append(passed,'T31_text_atomic_switch');

  -- T32 config RPC idem same-result + changed-field conflict
  v_idem := gen_random_uuid();
  perform public.admin_w_set_service_pref_default(v_super,'plan_reminder',true,'r1','r',v_idem);
  perform public.admin_w_set_service_pref_default(v_super,'plan_reminder',true,'r1','r',v_idem);  -- same → replay
  select count(*) into n from public.admin_write_log where action='set_service_pref_default' and idempotency_key=v_idem;
  if n<>1 then raise exception 'T32a FAIL same-result n=%', n; end if;
  begin perform public.admin_w_set_service_pref_default(v_super,'plan_reminder',false,'r1','r',v_idem); raise exception 'T32b FAIL';
    exception when others then if sqlerrm !~ 'idempotency_conflict' then raise exception 'T32b: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T32_config_rpc_idem');

  -- T35 legal_notice subject×source matris + varlık negatifleri (düzeltme #8)
  begin perform public.legal_notice_record('member_uid', v_user, 'cerez_politikasi', null, 'cookie_banner', 'r', gen_random_uuid()); raise exception 'T35a FAIL';
    exception when others then if sqlerrm !~ 'notice_source_not_allowed_for_subject' then raise exception 'T35a: %', sqlerrm; end if; end;
  begin perform public.legal_notice_record('member_uid', gen_random_uuid(), 'kvkk_aydinlatma', v_txt_kvkk, 'signup', 'r', gen_random_uuid()); raise exception 'T35b FAIL';
    exception when others then if sqlerrm !~ 'notice_member_not_found' then raise exception 'T35b: %', sqlerrm; end if; end;
  begin perform public.legal_notice_record('anon_subject', v_user, 'kvkk_aydinlatma', v_txt_kvkk, 'signup', 'r', gen_random_uuid()); raise exception 'T35c FAIL';
    exception when others then if sqlerrm !~ 'notice_source_not_allowed_for_subject' then raise exception 'T35c: %', sqlerrm; end if; end;
  begin perform public.legal_notice_record('anon_subject', gen_random_uuid(), 'cerez_politikasi', null, 'cookie_banner', 'r', gen_random_uuid()); raise exception 'T35d FAIL';
    exception when others then if sqlerrm !~ 'notice_anon_subject_invalid' then raise exception 'T35d: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T35_legal_notice_matrix');

  -- T36 suppression çapraz anlamsız kombinasyon reddi (düzeltme #9)
  begin perform public.admin_w_apply_suppression(v_super, v_hmac, 'push','all_email','user_unsubscribe','x','r',gen_random_uuid()); raise exception 'T36a FAIL';
    exception when others then if sqlerrm !~ 'admin_cannot_set_user_reason|suppression_combo_not_allowed' then raise exception 'T36a: %', sqlerrm; end if; end;
  begin perform public.admin_w_apply_suppression(v_super, v_hmac, 'email','global','abuse','x','r',gen_random_uuid()); raise exception 'T36b FAIL';
    exception when others then if sqlerrm !~ 'suppression_combo_not_allowed' then raise exception 'T36b: %', sqlerrm; end if; end;
  begin perform public.admin_w_apply_suppression(v_super, v_hmac, 'global','all_email','admin_safety_block','x','r',gen_random_uuid()); raise exception 'T36c FAIL';
    exception when others then if sqlerrm !~ 'suppression_combo_not_allowed' then raise exception 'T36c: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T36_suppression_cross_negatives');

  -- T37 marketing_config singleton DELETE reddi (düzeltme #1)
  begin delete from public.marketing_config where id=1; raise exception 'T37 FAIL: singleton silindi';
    exception when others then if sqlerrm !~ 'marketing_config_singleton_immutable' then raise exception 'T37: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T37_marketing_config_singleton_immutable');

  -- T29b Auth/members PRE=POST
  if (select count(*) from public.members) <> v_members_before + 2 then raise exception 'T33a FAIL members delta'; end if;
  if (select count(*) from auth.users) <> v_auth_before + 2 then raise exception 'T33b FAIL auth delta'; end if;
  passed:=array_append(passed,'T33_pre_post_unchanged');

  -- T34 çift-yönlü pointer invariant (deferred constraint) — SON test (constraints IMMEDIATE'e çevirir)
  execute 'set constraints all immediate';   -- final tutarlı state doğrulanır (pointer=v_ctrl2, tek aktif=v_ctrl2, aktif metin v_ctrl2-bağlı)
  begin
    update public.controller_identity_versions set is_active=false where id=v_ctrl2;   -- doğrudan service_role saldırısı
    raise exception 'T34 FAIL: pointer pasif controllera isaret edebildi';
  exception when others then if sqlerrm !~ 'active_controller_must_equal_pointer|pointer_not_active_published' then raise exception 'T34: %', sqlerrm; end if; end;
  passed:=array_append(passed,'T34_pointer_two_way_invariant');

  raise notice 'CDP3C_TESTS_PASS list=%', array_to_string(passed, ',');
end $$;
rollback;
\echo 'CDP3C_TESTS_PASS'
