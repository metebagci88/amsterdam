-- =====================================================================
-- ASALOCAL · İŞ PAKETİ 5 · WP5_DB_down.sql
-- *** OWNER-RUN ROLLBACK / SAHİP TARAFINDAN ÇALIŞTIRILIR ***
-- *** BU DOSYA DROP İÇERİR — SUPABASE MCP (apply_migration/execute_sql) İLE GÖNDERİLMEZ. ***
-- *** VERİ KAYBI: members.first_name / members.last_name kolonları ve içindeki TÜM isimler
--     kalıcı olarak silinir (yalnız isimler; diğer members kolonları/satırları etkilenmez). ***
-- *** GÜVENLİK: geri alma e-posta kilidini de kaldırır -> kullanıcı kendi members.email'ini
--     yeniden PATCH edebilir hale gelir (WP5 öncesi bilinen açık). Önce frontend'den
--     member_set_name çağrısı kaldırılmalıdır. ***
--
-- NE YAPAR
--   1) Silahlandırma (arming) kontrolü: aşağıdaki "set local wp5.down_confirm" satırı yorumdan
--      çıkarılmadıkça HİÇBİR ŞEY yapmaz (WP5_DOWN_NOT_ARMED).
--   2) PRE guard: canlı durum WP5 uygulanmış durum (veya zaten baseline) değilse durur.
--   3) public.member_set_name(text,text) -> DROP FUNCTION
--   4) members_first_name_wp5_policy / members_last_name_wp5_policy -> DROP CONSTRAINT
--   5) members.first_name / members.last_name -> DROP COLUMN (isim verisi kaybı)
--   6) guard_member_admin_fields(): production 2026-10-07 gövdesi BİREBİR geri yüklenir
--      (md5(prosrc)=9bba990aa5a30cd94c93f7609babb7d2, md5(pg_get_functiondef)=48bd6e33c6becde922a033d6093a81b5)
--   7) POST guard: baseline durumu (kolon imzası, guard md5'leri, ACL, policy/trigger matrisi)
--      birebir değilse RAISE -> tüm transaction geri alınır.
--   İdempotent: zaten baseline durumundaysa adımlar etkisizdir ve POST guard yine geçer.
--   DOKUNMAZ: SEC_VIEWS (sec_public_views_readonly) view ACL'leri ve eklentiler — "baseline" burada
--   SEC_VIEWS SONRASI production durumudur; geri alma sonrası view'lar salt-okunur kalır
--   (wp5_pre_assert satır 26-29 yine PASS). CHECK constraint adları değişmedi; DROP CONSTRAINT
--   IF EXISTS her iki politika sürümünü de kaldırır.
--
-- ÇALIŞTIRMA
--   Supabase Dashboard -> SQL Editor: dosyanın TAMAMINI yapıştırın, ARM satırını yorumdan
--   çıkarın, çalıştırın. (Dosya kendi BEGIN/COMMIT'ini içerir; hata olursa hiçbir şey kalmaz.)
--   psql: psql -v ON_ERROR_STOP=1 -f WP5_DB_down.sql   (ARM satırı yorumdan çıkarılmış kopya)
--   Ardından: gates/wp5_pre_assert.sql -> WP5_PRE_ASSERT_PASS (baseline'a dönüş kanıtı;
--   ledger satırı 'wp5_member_private_name' kalırsa ilgili satır FAIL verir -> bkz. APPLY_ROLLBACK.md)
-- =====================================================================
begin;
set local lock_timeout = '5s';

-- ARM (bilinçli onay): aşağıdaki satırın başındaki "-- " işaretini kaldırın.
-- set local wp5.down_confirm = 'DELETE_PRIVATE_NAMES';

do $wp5_down_arm$
begin
  if coalesce(current_setting('wp5.down_confirm', true), '') <> 'DELETE_PRIVATE_NAMES' then
    raise exception 'WP5_DOWN_NOT_ARMED: geri alma silahlandırılmadı (set local wp5.down_confirm = ''DELETE_PRIVATE_NAMES'')';
  end if;
end
$wp5_down_arm$;

-- PRE guard: yalnız WP5 uygulanmış durumdan (veya zaten baseline'dan) geri alınır
do $wp5_down_pre$
declare
  c_guard_base  constant text := '9bba990aa5a30cd94c93f7609babb7d2';
  c_guard_wp5   constant text := 'ef160b239cd9dc207a7f78313b0a3242';
  c_setname_wp5 constant text := '993b6a358e3ed58f478af75853d4e7fe';
  v_names int; v_cons int; v_guard text; v_fn int; v_fn_md5 text; v_n bigint := 0;
begin
  select count(*) into v_names from information_schema.columns
   where table_schema = 'public' and table_name = 'members' and column_name in ('first_name', 'last_name');
  select count(*) into v_cons from pg_constraint
   where conrelid = 'public.members'::regclass
     and conname in ('members_first_name_wp5_policy', 'members_last_name_wp5_policy');
  select md5(p.prosrc) into v_guard from pg_proc p where p.oid = to_regprocedure('public.guard_member_admin_fields()');
  select count(*), max(md5(p.prosrc)) into v_fn, v_fn_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'member_set_name';

  if v_names = 2 and v_cons = 2 and v_guard = c_guard_wp5 and v_fn = 1 and v_fn_md5 = c_setname_wp5 then
    execute 'select count(*) from public.members where first_name is not null or last_name is not null' into v_n;
    raise notice 'WP5_DOWN: state=applied; isim verisi silinecek satır sayısı=%', v_n;
  elsif v_names = 0 and v_cons = 0 and v_guard = c_guard_base and v_fn = 0 then
    raise notice 'WP5_DOWN: state=baseline (zaten geri alınmış; adımlar etkisiz)';
  else
    raise exception 'WP5_DOWN_DRIFT: beklenmeyen durum (name_cols=%, wp5_checks=%, guard_md5=%, member_set_name=% md5=%) — elle inceleyin',
      v_names, v_cons, v_guard, v_fn, coalesce(v_fn_md5, '<none>');
  end if;
end
$wp5_down_pre$;

DROP FUNCTION IF EXISTS public.member_set_name(text, text);
ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_first_name_wp5_policy;
ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_last_name_wp5_policy;
ALTER TABLE public.members DROP COLUMN IF EXISTS first_name;
ALTER TABLE public.members DROP COLUMN IF EXISTS last_name;

-- production 2026-10-07 gövdesi (pg_get_functiondef çıktısı, birebir)
CREATE OR REPLACE FUNCTION public.guard_member_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce(auth.role(),'')='service_role' OR current_setting('asalocal.trusted',true)='1' THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF TG_OP='INSERT' THEN
    NEW.tier:='Kaşif'; NEW.points:=0; NEW.blocked:=false; NEW.user_id:=auth.uid();
  ELSE
    NEW.tier:=OLD.tier; NEW.points:=OLD.points; NEW.blocked:=OLD.blocked; NEW.user_id:=OLD.user_id;
  END IF;
  RETURN NEW;
END $function$
;

-- POST guard: baseline birebir
do $wp5_down_post$
declare v_x text;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'members' and column_name in ('first_name', 'last_name'))
     or exists (select 1 from pg_constraint where conrelid = 'public.members'::regclass
                  and conname in ('members_first_name_wp5_policy', 'members_last_name_wp5_policy'))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'member_set_name') then
    raise exception 'WP5_DOWN_POST_FAIL: WP5 nesnelerinden kalıntı var';
  end if;
  if (select md5(string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '<null>'),
                            ',' order by ordinal_position))
        from information_schema.columns where table_schema = 'public' and table_name = 'members')
     is distinct from 'd9c4f34edd211326976abb53c40c559f' then
    raise exception 'WP5_DOWN_POST_FAIL: members kolon imzası baseline değil';
  end if;
  select md5(p.prosrc) || '|' || md5(pg_get_functiondef(p.oid)) || '|' || p.prosecdef::text || '|'
         || coalesce(array_to_string(p.proconfig, ';'), '<null>') || '|' || p.proowner::regrole::text || '|'
         || coalesce(p.proacl::text, '<null>')
    into v_x
    from pg_proc p where p.oid = to_regprocedure('public.guard_member_admin_fields()');
  if v_x is distinct from '9bba990aa5a30cd94c93f7609babb7d2|48bd6e33c6becde922a033d6093a81b5|true|search_path=public, pg_temp|postgres|{postgres=X/postgres,service_role=X/postgres}' then
    raise exception 'WP5_DOWN_POST_FAIL: guard_member_admin_fields baseline değil (%)', v_x;
  end if;
  if (select md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                            || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'), E'\n' order by policyname))
        from pg_policies where schemaname = 'public' and tablename = 'members') is distinct from '464d74a49a1cc84a16f0a1572cf7c22e'
     or (select md5(string_agg(t.tgname || '|' || t.tgenabled::text || '|' || t.tgtype::text || '|' || pn.nspname || '.' || p.proname,
                               E'\n' order by t.tgname))
           from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
          where t.tgrelid = 'public.members'::regclass and not t.tgisinternal) is distinct from '55b31b212c9588e1a8f15e185bd08bb6' then
    raise exception 'WP5_DOWN_POST_FAIL: policy/trigger matrisi baseline değil';
  end if;
  raise notice 'WP5_DOWN_POST_OK (baseline geri yüklendi)';
end
$wp5_down_post$;

commit;
