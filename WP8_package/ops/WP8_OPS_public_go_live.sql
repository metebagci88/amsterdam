-- WP8 PUBLIC GO-LIVE (later, separate; owner + legal). NOT needed for WP8 PASS (allowlist phase).
-- Preconditions outside the database (owner confirms before arming):
--   P-1 the /preferences opt-out link of the v3.2 template opens the e-mail preferences dialog;
--   P-2 the support mailbox in the template receives mail (WP7);
--   KVKK text bound to the controller and the service-delivery readiness attestations recorded.
-- Database preconditions are enforced by admin_w_email_public_go_live_set and by the go-live guard
-- trigger (readiness ready, caps >= 1, template pinned, service_enabled). The trigger records
-- public_go_live_since = now, so only users who sign up after this instant become eligible
-- without an allowlist row (no backfill).
-- Arm: replace both placeholders in the approved copy (YES and the super_admin actor uuid).
select set_config('wp8.allow_go_live', '@@ARM_YES@@', true);
select set_config('wp8.actor', '@@SUPER_ADMIN_UUID@@', true);
do $wp8_go_live$
declare v jsonb;
begin
  if current_setting('wp8.allow_go_live', true) is distinct from 'YES' then
    raise exception 'wp8_go_live_refused_without_explicit_arm';
  end if;
  v := public.admin_w_email_public_go_live_set(current_setting('wp8.actor')::uuid, true, 'wp8 public go-live', 'wp8-public-go-live');
  raise notice 'WP8_PUBLIC_GO_LIVE_OK %', v;
end
$wp8_go_live$;
