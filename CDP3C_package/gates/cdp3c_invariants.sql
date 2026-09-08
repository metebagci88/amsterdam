-- CDP-3C · Yapısal invariant assertion'ları (migration sonrası). Başarısızlık → RAISE.
\set ON_ERROR_STOP on
do $$
declare t text; v_rls boolean; v_force boolean; v_pol int;
begin
  -- 1) Tüm yeni tablolar RLS enabled + forced + policy YOK (deny-all)
  foreach t in array array[
    'controller_identity_versions','consent_purpose_doc','consent_text_versions','consent_text_approvals','legal_notice_events',
    'member_consent_events','member_consent_current','member_service_pref_events','member_service_pref_current',
    'service_pref_defaults','contact_suppression_events','contact_suppression_current','unsubscribe_tokens',
    'app_privacy_config','anon_consent_subject','anon_consent_events','anon_consent_current',
    'marketing_config','readiness_attestations','consent_write_ops'] loop
    select c.relrowsecurity, c.relforcerowsecurity, (select count(*) from pg_policy p where p.polrelid=c.oid)
      into v_rls, v_force, v_pol from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=t;
    if v_rls is distinct from true then raise exception 'INV: % RLS not enabled', t; end if;
    if v_force is distinct from true then raise exception 'INV: % RLS not forced', t; end if;
    if v_pol<>0 then raise exception 'INV: % has policies (deny-all beklenir)', t; end if;
  end loop;

  -- 2) Kullanıcı RPC'leri: authenticated=true, anon=false
  if not has_function_privilege('authenticated','public.consent_get_my_state()','EXECUTE') then raise exception 'INV: consent_get_my_state'; end if;
  if not has_function_privilege('authenticated','public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid)','EXECUTE') then raise exception 'INV: pref_center'; end if;
  if not has_function_privilege('authenticated','public.service_pref_set(public.service_pref_key,boolean,text,uuid)','EXECUTE') then raise exception 'INV: service_pref_set'; end if;
  if has_function_privilege('anon','public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid)','EXECUTE') then raise exception 'INV: anon can pref_center'; end if;

  -- 3) Kapalı akış/admin/config RPC'leri: authenticated=false, service_role=true
  if has_function_privilege('authenticated','public.consent_set_via_flow(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid)','EXECUTE') then raise exception 'INV: authenticated via_flow'; end if;
  if not has_function_privilege('service_role','public.consent_set_via_flow(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid)','EXECUTE') then raise exception 'INV: service_role via_flow'; end if;
  if has_function_privilege('authenticated','public.admin_q_member_consent(uuid,uuid)','EXECUTE') then raise exception 'INV: authenticated admin_q'; end if;
  if has_function_privilege('authenticated','public.legal_notice_record(public.legal_subject_kind,uuid,public.consent_doc_type,uuid,public.consent_source,text,uuid)','EXECUTE') then raise exception 'INV: authenticated legal_notice'; end if;
  if has_function_privilege('authenticated','public.anon_consent_set(uuid,public.consent_purpose,boolean,uuid,text,uuid)','EXECUTE') then raise exception 'INV: authenticated anon_consent_set'; end if;
  if has_function_privilege('authenticated','public.anon_merge_into_user(uuid,uuid,text,uuid)','EXECUTE') then raise exception 'INV: authenticated anon_merge'; end if;
  if has_function_privilege('authenticated','public.iys_supersede_red(uuid,text,public.suppression_channel,public.suppression_scope,text,text,uuid)','EXECUTE') then raise exception 'INV: authenticated iys_supersede'; end if;
  if has_function_privilege('authenticated','public.marketing_readiness_check()','EXECUTE') then raise exception 'INV: authenticated readiness'; end if;
  if has_function_privilege('authenticated','public.admin_w_set_marketing_enabled(uuid,boolean,text,text,uuid)','EXECUTE') then raise exception 'INV: authenticated set_marketing_enabled'; end if;
  if has_function_privilege('authenticated','public.admin_w_set_marketing_capture_enabled(uuid,boolean,text,text,uuid)','EXECUTE') then raise exception 'INV: authenticated set_capture'; end if;
  if has_function_privilege('authenticated','public.admin_w_add_readiness_attestation(uuid,public.readiness_domain,public.readiness_condition,text,timestamptz,text,text,uuid)','EXECUTE') then raise exception 'INV: authenticated add_attestation'; end if;
  if has_function_privilege('authenticated','public.admin_w_publish_consent_text(uuid,uuid,boolean,text,text,uuid)','EXECUTE') then raise exception 'INV: authenticated publish_text'; end if;
  if not has_function_privilege('service_role','public.admin_w_set_marketing_enabled(uuid,boolean,text,text,uuid)','EXECUTE') then raise exception 'INV: service_role set_marketing_enabled'; end if;
  if not has_function_privilege('service_role','public.anon_consent_set(uuid,public.consent_purpose,boolean,uuid,text,uuid)','EXECUTE') then raise exception 'INV: service_role anon_consent_set'; end if;

  -- 4) Helper'lar authenticated/anon'a KAPALI
  if has_function_privilege('authenticated','public._contact_hmac(text,int)','EXECUTE') then raise exception 'INV: authenticated _contact_hmac'; end if;
  if has_function_privilege('anon','public._contact_hmac(text,int)','EXECUTE') then raise exception 'INV: anon _contact_hmac'; end if;
  if has_function_privilege('authenticated','public._is_capture_gated(public.consent_purpose)','EXECUTE') then raise exception 'INV: authenticated _is_capture_gated'; end if;
  if has_function_privilege('authenticated','public._validate_controller_fields(public.controller_type,jsonb,jsonb)','EXECUTE') then raise exception 'INV: authenticated _validate_controller_fields'; end if;

  -- 5) marketing hard-gate default kapalı
  if (select marketing_enabled from public.marketing_config where id=1) then raise exception 'INV: marketing_enabled default true'; end if;
  if (select marketing_capture_enabled from public.marketing_config where id=1) then raise exception 'INV: marketing_capture_enabled default true'; end if;

  -- 6) marketing_config guard + purpose_doc immutable + suppression FK varlık kontrolü
  if not exists(select 1 from pg_trigger where tgname='trg_marketing_config_guard' and not tgisinternal) then raise exception 'INV: marketing_config guard trigger yok'; end if;
  if not exists(select 1 from pg_trigger where tgname='trg_consent_purpose_doc_immutable' and not tgisinternal) then raise exception 'INV: consent_purpose_doc immutable trigger yok'; end if;
  if not exists(
    select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid
    where c.relname='contact_suppression_current' and con.contype='f'
  ) then raise exception 'INV: contact_suppression_current FK (lineage) yok'; end if;

  -- 7) message_class / journeys EKLENMEMİŞ (faz sınırı)
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='email_templates' and column_name='message_class') then raise exception 'INV: message_class eklenmiş'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='journeys') then raise exception 'INV: journeys eklenmiş'; end if;

  -- 8) AUTHORITATIVE privilege matrisi (tüm public RPC + helper)
  declare s text;
  begin
    -- authenticated YALNIZ bu 3 RPC'yi execute edebilir; anon hiçbirini
    foreach s in array array[
      'public.consent_get_my_state()',
      'public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid)',
      'public.service_pref_set(public.service_pref_key,boolean,text,uuid)'] loop
      if not has_function_privilege('authenticated',s,'EXECUTE') then raise exception 'INV-MATRIX: authenticated exec YOK: %', s; end if;
      if has_function_privilege('anon',s,'EXECUTE') then raise exception 'INV-MATRIX: anon exec VAR: %', s; end if;
    end loop;
    -- service_role-only akış/admin/config RPC'leri: authenticated=false, anon=false, service_role=true
    foreach s in array array[
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
      'public.marketing_readiness_check()','public.marketing_capture_readiness_check()','public.service_delivery_readiness_check()'] loop
      if has_function_privilege('authenticated',s,'EXECUTE') then raise exception 'INV-MATRIX: authenticated exec VAR (olmamalı): %', s; end if;
      if has_function_privilege('anon',s,'EXECUTE') then raise exception 'INV-MATRIX: anon exec VAR: %', s; end if;
      if not has_function_privilege('service_role',s,'EXECUTE') then raise exception 'INV-MATRIX: service_role exec YOK: %', s; end if;
    end loop;
    -- helper/internal/trigger fn'leri: authenticated+anon KAPALI (public.* + underscore)
    foreach s in array array[
      'public._contact_hmac(text,int)','public._is_capture_gated(public.consent_purpose)',
      'public._validate_controller_fields(public.controller_type,jsonb,jsonb)',
      'public._consent_idem_check(uuid,uuid,text,text)','public._require_request_id(text)',
      'public._readiness_attested(public.readiness_domain,public.readiness_condition)',
      'public._suppression_combo_ok(public.suppression_channel,public.suppression_scope,public.suppression_reason)',
      'public._suppression_pair_ok(public.suppression_channel,public.suppression_scope)',
      'public._readiness_combo_ok(public.readiness_domain,public.readiness_condition)',
      'public._marketing_missing()','public._marketing_capture_missing()','public._service_delivery_missing()',
      'public._consent_set_internal(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid)'] loop
      if has_function_privilege('authenticated',s,'EXECUTE') then raise exception 'INV-MATRIX: authenticated helper exec VAR: %', s; end if;
      if has_function_privilege('anon',s,'EXECUTE') then raise exception 'INV-MATRIX: anon helper exec VAR: %', s; end if;
    end loop;
  end;

  -- 9) marketing_config singleton koruması (DELETE trigger + no-delete fn)
  if not exists(select 1 from pg_trigger where tgname='trg_marketing_config_no_delete' and not tgisinternal) then raise exception 'INV: marketing_config no-delete trigger yok'; end if;

  raise notice 'CDP3C_INVARIANTS_PASS';
end $$;
