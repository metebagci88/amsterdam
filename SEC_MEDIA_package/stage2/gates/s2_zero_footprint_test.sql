-- =====================================================================
-- SEC-MEDIA · STAGE 2 · gates/s2_zero_footprint_test.sql
-- PRODUCTION-SAFE hosted davranış testi — S2_up.sql uygulandıktan SONRA (Supabase execute_sql).
--
-- ZERO FOOTPRINT: Tek bir DO bloğudur ve HER ZAMAN `ERROR: REPORT:...` (P0001) ile biter.
-- Bu hata BEKLENENDİR: rapor hata metnidir ve RAISE tüm transaction'ı geri alır
-- (seed satırı, rol/GUC değişiklikleri dahil). Kalıcı hiçbir şey yazılmaz; Storage API/S3
-- çağrılmaz (yalnız storage.objects metadata satırı, transaction içinde).
-- Sonuç satırı: S2_ZF_VERDICT=PASS fails=0   (aksi halde STOP)
-- Ardından s2_prod_assert.sql satır 14 ile residue=0 ayrıca kanıtlanır.
--
-- Ne kanıtlar (Storage API'nin RLS'i uyguladığı DB katmanında):
--   anon & authenticated: INSERT -> 42501 RLS; UPSERT -> 42501 RLS; UPDATE -> 0 satır;
--                         DELETE (storage.allow_delete_query=true, Storage API yolu) -> 0 satır;
--                         SELECT media -> izinli (public read korunur); seed satırı değişmeden kalır
--   service_role (BYPASSRLS = admin-api Edge yolu): INSERT/UPDATE/DELETE çalışır
--
-- TRIGGER NOTU: production storage.objects üzerinde `protect_objects_delete`
--   (BEFORE DELETE FOR EACH STATEMENT -> storage.protect_delete()) vardır. GUC
--   storage.allow_delete_query<>'true' iken HER rol için DELETE'i ERRCODE 42501 ile reddeder.
--   Bu RLS DEĞİLDİR; S2'den önce de aynı hatayı verir. Bu yüzden: (a) GUC'suz DELETE'in
--   hata METNİ ayrıca doğrulanır (yanlış-pozitif 42501 kabul edilmez); (b) RLS kanıtı GUC='true'
--   (transaction-local, rollback ile kaybolur) altında 0 satır olarak alınır.
--   `update_objects_updated_at` (BEFORE UPDATE row) yalnız RLS'ten geçen satırda çalışır.
--
-- S2_up'tan ÖNCE çalıştırılırsa (isteğe bağlı "red-before-green" kanıtı) anon/authenticated
-- yazma satırları FAIL verir ve VERDICT=FAIL olur — test açığı yakalayabildiğini gösterir;
-- yine her şey geri alınır.
-- =====================================================================
do $s2zf$
declare
  rep         text   := '';
  fails       int    := 0;
  v_seed      uuid;
  v_seed_name text   := 'zz-sec-media-s2-zf/seed-' || gen_random_uuid()::text || '.bin';
  v_role      text;
  v_rc        bigint;
  v_cnt       bigint;
  v_pre       bigint;
  v_post      bigint;
  v_state     text;
  v_msg       text;
  v_meta      jsonb;
  v_trg       boolean;
begin
  if not (pg_has_role(current_user, 'anon', 'MEMBER')
          and pg_has_role(current_user, 'authenticated', 'MEMBER')
          and pg_has_role(current_user, 'service_role', 'MEMBER')) then
    raise exception using message = 'REPORT:S2_ZF_VERDICT=ERROR runner cannot switch roles (' || current_user || ')', errcode = 'P0001';
  end if;

  v_trg := exists (select 1 from pg_trigger
                    where tgrelid = 'storage.objects'::regclass and tgname = 'protect_objects_delete' and not tgisinternal);
  select count(*) into v_pre from storage.objects where bucket_id = 'media';
  rep := rep || format('INFO runner=%s protect_objects_delete=%s media_objects_pre=%s; ', current_user, v_trg, v_pre);

  -- 1) seed: service_role (BYPASSRLS) — admin-api Edge yolunun DB karşılığı
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('media', v_seed_name, '{"s2zf":"seed"}'::jsonb)
    returning id into v_seed;
    rep := rep || 'PASS service_role.insert; ';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL service_role.insert %s %s; ', v_state, v_msg);
    fails := fails + 1;
  end;
  reset role;
  if v_seed is null then
    raise exception using message = 'REPORT:' || rep || 'S2_ZF_VERDICT=FAIL seed_failed', errcode = 'P0001';
  end if;

  -- 2) anon + authenticated
  foreach v_role in array array['anon', 'authenticated'] loop
    perform set_config('request.jwt.claims',
      case when v_role = 'anon' then '{"role":"anon"}'
           else json_build_object('role', 'authenticated', 'sub', gen_random_uuid()::text)::text end, true);
    execute format('set local role %I', v_role);

    -- INSERT -> 42501 + RLS mesajı (doğru sebep)
    begin
      insert into storage.objects (bucket_id, name)
      values ('media', 'zz-sec-media-s2-zf/' || v_role || '-' || gen_random_uuid()::text || '.bin');
      rep := rep || format('FAIL %s.insert ALLOWED; ', v_role);
      fails := fails + 1;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = '42501' and v_msg like 'new row violates row-level security policy%' then
        rep := rep || format('PASS %s.insert denied 42501 RLS; ', v_role);
      else
        rep := rep || format('FAIL %s.insert wrong_reason %s %s; ', v_role, v_state, v_msg);
        fails := fails + 1;
      end if;
    end;

    -- UPSERT (x-upsert yolu: INSERT .. ON CONFLICT DO UPDATE) seed üzerine -> 42501 RLS
    begin
      insert into storage.objects (id, bucket_id, name)
      values (v_seed, 'media', v_seed_name)
      on conflict (id) do update set metadata = '{"s2zf":"upsert"}'::jsonb;
      rep := rep || format('FAIL %s.upsert ALLOWED; ', v_role);
      fails := fails + 1;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = '42501' and v_msg like 'new row violates row-level security policy%' then
        rep := rep || format('PASS %s.upsert denied 42501 RLS; ', v_role);
      else
        rep := rep || format('FAIL %s.upsert wrong_reason %s %s; ', v_role, v_state, v_msg);
        fails := fails + 1;
      end if;
    end;

    -- UPDATE -> 0 satır (RLS UPDATE policy yok => satırlar görünmez, hata yok)
    begin
      update storage.objects set metadata = '{"s2zf":"tampered"}'::jsonb where id = v_seed;
      get diagnostics v_rc = row_count;
      if v_rc = 0 then
        rep := rep || format('PASS %s.update rows=0; ', v_role);
      else
        rep := rep || format('FAIL %s.update rows=%s; ', v_role, v_rc);
        fails := fails + 1;
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      rep := rep || format('FAIL %s.update unexpected_error %s %s; ', v_role, v_state, v_msg);
      fails := fails + 1;
    end;

    -- DELETE (GUC yok): platform trigger'ı reddeder — RLS kanıtı DEĞİL, yalnız sebep doğrulaması
    if v_trg then
      perform set_config('storage.allow_delete_query', 'false', true);
      begin
        delete from storage.objects where id = v_seed;
        get diagnostics v_rc = row_count;
        rep := rep || format('FAIL %s.delete_no_guc trigger_did_not_fire rows=%s; ', v_role, v_rc);
        fails := fails + 1;
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        if v_state = '42501' and v_msg like 'Direct deletion from storage tables is not allowed%' then
          rep := rep || format('PASS %s.delete_no_guc blocked_by_protect_delete_trigger(not_RLS); ', v_role);
        else
          rep := rep || format('FAIL %s.delete_no_guc wrong_reason %s %s; ', v_role, v_state, v_msg);
          fails := fails + 1;
        end if;
      end;
    else
      rep := rep || format('INFO %s.delete_no_guc skipped(no protect_objects_delete trigger); ', v_role);
    end if;

    -- DELETE (Storage API yolu: storage.allow_delete_query=true) -> RLS -> 0 satır
    perform set_config('storage.allow_delete_query', 'true', true);
    begin
      delete from storage.objects where id = v_seed;
      get diagnostics v_rc = row_count;
      if v_rc = 0 then
        rep := rep || format('PASS %s.delete rows=0; ', v_role);
      else
        rep := rep || format('FAIL %s.delete rows=%s; ', v_role, v_rc);
        fails := fails + 1;
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      rep := rep || format('FAIL %s.delete unexpected_error %s %s; ', v_role, v_state, v_msg);
      fails := fails + 1;
    end;
    perform set_config('storage.allow_delete_query', 'false', true);

    -- SELECT -> izinli (public read korunur)
    begin
      select count(*) into v_cnt from storage.objects where id = v_seed;
      if v_cnt = 1 then
        rep := rep || format('PASS %s.select media visible; ', v_role);
      else
        rep := rep || format('FAIL %s.select visible=%s; ', v_role, v_cnt);
        fails := fails + 1;
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      rep := rep || format('FAIL %s.select error %s %s; ', v_role, v_state, v_msg);
      fails := fails + 1;
    end;

    reset role;

    -- seed satırı değişmeden duruyor mu (runner olarak)
    select metadata into v_meta from storage.objects where id = v_seed;
    if v_meta = '{"s2zf":"seed"}'::jsonb then
      rep := rep || format('PASS %s.seed_intact; ', v_role);
    else
      rep := rep || format('FAIL %s.seed_changed meta=%s; ', v_role, coalesce(v_meta::text, '<deleted>'));
      fails := fails + 1;
    end if;
  end loop;

  -- 3) service_role yazma yolu (Edge/cleanup) hâlâ çalışır
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  begin
    update storage.objects set metadata = '{"s2zf":"svc"}'::jsonb where id = v_seed;
    get diagnostics v_rc = row_count;
    if v_rc = 1 then
      rep := rep || 'PASS service_role.update rows=1; ';
    else
      rep := rep || format('FAIL service_role.update rows=%s; ', v_rc);
      fails := fails + 1;
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL service_role.update %s %s; ', v_state, v_msg);
    fails := fails + 1;
  end;
  perform set_config('storage.allow_delete_query', 'true', true);
  begin
    delete from storage.objects where id = v_seed;
    get diagnostics v_rc = row_count;
    if v_rc = 1 then
      rep := rep || 'PASS service_role.delete rows=1; ';
    else
      rep := rep || format('FAIL service_role.delete rows=%s; ', v_rc);
      fails := fails + 1;
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    rep := rep || format('FAIL service_role.delete %s %s; ', v_state, v_msg);
    fails := fails + 1;
  end;
  perform set_config('storage.allow_delete_query', 'false', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- 4) transaction içi residue (RAISE ayrıca her şeyi geri alır)
  select count(*) into v_cnt from storage.objects where name like 'zz-sec-media-s2-zf/%';
  select count(*) into v_post from storage.objects where bucket_id = 'media';
  if v_cnt = 0 and v_post = v_pre then
    rep := rep || format('PASS in_txn_residue=0 media_objects=%s; ', v_post);
  else
    rep := rep || format('FAIL in_txn_residue=%s media_objects=%s pre=%s; ', v_cnt, v_post, v_pre);
    fails := fails + 1;
  end if;

  rep := rep || format('S2_ZF_VERDICT=%s fails=%s', case when fails = 0 then 'PASS' else 'FAIL' end, fails);
  raise exception using message = 'REPORT:' || rep, errcode = 'P0001';
end
$s2zf$;
