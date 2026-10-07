-- =====================================================================
-- ASALOCAL · WP5 · gates/wp5_pre_assert.sql   (SALT-OKUNUR / READ-ONLY)
-- WP5_DB_up.sql UYGULANMADAN ÖNCE ve SEC_VIEWS hotfix'i (sec_public_views_readonly) UYGULANDIKTAN
-- SONRA production'da çalıştırılır (Supabase execute_sql).
-- Baseline'ı kaydeder (actual kolonu) ve 2026-10-07 read-only ölçümüyle karşılaştırır.
-- Yalnız SELECT; hiçbir şey yazmaz; e-posta/isim/kişisel veri SEÇMEZ (yalnız sayılar ve md5'ler).
-- Beklenen: tüm counted satırlar PASS (24) ve OVERALL = WP5_PRE_ASSERT_PASS.  Herhangi bir FAIL => STOP.
-- Satır 26-29 (SEC_VIEWS önkoşulu + pg_graphql yokluğu) 2026-10-07 production kanıtında YOKTUR
-- (evidence/ JSON'u SEC_VIEWS öncesi 20 satırlık sürümdür) -> SEC_VIEWS'tan sonra production'da
-- YENİDEN çalıştırılması zorunludur.
-- Aynı dosya PGlite fixture'ında da PASS vermek zorundadır (fixture sadakat kanıtı).
-- Geri alma (WP5_DB_down.sql) sonrası da PASS beklenir (satır 20 hariç: ledger satırı kalır).
-- =====================================================================
with fn as (
  select p.oid, p.proname::text as proname, md5(p.prosrc) as src_md5,
         p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '<null>') || '|' || p.proowner::regrole::text
           || '|' || coalesce(p.proacl::text, '<null>') || '|' || p.prorettype::regtype::text || '|'
           || (p.prolang = (select l.oid from pg_language l where l.lanname = 'plpgsql'))::text as attrs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('guard_member_admin_fields', 'member_upsert_profile', 'complete_profile', 'member_set_name')
),
chk(ord, check_name, expected, actual, counted) as (
  select 1, 'server_encoding (IS NFC NORMALIZED için UTF8)', 'UTF8', current_setting('server_encoding'), true
  union all
  select 2, 'members RLS enabled|forced', 'true|false',
         (select c.relrowsecurity::text || '|' || c.relforcerowsecurity::text from pg_class c where c.oid = 'public.members'::regclass), true
  union all
  select 3, 'members 11 baseline kolon imzası md5',
         'd9c4f34edd211326976abb53c40c559f',
         (select md5(string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '<null>'),
                                ',' order by ordinal_position))
            from information_schema.columns
           where table_schema = 'public' and table_name = 'members' and column_name not in ('first_name', 'last_name')), true
  union all
  select 4, 'first_name/last_name kolonu YOK (sayı)', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'members' and column_name in ('first_name', 'last_name')), true
  union all
  select 5, 'WP5 CHECK constraint YOK (sayı)', '0',
         (select count(*)::text from pg_constraint where conrelid = 'public.members'::regclass
             and conname in ('members_first_name_wp5_policy', 'members_last_name_wp5_policy')), true
  union all
  select 6, 'member_set_name YOK (overload sayısı)', '0',
         (select count(*)::text from fn where proname = 'member_set_name'), true
  union all
  select 7, 'guard_member_admin_fields md5(prosrc) = production baseline', '9bba990aa5a30cd94c93f7609babb7d2',
         coalesce((select src_md5 from fn where proname = 'guard_member_admin_fields'), '<absent>'), true
  union all
  select 8, 'guard_member_admin_fields md5(pg_get_functiondef) = production baseline', '48bd6e33c6becde922a033d6093a81b5',
         coalesce((select md5(pg_get_functiondef(oid)) from fn where proname = 'guard_member_admin_fields'), '<absent>'), true
  union all
  select 9, 'guard öznitelikleri (secdef|search_path|owner|acl|ret|plpgsql)',
         'true|search_path=public, pg_temp|postgres|{postgres=X/postgres,service_role=X/postgres}|trigger|true',
         coalesce((select attrs from fn where proname = 'guard_member_admin_fields'), '<absent>'), true
  union all
  select 10, 'member_upsert_profile md5(prosrc)|öznitelikler',
         'ef472f2ed6dd8398be7c3ed54007ec8a|false|search_path=public, pg_temp|postgres|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|jsonb|true',
         coalesce((select src_md5 || '|' || attrs from fn where proname = 'member_upsert_profile'), '<absent>'), true
  union all
  select 11, 'complete_profile md5(prosrc)|öznitelikler',
         '631b3b67ae91b914c377684724e65f59|true|search_path=public, pg_temp|postgres|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|jsonb|true',
         coalesce((select src_md5 || '|' || attrs from fn where proname = 'complete_profile'), '<absent>'), true
  union all
  select 12, 'members policy matrisi md5 (3 self policy)', '464d74a49a1cc84a16f0a1572cf7c22e',
         (select coalesce(md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                                         || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'), E'\n' order by policyname)), '<none>')
            from pg_policies where schemaname = 'public' and tablename = 'members'), true
  union all
  select 13, 'members trigger matrisi md5 (guard + ref + WSE seed)', '55b31b212c9588e1a8f15e185bd08bb6',
         (select coalesce(md5(string_agg(t.tgname || '|' || t.tgenabled::text || '|' || t.tgtype::text || '|' || pn.nspname || '.' || p.proname,
                                         E'\n' order by t.tgname)), '<none>')
            from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
           where t.tgrelid = 'public.members'::regclass and not t.tgisinternal), true
  union all
  select 14, 'members tablo ACL', '{postgres=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}',
         (select coalesce(relacl::text, '<null>') from pg_class where oid = 'public.members'::regclass), true
  union all
  select 15, 'anon members yetkisi | kolon ACL sayısı', 'false|0',
         has_table_privilege('anon', 'public.members', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')::text || '|'
         || (select count(*)::text from pg_attribute a where a.attrelid = 'public.members'::regclass and a.attacl is not null), true
  union all
  select 16, 'member_public kolonları', 'display_name,tier',
         (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = 'public.member_public'::regclass and a.attnum > 0), true
  union all
  select 17, 'comments_public kolonları', 'id,venue_id,city,display_name,body,photo_url,created_at',
         (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = 'public.comments_public'::regclass and a.attnum > 0), true
  union all
  select 18, 'view tanım md5 (comments_public, member_public)',
         'comments_public:8217b12d443b3470d9e7332a2a5e52db,member_public:c5240d36e89c7daeba5086ebcd31f710',
         (select string_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)), ',' order by c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname in ('member_public', 'comments_public')), true
  union all
  select 19, 'rol BYPASSRLS (anon,authenticated,service_role)', 'anon=f,authenticated=f,service_role=t',
         (select string_agg(rolname || '=' || case when rolbypassrls then 't' else 'f' end, ',' order by rolname)
            from pg_roles where rolname in ('anon', 'authenticated', 'service_role')), true
  union all
  select 20, 'ledger: wp5_member_private_name henüz uygulanmadı', '0',
         (select count(*)::text from supabase_migrations.schema_migrations where name = 'wp5_member_private_name'), true
  union all
  select 21, 'INFO guard e-posta kilidi içeriyor mu (WP5 öncesi: false = açık)', 'false',
         coalesce((select (p.prosrc ~ 'NEW\.email')::text from pg_proc p where p.oid = to_regprocedure('public.guard_member_admin_fields()')), '<absent>'), false
  union all
  select 22, 'INFO members satır sayısı (yalnız sayı)', '-',
         (select count(*)::text from public.members), false
  union all
  select 23, 'INFO yeni public fonksiyon varsayılan EXECUTE alanları (postgres defacl) — REVOKE gerekçesi', '-',
         coalesce((select string_agg(defaclacl::text, ' ') from pg_default_acl
                    where defaclnamespace = 'public'::regnamespace and defaclobjtype = 'f'
                      and defaclrole = 'postgres'::regrole), '<none>'), false
  union all
  select 24, 'INFO members rewrite bağımlıları (view:kolonlar)', '-',
         (select coalesce(string_agg(x, ' ; ' order by x), '<none>') from (
            select dv.relname || ':' || string_agg(distinct a.attname::text, ',') as x
              from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class dv on dv.oid = r.ev_class
              join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
             where d.refobjid = 'public.members'::regclass and d.classid = 'pg_rewrite'::regclass and dv.oid <> 'public.members'::regclass
             group by dv.relname) s), false
  union all
  select 25, 'INFO member_public otomatik-güncellenebilir maskesi | anon yazma yetkisi (SEC_VIEWS sonrası 28|false; zorlayan sayılan satırlar 26-28)', '-',
         pg_relation_is_updatable('public.member_public'::regclass, false)::text || '|'
         || has_table_privilege('anon', 'public.member_public', 'INSERT,UPDATE,DELETE')::text, false
  union all
  select 26, 'SEC_VIEWS önkoşulu: anon için yazılabilir view sayısı (member_public, comments_public, comment_reaction_counts; tablo INSERT/UPDATE/DELETE/TRUNCATE veya kolon INSERT/UPDATE; view yoksa da sayılır)', '0',
         (select count(*)::text from (values ('member_public'), ('comments_public'), ('comment_reaction_counts')) v(n)
           where to_regclass('public.' || v.n) is null
              or has_table_privilege('anon', to_regclass('public.' || v.n), 'INSERT,UPDATE,DELETE,TRUNCATE')
              or has_any_column_privilege('anon', to_regclass('public.' || v.n), 'INSERT,UPDATE')), true
  union all
  select 27, 'SEC_VIEWS önkoşulu: authenticated için yazılabilir view sayısı (aynı 3 view; tablo veya kolon düzeyi)', '0',
         (select count(*)::text from (values ('member_public'), ('comments_public'), ('comment_reaction_counts')) v(n)
           where to_regclass('public.' || v.n) is null
              or has_table_privilege('authenticated', to_regclass('public.' || v.n), 'INSERT,UPDATE,DELETE,TRUNCATE')
              or has_any_column_privilege('authenticated', to_regclass('public.' || v.n), 'INSERT,UPDATE')), true
  union all
  select 28, 'SEC_VIEWS önkoşulu: 3 view ACL = sec_public_views_readonly hedefi (anon/authenticated yalnız SELECT)',
         'comment_reaction_counts={postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres};comments_public={postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres};member_public={postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}',
         (select coalesce(string_agg(c.relname || '=' || coalesce(c.relacl::text, '<null>'), ';' order by c.relname), '<none>')
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname in ('member_public', 'comments_public', 'comment_reaction_counts')), true
  union all
  select 29, 'pg_graphql eklentisi kurulu DEĞİL (guard asalocal.trusted transaction-local güven bayrağı varsayımı)', '0',
         (select count(*)::text from pg_extension where extname = 'pg_graphql'), true
)
select ord, check_name, expected, actual,
       case when not counted then 'INFO' when expected = actual then 'PASS' else 'FAIL' end as result
  from chk
union all
select 99, 'OVERALL', 'all counted rows PASS',
       (select count(*) filter (where counted and expected is distinct from actual) || ' FAIL / ' || count(*) filter (where counted) || ' counted' from chk),
       case when (select bool_and(expected is not distinct from actual) filter (where counted) from chk)
            then 'WP5_PRE_ASSERT_PASS' else 'WP5_PRE_ASSERT_FAIL' end
order by ord;
