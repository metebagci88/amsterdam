-- WP8 zero-footprint probe (optional, execute_sql, same approval window as the POST assert).
-- ONE DO block that ALWAYS ends with RAISE EXCEPTION, so every change it makes is rolled back
-- in any execution mode (autocommit, explicit transaction, or a lost BEGIN/ROLLBACK frame).
-- Inside it opens the gates by direct UPDATE (caps, automation, boundary, service_enabled),
-- runs the sweep (expected gate open, 0 candidates: allowlist empty), one claim (expected 0)
-- and tries public_go_live=true (expected refusal: readiness not ready).
-- Expected error text: WP8_ZF_DONE:{"pass": true, ...}. Any other error is a STOP.
do $wp8_zf$
declare
  v_sweep jsonb; v_claim int; v_gl text := 'not_refused'; v_pass boolean;
begin
  if to_regprocedure('public.welcome_enqueue_sweep(int)') is null then
    raise exception 'WP8_ZF_FAIL:wp8_not_installed';
  end if;
  update public.email_service_policy set service_daily_cap = 40, service_monthly_cap = 1200 where id = 1;
  update public.email_service_policy set welcome_auto_enqueue_enabled = true, welcome_enqueue_from = clock_timestamp() where id = 1;
  update public.email_provider_config set service_enabled = true where id = 1;
  v_sweep := public.welcome_enqueue_sweep();
  select count(*) into v_claim from public.email_claim_batch(1);
  begin
    update public.email_provider_config set public_go_live = true where id = 1;
  exception when others then
    v_gl := case when sqlerrm like '%wp8_public_go_live_requires_service_delivery_readiness%' then 'refused' else 'error_' || sqlstate end;
  end;
  v_pass := v_sweep->>'gate' = 'open' and (v_sweep->>'candidates')::int = 0 and (v_sweep->>'errors')::int = 0
            and v_claim = 0 and v_gl = 'refused';
  raise exception 'WP8_ZF_DONE:%', jsonb_build_object('pass', v_pass, 'sweep', v_sweep, 'claimed', v_claim, 'go_live', v_gl);
end
$wp8_zf$;
