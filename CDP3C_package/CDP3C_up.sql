-- =====================================================================
-- ASALOCAL · CDP-3C · Consent / Suppression / Controller / Servis-tercihleri
-- ADDITIVE migration · REVİZE (v4) · İNCELEME İÇİN; PRODUCTION'A UYGULANMADI.
-- Bağımsız inceleme + geçici gerçek Postgres/Supabase CI GEÇMEDEN apply YOK.
-- YEREL doğrulama: gömülü Postgres 16 + vault/auth/pgcrypto shim ile tüm gate'ler
--   (baseline→up→up(idempotent)→invariants→tests→down_soft→downsoft_assert) GEÇTİ.
--
-- THREAT MODEL (düzeltme #13): service_role RLS'yi BYPASS eder. Bu nedenle KRİTİK
--   invariant'lar RPC'ye DEĞİL, DB TRIGGER'larına dayanır ve doğrudan service_role
--   yazımlarına karşı da enforce edilir: (a) marketing enable/capture hard-gate,
--   (b) published controller/text immutability + unpublish yasağı, (c) event
--   append-only, (d) consent_purpose_doc immutability, (e) suppression kombinasyon
--   matrisi, (f) readiness attestation kapalı-şema, (g) aktif consent metni için
--   hukuk-onayı kapısı, (h) marketing_config.active_controller_version_id → aktif
--   controller invariant'ı. Non-kritik draft yazımları service_role'e açıktır;
--   "her doğrudan yazım engellendi" İDDİA EDİLMEZ — yalnız bu invariant'lar.
-- KAPSAM DIŞI: message_class/sınıflandırma + assertServiceContent + unsubscribe_consume
--   + send → CDP-3D; journeys/scheduler → CDP-3E; Resend/DNS/outbox → CDP-3D;
--   aktif hukuk metni SEED EDİLMEZ (hukuk onayı + fail-closed).
-- Güvenlik: ham e-posta/telefon/token/PII audit/idempotency/hata'da YOK.
-- =====================================================================
set local statement_timeout = '60s';

-- ---------- 0) ENUM'lar ----------
do $$ begin create type public.consent_purpose as enum
  ('email_marketing','sms_marketing','push_marketing','on_site_personalized_messages',
   'personalization_profiling','analytics_storage','advertising_storage'); exception when duplicate_object then null; end $$;
do $$ begin create type public.consent_state as enum ('granted','denied','unknown'); exception when duplicate_object then null; end $$;
do $$ begin create type public.consent_source as enum
  ('signup','pref_center','cookie_banner','unsubscribe','iys_sync','system','import'); exception when duplicate_object then null; end $$;
do $$ begin create type public.consent_doc_type as enum
  ('kvkk_aydinlatma','acik_riza_marketing','acik_riza_kisisellestirme','gizlilik_politikasi','cerez_politikasi','uyelik_sartlari'); exception when duplicate_object then null; end $$;
do $$ begin create type public.controller_type as enum ('natural_person','legal_entity'); exception when duplicate_object then null; end $$;
do $$ begin create type public.legal_subject_kind as enum ('member_uid','anon_subject'); exception when duplicate_object then null; end $$;   -- düzeltme #6
do $$ begin create type public.suppression_channel as enum ('email','sms','push','global'); exception when duplicate_object then null; end $$;
do $$ begin create type public.suppression_scope as enum ('marketing','all_email','global'); exception when duplicate_object then null; end $$;
do $$ begin create type public.suppression_reason as enum
  ('user_unsubscribe','iys_red','hard_bounce','spam_complaint','abuse','admin_safety_block'); exception when duplicate_object then null; end $$;
do $$ begin create type public.service_pref_key as enum
  ('trip_created_confirmation','trip_updated_confirmation','trip_start_minus_7_days',
   'trip_start_minus_1_day','plan_saved_confirmation','plan_reminder','welcome_service_email'); exception when duplicate_object then null; end $$;
do $$ begin create type public.readiness_domain as enum ('marketing','marketing_capture','service_delivery'); exception when duplicate_object then null; end $$;
do $$ begin create type public.readiness_condition as enum
  ('mersis_business','iys_application','iys_sync_method','brand_docs','dns_spf_dkim_dmarc',
   'resend_domain_verified','bounce_complaint_webhook','sender_identity','reply_to_support',
   'processor_transfer_assessment','legal_signoff','allowlist_test'); exception when duplicate_object then null; end $$;

-- ---------- 1) Controller identity ----------
create table if not exists public.controller_identity_versions (
  id uuid primary key default gen_random_uuid(),
  controller_type public.controller_type not null,
  version int not null,
  display_name text not null check (length(display_name) between 1 and 200),
  natural_person_fields jsonb,
  legal_entity_fields jsonb,
  published_address_form text,
  is_active boolean not null default false,
  is_published boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (controller_type, version),
  constraint controller_exactly_one_fieldset check (num_nonnulls(natural_person_fields, legal_entity_fields) = 1),
  constraint controller_valid_range check (valid_to is null or valid_to > valid_from)   -- düzeltme #9
);
create unique index if not exists ux_controller_active on public.controller_identity_versions (is_active) where is_active;

create or replace function public._validate_controller_fields(p_type public.controller_type, p_np jsonb, p_le jsonb)
returns void language plpgsql immutable as $fn$
declare k text;
begin
  if p_type='natural_person' then
    if p_le is not null then raise exception 'controller_mutual_exclusivity'; end if;
    if p_np is null or jsonb_typeof(p_np)<>'object' then raise exception 'controller_fields_not_object'; end if;
    for k in select key from jsonb_object_keys(p_np) as t(key) loop
      if k not in ('full_name','contact_channel') then raise exception 'controller_extra_key:%', k; end if;
    end loop;
    if not (p_np ? 'full_name' and p_np ? 'contact_channel') then raise exception 'controller_missing_key'; end if;
    if jsonb_typeof(p_np->'full_name')<>'string' or length(p_np->>'full_name') not between 1 and 200 then raise exception 'controller_full_name_invalid'; end if;
    if jsonb_typeof(p_np->'contact_channel')<>'string' or length(p_np->>'contact_channel') not between 1 and 200 then raise exception 'controller_contact_channel_invalid'; end if;
  elsif p_type='legal_entity' then
    if p_np is not null then raise exception 'controller_mutual_exclusivity'; end if;
    if p_le is null or jsonb_typeof(p_le)<>'object' then raise exception 'controller_fields_not_object'; end if;
    for k in select key from jsonb_object_keys(p_le) as t(key) loop
      if k not in ('legal_name','mersis') then raise exception 'controller_extra_key:%', k; end if;
    end loop;
    if not (p_le ? 'legal_name' and p_le ? 'mersis') then raise exception 'controller_missing_key'; end if;
    if jsonb_typeof(p_le->'legal_name')<>'string' or length(p_le->>'legal_name') not between 1 and 200 then raise exception 'controller_legal_name_invalid'; end if;
    if jsonb_typeof(p_le->'mersis')<>'string' or (p_le->>'mersis') !~ '^[0-9]{16}$' then raise exception 'controller_mersis_invalid'; end if;
  else raise exception 'controller_type_invalid'; end if;
end $fn$;
revoke all on function public._validate_controller_fields(public.controller_type,jsonb,jsonb) from public, anon, authenticated;

create or replace function public._controller_biu() returns trigger language plpgsql as $fn$
begin
  perform public._validate_controller_fields(new.controller_type, new.natural_person_fields, new.legal_entity_fields);
  if TG_OP='UPDATE' and OLD.is_published and not new.is_published then raise exception 'controller_cannot_unpublish'; end if;
  if new.is_active and (new.valid_to is not null and new.valid_to<=now()) then raise exception 'controller_cannot_activate_expired'; end if;   -- düzeltme #9
  if new.is_active and not new.is_published then new.is_published := true; end if;
  return new;
end $fn$;
drop trigger if exists trg_controller_biu on public.controller_identity_versions;
create trigger trg_controller_biu before insert or update on public.controller_identity_versions for each row execute function public._controller_biu();

create or replace function public._controller_immutable() returns trigger language plpgsql as $fn$
begin
  if TG_OP='DELETE' then if OLD.is_published then raise exception 'controller_published_immutable_delete'; end if; return OLD; end if;
  if OLD.is_published and (
       new.controller_type is distinct from old.controller_type or new.version is distinct from old.version
    or new.display_name is distinct from old.display_name
    or new.natural_person_fields is distinct from old.natural_person_fields
    or new.legal_entity_fields is distinct from old.legal_entity_fields
    or new.published_address_form is distinct from old.published_address_form
    or new.valid_from is distinct from old.valid_from or new.valid_to is distinct from old.valid_to
  ) then raise exception 'controller_published_immutable'; end if;
  return new;
end $fn$;
drop trigger if exists trg_controller_immutable on public.controller_identity_versions;
create trigger trg_controller_immutable before update or delete on public.controller_identity_versions for each row execute function public._controller_immutable();

-- ---------- 2) purpose → doc allowlist (IMMUTABLE mapping) ----------
create table if not exists public.consent_purpose_doc (
  purpose public.consent_purpose primary key,
  doc_type public.consent_doc_type not null
);
insert into public.consent_purpose_doc(purpose, doc_type) values
  ('email_marketing','acik_riza_marketing'),('sms_marketing','acik_riza_marketing'),('push_marketing','acik_riza_marketing'),
  ('advertising_storage','cerez_politikasi'),('analytics_storage','cerez_politikasi'),
  ('on_site_personalized_messages','acik_riza_kisisellestirme'),('personalization_profiling','acik_riza_kisisellestirme')
on conflict (purpose) do nothing;
create or replace function public._consent_purpose_doc_immutable() returns trigger language plpgsql as $fn$
begin raise exception 'consent_purpose_doc_immutable'; end $fn$;
revoke all on function public._consent_purpose_doc_immutable() from public, anon, authenticated;
drop trigger if exists trg_consent_purpose_doc_immutable on public.consent_purpose_doc;
create trigger trg_consent_purpose_doc_immutable before update or delete on public.consent_purpose_doc for each row execute function public._consent_purpose_doc_immutable();

-- ---------- 3) Consent metin sürümleri (immutable + hukuk-onayı kapısı) ----------
create table if not exists public.consent_text_versions (
  id uuid primary key default gen_random_uuid(),
  doc_type public.consent_doc_type not null,
  version int not null,
  locale text not null default 'tr' check (locale ~ '^[a-z]{2}$'),
  controller_version_id uuid not null references public.controller_identity_versions(id),
  body text not null check (length(body) >= 1),
  content_hash text not null,
  is_active boolean not null default false,
  is_published boolean not null default false,
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (doc_type, version, locale)
);
create unique index if not exists ux_consent_text_active on public.consent_text_versions (doc_type, locale) where is_active;

-- Hukuk onayı (append-only immutable); aktifleştirme bu onaya bağlı (düzeltme #10)
create table if not exists public.consent_text_approvals (
  id uuid primary key default gen_random_uuid(),
  text_version_id uuid not null references public.consent_text_versions(id),
  approver uuid not null,
  approved_at timestamptz not null default now(),
  evidence_ref text not null check (evidence_ref ~ '^[A-Za-z0-9:_./#-]{1,200}$'),
  approved_content_hash text not null,
  request_id text not null,
  idempotency_key uuid not null unique
);

create or replace function public._consent_text_biu() returns trigger language plpgsql as $fn$
begin
  new.content_hash := encode(extensions.digest(convert_to(coalesce(new.body,''),'UTF8'),'sha256'),'hex');
  if TG_OP='UPDATE' and OLD.is_published and not new.is_published then raise exception 'consent_text_cannot_unpublish'; end if;
  -- aktif consent metni yalnız HUKUK ONAYI content_hash'e bağlıysa mümkün (düzeltme #10)
  if new.is_active then
    if not exists(select 1 from public.consent_text_approvals a where a.text_version_id=new.id and a.approved_content_hash=new.content_hash) then
      raise exception 'legal_approval_required_for_active';
    end if;
    -- aktif metin AUTHORITATIVE controller'a (marketing_config pointer = aktif+yayımlı) bağlı olmalı (düzeltme #5)
    if not exists(select 1 from public.marketing_config mc join public.controller_identity_versions c on c.id=mc.active_controller_version_id
                  where mc.id=1 and c.id=new.controller_version_id and c.is_active and c.is_published) then
      raise exception 'consent_text_controller_not_authoritative';
    end if;
  end if;
  if new.is_active and not new.is_published then new.is_published := true; new.published_at := coalesce(new.published_at, now()); end if;
  return new;
end $fn$;
drop trigger if exists trg_consent_text_biu on public.consent_text_versions;
create trigger trg_consent_text_biu before insert or update on public.consent_text_versions for each row execute function public._consent_text_biu();

create or replace function public._consent_text_immutable() returns trigger language plpgsql as $fn$
begin
  if TG_OP='DELETE' then if OLD.is_published then raise exception 'consent_text_published_immutable_delete'; end if; return OLD; end if;
  if OLD.is_published and (
       new.body is distinct from old.body or new.content_hash is distinct from old.content_hash
    or new.version is distinct from old.version or new.doc_type is distinct from old.doc_type
    or new.locale is distinct from old.locale or new.controller_version_id is distinct from old.controller_version_id
    or new.published_at is distinct from old.published_at
  ) then raise exception 'consent_text_published_immutable'; end if;
  return new;
end $fn$;
drop trigger if exists trg_consent_text_immutable on public.consent_text_versions;
create trigger trg_consent_text_immutable before update or delete on public.consent_text_versions for each row execute function public._consent_text_immutable();

-- approvals append-only immutable
create or replace function public._approval_immutable() returns trigger language plpgsql as $fn$
begin raise exception 'consent_text_approval_immutable'; end $fn$;
revoke all on function public._approval_immutable() from public, anon, authenticated;
drop trigger if exists trg_approval_immutable on public.consent_text_approvals;
create trigger trg_approval_immutable before update or delete on public.consent_text_approvals for each row execute function public._approval_immutable();

-- ---------- 4) Legal notice events (typed subject; RIZA DEĞİL) (düzeltme #6) ----------
create table if not exists public.legal_notice_events (
  id uuid primary key default gen_random_uuid(),
  subject_kind public.legal_subject_kind not null,
  subject_id uuid not null,
  doc_type public.consent_doc_type not null,
  text_version_id uuid not null references public.consent_text_versions(id),
  controller_version_id uuid not null references public.controller_identity_versions(id),
  presented_at timestamptz not null default now(),
  source public.consent_source not null,
  request_id text not null,
  idempotency_key uuid not null unique
);

-- ---------- 5) Üye consent ----------
create table if not exists public.member_consent_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, purpose public.consent_purpose not null,
  action text not null check (action in ('granted','withdrawn')),
  text_version_id uuid references public.consent_text_versions(id),
  text_content_hash text, consent_epoch bigint not null default 1,
  source public.consent_source not null, request_id text not null,
  idempotency_key uuid not null, fingerprint text not null,
  occurred_at timestamptz not null default now(), evidence jsonb not null default '{}'::jsonb
);
create table if not exists public.member_consent_current (
  user_id uuid not null, purpose public.consent_purpose not null,
  state public.consent_state not null default 'unknown', text_version_id uuid,
  consent_epoch bigint not null default 1, source public.consent_source,
  last_event_id uuid, updated_at timestamptz not null default now(),
  primary key (user_id, purpose)
);

-- ---------- 6) Servis tercihleri ----------
create table if not exists public.member_service_pref_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, pref_key public.service_pref_key not null, enabled boolean not null,
  source public.consent_source not null, request_id text not null, idempotency_key uuid not null,
  fingerprint text not null, occurred_at timestamptz not null default now()
);
create table if not exists public.member_service_pref_current (
  user_id uuid not null, pref_key public.service_pref_key not null, enabled boolean not null,
  last_event_id uuid, updated_at timestamptz not null default now(), primary key (user_id, pref_key)
);
create table if not exists public.service_pref_defaults (
  pref_key public.service_pref_key primary key, default_enabled boolean
);
insert into public.service_pref_defaults(pref_key, default_enabled)
select k, null::boolean from unnest(enum_range(null::public.service_pref_key)) k on conflict do nothing;

-- ---------- 7) Suppression (lineage + FK + kombinasyon matrisi) ----------
create table if not exists public.contact_suppression_events (
  id uuid primary key default gen_random_uuid(),
  channel public.suppression_channel not null, scope public.suppression_scope not null,
  contact_hmac text not null check (contact_hmac ~ '^[0-9a-f]{64}$'),
  pepper_version int not null default 1, reason public.suppression_reason not null,
  action text not null check (action in ('suppress','supersede')), supersede_evidence jsonb,
  source public.consent_source not null, request_id text not null,
  idempotency_key uuid not null, fingerprint text not null, occurred_at timestamptz not null default now()
);
create table if not exists public.contact_suppression_current (
  channel public.suppression_channel not null,
  contact_hmac text not null check (contact_hmac ~ '^[0-9a-f]{64}$'),
  scope public.suppression_scope not null, reason public.suppression_reason not null,
  pepper_version int not null default 1, status text not null check (status in ('active','superseded')),
  source_event_id uuid not null references public.contact_suppression_events(id),
  superseded_at timestamptz, superseded_by uuid references public.contact_suppression_events(id),
  updated_at timestamptz not null default now(),
  primary key (channel, contact_hmac, scope, reason)
);
-- kapalı kombinasyon matrisi (düzeltme #12)
-- ÖNCE exact (channel,scope) çifti, SONRA reason (çapraz anlamsız kombinasyon YOK; düzeltme #9)
create or replace function public._suppression_pair_ok(p_channel public.suppression_channel, p_scope public.suppression_scope)
returns boolean language sql immutable as $fn$
  select (p_channel,p_scope) in (
    ('email','marketing'), ('email','all_email'), ('sms','marketing'), ('push','marketing'), ('global','global')
  );
$fn$;
revoke all on function public._suppression_pair_ok(public.suppression_channel,public.suppression_scope) from public, anon, authenticated;
create or replace function public._suppression_combo_ok(p_channel public.suppression_channel, p_scope public.suppression_scope, p_reason public.suppression_reason)
returns boolean language sql immutable as $fn$
  select public._suppression_pair_ok(p_channel,p_scope) and case p_reason
    when 'user_unsubscribe'   then (p_channel,p_scope) in (('email','marketing'),('email','all_email'),('sms','marketing'),('push','marketing'))
    when 'iys_red'            then (p_channel,p_scope) in (('email','marketing'),('sms','marketing'))
    when 'hard_bounce'        then (p_channel,p_scope) in (('email','marketing'),('email','all_email'))
    when 'spam_complaint'     then (p_channel,p_scope) in (('email','marketing'),('email','all_email'))
    when 'abuse'              then (p_channel,p_scope) in (('email','marketing'),('email','all_email'),('sms','marketing'),('push','marketing'),('global','global'))
    when 'admin_safety_block' then (p_channel,p_scope) in (('email','marketing'),('sms','marketing'),('push','marketing'),('global','global'))
    else false end;
$fn$;
revoke all on function public._suppression_combo_ok(public.suppression_channel,public.suppression_scope,public.suppression_reason) from public, anon, authenticated;
create or replace function public._suppression_combo_guard() returns trigger language plpgsql as $fn$
begin
  if not public._suppression_combo_ok(new.channel,new.scope,new.reason) then raise exception 'suppression_combo_not_allowed:%/%/%', new.channel,new.scope,new.reason; end if;
  return new;
end $fn$;
revoke all on function public._suppression_combo_guard() from public, anon, authenticated;
drop trigger if exists trg_supp_ev_combo on public.contact_suppression_events;
create trigger trg_supp_ev_combo before insert on public.contact_suppression_events for each row execute function public._suppression_combo_guard();
drop trigger if exists trg_supp_cur_combo on public.contact_suppression_current;
create trigger trg_supp_cur_combo before insert or update on public.contact_suppression_current for each row execute function public._suppression_combo_guard();

-- ---------- 8) Unsubscribe token ----------
create table if not exists public.unsubscribe_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, scope public.suppression_scope not null, consent_epoch bigint not null,
  token_hash text not null unique, created_at timestamptz not null default now(),
  expires_at timestamptz, used_at timestamptz, revoked boolean not null default false
);

-- ---------- 9) Anon consent + privacy config ----------
create table if not exists public.app_privacy_config (
  id int primary key default 1 check (id=1),
  anon_ttl_days int check (anon_ttl_days is null or anon_ttl_days between 1 and 3650),
  updated_at timestamptz not null default now(), updated_by uuid
);
insert into public.app_privacy_config(id) values (1) on conflict do nothing;
create table if not exists public.anon_consent_subject (
  subject_id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null, merged_user_id uuid, merged_at timestamptz
);
create table if not exists public.anon_consent_events (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.anon_consent_subject(subject_id),
  purpose public.consent_purpose not null check (purpose in ('analytics_storage','advertising_storage')),
  action text not null check (action in ('granted','withdrawn')),
  text_version_id uuid references public.consent_text_versions(id),
  source public.consent_source not null, request_id text not null, idempotency_key uuid not null,
  occurred_at timestamptz not null default now()
);
create table if not exists public.anon_consent_current (
  subject_id uuid not null references public.anon_consent_subject(subject_id),
  purpose public.consent_purpose not null check (purpose in ('analytics_storage','advertising_storage')),
  state public.consent_state not null default 'unknown', last_event_id uuid,
  updated_at timestamptz not null default now(), primary key (subject_id, purpose)
);

-- ---------- 10) Marketing config + readiness attestation (kapalı şema) ----------
create table if not exists public.marketing_config (
  id int primary key default 1 check (id=1),
  marketing_enabled boolean not null default false,
  marketing_capture_enabled boolean not null default false,
  active_controller_version_id uuid references public.controller_identity_versions(id),
  updated_at timestamptz not null default now(), updated_by uuid
);
insert into public.marketing_config(id) values (1) on conflict do nothing;

create table if not exists public.readiness_attestations (
  id uuid primary key default gen_random_uuid(),
  domain public.readiness_domain not null, condition public.readiness_condition not null,
  actor uuid not null, evidence_ref text not null check (evidence_ref ~ '^[A-Za-z0-9:_./#-]{1,200}$'),
  attested_at timestamptz not null default now(), expires_at timestamptz,
  revokes_attestation_id uuid references public.readiness_attestations(id)
);
create unique index if not exists ux_readiness_one_revoke on public.readiness_attestations (revokes_attestation_id) where revokes_attestation_id is not null;  -- düzeltme #11
-- domain×condition allowlist + expires kontrolü (düzeltme #11)
create or replace function public._readiness_combo_ok(p_domain public.readiness_domain, p_cond public.readiness_condition)
returns boolean language sql immutable as $fn$
  select case p_domain
    when 'marketing' then p_cond in ('mersis_business','iys_application','iys_sync_method','brand_docs','dns_spf_dkim_dmarc','resend_domain_verified','bounce_complaint_webhook','sender_identity','legal_signoff','allowlist_test')
    when 'marketing_capture' then p_cond in ('mersis_business','legal_signoff','brand_docs')
    when 'service_delivery' then p_cond in ('resend_domain_verified','dns_spf_dkim_dmarc','sender_identity','reply_to_support','processor_transfer_assessment','allowlist_test')
    else false end;
$fn$;
revoke all on function public._readiness_combo_ok(public.readiness_domain,public.readiness_condition) from public, anon, authenticated;
create or replace function public._readiness_attestation_biu() returns trigger language plpgsql as $fn$
begin
  if new.revokes_attestation_id is null then
    if not public._readiness_combo_ok(new.domain,new.condition) then raise exception 'readiness_combo_not_allowed:%/%', new.domain,new.condition; end if;
  end if;
  if new.expires_at is not null and new.expires_at<=now() then raise exception 'readiness_expires_in_past'; end if;
  return new;
end $fn$;
revoke all on function public._readiness_attestation_biu() from public, anon, authenticated;
drop trigger if exists trg_readiness_biu on public.readiness_attestations;
create trigger trg_readiness_biu before insert on public.readiness_attestations for each row execute function public._readiness_attestation_biu();

-- ---------- 11) 0C idempotency defteri ----------
create table if not exists public.consent_write_ops (
  idempotency_key uuid primary key, actor uuid not null, action text not null,
  fingerprint text not null, result jsonb, created_at timestamptz not null default now()
);

-- =====================================================================
-- 12) Vault pepper + HMAC
-- =====================================================================
do $$ declare v int; begin
  select count(*) into v from vault.secrets where name='cdp3c_contact_pepper_v1';
  if v=0 then perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'cdp3c_contact_pepper_v1','CDP-3C contact HMAC pepper v1'); end if;
end $$;
create or replace function public._contact_hmac(p_contact text, p_pepper_version int default 1)
returns text language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare v_pepper text; begin
  select decrypted_secret into v_pepper from vault.decrypted_secrets where name='cdp3c_contact_pepper_v'||p_pepper_version;
  if v_pepper is null then raise exception 'pepper_missing'; end if;
  return encode(extensions.hmac(convert_to(lower(trim(coalesce(p_contact,''))),'UTF8'), convert_to(v_pepper,'UTF8'),'sha256'),'hex');
end $fn$;

-- =====================================================================
-- RLS deny-all/force + helper EXECUTE kapatma
-- =====================================================================
do $$ declare t text; begin
  foreach t in array array[
    'controller_identity_versions','consent_purpose_doc','consent_text_versions','consent_text_approvals','legal_notice_events',
    'member_consent_events','member_consent_current','member_service_pref_events','member_service_pref_current',
    'service_pref_defaults','contact_suppression_events','contact_suppression_current','unsubscribe_tokens',
    'app_privacy_config','anon_consent_subject','anon_consent_events','anon_consent_current',
    'marketing_config','readiness_attestations','consent_write_ops'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on function public._consent_text_biu() from public, anon, authenticated;
revoke all on function public._consent_text_immutable() from public, anon, authenticated;
revoke all on function public._controller_biu() from public, anon, authenticated;
revoke all on function public._controller_immutable() from public, anon, authenticated;
revoke all on function public._contact_hmac(text,int) from public, anon, authenticated;

-- append-only guard
create or replace function public._append_only_guard() returns trigger language plpgsql as $fn$
begin raise exception 'append_only_%', TG_TABLE_NAME; end $fn$;
revoke all on function public._append_only_guard() from public, anon, authenticated;
do $$ declare t text; begin
  foreach t in array array['member_consent_events','member_service_pref_events','contact_suppression_events',
                           'anon_consent_events','legal_notice_events','readiness_attestations'] loop
    execute format('drop trigger if exists trg_append_only on public.%I', t);
    execute format('create trigger trg_append_only before update or delete on public.%I for each row execute function public._append_only_guard()', t);
  end loop;
end $$;

-- =====================================================================
-- Yardımcılar
-- =====================================================================
create or replace function public._is_capture_gated(p public.consent_purpose) returns boolean language sql immutable as $fn$
  select p in ('email_marketing','sms_marketing','push_marketing','advertising_storage','on_site_personalized_messages','personalization_profiling');
$fn$;
revoke all on function public._is_capture_gated(public.consent_purpose) from public, anon, authenticated;

create or replace function public._require_request_id(p text) returns text language plpgsql immutable as $fn$
declare v text := btrim(coalesce(p,'')); begin
  if length(v)=0 or length(v)>80 then raise exception 'request_id_required'; end if; return v;
end $fn$;
revoke all on function public._require_request_id(text) from public, anon, authenticated;

create or replace function public._consent_idem_check(p_idem uuid, p_actor uuid, p_action text, p_fp text)
returns jsonb language plpgsql security definer set search_path=public as $fn$
declare v record; begin
  select * into v from public.consent_write_ops where idempotency_key=p_idem;
  if found then
    if v.actor<>p_actor or v.action<>p_action or v.fingerprint<>p_fp then raise exception 'idempotency_conflict'; end if;
    return coalesce(v.result,'{"ok":true,"replay":true}'::jsonb);
  end if; return null;
end $fn$;
revoke all on function public._consent_idem_check(uuid,uuid,text,text) from public, anon, authenticated;

create or replace function public._readiness_attested(p_domain public.readiness_domain, p_cond public.readiness_condition)
returns boolean language sql stable security definer set search_path=public as $fn$
  select exists (select 1 from public.readiness_attestations a
    where a.domain=p_domain and a.condition=p_cond and a.revokes_attestation_id is null
      and (a.expires_at is null or a.expires_at>now())
      and not exists (select 1 from public.readiness_attestations r where r.revokes_attestation_id=a.id));
$fn$;
revoke all on function public._readiness_attested(public.readiness_domain,public.readiness_condition) from public, anon, authenticated;

-- Readiness ENFORCEMENT helper'ları (missing text[]; soft-down KORUR — düzeltme #4)
create or replace function public._marketing_capture_missing() returns text[] language plpgsql stable security definer set search_path=public as $fn$
declare m text[] := array[]::text[]; v_ctrl uuid;
begin
  select active_controller_version_id into v_ctrl from public.marketing_config where id=1;
  if v_ctrl is null or not exists(select 1 from public.controller_identity_versions where id=v_ctrl and controller_type='legal_entity' and is_active) then m:=array_append(m,'active_legal_entity_controller'); end if;
  if not exists(select 1 from public.consent_text_versions where doc_type='acik_riza_marketing' and is_active and controller_version_id=v_ctrl) then m:=array_append(m,'marketing_consent_text_bound_to_controller'); end if;
  if not public._readiness_attested('marketing_capture','legal_signoff') then m:=array_append(m,'legal_signoff'); end if;
  return m;
end $fn$;
revoke all on function public._marketing_capture_missing() from public, anon, authenticated;

create or replace function public._marketing_missing() returns text[] language plpgsql stable security definer set search_path=public as $fn$
declare m text[] := array[]::text[]; v_ctrl uuid; c public.readiness_condition;
begin
  select active_controller_version_id into v_ctrl from public.marketing_config where id=1;
  if v_ctrl is null or not exists(select 1 from public.controller_identity_versions where id=v_ctrl and controller_type='legal_entity' and is_active) then m:=array_append(m,'active_legal_entity_controller'); end if;
  if not exists(select 1 from public.consent_text_versions where doc_type='kvkk_aydinlatma' and is_active and controller_version_id=v_ctrl) then m:=array_append(m,'kvkk_text_bound_to_controller'); end if;
  if not exists(select 1 from public.consent_text_versions where doc_type='acik_riza_marketing' and is_active and controller_version_id=v_ctrl) then m:=array_append(m,'marketing_consent_text_bound_to_controller'); end if;
  foreach c in array array['mersis_business','iys_application','iys_sync_method','brand_docs','dns_spf_dkim_dmarc','resend_domain_verified','bounce_complaint_webhook','sender_identity','legal_signoff','allowlist_test']::public.readiness_condition[] loop
    if not public._readiness_attested('marketing',c) then m:=array_append(m, c::text); end if;
  end loop;
  return m;
end $fn$;
revoke all on function public._marketing_missing() from public, anon, authenticated;

create or replace function public._service_delivery_missing() returns text[] language plpgsql stable security definer set search_path=public as $fn$
declare m text[] := array[]::text[]; v_ctrl uuid; c public.readiness_condition;
begin
  select active_controller_version_id into v_ctrl from public.marketing_config where id=1;
  if not exists(select 1 from public.consent_text_versions where doc_type='kvkk_aydinlatma' and is_active and controller_version_id=v_ctrl) then m:=array_append(m,'kvkk_text_bound_to_controller'); end if;
  foreach c in array array['resend_domain_verified','dns_spf_dkim_dmarc','sender_identity','reply_to_support','processor_transfer_assessment','allowlist_test']::public.readiness_condition[] loop
    if not public._readiness_attested('service_delivery',c) then m:=array_append(m, c::text); end if;
  end loop;
  return m;
end $fn$;
revoke all on function public._service_delivery_missing() from public, anon, authenticated;

-- Public readiness okuma (JSON) — soft-down bunları DÜŞÜRÜR; helper'lar kalır
create or replace function public.marketing_capture_readiness_check() returns jsonb language sql stable security definer set search_path=public as $fn$
  select jsonb_build_object('ready', array_length(public._marketing_capture_missing(),1) is null, 'missing', to_jsonb(public._marketing_capture_missing()));
$fn$;
revoke all on function public.marketing_capture_readiness_check() from public, anon, authenticated;
grant execute on function public.marketing_capture_readiness_check() to service_role;
create or replace function public.marketing_readiness_check() returns jsonb language sql stable security definer set search_path=public as $fn$
  select jsonb_build_object('ready', array_length(public._marketing_missing(),1) is null, 'missing', to_jsonb(public._marketing_missing()));
$fn$;
revoke all on function public.marketing_readiness_check() from public, anon, authenticated;
grant execute on function public.marketing_readiness_check() to service_role;
create or replace function public.service_delivery_readiness_check() returns jsonb language sql stable security definer set search_path=public as $fn$
  select jsonb_build_object('ready', array_length(public._service_delivery_missing(),1) is null, 'missing', to_jsonb(public._service_delivery_missing()));
$fn$;
revoke all on function public.service_delivery_readiness_check() from public, anon, authenticated;
grant execute on function public.service_delivery_readiness_check() to service_role;

-- =====================================================================
-- Marketing hard-gate + pointer invariant DB TRIGGER (service_role dahil; düzeltme #10/#13)
-- =====================================================================
create or replace function public._marketing_config_guard() returns trigger language plpgsql as $fn$
begin
  if TG_OP='UPDATE' then
    if new.marketing_enabled and not old.marketing_enabled then
      if array_length(public._marketing_missing(),1) is not null then raise exception 'marketing_enable_readiness_incomplete'; end if;
    end if;
    if new.marketing_capture_enabled and not old.marketing_capture_enabled then
      if array_length(public._marketing_capture_missing(),1) is not null then raise exception 'marketing_capture_readiness_incomplete'; end if;
    end if;
    -- pointer daima aktif controller'a işaret etmeli (drift yasak; düzeltme #9)
    if new.active_controller_version_id is not null and new.active_controller_version_id is distinct from old.active_controller_version_id then
      if not exists(select 1 from public.controller_identity_versions where id=new.active_controller_version_id and is_active and is_published) then raise exception 'active_controller_pointer_must_be_active'; end if;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public._marketing_config_guard() from public, anon, authenticated;
drop trigger if exists trg_marketing_config_guard on public.marketing_config;
create trigger trg_marketing_config_guard before update on public.marketing_config for each row execute function public._marketing_config_guard();

-- ÇİFT-YÖNLÜ authoritative invariant (DEFERRABLE; atomik RPC içi geçici state'e izin verir; düzeltme #5)
--   * pointer null değilse tam olarak aktif+yayımlı controller'a işaret eder,
--   * aktif controller tam olarak pointer,
--   * aktif consent text yalnız pointer controller'a bağlı olabilir.
-- Doğrudan service_role deactivation'ı bile COMMIT'te (veya SET CONSTRAINTS IMMEDIATE) yakalanır.
-- marketing_config singleton: DELETE YASAK; tek satır (id=1) PK+CHECK ile zaten sabit (düzeltme #1)
create or replace function public._marketing_config_no_delete() returns trigger language plpgsql as $fn$
begin raise exception 'marketing_config_singleton_immutable'; end $fn$;
revoke all on function public._marketing_config_no_delete() from public, anon, authenticated;
drop trigger if exists trg_marketing_config_no_delete on public.marketing_config;
create trigger trg_marketing_config_no_delete before delete on public.marketing_config for each row execute function public._marketing_config_no_delete();

create or replace function public._authoritative_consistency() returns trigger language plpgsql as $fn$
declare ptr uuid; n_ctrl int; n_cfg int;
begin
  select count(*) into n_cfg from public.marketing_config where id=1;
  if n_cfg<>1 then raise exception 'marketing_config_singleton_missing'; end if;   -- tam bir singleton (düzeltme #1)
  select active_controller_version_id into ptr from public.marketing_config where id=1;
  select count(*) into n_ctrl from public.controller_identity_versions where is_active;
  if ptr is null then
    if n_ctrl<>0 then raise exception 'active_controller_without_pointer'; end if;
    if exists(select 1 from public.consent_text_versions where is_active) then raise exception 'active_text_without_pointer'; end if;
  else
    if not exists(select 1 from public.controller_identity_versions where id=ptr and is_active and is_published) then raise exception 'pointer_not_active_published'; end if;
    if n_ctrl<>1 then raise exception 'active_controller_must_equal_pointer'; end if;
    if exists(select 1 from public.consent_text_versions where is_active and controller_version_id<>ptr) then raise exception 'active_text_not_bound_to_pointer'; end if;
  end if;
  return null;
end $fn$;
revoke all on function public._authoritative_consistency() from public, anon, authenticated;
drop trigger if exists trg_auth_consistency_ctrl on public.controller_identity_versions;
create constraint trigger trg_auth_consistency_ctrl after insert or update or delete on public.controller_identity_versions deferrable initially deferred for each row execute function public._authoritative_consistency();
drop trigger if exists trg_auth_consistency_mc on public.marketing_config;
create constraint trigger trg_auth_consistency_mc after insert or update or delete on public.marketing_config deferrable initially deferred for each row execute function public._authoritative_consistency();
drop trigger if exists trg_auth_consistency_txt on public.consent_text_versions;
create constraint trigger trg_auth_consistency_txt after insert or update or delete on public.consent_text_versions deferrable initially deferred for each row execute function public._authoritative_consistency();

-- =====================================================================
-- KULLANICI RPC'leri (authenticated)
-- =====================================================================
create or replace function public.consent_get_my_state()
returns jsonb language plpgsql security definer set search_path=public as $fn$
declare v_uid uuid := auth.uid(); v_consent jsonb; v_prefs jsonb;
begin
  if v_uid is null then raise exception 'no_auth'; end if;
  select coalesce(jsonb_object_agg(purpose, jsonb_build_object('state',state,'text_version_id',text_version_id,'epoch',consent_epoch)),'{}'::jsonb)
    into v_consent from public.member_consent_current where user_id=v_uid;
  select coalesce(jsonb_object_agg(d.pref_key,
           case when c.user_id is not null then to_jsonb(c.enabled)
                when d.default_enabled is not null then to_jsonb(d.default_enabled)
                else to_jsonb('config_pending'::text) end),'{}'::jsonb)
    into v_prefs from public.service_pref_defaults d
    left join public.member_service_pref_current c on c.user_id=v_uid and c.pref_key=d.pref_key;
  return jsonb_build_object('consent',v_consent,'service_prefs',v_prefs);
end $fn$;
revoke all on function public.consent_get_my_state() from public, anon;
grant execute on function public.consent_get_my_state() to authenticated;

create or replace function public._consent_set_internal(
  p_uid uuid, p_purpose public.consent_purpose, p_grant boolean, p_text_version_id uuid, p_locale text,
  p_source public.consent_source, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_epoch bigint; v_evid uuid; v_supp uuid; v_state public.consent_state;
  v_doc public.consent_doc_type; v_ctrl uuid; v_ok boolean; v_email text; v_hmac text; v_rid text;
begin
  if p_uid is null then raise exception 'no_auth'; end if;
  v_rid := public._require_request_id(p_request_id);
  if p_idem is null then raise exception 'idem_required'; end if;
  if (not p_grant) and p_text_version_id is not null then raise exception 'withdraw_text_version_must_be_null'; end if;
  if p_purpose in ('analytics_storage','advertising_storage') and p_source <> 'cookie_banner' then raise exception 'cookie_purpose_requires_cookie_banner'; end if;

  v_fp := encode(extensions.digest(convert_to(p_uid::text||p_purpose::text||p_grant::text||coalesce(p_text_version_id::text,'')||coalesce(p_locale,'')||p_source::text,'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_uid,'consent_set',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_uid::text||'|'||p_purpose::text, 0));
  v_prev := public._consent_idem_check(p_idem,p_uid,'consent_set',v_fp); if v_prev is not null then return v_prev; end if;

  if p_grant then
    if public._is_capture_gated(p_purpose) then
      if not (select marketing_capture_enabled from public.marketing_config where id=1) then raise exception 'marketing_capture_disabled'; end if;
    end if;
    select doc_type into v_doc from public.consent_purpose_doc where purpose=p_purpose;
    select active_controller_version_id into v_ctrl from public.marketing_config where id=1;
    if v_ctrl is null then raise exception 'no_active_controller'; end if;
    select (ct.is_active and ct.is_published and ct.doc_type=v_doc and ct.locale=coalesce(p_locale,'tr') and ct.controller_version_id=v_ctrl)
      into v_ok from public.consent_text_versions ct where ct.id=p_text_version_id;
    if v_ok is distinct from true then raise exception 'invalid_or_stale_consent_version'; end if;
    v_state := 'granted';
  else v_state := 'denied'; end if;

  select coalesce(max(consent_epoch),1) + case when p_grant then 1 else 0 end into v_epoch
    from public.member_consent_events where user_id=p_uid and purpose=p_purpose;

  insert into public.member_consent_events(user_id,purpose,action,text_version_id,text_content_hash,consent_epoch,source,request_id,idempotency_key,fingerprint)
  values (p_uid,p_purpose, case when p_grant then 'granted' else 'withdrawn' end,
          case when p_grant then p_text_version_id else null end,
          case when p_grant then (select content_hash from public.consent_text_versions where id=p_text_version_id) else null end,
          v_epoch, p_source, v_rid, p_idem, v_fp) returning id into v_evid;

  insert into public.member_consent_current as m (user_id,purpose,state,text_version_id,consent_epoch,source,last_event_id,updated_at)
  values (p_uid,p_purpose,v_state, case when p_grant then p_text_version_id else null end, v_epoch, p_source, v_evid, now())
  on conflict (user_id,purpose) do update set state=excluded.state, text_version_id=excluded.text_version_id,
     consent_epoch=excluded.consent_epoch, source=excluded.source, last_event_id=excluded.last_event_id, updated_at=now();

  if p_purpose='email_marketing' then
    select lower(trim(email)) into v_email from public.members where user_id=p_uid;
    if v_email is null or v_email='' then raise exception 'contact_email_unresolved_for_suppression'; end if;
    v_hmac := public._contact_hmac(v_email, 1);
    if not p_grant then
      insert into public.contact_suppression_events(channel,scope,contact_hmac,pepper_version,reason,action,source,request_id,idempotency_key,fingerprint)
      values ('email','marketing',v_hmac,1,'user_unsubscribe','suppress',p_source,v_rid,p_idem,v_fp) returning id into v_supp;
      insert into public.contact_suppression_current(channel,contact_hmac,scope,reason,pepper_version,status,source_event_id,updated_at)
      values ('email',v_hmac,'marketing','user_unsubscribe',1,'active',v_supp,now())
      on conflict (channel,contact_hmac,scope,reason) do update set status='active',source_event_id=v_supp,superseded_at=null,superseded_by=null,updated_at=now();
    else
      if exists(select 1 from public.contact_suppression_current where channel='email' and contact_hmac=v_hmac and scope='marketing' and reason='user_unsubscribe' and status='active') then
        insert into public.contact_suppression_events(channel,scope,contact_hmac,pepper_version,reason,action,supersede_evidence,source,request_id,idempotency_key,fingerprint)
        values ('email','marketing',v_hmac,1,'user_unsubscribe','supersede', jsonb_build_object('consent_epoch',v_epoch), p_source,v_rid,p_idem,v_fp) returning id into v_supp;
        update public.contact_suppression_current set status='superseded', superseded_at=now(), superseded_by=v_supp, updated_at=now()
          where channel='email' and contact_hmac=v_hmac and scope='marketing' and reason='user_unsubscribe' and status='active';
      end if;
    end if;
  end if;

  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result)
  values (p_idem,p_uid,'consent_set',v_fp, jsonb_build_object('ok',true,'purpose',p_purpose,'state',v_state,'epoch',v_epoch));
  return jsonb_build_object('ok',true,'purpose',p_purpose,'state',v_state,'epoch',v_epoch);
end $fn$;
revoke all on function public._consent_set_internal(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid) from public, anon, authenticated;

create or replace function public.consent_set_pref_center(p_purpose public.consent_purpose, p_grant boolean, p_text_version_id uuid, p_locale text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public as $fn$
begin
  if p_purpose in ('analytics_storage','advertising_storage') then raise exception 'analytics_managed_by_cookie_flow'; end if;
  return public._consent_set_internal(auth.uid(), p_purpose, p_grant, p_text_version_id, coalesce(p_locale,'tr'), 'pref_center', p_request_id, p_idem);
end $fn$;
revoke all on function public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid) from public, anon;
grant execute on function public.consent_set_pref_center(public.consent_purpose,boolean,uuid,text,text,uuid) to authenticated;

create or replace function public.consent_set_via_flow(p_uid uuid, p_purpose public.consent_purpose, p_grant boolean, p_text_version_id uuid, p_locale text, p_source public.consent_source, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public as $fn$
begin
  if p_source not in ('signup','cookie_banner','unsubscribe','system') then raise exception 'bad_flow_source'; end if;
  if p_source='unsubscribe' and p_grant then raise exception 'unsubscribe_is_withdraw_only'; end if;
  if p_source='cookie_banner' and p_purpose not in ('analytics_storage','advertising_storage') then raise exception 'cookie_banner_purpose_only'; end if;
  if p_source='signup' and p_grant and public._is_capture_gated(p_purpose) then raise exception 'signup_cannot_grant_marketing'; end if;
  if p_source='system' and p_grant then raise exception 'system_cannot_grant'; end if;
  return public._consent_set_internal(p_uid, p_purpose, p_grant, p_text_version_id, coalesce(p_locale,'tr'), p_source, p_request_id, p_idem);
end $fn$;
revoke all on function public.consent_set_via_flow(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid) from public, anon, authenticated;
grant execute on function public.consent_set_via_flow(uuid,public.consent_purpose,boolean,uuid,text,public.consent_source,text,uuid) to service_role;

create or replace function public.service_pref_set(p_key public.service_pref_key, p_enabled boolean, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_uid uuid := auth.uid(); v_fp text; v_prev jsonb; v_evid uuid; v_rid text;
begin
  if v_uid is null then raise exception 'no_auth'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  v_fp := encode(extensions.digest(convert_to(v_uid::text||p_key::text||p_enabled::text,'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,v_uid,'service_pref_set',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text||'|'||p_key::text,0));
  v_prev := public._consent_idem_check(p_idem,v_uid,'service_pref_set',v_fp); if v_prev is not null then return v_prev; end if;
  insert into public.member_service_pref_events(user_id,pref_key,enabled,source,request_id,idempotency_key,fingerprint)
  values (v_uid,p_key,p_enabled,'pref_center',v_rid,p_idem,v_fp) returning id into v_evid;
  insert into public.member_service_pref_current(user_id,pref_key,enabled,last_event_id,updated_at)
  values (v_uid,p_key,p_enabled,v_evid,now())
  on conflict (user_id,pref_key) do update set enabled=excluded.enabled,last_event_id=excluded.last_event_id,updated_at=now();
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,v_uid,'service_pref_set',v_fp,jsonb_build_object('ok',true,'key',p_key,'enabled',p_enabled));
  return jsonb_build_object('ok',true,'key',p_key,'enabled',p_enabled);
end $fn$;
revoke all on function public.service_pref_set(public.service_pref_key,boolean,text,uuid) from public, anon;
grant execute on function public.service_pref_set(public.service_pref_key,boolean,text,uuid) to authenticated;

-- Legal notice (typed subject; 0C; consent üretmez; düzeltme #6)
create or replace function public.legal_notice_record(p_subject_kind public.legal_subject_kind, p_subject_id uuid, p_doc_type public.consent_doc_type, p_text_version_id uuid, p_source public.consent_source, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_ctrl uuid; v_ok boolean; v_rid text; v_fp text; v_prev jsonb;
begin
  if p_subject_id is null then raise exception 'subject_id_required'; end if;
  if p_source not in ('signup','cookie_banner','pref_center','system') then raise exception 'bad_notice_source'; end if;
  -- STATİK subject_kind×source matrisi (durum DEĞİL; düzeltme #8)
  if p_subject_kind='member_uid' then
    if p_source not in ('signup','pref_center','system') then raise exception 'notice_source_not_allowed_for_subject'; end if;
  elsif p_subject_kind='anon_subject' then
    if p_source not in ('cookie_banner','system') then raise exception 'notice_source_not_allowed_for_subject'; end if;
  else raise exception 'notice_subject_kind_invalid'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  v_fp := encode(extensions.digest(convert_to('legal_notice|'||p_subject_kind::text||'|'||p_subject_id::text||'|'||p_doc_type::text||'|'||coalesce(p_text_version_id::text,'')||'|'||p_source::text,'UTF8'),'sha256'),'hex');
  -- IDEM ÖNCE: aynı idem+payload, subject sonradan merge/expire olsa bile ÖNCEKİ sonucu döner (düzeltme #2)
  v_prev := public._consent_idem_check(p_idem,p_subject_id,'legal_notice_record',v_fp); if v_prev is not null then return v_prev; end if;
  -- anon → consent/merge ile AYNI subject-level lock; member → member lock
  if p_subject_kind='anon_subject' then perform pg_advisory_xact_lock(hashtextextended('anon_subject|'||p_subject_id::text,0));
  else perform pg_advisory_xact_lock(hashtextextended('legal_notice_member|'||p_subject_id::text,0)); end if;
  v_prev := public._consent_idem_check(p_idem,p_subject_id,'legal_notice_record',v_fp); if v_prev is not null then return v_prev; end if;
  -- DURUM kontrolü LOCK SONRASI (varlık/expiry/merged yeniden okunur)
  if p_subject_kind='member_uid' then
    if not exists(select 1 from public.members where user_id=p_subject_id) then raise exception 'notice_member_not_found'; end if;
  else
    if not exists(select 1 from public.anon_consent_subject s where s.subject_id=p_subject_id and s.merged_user_id is null and s.expires_at>now()) then raise exception 'notice_anon_subject_invalid'; end if;
  end if;
  select active_controller_version_id into v_ctrl from public.marketing_config where id=1;
  if v_ctrl is null then raise exception 'no_active_controller'; end if;
  select (is_active and is_published and doc_type=p_doc_type and controller_version_id=v_ctrl) into v_ok from public.consent_text_versions where id=p_text_version_id;
  if v_ok is distinct from true then raise exception 'invalid_or_stale_notice_version'; end if;
  insert into public.legal_notice_events(subject_kind,subject_id,doc_type,text_version_id,controller_version_id,presented_at,source,request_id,idempotency_key)
  values (p_subject_kind,p_subject_id,p_doc_type,p_text_version_id,v_ctrl,now(),p_source,v_rid,p_idem);
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_subject_id,'legal_notice_record',v_fp,jsonb_build_object('ok',true));
  return jsonb_build_object('ok',true);
end $fn$;
revoke all on function public.legal_notice_record(public.legal_subject_kind,uuid,public.consent_doc_type,uuid,public.consent_source,text,uuid) from public, anon, authenticated;
grant execute on function public.legal_notice_record(public.legal_subject_kind,uuid,public.consent_doc_type,uuid,public.consent_source,text,uuid) to service_role;

-- =====================================================================
-- ANON consent
-- =====================================================================
-- anon subject oluşturma: 0C (request_id+idem) — network retry mükerrer subject ÜRETMEZ (düzeltme #7)
create or replace function public.anon_subject_create(p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_ttl int; v_id uuid; v_rid text; v_fp text; v_prev jsonb; v_sys uuid := '00000000-0000-0000-0000-000000000002';
begin
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  v_fp := encode(extensions.digest(convert_to('anon_subject_create|'||v_rid,'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem, v_sys, 'anon_subject_create', v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('anon_subject_create|'||p_idem::text,0));
  v_prev := public._consent_idem_check(p_idem, v_sys, 'anon_subject_create', v_fp); if v_prev is not null then return v_prev; end if;
  select anon_ttl_days into v_ttl from public.app_privacy_config where id=1;
  if v_ttl is null then raise exception 'anon_ttl_not_configured'; end if;
  insert into public.anon_consent_subject(expires_at) values (now() + make_interval(days => v_ttl)) returning subject_id into v_id;
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,v_sys,'anon_subject_create',v_fp, jsonb_build_object('ok',true,'subject_id',v_id));
  return jsonb_build_object('ok',true,'subject_id',v_id);
end $fn$;
revoke all on function public.anon_subject_create(text,uuid) from public, anon, authenticated;
grant execute on function public.anon_subject_create(text,uuid) to service_role;

create or replace function public.anon_consent_set(p_subject uuid, p_purpose public.consent_purpose, p_grant boolean, p_text_version_id uuid, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_evid uuid; v_rid text; v_exp timestamptz; v_merged uuid; v_ctrl uuid; v_ok boolean; v_doc public.consent_doc_type;
begin
  if p_purpose not in ('analytics_storage','advertising_storage') then raise exception 'anon_purpose_not_allowed'; end if;
  if (not p_grant) and p_text_version_id is not null then raise exception 'withdraw_text_version_must_be_null'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_subject::text||p_purpose::text||p_grant::text||coalesce(p_text_version_id::text,''),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_subject,'anon_consent_set',v_fp); if v_prev is not null then return v_prev; end if;
  -- SUBJECT-level lock (merge ile AYNI) + lock SONRASI durum yeniden okunur (düzeltme #4 race)
  perform pg_advisory_xact_lock(hashtextextended('anon_subject|'||p_subject::text,0));
  v_prev := public._consent_idem_check(p_idem,p_subject,'anon_consent_set',v_fp); if v_prev is not null then return v_prev; end if;
  select expires_at, merged_user_id into v_exp, v_merged from public.anon_consent_subject where subject_id=p_subject for update;
  if v_exp is null then raise exception 'anon_subject_not_found'; end if;
  if v_merged is not null then raise exception 'anon_subject_merged'; end if;   -- merge kazandıysa consent yazılamaz
  if v_exp <= now() then raise exception 'anon_subject_expired'; end if;
  if p_grant then   -- metin doğrulama: aktif+yayımlı+cerez_politikasi+purpose mapping+aktif controller (düzeltme #8)
    select doc_type into v_doc from public.consent_purpose_doc where purpose=p_purpose;
    select active_controller_version_id into v_ctrl from public.marketing_config where id=1;
    if v_ctrl is null then raise exception 'no_active_controller'; end if;
    select (is_active and is_published and doc_type=v_doc and controller_version_id=v_ctrl) into v_ok from public.consent_text_versions where id=p_text_version_id;
    if v_ok is distinct from true then raise exception 'invalid_or_stale_consent_version'; end if;
  end if;
  insert into public.anon_consent_events(subject_id,purpose,action,text_version_id,source,request_id,idempotency_key)
  values (p_subject,p_purpose, case when p_grant then 'granted' else 'withdrawn' end, case when p_grant then p_text_version_id else null end, 'cookie_banner', v_rid, p_idem) returning id into v_evid;
  insert into public.anon_consent_current(subject_id,purpose,state,last_event_id,updated_at)
  values (p_subject,p_purpose, (case when p_grant then 'granted' else 'denied' end)::public.consent_state, v_evid, now())
  on conflict (subject_id,purpose) do update set state=excluded.state,last_event_id=excluded.last_event_id,updated_at=now();
  update public.anon_consent_subject set last_seen_at=now() where subject_id=p_subject;
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_subject,'anon_consent_set',v_fp,jsonb_build_object('ok',true));
  return jsonb_build_object('ok',true,'purpose',p_purpose,'state', case when p_grant then 'granted' else 'denied' end);
end $fn$;
revoke all on function public.anon_consent_set(uuid,public.consent_purpose,boolean,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.anon_consent_set(uuid,public.consent_purpose,boolean,uuid,text,uuid) to service_role;

-- login merge: 0C + hedef kullanıcı doğrulama + conflict; marketing grant TAŞIMAZ (düzeltme #7)
create or replace function public.anon_merge_into_user(p_subject uuid, p_user uuid, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_rid text; v_exp timestamptz; v_merged uuid; v_fp text; v_prev jsonb;
begin
  if p_user is null then raise exception 'user_required'; end if;
  if not exists(select 1 from public.members where user_id=p_user) then raise exception 'target_user_not_found'; end if;   -- düzeltme #7
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  v_fp := encode(extensions.digest(convert_to('anon_merge|'||p_subject::text||'|'||p_user::text,'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_user,'anon_merge',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('anon_subject|'||p_subject::text,0));   -- consent_set ile AYNI lock (düzeltme #4)
  v_prev := public._consent_idem_check(p_idem,p_user,'anon_merge',v_fp); if v_prev is not null then return v_prev; end if;
  select expires_at, merged_user_id into v_exp, v_merged from public.anon_consent_subject where subject_id=p_subject for update;
  if v_exp is null then raise exception 'anon_subject_not_found'; end if;
  if v_merged is not null then
    if v_merged<>p_user then raise exception 'anon_subject_merge_conflict'; end if;
    return jsonb_build_object('ok',true,'replay',true);
  end if;
  if v_exp <= now() then raise exception 'anon_subject_expired'; end if;
  update public.anon_consent_subject set merged_user_id=p_user, merged_at=now(), last_seen_at=now() where subject_id=p_subject;
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_user,'anon_merge',v_fp,jsonb_build_object('ok',true,'no_grant_transferred',true));
  return jsonb_build_object('ok',true,'no_grant_transferred',true);
end $fn$;
revoke all on function public.anon_merge_into_user(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.anon_merge_into_user(uuid,uuid,text,uuid) to service_role;

-- =====================================================================
-- ADMIN RPC'leri
-- =====================================================================
create or replace function public.admin_q_member_consent(p_actor uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $fn$
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin','support','crm'])) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'consent', coalesce((select jsonb_agg(jsonb_build_object('purpose',purpose,'state',state,'text_version_id',text_version_id,'epoch',consent_epoch,'updated_at',updated_at)) from public.member_consent_current where user_id=p_user_id),'[]'::jsonb),
    'consent_timeline', coalesce((select jsonb_agg(jsonb_build_object('purpose',purpose,'action',action,'text_version_id',text_version_id,'source',source,'occurred_at',occurred_at) order by occurred_at) from public.member_consent_events where user_id=p_user_id),'[]'::jsonb),
    'service_prefs', coalesce((select jsonb_agg(jsonb_build_object('key',pref_key,'enabled',enabled,'updated_at',updated_at)) from public.member_service_pref_current where user_id=p_user_id),'[]'::jsonb));
end $fn$;
revoke all on function public.admin_q_member_consent(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_q_member_consent(uuid,uuid) to service_role;

create or replace function public.admin_w_apply_suppression(
  p_actor uuid, p_contact_hmac text, p_channel public.suppression_channel, p_scope public.suppression_scope,
  p_reason public.suppression_reason, p_reason_text text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_evid uuid; v_rid text;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  if p_reason in ('user_unsubscribe','iys_red') then raise exception 'admin_cannot_set_user_reason'; end if;
  if p_contact_hmac !~ '^[0-9a-f]{64}$' then raise exception 'bad_contact_hmac'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason_text),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|apply_suppression|'||p_contact_hmac||'|'||p_channel::text||'|'||p_scope::text||'|'||p_reason::text||'|'||btrim(p_reason_text),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'apply_suppression',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('apply_suppression|'||p_contact_hmac||'|'||p_channel::text||'|'||p_scope::text||'|'||p_reason::text,0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'apply_suppression',v_fp); if v_prev is not null then return v_prev; end if;
  insert into public.contact_suppression_events(channel,scope,contact_hmac,pepper_version,reason,action,source,request_id,idempotency_key,fingerprint)
  values (p_channel,p_scope,p_contact_hmac,1,p_reason,'suppress','system',v_rid,p_idem,v_fp) returning id into v_evid;
  insert into public.contact_suppression_current(channel,contact_hmac,scope,reason,pepper_version,status,source_event_id,updated_at)
  values (p_channel,p_contact_hmac,p_scope,p_reason,1,'active',v_evid,now())
  on conflict (channel,contact_hmac,scope,reason) do update set status='active',source_event_id=v_evid,superseded_at=null,superseded_by=null,updated_at=now();
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'apply_suppression','contact_suppression', p_channel::text||':'||p_scope::text||':'||p_reason::text, '{}'::jsonb, jsonb_build_object('status','active'), p_reason_text, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'apply_suppression',v_fp,jsonb_build_object('ok',true));
  return jsonb_build_object('ok',true);
end $fn$;
revoke all on function public.admin_w_apply_suppression(uuid,text,public.suppression_channel,public.suppression_scope,public.suppression_reason,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_apply_suppression(uuid,text,public.suppression_channel,public.suppression_scope,public.suppression_reason,text,text,uuid) to service_role;

create or replace function public.iys_supersede_red(p_actor uuid, p_contact_hmac text, p_channel public.suppression_channel, p_scope public.suppression_scope, p_iys_sync_ref text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_evid uuid; v_rid text;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  if p_contact_hmac !~ '^[0-9a-f]{64}$' then raise exception 'bad_contact_hmac'; end if;
  if coalesce(btrim(p_iys_sync_ref),'')='' then raise exception 'iys_sync_evidence_required'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|iys_supersede_red|'||p_contact_hmac||'|'||p_channel::text||'|'||p_scope::text||'|'||btrim(p_iys_sync_ref),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'iys_supersede_red',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('iys_supersede_red|'||p_contact_hmac||'|'||p_channel::text||'|'||p_scope::text,0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'iys_supersede_red',v_fp); if v_prev is not null then return v_prev; end if;
  if not exists(select 1 from public.contact_suppression_current where channel=p_channel and scope=p_scope and contact_hmac=p_contact_hmac and reason='iys_red' and status='active') then raise exception 'no_active_iys_red'; end if;
  insert into public.contact_suppression_events(channel,scope,contact_hmac,pepper_version,reason,action,supersede_evidence,source,request_id,idempotency_key,fingerprint)
  values (p_channel,p_scope,p_contact_hmac,1,'iys_red','supersede', jsonb_build_object('iys_sync_ref',p_iys_sync_ref),'iys_sync',v_rid,p_idem,v_fp) returning id into v_evid;
  update public.contact_suppression_current set status='superseded',superseded_at=now(),superseded_by=v_evid,updated_at=now()
    where channel=p_channel and scope=p_scope and contact_hmac=p_contact_hmac and reason='iys_red' and status='active';
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'iys_supersede_red',v_fp,jsonb_build_object('ok',true));
  return jsonb_build_object('ok',true);
end $fn$;
revoke all on function public.iys_supersede_red(uuid,text,public.suppression_channel,public.suppression_scope,text,text,uuid) from public, anon, authenticated;
grant execute on function public.iys_supersede_red(uuid,text,public.suppression_channel,public.suppression_scope,text,text,uuid) to service_role;

create or replace function public.admin_w_set_marketing_enabled(p_actor uuid, p_enabled boolean, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_before boolean; v_fp text; v_prev jsonb; v_rid text;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|set_marketing_enabled|'||p_enabled::text||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_marketing_enabled',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('set_marketing_enabled',0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_marketing_enabled',v_fp); if v_prev is not null then return v_prev; end if;
  select marketing_enabled into v_before from public.marketing_config where id=1 for update;
  if p_enabled and array_length(public._marketing_missing(),1) is not null then raise exception 'marketing_readiness_incomplete: %', to_jsonb(public._marketing_missing()); end if;
  update public.marketing_config set marketing_enabled=p_enabled, updated_at=now(), updated_by=p_actor where id=1;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'set_marketing_enabled','marketing_config','1', jsonb_build_object('enabled',v_before), jsonb_build_object('enabled',p_enabled), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'set_marketing_enabled',v_fp, jsonb_build_object('ok',true,'marketing_enabled',p_enabled));
  return jsonb_build_object('ok',true,'marketing_enabled',p_enabled);
end $fn$;
revoke all on function public.admin_w_set_marketing_enabled(uuid,boolean,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_set_marketing_enabled(uuid,boolean,text,text,uuid) to service_role;

create or replace function public.admin_w_set_marketing_capture_enabled(p_actor uuid, p_enabled boolean, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_before boolean; v_fp text; v_prev jsonb; v_rid text;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|set_marketing_capture|'||p_enabled::text||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_marketing_capture',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('set_marketing_capture',0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_marketing_capture',v_fp); if v_prev is not null then return v_prev; end if;
  select marketing_capture_enabled into v_before from public.marketing_config where id=1 for update;
  if p_enabled and array_length(public._marketing_capture_missing(),1) is not null then raise exception 'marketing_capture_readiness_incomplete: %', to_jsonb(public._marketing_capture_missing()); end if;
  update public.marketing_config set marketing_capture_enabled=p_enabled, updated_at=now(), updated_by=p_actor where id=1;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'set_marketing_capture','marketing_config','1', jsonb_build_object('capture',v_before), jsonb_build_object('capture',p_enabled), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'set_marketing_capture',v_fp, jsonb_build_object('ok',true,'capture',p_enabled));
  return jsonb_build_object('ok',true,'marketing_capture_enabled',p_enabled);
end $fn$;
revoke all on function public.admin_w_set_marketing_capture_enabled(uuid,boolean,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_set_marketing_capture_enabled(uuid,boolean,text,text,uuid) to service_role;

-- Config yönetim RPC'leri — hepsi 0C (lock + post-lock recheck + tam fingerprint); düzeltme #5
create or replace function public.admin_w_add_readiness_attestation(p_actor uuid, p_domain public.readiness_domain, p_condition public.readiness_condition, p_evidence_ref text, p_expires_at timestamptz, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_rid text; v_id uuid;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  if coalesce(btrim(p_evidence_ref),'')='' then raise exception 'evidence_required'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|add_attestation|'||p_domain::text||'|'||p_condition::text||'|'||btrim(p_evidence_ref)||'|'||coalesce(p_expires_at::text,'')||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'add_attestation',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('add_attestation|'||p_domain::text||'|'||p_condition::text,0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'add_attestation',v_fp); if v_prev is not null then return v_prev; end if;
  insert into public.readiness_attestations(domain,condition,actor,evidence_ref,expires_at) values (p_domain,p_condition,p_actor,p_evidence_ref,p_expires_at) returning id into v_id;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'add_readiness_attestation','readiness_attestations',v_id::text,'{}'::jsonb, jsonb_build_object('domain',p_domain,'condition',p_condition,'expires_at',p_expires_at), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'add_attestation',v_fp,jsonb_build_object('ok',true,'id',v_id));
  return jsonb_build_object('ok',true,'id',v_id);
end $fn$;
revoke all on function public.admin_w_add_readiness_attestation(uuid,public.readiness_domain,public.readiness_condition,text,timestamptz,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_add_readiness_attestation(uuid,public.readiness_domain,public.readiness_condition,text,timestamptz,text,text,uuid) to service_role;

create or replace function public.admin_w_revoke_readiness_attestation(p_actor uuid, p_attestation_id uuid, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_rid text; v_id uuid; v_dom public.readiness_domain; v_cond public.readiness_condition;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|revoke_attestation|'||p_attestation_id::text||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'revoke_attestation',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('revoke_attestation|'||p_attestation_id::text,0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'revoke_attestation',v_fp); if v_prev is not null then return v_prev; end if;
  select domain,condition into v_dom,v_cond from public.readiness_attestations where id=p_attestation_id and revokes_attestation_id is null for update;
  if v_dom is null then raise exception 'attestation_not_found_or_is_revoke'; end if;
  insert into public.readiness_attestations(domain,condition,actor,evidence_ref,revokes_attestation_id) values (v_dom,v_cond,p_actor,'revoke:'||p_attestation_id::text,p_attestation_id) returning id into v_id;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'revoke_readiness_attestation','readiness_attestations',p_attestation_id::text, jsonb_build_object('revoked',false), jsonb_build_object('revoked',true), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'revoke_attestation',v_fp,jsonb_build_object('ok',true,'id',v_id));
  return jsonb_build_object('ok',true,'id',v_id);
end $fn$;
revoke all on function public.admin_w_revoke_readiness_attestation(uuid,uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_revoke_readiness_attestation(uuid,uuid,text,text,uuid) to service_role;

create or replace function public.admin_w_set_service_pref_default(p_actor uuid, p_key public.service_pref_key, p_enabled boolean, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_rid text; v_before boolean; v_res jsonb;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|set_pref_default|'||p_key::text||'|'||p_enabled::text||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_pref_default',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('set_pref_default|'||p_key::text,0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_pref_default',v_fp); if v_prev is not null then return v_prev; end if;
  select default_enabled into v_before from public.service_pref_defaults where pref_key=p_key for update;
  update public.service_pref_defaults set default_enabled=p_enabled where pref_key=p_key;
  v_res := jsonb_build_object('ok',true,'key',p_key,'default_enabled',p_enabled);   -- replay==fresh (düzeltme #11)
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'set_service_pref_default','service_pref_defaults',p_key::text, jsonb_build_object('default',v_before), jsonb_build_object('default',p_enabled), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'set_pref_default',v_fp,v_res);
  return v_res;   -- mevcut üye satırlarına BACKFILL YOK
end $fn$;
revoke all on function public.admin_w_set_service_pref_default(uuid,public.service_pref_key,boolean,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_set_service_pref_default(uuid,public.service_pref_key,boolean,text,text,uuid) to service_role;

create or replace function public.admin_w_set_anon_ttl(p_actor uuid, p_days int, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_rid text; v_before int;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  if p_days is null or p_days<1 or p_days>3650 then raise exception 'anon_ttl_out_of_range'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|set_anon_ttl|'||p_days::text||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_anon_ttl',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('set_anon_ttl',0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'set_anon_ttl',v_fp); if v_prev is not null then return v_prev; end if;
  select anon_ttl_days into v_before from public.app_privacy_config where id=1 for update;
  update public.app_privacy_config set anon_ttl_days=p_days, updated_at=now(), updated_by=p_actor where id=1;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'set_anon_ttl','app_privacy_config','1', jsonb_build_object('days',v_before), jsonb_build_object('days',p_days), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'set_anon_ttl',v_fp,jsonb_build_object('ok',true));
  return jsonb_build_object('ok',true,'anon_ttl_days',p_days);
end $fn$;
revoke all on function public.admin_w_set_anon_ttl(uuid,int,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_set_anon_ttl(uuid,int,text,text,uuid) to service_role;

-- Hukuk onayı ekleme (append-only immutable; 0C; düzeltme #10)
create or replace function public.admin_w_approve_consent_text(p_actor uuid, p_text_version_id uuid, p_evidence_ref text, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_rid text; v_hash text; v_id uuid; v_res jsonb;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  if coalesce(btrim(p_evidence_ref),'')='' then raise exception 'evidence_required'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  -- 0C fingerprint IMMUTABLE request-intent'ten (current hash DEĞİL): aynı idem+aynı intent retry → aynı stored result.
  -- İçerik değişirse yeni hash onayı YENİ idem gerektirir (eski idem eski sonucu döner). (düzeltme #5)
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|approve_text|'||p_text_version_id::text||'|'||btrim(p_evidence_ref)||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'approve_text',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('approve_text|'||p_text_version_id::text,0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'approve_text',v_fp); if v_prev is not null then return v_prev; end if;
  -- current hash'i KİLİTLİ satırdan al; onay bu hash'e bağlanır (stale approval yok)
  select content_hash into v_hash from public.consent_text_versions where id=p_text_version_id for update;
  if v_hash is null then raise exception 'consent_text_not_found'; end if;
  insert into public.consent_text_approvals(text_version_id,approver,evidence_ref,approved_content_hash,request_id,idempotency_key)
  values (p_text_version_id,p_actor,p_evidence_ref,v_hash,v_rid,p_idem) returning id into v_id;
  v_res := jsonb_build_object('ok',true,'id',v_id,'approved_hash',v_hash);
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'approve_consent_text','consent_text_versions',p_text_version_id::text,'{}'::jsonb, jsonb_build_object('approved_hash',v_hash), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'approve_text',v_fp,v_res);
  return v_res;
end $fn$;
revoke all on function public.admin_w_approve_consent_text(uuid,uuid,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_approve_consent_text(uuid,uuid,text,text,text,uuid) to service_role;

-- Controller yayımlama/aktivasyon: ATOMİK switch + pointer (düzeltme #9; 0C)
create or replace function public.admin_w_publish_controller_version(p_actor uuid, p_id uuid, p_activate boolean, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_rid text; v_valid_to timestamptz;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|publish_controller|'||p_id::text||'|'||p_activate::text||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'publish_controller',v_fp); if v_prev is not null then return v_prev; end if;
  perform pg_advisory_xact_lock(hashtextextended('publish_controller',0));   -- tek aktif controller → global lock
  v_prev := public._consent_idem_check(p_idem,p_actor,'publish_controller',v_fp); if v_prev is not null then return v_prev; end if;
  select valid_to into v_valid_to from public.controller_identity_versions where id=p_id for update;
  if not found then raise exception 'controller_not_found'; end if;
  if p_activate then
    if v_valid_to is not null and v_valid_to<=now() then raise exception 'controller_cannot_activate_expired'; end if;
    update public.controller_identity_versions set is_active=false where is_active and id<>p_id;   -- atomik switch
    update public.controller_identity_versions set is_published=true, is_active=true where id=p_id;
    update public.marketing_config set active_controller_version_id=p_id, updated_at=now(), updated_by=p_actor where id=1;  -- authoritative pointer
    -- yeni controller'a bağlı OLMAYAN aktif metinler artık authoritative değil → pasifleştir (düzeltme #5)
    update public.consent_text_versions set is_active=false where is_active and controller_version_id<>p_id;
  else
    update public.controller_identity_versions set is_published=true where id=p_id;
  end if;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'publish_controller','controller_identity_versions',p_id::text,'{}'::jsonb, jsonb_build_object('published',true,'active',p_activate), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'publish_controller',v_fp,jsonb_build_object('ok',true));
  return jsonb_build_object('ok',true);
end $fn$;
revoke all on function public.admin_w_publish_controller_version(uuid,uuid,boolean,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_publish_controller_version(uuid,uuid,boolean,text,text,uuid) to service_role;

-- Consent text yayımlama/aktivasyon: ATOMİK switch + hukuk-onayı kapısı (trigger enforce; düzeltme #9/#10)
create or replace function public.admin_w_publish_consent_text(p_actor uuid, p_id uuid, p_activate boolean, p_reason text, p_request_id text, p_idem uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v_fp text; v_prev jsonb; v_rid text; v_doc public.consent_doc_type; v_loc text; v_ctrl uuid;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  v_rid := public._require_request_id(p_request_id); if p_idem is null then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'reason_required'; end if;
  v_fp := encode(extensions.digest(convert_to(p_actor::text||'|publish_text|'||p_id::text||'|'||p_activate::text||'|'||btrim(p_reason),'UTF8'),'sha256'),'hex');
  v_prev := public._consent_idem_check(p_idem,p_actor,'publish_text',v_fp); if v_prev is not null then return v_prev; end if;
  -- TÜM consent-text switch'leri TEK global advisory lock ile serialize (deadlock yok; düzeltme #6)
  perform pg_advisory_xact_lock(hashtextextended('consent_text_switch',0));
  v_prev := public._consent_idem_check(p_idem,p_actor,'publish_text',v_fp); if v_prev is not null then return v_prev; end if;
  select doc_type, locale, controller_version_id into v_doc, v_loc, v_ctrl from public.consent_text_versions where id=p_id for update;
  if not found then raise exception 'consent_text_not_found'; end if;
  if p_activate then
    if not exists(select 1 from public.controller_identity_versions where id=v_ctrl and is_active and is_published) then raise exception 'text_controller_not_active'; end if;
    update public.consent_text_versions set is_active=false where is_active and doc_type=v_doc and locale=v_loc and id<>p_id;  -- atomik switch
    update public.consent_text_versions set is_active=true where id=p_id;   -- BIU: hukuk-onayı kapısı burada enforce
  else
    update public.consent_text_versions set is_published=true where id=p_id;
  end if;
  insert into public.admin_write_log(actor_uid,action,target_type,target_id,before,after,reason,request_id,idempotency_key,at)
  values (p_actor,'publish_consent_text','consent_text_versions',p_id::text,'{}'::jsonb, jsonb_build_object('published',true,'active',p_activate), p_reason, v_rid, p_idem, now());
  insert into public.consent_write_ops(idempotency_key,actor,action,fingerprint,result) values (p_idem,p_actor,'publish_text',v_fp,jsonb_build_object('ok',true));
  return jsonb_build_object('ok',true);
end $fn$;
revoke all on function public.admin_w_publish_consent_text(uuid,uuid,boolean,text,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_w_publish_consent_text(uuid,uuid,boolean,text,text,uuid) to service_role;

-- =====================================================================
-- KAPSAM DIŞI: message_class/sınıf + assertServiceContent + unsubscribe_consume + send → CDP-3D;
--   journeys/scheduler → CDP-3E; Resend/DNS/outbox → CDP-3D; aktif hukuk metni SEED EDİLMEZ.
-- =====================================================================
