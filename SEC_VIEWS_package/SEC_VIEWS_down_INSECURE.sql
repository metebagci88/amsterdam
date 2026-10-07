-- =====================================================================
-- SEC-VIEWS · SEC_VIEWS_down_INSECURE.sql   — UYARI: GÜVENLİK AÇIĞINI GERİ AÇAR
-- Yalnız site sahibinin açık kararıyla ve SELECT dışı yetkiye ihtiyaç duyan bir istemci bulunursa.
-- Kurulmadan (armed) çalışmaz: önce aynı transaction'da
--   select set_config('sec_views.rollback_armed', 'YES-REOPEN-HOLE', true);
-- Ardından baseline ACL'i birebir geri yükler ve doğrular. Atomik çalıştırın (psql -1 / tek transaction).
-- =====================================================================
do $sv_down_arm$
begin
  if coalesce(current_setting('sec_views.rollback_armed', true), '') <> 'YES-REOPEN-HOLE' then
    raise exception 'SEC_VIEWS_DOWN_NOT_ARMED: hiçbir şey değişmedi';
  end if;
end
$sv_down_arm$;

grant insert, update, delete, truncate, references, trigger, maintain
  on table public.member_public, public.comments_public, public.comment_reaction_counts
  to anon, authenticated;

do $sv_down_post$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname in ('member_public', 'comments_public', 'comment_reaction_counts')
                and c.relacl::text is distinct from '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}') then
    raise exception 'SEC_VIEWS_DOWN_POST_FAIL: baseline ACL geri yüklenemedi';
  end if;
  raise notice 'SEC_VIEWS_DOWN_OK (baseline restored — hole is OPEN again)';
end
$sv_down_post$;
