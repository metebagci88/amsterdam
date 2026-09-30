# welcome_service_email future-default — inert design

**Status:** design package only. This change does not apply SQL to production, does not set `default_enabled=true`, and does not send mail.

**Scope:** `welcome_service_email` only. Other `optional_service` keys stay unset.

## Verdict

`DESIGN_PACKAGE_READY_INERT`

The inert migration installs the seed trigger, the policy columns, and the read-path fix while `welcome_service_email.default_enabled` stays null. New members are not seeded until a separate, explicit activation sets the flag, `effective_from`, and `policy_version` together. That activation file is in this package and is not executed by the migration or by CI.

## Hypothesis check (this turn)

Prior PRE notes were treated as unlabeled until checked against the repo and an ephemeral database. Production was not queried.

| Hypothesis | Evidence | Result |
|---|---|---|
| Send path ignores `service_pref_defaults` | `CDP3D_package/CDP3D_up.sql` `_email_send_decision`: `optional_service` reads only `member_service_pref_current`. Missing or null row returns `service_pref_missing`. | Confirmed. This package does not replace that function. The ephemeral gate hashes `pg_get_functiondef` before and after the migration. With the welcome flag forced true and no current row, the decision is still `service_pref_missing`. |
| Preference read path falls back to defaults | `CDP3C_package/CDP3C_up.sql` `consent_get_my_state`: if `c.user_id` is null and `d.default_enabled` is not null, the RPC returns that boolean. | Confirmed for the pre-change function. The inert migration replaces that branch. A missing current row is the string `not_configured`. |
| Member UI treats boolean true as Açık | `amsterdam/index.html`: `pending=(v==="config_pending")`, `on=(v===true)`. Any other value, including `false` and `not_configured`, renders Kapalı. | Confirmed from source. The HTML is not modified. After the RPC change, a missing row displays Kapalı instead of "Varsayılan belirlenmedi". A real current row still displays Açık or Kapalı from `enabled`. |

## Schema names used (from repo migrations, not invented)

| Object | Source | Columns this package relies on |
|---|---|---|
| `public.service_pref_defaults` | `CDP3C_up.sql` | `pref_key service_pref_key` PK, `default_enabled boolean` |
| `public.member_service_pref_events` | `CDP3C_up.sql` | `user_id`, `pref_key`, `enabled`, `source`, `request_id`, `idempotency_key`, `fingerprint` (`id`, `occurred_at` have defaults) |
| `public.member_service_pref_current` | `CDP3C_up.sql` | PK `(user_id, pref_key)`, `enabled`, `last_event_id`, `updated_at` |
| `public.consent_source` | `CDP3C_up.sql` | label `signup` (also `pref_center`, `system`, …). No new label. |
| `public.consent_get_my_state()` | `CDP3C_up.sql` | same signature, `security definer`, `search_path=public`, execute for `authenticated` |
| `public.service_pref_set(...)` | `CDP3C_up.sql` | unchanged. OFF path stays `source=pref_center`. |
| `auth.users` | `CDP3C` tests insert `(id, email, created_at)` | `id uuid`, `created_at timestamptz` |
| `public.admin_write_log.actor_uid` | `cdp3c_baseline.sql` | uuid, no FK. `configured_by` matches that type. |
| `public._email_send_decision(uuid, email_message_class, service_pref_key)` | `CDP3D_up.sql` | not modified |

`WSE_up.sql` preflight raises `WSE_PREFLIGHT` if any of those names or types are absent. New columns on `service_pref_defaults` are only the four below. They are added nullable, with no column default, so existing rows are not stamped.

- `effective_from timestamptz`
- `policy_version text`
- `configured_at timestamptz`
- `configured_by uuid`

Check constraints added by the inert migration:

- `service_pref_defaults_activation_welcome_only` — a non-welcome key cannot have `default_enabled` true and `effective_from` set together.
- `service_pref_defaults_policy_version_welcome_v1` — the only non-null policy version this package accepts is `welcome_service_email.v1` on `welcome_service_email`.

## Binding behavior

1. **Only welcome.** The seed reads that key only. Activation updates that key only. The welcome-only check blocks the same pair of values on other keys.
2. **Auth users created after activation.** Seed requires `auth.users.created_at >= effective_from`.
3. **Old auth user, later `members` insert.** If `auth.users.created_at` is before `effective_from`, the insert does not seed. `members.created_at` is not the boundary.
4. **Existing rows stay.** The migration has no `UPDATE` of defaults, members, prefs, or events. Activation writes one defaults row and one admin audit row; it does not scan members.
5. **No backfill.** The trigger is `AFTER INSERT` only. Existing `members` rows are not rewritten.
6. **No marketing consent.** Seed source is `signup` on `member_service_pref_events` only. No `member_consent_*` write, no `pref_center` source on the seed.
7. **No enqueue.** The seed inserts one event and one current row. `_email_send_decision` is untouched, so a missing row is still denied. Flags, allowlist, and outbox are not referenced.
8. **Pref-center OFF stays OFF.** Seed returns immediately when a current row exists. It does not run on `UPDATE`. `INSERT ... ON CONFLICT DO UPDATE` does not fire an INSERT trigger, so a profile upsert does not write a second event and does not turn the row back on.

## A–E

**A. Policy metadata.** Columns above. `default_enabled` is unchanged by the inert migration (production value remains null).

**B. Seed.** `trg_members_seed_welcome_service_pref` → `_seed_welcome_service_pref_on_member_insert()`. `SECURITY DEFINER`, `search_path=public, extensions`, `EXECUTE` revoked from `public`, `anon`, and `authenticated`. Same advisory lock key as `service_pref_set` (`user_id || '|welcome_service_email'`). Event then current in the same transaction as the member insert. `source=signup`, `request_id=signup-seed`. Fingerprint and idempotency key are hashes of the user id and the policy, not the email address. The function does not read `NEW.email`.

**C. Read path.** `consent_get_my_state` still lists keys from `service_pref_defaults` (that is the catalog). The value is the current row when one exists, otherwise `not_configured`. `default_enabled` is not read.

**D. Send path.** No edit to `_email_send_decision`. No defaults fallback.

**E. Two phases.**
1. `WSE_up.sql` — inert. Welcome flag stays null. Trigger is installed but the seed predicate fails closed.
2. `WSE_ACTIVATE.sql` — not part of phase 1. Refuses unless `wse.allow_activation=YES` in the same transaction. Then `admin_w_activate_welcome_service_email_default` sets `default_enabled=true`, `effective_from=clock_timestamp()` (caller cannot backdate), `policy_version=welcome_service_email.v1`, `configured_at`, `configured_by`. Super-admin only. Idempotent replay of the same key returns the stored JSON. A second key raises `welcome_default_already_active`. If a soft rollback cleared the policy, replaying the old key raises `welcome_default_replay_stale` instead of reporting success. If the seed trigger is missing, it raises `activation_requires_seed_trigger` and does not write the flag.

## Soft rollback

`WSE_down_soft.sql` drops the trigger, the seed function, and the activation function if present, and nulls the welcome policy columns. It does not delete `member_service_pref_*` rows, does not drop the new columns or checks, and does not restore the old defaults fallback.

Re-enable order after a soft rollback: apply `WSE_up.sql` again (trigger returns, policy still null), then run `WSE_ACTIVATE.sql` under a new approval with a new idempotency key.

## What this package does not do

No production SQL. No `default_enabled=true` in the inert file. No writes to existing users. No enqueue, outbox, dispatch, allowlist, provider flags, or Auth mail settings. No Başak send. No marketing grant. No backfill.

## Tests

See `WSE_TEST_MATRIX.md`. The matrix runs on a throwaway local Postgres 16 database (`gates/wse_ephemeral.sh`). A second throwaway database runs the two-session race (`gates/wse_concurrency.sh`). Both refuse a Supabase host. Current PGlite builds in this environment do not ship the `pgcrypto` contrib the send-path function needs, so the runnable gate is Postgres itself.
