-- WP8 behaviour suite (CI only). Runs inside ONE transaction that the runner rolls back.
-- Shared by real PostgreSQL 16 (psql) and PGlite (PostgreSQL 17). No psql meta-commands.
-- Precondition: CI chain + wp8_fixture_pre.sql + WP8_DB_up.sql applied (inert state).
-- Every check writes one row into wp8_t; the runner prints them and compares the count.

create temp table wp8_t(seq serial primary key, name text not null, pass boolean not null, info text);
create function pg_temp.ck(p_name text, p_pass boolean, p_info text default null) returns void
language sql as $t$
  insert into wp8_t(name, pass, info) values (p_name, coalesce(p_pass, false), case when coalesce(p_pass, false) then null else coalesce(p_info, 'null') end)
$t$;
create function pg_temp.err(p_name text, p_sql text, p_frag text) returns void
language plpgsql as $t$
declare v_msg text := null;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm || ' [' || sqlstate || ']';
  end;
  perform pg_temp.ck(p_name, v_msg is not null and position(p_frag in v_msg) > 0, coalesce(v_msg, 'no error'));
end
$t$;
create function pg_temp.open_res(c int, e int, i int, d int, r int, x int, reasons jsonb, expired int default 0, reconciled int default 0) returns jsonb
language sql immutable as $t$
  select jsonb_build_object('ok', true, 'gate', 'open', 'candidates', c, 'enqueued', e, 'idempotent', i, 'not_eligible', d,
    'race', r, 'errors', x, 'reasons', reasons, 'expired', expired, 'reconciled', reconciled)
$t$;
create function pg_temp.closed_res(g text, expired int default 0, reconciled int default 0) returns jsonb
language sql immutable as $t$
  select jsonb_build_object('ok', true, 'gate', g, 'expired', expired, 'reconciled', reconciled)
$t$;
create function pg_temp.sweep_is(p_name text, p_expect jsonb, p_limit int default null) returns jsonb
language plpgsql as $t$
declare v jsonb;
begin
  v := public.welcome_enqueue_sweep(p_limit);
  perform pg_temp.ck(p_name, v = p_expect, v::text);
  return v;
end
$t$;
create function pg_temp.uid(p_label text) returns uuid language sql immutable as $t$ select md5('wp8-ci-' || p_label)::uuid $t$;
create function pg_temp.nrows(p_label text) returns int language sql as $t$
  select count(*)::int from public.email_outbox where user_id = pg_temp.uid(p_label)
$t$;
create function pg_temp.wrow(p_label text) returns public.email_outbox language sql as $t$
  select * from public.email_outbox where idempotency_key = 'wp8:welcome_service_email:v1:' || pg_temp.uid(p_label)::text
$t$;
create function pg_temp.claim(n int) returns int language sql as $t$ select count(*)::int from public.email_claim_batch(n) $t$;
create function pg_temp.mkuser(p_label text, p_first text, p_allow boolean, p_pref boolean, p_auth_at timestamptz, p_member_at timestamptz, p_blocked boolean default false)
returns uuid language plpgsql as $t$
declare v uuid := pg_temp.uid(p_label);
begin
  insert into auth.users(id, email, created_at) values (v, 'ci-' || lower(p_label) || '@example.test', p_auth_at);
  insert into public.members(user_id, email, created_at, first_name, blocked) values (v, 'ci-' || lower(p_label) || '@example.test', p_member_at, p_first, p_blocked);
  if p_pref is false then
    perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true);
    perform public.service_pref_set('welcome_service_email', false, 'ci-pref-off-' || p_label, md5('ci-pref-off-' || p_label)::uuid);
    perform set_config('request.jwt.claims', '', true);
  end if;
  if p_allow then
    insert into public.email_send_allowlist(user_id, note, active) values (v, 'wp8-ci-' || p_label, true);
  end if;
  return v;
end
$t$;
create function pg_temp.pref_off(p_label text) returns void language plpgsql as $t$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(p_label), 'role', 'authenticated')::text, true);
  perform public.service_pref_set('welcome_service_email', false, 'ci-pref-off2-' || p_label, md5('ci-pref-off2-' || p_label)::uuid);
  perform set_config('request.jwt.claims', '', true);
end
$t$;
create function pg_temp.suppress(p_label text) returns void language plpgsql as $t$
declare v_h text := public._contact_hmac('ci-' || lower(p_label) || '@example.test', 1); v_ev uuid;
begin
  insert into public.contact_suppression_events(channel, scope, contact_hmac, reason, action, source, request_id, idempotency_key, fingerprint)
  values ('email', 'all_email', v_h, 'user_unsubscribe', 'suppress', 'unsubscribe', 'ci', gen_random_uuid(), 'ci-' || p_label) returning id into v_ev;
  insert into public.contact_suppression_current(channel, contact_hmac, scope, reason, status, source_event_id)
  values ('email', v_h, 'all_email', 'user_unsubscribe', 'active', v_ev);
end
$t$;

select set_config('wp8t.mkt_md5', (select md5(string_agg(row(m.*)::text, '|' order by m.id)) from public.marketing_config m), false);
select set_config('wp8t.auth_md5', (select md5(string_agg(row(u.*)::text, '|' order by u.id)) from auth.users u where u.id::text like '0000000f-%'), false);
select set_config('wp8t.legacy_md5', (select md5(string_agg(row(o.*)::text, '|' order by o.idempotency_key)) from public.email_outbox o), false);
select set_config('wp8t.events_md5', (select md5(string_agg(row(e.*)::text, '|' order by e.svix_id)) from public.email_send_events e), false);
select set_config('wp8t.decision_md5', (select md5(prosrc) from pg_proc where oid = 'public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)'::regprocedure), false);
select set_config('wp8t.tpl', (select id::text from public.email_service_templates where template_key = 'welcome_service_email' and version = 'v3.2'), false);

-- ===== S1 inert state, setter argument checks
select pg_temp.sweep_is('S1 inert: sweep -> auto_disabled, no writes', pg_temp.closed_res('auto_disabled'));
select pg_temp.ck('S1 inert: claim(10) -> 0 rows', pg_temp.claim(10) = 0);
select pg_temp.ck('S1 inert: ledger empty', (select count(*) from public.email_wp8_run_ledger) = 0);
select pg_temp.ck('S1 inert: policy defaults', (select not welcome_auto_enqueue_enabled and welcome_enqueue_from is null and service_daily_cap = 0
  and service_monthly_cap = 0 and not service_dispatch_paused and public_go_live_since is null and welcome_template_id = current_setting('wp8t.tpl')::uuid
  from public.email_service_policy where id = 1));
select pg_temp.err('S1 setter: enable with caps 0 refused', $q$select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', true, 'ci', 'ci-1')$q$, 'wp8_caps_unset');
select pg_temp.err('S1 setter: support role refused', $q$select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a002', false, 'ci', 'ci-1')$q$, 'forbidden');
select pg_temp.err('S1 setter: null actor refused', $q$select public.admin_w_welcome_automation_set(null, false, 'ci', 'ci-1')$q$, 'forbidden');
select pg_temp.err('S1 setter: reason with @ refused', $q$select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', false, 'a@b', 'ci-1')$q$, 'reason_invalid');
select pg_temp.err('S1 setter: blank reason refused', $q$select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', false, '  ', 'ci-1')$q$, 'reason_invalid');
select pg_temp.err('S1 setter: missing request id refused', $q$select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', false, 'ci', '')$q$, 'request_id_required');
select pg_temp.err('S1 setter: request id with @ refused', $q$select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', false, 'ci', 'x@y')$q$, 'request_id_invalid');
select pg_temp.err('S1 go-live setter: support role refused', $q$select public.admin_w_email_public_go_live_set('0000000a-0000-4000-8000-00000000a002', true, 'ci', 'ci-1')$q$, 'forbidden');

-- ===== S2 policy guard (amendment 1) and ACL
select pg_temp.err('S2 boundary NULL -> past refused', $q$update public.email_service_policy set welcome_enqueue_from = timestamptz '2026-10-01 00:00:00+00' where id = 1$q$, 'wp8_boundary_cannot_precede_change');
select pg_temp.err('S2 boundary before cutover refused (guard fires before the CHECK)', $q$update public.email_service_policy set welcome_enqueue_from = timestamptz '2026-09-30 00:00:00+00' where id = 1$q$, 'wp8_boundary_cannot_precede_change');
select pg_temp.err('S2 policy delete refused', $q$delete from public.email_service_policy where id = 1$q$, 'wp8_policy_delete_refused');
select pg_temp.err('S2 policy non-inert insert refused', $q$insert into public.email_service_policy(id, service_daily_cap, service_monthly_cap) values (1, 5, 5)$q$, 'wp8_policy_insert_must_be_inert');
select pg_temp.err('S2 policy second row refused', $q$insert into public.email_service_policy(id) values (2)$q$, 'wp8_policy_insert_must_be_inert');
select pg_temp.err('S2 go-live since NULL -> past refused', $q$update public.email_service_policy set public_go_live_since = timestamptz '2026-10-02 00:00:00+00' where id = 1$q$, 'wp8_go_live_since_cannot_precede_change');
select pg_temp.err('S2 daily cap ceiling 50', $q$update public.email_service_policy set service_daily_cap = 51, service_monthly_cap = 1500 where id = 1$q$, 'email_service_policy_ranges_ck');
select pg_temp.err('S2 monthly cap ceiling 1500', $q$update public.email_service_policy set service_daily_cap = 10, service_monthly_cap = 1501 where id = 1$q$, 'email_service_policy_ranges_ck');
select pg_temp.err('S2 OTP daily reserve floor 20', $q$update public.email_service_policy set otp_reserve_daily = 19 where id = 1$q$, 'email_service_policy_ranges_ck');
select pg_temp.err('S2 OTP monthly reserve floor 300', $q$update public.email_service_policy set otp_reserve_monthly = 299 where id = 1$q$, 'email_service_policy_ranges_ck');
select pg_temp.err('S2 enable without boundary refused by CHECK', $q$update public.email_service_policy set welcome_auto_enqueue_enabled = true where id = 1$q$, 'email_service_policy_enable_ck');
select pg_temp.err('S2 pin to a non-welcome template refused', $q$update public.email_service_policy set welcome_template_id = gen_random_uuid() where id = 1$q$, 'wp8_template_not_welcome');
do $t$
declare v_denied int := 0; v_t text;
begin
  foreach v_t in array array[
    'update public.email_service_policy set service_daily_cap = 5, service_monthly_cap = 5 where id = 1',
    'insert into public.email_service_policy(id) values (1)',
    'delete from public.email_service_policy where id = 1',
    'truncate public.email_service_policy',
    'select count(*) from public.email_service_policy',
    'insert into public.email_service_templates(template_key) values (''x'')',
    'delete from public.email_send_event_links',
    'insert into public.email_wp8_run_ledger(job, gate) values (''welcome_enqueue_sweep'', ''open'')',
    'delete from public.email_wp8_manifest'] loop
    begin
      set local role service_role;
      execute v_t;
    exception when insufficient_privilege then
      v_denied := v_denied + 1;
    end;
    reset role;
  end loop;
  perform pg_temp.ck('S2 service_role cannot write (or read) WP8 tables directly (9 statements)', v_denied = 9, v_denied::text);
end
$t$;
do $t$
declare v_denied int := 0; v_t text; v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_t in array array[
      'select public.welcome_enqueue_sweep()',
      'select count(*) from public.email_claim_batch(1)',
      'select public.email_release_claim(gen_random_uuid(), 60, false)',
      'select public.email_mark_result(gen_random_uuid(), true, null, null)',
      'select public.email_reconcile_orphan_events(1)',
      'select public.admin_w_welcome_automation_set(null, false, ''x'', ''y'')',
      'select public.admin_w_email_public_go_live_set(null, false, ''x'', ''y'')',
      'select * from public.welcome_render(gen_random_uuid(), null)',
      'select public._wp8_auth_otp_load()',
      'select public._email_link_orphans_for(gen_random_uuid(), ''reconcile_late_link'')',
      'select count(*) from public.email_service_policy',
      'select count(*) from public.email_service_templates',
      'select count(*) from public.email_wp8_run_ledger'] loop
      begin
        execute format('set local role %I', v_role);
        execute v_t;
      exception when insufficient_privilege then
        v_denied := v_denied + 1;
      end;
      reset role;
    end loop;
  end loop;
  perform pg_temp.ck('S2 anon/authenticated denied on 13 WP8 entry points and tables each', v_denied = 26, v_denied::text);
end
$t$;
select pg_temp.ck('S2 manifest: every WP8 function closed to anon/authenticated, service_role as declared',
  (select count(*) = 14 and bool_and(not has_function_privilege('anon', to_regprocedure(m.signature), 'execute')
       and not has_function_privilege('authenticated', to_regprocedure(m.signature), 'execute')
       and has_function_privilege('service_role', to_regprocedure(m.signature), 'execute') = m.service_role_execute
       and (select md5(prosrc) from pg_proc where oid = to_regprocedure(m.signature)) = m.body_md5)
     from public.email_wp8_manifest m where m.object_kind = 'function'));
select pg_temp.ck('S2 manifest: every WP8 table RLS forced and closed',
  (select count(*) = 5 and bool_and(c.relrowsecurity and c.relforcerowsecurity
       and not has_table_privilege('anon', c.oid, 'select,insert,update,delete')
       and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
       and not has_table_privilege('service_role', c.oid, 'insert,update,delete,truncate'))
     from public.email_wp8_manifest m join pg_class c on c.oid = to_regclass(m.signature) where m.object_kind = 'table'));
select pg_temp.err('S2 manifest is append-only', $q$delete from public.email_wp8_manifest$q$, 'append_only');

-- ===== S3 template and render
select pg_temp.ck('S3 template bytes pinned', (select html_sha256 = '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'
  and text_sha256 = '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'
  and octet_length(convert_to(body_html, 'UTF8')) = 13354 and octet_length(convert_to(body_text, 'UTF8')) = 343
  and subject = U&'Aram\0131za ho\015F geldin' and message_class = 'optional_service' and locale = 'tr-TR'
  from public.email_service_templates where id = current_setting('wp8t.tpl')::uuid));
select pg_temp.ck('S3 render O''Neil: html escaped, text raw',
  (select position('Merhaba O&#39;Neil,' in body_html) > 0 and position('Merhaba O''Neil,' in body_text) > 0 and position('{{' in body_html || body_text) = 0
     from public.welcome_render(current_setting('wp8t.tpl')::uuid, 'O''Neil')));
select pg_temp.ck('S3 render: subject static, no name in subject',
  (select subject = U&'Aram\0131za ho\015F geldin' from public.welcome_render(current_setting('wp8t.tpl')::uuid, 'Zeynep')));
select pg_temp.ck('S3 render: html outside the greeting is byte-identical to v3.2',
  (select replace(r.body_html, 'Merhaba Zeynep,', 'Merhaba {{first_name}},') = t.body_html
      and replace(r.body_text, 'Merhaba Zeynep,', 'Merhaba {{first_name}},') = t.body_text
     from public.welcome_render(current_setting('wp8t.tpl')::uuid, 'Zeynep') r, public.email_service_templates t where t.id = current_setting('wp8t.tpl')::uuid));
select pg_temp.ck('S3 render NULL -> neutral greeting, rest byte-identical',
  (select position('Merhaba,' in r.body_html) > 0 and position('Merhaba,' in r.body_text) > 0
      and replace(r.body_html, 'Merhaba,', 'Merhaba {{first_name}},') = t.body_html
      and replace(r.body_text, 'Merhaba,', 'Merhaba {{first_name}},') = t.body_text
     from public.welcome_render(current_setting('wp8t.tpl')::uuid, null) r, public.email_service_templates t where t.id = current_setting('wp8t.tpl')::uuid));
select pg_temp.ck('S3 render neutral for blank / 51 chars / brace / U+2028 / control char',
  (select bool_and(position('Merhaba,' in r.body_html) > 0 and position('Merhaba,' in r.body_text) > 0 and position('{{' in r.body_html || r.body_text) = 0)
     from unnest(array['', '   ', repeat('a', 51), 'A{b', 'A}b', 'A' || U&'\2028' || 'b', 'A' || chr(9) || 'b', 'A' || chr(127)]) n,
          lateral public.welcome_render(current_setting('wp8t.tpl')::uuid, n) r));
select pg_temp.ck('S3 render escapes < > & " in html',
  (select position('Merhaba &lt;b&gt;x&amp;y&quot;&lt;/b&gt;,' in body_html) > 0 and position('Merhaba <b>x&y"</b>,' in body_text) > 0
     from public.welcome_render(current_setting('wp8t.tpl')::uuid, '<b>x&y"</b>')));
select pg_temp.ck('S3 render trims and keeps Turkish letters', (select position(U&'Merhaba Ay\015Fe,' in body_html) > 0
     from public.welcome_render(current_setting('wp8t.tpl')::uuid, U&'  Ay\015Fe ')));
select pg_temp.ck('S3 render 50 chars kept', (select position('Merhaba ' || repeat('a', 50) || ',' in body_text) > 0
     from public.welcome_render(current_setting('wp8t.tpl')::uuid, repeat('a', 50))));
select pg_temp.err('S3 render unknown template refused', $q$select * from public.welcome_render(gen_random_uuid(), 'x')$q$, 'wp8_template_missing');
select pg_temp.err('S3 template immutable (update)', $q$update public.email_service_templates set subject = 'x'$q$, 'append_only');
select pg_temp.err('S3 template immutable (delete)', $q$delete from public.email_service_templates$q$, 'append_only');
select pg_temp.err('S3 template sha CHECK', $q$insert into public.email_service_templates(template_key, version, message_class, service_pref_key, locale, subject, body_html, body_text, html_sha256, text_sha256, source_path_html, source_path_text)
  values ('welcome_service_email', 'vX', 'optional_service', 'welcome_service_email', 'tr-TR', 's', 'Merhaba {{first_name}}, a', 'Merhaba {{first_name}}, a', repeat('0', 64), repeat('0', 64), 'x', 'y')$q$, 'email_service_templates_html_sha_ck');
select pg_temp.err('S3 template greeting CHECK (two placeholders)', $q$insert into public.email_service_templates(template_key, version, message_class, service_pref_key, locale, subject, body_html, body_text, html_sha256, text_sha256, source_path_html, source_path_text)
  values ('welcome_service_email', 'vY', 'optional_service', 'welcome_service_email', 'tr-TR', 's', 'Merhaba {{first_name}}, {{first_name}}', 'Merhaba {{first_name}},',
          encode(sha256(convert_to('Merhaba {{first_name}}, {{first_name}}', 'UTF8')), 'hex'), encode(sha256(convert_to('Merhaba {{first_name}},', 'UTF8')), 'hex'), 'x', 'y')$q$, 'email_service_templates_greeting_ck');
select pg_temp.err('S3 template class CHECK (marketing impossible)', $q$insert into public.email_service_templates(template_key, version, message_class, service_pref_key, locale, subject, body_html, body_text, html_sha256, text_sha256, source_path_html, source_path_text)
  values ('welcome_service_email', 'vZ', 'essential_transactional', 'welcome_service_email', 'tr-TR', 's', 'Merhaba {{first_name}},', 'Merhaba {{first_name}},',
          encode(sha256(convert_to('Merhaba {{first_name}},', 'UTF8')), 'hex'), encode(sha256(convert_to('Merhaba {{first_name}},', 'UTF8')), 'hex'), 'x', 'y')$q$, 'email_service_templates_class_ck');

-- ===== S4 enable automation; every closed gate writes nothing
update public.email_service_policy set service_daily_cap = 40, service_monthly_cap = 1200, welcome_delay_minutes = 0 where id = 1;
select set_config('wp8t.en', public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', true, 'ci enable', 'ci-enable-1')::text, false);
select set_config('wp8t.b', (select welcome_enqueue_from::text from public.email_service_policy where id = 1), false);
select pg_temp.ck('S4 setter enable: boundary is the setter clock (>= transaction start)', (select welcome_auto_enqueue_enabled and welcome_enqueue_from >= transaction_timestamp()
  and welcome_enqueue_from <= clock_timestamp() from public.email_service_policy where id = 1));
select pg_temp.ck('S4 setter enable: audit row without e-mail', (select count(*) = 1 and bool_and(reason = 'ci enable' and request_id = 'ci-enable-1' and position('@' in after::text) = 0)
  from public.admin_write_log where action = 'wp8_welcome_automation_set'));
select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', true, 'ci enable again', 'ci-enable-2');
select pg_temp.ck('S4 setter re-enable keeps the boundary', (select welcome_enqueue_from = current_setting('wp8t.b')::timestamptz from public.email_service_policy where id = 1));
select pg_temp.err('S4 boundary cannot move backwards', $q$update public.email_service_policy set welcome_enqueue_from = welcome_enqueue_from - interval '1 second' where id = 1$q$, 'wp8_boundary_cannot_move_backwards');
select pg_temp.err('S4 boundary cannot be cleared', $q$update public.email_service_policy set welcome_enqueue_from = null where id = 1$q$, 'wp8_boundary_cannot_move_backwards');
select pg_temp.sweep_is('S4 gate service_disabled (no writes)', pg_temp.closed_res('service_disabled'));
update public.email_provider_config set service_enabled = true where id = 1;
update public.email_service_policy set service_dispatch_paused = true where id = 1;
select pg_temp.sweep_is('S4 gate dispatch_paused', pg_temp.closed_res('dispatch_paused'));
update public.email_service_policy set service_dispatch_paused = false, service_daily_cap = 0 where id = 1;
select pg_temp.sweep_is('S4 gate caps_unset', pg_temp.closed_res('caps_unset'));
update public.email_service_policy set service_daily_cap = 40 where id = 1;
update public.service_pref_defaults set default_enabled = null where pref_key = 'welcome_service_email';
select pg_temp.sweep_is('S4 gate wse_policy_inactive', pg_temp.closed_res('wse_policy_inactive'));
update public.service_pref_defaults set default_enabled = true where pref_key = 'welcome_service_email';
insert into public.email_service_templates(template_key, version, message_class, service_pref_key, locale, subject, body_html, body_text, html_sha256, text_sha256, source_path_html, source_path_text)
values ('welcome_service_email', 'v9.9-ci', 'optional_service', 'welcome_service_email', 'tr-TR', 'ci', 'Merhaba {{first_name}}, ci', 'Merhaba {{first_name}}, ci',
        encode(sha256(convert_to('Merhaba {{first_name}}, ci', 'UTF8')), 'hex'), encode(sha256(convert_to('Merhaba {{first_name}}, ci', 'UTF8')), 'hex'), 'ci', 'ci');
update public.email_service_policy set welcome_template_id = (select id from public.email_service_templates where version = 'v9.9-ci') where id = 1;
select pg_temp.sweep_is('S4 gate template_unverified (other template pinned)', pg_temp.closed_res('template_unverified'));
insert into public.email_service_templates(template_key, version, message_class, service_pref_key, locale, subject, body_html, body_text, html_sha256, text_sha256, source_path_html, source_path_text)
select 'welcome_service_email', 'v9.8-ci-text', 'optional_service', 'welcome_service_email', 'tr-TR', t.subject, t.body_html, 'Merhaba {{first_name}}, other text',
       t.html_sha256, encode(sha256(convert_to('Merhaba {{first_name}}, other text', 'UTF8')), 'hex'), 'ci', 'ci'
  from public.email_service_templates t where t.id = current_setting('wp8t.tpl')::uuid;
update public.email_service_policy set welcome_template_id = (select id from public.email_service_templates where version = 'v9.8-ci-text') where id = 1;
select pg_temp.sweep_is('S4 gate template_unverified (same html, other text part)', pg_temp.closed_res('template_unverified'));
insert into public.email_service_templates(template_key, version, message_class, service_pref_key, locale, subject, body_html, body_text, html_sha256, text_sha256, source_path_html, source_path_text)
select 'welcome_service_email', 'v3.2-ci-copy', 'optional_service', 'welcome_service_email', 'tr-TR', t.subject, t.body_html, t.body_text, t.html_sha256, t.text_sha256, 'ci', 'ci'
  from public.email_service_templates t where t.id = current_setting('wp8t.tpl')::uuid;
update public.email_service_policy set welcome_template_id = (select id from public.email_service_templates where version = 'v3.2-ci-copy') where id = 1;
select pg_temp.sweep_is('S4 gate template_unverified (identical bytes, other version)', pg_temp.closed_res('template_unverified'));
update public.email_service_policy set welcome_template_id = current_setting('wp8t.tpl')::uuid where id = 1;
select pg_temp.ck('S4 closed gates wrote no ledger row and no outbox row', (select count(*) from public.email_wp8_run_ledger) = 0
  and (select count(*) from public.email_outbox) = 3);
select pg_temp.sweep_is('S4 gate open, empty allowlist -> 0 candidates', pg_temp.open_res(0, 0, 0, 0, 0, 0, '{}'));
select pg_temp.ck('S4 open sweep writes one counts-only ledger row', (select count(*) = 1 and bool_and(gate = 'open' and candidates = 0 and reasons = '{}'::jsonb) from public.email_wp8_run_ledger));

-- ===== S5 cohort: allowlist, boundary (no backfill), pref, block, age
select pg_temp.mkuser('A', 'O''Neil', true, null, clock_timestamp(), now());
select pg_temp.mkuser('B', null, true, null, clock_timestamp(), now());
select pg_temp.mkuser('C', null, true, false, clock_timestamp(), now());
select pg_temp.mkuser('D', 'Deniz', false, null, clock_timestamp(), now());
select pg_temp.mkuser('E', 'Ece', true, null, clock_timestamp(), now());
select pg_temp.mkuser('F', 'Fatma', true, null, clock_timestamp(), now(), true);
select pg_temp.mkuser('G', 'Gul', true, null, timestamptz '2026-10-05 12:00:00+00', now());
select pg_temp.mkuser('H', 'Hasan', true, null, clock_timestamp(), now() - interval '49 hours');
select pg_temp.mkuser('J', 'Jale', true, null, clock_timestamp(), now());
select pg_temp.suppress('J');
insert into public.email_send_allowlist(user_id, note, active) values
  ('0000000f-0000-4000-8000-0000000000f1', 'wp8-ci-legacy', true),
  ('0000000f-0000-4000-8000-0000000000f3', 'wp8-ci-post-wse', true);
select pg_temp.ck('S5 WSE seed gave pref=true to the new users, C is OFF', (select count(*) filter (where enabled) = 8 and count(*) filter (where not enabled) = 1
  from public.member_service_pref_current where user_id in (select pg_temp.uid(l) from unnest(array['A','B','C','D','E','F','G','H','J']) l)));
select pg_temp.sweep_is('S5 sweep: A,B,E enqueued; J denied by decision', pg_temp.open_res(4, 3, 0, 1, 0, 0, '{"suppressed_unsubscribe": 1}'));
select pg_temp.ck('S5 one queued row each for A, B, E', pg_temp.nrows('A') = 1 and pg_temp.nrows('B') = 1 and pg_temp.nrows('E') = 1
  and (pg_temp.wrow('A')).status = 'queued' and (pg_temp.wrow('B')).status = 'queued' and (pg_temp.wrow('E')).status = 'queued');
select pg_temp.ck('S5 pref OFF (C): no row, no skipped row', pg_temp.nrows('C') = 0);
select pg_temp.ck('S5 not allowlisted (D): no row, no skipped row', pg_temp.nrows('D') = 0);
select pg_temp.ck('S5 blocked (F): no row', pg_temp.nrows('F') = 0);
select pg_temp.ck('S5 auth before boundary (G): no row (no backfill)', pg_temp.nrows('G') = 0);
select pg_temp.ck('S5 member older than max-age (H): no row', pg_temp.nrows('H') = 0);
select pg_temp.ck('S5 suppressed (J): no row, no skipped row', pg_temp.nrows('J') = 0);
select pg_temp.ck('S5 legacy owner and post-WSE/pre-WP8 user: no new row', (select count(*) from public.email_outbox where user_id = '0000000f-0000-4000-8000-0000000000f1') = 2
  and (select count(*) from public.email_outbox where user_id = '0000000f-0000-4000-8000-0000000000f3') = 0);
select pg_temp.ck('S5 rows carry key, class, template id, request id; legacy template_id stays NULL',
  (select count(*) = 3 and bool_and(o.message_class = 'optional_service' and o.service_pref_key = 'welcome_service_email' and o.template_id is null
       and o.service_template_id = current_setting('wp8t.tpl')::uuid and o.request_id = 'wp8-sweep' and o.attempts = 0 and o.subject = U&'Aram\0131za ho\015F geldin')
     from public.email_outbox o where o.idempotency_key like 'wp8:welcome_service_email:v1:%'));
select pg_temp.ck('S5 A body: Merhaba O&#39;Neil, (html) / Merhaba O''Neil, (text)',
  position('Merhaba O&#39;Neil,' in (pg_temp.wrow('A')).body_html) > 0 and position('Merhaba O''Neil,' in (pg_temp.wrow('A')).body_text) > 0);
select pg_temp.ck('S5 B body: neutral Merhaba, in both parts', position('Merhaba,' in (pg_temp.wrow('B')).body_html) > 0 and position('Merhaba,' in (pg_temp.wrow('B')).body_text) > 0
  and position('{{' in (pg_temp.wrow('B')).body_html || (pg_temp.wrow('B')).body_text) = 0);
select pg_temp.ck('S5 no address in outbox subject/body', (select count(*) from public.email_outbox where subject like '%@example.test%' or coalesce(body_html, '') like '%@example.test%' or coalesce(body_text, '') like '%@example.test%') = 0);
select pg_temp.sweep_is('S5 second sweep: nothing new (J re-evaluated)', pg_temp.open_res(1, 0, 0, 1, 0, 0, '{"suppressed_unsubscribe": 1}'));
insert into public.email_send_allowlist(user_id, note, active) values (pg_temp.uid('D'), 'wp8-ci-D', true);
select pg_temp.sweep_is('S5 D allowlisted later -> enqueued', pg_temp.open_res(2, 1, 0, 1, 0, 0, '{"suppressed_unsubscribe": 1}'));
select pg_temp.ck('S5 exactly one welcome row per user', (select count(*) = 0 from (select user_id from public.email_outbox where service_pref_key = 'welcome_service_email' and created_at >= timestamptz '2026-10-01' group by user_id having count(*) > 1) d));
select pg_temp.ck('S5 replay of the same enqueue -> idempotent, same id',
  (select (public.email_enqueue(o.user_id, 'optional_service', 'welcome_service_email', o.subject, o.body_html, o.body_text, null, o.idempotency_key, 'replay')->>'idempotent')::boolean
          and (public.email_enqueue(o.user_id, 'optional_service', 'welcome_service_email', o.subject, o.body_html, o.body_text, null, o.idempotency_key, 'replay')->>'id')::uuid = o.id
     from public.email_outbox o where o.idempotency_key = 'wp8:welcome_service_email:v1:' || pg_temp.uid('A')::text));
select pg_temp.err('S5 second welcome for A under another key -> unique_violation',
  format($q$select public.email_enqueue(%L, 'optional_service', 'welcome_service_email', 's', 'h', 't', null, 'other-key-A', 'r')$q$, pg_temp.uid('A')), '23505');
update public.email_service_policy set welcome_delay_minutes = 10 where id = 1;
select pg_temp.mkuser('I', 'Ilke', true, null, clock_timestamp(), now());
select pg_temp.sweep_is('S5 delay not elapsed -> I not a candidate', pg_temp.open_res(0, 0, 0, 0, 0, 0, '{}'));
update public.members set created_at = now() - interval '11 minutes' where user_id = pg_temp.uid('I');
select pg_temp.sweep_is('S5 delay elapsed -> I enqueued', pg_temp.open_res(1, 1, 0, 0, 0, 0, '{}'));
update public.email_service_policy set welcome_delay_minutes = 0 where id = 1;
select pg_temp.ck('S5 no wp8 row is ever skipped by the sweep', (select count(*) from public.email_outbox where idempotency_key like 'wp8:%' and status = 'skipped') = 0);

-- ===== S6 head-of-line: denied users ahead of an eligible one do not starve it (amendment 6)
update public.email_service_policy set welcome_sweep_limit = 2 where id = 1;
select pg_temp.mkuser('K1', null, true, null, clock_timestamp(), now() - interval '3 minutes');
select pg_temp.mkuser('K2', null, true, null, clock_timestamp(), now() - interval '3 minutes');
select pg_temp.mkuser('K3', null, true, null, clock_timestamp(), now() - interval '3 minutes');
select pg_temp.mkuser('K4', null, true, null, clock_timestamp(), now() - interval '2 minutes');
select pg_temp.suppress('K1'); select pg_temp.suppress('K2'); select pg_temp.suppress('K3');
select pg_temp.sweep_is('S6 limit 2, 3 denied first, K4 still enqueued', pg_temp.open_res(5, 1, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}'));
select pg_temp.ck('S6 K4 has its welcome', pg_temp.nrows('K4') = 1);
select pg_temp.mkuser('K5', null, true, null, clock_timestamp(), now() - interval '1 minutes');
select pg_temp.mkuser('K6', null, true, null, clock_timestamp(), now() - interval '1 minutes');
select pg_temp.mkuser('K7', null, true, null, clock_timestamp(), now() - interval '1 minutes');
select pg_temp.sweep_is('S6 limit counts enqueued rows (2 of 3 new)', pg_temp.open_res(5, 2, 0, 3, 0, 0, '{"suppressed_unsubscribe": 3}'));
select pg_temp.sweep_is('S6 explicit p_limit 1', pg_temp.open_res(4, 1, 0, 3, 0, 0, '{"suppressed_unsubscribe": 3}'), 1);
update public.email_service_policy set welcome_sweep_limit = 20 where id = 1;

-- ===== S7 claim: decision re-check, caps, in-flight, pause, OTP headroom
select pg_temp.pref_off('E');
create temp table wp8_c1 as select * from public.email_claim_batch(20);
select pg_temp.ck('S7 claim: 8 optional rows claimed, E skipped (pref OFF after enqueue)', (select count(*) from wp8_c1) = 8
  and (pg_temp.wrow('E')).status = 'skipped' and (pg_temp.wrow('E')).skip_reason = 'service_pref_disabled');
select pg_temp.ck('S7 claimed rows: sending, attempts 1, first_attempt_at and lease set', (select count(*) = 8 and bool_and(attempts = 1 and first_attempt_at is not null and lease_expires_at > now())
  from public.email_outbox where status = 'sending'));
select pg_temp.ck('S7 claim returns recipient, sender, subject and bodies of the claimed rows', (select bool_and(c.recipient_email = m.email and c.from_email = 'no-reply@send.asalocal.club'
    and c.reply_to = 'destek@asalocal.club' and c.from_name = 'ASALOCAL' and c.message_class = 'optional_service' and c.body_html = o.body_html and c.body_text = o.body_text)
  from wp8_c1 c join public.email_outbox o on o.id = c.outbox_id join public.members m on m.user_id = o.user_id));
update public.email_service_policy set service_daily_cap = 9 where id = 1;
select pg_temp.mkuser('M', null, true, null, clock_timestamp(), now());
select pg_temp.mkuser('N', null, true, null, clock_timestamp(), now());
select pg_temp.sweep_is('S7 M and N enqueued', pg_temp.open_res(6, 2, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}'));
select pg_temp.ck('S7 in-flight counts against the daily cap: 8 sending, cap 9 -> 1 claim', pg_temp.claim(10) = 1);
select pg_temp.ck('S7 cap reached -> 0 claims, row held queued with attempts 0', pg_temp.claim(10) = 0
  and (select count(*) from public.email_outbox where idempotency_key like 'wp8:%' and status = 'queued' and attempts = 0) = 1);
update public.email_service_policy set service_daily_cap = 40 where id = 1;
update public.email_service_policy set service_dispatch_paused = true where id = 1;
select pg_temp.ck('S7 pause holds optional rows queued', pg_temp.claim(10) = 0);
update public.email_service_policy set service_dispatch_paused = false where id = 1;
insert into auth.users(id, email, created_at, confirmation_sent_at)
select md5('wp8-ci-otp-' || g)::uuid, 'otp-' || g || '@example.test', now() - interval '2 days', now() - interval '1 hour' from generate_series(1, 35) g;
insert into auth.users(id, email, created_at, recovery_sent_at, email_change_sent_at)
select md5('wp8-ci-otp2-' || g)::uuid, 'otp2-' || g || '@example.test', now() - interval '2 days', now() - interval '2 hours', now() - interval '3 hours' from generate_series(1, 13) g;
select pg_temp.ck('S7 OTP lower bound counts every *_sent_at column', (select public._wp8_auth_otp_load() = array[61, 61]));
select pg_temp.ck('S7 OTP headroom: 100 - 30 reserve - 61 OTP - 9 in flight = 0 -> no claim', pg_temp.claim(10) = 0);
update auth.users set confirmation_sent_at = now() - interval '25 hours' where id = md5('wp8-ci-otp-1')::uuid;
select pg_temp.ck('S7 OTP headroom 1 (100 - 30 - 60 - 9) -> the held row is claimed', public._wp8_auth_otp_load() = array[60, 61] and pg_temp.claim(10) = 1);
update auth.users set confirmation_sent_at = null, recovery_sent_at = null, email_change_sent_at = null where email like 'otp%@example.test';
alter table auth.users rename column reauthentication_sent_at to reauth_ci_renamed;
select pg_temp.ck('S7 OTP columns missing -> load NULL', public._wp8_auth_otp_load() is null);
select pg_temp.mkuser('O', null, true, null, clock_timestamp(), now());
select pg_temp.sweep_is('S7 O enqueued', pg_temp.open_res(5, 1, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}'));
select pg_temp.ck('S7 OTP columns missing -> claim fails closed (0)', pg_temp.claim(10) = 0);
alter table auth.users rename column reauth_ci_renamed to reauthentication_sent_at;
update public.email_provider_config set essential_enabled = true where id = 1;
select pg_temp.ck('S7 essential enqueue (allowlisted user) queued', (public.email_enqueue(pg_temp.uid('B'), 'essential_transactional', null, 'ess', '<p>e</p>', 'e', null, 'ci-essential-1', 'ci')->>'status') = 'queued');
update auth.users set confirmation_sent_at = now() - interval '1 hour' where email like 'otp-%@example.test';
update auth.users set recovery_sent_at = now() - interval '1 hour', email_change_sent_at = now() - interval '1 hour' where email like 'otp2-%@example.test';
select pg_temp.ck('S7 essential bounded by the same total ceiling (0 headroom -> 0)', pg_temp.claim(10) = 0
  and (select status from public.email_outbox where idempotency_key = 'ci-essential-1') = 'queued');
update auth.users set confirmation_sent_at = null, recovery_sent_at = null, email_change_sent_at = null where email like 'otp%@example.test';
select set_config('wp8t.n', pg_temp.claim(10)::text, false);
select pg_temp.ck('S7 essential claimed once headroom returns (plus O)', current_setting('wp8t.n')::int = 2 and (select status from public.email_outbox where idempotency_key = 'ci-essential-1') = 'sending', current_setting('wp8t.n'));
update public.email_provider_config set essential_enabled = false where id = 1;

-- ===== S8 mark_result classification, release, lease loop, retry horizon, stale expiry
select set_config('wp8t.rA', (pg_temp.wrow('A')).id::text, false);
select pg_temp.ck('S8 mark ok -> sent', (public.email_mark_result(current_setting('wp8t.rA')::uuid, true, 'prov-ci-A', null)->>'status') = 'sent'
  and (pg_temp.wrow('A')).status = 'sent' and (pg_temp.wrow('A')).sent_at is not null);
select pg_temp.ck('S8 mark again -> ignored (monotonic)', (public.email_mark_result(current_setting('wp8t.rA')::uuid, false, null, 'resend_500')->>'ignored')::boolean
  and (pg_temp.wrow('A')).status = 'sent');
do $t$
declare v_l text; v_e text; v_id uuid; n_ok int := 0; v_res jsonb; v_bad text := '';
begin
  for v_e, v_l in select * from (values ('resend_400', 'failed'), ('resend_401', 'failed'), ('resend_403', 'failed'), ('resend_404', 'failed'),
                                   ('resend_405', 'failed'), ('resend_422', 'failed'), ('resend_500', 'requeued'), ('resend_503', 'requeued'),
                                   ('resend_408', 'requeued'), ('resend_409', 'requeued'), ('resend_429', 'requeued'), ('network_error', 'requeued'),
                                   ('resend_429_release_cap', 'requeued')) x(e, s) loop
    insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status, attempts, claimed_at, lease_expires_at)
    values ('ci-mark-' || v_e, 'ci', 'optional_service', 'welcome_service_email', 's', gen_random_uuid(), repeat('b', 64), 'sending', 1, now(), now() + interval '2 minutes')
    returning id into v_id;
    v_res := public.email_mark_result(v_id, false, null, v_e);
    if v_res->>'status' = v_l and (select status::text from public.email_outbox where id = v_id) = (case when v_l = 'requeued' then 'queued' else 'failed' end) then
      n_ok := n_ok + 1;
    else
      v_bad := v_bad || v_e || ' ';
    end if;
  end loop;
  perform pg_temp.ck('S8 mark(false): 400/401/403/404/405/422 terminal on first attempt; 408/409/429/5xx/network retry (13 cases)', n_ok = 13, v_bad);
end
$t$;
select pg_temp.ck('S8 retry backoff 2^attempts minutes', (select bool_and(next_attempt_at = now() + interval '2 minutes') from public.email_outbox where last_error in ('resend_500', 'resend_503', 'network_error') and status = 'queued'));
insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status, attempts, claimed_at, lease_expires_at)
values ('ci-release-1', 'ci', 'optional_service', 'welcome_service_email', 's', gen_random_uuid(), repeat('c', 64), 'sending', 1, now(), now() + interval '2 minutes');
select set_config('wp8t.rel', (select public.email_release_claim(id, 120, false)->>'status' from public.email_outbox where idempotency_key = 'ci-release-1'), false);
select pg_temp.ck('S8 release (429): queued, attempt refunded, retry-after honoured',
  current_setting('wp8t.rel') = 'released'
  and (select status = 'queued' and attempts = 0 and rate_limit_releases = 1 and next_attempt_at = now() + interval '120 seconds' and last_error = 'resend_429' and first_attempt_at is null
       from public.email_outbox where idempotency_key = 'ci-release-1'));
select pg_temp.ck('S8 release on a non-sending row -> ignored', (select (public.email_release_claim(id, 120, false)->>'ignored')::boolean from public.email_outbox where idempotency_key = 'ci-release-1'));
update public.email_outbox set status = 'sending', attempts = 1, lease_expires_at = now() + interval '2 minutes' where idempotency_key = 'ci-release-1';
select set_config('wp8t.rel', (select public.email_release_claim(id, 5, true)->>'retry_after_seconds' from public.email_outbox where idempotency_key = 'ci-release-1'), false);
select pg_temp.ck('S8 release clamps retry-after to 60..3600 and marks not attempted', current_setting('wp8t.rel')::int = 60
  and (select last_error = 'released_not_attempted' from public.email_outbox where idempotency_key = 'ci-release-1'));
update public.email_outbox set status = 'sending', attempts = 1, lease_expires_at = now() + interval '2 minutes' where idempotency_key = 'ci-release-1';
select pg_temp.ck('S8 release clamp upper 3600', (select (public.email_release_claim(id, 99999, false)->>'retry_after_seconds')::int = 3600 from public.email_outbox where idempotency_key = 'ci-release-1'));
do $t$
declare v_id uuid; i int := 0; v_st text;
begin
  select id into v_id from public.email_outbox where idempotency_key = 'ci-release-1';
  update public.email_outbox set status = 'queued', attempts = 0, rate_limit_releases = 0, first_attempt_at = null where id = v_id;
  loop
    i := i + 1;
    exit when i > 40;
    update public.email_outbox set next_attempt_at = now() where id = v_id and status = 'queued';
    select status::text into v_st from public.email_outbox where id = v_id;
    exit when v_st <> 'queued';
    update public.email_outbox set status = 'sending', attempts = attempts + 1, claimed_at = now(), lease_expires_at = now() + interval '2 minutes',
           first_attempt_at = coalesce(first_attempt_at, now()) where id = v_id;
    perform public.email_release_claim(v_id, 60, false);
  end loop;
  perform pg_temp.ck('S8 429 loop is bounded: 6 free releases, then attempts are consumed, ends failed',
    (select status = 'failed' and rate_limit_releases = 6 and attempts = 5 from public.email_outbox where id = v_id) and i <= 12,
    (select format('status=%s releases=%s attempts=%s iterations=%s', status, rate_limit_releases, attempts, i) from public.email_outbox where id = v_id));
end
$t$;
insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status, attempts, claimed_at, lease_expires_at, first_attempt_at)
values ('ci-lease-1', 'ci', 'optional_service', 'welcome_service_email', 's', gen_random_uuid(), repeat('d', 64), 'sending', 1, now(), now() - interval '1 second', now());
select pg_temp.claim(1);
select pg_temp.ck('S8 expired lease -> requeued with backoff (not hot-looped), last_error lease_expired',
  (select status = 'queued' and attempts = 1 and next_attempt_at = now() + interval '2 minutes' and last_error = 'lease_expired' from public.email_outbox where idempotency_key = 'ci-lease-1'));
update public.email_outbox set status = 'sending', attempts = 5, lease_expires_at = now() - interval '1 second' where idempotency_key = 'ci-lease-1';
select pg_temp.claim(1);
select pg_temp.ck('S8 expired lease at max attempts -> failed lease_expired_max_attempts',
  (select status = 'failed' and attempts = 5 and last_error = 'lease_expired_max_attempts' from public.email_outbox where idempotency_key = 'ci-lease-1'));
insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status, attempts, first_attempt_at)
values ('ci-horizon-1', 'ci', 'optional_service', 'welcome_service_email', 's', gen_random_uuid(), repeat('e', 64), 'queued', 1, now() - interval '21 hours');
select pg_temp.claim(1);
select pg_temp.ck('S8 retry horizon: first attempt 21 h ago -> failed retry_window_exceeded',
  (select status = 'failed' and last_error = 'retry_window_exceeded' from public.email_outbox where idempotency_key = 'ci-horizon-1'));
select pg_temp.mkuser('W', null, true, null, clock_timestamp(), now());
select pg_temp.sweep_is('S8 W enqueued', pg_temp.open_res(5, 1, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}'));
update public.email_service_policy set service_dispatch_paused = true where id = 1;
update public.email_outbox set created_at = now() - interval '73 hours', next_attempt_at = now() where status = 'queued' and idempotency_key like 'wp8:%';
select set_config('wp8t.stale', (select count(*)::text from public.email_outbox where status = 'queued' and idempotency_key like 'wp8:%'), false);
insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status, created_at)
values ('ci-non-wp8-old', 'ci', 'optional_service', 'welcome_service_email', 's', gen_random_uuid(), repeat('f', 64), 'queued', now() - interval '80 hours');
select pg_temp.ck('S8 one stale queued wp8 welcome before the claim', current_setting('wp8t.stale')::int = 1);
select set_config('wp8t.n', pg_temp.claim(10)::text, false);
select pg_temp.ck('S8 paused 73 h: claim still cancels stale wp8 welcomes first', current_setting('wp8t.n')::int = 0
  and (select count(*) from public.email_outbox where status = 'queued' and idempotency_key like 'wp8:%') = 0
  and (select count(*) = current_setting('wp8t.stale')::int from public.email_outbox where status = 'canceled' and last_error = 'wp8_queue_expired'));
select pg_temp.ck('S8 non-wp8 rows are not expired by WP8', (select status = 'queued' from public.email_outbox where idempotency_key = 'ci-non-wp8-old'));
update public.email_outbox set status = 'canceled' where idempotency_key = 'ci-non-wp8-old';
update public.email_service_policy set service_dispatch_paused = false where id = 1;
select pg_temp.ck('S8 re-enabled after the pause: 0 claims for stale welcomes', pg_temp.claim(10) = 0);

-- ===== S9 late-link (Gap C): mark_result and reconcile; legacy orphans never linked
select pg_temp.mkuser('X', null, true, null, clock_timestamp(), now());
select pg_temp.mkuser('Y', null, true, null, clock_timestamp(), now());
select pg_temp.mkuser('Z', null, true, null, clock_timestamp(), now());
select pg_temp.sweep_is('S9 X, Y, Z enqueued', pg_temp.open_res(7, 3, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}'));
select pg_temp.ck('S9 X, Y, Z claimed', pg_temp.claim(10) = 3);
select public.email_ingest_provider_event('svix-ci-x1', 'email.delivered', 'prov-ci-X', 'ci-x@example.test', now(), null);
select pg_temp.ck('S9 webhook before mark -> orphan event', (select outbox_id is null from public.email_send_events where svix_id = 'svix-ci-x1'));
select pg_temp.ck('S9 mark ok late-links the orphan -> delivered', (public.email_mark_result((pg_temp.wrow('X')).id, true, 'prov-ci-X', null)->>'late_linked')::int = 1
  and (pg_temp.wrow('X')).status = 'delivered' and (pg_temp.wrow('X')).delivered_at = (select received_at from public.email_send_events where svix_id = 'svix-ci-x1'));
select pg_temp.ck('S9 link row recorded; event row untouched (append-only)', (select count(*) = 1 from public.email_send_event_links l join public.email_send_events e on e.id = l.event_id
  where e.svix_id = 'svix-ci-x1' and l.outbox_id = (pg_temp.wrow('X')).id and l.link_source = 'mark_result_late_link')
  and (select outbox_id is null from public.email_send_events where svix_id = 'svix-ci-x1'));
select public.email_mark_result((pg_temp.wrow('Y')).id, true, 'prov-ci-Y', null);
insert into public.email_send_events(outbox_id, provider_message_id, svix_id, event_type) values (null, 'prov-ci-Y', 'svix-ci-y1', 'email.delivered');
insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status, provider_message_id, sent_at)
values ('ci-legacy-orphan-match', 'ci', 'optional_service', 'welcome_service_email', 's', gen_random_uuid(), repeat('a', 64), 'sent', 'prov-legacy-orphan', now());
select pg_temp.sweep_is('S9 sweep housekeeping reconciles the late orphan', pg_temp.open_res(4, 0, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}', 0, 1));
select pg_temp.ck('S9 reconcile -> Y delivered via reconcile_late_link', (pg_temp.wrow('Y')).status = 'delivered'
  and (select count(*) = 1 from public.email_send_event_links l where l.outbox_id = (pg_temp.wrow('Y')).id and l.link_source = 'reconcile_late_link'));
select pg_temp.ck('S9 legacy (pre-cutover) orphans are never linked', (select count(*) from public.email_send_event_links l join public.email_send_events e on e.id = l.event_id
  where e.provider_message_id = 'prov-legacy-orphan') = 0 and (select status = 'sent' from public.email_outbox where idempotency_key = 'ci-legacy-orphan-match'));
update public.email_outbox set status = 'canceled' where idempotency_key = 'ci-legacy-orphan-match';
select public.email_ingest_provider_event('svix-ci-z1', 'email.bounced', 'prov-ci-Z', 'ci-z@example.test', now(), 'Permanent');
select pg_temp.ck('S9 permanent bounce before mark -> late-link marks failed; suppression applied by ingest',
  (public.email_mark_result((pg_temp.wrow('Z')).id, true, 'prov-ci-Z', null)->>'status') = 'failed'
  and (select count(*) = 1 from public.contact_suppression_current where contact_hmac = public._contact_hmac('ci-z@example.test', 1) and reason = 'hard_bounce' and status = 'active'));
select pg_temp.ck('S9 reconcile is idempotent', (public.email_reconcile_orphan_events(50)->>'linked')::int = 0);
select pg_temp.err('S9 links are append-only', $q$delete from public.email_send_event_links$q$, 'append_only');
select pg_temp.err('S9 link source validated', format($q$select public._email_link_orphans_for(%L, 'x')$q$, (pg_temp.wrow('X')).id), 'wp8_link_source_invalid');
select pg_temp.ck('S9 webhook after delivered keeps delivered (monotonic, unchanged ingest)',
  (select (public.email_ingest_provider_event('svix-ci-x2', 'email.sent', 'prov-ci-X', 'ci-x@example.test', now(), null)->>'ok')::boolean) and (pg_temp.wrow('X')).status = 'delivered');
select pg_temp.ck('S9 webhook dedupe (same svix id) unchanged', (public.email_ingest_provider_event('svix-ci-x2', 'email.sent', 'prov-ci-X', 'ci-x@example.test', now(), null)->>'duplicate')::boolean);

-- ===== S10 public go-live fail-closed (amendment 2)
select pg_temp.err('S10 direct go-live refused without readiness', $q$update public.email_provider_config set public_go_live = true where id = 1$q$, 'wp8_public_go_live_requires_service_delivery_readiness');
select pg_temp.err('S10 go-live setter refused without readiness', $q$select public.admin_w_email_public_go_live_set('0000000a-0000-4000-8000-00000000a001', true, 'ci', 'ci-gl-1')$q$, 'wp8_public_go_live_requires_service_delivery_readiness');
select pg_temp.err('S10 insert with go-live true refused (trigger before conflict)', $q$insert into public.email_provider_config(id, public_go_live) values (1, true)$q$, 'wp8_public_go_live_requires_service_delivery_readiness');
select pg_temp.err('S10 provider config delete refused', $q$delete from public.email_provider_config where id = 1$q$, 'wp8_provider_config_delete_refused');
select pg_temp.mkuser('Q', null, false, null, clock_timestamp(), now());
update public.wp8_ci_readiness set ready = true where id = 1;
update public.email_provider_config set public_go_live = true where id = 1;
select pg_temp.ck('S10 direct go-live records public_go_live_since (>= transaction start)', (select public_go_live_since >= transaction_timestamp() and public_go_live_since <= clock_timestamp()
  from public.email_service_policy where id = 1));
select pg_temp.mkuser('R', null, false, null, clock_timestamp(), now());
select pg_temp.sweep_is('S10 after direct go-live: R (signed up after) enqueued, Q (before) not', pg_temp.open_res(5, 1, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}'));
select pg_temp.ck('S10 Q has no welcome (no backfill of pre-go-live signups)', pg_temp.nrows('Q') = 0 and pg_temp.nrows('R') = 1);
select set_config('wp8t.since1', (select public_go_live_since::text from public.email_service_policy where id = 1), false);
select pg_temp.err('S10 go-live since cannot move backwards', $q$update public.email_service_policy set public_go_live_since = public_go_live_since - interval '1 second' where id = 1$q$, 'wp8_go_live_since_cannot_move_backwards');
update public.wp8_ci_readiness set ready = false where id = 1;
select pg_temp.ck('S10 go-live setter disable always allowed', (public.admin_w_email_public_go_live_set('0000000a-0000-4000-8000-00000000a001', false, 'ci close', 'ci-gl-2')->>'public_go_live')::boolean = false);
select pg_temp.mkuser('S', null, false, null, clock_timestamp(), now());
update public.wp8_ci_readiness set ready = true where id = 1;
select pg_temp.ck('S10 go-live setter enable with readiness', (public.admin_w_email_public_go_live_set('0000000a-0000-4000-8000-00000000a001', true, 'ci reopen', 'ci-gl-3')->>'public_go_live')::boolean);
select pg_temp.ck('S10 reopen moved public_go_live_since forward', (select public_go_live_since > current_setting('wp8t.since1')::timestamptz from public.email_service_policy where id = 1));
select pg_temp.sweep_is('S10 after reopen: S (signed up while closed) not welcomed', pg_temp.open_res(4, 0, 0, 4, 0, 0, '{"suppressed_unsubscribe": 4}'));
select pg_temp.ck('S10 go-live audit rows (counts only, no e-mail)', (select count(*) = 2 and bool_and(position('@' in coalesce(after::text, '') || coalesce(before::text, '')) = 0)
  from public.admin_write_log where action = 'wp8_email_public_go_live_set'));
update public.email_provider_config set public_go_live = false where id = 1;
update public.wp8_ci_readiness set ready = false where id = 1;

-- ===== S11 unchanged surfaces
select pg_temp.ck('S11 marketing_config unchanged', (select md5(string_agg(row(m.*)::text, '|' order by m.id)) from public.marketing_config m) = current_setting('wp8t.mkt_md5'));
select pg_temp.ck('S11 fixture auth users unchanged by WP8', (select md5(string_agg(row(u.*)::text, '|' order by u.id)) from auth.users u where u.id::text like '0000000f-%') = current_setting('wp8t.auth_md5'));
select pg_temp.ck('S11 legacy outbox rows unchanged', (select md5(string_agg(row(o.*)::text, '|' order by o.idempotency_key)) from public.email_outbox o where o.idempotency_key like 'legacy-%')
  = (select current_setting('wp8t.legacy_md5')));
select pg_temp.ck('S11 legacy events unchanged', (select md5(string_agg(row(e.*)::text, '|' order by e.svix_id)) from public.email_send_events e where e.svix_id like 'svix-legacy-%') = current_setting('wp8t.events_md5'));
select pg_temp.ck('S11 _email_send_decision unchanged', (select md5(prosrc) from pg_proc where oid = 'public._email_send_decision(uuid,public.email_message_class,public.service_pref_key)'::regprocedure) = current_setting('wp8t.decision_md5'));
select pg_temp.ck('S11 ledger holds counts only', (select count(*) > 0 and bool_and(position('@' in reasons::text) = 0 and reasons::text !~ '[0-9a-f]{8}-[0-9a-f]{4}') from public.email_wp8_run_ledger));

-- ===== S12 race between the sweep decision and email_enqueue never persists a skipped row (amendment 5)
alter function public._email_send_decision(uuid, public.email_message_class, public.service_pref_key) rename to _email_send_decision_ci_orig;
create function public._email_send_decision(p_user_id uuid, p_message_class public.email_message_class, p_service_pref_key public.service_pref_key)
returns jsonb language plpgsql security definer set search_path = public, extensions, vault as $t$
declare v jsonb; n int;
begin
  v := public._email_send_decision_ci_orig(p_user_id, p_message_class, p_service_pref_key);
  if p_user_id is distinct from md5('wp8-ci-RACE')::uuid then return v; end if;
  n := coalesce(nullif(current_setting('wp8t.calls', true), ''), '0')::int + 1;
  perform set_config('wp8t.calls', n::text, true);
  if n = 2 and (v->>'allow')::boolean then
    return jsonb_build_object('allow', false, 'skip_reason', 'not_in_allowlist', 'recipient_hmac', v->>'recipient_hmac');
  end if;
  return v;
end
$t$;
select pg_temp.mkuser('RACE', null, true, null, clock_timestamp(), now());
select set_config('wp8t.calls', '0', false);
select pg_temp.sweep_is('S12 decision flips between pre-check and enqueue -> race counted, nothing written', pg_temp.open_res(5, 0, 0, 4, 1, 0, '{"suppressed_unsubscribe": 4, "race_not_in_allowlist": 1}'));
select pg_temp.ck('S12 no skipped row persisted for the raced user (key not burned)', pg_temp.nrows('RACE') = 0);
select pg_temp.ck('S12 still no wp8 row ever skipped by the sweep', (select count(*) from public.email_outbox where idempotency_key like 'wp8:%' and status = 'skipped' and skip_reason <> 'service_pref_disabled') = 0);
