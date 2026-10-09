-- WP8 welcome automation and e-mail pipeline closure (ASALOCAL, work package 8). INERT migration.
-- WP8_DB_up.sql is generated from WP8_DB_up.src.sql by WP8_package/tools/wp8_build.mjs.
-- Edit the src file only, then rebuild. The two files differ only in the build placeholders.
--
-- Apply as ONE transaction (apply_migration, or psql -1). Statement 2 aborts in autocommit mode.
-- After apply nothing can be enqueued or sent:
--   welcome_auto_enqueue_enabled=false, welcome_enqueue_from=NULL, service caps 0,
--   email_provider_config flags untouched (the PRE guard requires them all false).
-- No net, cron, vault, auth or marketing writes. No member, preference or outbox row is written.
-- Comment lines start at column 0 and never appear inside a dollar-quoted body.
-- The approved welcome v3.2 bytes are embedded hex-encoded and pinned by sha256 CHECKs.
set local statement_timeout = '60s';
set local lock_timeout = '5s';

do $wp8_pre$
declare
  v_md5 text; v_n bigint;
begin
  if current_setting('server_encoding') <> 'UTF8' then raise exception 'WP8_PRE_FAIL:server_encoding'; end if;
  if current_setting('server_version_num')::int < 140000 then raise exception 'WP8_PRE_FAIL:server_version'; end if;
  perform set_config('wp8.first_apply', case when to_regclass('public.email_service_policy') is null then '1' else '0' end, true);
  if to_regclass('public.email_outbox') is null or to_regclass('public.email_provider_config') is null
     or to_regclass('public.email_send_allowlist') is null or to_regclass('public.email_send_events') is null
     or to_regclass('public.member_service_pref_current') is null or to_regclass('public.service_pref_defaults') is null
     or to_regclass('public.admin_write_log') is null
     or to_regclass('auth.users') is null or to_regclass('public.members') is null then
    raise exception 'WP8_PRE_FAIL:missing_base_object';
  end if;
  if to_regprocedure('public.service_delivery_readiness_check()') is null then raise exception 'WP8_PRE_FAIL:readiness_fn'; end if;
  if to_regprocedure('public._append_only_guard()') is null then raise exception 'WP8_PRE_FAIL:append_only_guard'; end if;
  if to_regprocedure('public._admin_active(uuid)') is null or to_regprocedure('public._admin_has_role(uuid,text[])') is null
     or to_regprocedure('public._require_request_id(text)') is null then
    raise exception 'WP8_PRE_FAIL:admin_helpers';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'members'
       and column_name in ('user_id', 'email', 'blocked', 'created_at', 'first_name')) <> 5 then
    raise exception 'WP8_PRE_FAIL:members_columns';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'service_pref_defaults'
       and column_name in ('effective_from', 'policy_version')) <> 2 then
    raise exception 'WP8_PRE_FAIL:wse_columns';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'auth' and table_name = 'users'
       and column_name in ('id', 'created_at')) <> 2 then
    raise exception 'WP8_PRE_FAIL:auth_users_columns';
  end if;

  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)');
  if v_md5 is null or v_md5 not in ('4da18d72fb4822ba4307da5f7ff06ba2', 'cd4968cfd9609292ef01ce476583fd1f') then raise exception 'WP8_PRE_DRIFT:_email_send_decision:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text)');
  if v_md5 is null or v_md5 not in ('ba947a7c1c2f085e8b251877bb67c9a6', 'ed3c0fcd5236646e6043b79ea2eeefeb') then raise exception 'WP8_PRE_DRIFT:email_enqueue:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public._seed_welcome_service_pref_on_member_insert()');
  if v_md5 is null or v_md5 <> '92e4db755ce2d41584c302073e60fdb1' then raise exception 'WP8_PRE_DRIFT:wse_seed:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.email_ingest_provider_event(text,text,text,text,timestamptz,text)');
  if v_md5 is null or v_md5 not in ('8688c2d9c96cbc7428fd297d8f2fedc0', 'c79386a511a0d4fe886247de20c8444d') then raise exception 'WP8_PRE_DRIFT:ingest:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public._email_can_set_delivery(public.email_send_status,public.email_send_status)');
  if v_md5 is null or v_md5 not in ('164c0e3f3dea09585542573229d8179d', '2a017fd53d0e9d6473659449676b4d4c') then raise exception 'WP8_PRE_DRIFT:can_set:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.service_pref_set(public.service_pref_key,boolean,text,uuid)');
  if v_md5 is null or v_md5 <> 'f171f1ab1a2c183f861f63060a1ad5de' then raise exception 'WP8_PRE_DRIFT:service_pref_set:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.service_delivery_readiness_check()');
  if v_md5 is null or v_md5 <> '5e74aa1d695c2b573e90cc85fb2d4060' then raise exception 'WP8_PRE_DRIFT:readiness:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.email_purge_expired_content()');
  if v_md5 is null or v_md5 <> 'efec09f92a2d7f8fd4610b9461ecbc4c' then raise exception 'WP8_PRE_DRIFT:purge:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.email_claim_batch(int)');
  if v_md5 is null or v_md5 not in ('08fc00397182c86929bcb9afa6a6a995', '317199cf1aecb938c354602287b03b36', '@@WP8_CLAIM_MD5@@') then raise exception 'WP8_PRE_DRIFT:claim:%', v_md5; end if;
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.email_mark_result(uuid,boolean,text,text)');
  if v_md5 is null or v_md5 not in ('5d34c6af5d4934e23f6508a4a56a562c', 'e3f69dd307263b4ba5efdb50dbe65a17', '@@WP8_MARK_MD5@@') then raise exception 'WP8_PRE_DRIFT:mark:%', v_md5; end if;

  if not exists (select 1 from public.email_provider_config where id = 1) then raise exception 'WP8_PRE_FAIL:provider_config_missing'; end if;
  if exists (select 1 from public.email_provider_config where id = 1 and (essential_enabled or service_enabled or public_go_live)) then
    raise exception 'WP8_PRE_FAIL:provider_flags_not_all_false';
  end if;
  if exists (select 1 from public.email_outbox where status in ('queued', 'sending')) then raise exception 'WP8_PRE_FAIL:inflight_rows'; end if;
  select count(*) into v_n from (select user_id from public.email_outbox
     where service_pref_key = 'welcome_service_email' and created_at >= timestamptz '2026-10-01 00:00:00+00'
     group by user_id having count(*) > 1) d;
  if v_n > 0 then raise exception 'WP8_PRE_FAIL:welcome_duplicates_after_cutover:%', v_n; end if;

  perform set_config('wp8.pre_outbox', (select count(*) from public.email_outbox)::text, true);
  perform set_config('wp8.pre_events', (select count(*) from public.email_send_events)::text, true);
  perform set_config('wp8.pre_allowlist', (select count(*) from public.email_send_allowlist)::text, true);
  perform set_config('wp8.pre_prefs', (select count(*) from public.member_service_pref_current)::text, true);
  perform set_config('wp8.pre_members', (select count(*) from public.members)::text, true);
  perform set_config('wp8.pre_decision_md5', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)')), true);
  perform set_config('wp8.pre_enqueue_md5', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text)')), true);
  perform set_config('wp8.pre_ingest_md5', (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.email_ingest_provider_event(text,text,text,text,timestamptz,text)')), true);
  perform set_config('wp8.pre_cfg', (select md5(row(c.*)::text) from public.email_provider_config c where c.id = 1), true);
end
$wp8_pre$;

do $wp8_txn$
begin
  if coalesce(current_setting('wp8.pre_outbox', true), '') = '' then
    raise exception 'WP8_NOT_SINGLE_TRANSACTION';
  end if;
end
$wp8_txn$;

-- 1) Tables. All additive. RLS forced, no policies, no grants to anon/authenticated/service_role.
create table if not exists public.email_service_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  version text not null,
  message_class public.email_message_class not null,
  service_pref_key public.service_pref_key not null,
  locale text not null,
  subject text not null,
  body_html text not null,
  body_text text not null,
  html_sha256 text not null,
  text_sha256 text not null,
  source_path_html text not null,
  source_path_text text not null,
  created_at timestamptz not null default now(),
  constraint email_service_templates_key_version_uk unique (template_key, version),
  constraint email_service_templates_class_ck check (message_class = 'optional_service'),
  constraint email_service_templates_sha_fmt_ck check (html_sha256 ~ '^[0-9a-f]{64}$' and text_sha256 ~ '^[0-9a-f]{64}$'),
  constraint email_service_templates_html_sha_ck check (html_sha256 = encode(sha256(convert_to(body_html, 'UTF8')), 'hex')),
  constraint email_service_templates_text_sha_ck check (text_sha256 = encode(sha256(convert_to(body_text, 'UTF8')), 'hex')),
  constraint email_service_templates_greeting_ck check (
        (char_length(body_html) - char_length(replace(body_html, '{{first_name}}', ''))) = char_length('{{first_name}}')
    and (char_length(body_text) - char_length(replace(body_text, '{{first_name}}', ''))) = char_length('{{first_name}}')
    and position('Merhaba {{first_name}},' in body_html) > 0
    and position('Merhaba {{first_name}},' in body_text) > 0
    and position('{{' in replace(body_html, '{{first_name}}', '')) = 0
    and position('{{' in replace(body_text, '{{first_name}}', '')) = 0
    and position('{{' in subject) = 0)
);

create table if not exists public.email_service_policy (
  id int primary key default 1 check (id = 1),
  welcome_auto_enqueue_enabled boolean not null default false,
  welcome_enqueue_from timestamptz,
  welcome_delay_minutes int not null default 10,
  welcome_max_age_hours int not null default 48,
  welcome_queue_expiry_hours int not null default 72,
  welcome_sweep_limit int not null default 20,
  welcome_template_id uuid references public.email_service_templates(id),
  service_dispatch_paused boolean not null default false,
  service_daily_cap int not null default 0,
  service_monthly_cap int not null default 0,
  otp_reserve_daily int not null default 30,
  otp_reserve_monthly int not null default 600,
  public_go_live_since timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint email_service_policy_ranges_ck check (
        welcome_delay_minutes between 0 and 1440
    and welcome_max_age_hours between 1 and 168
    and welcome_queue_expiry_hours between 1 and 168
    and welcome_sweep_limit between 1 and 50
    and service_daily_cap between 0 and 50
    and service_monthly_cap between 0 and 1500
    and service_daily_cap <= service_monthly_cap
    and otp_reserve_daily between 20 and 100
    and otp_reserve_monthly between 300 and 3000),
  constraint email_service_policy_boundary_ck check (welcome_enqueue_from is null or welcome_enqueue_from >= timestamptz '2026-10-01 00:00:00+00'),
  constraint email_service_policy_go_live_since_ck check (public_go_live_since is null or public_go_live_since >= timestamptz '2026-10-01 00:00:00+00'),
  constraint email_service_policy_enable_ck check (not welcome_auto_enqueue_enabled or (welcome_enqueue_from is not null and welcome_template_id is not null))
);

create table if not exists public.email_send_event_links (
  event_id uuid primary key references public.email_send_events(id),
  outbox_id uuid not null references public.email_outbox(id),
  link_source text not null check (link_source in ('mark_result_late_link', 'reconcile_late_link')),
  linked_at timestamptz not null default now()
);

create table if not exists public.email_wp8_run_ledger (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  job text not null check (job = 'welcome_enqueue_sweep'),
  gate text not null check (gate ~ '^[a-z_]{1,40}$'),
  candidates int not null default 0,
  enqueued int not null default 0,
  idempotent int not null default 0,
  not_eligible int not null default 0,
  race int not null default 0,
  errors int not null default 0,
  expired int not null default 0,
  reconciled int not null default 0,
  reasons jsonb not null default '{}'::jsonb check (jsonb_typeof(reasons) = 'object')
);
create index if not exists email_wp8_run_ledger_ran_at_idx on public.email_wp8_run_ledger (ran_at);

create table if not exists public.email_wp8_manifest (
  object_kind text not null check (object_kind in ('function', 'table')),
  signature text not null,
  body_md5 text check (body_md5 is null or body_md5 ~ '^[0-9a-f]{32}$'),
  service_role_execute boolean not null default false,
  installed_at timestamptz not null default now(),
  primary key (object_kind, signature)
);

alter table public.email_outbox add column if not exists rate_limit_releases int not null default 0;
alter table public.email_outbox add column if not exists first_attempt_at timestamptz;
alter table public.email_outbox add column if not exists service_template_id uuid references public.email_service_templates(id);

-- 2) One welcome per user from the WP8 cutover on. The 3 legacy rows (2026-09-30) are tolerated.
create unique index if not exists email_outbox_welcome_once_uk on public.email_outbox (user_id)
  where service_pref_key = 'welcome_service_email'::public.service_pref_key
    and created_at >= timestamptz '2026-10-01 00:00:00+00';
create index if not exists email_outbox_sent_at_idx on public.email_outbox (sent_at) where sent_at is not null;

-- 3) Guards. Immutable templates, append-only links and manifest, guarded policy and provider config.
create or replace trigger email_service_templates_immutable before update or delete on public.email_service_templates
  for each row execute function public._append_only_guard();
create or replace trigger email_send_event_links_append_only before update or delete on public.email_send_event_links
  for each row execute function public._append_only_guard();
create or replace trigger email_wp8_manifest_append_only before update or delete on public.email_wp8_manifest
  for each row execute function public._append_only_guard();

create or replace function public._email_service_policy_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'wp8_policy_delete_refused';
  end if;
  if tg_op = 'INSERT' then
    if new.id is distinct from 1 or new.welcome_auto_enqueue_enabled or new.welcome_enqueue_from is not null
       or new.service_daily_cap <> 0 or new.service_monthly_cap <> 0 or new.welcome_template_id is not null
       or new.public_go_live_since is not null then
      raise exception 'wp8_policy_insert_must_be_inert';
    end if;
    new.updated_at := now();
    return new;
  end if;
  if new.welcome_enqueue_from is distinct from old.welcome_enqueue_from then
    if new.welcome_enqueue_from is null
       or (old.welcome_enqueue_from is not null and new.welcome_enqueue_from < old.welcome_enqueue_from) then
      raise exception 'wp8_boundary_cannot_move_backwards';
    end if;
    if new.welcome_enqueue_from < transaction_timestamp() then
      raise exception 'wp8_boundary_cannot_precede_change';
    end if;
  end if;
  if new.public_go_live_since is distinct from old.public_go_live_since then
    if new.public_go_live_since is null
       or (old.public_go_live_since is not null and new.public_go_live_since < old.public_go_live_since) then
      raise exception 'wp8_go_live_since_cannot_move_backwards';
    end if;
    if new.public_go_live_since < transaction_timestamp() then
      raise exception 'wp8_go_live_since_cannot_precede_change';
    end if;
  end if;
  if new.welcome_template_id is distinct from old.welcome_template_id and new.welcome_template_id is not null
     and not exists (select 1 from public.email_service_templates t
                      where t.id = new.welcome_template_id
                        and t.template_key = 'welcome_service_email'
                        and t.service_pref_key = 'welcome_service_email'
                        and t.message_class = 'optional_service') then
    raise exception 'wp8_template_not_welcome';
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
create or replace trigger email_service_policy_guard before insert or update or delete on public.email_service_policy
  for each row execute function public._email_service_policy_guard();

create or replace function public._email_provider_config_golive_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'wp8_provider_config_delete_refused';
  end if;
  if new.public_go_live and (tg_op = 'INSERT' or not coalesce(old.public_go_live, false)) then
    if coalesce((public.service_delivery_readiness_check()->>'ready')::boolean, false) is not true then
      raise exception 'wp8_public_go_live_requires_service_delivery_readiness';
    end if;
    update public.email_service_policy
       set public_go_live_since = greatest(coalesce(public_go_live_since, clock_timestamp()), clock_timestamp())
     where id = 1;
    if not found then
      raise exception 'wp8_public_go_live_requires_policy_row';
    end if;
  end if;
  return new;
end
$fn$;
create or replace trigger email_provider_config_golive_guard before insert or update or delete on public.email_provider_config
  for each row execute function public._email_provider_config_golive_guard();
alter table public.email_provider_config enable trigger email_provider_config_golive_guard;

do $wp8_acl_tables$
declare t text;
begin
  foreach t in array array['email_service_templates', 'email_service_policy', 'email_send_event_links', 'email_wp8_run_ledger', 'email_wp8_manifest'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end
$wp8_acl_tables$;

-- 4) The approved welcome v3.2 (byte-exact repo files, hex). Insert once, then pin (still inert).
insert into public.email_service_templates(template_key, version, message_class, service_pref_key, locale, subject,
  body_html, body_text, html_sha256, text_sha256, source_path_html, source_path_text)
values ('welcome_service_email', 'v3.2', 'optional_service', 'welcome_service_email', 'tr-TR',
  convert_from(decode('@@SUBJECT_HEX@@', 'hex'), 'UTF8'),
  convert_from(decode('
@@HTML_HEX@@
', 'hex'), 'UTF8'),
  convert_from(decode('
@@TXT_HEX@@
', 'hex'), 'UTF8'),
  '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb',
  '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56',
  'CDP3D_package/email/templates/welcome_service_email.v3.2.html',
  'CDP3D_package/email/templates/welcome_service_email.v3.2.txt')
on conflict (template_key, version) do nothing;

insert into public.email_service_policy(id) values (1) on conflict (id) do nothing;

update public.email_service_policy p
   set welcome_template_id = t.id
  from public.email_service_templates t
 where p.id = 1 and p.welcome_template_id is null
   and t.template_key = 'welcome_service_email' and t.version = 'v3.2';

-- 5) Render: the whole greeting token is replaced once; the name is HTML-escaped in the HTML part.
create or replace function public._wp8_html_escape(p text) returns text
language sql immutable strict set search_path = pg_catalog as $fn$
  select replace(replace(replace(replace(replace(p, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$fn$;

create or replace function public._wp8_greeting_name(p text) returns text
language sql immutable set search_path = pg_catalog as $fn$
  select case
    when p is null then null
    when btrim(p) = '' then null
    when char_length(btrim(p)) > 50 then null
    when btrim(p) ~ '[\x01-\x1f\x7f\u2028\u2029{}]' then null
    else btrim(p) end
$fn$;

create or replace function public.welcome_render(p_template_id uuid, p_first_name text)
returns table(subject text, body_html text, body_text text)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  t public.email_service_templates%rowtype;
  v_name text; v_h text; v_t text;
begin
  select * into t from public.email_service_templates where id = p_template_id;
  if not found then raise exception 'wp8_template_missing'; end if;
  if encode(sha256(convert_to(t.body_html, 'UTF8')), 'hex') <> t.html_sha256
     or encode(sha256(convert_to(t.body_text, 'UTF8')), 'hex') <> t.text_sha256 then
    raise exception 'wp8_template_sha_mismatch';
  end if;
  v_name := public._wp8_greeting_name(p_first_name);
  if v_name is null then
    v_h := replace(t.body_html, 'Merhaba {{first_name}},', 'Merhaba,');
    v_t := replace(t.body_text, 'Merhaba {{first_name}},', 'Merhaba,');
  else
    v_h := replace(t.body_html, 'Merhaba {{first_name}},', 'Merhaba ' || public._wp8_html_escape(v_name) || ',');
    v_t := replace(t.body_text, 'Merhaba {{first_name}},', 'Merhaba ' || v_name || ',');
  end if;
  if position('{{' in v_h) > 0 or position('{{' in v_t) > 0 then
    raise exception 'wp8_render_unresolved_variable';
  end if;
  subject := t.subject; body_html := v_h; body_text := v_t;
  return next;
end
$fn$;

-- 6) OTP lower bound from auth.users (counts only). NULL when the columns are missing: budget fails closed.
create or replace function public._wp8_auth_otp_load() returns int[]
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v int[];
begin
  if to_regclass('auth.users') is null
     or (select count(*) from pg_attribute a
          where a.attrelid = to_regclass('auth.users') and a.attnum > 0
            and a.attname in ('confirmation_sent_at', 'recovery_sent_at', 'email_change_sent_at', 'reauthentication_sent_at')) <> 4 then
    return null;
  end if;
  execute 'select array['
       || '(count(*) filter (where u.confirmation_sent_at > now() - interval ''24 hours'')'
       || ' + count(*) filter (where u.recovery_sent_at > now() - interval ''24 hours'')'
       || ' + count(*) filter (where u.email_change_sent_at > now() - interval ''24 hours'')'
       || ' + count(*) filter (where u.reauthentication_sent_at > now() - interval ''24 hours''))::int,'
       || '(count(*) filter (where u.confirmation_sent_at > now() - interval ''31 days'')'
       || ' + count(*) filter (where u.recovery_sent_at > now() - interval ''31 days'')'
       || ' + count(*) filter (where u.email_change_sent_at > now() - interval ''31 days'')'
       || ' + count(*) filter (where u.reauthentication_sent_at > now() - interval ''31 days''))::int]'
       || ' from auth.users u'
    into v;
  return v;
end
$fn$;

-- 7) Late-link of orphan webhook events (Gap C). email_send_events is never updated.
create or replace function public._email_link_orphans_for(p_outbox_id uuid, p_source text) returns int
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_pid text; v_cur public.email_send_status; e record; n int := 0;
begin
  if p_source is null or p_source not in ('mark_result_late_link', 'reconcile_late_link') then
    raise exception 'wp8_link_source_invalid';
  end if;
  select o.provider_message_id into v_pid from public.email_outbox o where o.id = p_outbox_id for update;
  if v_pid is null then return 0; end if;
  for e in
    select ev.id, ev.event_type, ev.received_at
      from public.email_send_events ev
     where ev.provider_message_id = v_pid and ev.outbox_id is null
       and ev.received_at >= timestamptz '2026-10-01 00:00:00+00'
       and not exists (select 1 from public.email_send_event_links l where l.event_id = ev.id)
     order by ev.received_at, ev.id
  loop
    insert into public.email_send_event_links(event_id, outbox_id, link_source)
    values (e.id, p_outbox_id, p_source)
    on conflict (event_id) do nothing;
    if not found then continue; end if;
    n := n + 1;
    select o.status into v_cur from public.email_outbox o where o.id = p_outbox_id;
    if e.event_type = 'email.delivered' and public._email_can_set_delivery(v_cur, 'delivered') then
      update public.email_outbox set status = 'delivered', delivered_at = e.received_at, updated_at = now() where id = p_outbox_id;
    elsif e.event_type in ('email.bounced', 'email.failed') and public._email_can_set_delivery(v_cur, 'failed') then
      update public.email_outbox set status = 'failed', failed_at = e.received_at, updated_at = now() where id = p_outbox_id;
    end if;
  end loop;
  return n;
end
$fn$;

create or replace function public.email_reconcile_orphan_events(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  r record; n_rows int := 0; n_links int := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then p_limit := 50; end if;
  for r in
    select distinct o.id
      from public.email_send_events ev
      join public.email_outbox o on o.provider_message_id = ev.provider_message_id
     where ev.outbox_id is null
       and ev.received_at >= timestamptz '2026-10-01 00:00:00+00'
       and not exists (select 1 from public.email_send_event_links l where l.event_id = ev.id)
     limit p_limit
  loop
    n_rows := n_rows + 1;
    n_links := n_links + public._email_link_orphans_for(r.id, 'reconcile_late_link');
  end loop;
  return jsonb_build_object('ok', true, 'outbox_rows', n_rows, 'linked', n_links);
end
$fn$;

-- 8) Sweep (enqueue path). Never runs in the signup transaction. Counts only, never ids or addresses.
create or replace function public.welcome_enqueue_sweep(p_limit int default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  pol public.email_service_policy%rowtype;
  cfg public.email_provider_config%rowtype;
  tpl public.email_service_templates%rowtype;
  v_wse_from timestamptz; v_from timestamptz; v_lim int; v_window int;
  r record; v_dec jsonb; v_res jsonb; v_r record; v_reason text; v_rec jsonb;
  n_cand int := 0; n_enq int := 0; n_idem int := 0; n_deny int := 0; n_race int := 0; n_err int := 0; n_exp int := 0; n_rec int := 0;
  v_reasons jsonb := '{}'::jsonb; v_out jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('wp8|welcome_enqueue_sweep', 0)) then
    return jsonb_build_object('ok', true, 'gate', 'busy');
  end if;
  select * into cfg from public.email_provider_config where id = 1 for share;
  select * into pol from public.email_service_policy where id = 1 for share;

  update public.email_outbox o
     set status = 'canceled', last_error = 'wp8_queue_expired', updated_at = now()
   where o.status = 'queued'
     and o.service_pref_key = 'welcome_service_email'
     and o.idempotency_key like 'wp8:welcome_service_email:v1:%'
     and o.created_at < now() - make_interval(hours => coalesce(pol.welcome_queue_expiry_hours, 72));
  get diagnostics n_exp = row_count;
  v_rec := public.email_reconcile_orphan_events(50);
  n_rec := coalesce((v_rec->>'linked')::int, 0);
  delete from public.email_wp8_run_ledger where ran_at < now() - interval '30 days';

  if pol.id is null then
    return jsonb_build_object('ok', true, 'gate', 'policy_missing', 'expired', n_exp, 'reconciled', n_rec);
  end if;
  if not pol.welcome_auto_enqueue_enabled then
    return jsonb_build_object('ok', true, 'gate', 'auto_disabled', 'expired', n_exp, 'reconciled', n_rec);
  end if;
  if pol.welcome_enqueue_from is null then
    return jsonb_build_object('ok', true, 'gate', 'boundary_unset', 'expired', n_exp, 'reconciled', n_rec);
  end if;
  if pol.service_dispatch_paused then
    return jsonb_build_object('ok', true, 'gate', 'dispatch_paused', 'expired', n_exp, 'reconciled', n_rec);
  end if;
  if pol.service_daily_cap < 1 or pol.service_monthly_cap < 1 then
    return jsonb_build_object('ok', true, 'gate', 'caps_unset', 'expired', n_exp, 'reconciled', n_rec);
  end if;
  if cfg.id is null or not cfg.service_enabled then
    return jsonb_build_object('ok', true, 'gate', 'service_disabled', 'expired', n_exp, 'reconciled', n_rec);
  end if;
  select d.effective_from into v_wse_from
    from public.service_pref_defaults d
   where d.pref_key = 'welcome_service_email' and d.default_enabled is true and d.effective_from is not null;
  if v_wse_from is null then
    return jsonb_build_object('ok', true, 'gate', 'wse_policy_inactive', 'expired', n_exp, 'reconciled', n_rec);
  end if;
  select * into tpl from public.email_service_templates where id = pol.welcome_template_id;
  if not found
     or tpl.template_key <> 'welcome_service_email' or tpl.version <> 'v3.2'
     or tpl.html_sha256 <> '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'
     or tpl.text_sha256 <> '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'
     or encode(sha256(convert_to(tpl.body_html, 'UTF8')), 'hex') <> tpl.html_sha256
     or encode(sha256(convert_to(tpl.body_text, 'UTF8')), 'hex') <> tpl.text_sha256 then
    return jsonb_build_object('ok', true, 'gate', 'template_unverified', 'expired', n_exp, 'reconciled', n_rec);
  end if;

  v_from := greatest(pol.welcome_enqueue_from, v_wse_from);
  v_lim := least(coalesce(p_limit, pol.welcome_sweep_limit), pol.welcome_sweep_limit, 50);
  if v_lim < 1 then v_lim := 1; end if;
  v_window := v_lim * 10;

  for r in
    select m.user_id, m.first_name
      from public.members m
      join auth.users u on u.id = m.user_id
      join public.member_service_pref_current pc
        on pc.user_id = m.user_id and pc.pref_key = 'welcome_service_email' and pc.enabled is true
     where u.created_at >= v_from
       and m.created_at <= now() - make_interval(mins => pol.welcome_delay_minutes)
       and m.created_at >= now() - make_interval(hours => pol.welcome_max_age_hours)
       and coalesce(m.blocked, false) = false
       and m.email is not null
       and (exists (select 1 from public.email_send_allowlist a where a.user_id = m.user_id and a.active)
            or (cfg.public_go_live and pol.public_go_live_since is not null and u.created_at >= pol.public_go_live_since))
       and not exists (select 1 from public.email_outbox o
                        where o.user_id = m.user_id and o.service_pref_key = 'welcome_service_email')
     order by m.created_at, m.user_id
     limit v_window
  loop
    exit when n_enq >= v_lim;
    n_cand := n_cand + 1;
    begin
      perform pg_advisory_xact_lock(hashtextextended(r.user_id::text || '|welcome_service_email', 0));
      v_dec := public._email_send_decision(r.user_id, 'optional_service', 'welcome_service_email');
      if not coalesce((v_dec->>'allow')::boolean, false) then
        v_reason := coalesce(v_dec->>'skip_reason', 'unknown');
        v_reasons := jsonb_set(v_reasons, array[v_reason], to_jsonb(coalesce((v_reasons->>v_reason)::int, 0) + 1));
        n_deny := n_deny + 1;
        continue;
      end if;
      select * into v_r from public.welcome_render(tpl.id, r.first_name);
      v_res := public.email_enqueue(r.user_id, 'optional_service', 'welcome_service_email',
                 v_r.subject, v_r.body_html, v_r.body_text, null,
                 'wp8:welcome_service_email:v1:' || r.user_id::text, 'wp8-sweep');
      if coalesce((v_res->>'idempotent')::boolean, false) then
        n_idem := n_idem + 1;
      elsif v_res->>'status' = 'queued' then
        update public.email_outbox set service_template_id = tpl.id
         where id = (v_res->>'id')::uuid and service_template_id is null;
        n_enq := n_enq + 1;
      else
        raise exception using errcode = 'WP8R1', message = 'wp8_sweep_race',
          detail = coalesce(v_res->>'skip_reason', v_res->>'status', 'unknown');
      end if;
    exception
      when sqlstate 'WP8R1' then
        get stacked diagnostics v_reason = pg_exception_detail;
        v_reason := 'race_' || coalesce(v_reason, 'unknown');
        v_reasons := jsonb_set(v_reasons, array[v_reason], to_jsonb(coalesce((v_reasons->>v_reason)::int, 0) + 1));
        n_race := n_race + 1;
      when others then
        v_reason := 'error_' || sqlstate;
        v_reasons := jsonb_set(v_reasons, array[v_reason], to_jsonb(coalesce((v_reasons->>v_reason)::int, 0) + 1));
        n_err := n_err + 1;
    end;
  end loop;

  insert into public.email_wp8_run_ledger(job, gate, candidates, enqueued, idempotent, not_eligible, race, errors, expired, reconciled, reasons)
  values ('welcome_enqueue_sweep', 'open', n_cand, n_enq, n_idem, n_deny, n_race, n_err, n_exp, n_rec, v_reasons);

  v_out := jsonb_build_object('ok', true, 'gate', 'open', 'candidates', n_cand, 'enqueued', n_enq,
    'idempotent', n_idem, 'not_eligible', n_deny, 'race', n_race, 'errors', n_err, 'reasons', v_reasons,
    'expired', n_exp, 'reconciled', n_rec);
  return v_out;
end
$fn$;

-- 9) Claim (same signature, return table and ACL as CDP-3D). Serialized; capped lease reclaim;
-- retry horizon; stale wp8 welcome expiry before any return; DB-enforced quota with OTP headroom.
create or replace function public.email_claim_batch(p_limit int default 10)
returns table(outbox_id uuid, message_class public.email_message_class, service_pref_key public.service_pref_key,
  subject text, body_html text, body_text text, recipient_email text, from_email text, from_name text, reply_to text)
language plpgsql security definer set search_path = public, extensions, vault as $fn$
declare
  r record; v_dec jsonb; v_email text; v_blocked boolean;
  v_cfg public.email_provider_config%rowtype;
  v_pol public.email_service_policy%rowtype;
  v_used_day int; v_used_month int; v_inflight int; v_otp int[];
  v_total int; v_budget int; v_n int := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then p_limit := 10; end if;
  perform pg_advisory_xact_lock(hashtextextended('wp8|email_claim_batch', 0));
  select * into v_cfg from public.email_provider_config where id = 1;
  select * into v_pol from public.email_service_policy where id = 1;

  update public.email_outbox o
     set status = 'failed', failed_at = now(), last_error = 'lease_expired_max_attempts',
         claimed_at = null, lease_expires_at = null, updated_at = now()
   where o.status = 'sending' and o.lease_expires_at is not null and o.lease_expires_at < now()
     and o.attempts >= o.max_attempts;
  update public.email_outbox o
     set status = 'queued', next_attempt_at = now() + (power(2, greatest(o.attempts, 1)) * interval '1 minute'),
         claimed_at = null, lease_expires_at = null, last_error = 'lease_expired', updated_at = now()
   where o.status = 'sending' and o.lease_expires_at is not null and o.lease_expires_at < now()
     and o.attempts < o.max_attempts;
  update public.email_outbox o
     set status = 'failed', failed_at = now(), last_error = 'retry_window_exceeded', updated_at = now()
   where o.status = 'queued' and o.attempts >= 1 and o.first_attempt_at is not null
     and o.first_attempt_at < now() - interval '20 hours';
  update public.email_outbox o
     set status = 'canceled', last_error = 'wp8_queue_expired', updated_at = now()
   where o.status = 'queued'
     and o.service_pref_key = 'welcome_service_email'
     and o.idempotency_key like 'wp8:welcome_service_email:v1:%'
     and o.created_at < now() - make_interval(hours => coalesce(v_pol.welcome_queue_expiry_hours, 72));

  if v_cfg.id is null or v_pol.id is null then return; end if;
  v_otp := public._wp8_auth_otp_load();
  if v_otp is null then return; end if;
  select count(*) into v_used_day from public.email_outbox o where o.sent_at > now() - interval '24 hours';
  select count(*) into v_used_month from public.email_outbox o where o.sent_at > now() - interval '31 days';
  select count(*) into v_inflight from public.email_outbox o where o.status = 'sending';
  v_used_day := v_used_day + v_inflight;
  v_used_month := v_used_month + v_inflight;
  v_total := least(100 - v_pol.otp_reserve_daily - v_otp[1] - v_used_day,
                   3000 - v_pol.otp_reserve_monthly - v_otp[2] - v_used_month,
                   p_limit);
  if v_total < 1 then return; end if;

  for r in
    select * from public.email_outbox o
     where o.status = 'queued' and o.next_attempt_at <= now() and o.attempts < o.max_attempts
       and o.message_class = 'essential_transactional'
     order by o.created_at for update skip locked limit v_total
  loop
    v_dec := public._email_send_decision(r.user_id, r.message_class, r.service_pref_key);
    if not (v_dec->>'allow')::boolean then
      update public.email_outbox set status = 'skipped', skip_reason = (v_dec->>'skip_reason')::public.email_skip_reason, updated_at = now() where id = r.id;
      continue;
    end if;
    select m.email, coalesce(m.blocked, false) into v_email, v_blocked from public.members m where m.user_id = r.user_id;
    if v_email is null or v_blocked then
      update public.email_outbox set status = 'skipped', skip_reason = case when v_email is null then 'recipient_missing_email' else 'recipient_blocked' end, updated_at = now() where id = r.id;
      continue;
    end if;
    update public.email_outbox
       set status = 'sending', attempts = attempts + 1, claimed_at = now(), first_attempt_at = coalesce(first_attempt_at, now()),
           lease_expires_at = now() + make_interval(secs => coalesce(v_cfg.lease_seconds, 120)), updated_at = now()
     where id = r.id;
    v_n := v_n + 1;
    outbox_id := r.id; message_class := r.message_class; service_pref_key := r.service_pref_key;
    subject := r.subject; body_html := r.body_html; body_text := r.body_text; recipient_email := v_email;
    from_email := v_cfg.from_email; from_name := v_cfg.from_name; reply_to := v_cfg.reply_to;
    return next;
  end loop;

  if v_pol.service_dispatch_paused then return; end if;
  v_budget := least(v_pol.service_daily_cap - v_used_day - v_n,
                    v_pol.service_monthly_cap - v_used_month - v_n,
                    v_total - v_n);
  if v_budget < 1 then return; end if;

  for r in
    select * from public.email_outbox o
     where o.status = 'queued' and o.next_attempt_at <= now() and o.attempts < o.max_attempts
       and o.message_class = 'optional_service'
     order by o.created_at for update skip locked limit v_budget
  loop
    v_dec := public._email_send_decision(r.user_id, r.message_class, r.service_pref_key);
    if not (v_dec->>'allow')::boolean then
      update public.email_outbox set status = 'skipped', skip_reason = (v_dec->>'skip_reason')::public.email_skip_reason, updated_at = now() where id = r.id;
      continue;
    end if;
    select m.email, coalesce(m.blocked, false) into v_email, v_blocked from public.members m where m.user_id = r.user_id;
    if v_email is null or v_blocked then
      update public.email_outbox set status = 'skipped', skip_reason = case when v_email is null then 'recipient_missing_email' else 'recipient_blocked' end, updated_at = now() where id = r.id;
      continue;
    end if;
    update public.email_outbox
       set status = 'sending', attempts = attempts + 1, claimed_at = now(), first_attempt_at = coalesce(first_attempt_at, now()),
           lease_expires_at = now() + make_interval(secs => coalesce(v_cfg.lease_seconds, 120)), updated_at = now()
     where id = r.id;
    outbox_id := r.id; message_class := r.message_class; service_pref_key := r.service_pref_key;
    subject := r.subject; body_html := r.body_html; body_text := r.body_text; recipient_email := v_email;
    from_email := v_cfg.from_email; from_name := v_cfg.from_name; reply_to := v_cfg.reply_to;
    return next;
  end loop;
end
$fn$;

-- 10) Mark result (same signature and ACL). Row lock; permanent provider errors are terminal;
-- 408/409/429/5xx/network retry with backoff up to max_attempts; late-link on success.
create or replace function public.email_mark_result(p_outbox_id uuid, p_ok boolean, p_provider_message_id text, p_error text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $fn$
declare
  v public.email_outbox%rowtype; v_backoff interval; v_pid text; v_linked int := 0; v_err text; v_terminal boolean;
begin
  select * into v from public.email_outbox where id = p_outbox_id for update;
  if not found then raise exception 'outbox_not_found'; end if;
  if v.status <> 'sending' then
    return jsonb_build_object('ok', true, 'ignored', true, 'status', v.status);
  end if;
  if p_ok then
    v_pid := nullif(btrim(p_provider_message_id), '');
    update public.email_outbox
       set status = 'sent', provider_message_id = v_pid, sent_at = now(), last_error = null,
           lease_expires_at = null, updated_at = now()
     where id = p_outbox_id;
    if v_pid is not null then
      v_linked := public._email_link_orphans_for(p_outbox_id, 'mark_result_late_link');
    end if;
    return jsonb_build_object('ok', true, 'status', (select o.status from public.email_outbox o where o.id = p_outbox_id), 'late_linked', v_linked);
  end if;
  v_err := left(coalesce(p_error, ''), 300);
  v_terminal := v_err ~ '^resend_4[0-9][0-9]$' and v_err not in ('resend_408', 'resend_409', 'resend_429');
  if v_terminal or v.attempts >= v.max_attempts then
    update public.email_outbox
       set status = 'failed', failed_at = now(), last_error = v_err, lease_expires_at = null, updated_at = now()
     where id = p_outbox_id;
    return jsonb_build_object('ok', true, 'status', 'failed', 'terminal', v_terminal);
  end if;
  v_backoff := (power(2, greatest(v.attempts, 1)) * interval '1 minute');
  update public.email_outbox
     set status = 'queued', next_attempt_at = now() + v_backoff, last_error = v_err,
         claimed_at = null, lease_expires_at = null, updated_at = now()
   where id = p_outbox_id;
  return jsonb_build_object('ok', true, 'status', 'requeued', 'next_attempt_at', now() + v_backoff);
end
$fn$;

-- 11) Release a claim without consuming an attempt (Resend 429, or not attempted). At most 6 per row.
create or replace function public.email_release_claim(p_outbox_id uuid, p_retry_after_seconds int, p_not_attempted boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  v public.email_outbox%rowtype; v_delay int;
begin
  select * into v from public.email_outbox where id = p_outbox_id for update;
  if not found then raise exception 'outbox_not_found'; end if;
  if v.status <> 'sending' then
    return jsonb_build_object('ok', true, 'ignored', true, 'status', v.status);
  end if;
  if v.rate_limit_releases >= 6 then
    return public.email_mark_result(p_outbox_id, false, null,
      case when coalesce(p_not_attempted, false) then 'release_cap_not_attempted' else 'resend_429_release_cap' end);
  end if;
  v_delay := least(greatest(coalesce(p_retry_after_seconds, 60), 60), 3600);
  update public.email_outbox
     set status = 'queued', attempts = greatest(attempts - 1, 0), rate_limit_releases = rate_limit_releases + 1,
         first_attempt_at = case when attempts - 1 <= 0 then null else first_attempt_at end,
         next_attempt_at = now() + make_interval(secs => v_delay), claimed_at = null, lease_expires_at = null,
         last_error = case when coalesce(p_not_attempted, false) then 'released_not_attempted' else 'resend_429' end,
         updated_at = now()
   where id = p_outbox_id;
  return jsonb_build_object('ok', true, 'status', 'released', 'retry_after_seconds', v_delay);
end
$fn$;

-- 12) Guarded setters (super_admin actor, reason and request id without e-mail, audit row).
create or replace function public.admin_w_welcome_automation_set(p_actor uuid, p_enabled boolean, p_reason text, p_request_id text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  pol public.email_service_policy%rowtype; v_after public.email_service_policy%rowtype;
  v_rid text; v_reason text; v_wse timestamptz;
begin
  if p_actor is null or not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then
    raise exception 'forbidden';
  end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' or v_reason like '%@%' then raise exception 'reason_invalid'; end if;
  v_rid := public._require_request_id(p_request_id);
  if v_rid like '%@%' then raise exception 'request_id_invalid'; end if;
  if p_enabled is null then raise exception 'enabled_required'; end if;
  select * into pol from public.email_service_policy where id = 1 for update;
  if not found then raise exception 'wp8_policy_missing'; end if;
  if p_enabled then
    select d.effective_from into v_wse from public.service_pref_defaults d
     where d.pref_key = 'welcome_service_email' and d.default_enabled is true and d.effective_from is not null;
    if v_wse is null then raise exception 'wp8_wse_policy_inactive'; end if;
    if pol.welcome_template_id is null or not exists (
         select 1 from public.email_service_templates t
          where t.id = pol.welcome_template_id and t.template_key = 'welcome_service_email' and t.version = 'v3.2'
            and t.html_sha256 = '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'
            and t.text_sha256 = '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'
            and encode(sha256(convert_to(t.body_html, 'UTF8')), 'hex') = t.html_sha256
            and encode(sha256(convert_to(t.body_text, 'UTF8')), 'hex') = t.text_sha256) then
      raise exception 'wp8_template_unverified';
    end if;
    if pol.service_daily_cap < 1 or pol.service_monthly_cap < 1 then raise exception 'wp8_caps_unset'; end if;
    update public.email_service_policy
       set welcome_auto_enqueue_enabled = true,
           welcome_enqueue_from = case when pol.welcome_auto_enqueue_enabled then welcome_enqueue_from
                                       else greatest(coalesce(welcome_enqueue_from, clock_timestamp()), clock_timestamp()) end,
           updated_by = p_actor
     where id = 1
    returning * into v_after;
  else
    update public.email_service_policy
       set welcome_auto_enqueue_enabled = false, updated_by = p_actor
     where id = 1
    returning * into v_after;
  end if;
  insert into public.admin_write_log(actor_uid, action, target_type, target_id, before, after, reason, request_id, idempotency_key, at)
  values (p_actor, 'wp8_welcome_automation_set', 'email_service_policy', '1',
          jsonb_build_object('enabled', pol.welcome_auto_enqueue_enabled, 'enqueue_from', pol.welcome_enqueue_from),
          jsonb_build_object('enabled', v_after.welcome_auto_enqueue_enabled, 'enqueue_from', v_after.welcome_enqueue_from),
          v_reason, v_rid, md5('wp8_welcome_automation_set|' || v_rid || '|' || clock_timestamp()::text)::uuid, clock_timestamp());
  return jsonb_build_object('ok', true, 'enabled', v_after.welcome_auto_enqueue_enabled, 'enqueue_from', v_after.welcome_enqueue_from);
end
$fn$;

create or replace function public.admin_w_email_public_go_live_set(p_actor uuid, p_enable boolean, p_reason text, p_request_id text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $fn$
declare
  cfg public.email_provider_config%rowtype; pol public.email_service_policy%rowtype; v_after public.email_service_policy%rowtype;
  v_rid text; v_reason text;
begin
  if p_actor is null or not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then
    raise exception 'forbidden';
  end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' or v_reason like '%@%' then raise exception 'reason_invalid'; end if;
  v_rid := public._require_request_id(p_request_id);
  if v_rid like '%@%' then raise exception 'request_id_invalid'; end if;
  if p_enable is null then raise exception 'enable_required'; end if;
  select * into cfg from public.email_provider_config where id = 1 for update;
  if not found then raise exception 'wp8_provider_config_missing'; end if;
  select * into pol from public.email_service_policy where id = 1 for update;
  if not found then raise exception 'wp8_policy_missing'; end if;
  if p_enable then
    if coalesce((public.service_delivery_readiness_check()->>'ready')::boolean, false) is not true then
      raise exception 'wp8_public_go_live_requires_service_delivery_readiness';
    end if;
    if pol.service_daily_cap < 1 or pol.service_monthly_cap < 1 then raise exception 'wp8_caps_unset'; end if;
    if pol.welcome_template_id is null then raise exception 'wp8_template_unpinned'; end if;
    if not cfg.service_enabled then raise exception 'wp8_service_disabled'; end if;
    update public.email_provider_config set public_go_live = true, updated_at = now(), updated_by = p_actor where id = 1;
  else
    update public.email_provider_config set public_go_live = false, updated_at = now(), updated_by = p_actor where id = 1;
  end if;
  select * into v_after from public.email_service_policy where id = 1;
  insert into public.admin_write_log(actor_uid, action, target_type, target_id, before, after, reason, request_id, idempotency_key, at)
  values (p_actor, 'wp8_email_public_go_live_set', 'email_provider_config', '1',
          jsonb_build_object('public_go_live', cfg.public_go_live, 'public_go_live_since', pol.public_go_live_since),
          jsonb_build_object('public_go_live', p_enable, 'public_go_live_since', v_after.public_go_live_since),
          v_reason, v_rid, md5('wp8_email_public_go_live_set|' || v_rid || '|' || clock_timestamp()::text)::uuid, clock_timestamp());
  return jsonb_build_object('ok', true, 'public_go_live', p_enable, 'public_go_live_since', v_after.public_go_live_since);
end
$fn$;

-- 13) Function ACL. Internal helpers: owner only. Entry points: service_role only.
revoke all on function public._email_service_policy_guard() from public, anon, authenticated, service_role;
revoke all on function public._email_provider_config_golive_guard() from public, anon, authenticated, service_role;
revoke all on function public._wp8_html_escape(text) from public, anon, authenticated, service_role;
revoke all on function public._wp8_greeting_name(text) from public, anon, authenticated, service_role;
revoke all on function public.welcome_render(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public._wp8_auth_otp_load() from public, anon, authenticated, service_role;
revoke all on function public._email_link_orphans_for(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.email_reconcile_orphan_events(int) from public, anon, authenticated;
revoke all on function public.welcome_enqueue_sweep(int) from public, anon, authenticated;
revoke all on function public.email_claim_batch(int) from public, anon, authenticated;
revoke all on function public.email_mark_result(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.email_release_claim(uuid, int, boolean) from public, anon, authenticated;
revoke all on function public.admin_w_welcome_automation_set(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.admin_w_email_public_go_live_set(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.email_reconcile_orphan_events(int) to service_role;
grant execute on function public.welcome_enqueue_sweep(int) to service_role;
grant execute on function public.email_claim_batch(int) to service_role;
grant execute on function public.email_mark_result(uuid, boolean, text, text) to service_role;
grant execute on function public.email_release_claim(uuid, int, boolean) to service_role;
grant execute on function public.admin_w_welcome_automation_set(uuid, boolean, text, text) to service_role;
grant execute on function public.admin_w_email_public_go_live_set(uuid, boolean, text, text) to service_role;

-- 14) Documentation (catalog comments; no PII).
comment on table public.email_service_templates is 'WP8: immutable optional_service templates. v3.2 welcome stored byte-exact (sha256 pinned). Only the {{first_name}} placeholder, no PII.';
comment on table public.email_service_policy is 'WP8: welcome automation policy singleton. Inert defaults. Guard trigger: boundary and go-live instant only move forward and never before the changing transaction; no delete; inert-only insert.';
comment on column public.email_service_policy.welcome_enqueue_from is 'WP8 no-backfill boundary on auth.users.created_at. NULL = automation impossible. Set by admin_w_welcome_automation_set to its own clock.';
comment on column public.email_service_policy.public_go_live_since is 'WP8: instant of the last public_go_live false to true transition, recorded by the provider config trigger. Non-allowlisted users must have signed up at or after it.';
comment on column public.email_service_policy.service_daily_cap is 'WP8: rolling 24 h cap for optional_service claims (all classes counted). 0 = no optional claims. Ceiling 50.';
comment on column public.email_service_policy.service_monthly_cap is 'WP8: rolling 31 day cap for optional_service claims. 0 = no optional claims. Ceiling 1500.';
comment on column public.email_service_policy.otp_reserve_daily is 'WP8: Resend free quota (100/day) headroom kept for Auth OTP on top of the OTP lower bound read from auth.users.';
comment on table public.email_send_event_links is 'WP8: append-only late links of orphan provider events (webhook before mark_result). email_send_events stays untouched.';
comment on table public.email_wp8_run_ledger is 'WP8: counts-only sweep run ledger (gate open or errors). No ids, no addresses. Purged after 30 days by the sweep.';
comment on table public.email_wp8_manifest is 'WP8: append-only manifest of WP8 functions (body md5, expected service_role execute) and tables, written by the migration.';
comment on function public.welcome_enqueue_sweep(int) is 'WP8: welcome enqueue sweep. Gates fail closed. Allowlist or public go-live, boundary, delay, max-age, pref, decision. Returns counts only.';
comment on function public.email_claim_batch(int) is 'WP8 revision of the CDP-3D claim: serialized, capped lease reclaim, 20 h retry horizon, wp8 queue expiry, quota with OTP headroom, optional caps, pause.';
comment on function public.email_mark_result(uuid, boolean, text, text) is 'WP8 revision of the CDP-3D mark: row lock, permanent 4xx terminal, late-link of orphan events.';
comment on function public.email_release_claim(uuid, int, boolean) is 'WP8: refund a claim after Resend 429 or when not attempted. At most 6 per row, then counts as an attempt.';

do $wp8_post$
declare
  r record; v text; v_oid oid; n_fn int := 0; n_tbl int := 0;
begin
  if exists (select 1 from public.email_provider_config where id = 1 and (essential_enabled or service_enabled or public_go_live)) then
    raise exception 'WP8_POST_FAIL:provider_flags';
  end if;
  if (select md5(row(c.*)::text) from public.email_provider_config c where c.id = 1) is distinct from current_setting('wp8.pre_cfg') then
    raise exception 'WP8_POST_FAIL:provider_config_changed';
  end if;
  if not exists (select 1 from public.email_service_policy where id = 1 and not welcome_auto_enqueue_enabled) then
    raise exception 'WP8_POST_FAIL:policy_not_inert';
  end if;
  if current_setting('wp8.first_apply') = '1' and not exists (
       select 1 from public.email_service_policy where id = 1 and welcome_enqueue_from is null
          and service_daily_cap = 0 and service_monthly_cap = 0 and not service_dispatch_paused
          and public_go_live_since is null) then
    raise exception 'WP8_POST_FAIL:policy_defaults';
  end if;
  if current_setting('wp8.first_apply') = '1' and exists (select 1 from public.email_wp8_run_ledger) then
    raise exception 'WP8_POST_FAIL:ledger_not_empty';
  end if;
  if (select count(*) from public.email_outbox)::text <> current_setting('wp8.pre_outbox') then raise exception 'WP8_POST_FAIL:outbox_count'; end if;
  if (select count(*) from public.email_send_events)::text <> current_setting('wp8.pre_events') then raise exception 'WP8_POST_FAIL:events_count'; end if;
  if (select count(*) from public.email_send_allowlist)::text <> current_setting('wp8.pre_allowlist') then raise exception 'WP8_POST_FAIL:allowlist_count'; end if;
  if (select count(*) from public.member_service_pref_current)::text <> current_setting('wp8.pre_prefs') then raise exception 'WP8_POST_FAIL:prefs_count'; end if;
  if (select count(*) from public.members)::text <> current_setting('wp8.pre_members') then raise exception 'WP8_POST_FAIL:members_count'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)');
  if v is distinct from current_setting('wp8.pre_decision_md5') then raise exception 'WP8_POST_FAIL:decision_changed'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text)');
  if v is distinct from current_setting('wp8.pre_enqueue_md5') then raise exception 'WP8_POST_FAIL:enqueue_changed'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public.email_ingest_provider_event(text,text,text,text,timestamptz,text)');
  if v is distinct from current_setting('wp8.pre_ingest_md5') then raise exception 'WP8_POST_FAIL:ingest_changed'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public._seed_welcome_service_pref_on_member_insert()');
  if v is distinct from '92e4db755ce2d41584c302073e60fdb1' then raise exception 'WP8_POST_FAIL:wse_seed_changed'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public.service_pref_set(public.service_pref_key,boolean,text,uuid)');
  if v is distinct from 'f171f1ab1a2c183f861f63060a1ad5de' then raise exception 'WP8_POST_FAIL:service_pref_set_changed'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public.service_delivery_readiness_check()');
  if v is distinct from '5e74aa1d695c2b573e90cc85fb2d4060' then raise exception 'WP8_POST_FAIL:readiness_changed'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public.email_purge_expired_content()');
  if v is distinct from 'efec09f92a2d7f8fd4610b9461ecbc4c' then raise exception 'WP8_POST_FAIL:purge_changed'; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public.email_claim_batch(int)');
  if v is distinct from '@@WP8_CLAIM_MD5@@' then raise exception 'WP8_POST_FAIL:claim_md5:%', v; end if;
  select md5(prosrc) into v from pg_proc where oid = to_regprocedure('public.email_mark_result(uuid,boolean,text,text)');
  if v is distinct from '@@WP8_MARK_MD5@@' then raise exception 'WP8_POST_FAIL:mark_md5:%', v; end if;

  if not exists (
       select 1 from public.email_service_templates t join public.email_service_policy p on p.welcome_template_id = t.id
        where p.id = 1 and t.template_key = 'welcome_service_email' and t.version = 'v3.2'
          and t.html_sha256 = '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'
          and t.text_sha256 = '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'
          and encode(sha256(convert_to(t.body_html, 'UTF8')), 'hex') = t.html_sha256
          and encode(sha256(convert_to(t.body_text, 'UTF8')), 'hex') = t.text_sha256
          and t.subject = convert_from(decode('@@SUBJECT_HEX@@', 'hex'), 'UTF8')) then
    raise exception 'WP8_POST_FAIL:template_pin';
  end if;
  if not exists (select 1 from pg_index where indexrelid = to_regclass('public.email_outbox_welcome_once_uk') and indisvalid and indisunique) then
    raise exception 'WP8_POST_FAIL:welcome_once_index';
  end if;
  if (select count(*) from pg_trigger
       where not tgisinternal and tgenabled = 'O'
         and ((tgrelid = to_regclass('public.email_provider_config') and tgname = 'email_provider_config_golive_guard')
           or (tgrelid = to_regclass('public.email_service_policy') and tgname = 'email_service_policy_guard')
           or (tgrelid = to_regclass('public.email_service_templates') and tgname = 'email_service_templates_immutable')
           or (tgrelid = to_regclass('public.email_send_event_links') and tgname = 'email_send_event_links_append_only')
           or (tgrelid = to_regclass('public.email_wp8_manifest') and tgname = 'email_wp8_manifest_append_only'))) <> 5 then
    raise exception 'WP8_POST_FAIL:guard_triggers';
  end if;

  for r in select * from (values
@@WP8_FN_MANIFEST@@
  ) as m(sig, body_md5, svc) loop
    v_oid := to_regprocedure(r.sig);
    if v_oid is null then raise exception 'WP8_POST_FAIL:function_missing:%', r.sig; end if;
    if (select md5(prosrc) from pg_proc where oid = v_oid) is distinct from r.body_md5 then
      raise exception 'WP8_POST_FAIL:function_md5:%', r.sig;
    end if;
    if has_function_privilege('anon', v_oid, 'execute') or has_function_privilege('authenticated', v_oid, 'execute') then
      raise exception 'WP8_POST_FAIL:function_acl_public:%', r.sig;
    end if;
    if has_function_privilege('service_role', v_oid, 'execute') is distinct from r.svc then
      raise exception 'WP8_POST_FAIL:function_acl_service_role:%', r.sig;
    end if;
    insert into public.email_wp8_manifest(object_kind, signature, body_md5, service_role_execute)
    values ('function', r.sig, r.body_md5, r.svc) on conflict (object_kind, signature) do nothing;
    if not exists (select 1 from public.email_wp8_manifest mf where mf.object_kind = 'function' and mf.signature = r.sig
                    and mf.body_md5 = r.body_md5 and mf.service_role_execute = r.svc) then
      raise exception 'WP8_POST_FAIL:manifest_mismatch:%', r.sig;
    end if;
    n_fn := n_fn + 1;
  end loop;
  for r in select * from (values
@@WP8_TABLE_MANIFEST@@
  ) as m(tbl) loop
    v_oid := to_regclass(r.tbl);
    if v_oid is null then raise exception 'WP8_POST_FAIL:table_missing:%', r.tbl; end if;
    if has_table_privilege('anon', v_oid, 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('authenticated', v_oid, 'select,insert,update,delete,truncate,references,trigger') then
      raise exception 'WP8_POST_FAIL:table_acl_public:%', r.tbl;
    end if;
    if has_table_privilege('service_role', v_oid, 'insert,update,delete,truncate') then
      raise exception 'WP8_POST_FAIL:table_acl_service_role:%', r.tbl;
    end if;
    if not exists (select 1 from pg_class c where c.oid = v_oid and c.relrowsecurity and c.relforcerowsecurity) then
      raise exception 'WP8_POST_FAIL:table_rls:%', r.tbl;
    end if;
    insert into public.email_wp8_manifest(object_kind, signature) values ('table', r.tbl) on conflict (object_kind, signature) do nothing;
    n_tbl := n_tbl + 1;
  end loop;
  if (select count(*) from public.email_wp8_manifest where object_kind = 'function') <> n_fn
     or (select count(*) from public.email_wp8_manifest where object_kind = 'table') <> n_tbl then
    raise exception 'WP8_POST_FAIL:manifest_extra_rows';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%net.http_post%') then
    raise exception 'WP8_POST_FAIL:http_caller_present';
  end if;
  raise notice 'WP8_UP_OK functions=% tables=%', n_fn, n_tbl;
end
$wp8_post$;
