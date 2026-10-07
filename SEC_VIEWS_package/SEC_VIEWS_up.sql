-- =====================================================================
-- ASALOCAL · SEC-VIEWS HOTFIX · SEC_VIEWS_up.sql
-- Migration adı (Supabase apply_migration): sec_public_views_readonly
--
-- SORUN (production'da 2026-10-07 read-only katalog ile doğrulandı; İP5 DB incelemesinde bulundu)
--   public.member_public  = SELECT display_name, tier FROM members WHERE blocked = false
--     * otomatik güncellenebilir view (pg_relation_is_updatable = 28 -> INSERT+UPDATE+DELETE)
--     * security_invoker=false, sahip postgres (tablo sahibi, BYPASSRLS) -> members RLS UYGULANMAZ
--     * anon ve authenticated: arwdDxtm (INSERT/UPDATE/DELETE/TRUNCATE/... dahil)
--     * members_admin_guard trigger'ı yalnız BEFORE INSERT/UPDATE (tgtype 23); DELETE'i görmez
--   => public anon anahtarına sahip herkes PostgREST üzerinden
--      DELETE /rest/v1/member_public?<filtre>  ile members satırlarını silebilir;
--      her giriş yapmış kullanıcı başka üyelerin display_name'ini değiştirebilir.
--   comments_public ve comment_reaction_counts güncellenemez (bits=0) ama aynı geniş yetkileri taşır.
--
-- NE YAPAR (yalnız SIKILAŞTIRIR)
--   Üç public view'da anon ve authenticated için SELECT dışındaki tüm yetkileri geri alır:
--     REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ... FROM anon, authenticated
--   SELECT korunur (frontend yalnız okur: comments_public, comment_reaction_counts). service_role ve
--   postgres yetkileri, view tanımları, reloptions, tablolar, policy'ler, fonksiyonlar DEĞİŞMEZ.
--
-- ÇALIŞTIRMA: apply_migration(name => 'sec_public_views_readonly', query => <bu dosya>)  (atomik)
--   Gövdede dış BEGIN/COMMIT yok; yıkıcı DDL anahtar kelimesi YOK (gates/sec_views_token_scan.sh).
-- GÜVENCELER
--   PRE guard : 3 view'ın tanım md5'i, sahibi, reloptions'ı ve ACL'i baseline'a YA DA hedef duruma
--               birebir eşit değilse hiçbir şey değiştirmeden durur.
--   POST guard: ACL hedefe birebir eşit değilse RAISE -> transaction geri alınır.
--   İdempotent: ikinci çalıştırma aynı son durumu üretir.
-- GERİ ALMA: SEC_VIEWS_down_INSECURE.sql (açığı GERİ AÇAR; yalnız açık sahip kararıyla, armed GUC ile)
-- =====================================================================

set local lock_timeout = '5s';

do $sv_pre$
declare
  c_base   constant text := '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}';
  c_target constant text := '{postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}';
  r record;
  v_n int := 0;
begin
  for r in
    select v.name, v.def_md5, c.oid, c.relkind, pg_get_userbyid(c.relowner) as owner,
           array_to_string(c.reloptions, ',') as opts, c.relacl::text as acl,
           md5(pg_get_viewdef(c.oid, true)) as cur_md5
      from (values ('member_public',           'bfb056b40e300dbb32edb4606f348ad2'),
                   ('comments_public',         '1d109aaeddd96e0ad746fb7a177d5da1'),
                   ('comment_reaction_counts', '240f9780784dbce197e977c3279ec4f6')) v(name, def_md5)
      left join pg_class c on c.oid = to_regclass('public.' || v.name)
  loop
    if r.oid is null or r.relkind <> 'v' then
      raise exception 'SEC_VIEWS_PRE_FAIL: public.% yok veya view değil', r.name;
    end if;
    if r.cur_md5 is distinct from r.def_md5 then
      raise exception 'SEC_VIEWS_PRE_DRIFT: public.% tanımı beklenen değil (md5=%)', r.name, r.cur_md5;
    end if;
    if r.owner <> 'postgres' or r.opts is distinct from 'security_invoker=false,security_barrier=true' then
      raise exception 'SEC_VIEWS_PRE_DRIFT: public.% sahip/opsiyon beklenen değil (%/%)', r.name, r.owner, r.opts;
    end if;
    if r.acl is distinct from c_base and r.acl is distinct from c_target then
      raise exception 'SEC_VIEWS_PRE_DRIFT: public.% ACL beklenen değil (%)', r.name, r.acl;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> 3 then
    raise exception 'SEC_VIEWS_PRE_FAIL: 3 view bekleniyordu, % bulundu', v_n;
  end if;
  raise notice 'SEC_VIEWS_PRE_OK';
end
$sv_pre$;

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.member_public, public.comments_public, public.comment_reaction_counts
  from anon, authenticated;

comment on view public.member_public is
  'Public read-only projection (display_name, tier) of non-blocked members. SEC-VIEWS 2026-10-07: anon/authenticated SELECT only (owner-rights view would bypass members RLS for writes).';
comment on view public.comments_public is
  'Public read-only projection of visible comments. SEC-VIEWS 2026-10-07: anon/authenticated SELECT only.';
comment on view public.comment_reaction_counts is
  'Public read-only reaction counts. SEC-VIEWS 2026-10-07: anon/authenticated SELECT only.';

do $sv_post$
declare
  c_target constant text := '{postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}';
  v_bad text;
begin
  select string_agg(c.relname || '=' || coalesce(c.relacl::text, '<null>'), '; ')
    into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('member_public', 'comments_public', 'comment_reaction_counts')
     and c.relacl::text is distinct from c_target;
  if v_bad is not null then
    raise exception 'SEC_VIEWS_POST_FAIL: ACL hedef değil: %', v_bad;
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('v', 'm')
                and (has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                  or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'))) then
    raise exception 'SEC_VIEWS_POST_FAIL: public şemada anon/authenticated için yazılabilir view kaldı';
  end if;
  if not (has_table_privilege('anon', 'public.comments_public', 'SELECT')
      and has_table_privilege('anon', 'public.comment_reaction_counts', 'SELECT')
      and has_table_privilege('anon', 'public.member_public', 'SELECT')
      and has_table_privilege('authenticated', 'public.comments_public', 'SELECT')
      and has_table_privilege('authenticated', 'public.comment_reaction_counts', 'SELECT')
      and has_table_privilege('authenticated', 'public.member_public', 'SELECT')) then
    raise exception 'SEC_VIEWS_POST_FAIL: SELECT yetkisi kayboldu';
  end if;
  raise notice 'SEC_VIEWS_POST_OK';
end
$sv_post$;
