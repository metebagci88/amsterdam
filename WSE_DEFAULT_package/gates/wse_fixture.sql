-- =====================================================================
-- CI/ephemeral ONLY. DÖRT mevcut kullanıcı, migration'dan ÖNCE.
-- welcome policy hâlâ null olduğu için (trigger henüz yok) seed yok.
-- L1 welcome ON (pref_center), L2 welcome OFF (system), L3 ve L4 satırsız.
-- auth.users.created_at hepsi 2020 — aktivasyon anından önce.
-- =====================================================================

insert into auth.users(id, email, created_at) values
  ('11111111-1111-4111-8111-111111111111', 'legacy1@example.test', timestamptz '2020-01-01+00'),
  ('22222222-2222-4222-8222-222222222222', 'legacy2@example.test', timestamptz '2020-01-01+00'),
  ('33333333-3333-4333-8333-333333333333', 'legacy3@example.test', timestamptz '2020-01-01+00'),
  ('44444444-4444-4444-8444-444444444444', 'legacy4@example.test', timestamptz '2020-01-01+00');

insert into public.members(user_id, email, created_at, updated_at) values
  ('11111111-1111-4111-8111-111111111111', 'legacy1@example.test', timestamptz '2020-01-02+00', timestamptz '2020-01-02+00'),
  ('22222222-2222-4222-8222-222222222222', 'legacy2@example.test', timestamptz '2020-01-02+00', timestamptz '2020-01-02+00'),
  ('33333333-3333-4333-8333-333333333333', 'legacy3@example.test', timestamptz '2020-01-02+00', timestamptz '2020-01-02+00'),
  ('44444444-4444-4444-8444-444444444444', 'legacy4@example.test', timestamptz '2020-01-02+00', timestamptz '2020-01-02+00');

insert into public.member_service_pref_events(
  id, user_id, pref_key, enabled, source, request_id, idempotency_key, fingerprint, occurred_at
) values
  ('aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
    'welcome_service_email', true, 'pref_center', 'legacy-pc',
    'bbbbbbbb-1111-4111-8111-111111111111', repeat('ab', 32), timestamptz '2020-02-01+00'),
  ('aaaaaaaa-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
    'welcome_service_email', false, 'system', 'legacy-system',
    'bbbbbbbb-2222-4222-8222-222222222222', repeat('cd', 32), timestamptz '2020-02-01+00');

insert into public.member_service_pref_current(user_id, pref_key, enabled, last_event_id, updated_at) values
  ('11111111-1111-4111-8111-111111111111', 'welcome_service_email', true,
    'aaaaaaaa-1111-4111-8111-111111111111', timestamptz '2020-02-01+00'),
  ('22222222-2222-4222-8222-222222222222', 'welcome_service_email', false,
    'aaaaaaaa-2222-4222-8222-222222222222', timestamptz '2020-02-01+00');
