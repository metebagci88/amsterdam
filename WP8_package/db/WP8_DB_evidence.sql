-- WP8 acceptance evidence. ONE read-only SELECT (execute_sql). Labels and counts only:
-- no addresses, no names, no bodies, no user ids. QA users are found by their allowlist note
-- (wp8-qa-A / wp8-qa-B / wp8-qa-C, written by WP8_DB_owner_setup.sql step "allowlist").
-- Scoped to the CURRENT acceptance run: everything since the current boundary
-- (welcome_enqueue_from). After a hard kill and a new enable the boundary moves forward, so an
-- earlier run's QA rows, ledger rows and kick responses are reported as history, not re-judged.
-- "stop": true means STOP (PRD 2.2): sweep errors or kick HTTP != 200 in this run, a duplicate
-- welcome (any run), backfill (a wp8 row for a user who signed up before the boundary in effect
-- when the row was created, any run), a welcome for QA-C (pref OFF), or a skipped/failed wp8 row
-- of this run.
-- Without pg_net (today, and for good on the D2 GitHub Actions fallback) the kick_http_* fields
-- are JSON null and the kick evidence is the fallback workflow's run log; every other STOP rule is
-- still evaluated (kick_http_not_200 only reads a JSON object, never a null or other scalar).
with pol as (
  select p.*, greatest(now() - interval '24 hours', p.welcome_enqueue_from) as win_from
    from public.email_service_policy p where p.id = 1
), qa as (
  select a.note as label, a.user_id, a.active,
         (select u.created_at >= (select welcome_enqueue_from from pol) from auth.users u where u.id = a.user_id) as signed_up_after_boundary,
         (select c.enabled from public.member_service_pref_current c where c.user_id = a.user_id and c.pref_key = 'welcome_service_email') as pref
    from public.email_send_allowlist a
   where a.note in ('wp8-qa-A', 'wp8-qa-B', 'wp8-qa-C') and a.added_at >= (select welcome_enqueue_from from pol)
), wp8_rows as (
  select o.*, (o.created_at >= (select welcome_enqueue_from from pol)) as this_run,
         greatest(case when o.created_at >= (select welcome_enqueue_from from pol) then (select welcome_enqueue_from from pol) end,
                  (select max((l.after->>'enqueue_from')::timestamptz) from public.admin_write_log l
                    where l.action = 'wp8_welcome_automation_set' and l.at <= o.created_at)) as boundary_at_enqueue
    from public.email_outbox o where o.idempotency_key like 'wp8:%'
), qa_rows as (
  select q.label, o.*
    from qa q join public.email_outbox o on o.user_id = q.user_id and o.service_pref_key = 'welcome_service_email'
), per_label as (
  select q.label, jsonb_build_object(
    'allowlist_active', q.active,
    'signed_up_after_boundary', q.signed_up_after_boundary,
    'pref_enabled', q.pref,
    'welcome_rows', (select count(*) from qa_rows r where r.label = q.label),
    'statuses', (select coalesce(jsonb_object_agg(s, n), '{}'::jsonb) from (select r.status::text s, count(*) n from qa_rows r where r.label = q.label group by 1) x),
    'key_ok', (select bool_and(r.idempotency_key = 'wp8:welcome_service_email:v1:' || r.user_id::text) from qa_rows r where r.label = q.label),
    'template_v32', (select bool_and(r.service_template_id = (select welcome_template_id from pol)) from qa_rows r where r.label = q.label),
    'html_greeting_escaped_oneil', (select bool_or(position('Merhaba O&#39;Neil,' in coalesce(r.body_html, '')) > 0) from qa_rows r where r.label = q.label),
    'text_greeting_oneil', (select bool_or(position('Merhaba O''Neil,' in coalesce(r.body_text, '')) > 0) from qa_rows r where r.label = q.label),
    'html_greeting_neutral', (select bool_or(position('Merhaba,' in coalesce(r.body_html, '')) > 0 and position('Merhaba,' in coalesce(r.body_text, '')) > 0) from qa_rows r where r.label = q.label),
    'content_purged', (select bool_or(r.content_purged_at is not null) from qa_rows r where r.label = q.label),
    'attempts_max', (select max(r.attempts) from qa_rows r where r.label = q.label),
    'provider_id_set', (select bool_and(r.provider_message_id is not null) from qa_rows r where r.label = q.label and r.status in ('sent', 'delivered')),
    'events', (select coalesce(jsonb_object_agg(t, n), '{}'::jsonb) from (
        select e.event_type t, count(*) n from public.email_send_events e
         left join public.email_send_event_links l on l.event_id = e.id
         where coalesce(e.outbox_id, l.outbox_id) in (select r.id from qa_rows r where r.label = q.label) group by 1) x),
    'late_links', (select count(*) from public.email_send_event_links l where l.outbox_id in (select r.id from qa_rows r where r.label = q.label))
  ) as v from qa q
), glob as (
  select jsonb_build_object(
    'policy', (select jsonb_build_object('auto', welcome_auto_enqueue_enabled, 'boundary_set', welcome_enqueue_from is not null, 'paused', service_dispatch_paused,
        'daily_cap', service_daily_cap, 'monthly_cap', service_monthly_cap, 'delay_min', welcome_delay_minutes, 'max_age_h', welcome_max_age_hours,
        'public_go_live_since_set', public_go_live_since is not null) from pol),
    'flags', (select jsonb_build_object('essential', essential_enabled, 'service', service_enabled, 'public_go_live', public_go_live) from public.email_provider_config where id = 1),
    'allowlist_active', (select count(*) from public.email_send_allowlist where active),
    'wp8_rows_by_status', (select coalesce(jsonb_object_agg(s, n), '{}'::jsonb) from (select status::text s, count(*) n from wp8_rows group by 1) x),
    'wp8_rows_total', (select count(*) from wp8_rows),
    'this_run', jsonb_build_object(
        'wp8_rows', (select count(*) from wp8_rows where this_run),
        'wp8_rows_by_status', (select coalesce(jsonb_object_agg(s, n), '{}'::jsonb) from (select status::text s, count(*) n from wp8_rows where this_run group by 1) x),
        'qa_labels', (select count(*) from qa),
        'earlier_qa_rows', (select count(*) from public.email_send_allowlist a where a.note in ('wp8-qa-A', 'wp8-qa-B', 'wp8-qa-C')
                              and (a.added_at >= (select welcome_enqueue_from from pol)) is not true),
        'ledger', (select jsonb_build_object('runs', count(*), 'enqueued', coalesce(sum(enqueued), 0), 'errors', coalesce(sum(errors), 0))
                     from public.email_wp8_run_ledger where ran_at >= (select welcome_enqueue_from from pol))),
    'legacy_rows', (select count(*) from public.email_outbox where created_at < timestamptz '2026-10-01 00:00:00+00'),
    'sent_24h_all_classes', (select count(*) from public.email_outbox where sent_at > now() - interval '24 hours'),
    'ledger_24h', (select jsonb_build_object('runs', count(*), 'enqueued', coalesce(sum(enqueued), 0), 'not_eligible', coalesce(sum(not_eligible), 0),
        'race', coalesce(sum(race), 0), 'errors', coalesce(sum(errors), 0), 'expired', coalesce(sum(expired), 0), 'reconciled', coalesce(sum(reconciled), 0),
        'last_run_age_s', extract(epoch from now() - max(ran_at))::int) from public.email_wp8_run_ledger where ran_at > now() - interval '24 hours'),
    'pg_cron_present', to_regclass('cron.job') is not null,
    'pg_net_present', to_regclass('net._http_response') is not null,
    'cron_jobs', case when to_regclass('cron.job') is null then null else
        (xpath('/row/c/text()', query_to_xml('select count(*) as c from cron.job where jobname like ''wp8-%'' and active', false, true, '')))[1]::text::int end,
    'kick_http_24h', case when to_regclass('net._http_response') is null then null else
        (xpath('/row/c/text()', query_to_xml('select coalesce(json_object_agg(coalesce(status_code::text, ''error''), n), ''{}'') as c from (select status_code, count(*) n from net._http_response where created > now() - interval ''24 hours'' group by 1) x', false, true, '')))[1]::text::jsonb end,
    'kick_http_this_run_24h', case when to_regclass('net._http_response') is null then null else
        (xpath('/row/c/text()', query_to_xml(format('select coalesce(json_object_agg(coalesce(status_code::text, %L), n), %L) as c from (select status_code, count(*) n from net._http_response where created > %L::timestamptz group by 1) x',
                                                    'error', '{}', (select win_from from pol)), false, true, '')))[1]::text::jsonb end
  ) as v
), kick as (
  select case when jsonb_typeof(v->'kick_http_this_run_24h') = 'object' then v->'kick_http_this_run_24h' else '{}'::jsonb end as codes from glob
), stops as (
  select array_remove(array[
    case when (select coalesce(sum(errors), 0) from public.email_wp8_run_ledger where ran_at > (select win_from from pol)) > 0 then 'sweep_errors' end,
    case when exists (select 1 from jsonb_object_keys((select codes from kick)) k where k <> '200') then 'kick_http_not_200' end,
    case when exists (select 1 from public.email_outbox where service_pref_key = 'welcome_service_email' and created_at >= timestamptz '2026-10-01 00:00:00+00'
                      group by user_id having count(*) > 1) then 'duplicate_welcome' end,
    case when exists (select 1 from wp8_rows o join auth.users u on u.id = o.user_id
                      where u.created_at < coalesce(o.boundary_at_enqueue, (select welcome_enqueue_from from pol))) then 'backfill' end,
    case when exists (select 1 from qa_rows r where r.label = 'wp8-qa-C') then 'qa_c_pref_off_but_welcomed' end,
    case when exists (select 1 from wp8_rows where this_run and status = 'skipped' and skip_reason <> 'service_pref_disabled') then 'sweep_skipped_row' end,
    case when exists (select 1 from wp8_rows where this_run and status = 'failed') then 'wp8_failed_row' end
  ], null) as reasons
)
select jsonb_build_object(
  'stop', cardinality((select reasons from stops)) > 0,
  'stop_reasons', to_jsonb((select reasons from stops)),
  'qa', (select coalesce(jsonb_object_agg(label, v), '{}'::jsonb) from per_label),
  'global', (select v from glob)) as wp8_evidence;
