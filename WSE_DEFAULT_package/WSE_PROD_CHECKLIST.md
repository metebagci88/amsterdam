# welcome_service_email future-default — production checklist

This pull request does not run these statements. Phase 1 is a later human apply of `WSE_up.sql` only. Phase 2 (`WSE_ACTIVATE.sql`) needs a separate approval and is not part of that apply.

Do not touch Auth mail settings, Başak send, provider flags, the send allowlist, or the outbox in either phase.

## Before phase 1 (read-only)

Record counts and definitions. Expect welcome `default_enabled` null, no `effective_from` column yet, and no seed trigger.

```sql
select pref_key, default_enabled
  from public.service_pref_defaults
 order by pref_key;

select column_name, data_type
  from information_schema.columns
 where table_schema='public' and table_name='service_pref_defaults'
 order by ordinal_position;

select tgname from pg_trigger
 where tgrelid='public.members'::regclass and not tgisinternal
 order by tgname;

select count(*) as members from public.members;
select count(*) as auth_users from auth.users;
select count(*) as pref_current from public.member_service_pref_current;
select count(*) as pref_events from public.member_service_pref_events;
select count(*) as consent_current from public.member_consent_current;
select count(*) as outbox from public.email_outbox;

select essential_enabled, service_enabled, public_go_live
  from public.email_provider_config where id=1;
select count(*) as allowlist_active
  from public.email_send_allowlist where active;
select marketing_enabled, marketing_capture_enabled
  from public.marketing_config where id=1;
```

Confirm `auth.users.created_at` is `timestamp with time zone`. The migration preflight stops if it is not.

Confirm `_email_send_decision` does not mention `service_pref_defaults` (save `md5(pg_get_functiondef(...))`).

## Apply phase 1

Apply `WSE_up.sql` once, in a transaction, with a statement timeout set by the operator session. Do not run `WSE_ACTIVATE.sql`. Do not set `wse.allow_activation`.

## After phase 1 (read-only)

- Welcome `default_enabled`, `effective_from`, `policy_version`, `configured_at`, `configured_by` are all null.
- Other keys are unchanged (still null).
- `trg_members_seed_welcome_service_pref` exists and is AFTER INSERT only.
- Member, auth, pref, event, and consent counts match the pre-check.
- Outbox count unchanged. Provider flags unchanged. Allowlist unchanged. Marketing flags unchanged.
- `_email_send_decision` hash unchanged.
- `consent_get_my_state` returns `not_configured` for a user with no current row, and the stored boolean when a row exists.
- A sample of `admin_write_log` shows no new activation row.

## Phase 2 — do not run with phase 1

Only after a separate approval:

1. Confirm the seed trigger is still present.
2. In one transaction, set `wse.allow_activation=YES` and the actor, reason (no email), request id, and a fresh idempotency uuid.
3. Run `WSE_ACTIVATE.sql`.
4. Confirm only `welcome_service_email` changed: `default_enabled` true, `policy_version=welcome_service_email.v1`, `effective_from` equal to that transaction's clock, `configured_by` the actor uuid.
5. Confirm member/pref/consent/outbox counts did not jump. Existing users must not gain a welcome row from activation itself.
6. A new Auth user created after `effective_from`, on first `members` insert, gets one `signup` current row. An Auth user created earlier must not.

`effective_from` is `clock_timestamp()` inside the function. Do not edit it backwards.

## Soft rollback

`WSE_down_soft.sql` stops future seeds and clears the welcome policy columns. It does not delete preference history and does not put the defaults ON-fallback back.

After rollback, do not run the activation file until `WSE_up.sql` has restored the trigger. Use a new idempotency key. The old key raises `welcome_default_replay_stale`.
