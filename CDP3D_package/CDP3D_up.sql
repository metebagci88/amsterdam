-- =====================================================================
-- CDP-3D · Resend + Servis E-postası Altyapısı — FORWARD MIGRATION (additive)
-- Proje: tosqsabuaomgqjtogdrn
-- Bağımlılık (CDP-3C): public._contact_hmac, contact_suppression_*, _suppression_combo_*,
--   member_service_pref_*, service_pref_defaults, _append_only_guard, _admin_active/_admin_has_role,
--   admin_write_log, members(user_id,email,blocked), Vault secret cdp3c_contact_pepper_v1.
-- İlke: additive + fail-closed + PII-min. Marketing enum'da temsil dahi edilemez.
-- Onaylı gönderim domaini: send.asalocal.club (from no-reply@send.asalocal.club, reply-to destek@asalocal.club).
-- Düzeltmeler: 0C idempotency (fingerprint+lock+recheck+conflict), claim-lease+reclaim,
--   provider-idempotency (outbox id), monoton durum makinesi, atomik webhook dedupe,
--   permanent-only bounce suppression, PII/retention (content purge).
-- Idempotent DDL: do-block / if not exists.
-- =====================================================================
set local statement_timeout = '60s';

-- ---------- 1) Enums ----------
do $$ begin create type public.email_message_class as enum
  ('essential_transactional','optional_service'); exception when duplicate_object then null; end $$;
do $$ begin create type public.email_send_status as enum
  ('queued','sending','sent','delivered','failed','skipped','canceled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.email_skip_reason as enum
  ('suppressed_hard_bounce','suppressed_spam','suppressed_abuse','suppressed_admin_safety',
   'suppressed_global','suppressed_unsubscribe','service_pref_disabled','service_pref_missing',
   'not_in_allowlist','recipient_blocked','recipient_missing_email','class_disabled',
   'config_pending','marketing_rejected'); exception when duplicate_object then null; end $$;

-- ---------- 2) Provider config (singleton) — hepsi KAPALI (fail-closed) ----------
create table if not exists public.email_provider_config (
  id int primary key default 1 check (id = 1),
  essential_enabled boolean not null default false,
  service_enabled   boolean not null default false,
  public_go_live    boolean not null default false,   -- KVKK/controller go-live kapısı (CDP-3D KURAR, AÇMAZ)
  from_email text not null default 'no-reply@send.asalocal.club',
  from_name  text not null default 'ASALOCAL',
  reply_to   text not null default 'destek@asalocal.club',
  lease_seconds int not null default 120,             -- claim lease süresi
  content_retention_days int not null default 30,     -- outbox içerik saklama (PII)
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.email_provider_config(id) values (1) on conflict (id) do nothing;

-- ---------- 3) Gönderim allowlist (fail-closed) ----------
create table if not exists public.email_send_allowlist (
  user_id uuid primary key,
  note text,
  active boolean not null default true,
  added_at timestamptz not null default now(),
  added_by uuid
);

-- ---------- 4) Outbox ----------
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  intent_fingerprint text not null,                   -- 0C: aynı key+farklı payload -> conflict
  message_class public.email_message_class not null,
  service_pref_key public.service_pref_key,
  template_id uuid references public.email_templates(id),
  subject text not null,
  body_html text,
  body_text text,
  user_id uuid not null,
  recipient_hmac text not null check (recipient_hmac ~ '^[0-9a-f]{64}$'),
  pepper_version int not null default 1,
  status public.email_send_status not null default 'queued',
  skip_reason public.email_skip_reason,
  provider_message_id text,
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  content_purged_at timestamptz,                       -- PII retention: içerik temizlendi
  last_error text,
  request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_by uuid,
  constraint email_outbox_class_pref_ck check (
    (message_class = 'optional_service' and service_pref_key is not null) or
    (message_class = 'essential_transactional' and service_pref_key is null)
  )
);
create index if not exists email_outbox_claim_idx on public.email_outbox (status, next_attempt_at) where status = 'queued';
create index if not exists email_outbox_lease_idx on public.email_outbox (status, lease_expires_at) where status = 'sending';
create index if not exists email_outbox_provider_idx on public.email_outbox (provider_message_id) where provider_message_id is not null;

-- ---------- 5) Provider olay logu (append-only, PII'siz) ----------
create table if not exists public.email_send_events (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid references public.email_outbox(id),
  provider_message_id text,
  svix_id text,
  event_type text not null,
  recipient_hmac text check (recipient_hmac ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz,
  received_at timestamptz not null default now()
);
-- atomik dedupe (INSERT ON CONFLICT için) — düzeltme #5
create unique index if not exists email_send_events_svix_uk on public.email_send_events (svix_id) where svix_id is not null;
drop trigger if exists email_send_events_append_only on public.email_send_events;
create trigger email_send_events_append_only before update or delete on public.email_send_events
  for each row execute function public._append_only_guard();

-- ---------- 6) RLS deny-all + force + revoke ----------
do $$ declare t text; begin
  foreach t in array array['email_provider_config','email_send_allowlist','email_outbox','email_send_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- =====================================================================
-- 7) Durum makinesi (monoton) — düzeltme #4
--    Başarı merdiveni ileri-yönlü: queued<sending<sent<delivered.
--    delivered'a ulaşınca geç 'sent' geri düşüremez. Bounce/failed yalnız delivered ÖNCESİ.
-- =====================================================================
create or replace function public._email_status_rank(s public.email_send_status) returns int
language sql immutable as $fn$ select case s
  when 'queued' then 10 when 'sending' then 20 when 'sent' then 30 when 'delivered' then 40
  when 'failed' then 90 when 'skipped' then 95 when 'canceled' then 96 end; $fn$;

create or replace function public._email_can_set_delivery(p_old public.email_send_status, p_new public.email_send_status)
returns boolean language sql immutable as $fn$
  select case
    when p_new='sent'      then p_old in ('sending')
    when p_new='delivered' then p_old in ('sending','sent')
    when p_new='failed'    then p_old in ('sending','sent')      -- bounce/failed yalnız delivered ÖNCESİ
    when p_new='sending'   then p_old in ('queued')
    when p_new='skipped'   then p_old in ('queued','sending')
    else false end;
$fn$;
revoke all on function public._email_status_rank(public.email_send_status) from public, anon, authenticated;
revoke all on function public._email_can_set_delivery(public.email_send_status,public.email_send_status) from public, anon, authenticated;

-- =====================================================================
-- 8) Karar fonksiyonu (server-only): sınıf allowlist + suppression matrisi + service pref +
--    gönderim allowlist + config. Ham e-posta -> HMAC İÇERİDE, dışarı çıkmaz.
-- =====================================================================
create or replace function public._email_send_decision(
  p_user_id uuid, p_message_class public.email_message_class, p_service_pref_key public.service_pref_key
) returns jsonb
language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare v_email text; v_blocked boolean; v_hmac text; v_cfg public.email_provider_config%rowtype;
        v_pref_enabled boolean; v_pref_found boolean; v_sup record; v_skip public.email_skip_reason;
begin
  if p_message_class is null or p_message_class not in ('essential_transactional','optional_service') then
    return jsonb_build_object('allow',false,'skip_reason','marketing_rejected');
  end if;
  if p_message_class='optional_service' and p_service_pref_key is null then
    return jsonb_build_object('allow',false,'skip_reason','config_pending');
  end if;
  if p_message_class='essential_transactional' and p_service_pref_key is not null then
    return jsonb_build_object('allow',false,'skip_reason','config_pending');
  end if;

  select email, coalesce(blocked,false) into v_email, v_blocked from public.members where user_id=p_user_id;
  if v_email is null then return jsonb_build_object('allow',false,'skip_reason','recipient_missing_email'); end if;
  if v_blocked then return jsonb_build_object('allow',false,'skip_reason','recipient_blocked'); end if;
  v_hmac := public._contact_hmac(v_email, 1);

  select * into v_cfg from public.email_provider_config where id=1;
  if v_cfg is null then return jsonb_build_object('allow',false,'skip_reason','config_pending','recipient_hmac',v_hmac); end if;
  if p_message_class='essential_transactional' and not v_cfg.essential_enabled then
    return jsonb_build_object('allow',false,'skip_reason','class_disabled','recipient_hmac',v_hmac); end if;
  if p_message_class='optional_service' and not v_cfg.service_enabled then
    return jsonb_build_object('allow',false,'skip_reason','class_disabled','recipient_hmac',v_hmac); end if;

  if not v_cfg.public_go_live then
    if not exists (select 1 from public.email_send_allowlist a where a.user_id=p_user_id and a.active) then
      return jsonb_build_object('allow',false,'skip_reason','not_in_allowlist','recipient_hmac',v_hmac); end if;
  end if;

  -- suppression matrisi (düzeltme #3)
  v_skip := null;
  for v_sup in
    select channel, scope, reason from public.contact_suppression_current
     where contact_hmac=v_hmac and status='active' and channel in ('email','global')
  loop
    if v_sup.channel='global' or v_sup.scope='global' then v_skip := 'suppressed_global'; exit;
    elsif v_sup.scope='all_email' then
      if v_sup.reason in ('hard_bounce','spam_complaint','abuse','admin_safety_block') then
        v_skip := case v_sup.reason when 'hard_bounce' then 'suppressed_hard_bounce'
          when 'spam_complaint' then 'suppressed_spam' when 'abuse' then 'suppressed_abuse'
          else 'suppressed_admin_safety' end::public.email_skip_reason; exit;
      elsif v_sup.reason in ('user_unsubscribe','iys_red') then
        if p_message_class='optional_service' then v_skip := 'suppressed_unsubscribe'; exit; end if;
      end if;
    end if;
  end loop;
  if v_skip is not null then return jsonb_build_object('allow',false,'skip_reason',v_skip,'recipient_hmac',v_hmac); end if;

  if p_message_class='optional_service' then
    select enabled into v_pref_enabled from public.member_service_pref_current
      where user_id=p_user_id and pref_key=p_service_pref_key;
    v_pref_found := found;
    if not v_pref_found or v_pref_enabled is null then
      return jsonb_build_object('allow',false,'skip_reason','service_pref_missing','recipient_hmac',v_hmac); end if;
    if v_pref_enabled = false then
      return jsonb_build_object('allow',false,'skip_reason','service_pref_disabled','recipient_hmac',v_hmac); end if;
  end if;

  return jsonb_build_object('allow',true,'recipient_hmac',v_hmac);
end $fn$;
revoke all on function public._email_send_decision(uuid,public.email_message_class,public.service_pref_key) from public, anon, authenticated;
grant execute on function public._email_send_decision(uuid,public.email_message_class,public.service_pref_key) to service_role;

-- =====================================================================
-- 9) Enqueue (service_role) — 0C: fingerprint + advisory lock + recheck + conflict. Düzeltme #2.
-- =====================================================================
create or replace function public.email_enqueue(
  p_user_id uuid, p_message_class public.email_message_class, p_service_pref_key public.service_pref_key,
  p_subject text, p_body_html text, p_body_text text, p_template_id uuid, p_idempotency_key text, p_request_id text
) returns jsonb
language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare v_dec jsonb; v_hmac text; v_status public.email_send_status; v_skip public.email_skip_reason;
        v_id uuid; v_existing public.email_outbox%rowtype; v_fp text;
begin
  if coalesce(btrim(p_idempotency_key),'')='' then raise exception 'idem_required'; end if;
  if coalesce(btrim(p_subject),'')='' then raise exception 'subject_required'; end if;

  -- intent fingerprint (payload niyeti)
  v_fp := encode(extensions.digest(convert_to(
    coalesce(p_user_id::text,'')||'|'||coalesce(p_message_class::text,'')||'|'||coalesce(p_service_pref_key::text,'')||'|'||
    coalesce(p_subject,'')||'|'||coalesce(p_body_html,'')||'|'||coalesce(p_body_text,'')||'|'||coalesce(p_template_id::text,''),'UTF8'),'sha256'),'hex');

  -- aynı key'i seri hale getir (paralel çift-insert yarışı)
  perform pg_advisory_xact_lock(hashtextextended('email_enqueue|'||p_idempotency_key,0));

  select * into v_existing from public.email_outbox where idempotency_key=p_idempotency_key;
  if found then
    if v_existing.intent_fingerprint = v_fp then
      return jsonb_build_object('ok',true,'id',v_existing.id,'status',v_existing.status,'idempotent',true);
    else
      raise exception 'idempotency_conflict';
    end if;
  end if;

  v_dec := public._email_send_decision(p_user_id, p_message_class, p_service_pref_key);
  v_hmac := v_dec->>'recipient_hmac';
  if v_hmac is null then
    return jsonb_build_object('ok',false,'skip_reason',v_dec->>'skip_reason');
  end if;
  if (v_dec->>'allow')::boolean then v_status := 'queued'; v_skip := null;
  else v_status := 'skipped'; v_skip := (v_dec->>'skip_reason')::public.email_skip_reason; end if;

  insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, template_id,
    subject, body_html, body_text, user_id, recipient_hmac, pepper_version, status, skip_reason, request_id)
  values (p_idempotency_key, v_fp, p_message_class, p_service_pref_key, p_template_id,
    p_subject, p_body_html, p_body_text, p_user_id, v_hmac, 1, v_status, v_skip, nullif(btrim(p_request_id),''))
  returning id into v_id;

  return jsonb_build_object('ok',true,'id',v_id,'status',v_status,'skip_reason',v_skip);
end $fn$;
revoke all on function public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.email_enqueue(uuid,public.email_message_class,public.service_pref_key,text,text,text,uuid,text,text) to service_role;

-- =====================================================================
-- 10) Claim batch (service_role) — lease + reclaim (düzeltme #3). Ham e-posta yalnız burada döner.
-- =====================================================================
create or replace function public.email_claim_batch(p_limit int default 10)
returns table(outbox_id uuid, message_class public.email_message_class, service_pref_key public.service_pref_key,
  subject text, body_html text, body_text text, recipient_email text, from_email text, from_name text, reply_to text)
language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare r record; v_dec jsonb; v_email text; v_blocked boolean; v_cfg public.email_provider_config%rowtype;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then p_limit := 10; end if;
  select * into v_cfg from public.email_provider_config where id=1;

  -- reclaim: lease süresi dolmuş 'sending' kayıtları güvenli şekilde queued'a al (kayıp yanıt/çökme)
  update public.email_outbox
     set status='queued', next_attempt_at=now(), claimed_at=null, lease_expires_at=null, updated_at=now()
   where status='sending' and lease_expires_at is not null and lease_expires_at < now();

  for r in
    select * from public.email_outbox
     where status='queued' and next_attempt_at <= now()
     order by created_at for update skip locked limit p_limit
  loop
    v_dec := public._email_send_decision(r.user_id, r.message_class, r.service_pref_key);
    if not (v_dec->>'allow')::boolean then
      update public.email_outbox set status='skipped', skip_reason=(v_dec->>'skip_reason')::public.email_skip_reason, updated_at=now() where id=r.id;
      continue;
    end if;
    select email, coalesce(blocked,false) into v_email, v_blocked from public.members where user_id=r.user_id;
    if v_email is null or v_blocked then
      update public.email_outbox set status='skipped', skip_reason=case when v_email is null then 'recipient_missing_email' else 'recipient_blocked' end, updated_at=now() where id=r.id;
      continue;
    end if;
    update public.email_outbox
       set status='sending', attempts=attempts+1, claimed_at=now(),
           lease_expires_at=now() + make_interval(secs => coalesce(v_cfg.lease_seconds,120)), updated_at=now()
     where id=r.id;
    outbox_id := r.id; message_class := r.message_class; service_pref_key := r.service_pref_key;
    subject := r.subject; body_html := r.body_html; body_text := r.body_text; recipient_email := v_email;
    from_email := v_cfg.from_email; from_name := v_cfg.from_name; reply_to := v_cfg.reply_to;
    return next;
  end loop;
end $fn$;
revoke all on function public.email_claim_batch(int) from public, anon, authenticated;
grant execute on function public.email_claim_batch(int) to service_role;

-- =====================================================================
-- 11) Sonuç işaretle (service_role) — monoton; yalnız 'sending'den. Düzeltme #4.
-- =====================================================================
create or replace function public.email_mark_result(p_outbox_id uuid, p_ok boolean, p_provider_message_id text, p_error text)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v public.email_outbox%rowtype; v_backoff interval;
begin
  select * into v from public.email_outbox where id=p_outbox_id;
  if not found then raise exception 'outbox_not_found'; end if;
  if v.status <> 'sending' then
    -- yarış/geç çağrı: monoton koruma, sessizce yok say
    return jsonb_build_object('ok',true,'ignored',true,'status',v.status);
  end if;
  if p_ok then
    update public.email_outbox set status='sent', provider_message_id=nullif(btrim(p_provider_message_id),''),
           sent_at=now(), last_error=null, lease_expires_at=null, updated_at=now() where id=p_outbox_id;
    return jsonb_build_object('ok',true,'status','sent');
  else
    if v.attempts >= v.max_attempts then
      update public.email_outbox set status='failed', failed_at=now(), last_error=left(coalesce(p_error,''),300), lease_expires_at=null, updated_at=now() where id=p_outbox_id;
      return jsonb_build_object('ok',true,'status','failed');
    else
      v_backoff := (power(2, greatest(v.attempts,1)) * interval '1 minute');
      update public.email_outbox set status='queued', next_attempt_at=now()+v_backoff, last_error=left(coalesce(p_error,''),300),
             claimed_at=null, lease_expires_at=null, updated_at=now() where id=p_outbox_id;
      return jsonb_build_object('ok',true,'status','requeued','next_attempt_at',now()+v_backoff);
    end if;
  end if;
end $fn$;
revoke all on function public.email_mark_result(uuid,boolean,text,text) from public, anon, authenticated;
grant execute on function public.email_mark_result(uuid,boolean,text,text) to service_role;

-- =====================================================================
-- 12) Sistem suppression (service_role) — yalnız hard_bounce/spam_complaint/abuse (permanent).
--     Ham e-posta İÇERİDE hmac'e çevrilir; saklanmaz. Idempotent, append-only, OTOMATİK KALDIRMAZ.
-- =====================================================================
create or replace function public._email_system_apply_suppression(p_recipient_email text, p_reason public.suppression_reason, p_source_ref text)
returns jsonb language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare v_hmac text; v_scope public.suppression_scope := 'all_email'; v_evid uuid; v_idem uuid; v_fp text;
begin
  if p_reason not in ('hard_bounce','spam_complaint','abuse') then raise exception 'system_reason_not_allowed:%', p_reason; end if;
  if coalesce(btrim(p_recipient_email),'')='' then raise exception 'email_required'; end if;
  v_hmac := public._contact_hmac(p_recipient_email, 1);
  v_idem := gen_random_uuid();
  v_fp := encode(extensions.digest(convert_to('system|apply_suppression|'||v_hmac||'|email|'||v_scope::text||'|'||p_reason::text,'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('email_sys_supp|'||v_hmac||'|'||p_reason::text,0));
  if exists (select 1 from public.contact_suppression_current where contact_hmac=v_hmac and channel='email' and scope=v_scope and reason=p_reason and status='active') then
    return jsonb_build_object('ok',true,'idempotent',true);
  end if;
  insert into public.contact_suppression_events(channel,scope,contact_hmac,pepper_version,reason,action,source,request_id,idempotency_key,fingerprint)
  values ('email',v_scope,v_hmac,1,p_reason,'suppress','system','resend-webhook',v_idem,v_fp) returning id into v_evid;
  insert into public.contact_suppression_current(channel,contact_hmac,scope,reason,pepper_version,status,source_event_id,updated_at)
  values ('email',v_hmac,v_scope,p_reason,1,'active',v_evid,now())
  on conflict (channel,contact_hmac,scope,reason) do update set status='active',source_event_id=v_evid,superseded_at=null,superseded_by=null,updated_at=now();
  return jsonb_build_object('ok',true,'suppressed',true);
end $fn$;
revoke all on function public._email_system_apply_suppression(text,public.suppression_reason,text) from public, anon, authenticated;
grant execute on function public._email_system_apply_suppression(text,public.suppression_reason,text) to service_role;

-- =====================================================================
-- 13) Provider olay ingest (service_role) — atomik svix dedupe + monoton + permanent-only bounce.
--     Düzeltme #5 (dedupe), #4 (monoton), #6 (bounce sınıfı).
-- =====================================================================
create or replace function public.email_ingest_provider_event(
  p_svix_id text, p_event_type text, p_provider_message_id text, p_recipient_email text,
  p_occurred_at timestamptz, p_bounce_type text default null
) returns jsonb
language plpgsql security definer set search_path=public, extensions, vault as $fn$
declare v_hmac text; v_outbox uuid; v_cur public.email_send_status; v_inserted boolean := false; v_evid uuid;
begin
  if coalesce(btrim(p_event_type),'')='' then raise exception 'event_type_required'; end if;
  if coalesce(btrim(p_recipient_email),'')<>'' then v_hmac := public._contact_hmac(p_recipient_email, 1); end if;
  select id, status into v_outbox, v_cur from public.email_outbox
    where provider_message_id = nullif(btrim(p_provider_message_id),'') limit 1;

  -- atomik dedupe: svix_id benzersiz; conflict -> zaten işlendi
  insert into public.email_send_events(outbox_id, provider_message_id, svix_id, event_type, recipient_hmac, occurred_at)
  values (v_outbox, nullif(btrim(p_provider_message_id),''), nullif(btrim(p_svix_id),''), p_event_type, v_hmac, p_occurred_at)
  on conflict (svix_id) where svix_id is not null do nothing
  returning id into v_evid;
  v_inserted := (v_evid is not null);
  if not v_inserted and nullif(btrim(p_svix_id),'') is not null then
    return jsonb_build_object('ok',true,'duplicate',true);
  end if;

  -- monoton durum güncelle (yalnız izinli geçiş)
  if v_outbox is not null then
    if p_event_type='email.sent' and public._email_can_set_delivery(v_cur,'sent') then
      update public.email_outbox set status='sent', sent_at=coalesce(sent_at,now()), updated_at=now() where id=v_outbox;
    elsif p_event_type='email.delivered' and public._email_can_set_delivery(v_cur,'delivered') then
      update public.email_outbox set status='delivered', delivered_at=now(), updated_at=now() where id=v_outbox;
    elsif p_event_type='email.bounced' and public._email_can_set_delivery(v_cur,'failed') then
      update public.email_outbox set status='failed', failed_at=now(), updated_at=now() where id=v_outbox;
    elsif p_event_type='email.failed' and public._email_can_set_delivery(v_cur,'failed') then
      update public.email_outbox set status='failed', failed_at=now(), updated_at=now() where id=v_outbox;
    -- email.delivery_delayed (transient) ve email.complained: DELIVERY durumu DEĞİŞMEZ
    end if;
  end if;

  -- suppression geri beslemesi (yalnız permanent) — düzeltme #6
  if v_hmac is not null then
    if p_event_type='email.bounced' and (p_bounce_type is null or lower(p_bounce_type)='permanent') then
      perform public._email_system_apply_suppression(p_recipient_email,'hard_bounce','bounce:'||coalesce(p_provider_message_id,''));
    elsif p_event_type='email.complained' then
      perform public._email_system_apply_suppression(p_recipient_email,'spam_complaint','complaint:'||coalesce(p_provider_message_id,''));
    end if;
    -- email.delivery_delayed / transient bounce -> KALICI suppression YOK
    -- suppression.removed/added -> yalnız loglanır; yerel suppression OTOMATİK kaldırılmaz
  end if;

  return jsonb_build_object('ok',true);
end $fn$;
revoke all on function public.email_ingest_provider_event(text,text,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.email_ingest_provider_event(text,text,text,text,timestamptz,text) to service_role;

-- =====================================================================
-- 14) İçerik retention / purge (service_role) — PII: terminal + retention geçmiş kayıtların
--     subject/body alanlarını temizle. Düzeltme #7.
-- =====================================================================
create or replace function public.email_purge_expired_content() returns jsonb
language plpgsql security definer set search_path=public, extensions as $fn$
declare v_days int; v_n int;
begin
  select content_retention_days into v_days from public.email_provider_config where id=1;
  v_days := coalesce(v_days,30);
  update public.email_outbox
     set subject='[purged]', body_html=null, body_text=null, content_purged_at=now(), updated_at=now()
   where content_purged_at is null
     and status in ('sent','delivered','failed','skipped','canceled')
     and updated_at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok',true,'purged',v_n);
end $fn$;
revoke all on function public.email_purge_expired_content() from public, anon, authenticated;
grant execute on function public.email_purge_expired_content() to service_role;

-- =====================================================================
-- 15) Admin okuma (super_admin) — salt-okunur, PII'siz.
-- =====================================================================
create or replace function public.admin_q_email_delivery_status(p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public, extensions as $fn$
declare v jsonb;
begin
  if not (public._admin_active(p_actor) and public._admin_has_role(p_actor, array['super_admin'])) then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'config', (select jsonb_build_object('essential_enabled',essential_enabled,'service_enabled',service_enabled,
                       'public_go_live',public_go_live,'from_email',from_email,'from_name',from_name,'reply_to',reply_to) from public.email_provider_config where id=1),
    'allowlist_count', (select count(*) from public.email_send_allowlist where active),
    'outbox_by_status', (select coalesce(jsonb_object_agg(status, c),'{}'::jsonb) from (select status::text, count(*) c from public.email_outbox group by status) s),
    'skipped_by_reason', (select coalesce(jsonb_object_agg(skip_reason, c),'{}'::jsonb) from (select skip_reason::text, count(*) c from public.email_outbox where skip_reason is not null group by skip_reason) s)
  ) into v;
  return v;
end $fn$;
revoke all on function public.admin_q_email_delivery_status(uuid) from public, anon, authenticated;
grant execute on function public.admin_q_email_delivery_status(uuid) to service_role;

-- =====================================================================
-- SON. Tüm kapılar fail-closed + kapalı. public_go_live=false (go-live kapısı kurulu, açık değil).
-- =====================================================================
