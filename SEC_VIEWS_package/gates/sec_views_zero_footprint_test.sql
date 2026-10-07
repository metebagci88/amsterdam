-- =====================================================================
-- SEC-VIEWS · gates/sec_views_zero_footprint_test.sql   (ZERO FOOTPRINT)
-- Tek DO bloğu; HER ZAMAN `ERROR: REPORT:...` (P0001) ile biter -> tüm transaction geri alınır.
-- Yazma denemeleri `WHERE false` ile yapılır: yetki kontrolü executor başlangıcında satırdan bağımsız
-- yapılır, dolayısıyla açık varken bile hiçbir satır etkilenmez; final RAISE ayrıca her şeyi geri alır.
-- Beklenen: uygulamadan ÖNCE  SV_ZF_VERDICT=VULNERABLE (açığın kanıtı)
--           uygulamadan SONRA SV_ZF_VERDICT=PASS        (yazma 42501, okuma çalışıyor)
-- =====================================================================
do $sv_zf$
declare
  rep   text := '';
  fails int  := 0;
  opens int  := 0;
  v_role text;
  v_stmt text;
  v_n bigint;
  stmts text[] := array[
    'delete from public.member_public where false',
    'update public.member_public set display_name = display_name where false',
    'insert into public.member_public (display_name) select ''x'' where false',
    'delete from public.comments_public where false',
    'delete from public.comment_reaction_counts where false'
  ];
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    perform set_config('request.jwt.claims',
      case when v_role = 'anon' then '{"role":"anon"}'
           else '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f00d"}' end, true);
    execute format('set local role %I', v_role);
    foreach v_stmt in array stmts loop
      begin
        execute v_stmt;
        opens := opens + 1;
        rep := rep || v_role || ':WRITE_ALLOWED[' || split_part(v_stmt, ' where', 1) || '];';
      exception
        when insufficient_privilege then
          rep := rep || v_role || ':denied;';
        when others then
          -- comments_public / comment_reaction_counts güncellenemez: yetki olsa bile 0A000/55000 vb.
          -- Bu, yetki geri alındıktan sonra 42501'den ÖNCE gelmez; 42501 dışı her hata yetki kanıtı DEĞİLDİR.
          rep := rep || v_role || ':other_' || sqlstate || ';';
          if v_stmt like '%member_public%' then fails := fails + 1; end if;
      end;
    end loop;
    begin
      execute 'select count(*) from public.member_public' into v_n;
      execute 'select count(*) from (select 1 from public.comments_public limit 1) s' into v_n;
      execute 'select count(*) from (select 1 from public.comment_reaction_counts limit 1) s' into v_n;
      rep := rep || v_role || ':read_ok;';
    exception when others then
      fails := fails + 1;
      rep := rep || v_role || ':READ_FAIL_' || sqlstate || ';';
    end;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  raise exception using errcode = 'P0001', message = 'REPORT:' || rep || ' opens=' || opens || ' fails=' || fails
    || ' SV_ZF_VERDICT=' || case when opens > 0 then 'VULNERABLE' when fails > 0 then 'FAIL' else 'PASS' end;
end
$sv_zf$;
