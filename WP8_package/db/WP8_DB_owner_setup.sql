-- WP8 OWNER SETUP (TEMPLATE). Never applied by the builder or by CI against production.
-- One step per owner-approved call, in this order: enable -> allowlist (A, C) -> evidence ->
-- allowlist (B, within 24 h of enable) -> evidence -> close.
-- Before each call, replace EVERY placeholder in the approved copy:
--   @@ARM_YES@@           -> YES
--   @@STEP@@              -> enable | allowlist | close
--   @@SUPER_ADMIN_UUID@@  -> the owner's super_admin user id (a uuid, not an e-mail)
--   @@QA_LABEL@@          -> A | B | C        (step allowlist only; otherwise NONE)
--   @@QA_USER_UUID@@      -> the QA user's id (step allowlist only; otherwise 00000000-0000-0000-0000-000000000000)
-- An unreplaced placeholder fails closed (invalid step or uuid) and the whole transaction rolls back.
-- QA users are ordinary test accounts the owner creates through the normal site sign-up AFTER
-- the enable step (Auth OTP, no direct auth.users writes; PRD 2.4 needs owner approval, decision D5):
--   QA-A: first name O'Neil entered in the profile banner (proves HTML escaping), pref ON.
--   QA-B: no first name (proves the neutral greeting), pref ON. Allowlisted only after A's welcome
--         reached sent or delivered (the step refuses otherwise).
--   QA-C: welcome preference switched OFF in the e-mail preferences dialog BEFORE allowlisting.
-- A run is everything since the current boundary (welcome_enqueue_from, set by the enable step).
-- The labels wp8-qa-A/B/C belong to the run in which they were allowlisted (added_at >= boundary):
-- after a hard kill, a new enable moves the boundary forward and the labels are free again for new
-- QA accounts; the earlier run's rows stay inactive as evidence. A user id is never allowlisted twice.
-- Refuses unless: WP8 functions match the stored manifest, provider flags as expected for the step,
-- template pinned with both sha256, no risky trigger on members/auth.users/auth.identities,
-- GoTrue OTP columns present (quota headroom), and the acceptance window is still open.
select set_config('wp8.allow_setup', '@@ARM_YES@@', true);
select set_config('wp8.setup_step', '@@STEP@@', true);
select set_config('wp8.actor', '@@SUPER_ADMIN_UUID@@', true);
select set_config('wp8.qa_label', '@@QA_LABEL@@', true);
select set_config('wp8.qa_user', '@@QA_USER_UUID@@', true);

do $wp8_setup$
declare
  v_step text := current_setting('wp8.setup_step', true);
  v_actor uuid; v_label text; v_user uuid; v_note text;
  pol public.email_service_policy%rowtype; cfg public.email_provider_config%rowtype;
  v_auth timestamptz; v_member timestamptz; v_pref boolean; v_n int; v_res jsonb;
begin
  if coalesce(current_setting('wp8.allow_setup', true), '') <> 'YES' then
    raise exception 'wp8_setup_refused_without_explicit_arm';
  end if;
  if v_step is null or v_step not in ('enable', 'allowlist', 'close') then
    raise exception 'wp8_setup_unknown_step';
  end if;
  v_actor := current_setting('wp8.actor')::uuid;
  if not (public._admin_active(v_actor) and public._admin_has_role(v_actor, array['super_admin'])) then
    raise exception 'wp8_setup_actor_not_super_admin';
  end if;
  if exists (select 1 from public.email_wp8_manifest m where m.object_kind = 'function'
              and (to_regprocedure(m.signature) is null
                   or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(m.signature)) is distinct from m.body_md5))
     or (select count(*) from public.email_wp8_manifest where object_kind = 'function') <> 14 then
    raise exception 'wp8_setup_functions_do_not_match_manifest';
  end if;
  if not exists (select 1 from public.email_service_templates t join public.email_service_policy p on p.welcome_template_id = t.id
                  where p.id = 1 and t.html_sha256 = '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'
                    and t.text_sha256 = '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'
                    and encode(sha256(convert_to(t.body_html, 'UTF8')), 'hex') = t.html_sha256
                    and encode(sha256(convert_to(t.body_text, 'UTF8')), 'hex') = t.text_sha256) then
    raise exception 'wp8_setup_template_unverified';
  end if;
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
              where not t.tgisinternal
                and t.tgrelid in (select x from (values (to_regclass('public.members')), (to_regclass('auth.users')), (to_regclass('auth.identities'))) v(x) where x is not null)
                and p.prosrc ~* '(\mnet\.|\mhttp_(get|post|put|patch|delete|head|request)\M|\mhttp\s*\(|extensions\.http|dblink|pg_net|email_enqueue|email_outbox|email_claim_batch|email_dispatch_kick|welcome_enqueue_sweep|functions/v1)') then
    raise exception 'wp8_setup_unreviewed_trigger_on_members_or_auth';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'auth' and table_name = 'users'
       and column_name in ('confirmation_sent_at', 'recovery_sent_at', 'email_change_sent_at', 'reauthentication_sent_at')) <> 4 then
    raise exception 'wp8_setup_auth_otp_columns_missing';
  end if;
  if not ((public.service_delivery_readiness_check()) ? 'ready') then
    raise exception 'wp8_setup_readiness_not_callable';
  end if;
  if to_regclass('cron.job') is not null then
    execute $q$select count(*) from cron.job where jobname in ('wp8-welcome-sweep', 'wp8-email-dispatch-kick', 'wp8-email-purge') and active$q$ into v_n;
    if v_n <> 3 then raise exception 'wp8_setup_scheduler_incomplete:%', v_n; end if;
  end if;
  select * into cfg from public.email_provider_config where id = 1 for update;
  select * into pol from public.email_service_policy where id = 1 for update;

  if v_step = 'enable' then
    if cfg.essential_enabled or cfg.service_enabled or cfg.public_go_live then raise exception 'wp8_setup_enable_requires_flags_off'; end if;
    if (select count(*) from public.email_send_allowlist where active) <> 0 then raise exception 'wp8_setup_enable_requires_empty_allowlist'; end if;
    if pol.welcome_auto_enqueue_enabled then raise exception 'wp8_setup_already_enabled'; end if;
    if (select count(*) from public.email_outbox where status in ('queued', 'sending')) <> 0 then raise exception 'wp8_setup_enable_requires_no_inflight'; end if;
    update public.email_service_policy
       set service_daily_cap = 40, service_monthly_cap = 1200, welcome_delay_minutes = 10, welcome_max_age_hours = 48,
           welcome_queue_expiry_hours = 72, welcome_sweep_limit = 20, service_dispatch_paused = false
     where id = 1;
    v_res := public.admin_w_welcome_automation_set(v_actor, true, 'wp8 allowlist phase', 'wp8-setup-enable');
    update public.email_provider_config set service_enabled = true, updated_at = now(), updated_by = v_actor where id = 1;
    insert into public.admin_write_log(actor_uid, action, target_type, target_id, before, after, reason, request_id, idempotency_key, at)
    values (v_actor, 'wp8_setup_enable', 'email_provider_config', '1', jsonb_build_object('service_enabled', false),
            jsonb_build_object('service_enabled', true, 'daily_cap', 40, 'monthly_cap', 1200), 'wp8 allowlist phase', 'wp8-setup-enable',
            md5('wp8-setup-enable|' || clock_timestamp()::text)::uuid, clock_timestamp());
    raise notice 'WP8_SETUP_ENABLE_OK boundary_set=% service_enabled=true essential=false public_go_live=false allowlist_active=0',
      (select welcome_enqueue_from is not null from public.email_service_policy where id = 1);

  elsif v_step = 'allowlist' then
    v_label := current_setting('wp8.qa_label');
    if v_label not in ('A', 'B', 'C') then raise exception 'wp8_setup_bad_label'; end if;
    v_user := current_setting('wp8.qa_user')::uuid;
    v_note := 'wp8-qa-' || v_label;
    if not pol.welcome_auto_enqueue_enabled or pol.welcome_enqueue_from is null or not cfg.service_enabled or cfg.public_go_live or cfg.essential_enabled then
      raise exception 'wp8_setup_allowlist_requires_enable_step';
    end if;
    if pol.welcome_enqueue_from < now() - interval '24 hours' then
      raise exception 'wp8_setup_acceptance_window_exceeded';
    end if;
    select u.created_at into v_auth from auth.users u where u.id = v_user;
    if v_auth is null then raise exception 'wp8_setup_qa_user_unknown'; end if;
    if v_auth < pol.welcome_enqueue_from then raise exception 'wp8_setup_qa_user_signed_up_before_boundary'; end if;
    select m.created_at into v_member from public.members m where m.user_id = v_user;
    if v_member is null then raise exception 'wp8_setup_qa_user_never_logged_in'; end if;
    if v_member < now() - make_interval(hours => pol.welcome_max_age_hours) + interval '1 hour' then
      raise exception 'wp8_setup_qa_user_too_old_for_window';
    end if;
    select c.enabled into v_pref from public.member_service_pref_current c where c.user_id = v_user and c.pref_key = 'welcome_service_email';
    if v_label in ('A', 'B') and v_pref is distinct from true then raise exception 'wp8_setup_qa_pref_must_be_on'; end if;
    if v_label = 'C' and v_pref is distinct from false then raise exception 'wp8_setup_qa_c_pref_must_be_off'; end if;
    if exists (select 1 from public.email_outbox where user_id = v_user) then raise exception 'wp8_setup_qa_user_has_outbox_rows'; end if;
    if exists (select 1 from public.email_send_allowlist where user_id = v_user) then raise exception 'wp8_setup_qa_already_allowlisted'; end if;
    if exists (select 1 from public.email_send_allowlist where note = v_note and (active or added_at >= pol.welcome_enqueue_from)) then
      raise exception 'wp8_setup_qa_label_already_used_in_this_run';
    end if;
    if v_label = 'B' and not exists (
         select 1 from public.email_send_allowlist a join public.email_outbox o on o.user_id = a.user_id
          where a.note = 'wp8-qa-A' and a.active and a.added_at >= pol.welcome_enqueue_from
            and o.idempotency_key = 'wp8:welcome_service_email:v1:' || a.user_id::text
            and o.created_at >= pol.welcome_enqueue_from and o.status in ('sent', 'delivered')) then
      raise exception 'wp8_setup_b_requires_a_first';
    end if;
    if (select count(*) from public.email_send_allowlist where active) >= 3 then raise exception 'wp8_setup_allowlist_limit'; end if;
    insert into public.email_send_allowlist(user_id, note, active, added_by) values (v_user, v_note, true, v_actor);
    insert into public.admin_write_log(actor_uid, action, target_type, target_id, before, after, reason, request_id, idempotency_key, at)
    values (v_actor, 'wp8_setup_allowlist', 'email_send_allowlist', v_note, '{}'::jsonb, jsonb_build_object('label', v_label, 'active', true),
            'wp8 sequential acceptance', 'wp8-setup-allowlist-' || v_label, md5('wp8-setup-allowlist|' || v_label || '|' || clock_timestamp()::text)::uuid, clock_timestamp());
    raise notice 'WP8_SETUP_ALLOWLIST_OK label=% allowlist_active=%', v_label, (select count(*) from public.email_send_allowlist where active);

  else
    update public.email_send_allowlist set active = false where note in ('wp8-qa-A', 'wp8-qa-B', 'wp8-qa-C');
    get diagnostics v_n = row_count;
    if cfg.public_go_live then raise exception 'wp8_setup_close_public_go_live_must_stay_off'; end if;
    insert into public.admin_write_log(actor_uid, action, target_type, target_id, before, after, reason, request_id, idempotency_key, at)
    values (v_actor, 'wp8_setup_close', 'email_send_allowlist', 'wp8-qa', '{}'::jsonb, jsonb_build_object('deactivated', v_n),
            'wp8 allowlist phase closed', 'wp8-setup-close', md5('wp8-setup-close|' || clock_timestamp()::text)::uuid, clock_timestamp());
    raise notice 'WP8_SETUP_CLOSE_OK deactivated=% automation=% public_go_live=false', v_n,
      (select welcome_auto_enqueue_enabled from public.email_service_policy where id = 1);
  end if;
end
$wp8_setup$;
