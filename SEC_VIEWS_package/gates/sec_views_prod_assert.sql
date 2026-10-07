-- =====================================================================
-- SEC-VIEWS · gates/sec_views_prod_assert.sql   (SALT-OKUNUR / READ-ONLY)
-- SEC_VIEWS_up.sql uygulandıktan SONRA. Beklenen: OVERALL = SEC_VIEWS_PROD_ASSERT_PASS.
-- Satır 9: public şemadaki DİĞER tüm ilişkilerin ACL'i (3 view hariç) değişmedi — PRE değeri
-- 2026-10-07 read-only ölçümünden (evidence/pre_acl_other_prod_2026-10-07.txt).
-- =====================================================================
with v as (
  select c.relname, c.oid, c.relacl::text as acl, array_to_string(c.reloptions, ',') as opts,
         md5(pg_get_viewdef(c.oid, true)) as def_md5, pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('member_public', 'comments_public', 'comment_reaction_counts')
),
chk(ord, check_name, expected, actual) as (
  select 1, 'view ACLs (anon/authenticated SELECT only)',
         'comment_reaction_counts={postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres};'
         || 'comments_public={postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres};'
         || 'member_public={postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}',
         (select string_agg(relname::text || '=' || coalesce(acl, '<null>'), ';' order by relname) from v)
  union all
  select 2, 'all 3 views share the target ACL', '1', (select count(distinct acl)::text from v)
  union all
  select 3, 'view definitions unchanged (md5)',
         'comment_reaction_counts:240f9780784dbce197e977c3279ec4f6,comments_public:1d109aaeddd96e0ad746fb7a177d5da1,member_public:bfb056b40e300dbb32edb4606f348ad2',
         (select string_agg(relname::text || ':' || def_md5, ',' order by relname) from v)
  union all
  select 4, 'view owner + reloptions unchanged', '3',
         (select count(*)::text from v where owner = 'postgres' and opts = 'security_invoker=false,security_barrier=true')
  union all
  select 5, 'writable views/matviews in public for anon/authenticated', '0',
         (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('v', 'm')
             and (has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
               or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')))
  union all
  select 6, 'SELECT kept for anon+authenticated on the 3 views', '6',
         (select (count(*) filter (where has_table_privilege('anon', oid, 'SELECT'))
                + count(*) filter (where has_table_privilege('authenticated', oid, 'SELECT')))::text from v)
  union all
  select 7, 'ledger: sec_public_views_readonly recorded', '1',
         (select count(*)::text from supabase_migrations.schema_migrations where name = 'sec_public_views_readonly')
  union all
  select 8, 'members FORCE RLS unchanged (false) + RLS on', 'true|false',
         (select relrowsecurity::text || '|' || relforcerowsecurity::text from pg_class where oid = 'public.members'::regclass)
  union all
  select 9, 'other public relations ACL count:md5 unchanged (== PRE)', '54:17159771c03ad0a8b0c2b00510a7cb9b',
         (select count(*)::text || ':' || md5(string_agg(c.relname::text || '|' || c.relkind::text || '|' || coalesce(c.relacl::text, '<null>'), E'\n' order by c.relname))
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f')
             and c.relname not in ('member_public', 'comments_public', 'comment_reaction_counts'))
)
select ord, check_name, expected, actual, case when expected = actual then 'PASS' else 'FAIL' end as result from chk
union all
select 99, 'OVERALL', 'all rows PASS',
       (select count(*) filter (where expected is distinct from actual) || ' FAIL / ' || count(*) || ' counted' from chk),
       case when (select bool_and(expected = actual) from chk) then 'SEC_VIEWS_PROD_ASSERT_PASS' else 'SEC_VIEWS_PROD_ASSERT_FAIL' end
order by ord;
