-- =====================================================================
-- ASALOCAL · welcome_service_email future-default · ACTIVATION
-- BU DOSYA İNERT MİGRATION DEĞİLDİR.
-- Bu turda production'a uygulanmaz. CI apply adımı bunu çalıştırmaz.
-- Çalıştırmak için aynı transaction içinde, bilerek:
--   select set_config('wse.allow_activation','YES', true);
--   select set_config('wse.actor','<super_admin uuid>', true);
--   select set_config('wse.reason','<no email>', true);
--   select set_config('wse.request_id','<id>', true);
--   select set_config('wse.idem','<uuid>', true);
-- Arm yoksa ilk blok exception atar; fonksiyon yazılmaz, satır güncellenmez.
--
-- Yazar: yalnız welcome_service_email üzerinde
--   default_enabled, effective_from=clock_timestamp(), policy_version,
--   configured_at, configured_by.
-- Yazmaz: members, auth.users, preference current/events, consent,
--   marketing, allowlist, outbox, enqueue.
-- effective_from çağıran tarafından geriye alınamaz; fonksiyon kendi saatini yazar.
-- =====================================================================

do $wse_activate_guard$
begin
  if current_setting('wse.allow_activation', true) is distinct from 'YES' then
    raise exception 'activation_refused_without_explicit_arm';
  end if;
end
$wse_activate_guard$;

create or replace function public.admin_w_activate_welcome_service_email_default(
  p_actor uuid, p_reason text, p_request_id text, p_idem uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_fp text;
  v_prev jsonb;
  v_rid text;
  v_reason text;
  v_before boolean;
  v_before_from timestamptz;
  v_before_ver text;
  v_at timestamptz;
  v_res jsonb;
begin
  if p_actor is null then
    raise exception 'actor_required';
  end if;
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then
    raise exception 'forbidden';
  end if;
  v_reason := btrim(coalesce(p_reason,''));
  if v_reason = '' then
    raise exception 'reason_required';
  end if;
  if v_reason like '%@%' then
    raise exception 'reason_must_not_contain_email';
  end if;
  v_rid := public._require_request_id(p_request_id);
  if v_rid like '%@%' then
    raise exception 'request_id_must_not_contain_email';
  end if;
  if p_idem is null then
    raise exception 'idem_required';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='service_pref_defaults'
       and column_name='effective_from'
  ) then
    raise exception 'activation_requires_inert_migration';
  end if;

  v_fp := encode(extensions.digest(convert_to(
    p_actor::text || '|activate_welcome_service_email_default|welcome_service_email|welcome_service_email.v1|' || v_reason,
    'UTF8'), 'sha256'), 'hex');

  v_prev := public._consent_idem_check(p_idem, p_actor, 'activate_welcome_service_email_default', v_fp);
  if v_prev is not null then
    if exists (
      select 1 from public.service_pref_defaults
       where pref_key = 'welcome_service_email'::public.service_pref_key
         and default_enabled is true
         and effective_from is not null
    ) then
      return v_prev;
    end if;
    raise exception 'welcome_default_replay_stale';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('activate_welcome_service_email', 0));

  v_prev := public._consent_idem_check(p_idem, p_actor, 'activate_welcome_service_email_default', v_fp);
  if v_prev is not null then
    if exists (
      select 1 from public.service_pref_defaults
       where pref_key = 'welcome_service_email'::public.service_pref_key
         and default_enabled is true
         and effective_from is not null
    ) then
      return v_prev;
    end if;
    raise exception 'welcome_default_replay_stale';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_members_seed_welcome_service_pref'
       and tgrelid = 'public.members'::regclass
       and not tgisinternal
  ) then
    raise exception 'activation_requires_seed_trigger';
  end if;

  select d.default_enabled, d.effective_from, d.policy_version
    into v_before, v_before_from, v_before_ver
    from public.service_pref_defaults d
   where d.pref_key = 'welcome_service_email'::public.service_pref_key
   for update;
  if not found then
    raise exception 'welcome_default_row_missing';
  end if;
  if v_before is true and v_before_from is not null then
    raise exception 'welcome_default_already_active';
  end if;

  v_at := clock_timestamp();
  update public.service_pref_defaults
     set default_enabled = true,
         effective_from = v_at,
         policy_version = 'welcome_service_email.v1',
         configured_at = v_at,
         configured_by = p_actor
   where pref_key = 'welcome_service_email'::public.service_pref_key;
  if not found then
    raise exception 'welcome_default_row_missing';
  end if;

  v_res := jsonb_build_object(
    'ok', true,
    'key', 'welcome_service_email',
    'default_enabled', true,
    'policy_version', 'welcome_service_email.v1',
    'effective_from', v_at
  );

  insert into public.admin_write_log(
    actor_uid, action, target_type, target_id, before, after, reason, request_id, idempotency_key, at
  ) values (
    p_actor,
    'activate_welcome_service_email_default',
    'service_pref_defaults',
    'welcome_service_email',
    jsonb_build_object('default_enabled', v_before, 'effective_from', v_before_from, 'policy_version', v_before_ver),
    jsonb_build_object('default_enabled', true, 'effective_from', v_at, 'policy_version', 'welcome_service_email.v1'),
    v_reason,
    v_rid,
    p_idem,
    v_at
  );
  insert into public.consent_write_ops(idempotency_key, actor, action, fingerprint, result)
  values (p_idem, p_actor, 'activate_welcome_service_email_default', v_fp, v_res);

  return v_res;
end
$fn$;

revoke all on function public.admin_w_activate_welcome_service_email_default(uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_activate_welcome_service_email_default(uuid,text,text,uuid) to service_role;

select public.admin_w_activate_welcome_service_email_default(
  current_setting('wse.actor')::uuid,
  current_setting('wse.reason'),
  current_setting('wse.request_id'),
  current_setting('wse.idem')::uuid
);
