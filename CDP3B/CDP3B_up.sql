-- =====================================================================
-- ASALOCAL · CDP-3B (v2, sertleştirilmiş) · Merkezi E-posta Şablonları + Immutable Sürüm + Asset Yayınlama
-- ADDITIVE. Gerçek gönderim/provider/cron/journey/consent YOK. Serbest SQL yok. $0.
-- - 0C idempotency deseni (admin_write_ops + fingerprint + idempotency_conflict + concurrency guard + gerçek sonuç)
-- - Her fonksiyonda AÇIK revoke (public/anon/authenticated); admin RPC'lere yalnız service_role EXECUTE
-- - publish fail-closed doğrulamaları; asset state modeli (draft/promoting/published/failed/orphaned) + promote/gc
-- - pointer bütünlüğü (deferred constraint trigger) + source_type içerik tutarlılığı + alan/JSON doğrulamaları
-- =====================================================================

-- ---------- 1) TABLOLAR ----------
create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  internal_name text not null,
  description text,
  email_class text not null check (email_class in ('marketing','transactional')),
  source_type text not null check (source_type in ('visual_builder','html_import')),
  status text not null default 'draft' check (status in ('draft','published','archived')),
  current_draft_version_id uuid,
  published_version_id uuid,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table if not exists public.email_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.email_templates(id) on delete restrict,
  version_number int not null,
  subject text, preview_text text, sender_name text, reply_to text,
  builder_json jsonb, source_html text, sanitized_html text, plain_text text,
  asset_manifest jsonb not null default '[]'::jsonb,
  variable_manifest jsonb not null default '[]'::jsonb,
  validation_report jsonb not null default '{}'::jsonb,
  content_hash text, builder_json_hash text,
  is_published boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid,
  published_at timestamptz, published_by uuid,
  unique (template_id, version_number)
);

create table if not exists public.email_assets (
  id uuid primary key default gen_random_uuid(),
  object_path text not null,                       -- draft (private) içerik-hash path: <sha256>.<ext>
  public_object_path text,                         -- promote sonrası public bucket path (immutable)
  content_hash text not null,
  mime text not null check (mime in ('image/png','image/jpeg','image/gif','image/webp')),
  bytes int not null check (bytes > 0 and bytes <= 2000000),
  width int, height int,
  status text not null default 'draft' check (status in ('draft','promoting','published','failed','orphaned')),
  created_at timestamptz not null default now(), created_by uuid, published_at timestamptz,
  unique (content_hash),
  unique (object_path),
  check (object_path ~ '^[0-9a-f]{64}\.(png|jpg|jpeg|gif|webp)$'),
  check (public_object_path is null or public_object_path ~ '^[0-9a-f]{64}\.(png|jpg|jpeg|gif|webp)$'),
  check (content_hash ~ '^[0-9a-f]{64}$'),
  check (width is null or (width between 1 and 5000)),
  check (height is null or (height between 1 and 5000)),
  -- mime/ext tutarlılığı
  check (
    (mime='image/png'  and object_path ~ '\.png$') or
    (mime='image/jpeg' and object_path ~ '\.(jpg|jpeg)$') or
    (mime='image/gif'  and object_path ~ '\.gif$') or
    (mime='image/webp' and object_path ~ '\.webp$')
  )
);

create table if not exists public.email_version_assets (
  version_id uuid not null references public.email_template_versions(id) on delete restrict,
  asset_id uuid not null references public.email_assets(id) on delete restrict,
  primary key (version_id, asset_id)
);

-- ---------- 2) RLS deny-all ----------
alter table public.email_templates enable row level security;
alter table public.email_template_versions enable row level security;
alter table public.email_assets enable row level security;
alter table public.email_version_assets enable row level security;
revoke all on public.email_templates, public.email_template_versions, public.email_assets, public.email_version_assets from anon, authenticated, public;

-- ---------- 3) IMMUTABILITY + ASSET + POINTER + SOURCE_TYPE trigger'ları ----------
create or replace function public._email_version_immutable() returns trigger
language plpgsql security definer set search_path to 'pg_catalog','public' as $$
begin
  if TG_OP='DELETE' then if OLD.is_published then raise exception 'published_version_immutable_delete' using errcode='P0001'; end if; return OLD; end if;
  if OLD.is_published then raise exception 'published_version_immutable_update' using errcode='P0001'; end if; return NEW;
end $$;
drop trigger if exists trg_email_version_immutable on public.email_template_versions;
create trigger trg_email_version_immutable before update or delete on public.email_template_versions for each row execute function public._email_version_immutable();

create or replace function public._email_asset_protect() returns trigger
language plpgsql security definer set search_path to 'pg_catalog','public' as $$
begin
  if TG_OP='DELETE' then
    if OLD.status='published' then raise exception 'published_asset_no_delete' using errcode='P0001'; end if;
    if exists(select 1 from public.email_version_assets where asset_id=OLD.id) then raise exception 'asset_in_use' using errcode='P0001'; end if;
    return OLD;
  end if;
  if OLD.status='published' and (NEW.content_hash<>OLD.content_hash or NEW.object_path<>OLD.object_path or coalesce(NEW.public_object_path,'')<>coalesce(OLD.public_object_path,'')) then
    raise exception 'published_asset_immutable' using errcode='P0001'; end if;
  return NEW;
end $$;
drop trigger if exists trg_email_asset_protect on public.email_assets;
create trigger trg_email_asset_protect before update or delete on public.email_assets for each row execute function public._email_asset_protect();

-- pointer bütünlüğü (deferred: create RPC çok-adımlı; tx sonunda doğrulanır)
create or replace function public._email_template_pointer_check() returns trigger
language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v record;
begin
  if NEW.current_draft_version_id is not null then
    select template_id,is_published into v from public.email_template_versions where id=NEW.current_draft_version_id;
    if not found or v.template_id<>NEW.id then raise exception 'draft_pointer_mismatch' using errcode='P0001'; end if;
    if v.is_published then raise exception 'draft_pointer_must_be_unpublished' using errcode='P0001'; end if;
  end if;
  if NEW.published_version_id is not null then
    select template_id,is_published into v from public.email_template_versions where id=NEW.published_version_id;
    if not found or v.template_id<>NEW.id then raise exception 'published_pointer_mismatch' using errcode='P0001'; end if;
    if not v.is_published then raise exception 'published_pointer_must_be_published' using errcode='P0001'; end if;
  end if;
  if NEW.status='published' and NEW.published_version_id is null then raise exception 'published_status_needs_pointer' using errcode='P0001'; end if;
  return NEW;
end $$;
drop trigger if exists trg_email_template_pointer on public.email_templates;
create constraint trigger trg_email_template_pointer after insert or update on public.email_templates
  deferrable initially deferred for each row execute function public._email_template_pointer_check();

-- source_type içerik tutarlılığı (INSERT/UPDATE): published sürümde içerik zorunlulukları
create or replace function public._email_version_source_consistency() returns trigger
language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_src text;
begin
  select source_type into v_src from public.email_templates where id=NEW.template_id;
  if v_src='visual_builder' then
    if NEW.source_html is not null then raise exception 'visual_builder_no_source_html' using errcode='22023'; end if;
    if NEW.is_published and NEW.builder_json is null then raise exception 'visual_builder_needs_builder_json' using errcode='22023'; end if;
  elsif v_src='html_import' then
    if NEW.is_published and NEW.source_html is null then raise exception 'html_import_needs_source_html' using errcode='22023'; end if;
  end if;
  return NEW;
end $$;
drop trigger if exists trg_email_version_source on public.email_template_versions;
create trigger trg_email_version_source before insert or update on public.email_template_versions for each row execute function public._email_version_source_consistency();

-- ---------- 4) yardımcılar (rol + idempotency + doğrulama) ----------
create or replace function public._email_can_write(p_actor uuid) returns boolean language sql stable security definer set search_path to 'pg_catalog','public' as $$
  select public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin','crm']); $$;
create or replace function public._email_can_publish(p_actor uuid) returns boolean language sql stable security definer set search_path to 'pg_catalog','public' as $$
  select public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin']); $$;

-- allowlist değişkenler
create or replace function public._email_vars_ok(p_vars jsonb) returns boolean language sql immutable set search_path to 'pg_catalog','public' as $$
  select jsonb_typeof(coalesce(p_vars,'[]'::jsonb))='array' and not exists(
    select 1 from jsonb_array_elements_text(coalesce(p_vars,'[]'::jsonb)) v
    where v not in ('first_name','city_name','trip_start_date','trip_end_date','days_until_trip','unsubscribe_url')); $$;

-- asset_manifest kapalı şema doğrulaması
create or replace function public._email_manifest_ok(p_man jsonb) returns boolean language sql stable security definer set search_path to 'pg_catalog','public' as $$
  -- KAPALI şema: array, <=50; her eleman object; yalnız {asset_id, public_path} anahtarları;
  -- asset_id uuid ve email_assets'te MEVCUT; public_path (varsa) içerik-hash formatı
  select jsonb_typeof(coalesce(p_man,'[]'::jsonb))='array'
     and (select count(*) from jsonb_array_elements(coalesce(p_man,'[]'::jsonb)))<=50
     and not exists(
       select 1 from jsonb_array_elements(coalesce(p_man,'[]'::jsonb)) e
       where jsonb_typeof(e)<>'object'
          or (e->>'asset_id') is null
          or (e->>'asset_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or not exists(select 1 from public.email_assets a where a.id=(e->>'asset_id')::uuid)
          or (select count(*) from jsonb_object_keys(e) k where k not in ('asset_id','public_path'))>0
          or ((e ? 'public_path') and coalesce(e->>'public_path','') !~ '^[0-9a-f]{64}\.(png|jpg|jpeg|gif|webp)$')); $$;

-- idempotency begin/finish (0C)
create or replace function public._email_idem_begin(p_idem uuid, p_actor uuid, p_action text, p_ttype text, p_tid text, p_fp text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_ex public.admin_write_ops%rowtype;
begin
  if p_idem is null then raise exception 'idem_required' using errcode='22023'; end if;
  select * into v_ex from public.admin_write_ops where idempotency_key=p_idem;
  if found then
    if v_ex.fingerprint<>p_fp or v_ex.action<>p_action then raise exception 'idempotency_conflict' using errcode='P0001'; end if;
    return coalesce(v_ex.result, jsonb_build_object('ok',true,'idempotent',true,'pending',true));
  end if;
  begin
    insert into public.admin_write_ops(idempotency_key,actor_uid,action,target_type,target_id,reason,fingerprint)
      values (p_idem,p_actor,p_action,p_ttype,p_tid,p_action,p_fp);
  exception when unique_violation then
    select * into v_ex from public.admin_write_ops where idempotency_key=p_idem;
    if v_ex.fingerprint<>p_fp or v_ex.action<>p_action then raise exception 'idempotency_conflict' using errcode='P0001'; end if;
    return coalesce(v_ex.result, jsonb_build_object('ok',true,'idempotent',true,'pending',true));
  end;
  return null;  -- devam et
end $$;
create or replace function public._email_idem_finish(p_idem uuid, p_result jsonb)
returns void language sql security definer set search_path to 'pg_catalog','public' as $$
  update public.admin_write_ops set result=p_result where idempotency_key=p_idem; $$;

-- canonical fingerprint: alan-isimli jsonb (delimiter çakışması YOK) + SHA-256 (pgcrypto). Tüm write RPC'ler bunu kullanır.
create or replace function public._email_fp(p_action text, p_actor uuid, p_payload jsonb)
returns text language sql immutable security definer set search_path to 'pg_catalog','public','extensions' as $$
  select encode(extensions.digest(convert_to(jsonb_build_object('action',p_action,'actor',p_actor,'payload',coalesce(p_payload,'{}'::jsonb))::text,'UTF8'),'sha256'),'hex');
$$;

-- ---------- 5) QUERY RPC'ler ----------
create or replace function public.admin_q_email_taxonomy(p_actor uuid)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
begin
  if not public._admin_active(p_actor) then raise exception 'not_admin' using errcode='P0001'; end if;
  if not public._admin_has_role(p_actor, array['super_admin','crm','analyst']) then raise exception 'forbidden' using errcode='P0001'; end if;
  return jsonb_build_object('ok',true,
    'email_classes', to_jsonb(array['marketing','transactional']),
    'source_types', to_jsonb(array['visual_builder','html_import']),
    'statuses', to_jsonb(array['draft','published','archived']),
    'variables', to_jsonb(array['first_name','city_name','trip_start_date','trip_end_date','days_until_trip','unsubscribe_url']),
    'draft_bucket','email-assets-draft','public_bucket','email-assets-public',
    'allowed_mime', to_jsonb(array['image/png','image/jpeg','image/gif','image/webp']),
    'limits', jsonb_build_object('asset_bytes',2000000,'html',400000,'builder_json',800000,'manifest',50,'variables',20));
end $$;

create or replace function public.admin_q_email_template_list(p_actor uuid)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v jsonb;
begin
  if not public._admin_active(p_actor) then raise exception 'not_admin' using errcode='P0001'; end if;
  if not public._admin_has_role(p_actor, array['super_admin','crm','analyst']) then raise exception 'forbidden' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'internal_name',t.internal_name,'description',t.description,
    'email_class',t.email_class,'source_type',t.source_type,'status',t.status,
    'published_version',(select version_number from public.email_template_versions pv where pv.id=t.published_version_id),
    'current_draft_version',(select version_number from public.email_template_versions dv where dv.id=t.current_draft_version_id),
    'updated_at',t.updated_at,'updated_by',t.updated_by) order by t.updated_at desc),'[]'::jsonb) into v from public.email_templates t;
  return jsonb_build_object('ok',true,'templates',v);
end $$;

create or replace function public.admin_q_email_template_get(p_actor uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare t public.email_templates; d jsonb; pub jsonb;
begin
  if not public._admin_active(p_actor) then raise exception 'not_admin' using errcode='P0001'; end if;
  if not public._admin_has_role(p_actor, array['super_admin','crm','analyst']) then raise exception 'forbidden' using errcode='P0001'; end if;
  select * into t from public.email_templates where id=p_id; if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select to_jsonb(v) into d from public.email_template_versions v where v.id=t.current_draft_version_id;
  select to_jsonb(v) into pub from public.email_template_versions v where v.id=t.published_version_id;
  return jsonb_build_object('ok',true,'template',to_jsonb(t),'draft',d,'published',pub);
end $$;

-- veri sağlığı / reconciliation (read-only)
create or replace function public.admin_q_email_data_health(p_actor uuid)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
begin
  if not public._admin_active(p_actor) then raise exception 'not_admin' using errcode='P0001'; end if;
  if not public._admin_has_role(p_actor, array['super_admin','analyst']) then raise exception 'forbidden' using errcode='P0001'; end if;
  return jsonb_build_object('ok',true,
    'assets_promoting',(select count(*) from public.email_assets where status='promoting'),
    'assets_failed',(select count(*) from public.email_assets where status='failed'),
    'assets_orphan_draft',(select count(*) from public.email_assets a where a.status='draft' and not exists(select 1 from public.email_version_assets va where va.asset_id=a.id)),
    'published_missing_public_path',(select count(*) from public.email_assets where status='published' and public_object_path is null),
    'templates_published',(select count(*) from public.email_templates where status='published'));
end $$;

-- GC adayları (dry-run, read-only)
create or replace function public.admin_q_email_asset_gc_candidates(p_actor uuid)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v jsonb;
begin
  if not public._email_can_publish(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('asset_id',a.id,'object_path',a.object_path) order by a.created_at),'[]'::jsonb) into v
    from public.email_assets a where a.status='draft' and not exists(select 1 from public.email_version_assets va where va.asset_id=a.id);
  return jsonb_build_object('ok',true,'candidates',v);
end $$;

-- ---------- 6) WRITE RPC'ler (idempotency + doğrulama) ----------

create or replace function public.admin_w_email_template_create(p_actor uuid, p_internal_name text, p_description text, p_email_class text, p_source_type text, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_tid uuid:=gen_random_uuid(); v_vid uuid:=gen_random_uuid(); v_fp text; v_pre jsonb; v_res jsonb; v_name text;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_write(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  v_name := btrim(coalesce(p_internal_name,''));
  if v_name='' or length(v_name)>120 then raise exception 'bad_name' using errcode='22023'; end if;
  if length(coalesce(p_description,''))>500 then raise exception 'bad_description' using errcode='22023'; end if;
  if p_email_class not in ('marketing','transactional') then raise exception 'bad_class' using errcode='22023'; end if;
  if p_source_type not in ('visual_builder','html_import') then raise exception 'bad_source_type' using errcode='22023'; end if;
  v_fp := public._email_fp('email_template_create', p_actor, jsonb_build_object('internal_name',v_name,'description',p_description,'email_class',p_email_class,'source_type',p_source_type));
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_template_create','email_template',v_tid::text,v_fp); if v_pre is not null then return v_pre; end if;
  insert into public.email_templates(id,internal_name,description,email_class,source_type,status,created_by,updated_by) values (v_tid,v_name,p_description,p_email_class,p_source_type,'draft',p_actor,p_actor);
  insert into public.email_template_versions(id,template_id,version_number,is_published,created_by) values (v_vid,v_tid,1,false,p_actor);
  update public.email_templates set current_draft_version_id=v_vid where id=v_tid;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_template_create','email_template',v_tid::text,null,jsonb_build_object('version',1),'email_template_create',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'template_id',v_tid,'version_id',v_vid,'version_number',1);
  perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

create or replace function public.admin_w_email_version_save(p_actor uuid, p_template_id uuid, p_subject text, p_preview_text text, p_sender_name text, p_reply_to text,
  p_builder_json jsonb, p_source_html text, p_sanitized_html text, p_plain_text text, p_asset_manifest jsonb, p_variable_manifest jsonb, p_validation_report jsonb, p_content_hash text, p_builder_json_hash text, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_did uuid; v_src text; v_fp text; v_pre jsonb; v_res jsonb;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_write(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  select current_draft_version_id, source_type into v_did, v_src from public.email_templates t where t.id=p_template_id;
  if v_did is null then raise exception 'no_draft_version' using errcode='P0001'; end if;
  -- alan doğrulamaları
  if length(coalesce(p_subject,''))>200 then raise exception 'bad_subject' using errcode='22023'; end if;
  if length(coalesce(p_preview_text,''))>200 then raise exception 'bad_preview' using errcode='22023'; end if;
  if length(coalesce(p_sender_name,''))>100 then raise exception 'bad_sender' using errcode='22023'; end if;
  if p_reply_to is not null and (length(p_reply_to)>200 or p_reply_to !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'bad_reply_to' using errcode='22023'; end if;
  if length(coalesce(p_sanitized_html,''))>400000 then raise exception 'sanitized_too_large' using errcode='22023'; end if;
  if length(coalesce(p_source_html,''))>400000 then raise exception 'source_too_large' using errcode='22023'; end if;
  if p_builder_json is not null and length(p_builder_json::text)>800000 then raise exception 'builder_json_too_large' using errcode='22023'; end if;
  if p_content_hash is not null and p_content_hash !~ '^[0-9a-f]{64}$' then raise exception 'bad_content_hash' using errcode='22023'; end if;
  if p_builder_json_hash is not null and p_builder_json_hash !~ '^[0-9a-f]{64}$' then raise exception 'bad_builder_hash' using errcode='22023'; end if;
  if not public._email_vars_ok(p_variable_manifest) or (select count(*) from jsonb_array_elements(coalesce(p_variable_manifest,'[]'::jsonb)))>20 then raise exception 'bad_variable_manifest' using errcode='22023'; end if;
  if not public._email_manifest_ok(p_asset_manifest) then raise exception 'bad_asset_manifest' using errcode='22023'; end if;
  if jsonb_typeof(coalesce(p_validation_report,'{}'::jsonb))<>'object' then raise exception 'bad_validation_report' using errcode='22023'; end if;
  if v_src='visual_builder' and p_source_html is not null then raise exception 'visual_builder_no_source_html' using errcode='22023'; end if;
  -- MANAGED asset URL <-> manifest server-side eşleşmesi (boş manifest ile managed görsel yayınlanamaz)
  if exists(select 1 from regexp_matches(coalesce(p_sanitized_html,''),'email-assets-public/([0-9a-f]{64}\.(?:png|jpg|jpeg|gif|webp))','g') h(m)
            where not exists(select 1 from jsonb_array_elements(coalesce(p_asset_manifest,'[]'::jsonb)) e join public.email_assets a on a.id=(e->>'asset_id')::uuid where a.object_path=h.m[1]))
  then raise exception 'asset_manifest_incomplete' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_asset_manifest,'[]'::jsonb)) e join public.email_assets a on a.id=(e->>'asset_id')::uuid
            where not exists(select 1 from regexp_matches(coalesce(p_sanitized_html,''),'email-assets-public/([0-9a-f]{64}\.(?:png|jpg|jpeg|gif|webp))','g') h(m) where h.m[1]=a.object_path))
  then raise exception 'asset_manifest_mismatch' using errcode='22023'; end if;
  v_fp := public._email_fp('email_version_save', p_actor, jsonb_build_object('template_id',p_template_id,'content_hash',p_content_hash,'builder_json_hash',p_builder_json_hash,'subject',p_subject,'preview_text',p_preview_text,'sender_name',p_sender_name,'reply_to',p_reply_to,'source_html',p_source_html,'plain_text',p_plain_text,'asset_manifest',coalesce(p_asset_manifest,'[]'::jsonb),'variable_manifest',coalesce(p_variable_manifest,'[]'::jsonb),'validation_report',coalesce(p_validation_report,'{}'::jsonb)));
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_version_save','email_template_version',v_did::text,v_fp); if v_pre is not null then return v_pre; end if;
  update public.email_template_versions set subject=p_subject, preview_text=p_preview_text, sender_name=p_sender_name, reply_to=p_reply_to,
    builder_json=p_builder_json, source_html=case when v_src='html_import' then p_source_html else null end, sanitized_html=p_sanitized_html, plain_text=p_plain_text,
    asset_manifest=coalesce(p_asset_manifest,'[]'::jsonb), variable_manifest=coalesce(p_variable_manifest,'[]'::jsonb), validation_report=coalesce(p_validation_report,'{}'::jsonb),
    content_hash=p_content_hash, builder_json_hash=p_builder_json_hash where id=v_did and is_published=false;
  update public.email_templates set updated_at=now(), updated_by=p_actor where id=p_template_id;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_version_save','email_template_version',v_did::text,null,jsonb_build_object('content_hash',p_content_hash),'email_version_save',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'version_id',v_did); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

-- asset kaydı (Edge, draft bucket'a magic-byte kontrolüyle yükledikten SONRA çağırır) — yalnız DRAFT
create or replace function public.admin_w_email_asset_register(p_actor uuid, p_object_path text, p_content_hash text, p_mime text, p_bytes int, p_width int, p_height int, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_id uuid; v_fp text; v_pre jsonb; v_res jsonb;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_write(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  if p_mime not in ('image/png','image/jpeg','image/gif','image/webp') then raise exception 'bad_mime' using errcode='22023'; end if;
  if p_content_hash !~ '^[0-9a-f]{64}$' then raise exception 'bad_content_hash' using errcode='22023'; end if;
  if p_object_path !~ '^[0-9a-f]{64}\.(png|jpg|jpeg|gif|webp)$' or left(p_object_path,64)<>p_content_hash then raise exception 'bad_object_path' using errcode='22023'; end if;
  if coalesce(p_bytes,0)<=0 or p_bytes>2000000 then raise exception 'bad_bytes' using errcode='22023'; end if;
  if p_width is not null and (p_width<1 or p_width>5000) then raise exception 'bad_width' using errcode='22023'; end if;
  if p_height is not null and (p_height<1 or p_height>5000) then raise exception 'bad_height' using errcode='22023'; end if;
  v_fp := public._email_fp('email_asset_register', p_actor, jsonb_build_object('content_hash',p_content_hash));
  -- content_hash idempotent kaydı: aynı içerik varsa mevcut satırı döndür (overwrite yok)
  select id into v_id from public.email_assets where content_hash=p_content_hash;
  if v_id is not null then v_res := jsonb_build_object('ok',true,'asset_id',v_id,'existing',true);
    perform public._email_idem_begin(p_idem,p_actor,'email_asset_register','email_asset',v_id::text,v_fp); perform public._email_idem_finish(p_idem,v_res); return v_res; end if;
  v_id := gen_random_uuid();
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_asset_register','email_asset',v_id::text,v_fp); if v_pre is not null then return v_pre; end if;
  insert into public.email_assets(id,object_path,content_hash,mime,bytes,width,height,status,created_by) values (v_id,p_object_path,p_content_hash,p_mime,p_bytes,p_width,p_height,'draft',p_actor);
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_asset_register','email_asset',v_id::text,null,jsonb_build_object('content_hash',p_content_hash),'email_asset_register',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'asset_id',v_id); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

-- asset promote (Edge public kopyayı doğruladıktan SONRA) — publish yetkisi
create or replace function public.admin_w_email_asset_promote(p_actor uuid, p_asset_id uuid, p_public_object_path text, p_content_hash text, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare a public.email_assets; v_fp text; v_pre jsonb; v_res jsonb;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_publish(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  select * into a from public.email_assets where id=p_asset_id; if not found then raise exception 'asset_not_found' using errcode='P0002'; end if;
  if a.content_hash<>p_content_hash then raise exception 'content_hash_mismatch' using errcode='P0001'; end if;
  if p_public_object_path is null or left(p_public_object_path,64)<>a.content_hash then raise exception 'bad_public_path' using errcode='22023'; end if;
  v_fp := public._email_fp('email_asset_promote', p_actor, jsonb_build_object('asset_id',p_asset_id,'content_hash',p_content_hash));
  if a.status='published' then
    if a.public_object_path is distinct from p_public_object_path then raise exception 'public_object_conflict' using errcode='P0001'; end if;
    v_res := jsonb_build_object('ok',true,'asset_id',a.id,'already',true);
    perform public._email_idem_begin(p_idem,p_actor,'email_asset_promote','email_asset',a.id::text,v_fp); perform public._email_idem_finish(p_idem,v_res); return v_res;
  end if;
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_asset_promote','email_asset',p_asset_id::text,v_fp); if v_pre is not null then return v_pre; end if;
  update public.email_assets set status='published', public_object_path=p_public_object_path, published_at=now() where id=p_asset_id and status in ('draft','promoting');
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_asset_promote','email_asset',p_asset_id::text,jsonb_build_object('status',a.status),jsonb_build_object('status','published'),'email_asset_promote',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'asset_id',p_asset_id); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

-- YAYINLA (fail-closed): tüm asset'ler önceden promote+doğrulanmış OLMALI; tek tx'te finalize
create or replace function public.admin_w_email_publish(p_actor uuid, p_template_id uuid, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_did uuid; v_class text; v_ver public.email_template_versions; e jsonb; v_aid uuid; a public.email_assets; v_fp text; v_pre jsonb; v_res jsonb;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_publish(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  -- IDEMPOTENCY ÖNCE: publish sonrası draft pointer null olsa bile aynı-key retry aynı sonucu döner. Fingerprint STABİL intent (template_id).
  v_fp := public._email_fp('email_publish', p_actor, jsonb_build_object('template_id',p_template_id));
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_publish','email_template',p_template_id::text,v_fp); if v_pre is not null then return v_pre; end if;
  select current_draft_version_id, email_class into v_did, v_class from public.email_templates where id=p_template_id;
  if v_did is null then raise exception 'no_draft_version' using errcode='P0001'; end if;
  select * into v_ver from public.email_template_versions where id=v_did;
  if v_ver.template_id<>p_template_id then raise exception 'version_template_mismatch' using errcode='P0001'; end if;
  if v_ver.is_published then raise exception 'already_published' using errcode='P0001'; end if;
  if coalesce(btrim(v_ver.sanitized_html),'')='' then raise exception 'empty_sanitized_html' using errcode='P0001'; end if;
  if coalesce(v_ver.content_hash,'') !~ '^[0-9a-f]{64}$' then raise exception 'bad_content_hash' using errcode='P0001'; end if;
  if coalesce(v_ver.validation_report->>'ok','')<>'true' then raise exception 'validation_not_ok' using errcode='P0001'; end if;
  if v_class='marketing' and not exists(select 1 from jsonb_array_elements_text(coalesce(v_ver.variable_manifest,'[]'::jsonb)) x where x='unsubscribe_url') then raise exception 'missing_unsubscribe' using errcode='P0001'; end if;
  if jsonb_typeof(coalesce(v_ver.asset_manifest,'[]'::jsonb))<>'array' then raise exception 'bad_asset_manifest' using errcode='P0001'; end if;
  -- her manifest asset'i gerçekten published + public path + hash eşleşmeli (fail-closed)
  for e in select * from jsonb_array_elements(coalesce(v_ver.asset_manifest,'[]'::jsonb)) loop
    v_aid := (e->>'asset_id')::uuid;
    select * into a from public.email_assets where id=v_aid;
    if not found then raise exception 'manifest_asset_missing' using errcode='P0001'; end if;
    if a.status<>'published' then raise exception 'asset_not_promoted' using errcode='P0001'; end if;
    if a.public_object_path is null then raise exception 'asset_no_public_path' using errcode='P0001'; end if;
    if (e->>'public_path') is not null and (e->>'public_path')<>a.public_object_path then raise exception 'manifest_public_path_mismatch' using errcode='P0001'; end if;
  end loop;
  update public.email_template_versions set is_published=true, published_at=now(), published_by=p_actor where id=v_did and is_published=false;
  update public.email_templates set published_version_id=v_did, current_draft_version_id=null, status='published', updated_at=now(), updated_by=p_actor where id=p_template_id;
  insert into public.email_version_assets(version_id,asset_id) select v_did,(ae->>'asset_id')::uuid from jsonb_array_elements(coalesce(v_ver.asset_manifest,'[]'::jsonb)) ae on conflict do nothing;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_publish','email_template',p_template_id::text,null,jsonb_build_object('version_id',v_did),'email_publish',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'published_version_id',v_did); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

create or replace function public.admin_w_email_new_version(p_actor uuid, p_template_id uuid, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_src uuid; v_new uuid:=gen_random_uuid(); v_num int; v_fp text; v_pre jsonb; v_res jsonb;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_write(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  -- template satırını KİLİTLE (eşzamanlı new_version -> tek tutarlı draft)
  perform 1 from public.email_templates where id=p_template_id for update;
  -- IDEMPOTENCY ÖNCE: başarı sonrası draft oluşsa da aynı-key retry aynı version_id döner. Fingerprint STABİL intent (v_num'e bağlı DEĞİL).
  v_fp := public._email_fp('email_new_version', p_actor, jsonb_build_object('template_id',p_template_id));
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_new_version','email_template',p_template_id::text,v_fp); if v_pre is not null then return v_pre; end if;
  select coalesce(published_version_id,current_draft_version_id) into v_src from public.email_templates where id=p_template_id;
  if v_src is null then raise exception 'not_found' using errcode='P0002'; end if;
  if (select current_draft_version_id from public.email_templates where id=p_template_id) is not null then raise exception 'draft_exists' using errcode='P0001'; end if;
  select coalesce(max(version_number),0)+1 into v_num from public.email_template_versions where template_id=p_template_id;
  insert into public.email_template_versions(id,template_id,version_number,subject,preview_text,sender_name,reply_to,builder_json,source_html,sanitized_html,plain_text,asset_manifest,variable_manifest,validation_report,content_hash,builder_json_hash,is_published,created_by)
    select v_new,template_id,v_num,subject,preview_text,sender_name,reply_to,builder_json,source_html,sanitized_html,plain_text,asset_manifest,variable_manifest,validation_report,content_hash,builder_json_hash,false,p_actor from public.email_template_versions where id=v_src;
  update public.email_templates set current_draft_version_id=v_new, status='draft', updated_at=now(), updated_by=p_actor where id=p_template_id;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_new_version','email_template',p_template_id::text,null,jsonb_build_object('version',v_num),'email_new_version',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'version_id',v_new,'version_number',v_num); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

create or replace function public.admin_w_email_duplicate(p_actor uuid, p_template_id uuid, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare s public.email_templates; v_src uuid; v_tid uuid:=gen_random_uuid(); v_vid uuid:=gen_random_uuid(); v_fp text; v_pre jsonb; v_res jsonb;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_write(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  select * into s from public.email_templates where id=p_template_id; if not found then raise exception 'not_found' using errcode='P0002'; end if;
  v_src := coalesce(s.published_version_id,s.current_draft_version_id);
  v_fp := public._email_fp('email_duplicate', p_actor, jsonb_build_object('template_id',p_template_id));
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_duplicate','email_template',v_tid::text,v_fp); if v_pre is not null then return v_pre; end if;
  insert into public.email_templates(id,internal_name,description,email_class,source_type,status,created_by,updated_by) values (v_tid,s.internal_name||' (kopya)',s.description,s.email_class,s.source_type,'draft',p_actor,p_actor);
  insert into public.email_template_versions(id,template_id,version_number,subject,preview_text,sender_name,reply_to,builder_json,source_html,sanitized_html,plain_text,asset_manifest,variable_manifest,validation_report,content_hash,builder_json_hash,is_published,created_by)
    select v_vid,v_tid,1,subject,preview_text,sender_name,reply_to,builder_json,source_html,sanitized_html,plain_text,asset_manifest,variable_manifest,validation_report,content_hash,builder_json_hash,false,p_actor from public.email_template_versions where id=v_src;
  update public.email_templates set current_draft_version_id=v_vid where id=v_tid;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_duplicate','email_template',v_tid::text,jsonb_build_object('from',p_template_id),null,'email_duplicate',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'template_id',v_tid,'version_id',v_vid); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

create or replace function public.admin_w_email_archive(p_actor uuid, p_template_id uuid, p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_fp text; v_pre jsonb; v_res jsonb;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_publish(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  if not exists(select 1 from public.email_templates where id=p_template_id) then raise exception 'not_found' using errcode='P0002'; end if;
  v_fp := public._email_fp('email_archive', p_actor, jsonb_build_object('template_id',p_template_id));
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_archive','email_template',p_template_id::text,v_fp); if v_pre is not null then return v_pre; end if;
  update public.email_templates set status='archived', updated_at=now(), updated_by=p_actor where id=p_template_id;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_archive','email_template',p_template_id::text,null,jsonb_build_object('status','archived'),'email_archive',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'status','archived'); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

-- GC finalize: Edge storage objesini sildikten SONRA yalnız hâlâ orphan-draft olan verilen id'lerin DB satırını sil
create or replace function public.admin_w_email_asset_gc_finalize(p_actor uuid, p_asset_ids uuid[], p_idem uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public' as $$
declare v_fp text; v_pre jsonb; v_res jsonb; v_del int:=0; v_skip int:=0; v_id uuid;
begin
  if not public._admin_writes_enabled() then raise exception 'admin_writes_disabled' using errcode='P0001'; end if;
  if not public._email_can_publish(p_actor) then raise exception 'forbidden' using errcode='P0001'; end if;
  if p_asset_ids is null then raise exception 'bad_ids' using errcode='22023'; end if;
  v_fp := public._email_fp('email_asset_gc_finalize', p_actor, jsonb_build_object('asset_ids',to_jsonb(coalesce(p_asset_ids,'{}'::uuid[]))));
  v_pre := public._email_idem_begin(p_idem,p_actor,'email_asset_gc_finalize','email_asset','batch',v_fp); if v_pre is not null then return v_pre; end if;
  foreach v_id in array p_asset_ids loop
    if exists(select 1 from public.email_assets a where a.id=v_id and a.status='draft' and not exists(select 1 from public.email_version_assets va where va.asset_id=a.id)) then
      delete from public.email_assets where id=v_id; v_del:=v_del+1;
    else v_skip:=v_skip+1; end if;
  end loop;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,idempotency_key,request_id) values (p_actor,'email_asset_gc_finalize','email_asset','batch',null,jsonb_build_object('deleted',v_del,'skipped',v_skip),'email_asset_gc_finalize',p_idem,p_request_id);
  v_res := jsonb_build_object('ok',true,'deleted',v_del,'skipped',v_skip); perform public._email_idem_finish(p_idem,v_res); return v_res;
end $$;

-- ---------- 7) AÇIK GRANT'ler: her fonksiyonda revoke; admin RPC'lere yalnız service_role ----------
do $g$
declare r record;
begin
  -- CDP-3B'nin TÜM fonksiyonları (helper+trigger+q+w) -> public/anon/authenticated kapalı
  for r in
    select p.oid::regprocedure sig, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like '%email%')
      and p.proname in (
        '_email_version_immutable','_email_asset_protect','_email_template_pointer_check','_email_version_source_consistency',
        '_email_can_write','_email_can_publish','_email_vars_ok','_email_manifest_ok','_email_idem_begin','_email_idem_finish',
        'admin_q_email_taxonomy','admin_q_email_template_list','admin_q_email_template_get','admin_q_email_data_health','admin_q_email_asset_gc_candidates',
        'admin_w_email_template_create','admin_w_email_version_save','admin_w_email_asset_register','admin_w_email_asset_promote',
        'admin_w_email_publish','admin_w_email_new_version','admin_w_email_duplicate','admin_w_email_archive','admin_w_email_asset_gc_finalize')
  loop
    if r.proname like 'admin_q_email%' or r.proname like 'admin_w_email%' then
      -- admin RPC'ler: public/anon/authenticated kapalı, YALNIZ service_role
      execute 'revoke all on function '||r.sig||' from public, anon, authenticated';
      execute 'grant execute on function '||r.sig||' to service_role';
    else
      -- helper + trigger fonksiyonları: HERKESE kapalı (service_role dahil). Edge bunları doğrudan çağırmaz.
      execute 'revoke all on function '||r.sig||' from public, anon, authenticated, service_role';
    end if;
  end loop;
end $g$;
