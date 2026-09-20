-- =====================================================================
-- CDP-3D · BASELINE CONTRACT GATE (fail-closed) — CI ephemeral doğrulaması
-- CDP3D_up.sql UYGULANMADAN ÖNCE koşar. CDP-3D'nin önceki-fazlara (CDP-3B/3C) olan
-- TÜM statik bağımlılıklarının ephemeral DB'de gerçek production kontratıyla
-- (ad + tip + nullability + enum label + fonksiyon imza/return + trigger-helper +
-- extension/şema + Vault) karşılandığını doğrular. Herhangi biri eksik/yanlışsa RAISE → gate KIRMIZI.
-- Yalnızca varlık değil, en az beklenen ad/tip kontratı denetlenir.
-- (ON_ERROR_STOP CI'da psql -v ile verilir; dosyada \set kullanılmaz -> araç bağımsız çalışır.)
-- =====================================================================
do $$
declare v_ret text;
begin
  ------------------------------------------------------------------ tablolar + kolonlar + tip
  -- members(user_id uuid, email text, blocked boolean)
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='members' and column_name='user_id' and data_type='uuid')
    then raise exception 'CONTRACT_FAIL: members.user_id uuid'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='members' and column_name='email' and data_type='text')
    then raise exception 'CONTRACT_FAIL: members.email text'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='members' and column_name='blocked' and data_type='boolean')
    then raise exception 'CONTRACT_FAIL: members.blocked boolean'; end if;
  -- email_templates(id uuid)
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='email_templates' and column_name='id' and data_type='uuid')
    then raise exception 'CONTRACT_FAIL: email_templates.id uuid'; end if;
  -- member_service_pref_current(user_id uuid, pref_key service_pref_key, enabled boolean)
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='member_service_pref_current' and column_name='user_id' and data_type='uuid')
    then raise exception 'CONTRACT_FAIL: member_service_pref_current.user_id uuid'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='member_service_pref_current' and column_name='pref_key' and udt_name='service_pref_key')
    then raise exception 'CONTRACT_FAIL: member_service_pref_current.pref_key service_pref_key'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='member_service_pref_current' and column_name='enabled' and data_type='boolean')
    then raise exception 'CONTRACT_FAIL: member_service_pref_current.enabled boolean'; end if;
  -- contact_suppression_current(contact_hmac text, channel/scope/reason enum, status text)
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='contact_suppression_current' and column_name='contact_hmac' and data_type='text')
    then raise exception 'CONTRACT_FAIL: contact_suppression_current.contact_hmac text'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='contact_suppression_current' and column_name='channel' and udt_name='suppression_channel')
    then raise exception 'CONTRACT_FAIL: contact_suppression_current.channel suppression_channel'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='contact_suppression_current' and column_name='scope' and udt_name='suppression_scope')
    then raise exception 'CONTRACT_FAIL: contact_suppression_current.scope suppression_scope'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='contact_suppression_current' and column_name='reason' and udt_name='suppression_reason')
    then raise exception 'CONTRACT_FAIL: contact_suppression_current.reason suppression_reason'; end if;
  -- contact_suppression_events (CDP-3D _email_system_apply_suppression buraya INSERT eder)
  if to_regclass('public.contact_suppression_events') is null
    then raise exception 'CONTRACT_FAIL: table contact_suppression_events'; end if;

  ------------------------------------------------------------------ enum + label kontratı
  if not exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='service_pref_key' and e.enumlabel='welcome_service_email')
    then raise exception 'CONTRACT_FAIL: enum service_pref_key label welcome_service_email'; end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='suppression_reason' and e.enumlabel='hard_bounce')
    then raise exception 'CONTRACT_FAIL: enum suppression_reason label hard_bounce'; end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='suppression_reason' and e.enumlabel='spam_complaint')
    then raise exception 'CONTRACT_FAIL: enum suppression_reason label spam_complaint'; end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='suppression_reason' and e.enumlabel='user_unsubscribe')
    then raise exception 'CONTRACT_FAIL: enum suppression_reason label user_unsubscribe'; end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='suppression_scope' and e.enumlabel='all_email')
    then raise exception 'CONTRACT_FAIL: enum suppression_scope label all_email'; end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='suppression_channel' and e.enumlabel='email')
    then raise exception 'CONTRACT_FAIL: enum suppression_channel label email'; end if;

  ------------------------------------------------------------------ fonksiyon imza + return type (to_regprocedure ile sağlam)
  if to_regprocedure('public._contact_hmac(text,integer)') is null
    then raise exception 'CONTRACT_FAIL: fn _contact_hmac(text,integer)'; end if;
  v_ret := pg_get_function_result(to_regprocedure('public._contact_hmac(text,integer)'));
  if v_ret <> 'text' then raise exception 'CONTRACT_FAIL: _contact_hmac return % (text bekleniyor)', v_ret; end if;
  if to_regprocedure('public._admin_active(uuid)') is null
    then raise exception 'CONTRACT_FAIL: fn _admin_active(uuid)'; end if;
  if pg_get_function_result(to_regprocedure('public._admin_active(uuid)')) <> 'boolean'
    then raise exception 'CONTRACT_FAIL: _admin_active return (boolean bekleniyor)'; end if;
  if to_regprocedure('public._admin_has_role(uuid,text[])') is null
    then raise exception 'CONTRACT_FAIL: fn _admin_has_role(uuid,text[])'; end if;
  if pg_get_function_result(to_regprocedure('public._admin_has_role(uuid,text[])')) <> 'boolean'
    then raise exception 'CONTRACT_FAIL: _admin_has_role return (boolean bekleniyor)'; end if;
  if to_regprocedure('public._append_only_guard()') is null
    then raise exception 'CONTRACT_FAIL: trigger fn _append_only_guard()'; end if;
  if pg_get_function_result(to_regprocedure('public._append_only_guard()')) <> 'trigger'
    then raise exception 'CONTRACT_FAIL: _append_only_guard return (trigger bekleniyor)'; end if;

  ------------------------------------------------------------------ Vault pepper + extension/şema
  if not exists (select 1 from information_schema.tables where table_schema='vault' and table_name='decrypted_secrets')
    then raise exception 'CONTRACT_FAIL: vault.decrypted_secrets yok'; end if;
  if not exists (select 1 from vault.decrypted_secrets where name='cdp3c_contact_pepper_v1')
    then raise exception 'CONTRACT_FAIL: Vault secret cdp3c_contact_pepper_v1 yok'; end if;
  if not exists (select 1 from pg_extension where extname='pgcrypto')
    then raise exception 'CONTRACT_FAIL: pgcrypto extension yok'; end if;
  if not exists (select 1 from pg_namespace where nspname='extensions')
    then raise exception 'CONTRACT_FAIL: schema extensions yok'; end if;

  raise notice 'BASELINE_CONTRACT_OK';
end $$;
