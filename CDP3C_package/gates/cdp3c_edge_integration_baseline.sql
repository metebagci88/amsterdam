-- =====================================================================
-- ASALOCAL · CDP-3C · EDGE ENTEGRASYON CI-ONLY doubles — PRODUCTION'A UYGULANMAZ
-- cdp3c_baseline.sql'in ÜSTÜNE uygulanır. Amaç: gerçek birleşik Edge handler'larının
-- (email-api + admin-api) çağırdığı CDP-2B admin-gateway yardımcılarının ve bir email-admin
-- RPC'sinin MİNİMAL doubles'ı — böylece 401/403 yolları GERÇEKTEN tetiklenir.
-- Production'da bunların GERÇEK tanımları vardır; bu dosya asla prod'a -f edilmez.
-- =====================================================================
\set ON_ERROR_STOP on

-- admin-api: getUser sonrası userClient ile çağrılır (auth.uid()).
create or replace function public.is_current_user_admin() returns boolean
  language sql stable security definer set search_path=public as $fn$
  select exists(select 1 from public.admin_users where user_id=auth.uid() and active);
$fn$;
create or replace function public.current_user_has_admin_role(role_name text) returns boolean
  language sql stable security definer set search_path=public as $fn$
  select exists(select 1 from public.admin_roles where user_id=auth.uid() and role::text=role_name);
$fn$;
revoke all on function public.is_current_user_admin() from public, anon;
grant execute on function public.is_current_user_admin() to authenticated, service_role;
revoke all on function public.current_user_has_admin_role(text) from public, anon;
grant execute on function public.current_user_has_admin_role(text) to authenticated, service_role;

-- admin-api: svc(service_role) ile çağrılır. Kill-switch/rate-limit CI'da AÇIK varsayılır.
create or replace function public.admin_api_status() returns boolean language sql stable as $fn$ select true $fn$;
create or replace function public.admin_writes_status() returns boolean language sql stable as $fn$ select true $fn$;
create or replace function public.admin_rate_check(p_actor uuid, p_action text, p_max_min int, p_max_day int)
  returns boolean language sql stable as $fn$ select true $fn$;
grant execute on function public.admin_api_status() to service_role;
grant execute on function public.admin_writes_status() to service_role;
grant execute on function public.admin_rate_check(uuid,text,int,int) to service_role;

-- email-api: 'list' action -> admin_q_email_template_list(p_actor). Admin değilse 'forbidden' (403 kanıtı için).
create or replace function public.admin_q_email_template_list(p_actor uuid) returns jsonb
  language plpgsql stable security definer set search_path=public as $fn$
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then
    raise exception 'forbidden';
  end if;
  return '[]'::jsonb;
end $fn$;
revoke all on function public.admin_q_email_template_list(uuid) from public, anon, authenticated;
grant execute on function public.admin_q_email_template_list(uuid) to service_role;
