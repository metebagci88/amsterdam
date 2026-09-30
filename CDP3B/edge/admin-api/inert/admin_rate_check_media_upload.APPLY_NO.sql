-- APPLY=NO
-- STORAGE_MEDIA_UPLOAD_EDGE · repo-only artifact. Do not apply to production.
--
-- One-token allowlist addition for public.admin_rate_check.
-- CREATE OR REPLACE only. This file does not DROP the function.
-- It does not DROP or CREATE storage policies. It does not change media.public.
-- It does not add q_member_consent or marketing_readiness_check.
-- Those two names stay absent on purpose (pre-existing Edge/SQL gap, out of scope).
--
-- Body matches the live function read on 2026-09-30 except the added token
-- 'media_upload' after 'member_360_by_ref'. Grants are left as they are:
-- CREATE OR REPLACE keeps existing EXECUTE grants when the signature is unchanged.
--
-- Limits enforced by the Edge handler, not by this function:
--   media_upload min=10 day=100
-- The action is also in WRITE_ACTIONS, so admin_writes_status still applies.

create or replace function public.admin_rate_check(p_actor uuid, p_action text, p_max_min integer, p_max_day integer)
returns boolean
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_min int; v_day int;
begin
  if p_action not in ('counts','member_search','member_360','comment_search','comment_set_hidden','member_set_blocked',
                      'adjust_points','content_rollback','audit_search','audit_detail','content_versions',
                      'cities_overview','city_health','member_set_note','member_set_segment',
                      'segment_preview','segment_list','segment_upsert','segment_run','segment_duplicate','segment_set_active','events_list',
                      'segment_taxonomy','segment_member_search','member_360_by_ref','media_upload') then
    raise exception 'bad action' using errcode='22023'; end if;
  if p_max_min is null or p_max_day is null or p_max_min < 1 or p_max_min > 100000 or p_max_day < 1 or p_max_day > 1000000 then
    raise exception 'bad limit' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtext('asalocal:rate:'||p_actor::text||':'||p_action));
  select count(*) into v_min from public.admin_rate_events where actor=p_actor and action=p_action and at > now() - interval '60 seconds';
  if v_min >= p_max_min then return false; end if;
  select count(*) into v_day from public.admin_rate_events where actor=p_actor and action=p_action and at > now() - interval '1 day';
  if v_day >= p_max_day then return false; end if;
  insert into public.admin_rate_events(actor, action) values (p_actor, p_action);
  return true;
end $function$;
