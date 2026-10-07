-- =====================================================================
-- ASALOCAL · İŞ PAKETİ 5 (Ad-soyad ve profil tamamlama) · WP5_DB_up.sql
-- Migration adı (Supabase apply_migration): wp5_member_private_name
--
-- DURUM: HAZIRLIK PAKETİ — PRODUCTION'A UYGULANMADI (PREPARED ONLY, NOT APPLIED).
-- Bkz. WP5_DB_APPLY_ROLLBACK.md (uygulama / kabul / geri alma adımları).
--
-- NE YAPAR / WHAT IT DOES (yalnız EKLEYİCİ / additive)
--   a) public.members.first_name text NULL, public.members.last_name text NULL
--      (add column if not exists; varsayılan YOK; backfill YOK -> mevcut satırlar NULL kalır)
--   b) İki CHECK constraint (isim karakter politikası v1, aşağıda):
--        members_first_name_wp5_policy, members_last_name_wp5_policy
--   c) public.member_set_name(p_first text, p_last text) returns jsonb
--      SECURITY INVOKER (RLS members_self_update ile yalnız çağıranın kendi satırı),
--      search_path sabit; EXECUTE yalnız authenticated (public/anon/service_role REVOKE).
--   d) public.guard_member_admin_fields(): mevcut gövde KORUNUR; yalnız e-posta kilidi EKLENİR
--      (güvenilmeyen çağıran için: INSERT'te email = çağıranın JWT'sindeki email claim'i; UPDATE'te
--      email yalnız kendi JWT email claim'ine eşitlenebilir, diğer her değer OLD.email'e sabitlenir).
--      Claim, GoTrue ayarlarının doğruladığı ölçüde doğrulanmıştır (bu dosya ek doğrulama yapmaz).
--      Güven testi (service_role / asalocal.trusted='1') ve diğer tüm satırlar birebir aynı.
--   e) DOKUNMAZ: member_upsert_profile, complete_profile, view'lar (member_public,
--      comments_public, comment_reaction_counts), admin RPC'leri, policy'ler, grant'ler, auth/SMTP, Edge.
--      Yeni kolonlar hiçbir view'da yok (POST guard: rewrite bağımlılığı = 0).
--
-- ÖNKOŞULLAR (PRE guard ZORLAR; sağlanmazsa HİÇBİR ŞEY değiştirmeden WP5_PRE_DRIFT)
--   * SEC_VIEWS hotfix'i (migration 'sec_public_views_readonly', SEC_VIEWS_package/) ÖNCE uygulanmış
--     olmalı: member_public / comments_public / comment_reaction_counts üzerinde anon ve
--     authenticated için INSERT/UPDATE/DELETE/TRUNCATE (tablo veya kolon düzeyi) YOK. Aksi halde
--     owner-rights (security_invoker=false) member_public üzerinden members RLS'i atlanır ve
--     "profil güncelleme yalnız kullanıcının kendisine" kabulü sağlanamaz.
--   * pg_graphql eklentisi KURULU DEĞİL: guard'ın asalocal.trusted güven bayrağı transaction-local
--     bir GUC'tur; yalnız istemcinin tek transaction'da birden çok ifade çalıştıramadığı (PostgREST:
--     istek başına tek ifade) sürece güvenlidir. pg_graphql çoklu mutation'ı tek transaction'da
--     çalıştırır -> bayrağı açan bir RPC'den sonra aynı transaction'da members yazımı guard'ı atlar.
--
-- İSİM KARAKTER POLİTİKASI v1 (CHECK; locale'den BAĞIMSIZ — yalnız kod noktası aralıkları)
--   NULL = "girilmedi" (izinli). NULL değilse HEPSİ:
--   P1  1..50 karakter (char_length, kod noktası)
--   P2  Unicode NFC normalize (IS NFC NORMALIZED; server_encoding UTF8 şart)
--   P3  baş/son boşluk yok (= btrim), çift boşluk yok; tek izinli boşluk U+0020
--   P4  ASCII'de YALNIZ harf A-Z a-z, boşluk, kesme (') , tire (-), nokta (.) izinli;
--       rakam, < > " ` \ { } [ ] | & ; = $ % # @ * + ? ! ^ ~ / : _ , ( ) ve tüm kontrol
--       karakterleri (U+0001-U+001F, U+007F, C1 U+0080-U+009F) REDDEDİLİR
--   P5  Reddedilen Unicode: NBSP ve tüm diğer boşluk türleri, soft hyphen, Latin-1 sembolleri
--       (U+00A0-U+00BF, × ÷), sıfır-genişlik/bidi/biçim karakterleri (U+200B-U+200F,
--       U+202A-U+202E, U+2060-U+206F, U+FEFF, Arapça/Moğolca biçim karakterleri),
--       görünmez/boş görünen dolgu karakterleri (U+034F CGJ, U+115F/U+1160 Hangul dolgu,
--       U+17B4/U+17B5 Khmer, U+180B-U+180F Moğolca FVS/VS, U+3164 Hangul dolgu; U+FFA0 ve
--       U+2800 braille boşluğu aşağıdaki U+FF00-U+FFFF / U+2000-U+2BFF aralıklarında),
--       genel noktalama + sembol blokları U+2000-U+2BFF (İZİNLİ istisnalar: U+2010 ‐ tire,
--       U+2019 ’ tipografik kesme), CJK sembol/noktalama U+3000-U+303F, özel kullanım alanları,
--       varyasyon seçicileri, küçük/tam genişlik biçimleri (U+FE00-U+FE6F, U+FF00-U+FFFF),
--       matematik alfanümerik, emoji/piktograf (U+1F000-U+1FBFF), etiket karakterleri ve
--       U+E0000 üstü; Arapça/Farsça rakamlar; birleştirici blokları U+1AB0-U+1AFF, U+1DC0-U+1DFF,
--       U+20D0-U+20FF, U+FE20-U+FE2F tamamen
--   P6  ilk karakter boşluk/kesme/nokta/tire/birleştirici işaret olamaz; son karakter
--       boşluk/tire olamaz; ardışık iki ayraç (' . - ‐ ’) olamaz; en fazla 2 ardışık
--       birleştirici işaret. İşaret kümesi M: U+0300-U+036F (Latin/Yunan/Kiril aksanları),
--       U+0483-U+0489 (Kiril), U+0591-U+05BD U+05BF U+05C1-U+05C2 U+05C4-U+05C5 U+05C7
--       (İbrani), U+0610-U+061A U+064B-U+065F U+0670 U+06D6-U+06DC U+06DF-U+06E4 U+06E7-U+06E8
--       U+06EA-U+06ED (Arap harekeleri), U+0900-U+0903 U+093A-U+093C U+093E-U+094F U+0951-U+0957
--       U+0962-U+0963 (Devanagari işaretleri; U+093D avagraha harf olduğu için hariç)
--   P7  en az bir "harf benzeri" karakter (kümesi L, yalnız kod noktası aralıkları): Latin
--       (A-Z a-z, U+00C0-U+024F, U+1E00-U+1EFF, U+A720-U+A7FF), Yunan, Kiril, Ermeni, İbrani,
--       Arap/Fars/Urdu harfleri, Süryani, Thaana, N'Ko, Devanagari, U+0980-U+0DFF (Bengal ...
--       Sinhala blokları), Tay, Lao, Tibet, Myanmar, Gürcü, Etiyopya, Cherokee, Kanada hece,
--       Khmer, Moğol, Tifinagh, Hiragana/Katakana, CJK (+ Ext A, Ext B-G), Yi, Hangul hece, Adlam.
--       Yalnız işaret/dolgu/ayraçtan oluşan (görsel olarak boş) isimler reddedilir.
--   Sonuç: Türkçe (ç ğ ı İ ö ş ü), Latin genişletilmiş, Yunan, Kiril, Arap, İbrani, CJK, Hangul,
--   Devanagari vb. harfler + tek boşluk + kesme + tire kabul; HTML/şablon/kontrol/görünmez
--   karakterler ve harfsiz girdiler ret.
--   (Kabul: Ayşe, Çağrı, Gül, O'Neil, O’Neil, Jean-Luc, İlkay Nur, J. R., محمد, דוד, 王小明,
--    김민준, प्रिया — Ret: <script>, '  a', 'a  ', '', 51 karakter, kontrol karakteri, '{', '"',
--    rakam, emoji, sıfır-genişlik, U+3164 dolgu, 'a'+49 İbrani işareti, yalnız hareke, yalnız tatweel.)
--   İsimler HTML'e yine de textContent ile basılmalıdır (savunma katmanı DB'de ikinci hattır).
--
-- ÇALIŞTIRMA / HOW TO RUN (gövdede dış BEGIN/COMMIT YOK)
--   Supabase : apply_migration(name => 'wp5_member_private_name', query => <bu dosya>)
--              (apply_migration kendi transaction'ını açar -> atomik)
--   psql     : psql -1 -v ON_ERROR_STOP=1 -f WP5_DB_up.sql      (-1 ZORUNLU -> atomik)
--   MCP metin kapısı: bu dosya yıkıcı DDL anahtar kelimesini HİÇBİR yerde içermez
--   (gates/wp5_mcp_token_scan.sh zorlar).
--
-- GÜVENCELER / GUARANTEES
--   * PRE guard : canlı durum YA doğrulanmış baseline (2026-10-07 read-only ölçüm + SEC_VIEWS
--                 sonrası view ACL'i) YA DA zaten uygulanmış WP5 durumu değilse HİÇBİR ŞEY
--                 değiştirmeden durur (kolon imzası, guard/upsert/complete_profile gövde md5'i,
--                 policy/trigger matrisi, view kolonları, anon yetkisi, 3 public view'ın anon/
--                 authenticated için salt-okunur olması, pg_graphql yokluğu, member_set_name
--                 overload'ları, RLS, rol BYPASSRLS bayrakları; uygulanmış durumda CHECK tanım md5'i).
--   * NULL kanıtı: ilk uygulamada yeni kolonlar eklendikten sonra tüm değerlerin NULL olduğu
--                 assert edilir (CHECK eklemeden önce).
--   * POST guard: son durum beklenen değilse RAISE -> tüm transaction geri alınır.
--   * İdempotent: ikinci çalıştırma aynı son durumu üretir ve aynı POST guard'dan geçer.
--   * lock_timeout 5s: members kilidi alınamazsa beklemek yerine hata (değişiklik yok).
-- =====================================================================

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- PRE guard (salt-okunur kontrol; drift varsa durur)
-- ---------------------------------------------------------------------
do $wp5_pre$
declare
  c_base_cols   constant text := 'd9c4f34edd211326976abb53c40c559f';  -- 11 baseline kolon imzası md5
  c_pol_md5     constant text := '464d74a49a1cc84a16f0a1572cf7c22e';  -- members policy matrisi md5
  c_trg_md5     constant text := '55b31b212c9588e1a8f15e185bd08bb6';  -- members trigger matrisi md5
  c_guard_base  constant text := '9bba990aa5a30cd94c93f7609babb7d2';  -- guard prosrc md5 (production 2026-10-07)
  c_guard_wp5   constant text := 'ef160b239cd9dc207a7f78313b0a3242';  -- guard prosrc md5 (WP5)
  c_setname_wp5 constant text := '993b6a358e3ed58f478af75853d4e7fe';  -- member_set_name prosrc md5 (WP5)
  c_upsert      constant text := 'ef472f2ed6dd8398be7c3ed54007ec8a';  -- member_upsert_profile prosrc md5
  c_complete    constant text := '631b3b67ae91b914c377684724e65f59';  -- complete_profile prosrc md5
  c_chk_first   constant text := '7614490ed320884bf7d453bbcb61ccd8';  -- pg_get_constraintdef md5 (first; WP5)
  c_chk_last    constant text := 'afdc557b2b144a07adf050176fc3468b';  -- pg_get_constraintdef md5 (last; WP5)
  v_names   int;
  v_cons    int;
  v_guard   text;
  v_fn      int;
  v_fn_md5  text;
  v_state   text;
  v_x       text;
begin
  if current_setting('server_encoding') <> 'UTF8' then
    raise exception 'WP5_PRE_FAIL: server_encoding=% (UTF8 gerekli: IS NFC NORMALIZED)', current_setting('server_encoding');
  end if;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'members' and c.relkind = 'r'
                    and c.relrowsecurity and not c.relforcerowsecurity) then
    raise exception 'WP5_PRE_FAIL: public.members yok, RLS kapalı veya FORCE RLS beklenmedik';
  end if;

  -- baseline kolon imzası (first_name/last_name hariç 11 kolon) birebir
  select md5(string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '<null>'),
                        ',' order by ordinal_position))
    into v_x
    from information_schema.columns
   where table_schema = 'public' and table_name = 'members' and column_name not in ('first_name', 'last_name');
  if v_x is distinct from c_base_cols then
    raise exception 'WP5_PRE_DRIFT: members kolon imzası beklenen değil (md5=%)', v_x;
  end if;

  -- policy matrisi (3 self policy) birebir
  select md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                        || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'), E'\n' order by policyname))
    into v_x
    from pg_policies where schemaname = 'public' and tablename = 'members';
  if v_x is distinct from c_pol_md5 then
    raise exception 'WP5_PRE_DRIFT: members policy matrisi beklenen değil (md5=%)', v_x;
  end if;

  -- trigger matrisi (search_path'ten bağımsız) birebir
  select md5(string_agg(t.tgname || '|' || t.tgenabled::text || '|' || t.tgtype::text || '|' || pn.nspname || '.' || p.proname,
                        E'\n' order by t.tgname))
    into v_x
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
   where t.tgrelid = 'public.members'::regclass and not t.tgisinternal;
  if v_x is distinct from c_trg_md5 then
    raise exception 'WP5_PRE_DRIFT: members trigger matrisi beklenen değil (md5=%)', v_x;
  end if;

  -- dokunulmayan bağımlı fonksiyonlar birebir
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.member_upsert_profile(text,text,text,text)')) is distinct from c_upsert then
    raise exception 'WP5_PRE_DRIFT: member_upsert_profile gövdesi production baseline değil';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.complete_profile()')) is distinct from c_complete then
    raise exception 'WP5_PRE_DRIFT: complete_profile gövdesi production baseline değil';
  end if;

  -- guard fonksiyonunun öznitelikleri (gövde dışında) değişmemiş olmalı
  select p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '<null>') || '|' || p.proowner::regrole::text
         || '|' || coalesce(p.proacl::text, '<null>') || '|' || p.prorettype::regtype::text || '|'
         || (p.prolang = (select l.oid from pg_language l where l.lanname = 'plpgsql'))::text
    into v_x
    from pg_proc p where p.oid = to_regprocedure('public.guard_member_admin_fields()');
  if v_x is distinct from 'true|search_path=public, pg_temp|postgres|{postgres=X/postgres,service_role=X/postgres}|trigger|true' then
    raise exception 'WP5_PRE_DRIFT: guard_member_admin_fields öznitelikleri beklenen değil (%)', v_x;
  end if;

  -- view kolonları (isim kolonları ASLA)
  if (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
       where a.attrelid = 'public.member_public'::regclass and a.attnum > 0) is distinct from 'display_name,tier' then
    raise exception 'WP5_PRE_DRIFT: member_public kolonları beklenen değil';
  end if;
  if (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
       where a.attrelid = 'public.comments_public'::regclass and a.attnum > 0)
     is distinct from 'id,venue_id,city,display_name,body,photo_url,created_at' then
    raise exception 'WP5_PRE_DRIFT: comments_public kolonları beklenen değil';
  end if;

  -- anon members üzerinde hiçbir yetkiye sahip değil; kolon düzeyi ACL yok
  if has_table_privilege('anon', 'public.members', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'WP5_PRE_DRIFT: anon public.members üzerinde yetkili';
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.members'::regclass and a.attacl is not null) then
    raise exception 'WP5_PRE_DRIFT: members üzerinde kolon düzeyi ACL var (beklenmedik)';
  end if;
  if (select string_agg(rolname || '=' || case when rolbypassrls then 't' else 'f' end, ',' order by rolname)
        from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))
     is distinct from 'anon=f,authenticated=f,service_role=t' then
    raise exception 'WP5_PRE_FAIL: rol BYPASSRLS bayrakları beklenen değil';
  end if;

  -- ÖNKOŞUL SEC_VIEWS (sec_public_views_readonly): 3 public view anon/authenticated için salt-okunur.
  -- has_table_privilege PUBLIC ve rol üyeliği yoluyla gelen yetkiyi de görür; kolon düzeyi
  -- INSERT/UPDATE ayrıca has_any_column_privilege ile yakalanır. View yoksa da durur.
  select string_agg(v.n || ':' || r.n, ',' order by v.n, r.n)
    into v_x
    from (values ('member_public'), ('comments_public'), ('comment_reaction_counts')) v(n)
   cross join (values ('anon'), ('authenticated')) r(n)
   where to_regclass('public.' || v.n) is null
      or has_table_privilege(r.n, to_regclass('public.' || v.n), 'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(r.n, to_regclass('public.' || v.n), 'INSERT,UPDATE');
  if v_x is not null then
    raise exception 'WP5_PRE_DRIFT: SEC_VIEWS önkoşulu sağlanmadı (view:rol yazılabilir veya view yok: %) — önce sec_public_views_readonly uygulanmalı', v_x;
  end if;

  -- ÖNKOŞUL: pg_graphql yok (asalocal.trusted transaction-local güven bayrağı yalnız istemci
  -- tek transaction'da birden çok ifade çalıştıramıyorsa güvenli)
  if exists (select 1 from pg_extension where extname = 'pg_graphql') then
    raise exception 'WP5_PRE_DRIFT: pg_graphql kurulu — asalocal.trusted güven varsayımı geçersiz (çoklu mutation tek transaction); WP5 uygulanmaz';
  end if;

  -- durum tespiti: baseline VEYA uygulanmış WP5 (karışık durum = drift)
  select count(*) into v_names from information_schema.columns
   where table_schema = 'public' and table_name = 'members' and column_name in ('first_name', 'last_name');
  select count(*) into v_cons from pg_constraint
   where conrelid = 'public.members'::regclass
     and conname in ('members_first_name_wp5_policy', 'members_last_name_wp5_policy');
  select md5(p.prosrc) into v_guard from pg_proc p where p.oid = to_regprocedure('public.guard_member_admin_fields()');
  select count(*), max(md5(p.prosrc)) into v_fn, v_fn_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'member_set_name';

  if v_names = 0 and v_cons = 0 and v_guard = c_guard_base and v_fn = 0 then
    v_state := 'baseline';
  elsif v_names = 2 and v_cons = 2 and v_guard = c_guard_wp5 and v_fn = 1 and v_fn_md5 = c_setname_wp5
        and exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.member_set_name(text,text)')) then
    v_state := 'applied';
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'members' and column_name in ('first_name', 'last_name')
                  and (data_type <> 'text' or is_nullable <> 'YES' or column_default is not null)) then
      raise exception 'WP5_PRE_DRIFT: isim kolonları text/NULL/varsayılansız değil';
    end if;
    if exists (select 1 from pg_constraint where conrelid = 'public.members'::regclass
                 and conname in ('members_first_name_wp5_policy', 'members_last_name_wp5_policy') and not convalidated) then
      raise exception 'WP5_PRE_DRIFT: WP5 CHECK constraint doğrulanmamış (NOT VALID)';
    end if;
    if (select md5(pg_get_constraintdef(oid)) from pg_constraint
         where conrelid = 'public.members'::regclass and conname = 'members_first_name_wp5_policy' and contype = 'c')
       is distinct from c_chk_first
       or (select md5(pg_get_constraintdef(oid)) from pg_constraint
            where conrelid = 'public.members'::regclass and conname = 'members_last_name_wp5_policy' and contype = 'c')
       is distinct from c_chk_last then
      raise exception 'WP5_PRE_DRIFT: WP5 CHECK tanımı bu paketin politikası değil (farklı/eski sürüm uygulanmış)';
    end if;
  else
    raise exception 'WP5_PRE_DRIFT: karışık/bilinmeyen durum (name_cols=%, wp5_checks=%, guard_md5=%, member_set_name=% md5=%)',
      v_names, v_cons, v_guard, v_fn, coalesce(v_fn_md5, '<none>');
  end if;
  raise notice 'WP5_PRE_OK state=%', v_state;
end
$wp5_pre$;

-- ---------------------------------------------------------------------
-- a) kolonlar (varsayılan YOK, backfill YOK)
-- ---------------------------------------------------------------------
alter table public.members add column if not exists first_name text;
alter table public.members add column if not exists last_name text;

-- NULL kanıtı: WP5 CHECK'leri henüz yoksa (ilk uygulama) tüm değerler NULL olmalı
do $wp5_null$
declare v_n bigint;
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.members'::regclass
                  and conname in ('members_first_name_wp5_policy', 'members_last_name_wp5_policy')) then
    select count(*) into v_n from public.members where first_name is not null or last_name is not null;
    if v_n <> 0 then
      raise exception 'WP5_NULL_FAIL: CHECK eklenmeden önce % satırda isim değeri var', v_n;
    end if;
  end if;
end
$wp5_null$;

-- ---------------------------------------------------------------------
-- b) CHECK constraint'leri (isim karakter politikası v1 — başlıktaki P1..P7)
-- ---------------------------------------------------------------------
do $wp5_chk$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.members'::regclass
                  and conname = 'members_first_name_wp5_policy') then
    alter table public.members add constraint members_first_name_wp5_policy check (
      first_name is null or (
            char_length(first_name) between 1 and 50
        and first_name is nfc normalized
        and first_name = btrim(first_name)
        and first_name !~ '[\x01-\x1f\x21-\x26\x28-\x2c\x2f-\x40\x5b-\x60\x7b-\xbf\xd7\xf7\x2c2-\x2c5\x34f\x600-\x605\x61c\x660-\x669\x6dd\x6f0-\x6f9\x70f\x890\x891\x8e2\x115f-\x1160\x1680\x17b4-\x17b5\x180b-\x180f\x1ab0-\x1aff\x1dc0-\x1dff\x2000-\x200f\x2011-\x2018\x201a-\x2bff\x3000-\x303f\x3164\xe000-\xf8ff\xfdd0-\xfdef\xfe00-\xfe6f\xfeff\xff00-\xffff\x110bd\x110cd\x13430-\x1343f\x1bca0-\x1bca3\x1d000-\x1d7ff\x1f000-\x1fbff\xe0000-\x10ffff]'
        and first_name ~ '[\x41-\x5a\x61-\x7a\xc0-\x24f\x370-\x373\x376-\x377\x37b-\x37d\x37f\x386\x388-\x3ff\x400-\x482\x48a-\x52f\x531-\x556\x560-\x588\x5d0-\x5ea\x5ef-\x5f2\x620-\x63f\x641-\x64a\x66e-\x66f\x671-\x6d3\x6d5\x6ee-\x6ef\x6fa-\x6fc\x6ff\x710-\x72f\x74d-\x7a5\x7ca-\x7ea\x8a0-\x8c9\x904-\x939\x93d\x950\x958-\x961\x971-\x97f\x980-\xdff\xe01-\xe30\xe32-\xe33\xe40-\xe46\xe81-\xeb0\xeb2-\xeb3\xebd-\xec6\xf40-\xf6c\x1000-\x102a\x10a0-\x10ff\x1200-\x137f\x13a0-\x13fd\x1401-\x166c\x1780-\x17b3\x1820-\x1878\x1c90-\x1cbf\x1e00-\x1fff\x2d30-\x2d67\x3041-\x3096\x309d-\x309f\x30a1-\x30fa\x30fc-\x30ff\x3400-\x4dbf\x4e00-\x9fff\xa000-\xa48c\xa720-\xa7ff\xac00-\xd7a3\x1e900-\x1e943\x20000-\x3134f]'
        and first_name !~ '^[ ''.\x2010\x2019\x300-\x36f\x483-\x489\x591-\x5bd\x5bf\x5c1-\x5c2\x5c4-\x5c5\x5c7\x610-\x61a\x64b-\x65f\x670\x6d6-\x6dc\x6df-\x6e4\x6e7-\x6e8\x6ea-\x6ed\x900-\x903\x93a-\x93c\x93e-\x94f\x951-\x957\x962-\x963-]'
        and first_name !~ '[ \x2010-]$'
        and first_name !~ '  '
        and first_name !~ '[''.\x2010\x2019-]{2}'
        and first_name !~ '[\x300-\x36f\x483-\x489\x591-\x5bd\x5bf\x5c1-\x5c2\x5c4-\x5c5\x5c7\x610-\x61a\x64b-\x65f\x670\x6d6-\x6dc\x6df-\x6e4\x6e7-\x6e8\x6ea-\x6ed\x900-\x903\x93a-\x93c\x93e-\x94f\x951-\x957\x962-\x963]{3}'
      )
    );
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.members'::regclass
                  and conname = 'members_last_name_wp5_policy') then
    alter table public.members add constraint members_last_name_wp5_policy check (
      last_name is null or (
            char_length(last_name) between 1 and 50
        and last_name is nfc normalized
        and last_name = btrim(last_name)
        and last_name !~ '[\x01-\x1f\x21-\x26\x28-\x2c\x2f-\x40\x5b-\x60\x7b-\xbf\xd7\xf7\x2c2-\x2c5\x34f\x600-\x605\x61c\x660-\x669\x6dd\x6f0-\x6f9\x70f\x890\x891\x8e2\x115f-\x1160\x1680\x17b4-\x17b5\x180b-\x180f\x1ab0-\x1aff\x1dc0-\x1dff\x2000-\x200f\x2011-\x2018\x201a-\x2bff\x3000-\x303f\x3164\xe000-\xf8ff\xfdd0-\xfdef\xfe00-\xfe6f\xfeff\xff00-\xffff\x110bd\x110cd\x13430-\x1343f\x1bca0-\x1bca3\x1d000-\x1d7ff\x1f000-\x1fbff\xe0000-\x10ffff]'
        and last_name ~ '[\x41-\x5a\x61-\x7a\xc0-\x24f\x370-\x373\x376-\x377\x37b-\x37d\x37f\x386\x388-\x3ff\x400-\x482\x48a-\x52f\x531-\x556\x560-\x588\x5d0-\x5ea\x5ef-\x5f2\x620-\x63f\x641-\x64a\x66e-\x66f\x671-\x6d3\x6d5\x6ee-\x6ef\x6fa-\x6fc\x6ff\x710-\x72f\x74d-\x7a5\x7ca-\x7ea\x8a0-\x8c9\x904-\x939\x93d\x950\x958-\x961\x971-\x97f\x980-\xdff\xe01-\xe30\xe32-\xe33\xe40-\xe46\xe81-\xeb0\xeb2-\xeb3\xebd-\xec6\xf40-\xf6c\x1000-\x102a\x10a0-\x10ff\x1200-\x137f\x13a0-\x13fd\x1401-\x166c\x1780-\x17b3\x1820-\x1878\x1c90-\x1cbf\x1e00-\x1fff\x2d30-\x2d67\x3041-\x3096\x309d-\x309f\x30a1-\x30fa\x30fc-\x30ff\x3400-\x4dbf\x4e00-\x9fff\xa000-\xa48c\xa720-\xa7ff\xac00-\xd7a3\x1e900-\x1e943\x20000-\x3134f]'
        and last_name !~ '^[ ''.\x2010\x2019\x300-\x36f\x483-\x489\x591-\x5bd\x5bf\x5c1-\x5c2\x5c4-\x5c5\x5c7\x610-\x61a\x64b-\x65f\x670\x6d6-\x6dc\x6df-\x6e4\x6e7-\x6e8\x6ea-\x6ed\x900-\x903\x93a-\x93c\x93e-\x94f\x951-\x957\x962-\x963-]'
        and last_name !~ '[ \x2010-]$'
        and last_name !~ '  '
        and last_name !~ '[''.\x2010\x2019-]{2}'
        and last_name !~ '[\x300-\x36f\x483-\x489\x591-\x5bd\x5bf\x5c1-\x5c2\x5c4-\x5c5\x5c7\x610-\x61a\x64b-\x65f\x670\x6d6-\x6dc\x6df-\x6e4\x6e7-\x6e8\x6ea-\x6ed\x900-\x903\x93a-\x93c\x93e-\x94f\x951-\x957\x962-\x963]{3}'
      )
    );
  end if;
end
$wp5_chk$;

comment on column public.members.first_name is
  'WP5: PRIVATE given name (ad). Only the owner (RLS self) and service_role can read it. Never exposed via member_public/comments_public. Write path: member_set_name(). NULL = not provided.';
comment on column public.members.last_name is
  'WP5: PRIVATE family name (soyad). Only the owner (RLS self) and service_role can read it. Never exposed via member_public/comments_public. Write path: member_set_name(). NULL = not provided.';
comment on constraint members_first_name_wp5_policy on public.members is
  'WP5 name policy v1: 1..50 chars, NFC, trimmed, single spaces, letters + space/apostrophe/hyphen/period only, at least one letter, max 2 consecutive combining marks; HTML/control/invisible/filler chars rejected. See WP5_DB_up.sql P1..P7.';
comment on constraint members_last_name_wp5_policy on public.members is
  'WP5 name policy v1: 1..50 chars, NFC, trimmed, single spaces, letters + space/apostrophe/hyphen/period only, at least one letter, max 2 consecutive combining marks; HTML/control/invisible/filler chars rejected. See WP5_DB_up.sql P1..P7.';

-- ---------------------------------------------------------------------
-- d) e-posta kilidi: guard_member_admin_fields (mevcut gövde + yalnız 2 e-posta satırı)
--    Öznitelikler (SECURITY DEFINER, search_path, sahip, ACL) CREATE OR REPLACE ile korunur.
-- ---------------------------------------------------------------------
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
    -- WP5: client INSERT email = email claim of the caller's JWT (same value member_upsert_profile inserts)
    NEW.email:=(auth.jwt()->>'email');
  ELSE
    NEW.tier:=OLD.tier; NEW.points:=OLD.points; NEW.blocked:=OLD.blocked; NEW.user_id:=OLD.user_id;
    -- WP5: client UPDATE may only sync email to the email claim of its own JWT; anything else is pinned to OLD
    IF NEW.email IS DISTINCT FROM (auth.jwt()->>'email') THEN NEW.email:=OLD.email; END IF;
  END IF;
  RETURN NEW;
END $function$
;

-- ---------------------------------------------------------------------
-- c) member_set_name — çağıranın KENDİ satırı (SECURITY INVOKER + RLS self-update)
--    Neden INVOKER: authenticated zaten members üzerinde UPDATE yetkisine ve
--    members_self_update (auth.uid() = user_id) policy'sine sahip; ek yetki gerekmez.
--    INVOKER, fonksiyonda hata olsa bile RLS'in başka satırı korumasını garanti eder;
--    DEFINER yüzeyi açılmaz. Satır yoksa oluşturmaz -> 'no_member_row' (frontend önce
--    mevcut member_upsert_profile akışını kullanır). Audit/log satırı YAZMAZ (PII çoğaltılmaz).
--    Normalizasyon: her tür boşluk dizisi -> tek U+0020, trim, NFC. Boş/NULL -> ret
--    (sessiz temizleme YOK; isim silme bu RPC'nin kapsamı dışında).
--    Sonuç: {ok:true} | {ok:false, reason: no_auth|bad_first|bad_last|no_member_row}
--    bad_first/bad_last kararı TEK kaynaktan: members_*_wp5_policy CHECK'i (check_violation).
-- ---------------------------------------------------------------------
create or replace function public.member_set_name(p_first text, p_last text)
 returns jsonb
 language plpgsql
 security invoker
 set search_path to 'pg_catalog', 'pg_temp'
as $wp5_set_name$
declare
  v_uid   uuid := auth.uid();
  v_first text;
  v_last  text;
  v_rc    bigint := 0;
  v_con   text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_auth');
  end if;
  if char_length(p_first) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'bad_first');
  end if;
  if char_length(p_last) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'bad_last');
  end if;
  v_first := normalize(btrim(regexp_replace(p_first, '[\x09-\x0d\x20\x85\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000]+', ' ', 'g'), ' '), nfc);
  v_last  := normalize(btrim(regexp_replace(p_last,  '[\x09-\x0d\x20\x85\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000]+', ' ', 'g'), ' '), nfc);
  if v_first is null or v_first = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_first');
  end if;
  if v_last is null or v_last = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_last');
  end if;
  if not exists (select 1 from public.members m where m.user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'no_member_row');
  end if;
  begin
    update public.members m
       set first_name = v_first, last_name = v_last, updated_at = now()
     where m.user_id = v_uid;
    get diagnostics v_rc = row_count;
  exception when check_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'members_first_name_wp5_policy' then
      return jsonb_build_object('ok', false, 'reason', 'bad_first');
    elsif v_con = 'members_last_name_wp5_policy' then
      return jsonb_build_object('ok', false, 'reason', 'bad_last');
    end if;
    raise;
  end;
  if v_rc <> 1 then
    return jsonb_build_object('ok', false, 'reason', 'no_member_row');
  end if;
  return jsonb_build_object('ok', true);
end
$wp5_set_name$;

revoke all on function public.member_set_name(text, text) from public, anon, service_role;
grant execute on function public.member_set_name(text, text) to authenticated;
comment on function public.member_set_name(text, text) is
  'WP5: caller sets own private first/last name. SECURITY INVOKER + RLS self-update. Returns {ok:true} or {ok:false,reason:no_auth|bad_first|bad_last|no_member_row}. No audit rows (no PII duplication).';

-- ---------------------------------------------------------------------
-- POST guard (son durum beklenen değilse RAISE -> tüm transaction geri alınır)
-- ---------------------------------------------------------------------
do $wp5_post$
declare
  c_base_cols   constant text := 'd9c4f34edd211326976abb53c40c559f';
  c_pol_md5     constant text := '464d74a49a1cc84a16f0a1572cf7c22e';
  c_trg_md5     constant text := '55b31b212c9588e1a8f15e185bd08bb6';
  c_guard_wp5   constant text := 'ef160b239cd9dc207a7f78313b0a3242';
  c_setname_wp5 constant text := '993b6a358e3ed58f478af75853d4e7fe';
  c_upsert      constant text := 'ef472f2ed6dd8398be7c3ed54007ec8a';
  c_complete    constant text := '631b3b67ae91b914c377684724e65f59';
  c_chk_first   constant text := '7614490ed320884bf7d453bbcb61ccd8';  -- pg_get_constraintdef md5 (first)
  c_chk_last    constant text := 'afdc557b2b144a07adf050176fc3468b';  -- pg_get_constraintdef md5 (last)
  v_x text;
begin
  -- kolonlar
  if (select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '<null>'), ',' order by column_name)
        from information_schema.columns
       where table_schema = 'public' and table_name = 'members' and column_name in ('first_name', 'last_name'))
     is distinct from 'first_name:text:YES:<null>,last_name:text:YES:<null>' then
    raise exception 'WP5_POST_FAIL: isim kolonları beklenen değil';
  end if;
  select md5(string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '<null>'),
                        ',' order by ordinal_position))
    into v_x
    from information_schema.columns
   where table_schema = 'public' and table_name = 'members' and column_name not in ('first_name', 'last_name');
  if v_x is distinct from c_base_cols then
    raise exception 'WP5_POST_FAIL: baseline kolon imzası değişti';
  end if;

  -- CHECK constraint'leri: tanım md5 + doğrulanmış + iki kolon için aynı ifade
  if (select md5(pg_get_constraintdef(oid)) from pg_constraint
       where conrelid = 'public.members'::regclass and conname = 'members_first_name_wp5_policy' and contype = 'c' and convalidated)
     is distinct from c_chk_first then
    raise exception 'WP5_POST_FAIL: members_first_name_wp5_policy tanımı beklenen değil';
  end if;
  if (select md5(pg_get_constraintdef(oid)) from pg_constraint
       where conrelid = 'public.members'::regclass and conname = 'members_last_name_wp5_policy' and contype = 'c' and convalidated)
     is distinct from c_chk_last then
    raise exception 'WP5_POST_FAIL: members_last_name_wp5_policy tanımı beklenen değil';
  end if;
  if (select replace(pg_get_constraintdef(oid), 'first_name', 'X') from pg_constraint
       where conrelid = 'public.members'::regclass and conname = 'members_first_name_wp5_policy')
     is distinct from
     (select replace(pg_get_constraintdef(oid), 'last_name', 'X') from pg_constraint
       where conrelid = 'public.members'::regclass and conname = 'members_last_name_wp5_policy') then
    raise exception 'WP5_POST_FAIL: ad/soyad CHECK ifadeleri farklı';
  end if;

  -- guard: yeni gövde + öznitelikler aynı
  select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '<null>') || '|'
         || p.proowner::regrole::text || '|' || coalesce(p.proacl::text, '<null>')
    into v_x
    from pg_proc p where p.oid = to_regprocedure('public.guard_member_admin_fields()');
  if v_x is distinct from (c_guard_wp5 || '|true|search_path=public, pg_temp|postgres|{postgres=X/postgres,service_role=X/postgres}') then
    raise exception 'WP5_POST_FAIL: guard_member_admin_fields beklenen değil (%)', v_x;
  end if;

  -- member_set_name: tek overload, INVOKER, search_path sabit, ACL yalnız postgres+authenticated
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'member_set_name') <> 1 then
    raise exception 'WP5_POST_FAIL: member_set_name overload sayısı 1 değil';
  end if;
  select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '<null>') || '|'
         || p.proowner::regrole::text || '|' || coalesce(p.proacl::text, '<null>') || '|' || p.prorettype::regtype::text
    into v_x
    from pg_proc p where p.oid = to_regprocedure('public.member_set_name(text,text)');
  if v_x is distinct from (c_setname_wp5 || '|false|search_path=pg_catalog, pg_temp|postgres|{postgres=X/postgres,authenticated=X/postgres}|jsonb') then
    raise exception 'WP5_POST_FAIL: member_set_name beklenen değil (%)', v_x;
  end if;
  if has_function_privilege('anon', 'public.member_set_name(text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.member_set_name(text,text)', 'EXECUTE') then
    raise exception 'WP5_POST_FAIL: member_set_name EXECUTE matrisi beklenen değil';
  end if;

  -- dokunulmayanlar
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.member_upsert_profile(text,text,text,text)')) is distinct from c_upsert
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.complete_profile()')) is distinct from c_complete then
    raise exception 'WP5_POST_FAIL: member_upsert_profile/complete_profile değişti';
  end if;
  if (select md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                            || coalesce(qual, '<null>') || '|' || coalesce(with_check, '<null>'), E'\n' order by policyname))
        from pg_policies where schemaname = 'public' and tablename = 'members') is distinct from c_pol_md5 then
    raise exception 'WP5_POST_FAIL: members policy matrisi değişti';
  end if;
  if (select md5(string_agg(t.tgname || '|' || t.tgenabled::text || '|' || t.tgtype::text || '|' || pn.nspname || '.' || p.proname,
                            E'\n' order by t.tgname))
        from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
       where t.tgrelid = 'public.members'::regclass and not t.tgisinternal) is distinct from c_trg_md5 then
    raise exception 'WP5_POST_FAIL: members trigger matrisi değişti';
  end if;
  if has_table_privilege('anon', 'public.members', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or exists (select 1 from pg_attribute a where a.attrelid = 'public.members'::regclass and a.attacl is not null) then
    raise exception 'WP5_POST_FAIL: members yetki matrisi değişti';
  end if;

  -- view'lar isim kolonlarını AÇMAZ: kolon listeleri aynı + hiçbir rewrite kuralı yeni kolonlara bağlı değil
  if (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
       where a.attrelid = 'public.member_public'::regclass and a.attnum > 0) is distinct from 'display_name,tier'
     or (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
          where a.attrelid = 'public.comments_public'::regclass and a.attnum > 0)
        is distinct from 'id,venue_id,city,display_name,body,photo_url,created_at' then
    raise exception 'WP5_POST_FAIL: view kolonları değişti';
  end if;
  if exists (select 1 from pg_depend d
               join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
              where d.refobjid = 'public.members'::regclass and d.classid = 'pg_rewrite'::regclass
                and a.attname in ('first_name', 'last_name')) then
    raise exception 'WP5_POST_FAIL: bir view/kural isim kolonlarına bağlı';
  end if;
  raise notice 'WP5_POST_OK';
end
$wp5_post$;
