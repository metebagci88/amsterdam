-- =====================================================================
-- ASALOCAL · WP5 · gates/wp5_prod_assert.sql   (SALT-OKUNUR / READ-ONLY)
-- WP5_DB_up.sql UYGULANDIKTAN SONRA production'da çalıştırılır (Supabase execute_sql).
-- Yalnız SELECT; hiçbir şey yazmaz; e-posta/isim SEÇMEZ (yalnız sayılar ve md5'ler).
-- Beklenen: tüm counted satırlar PASS (27) ve OVERALL = WP5_PROD_ASSERT_PASS.  FAIL => STOP + rollback kararı.
-- Satır 26-29: SEC_VIEWS önkoşulu (3 public view anon/authenticated için salt-okunur) ve pg_graphql
-- yokluğu WP5 sonrasında da geçerli olmalıdır (profil yazımı yalnız sahibine; guard güven varsayımı).
-- Satır 22 (zero-footprint kalıntısı) wp5_zero_footprint_test.sql sonrası da 0 olmalıdır.
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
  select 1, 'members RLS enabled|forced', 'true|false',
         (select c.relrowsecurity::text || '|' || c.relforcerowsecurity::text from pg_class c where c.oid = 'public.members'::regclass), true
  union all
  select 2, 'members 11 baseline kolon imzası md5 (değişmedi)', 'd9c4f34edd211326976abb53c40c559f',
         (select md5(string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '<null>'),
                                ',' order by ordinal_position))
            from information_schema.columns
           where table_schema = 'public' and table_name = 'members' and column_name not in ('first_name', 'last_name')), true
  union all
  select 3, 'isim kolonları (text, NULL, varsayılansız)', 'first_name:text:YES:<null>,last_name:text:YES:<null>',
         (select coalesce(string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '<null>'),
                                     ',' order by column_name), '<none>')
            from information_schema.columns
           where table_schema = 'public' and table_name = 'members' and column_name in ('first_name', 'last_name')), true
  union all
  select 4, 'WP5 CHECK constraint tanım md5 + doğrulanmış',
         'members_first_name_wp5_policy:7614490ed320884bf7d453bbcb61ccd8:true,members_last_name_wp5_policy:afdc557b2b144a07adf050176fc3468b:true',
         (select coalesce(string_agg(conname || ':' || md5(pg_get_constraintdef(oid)) || ':' || convalidated::text, ',' order by conname), '<none>')
            from pg_constraint where conrelid = 'public.members'::regclass and contype = 'c'
             and conname in ('members_first_name_wp5_policy', 'members_last_name_wp5_policy')), true
  union all
  select 5, 'guard_member_admin_fields md5(prosrc) = WP5', 'ef160b239cd9dc207a7f78313b0a3242',
         coalesce((select src_md5 from fn where proname = 'guard_member_admin_fields'), '<absent>'), true
  union all
  select 6, 'guard öznitelikleri değişmedi', 'true|search_path=public, pg_temp|postgres|{postgres=X/postgres,service_role=X/postgres}|trigger|true',
         coalesce((select attrs from fn where proname = 'guard_member_admin_fields'), '<absent>'), true
  union all
  select 7, 'member_set_name md5|INVOKER|search_path|owner|ACL|jsonb|plpgsql',
         '993b6a358e3ed58f478af75853d4e7fe|false|search_path=pg_catalog, pg_temp|postgres|{postgres=X/postgres,authenticated=X/postgres}|jsonb|true',
         coalesce((select src_md5 || '|' || attrs from fn where proname = 'member_set_name'), '<absent>'), true
  union all
  select 8, 'member_set_name tek overload (p_first text, p_last text)', '1|p_first text, p_last text',
         (select count(*)::text || '|' || coalesce(min(pg_get_function_identity_arguments(oid)), '<none>') from fn where proname = 'member_set_name'), true
  union all
  select 9, 'EXECUTE member_set_name anon|authenticated', 'false|true',
         coalesce((select has_function_privilege('anon', oid, 'EXECUTE')::text || '|' || has_function_privilege('authenticated', oid, 'EXECUTE')::text
                     from fn where proname = 'member_set_name'), '<absent>'), true
  union all
  select 10, 'member_upsert_profile değişmedi', 'ef472f2ed6dd8398be7c3ed54007ec8a|false|search_path=public, pg_temp|postgres|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|jsonb|true',
         coalesce((select src_md5 || '|' || attrs from fn where proname = 'member_upsert_profile'), '<absent>'), true
  union all
  select 11, 'complete_profile değişmedi', '631b3b67ae91b914c377684724e65f59|true|search_path=public, pg_temp|postgres|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|jsonb|true',
         coalesce((select src_md5 || '|' || attrs from fn where proname = 'complete_profile'), '<absent>'), true
  union all
  select 12, 'members policy matrisi değişmedi', '464d74a49a1cc84a16f0a1572cf7c22e',
         (select coalesce(md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                                         || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'), E'\n' order by policyname)), '<none>')
            from pg_policies where schemaname = 'public' and tablename = 'members'), true
  union all
  select 13, 'members trigger matrisi değişmedi', '55b31b212c9588e1a8f15e185bd08bb6',
         (select coalesce(md5(string_agg(t.tgname || '|' || t.tgenabled::text || '|' || t.tgtype::text || '|' || pn.nspname || '.' || p.proname,
                                         E'\n' order by t.tgname)), '<none>')
            from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
           where t.tgrelid = 'public.members'::regclass and not t.tgisinternal), true
  union all
  select 14, 'members tablo ACL değişmedi', '{postgres=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}',
         (select coalesce(relacl::text, '<null>') from pg_class where oid = 'public.members'::regclass), true
  union all
  select 15, 'anon members yetkisi | kolon ACL sayısı', 'false|0',
         has_table_privilege('anon', 'public.members', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')::text || '|'
         || (select count(*)::text from pg_attribute a where a.attrelid = 'public.members'::regclass and a.attacl is not null), true
  union all
  select 16, 'member_public kolonları (isim YOK)', 'display_name,tier',
         (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = 'public.member_public'::regclass and a.attnum > 0), true
  union all
  select 17, 'comments_public kolonları (isim YOK)', 'id,venue_id,city,display_name,body,photo_url,created_at',
         (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = 'public.comments_public'::regclass and a.attnum > 0), true
  union all
  select 18, 'view tanım md5 değişmedi', 'comments_public:8217b12d443b3470d9e7332a2a5e52db,member_public:c5240d36e89c7daeba5086ebcd31f710',
         (select string_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)), ',' order by c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname in ('member_public', 'comments_public')), true
  union all
  select 19, 'hiçbir view/kural first_name/last_name kolonuna bağlı değil', '0',
         (select count(*)::text from pg_depend d join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
           where d.refobjid = 'public.members'::regclass and d.classid = 'pg_rewrite'::regclass
             and a.attname in ('first_name', 'last_name')), true
  union all
  select 20, 'kolon açıklamaları WP5 PRIVATE', 'true|true',
         (coalesce(col_description('public.members'::regclass, (select attnum from pg_attribute where attrelid = 'public.members'::regclass and attname = 'first_name')), '') like 'WP5: PRIVATE%')::text
         || '|' ||
         (coalesce(col_description('public.members'::regclass, (select attnum from pg_attribute where attrelid = 'public.members'::regclass and attname = 'last_name')), '') like 'WP5: PRIVATE%')::text, true
  union all
  select 21, 'ledger: wp5_member_private_name uygulandı', '1',
         (select count(*)::text from supabase_migrations.schema_migrations where name = 'wp5_member_private_name'), true
  union all
  select 22, 'zero-footprint kalıntısı (auth.users + members, zz-wp5-zf- öneki; yalnız sayı)', '0|0',
         (select count(*)::text from auth.users where email like 'zz-wp5-zf-%') || '|'
         || (select count(*)::text from public.members where email like 'zz-wp5-zf-%'), true
  union all
  select 23, 'rol BYPASSRLS (anon,authenticated,service_role)', 'anon=f,authenticated=f,service_role=t',
         (select string_agg(rolname || '=' || case when rolbypassrls then 't' else 'f' end, ',' order by rolname)
            from pg_roles where rolname in ('anon', 'authenticated', 'service_role')), true
  union all
  select 24, 'INFO isim girilmiş satır sayısı (yalnız sayı; uygulama anında 0 beklenir)', '-',
         (select count(*)::text from public.members where first_name is not null or last_name is not null), false
  union all
  select 25, 'INFO members satır sayısı (yalnız sayı)', '-',
         (select count(*)::text from public.members), false
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
            then 'WP5_PROD_ASSERT_PASS' else 'WP5_PROD_ASSERT_FAIL' end
order by ord;
