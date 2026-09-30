# welcome_service_email future-default — test matrix

Ephemeral only. The inert migration is applied to a throwaway database. Activation runs inside a transaction that rolls back, except the concurrency script, which uses a database created for that process and dropped on exit.

| ID | Case | Expected | Where |
|---|---|---|---|
| T1 | Existing user, no welcome row | RPC `not_configured` (UI label Kapalı). Send decision `service_pref_missing` even if the welcome flag is true. | `wse_inert_assert.sql`, `wse_behavior.sql` |
| T2 | Auth user created before `effective_from`, `members` insert after activation | No current row, no event | `wse_behavior.sql`, concurrency old-auth race |
| T3 | Auth user created at `effective_from`, even if `members.created_at` is older | One current row, `enabled=true`. UI boolean true. | `wse_behavior.sql` |
| T4 | That seed | Exactly one current row and one event, `source=signup`, `request_id=signup-seed` | `wse_behavior.sql` |
| T5 | Second `INSERT ... ON CONFLICT DO UPDATE` | Still one event | `wse_behavior.sql`, 12-way upsert race |
| T6 | `service_pref_set(..., false)` after seed | Stays false. Send `service_pref_disabled` once class gates are open in the ephemeral probe. | `wse_behavior.sql` |
| T7 | Profile `UPDATE` and another upsert | Does not add an event and does not turn the row on | `wse_behavior.sql` |
| T8 | Flag not fully on (`default_enabled` null, or true without `effective_from`, or false) | No seed | `wse_inert_assert.sql`, `wse_behavior.sql` |
| T9 | Migration and activation with four pre-existing users | Those auth users, member rows, and the two legacy pref rows/events are unchanged. No backfill. | fixture + inert + behavior |
| T10 | Migration, activation, seed, decision probe | `email_outbox` stays 0. Provider flags and allowlist are not changed by the migration or activation. Decision probe opens flags only inside a rolled-back transaction. | inert, behavior, post-down |
| T11 | Marketing | `marketing_config` flags stay false. `member_consent_*` stays empty. | inert, behavior |
| T12 | Parallel create/upsert of one user | One current row, one `signup` event | `wse_concurrency.sh` (12 upserts, 8 plain inserts) |
| T13 | Soft rollback | Trigger and seed function gone. Welcome policy null. Historical pref rows remain. A later insert does not seed, even if the flag is set again while the trigger is absent. | `wse_after_down.sql`, `wse_post_down_assert.sql` |

Also asserted:

- Unarmed `WSE_ACTIVATE.sql` raises `activation_refused_without_explicit_arm` and writes nothing.
- Armed activation after soft rollback raises `activation_requires_seed_trigger`.
- `_email_send_decision` function definition hash is unchanged.
- `consent_get_my_state` no longer contains `default_enabled`.
- Admin audit and pref events contain no `@`.
- Non-welcome key cannot take `default_enabled` true together with `effective_from`.
- Member UI source still maps only `true` to Açık, so `not_configured` renders Kapalı.

## How to run

```bash
node WSE_DEFAULT_package/gates/wse_static_check.mjs
bash WSE_DEFAULT_package/gates/wse_ephemeral.sh
bash WSE_DEFAULT_package/gates/wse_concurrency.sh
```

`wse_ephemeral.sh` creates and drops `wse_ephemeral_suite_<pid>`. `wse_concurrency.sh` creates and drops `wse_ephemeral_conc_<pid>`.

Sentinels: `WSE_STATIC_PASS`, `WSE_EPHEMERAL_GATES_PASS`, `WSE_CONCURRENCY_PASS`.

CI: `.github/workflows/wse-default-gates.yml`.
