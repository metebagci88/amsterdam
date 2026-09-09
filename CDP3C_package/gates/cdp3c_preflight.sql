-- =====================================================================
-- ASALOCAL · CDP-3C · PRODUCTION COMPATIBILITY PREFLIGHT (SALT-OKUNUR) · v4
-- Apply ÖNCESİ gerçek production'da koşar. FAIL-CLOSED: eksik kolon/yanlış tip
-- NULL semantiğiyle fark edilmeden geçemez (count(*)=1 / IS DISTINCT FROM / EXISTS).
-- CI baseline (test double) prod parity KANITI DEĞİLDİR. Yazma YAPMAZ.
-- =====================================================================
\set ON_ERROR_STOP on
do $$
declare v_ret text; v_sec boolean; c text;
begin
  -- 1) members: user_id uuid + tek-kolon UNIQUE/PK; email metin (fail-closed count)
  if to_regclass('public.members') is null then raise exception 'PREFLIGHT: public.members yok'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='members' and column_name='user_id' and data_type='uuid')<>1
     then raise exception 'PREFLIGHT: members.user_id uuid değil/yok'; end if;
  if not exists (
    select 1 from pg_index i join pg_class cc on cc.oid=i.indrelid
      join pg_attribute a on a.attrelid=cc.oid and a.attnum = any(i.indkey)
    where cc.relname='members' and cc.relnamespace='public'::regnamespace and i.indisunique and a.attname='user_id'
      and (select count(*) from unnest(i.indkey))=1
  ) then raise exception 'PREFLIGHT: members.user_id tek-kolon UNIQUE/PK değil'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='members' and column_name='email' and data_type in ('text','character varying'))<>1
     then raise exception 'PREFLIGHT: members.email metin kolonu YOK'; end if;
  raise notice 'PREFLIGHT-INFO: members.email nullable=% (fail-closed supported state; withdraw email yoksa contact_email_unresolved_for_suppression)',
     (select is_nullable from information_schema.columns where table_schema='public' and table_name='members' and column_name='email');

  -- 2) admin_users.active boolean + admin_role enum SCHEMA-QUALIFIED değerleri
  if to_regclass('public.admin_users') is null then raise exception 'PREFLIGHT: admin_users yok'; end if;
  if to_regclass('public.admin_roles') is null then raise exception 'PREFLIGHT: admin_roles yok'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='admin_users' and column_name='active' and data_type='boolean')<>1
     then raise exception 'PREFLIGHT: admin_users.active boolean değil/yok'; end if;
  if not exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typname='admin_role' and n.nspname='public')
     then raise exception 'PREFLIGHT: public.admin_role enum yok'; end if;
  foreach c in array array['super_admin','support','crm'] loop
    if not exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
                  where t.typname='admin_role' and n.nspname='public' and e.enumlabel=c) then raise exception 'PREFLIGHT: admin_role değeri eksik: %', c; end if;
  end loop;

  -- 3) admin_write_log KULLANILAN kolonlar: ad + tip (fail-closed count) + nullability
  if to_regclass('public.admin_write_log') is null then raise exception 'PREFLIGHT: admin_write_log yok'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='admin_write_log' and column_name='actor_uid' and data_type='uuid')<>1 then raise exception 'PREFLIGHT: admin_write_log.actor_uid uuid değil/yok'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='admin_write_log' and column_name='action' and data_type in ('text','character varying'))<>1 then raise exception 'PREFLIGHT: admin_write_log.action metin değil/yok'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='admin_write_log' and column_name='before' and data_type='jsonb')<>1 then raise exception 'PREFLIGHT: admin_write_log.before jsonb değil/yok'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='admin_write_log' and column_name='after' and data_type='jsonb')<>1 then raise exception 'PREFLIGHT: admin_write_log.after jsonb değil/yok'; end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='admin_write_log' and column_name='at' and data_type like 'timestamp%')<>1 then raise exception 'PREFLIGHT: admin_write_log.at timestamp değil/yok'; end if;
  foreach c in array array['target_type','target_id','reason','request_id','idempotency_key'] loop
    if (select count(*) from information_schema.columns where table_schema='public' and table_name='admin_write_log' and column_name=c)<>1 then raise exception 'PREFLIGHT: admin_write_log.% kolonu yok', c; end if;
  end loop;
  -- actor_uid NOT NULL olmalı (audit aktörü zorunlu)
  if (select is_nullable from information_schema.columns where table_schema='public' and table_name='admin_write_log' and column_name='actor_uid')<>'NO' then raise exception 'PREFLIGHT: admin_write_log.actor_uid NOT NULL değil'; end if;

  -- 4) yetki yardımcı imzaları + DÖNÜŞ tipi + SECURITY DEFINER
  if to_regprocedure('public._admin_active(uuid)') is null then raise exception 'PREFLIGHT: _admin_active(uuid) yok'; end if;
  select pg_catalog.format_type(prorettype,null), prosecdef into v_ret, v_sec from pg_proc where oid=to_regprocedure('public._admin_active(uuid)');
  if v_ret is distinct from 'boolean' then raise exception 'PREFLIGHT: _admin_active dönüş boolean değil (%)', v_ret; end if;
  if v_sec is distinct from true then raise exception 'PREFLIGHT: _admin_active SECURITY DEFINER değil'; end if;
  if to_regprocedure('public._admin_has_role(uuid,text[])') is null then raise exception 'PREFLIGHT: _admin_has_role(uuid,text[]) yok'; end if;
  select pg_catalog.format_type(prorettype,null), prosecdef into v_ret, v_sec from pg_proc where oid=to_regprocedure('public._admin_has_role(uuid,text[])');
  if v_ret is distinct from 'boolean' then raise exception 'PREFLIGHT: _admin_has_role dönüş boolean değil (%)', v_ret; end if;
  if v_sec is distinct from true then raise exception 'PREFLIGHT: _admin_has_role SECURITY DEFINER değil'; end if;

  -- 5) CDP-3C AUTHORITATIVE nesne YOKLUĞU: gates/cdp3c_preflight_objects.sh (KANONİK manifest;
  --    20 tablo + 12 type + 48 func) tarafından ayrıca doğrulanır — burada ELLE liste TUTULMAZ (drift yok; düzeltme #1).
  --    Contract-only bu SQL prod'da `cdp3c_preflight_objects.sh` ile BİRLİKTE koşulur.

  -- 6) extension'lar DOĞRU ŞEMADA + kullanılan fonksiyon imzaları + Vault yüzeyi (prod/CI'da gerçek)
  if not exists(select 1 from pg_extension where extname='supabase_vault') then raise exception 'PREFLIGHT: supabase_vault extension yok'; end if;
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto' and n.nspname='extensions') then raise exception 'PREFLIGHT: pgcrypto extensions şemasında değil'; end if;
  if to_regprocedure('extensions.digest(bytea,text)') is null then raise exception 'PREFLIGHT: extensions.digest(bytea,text) yok'; end if;
  if to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then raise exception 'PREFLIGHT: extensions.hmac(bytea,bytea,text) yok'; end if;
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then raise exception 'PREFLIGHT: extensions.gen_random_bytes(integer) yok'; end if;
  if to_regclass('vault.secrets') is null then raise exception 'PREFLIGHT: vault.secrets yok'; end if;
  if to_regclass('vault.decrypted_secrets') is null then raise exception 'PREFLIGHT: vault.decrypted_secrets yok'; end if;
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='vault' and p.proname='create_secret') then raise exception 'PREFLIGHT: vault.create_secret yok'; end if;

  raise notice 'CDP3C_PREFLIGHT_PASS';
end $$;
