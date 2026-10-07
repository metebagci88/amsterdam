-- =====================================================================
-- ASALOCAL · WP5 · gates/wp5_zero_footprint_test.sql
-- PRODUCTION-SAFE hosted davranış testi — WP5_DB_up.sql uygulandıktan SONRA (Supabase execute_sql).
--
-- ZERO FOOTPRINT: Tek bir DO bloğudur ve HER ZAMAN `ERROR: REPORT:...` (P0001) ile biter.
-- Bu hata BEKLENENDİR: rapor hata metnidir ve RAISE tüm transaction'ı geri alır (geçici
-- auth.users + members satırları, member_ref, rol/GUC değişiklikleri dahil). Gerçek kullanıcı
-- satırları OKUNMAZ/DEĞİŞTİRİLMEZ; tüm sorgular yalnız bu bloğun ürettiği rastgele uuid'leri hedefler.
-- Geçici kullanıcılar: e-posta 'zz-wp5-zf-<rol>-<uuid>' + '@' + 'example.invalid' (çalışma anında
-- birleştirilir), auth.users.created_at = 2000-01-01 -> WSE welcome seed "future-only" kuralı
-- gereği tetiklenmez (hoş geldin e-postası/pref olayı oluşmaz). Sequence tüketen tablo yazılmaz.
-- complete_profile yalnız "incomplete_profile" dalında çağrılır (puan/trusted GUC yolu çalışmaz).
-- Sonuç satırı: WP5_ZF_VERDICT=PASS fails=0   (aksi halde STOP)
-- Ardından wp5_prod_assert.sql satır 22 ile residue=0 ayrıca kanıtlanır.
--
-- Kanıtladıkları (DB katmanı; PostgREST aynı rol/claim modeliyle çalışır):
--   A (sahip)  : member_set_name kendi satırına yazar (trim + NFC); geçersiz girdiler bad_first/bad_last;
--                doğrudan UPDATE ile geçersiz isim -> 23514 CHECK; doğrudan e-posta PATCH -> e-posta DEĞİŞMEZ;
--                JWT e-postası değişmişse yalnız o değere eşitlenebilir; B'nin satırı 0 satır (RLS);
--                member_upsert_profile güncelleme yolu çalışır ve e-postayı JWT'den alır;
--                complete_profile davranışı aynı (incomplete_profile)
--   B (kurban) : hiçbir alanı değişmez
--   C (satırsız): member_set_name -> no_member_row; doğrudan INSERT sahte e-posta -> JWT e-postası yazılır
--   D (satırsız): member_upsert_profile INSERT yolu çalışır, e-posta = JWT
--   anon       : member_set_name EXECUTE yok (42501); member_public/comments_public isim kolonu yok (42703);
--                member_public üzerinden UPDATE/DELETE 42501 (SEC_VIEWS önkoşulu; WHERE false -> satır hedeflenmez)
--   A (authenticated): member_public üzerinden UPDATE/DELETE 42501 (RLS'i atlayan owner-rights yol kapalı)
--   İsim politikası ret vektörleri görünmez/dolgu karakterlerini de içerir; hepsi chr() ile üretilir
--   (dosyada görünmez karakter literali yoktur).
--   sub'sız authenticated: no_auth
--   service_role: e-postayı değiştirebilir (admin/Edge yolu değişmedi)
-- WP5'ten ÖNCE çalıştırılırsa (isteğe bağlı red-before-green) VERDICT=FAIL olur; yine her şey geri alınır.
-- =====================================================================
do $wp5zf$
declare
  rep     text := '';
  fails   int  := 0;
  v_a     uuid := gen_random_uuid();
  v_b     uuid := gen_random_uuid();
  v_c     uuid := gen_random_uuid();
  v_d     uuid := gen_random_uuid();
  v_dom   text := '@' || 'example.invalid';
  v_ea    text;
  v_ea2   text;
  v_eb    text;
  v_ec    text;
  v_ed    text;
  v_evil  text;
  v_svc   text;
  v_res   jsonb;
  v_rc    bigint;
  v_state text;
  v_msg   text;
  v_t     text;
  v_b_pre text;
  v_b_post text;
  v_in    text[];
  v_lbl   text[];
  v_exp   text;
  v_bad   text[][];
  i       int;
begin
  if not (pg_has_role(current_user, 'anon', 'MEMBER')
          and pg_has_role(current_user, 'authenticated', 'MEMBER')
          and pg_has_role(current_user, 'service_role', 'MEMBER')) then
    raise exception using message = 'REPORT:WP5_ZF_VERDICT=ERROR runner cannot switch roles (' || current_user || ')', errcode = 'P0001';
  end if;
  v_ea   := 'zz-wp5-zf-a-'    || v_a || v_dom;
  v_ea2  := 'zz-wp5-zf-a2-'   || v_a || v_dom;
  v_eb   := 'zz-wp5-zf-b-'    || v_b || v_dom;
  v_ec   := 'zz-wp5-zf-c-'    || v_c || v_dom;
  v_ed   := 'zz-wp5-zf-d-'    || v_d || v_dom;
  v_evil := 'zz-wp5-zf-evil-' || v_a || v_dom;
  v_svc  := 'zz-wp5-zf-svc-'  || v_b || v_dom;
  rep := rep || format('INFO runner=%s guard_has_email_lock=%s member_set_name=%s; ', current_user,
    coalesce((select (p.prosrc ~ 'NEW\.email')::text from pg_proc p where p.oid = to_regprocedure('public.guard_member_admin_fields()')), '<absent>'),
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'member_set_name'));

  -- 0) seed (runner; trusted GUC yalnız seed için, hemen kapatılır)
  insert into auth.users (id, email, aud, role, created_at) values
    (v_a, v_ea, 'authenticated', 'authenticated', '2000-01-01T00:00:00Z'),
    (v_b, v_eb, 'authenticated', 'authenticated', '2000-01-01T00:00:00Z'),
    (v_c, v_ec, 'authenticated', 'authenticated', '2000-01-01T00:00:00Z'),
    (v_d, v_ed, 'authenticated', 'authenticated', '2000-01-01T00:00:00Z');
  perform set_config('asalocal.trusted', '1', true);
  insert into public.members (email, user_id, display_name) values (v_ea, v_a, 'zz-wp5-zf-a'), (v_eb, v_b, 'zz-wp5-zf-b');
  perform set_config('asalocal.trusted', '', true);
  select to_jsonb(m)::text into v_b_pre from public.members m where m.user_id = v_b;

  -- 1) A: sahip
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated', 'email', v_ea)::text, true);
  set local role authenticated;

  begin
    v_res := public.member_set_name('  Ayşe  ', 'Yılmaz');
    if v_res = '{"ok": true}'::jsonb then rep := rep || 'PASS A.set_name ok; ';
    else rep := rep || format('FAIL A.set_name %s; ', v_res); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.set_name error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;

  v_bad := array[
    array['<script>', 'X', 'bad_first'], array['  a', 'X', 'ok'], array['X', '', 'bad_last'], array['', 'X', 'bad_first'],
    array[repeat('a', 51), 'X', 'bad_first'], array['X', repeat('b', 51), 'bad_last'],
    array['a' || chr(1) || 'b', 'X', 'bad_first'], array['{x}', 'X', 'bad_first'], array['a"b', 'X', 'bad_first'],
    array['X', '<b>', 'bad_last'], array['Al1', 'X', 'bad_first'], array['X', 'a' || chr(8203) || 'b', 'bad_last'],
    -- görünmez / dolgu / işaret-yalnız (U+3164, U+3164x3, U+115F, U+1160, U+17B4, a+U+180B, a+U+034F,
    -- a+49xU+0591, 20xU+064E, U+2800, 3xU+0640)
    array[chr(12644), 'X', 'bad_first'], array['X', repeat(chr(12644), 3), 'bad_last'], array[chr(4447), 'X', 'bad_first'],
    array['X', chr(4448), 'bad_last'], array[chr(6068), 'X', 'bad_first'], array['X', 'a' || chr(6155), 'bad_last'],
    array['a' || chr(847), 'X', 'bad_first'], array['X', 'a' || repeat(chr(1425), 49), 'bad_last'],
    array[repeat(chr(1614), 20), 'X', 'bad_first'], array['X', chr(10240), 'bad_last'], array[repeat(chr(1600), 3), 'X', 'bad_first']
  ];
  -- not: '  a' trim sonrası 'a' -> geçerli (normalizasyon); ret testi doğrudan UPDATE ile aşağıda
  for i in 1 .. array_length(v_bad, 1) loop
    begin
      v_res := public.member_set_name(v_bad[i][1], v_bad[i][2]);
      v_t := coalesce(v_res->>'reason', case when (v_res->>'ok')::boolean then 'ok' end, '<null>');
      if v_t = v_bad[i][3] then rep := rep || format('PASS A.set_name[%s]=%s; ', i, v_t);
      else rep := rep || format('FAIL A.set_name[%s] got=%s exp=%s; ', i, v_res, v_bad[i][3]); fails := fails + 1; end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      rep := rep || format('FAIL A.set_name[%s] error %s %s; ', i, v_state, v_msg); fails := fails + 1;
    end;
  end loop;
  -- son geçerli değeri geri yaz (aşağıdaki doğrulama için)
  begin
    v_res := public.member_set_name('Ayşe', 'Yılmaz');
  exception when others then null;
  end;

  -- doğrudan UPDATE ile geçersiz isim -> CHECK 23514 (RPC'yi atlayan yol da korunur)
  v_in  := array['<script>', '  a', 'a  ', '', repeat('a', 51), 'a' || chr(9) || 'b', '{', '"',
                 chr(12644), repeat(chr(12644), 3), 'a' || chr(12644) || 'b', chr(4447), chr(4448), chr(6068), 'a' || chr(6155), 'a' || chr(847),
                 'a' || repeat(chr(1425), 49), repeat(chr(1614), 20), chr(10240), repeat(chr(1600), 3)];
  v_lbl := array['script', 'lead-space', 'trail-space', 'empty', '51chars', 'tab', 'brace', 'dquote',
                 'U+3164', 'U+3164x3', 'a+U+3164+b', 'U+115F', 'U+1160', 'U+17B4', 'a+U+180B', 'a+U+034F',
                 'a+49xU+0591', '20xU+064E', 'U+2800', '3xU+0640'];
  for i in 1 .. array_length(v_in, 1) loop
    begin
      update public.members set first_name = v_in[i] where user_id = v_a;
      rep := rep || format('FAIL A.patch_first_name[%s] ACCEPTED; ', v_lbl[i]); fails := fails + 1;
    exception when check_violation then
      rep := rep || format('PASS A.patch_first_name[%s] 23514; ', v_lbl[i]);
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      rep := rep || format('FAIL A.patch_first_name[%s] wrong %s %s; ', v_lbl[i], v_state, v_msg); fails := fails + 1;
    end;
  end loop;

  -- doğrudan e-posta PATCH (sahte değer) -> satır güncellenir ama e-posta DEĞİŞMEZ
  begin
    update public.members set email = v_evil, display_name = 'zz-wp5-zf-a-renamed' where user_id = v_a;
    get diagnostics v_rc = row_count;
    rep := rep || format('INFO A.patch_email rows=%s; ', v_rc);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.patch_email error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;

  -- B'nin satırı: RLS -> 0 satır
  begin
    update public.members set first_name = 'Hacked', email = v_evil, display_name = 'hacked' where user_id = v_b;
    get diagnostics v_rc = row_count;
    if v_rc = 0 then rep := rep || 'PASS A.update_B rows=0; ';
    else rep := rep || format('FAIL A.update_B rows=%s; ', v_rc); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.update_B error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;

  -- member_upsert_profile güncelleme yolu (mevcut sözleşme)
  begin
    v_res := public.member_upsert_profile(null, null, 'Amsterdam', null);
    if v_res = '{"ok": true}'::jsonb then rep := rep || 'PASS A.upsert_update ok; ';
    else rep := rep || format('FAIL A.upsert_update %s; ', v_res); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.upsert_update error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;

  -- SEC_VIEWS önkoşulu: authenticated, owner-rights member_public üzerinden yazamaz (WHERE false: satır hedeflenmez)
  begin
    update public.member_public set display_name = display_name where false;
    rep := rep || 'FAIL A.member_public_update ALLOWED; '; fails := fails + 1;
  exception when insufficient_privilege then rep := rep || 'PASS A.member_public_update 42501; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.member_public_update %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  begin
    delete from public.member_public where false;
    rep := rep || 'FAIL A.member_public_delete ALLOWED; '; fails := fails + 1;
  exception when insufficient_privilege then rep := rep || 'PASS A.member_public_delete 42501; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.member_public_delete %s %s; ', v_state, v_msg); fails := fails + 1;
  end;

  -- complete_profile: gender eksik -> incomplete_profile (WP5 öncesiyle aynı)
  begin
    v_res := public.complete_profile();
    if v_res = '{"ok": false, "reason": "incomplete_profile"}'::jsonb then rep := rep || 'PASS A.complete_profile incomplete; ';
    else rep := rep || format('FAIL A.complete_profile %s; ', v_res); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.complete_profile error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  reset role;

  -- runner doğrulaması (A) — dinamik SQL: WP5 öncesi (kolon yok) da REPORT üretir
  begin
    execute 'select coalesce(first_name, ''<null>'') || ''|'' || coalesce(last_name, ''<null>'') || ''|'' || (email = $1)::text || ''|'''
         || ' || coalesce(display_name, ''<null>'') || ''|'' || coalesce(home_city, ''<null>'') from public.members where user_id = $2'
      into v_t using v_ea, v_a;
    if v_t = 'Ayşe|Yılmaz|true|zz-wp5-zf-a-renamed|Amsterdam' then
      rep := rep || 'PASS A.row names+email_unchanged+display_name+home_city; ';
    else rep := rep || format('FAIL A.row %s; ', v_t); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL A.row error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;

  -- A'nın JWT e-postası değişmiş (Auth e-posta değişimi): yalnız o değere eşitlenebilir
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated', 'email', v_ea2)::text, true);
  set local role authenticated;
  update public.members set email = v_evil where user_id = v_a;
  reset role;
  select email into v_t from public.members where user_id = v_a;
  if v_t = v_ea then rep := rep || 'PASS A.patch_email_other pinned; ';
  else rep := rep || 'FAIL A.patch_email_other changed; '; fails := fails + 1; end if;
  set local role authenticated;
  update public.members set email = v_ea2 where user_id = v_a;
  reset role;
  select email into v_t from public.members where user_id = v_a;
  if v_t = v_ea2 then rep := rep || 'PASS A.patch_email_to_own_jwt synced; ';
  else rep := rep || 'FAIL A.patch_email_to_own_jwt not_synced; '; fails := fails + 1; end if;

  -- B değişmedi
  select to_jsonb(m)::text into v_b_post from public.members m where m.user_id = v_b;
  if v_b_post = v_b_pre then rep := rep || 'PASS B.untouched; ';
  else rep := rep || 'FAIL B.changed; '; fails := fails + 1; end if;

  -- 2) C: satırı yok
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated', 'email', v_ec)::text, true);
  set local role authenticated;
  begin
    v_res := public.member_set_name('Can', 'Demir');
    if v_res = '{"ok": false, "reason": "no_member_row"}'::jsonb then rep := rep || 'PASS C.set_name no_member_row; ';
    else rep := rep || format('FAIL C.set_name %s; ', v_res); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL C.set_name error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  begin
    insert into public.members (email, user_id, display_name) values (v_evil, v_c, 'zz-wp5-zf-c');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL C.insert error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  reset role;
  select (email = v_ec)::text into v_t from public.members where user_id = v_c;
  if v_t = 'true' then rep := rep || 'PASS C.insert spoofed_email -> jwt_email; ';
  else rep := rep || format('FAIL C.insert email_is_jwt=%s; ', coalesce(v_t, '<no_row>')); fails := fails + 1; end if;

  -- 3) D: member_upsert_profile INSERT + UPDATE yolu
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated', 'email', v_ed)::text, true);
  set local role authenticated;
  begin
    v_res := public.member_upsert_profile('zz-wp5-zf-d', null, null, null);
    v_t := v_res::text;
    v_res := public.member_upsert_profile(null, null, 'Amsterdam', null);
    v_t := v_t || '|' || v_res::text;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_t := 'error ' || v_state || ' ' || v_msg;
  end;
  reset role;
  begin
    execute 'select $1 || ''|'' || (email = $2)::text || ''|'' || coalesce(display_name, ''<null>'') || ''|'' || coalesce(home_city, ''<null>'')'
         || ' || ''|'' || coalesce(first_name, ''<null>'') from public.members where user_id = $3'
      into v_t using v_t, v_ed, v_d;
    if v_t = '{"ok": true}|{"ok": true}|true|zz-wp5-zf-d|Amsterdam|<null>' then rep := rep || 'PASS D.upsert insert+update email=jwt; ';
    else rep := rep || format('FAIL D.upsert %s; ', coalesce(v_t, '<no_row>')); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL D.row error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;

  -- 4) anon: EXECUTE yok; view'larda isim kolonu yok
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin
    v_res := public.member_set_name('Ayşe', 'Kaya');
    rep := rep || format('FAIL anon.set_name ALLOWED %s; ', v_res); fails := fails + 1;
  exception when insufficient_privilege then
    rep := rep || 'PASS anon.set_name 42501; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL anon.set_name wrong %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  begin
    perform first_name from public.member_public limit 1;
    rep := rep || 'FAIL anon.member_public exposes first_name; '; fails := fails + 1;
  exception when undefined_column then rep := rep || 'PASS anon.member_public no first_name; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL anon.member_public %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  begin
    perform last_name from public.comments_public limit 1;
    rep := rep || 'FAIL anon.comments_public exposes last_name; '; fails := fails + 1;
  exception when undefined_column then rep := rep || 'PASS anon.comments_public no last_name; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL anon.comments_public %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  begin
    update public.member_public set display_name = display_name where false;
    rep := rep || 'FAIL anon.member_public_update ALLOWED; '; fails := fails + 1;
  exception when insufficient_privilege then rep := rep || 'PASS anon.member_public_update 42501; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL anon.member_public_update %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  begin
    delete from public.member_public where false;
    rep := rep || 'FAIL anon.member_public_delete ALLOWED; '; fails := fails + 1;
  exception when insufficient_privilege then rep := rep || 'PASS anon.member_public_delete 42501; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL anon.member_public_delete %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  begin
    perform first_name from public.members limit 1;
    rep := rep || 'FAIL anon.members readable; '; fails := fails + 1;
  exception when insufficient_privilege then rep := rep || 'PASS anon.members 42501; ';
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL anon.members %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  reset role;

  -- 5) sub'sız authenticated -> no_auth
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  begin
    v_res := public.member_set_name('Ayşe', 'Kaya');
    if v_res = '{"ok": false, "reason": "no_auth"}'::jsonb then rep := rep || 'PASS nosub.set_name no_auth; ';
    else rep := rep || format('FAIL nosub.set_name %s; ', v_res); fails := fails + 1; end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL nosub.set_name error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  reset role;

  -- 6) service_role: e-posta değiştirebilir (admin/Edge yolu değişmedi)
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  begin
    update public.members set email = v_svc where user_id = v_b;
    get diagnostics v_rc = row_count;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL svc.update error %s %s; ', v_state, v_msg); fails := fails + 1;
  end;
  reset role;
  select (email = v_svc)::text into v_t from public.members where user_id = v_b;
  if v_t = 'true' then rep := rep || 'PASS svc.email_set; ';
  else rep := rep || format('FAIL svc.email_set %s; ', coalesce(v_t, '<no_row>')); fails := fails + 1; end if;
  perform set_config('request.jwt.claims', '', true);

  rep := rep || format('WP5_ZF_VERDICT=%s fails=%s', case when fails = 0 then 'PASS' else 'FAIL' end, fails);
  raise exception using message = 'REPORT:' || rep, errcode = 'P0001';
end
$wp5zf$;
