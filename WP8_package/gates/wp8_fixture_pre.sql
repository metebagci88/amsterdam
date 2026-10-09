-- WP8 CI-ONLY fixture: reproduces the 2026-10-08 production PRE facts with fictional data.
-- WSE active since 2026-09-30T16:26:59.948763Z; flags false; allowlist 0; members 3, first_name 0;
-- outbox 3 welcome rows (2 delivered for one user, 1 canceled), all 2026-09-30; events 6 (2 orphans).
update public.service_pref_defaults
   set default_enabled = true, effective_from = timestamptz '2026-09-30 16:26:59.948763+00',
       policy_version = 'welcome_service_email.v1', configured_at = timestamptz '2026-09-30 16:26:59.948763+00'
 where pref_key = 'welcome_service_email';

insert into public.admin_users(user_id, active) values ('0000000a-0000-4000-8000-00000000a001', true);
insert into public.admin_roles(user_id, role) values ('0000000a-0000-4000-8000-00000000a001', 'super_admin');
insert into public.admin_users(user_id, active) values ('0000000a-0000-4000-8000-00000000a002', true);
insert into public.admin_roles(user_id, role) values ('0000000a-0000-4000-8000-00000000a002', 'support');

insert into auth.users(id, email, created_at) values
  ('0000000f-0000-4000-8000-0000000000f1', 'legacy-owner@example.test', timestamptz '2026-08-01 10:00:00+00'),
  ('0000000f-0000-4000-8000-0000000000f2', 'post-wse-1@example.test', timestamptz '2026-09-30 17:10:00+00'),
  ('0000000f-0000-4000-8000-0000000000f3', 'post-wse-2@example.test', timestamptz '2026-10-02 10:00:00+00');
insert into public.members(user_id, email, created_at) values
  ('0000000f-0000-4000-8000-0000000000f1', 'legacy-owner@example.test', timestamptz '2026-08-01 10:00:00+00'),
  ('0000000f-0000-4000-8000-0000000000f2', 'post-wse-1@example.test', timestamptz '2026-09-30 17:10:00+00'),
  ('0000000f-0000-4000-8000-0000000000f3', 'post-wse-2@example.test', timestamptz '2026-10-02 10:00:00+00');
insert into public.member_service_pref_current(user_id, pref_key, enabled)
values ('0000000f-0000-4000-8000-0000000000f1', 'welcome_service_email', true)
on conflict (user_id, pref_key) do nothing;

insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, body_html, body_text,
  user_id, recipient_hmac, status, attempts, provider_message_id, created_at, updated_at, sent_at, delivered_at)
values
  ('legacy-acceptance-1', 'legacy', 'optional_service', 'welcome_service_email', 'legacy', '<p>legacy</p>', 'legacy',
   '0000000f-0000-4000-8000-0000000000f1', public._contact_hmac('legacy-owner@example.test', 1), 'delivered', 1, 'prov-legacy-1',
   timestamptz '2026-09-30 17:00:00+00', timestamptz '2026-09-30 17:00:05+00', timestamptz '2026-09-30 17:00:01+00', timestamptz '2026-09-30 17:00:05+00'),
  ('legacy-acceptance-2', 'legacy', 'optional_service', 'welcome_service_email', 'legacy', '<p>legacy</p>', 'legacy',
   '0000000f-0000-4000-8000-0000000000f1', public._contact_hmac('legacy-owner@example.test', 1), 'delivered', 1, 'prov-legacy-2',
   timestamptz '2026-09-30 18:00:00+00', timestamptz '2026-09-30 18:00:05+00', timestamptz '2026-09-30 18:00:01+00', timestamptz '2026-09-30 18:00:05+00'),
  ('legacy-acceptance-3', 'legacy', 'optional_service', 'welcome_service_email', 'legacy', '<p>legacy</p>', 'legacy',
   '0000000f-0000-4000-8000-0000000000f2', public._contact_hmac('post-wse-1@example.test', 1), 'canceled', 1, null,
   timestamptz '2026-09-30 17:20:00+00', timestamptz '2026-09-30 17:20:05+00', null, null);
insert into public.email_send_events(outbox_id, provider_message_id, svix_id, event_type, received_at)
select o.id, o.provider_message_id, 'svix-legacy-' || o.provider_message_id || '-' || t.ev, 'email.' || t.ev, o.sent_at + interval '1 second'
  from public.email_outbox o cross join (values ('sent'), ('delivered')) t(ev)
 where o.provider_message_id in ('prov-legacy-1', 'prov-legacy-2');
insert into public.email_send_events(outbox_id, provider_message_id, svix_id, event_type, received_at) values
  (null, 'prov-legacy-orphan', 'svix-legacy-orphan-sent', 'email.sent', timestamptz '2026-09-30 16:40:00+00'),
  (null, 'prov-legacy-orphan', 'svix-legacy-orphan-delivered', 'email.delivered', timestamptz '2026-09-30 16:40:05+00');
