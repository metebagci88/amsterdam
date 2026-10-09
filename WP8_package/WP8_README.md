# WP8 — Welcome automation and e-mail pipeline closure (İŞ PAKETİ 8)

Branch `wp8-welcome-automation`. Supabase free plan + Cloudflare Pages. Resend free quota (100/day, 3,000/month) shared with Auth OTP.

**Özet (TR).** WP8, yeni üyeye tek, idempotent ve tercih-saygılı bir hoş geldin e-postası (onaylı v3.2, byte-exact) gönderecek hattı kurar. Migration uygulandığında **hiçbir şey açılmaz**: otomasyon kapalı, sınır (boundary) NULL, kotalar 0, sağlayıcı bayrakları dokunulmadan false. Gönderim yalnız sahibin (owner) onayladığı ayrı adımlarla, önce kontrollü allowlist ile açılır; public açılış ayrı, sonra ve fail-closed. Mevcut üyelere (WSE aktivasyonu 2026-09-30 ile WP8 go-live arasında kaydolanlar dahil) **backfill yok**. Auth SMTP/OTP ve marketing bayrakları değişmez.

Nothing in this package contacts production by itself. Every production step below is a separate, owner-approved call. Secrets and e-mail addresses never go into files, chat or logs.

---

## 1. STOP items and go-live blockers

| ID | Kind | Finding | Action |
|---|---|---|---|
| STOP-1 | needs owner acknowledgment (D1) | Live `md5(prosrc)` differs from the raw repo body for 6 of 14 functions (`_email_can_set_delivery`, `_email_send_decision`, `email_enqueue`, `email_claim_batch`, `email_mark_result`, `email_ingest_provider_event`). Loading `CDP3D_package/CDP3D_up.sql` into PostgreSQL 16 and applying normalization N (drop whole `--` comment lines, strip trailing `--` comments) reproduces all 6 live values exactly; the other 8 match the raw repo byte-for-byte. CDP-3D was applied from a comment-stripped copy. Code is token-identical. | Acknowledge "comment-only drift, semantics identical" before the apply window (STOP until then). `db/WP8_DB_pre_assert.sql` pins the exact live (normalized) md5s, because PRE must match production as it is; the migration's own PRE guard, `WP8_DB_post_assert.sql` and the post-rollback assert accept both forms. WP8 bodies contain no `--`, and the rollback restores the exact live (normalized) bodies. Re-proved on every CI run (`wp8_md5_parity.py`, `wp8_ephemeral.sh`). |
| P-1 | public go-live blocker | The v3.2 opt-out link `https://asalocal.club/preferences` (html + text) has no page or `_redirects` rule on main; Pages serves the home page and the preferences dialog does not open. | Separate site change before public go-live (a `_redirects` rule plus a hook that opens the WP4 prefs dialog). The template stays byte-exact. Not needed for the allowlist phase. |
| P-2 | public go-live blocker | `mailto:destek@asalocal.club` may have no MX (template open issue). | WP7 support channel. |
| P-3 | public go-live check | Apex links rely on an apex → www redirect (template open issue). | Verify live before public go-live. |
| R-1 | risk, recorded | `trg_member_ref` on `public.members` exists live but not in the repo. | The PRE assert inventories every trigger on `public.members`, `auth.users`, `auth.identities` (definition, function md5, SECURITY DEFINER flag, tables written) and fails on any trigger body that calls HTTP or the e-mail pipeline. The owner setup refuses on the same condition. |

md5 parity (live PRE 2026-10-08 vs repo; computed by loading the SQL into a local PostgreSQL 16):

| function | live | raw repo | N(repo) |
|---|---|---|---|
| `_email_can_set_delivery` | `164c0e3f…` | `2a017fd5…` | = live |
| `_email_send_decision` | `4da18d72…` | `cd4968cf…` | = live |
| `email_claim_batch` | `08fc0039…` | `317199cf…` | = live |
| `email_enqueue` | `ba947a7c…` | `ed3c0fcd…` | = live |
| `email_ingest_provider_event` | `8688c2d9…` | `c79386a5…` | = live |
| `email_mark_result` | `5d34c6af…` | `e3f69dd3…` | = live |
| `_email_status_rank`, `_email_system_apply_suppression`, `admin_q_email_delivery_status`, `email_purge_expired_content`, `_seed_welcome_service_pref_on_member_insert` (WSE), `consent_get_my_state` (WSE), `service_delivery_readiness_check` (CDP-3C), `service_pref_set` (CDP-3C) | = raw repo | | |

---

## 2. What WP8 does

```
members INSERT (first login) --AFTER INSERT--> WSE seed (unchanged): pref(welcome)=true      (no enqueue in the signup transaction)
pg_cron wp8-welcome-sweep */5 --> welcome_enqueue_sweep()          SECURITY DEFINER, service_role/owner only, counts only
   gates (all fail closed, zero writes): policy, auto on, boundary set, not paused, caps >= 1, service_enabled,
                                         WSE policy active, template v3.2 pinned (html + text sha256 recomputed)
   candidates: auth.users.created_at >= greatest(boundary, WSE effective_from); member age in [delay, max-age];
               pref = true; not blocked; e-mail present; (active allowlist row OR public go-live AND signed up
               after public_go_live_since); no welcome row ever (legacy rows included)
   per user: advisory lock uid|welcome_service_email (same key as service_pref_set and the WSE seed)
             -> _email_send_decision (authoritative, no default fallback) -> welcome_render(v3.2, first_name)
             -> email_enqueue(key 'wp8:welcome_service_email:v1:<uid>'); anything but queued/idempotent rolls the
                sub-transaction back (no skipped row, no burned key)
pg_cron wp8-email-dispatch-kick 2-59/5 --> email_dispatch_kick() --pg_net--> Edge service-email-dispatch v4 (token path)
   Edge: email_claim_batch (serialized; caps; OTP headroom; capped lease reclaim; 20 h retry horizon; stale welcome expiry)
         -> Resend (Idempotency-Key outbox-<id>, 1 req/s, 15 s timeout, 90 s budget)
         2xx -> email_mark_result(ok) + late-link of early webhook events
         400/401/403/404/405/422 -> terminal failed (401/403 also stop the batch)
         408/409/5xx/network -> retry with 2,4,8,16 min backoff, at most 5 attempts
         429 -> email_release_claim (attempt refunded, at most 6 per row), rest released, batch stops
Resend webhook --> resend-webhook Edge (unchanged) --> email_ingest_provider_event (unchanged)
pg_cron wp8-email-purge 17 3 * * * --> email_purge_expired_content() (CDP-3D 30-day body purge, first time scheduled)
```

Unchanged: WSE seed trigger, `_email_send_decision`, `email_enqueue`, `email_ingest_provider_event`, `_email_system_apply_suppression`, `admin_q_email_delivery_status`, the resend-webhook Edge, Auth SMTP/OTP, marketing tables and flags, the CDP-3B template library (its classes are marketing/transactional only and its sanitizer strips `<style>`/`@media`, so v3.2 is stored in its own immutable table instead).

Changed: `email_claim_batch` and `email_mark_result` (same signature, return type and ACL; new bodies), the dispatch Edge (v4), new WP8 objects.

Key properties (each one is a named CI check, see §10):

- **Inert on apply.** No row in outbox, events, allowlist, prefs, members, auth or provider config is written; the migration's own PRE/POST guards abort the transaction otherwise.
- **No backfill.** The boundary is the setter's own clock (`clock_timestamp()` at enable), can only move forward and never below the changing transaction's start (the policy row cannot be backdated, deleted or re-inserted non-inert, and service_role has no write grant on WP8 tables). Public go-live (setter or direct SQL, insert or update, every reopen) records `public_go_live_since`; non-allowlisted users must have signed up after it.
- **One welcome per user.** `email_outbox_welcome_once_uk` (from 2026-10-01; the 3 legacy rows are tolerated), the deterministic key, single-flight sweep, NOT EXISTS over all welcome rows.
- **Opt-out.** Pref OFF before enqueue → no row; pref OFF after enqueue → `skipped/service_pref_disabled` at claim.
- **Quota.** Rolling 24 h / 31 day caps for optional_service (default 0 = nothing claimable; ceilings 50/day, 1,500/month), and every claim (both classes) also stays under `100 - otp_reserve_daily (>= 20, default 30) - OTP lower bound - used` and the monthly equivalent. The OTP lower bound counts `auth.users.*_sent_at` in the window; if those columns are missing the claim fails closed.
- **Bounded retry.** 5 attempts, 6 free 429 releases, permanent 4xx terminal, lease expiry backs off and fails at max attempts, nothing retried later than 20 h after the first attempt (inside Resend's 24 h idempotency window), queued welcomes expire after 72 h even while paused. Transient bounces are terminal as in CDP-3D (no retry; a retry would need a new provider key).
- **PII.** first_name is HTML-escaped in the html part, raw in text/plain; NULL, blank, > 50 chars, control, line-separator or brace characters give the neutral `Merhaba,`. Subject is static. Rendered bodies are purged after 30 days. Sweep, ledger, Edge responses and evidence carry counts and labels only.

---

## 3. Files

| Path | Purpose | Applied by |
|---|---|---|
| `db/WP8_DB_up.src.sql` | Human-edited migration source (placeholders) | never (build input) |
| `db/WP8_DB_up.sql` | Generated migration: inert, single transaction, no DROP text, no `--` in bodies, template hex-embedded | `apply_migration('wp8_welcome_automation_inert')` |
| `db/WP8_MANIFEST.json` | Build manifest: 14 functions (body md5, service_role EXECUTE), 5 tables, template shas | — |
| `db/WP8_DB_pre_assert.sql` | One read-only SELECT before apply | `execute_sql` |
| `db/WP8_DB_post_assert.sql` | One read-only SELECT after apply (43 checks) | `execute_sql` |
| `db/WP8_DB_zf_probe.sql` | Optional zero-footprint probe: one DO block that always ends in `RAISE EXCEPTION 'WP8_ZF_DONE:…'` | `execute_sql` (optional) |
| `db/WP8_DB_scheduler_optin.sql` | Armed: `email_dispatch_kick()` + 3 pg_cron jobs | owner-approved |
| `db/WP8_DB_owner_setup.sql` | Armed template, placeholders only (step, actor uuid, QA label, QA user uuid) | owner-approved, one step per call |
| `db/WP8_DB_evidence.sql` | One read-only SELECT: acceptance evidence + STOP flags, labels/counts only | `execute_sql` |
| `db/WP8_DB_rollback.sql` | Functional rollback, no DROP | owner-approved |
| `db/WP8_DB_post_rollback_assert.sql` | One read-only SELECT after rollback | `execute_sql` |
| `db/WP8_DB_rollback_cleanup_optional.sql` | The ONLY file with DROP (functions + guard trigger; tables kept) | optional, separate approval |
| `ops/WP8_OPS_extensions_enable.sql` | Armed: `pg_cron`, `pg_net` | owner-approved |
| `ops/WP8_OPS_kill_switch_soft.sql` / `_hard.sql` | Off-only switches | emergency |
| `ops/WP8_OPS_scheduler_unschedule.sql` | Removes the 3 wp8 jobs | kill switch / rollback |
| `ops/WP8_OPS_public_go_live.sql` | Armed: public go-live via the guarded setter | later, owner + legal |
| `scheduler/wp8-dispatch-fallback.yml.disabled` | GitHub Actions fallback scheduler (inert outside `.github/workflows`) | only if D2 = fallback |
| `rollback/edge-service-email-dispatch-v3/index.ts` | Byte-exact v3 Edge (sha256 `1279d9aa…`) for rollback | redeploy on rollback |
| `tools/wp8_build.mjs`, `tools/wp8_normalize.py` | Deterministic build; normalization N | dev/CI |
| `gates/*` | CI gates (§10) | CI only |
| `SHA256SUMS` | Pins every file above | CI |
| `../CDP3D_package/edge/service-email-dispatch/index.ts` | Edge v4 (sha256 `b21d911d…`; dispatch line updated in `CDP3D_package/SHA256SUMS`) | `deploy_edge_function`, owner-approved |
| `../.github/workflows/wp8-gates.yml` | CI | PR |

Build: `node WP8_package/tools/wp8_build.mjs` (writes `WP8_DB_up.sql` + `WP8_MANIFEST.json`); `--check` verifies byte equality. Never edit the generated file by hand; md5 constants come from the build.

---

## 4. Apply runbook (one approval window per step; PRD §2.2 stop rule applies to every step)

Program order: merge only after WP7 PASS, CI green, normal merge commit.

1. **PRE** — `execute_sql` with `db/WP8_DB_pre_assert.sql`. Expect `{"wp8_pre": true, "failed": []}`. Record `facts` (trigger inventory, function owners, auth column inventory). Any FAIL → STOP.
2. **Apply** — `apply_migration` name `wp8_welcome_automation_inert`, body `db/WP8_DB_up.sql` (one transaction; statement 2 aborts in autocommit mode with `WP8_NOT_SINGLE_TRANSACTION` before any DDL). Guard error → whole transaction rolled back → STOP, no retry.
3. **POST** — `execute_sql` with `db/WP8_DB_post_assert.sql`. Expect `{"wp8_post": true, "failed": [], "n": 43}`. Optionally `db/WP8_DB_zf_probe.sql`: expect the error text `WP8_ZF_DONE:{"pass": true, …}` (the error is the success signal; every change is rolled back). Any other result → STOP.
4. **Edge v4 + secrets** (owner, Dashboard; names only, values never in chat/files/logs):
   - Edge secret `DISPATCH_TRIGGER_TOKEN`: fresh random value, at least 32 characters (for example `openssl rand -hex 32` run locally by the owner).
   - Vault secrets by name: `wp8_dispatch_token` (same value), `wp8_dispatch_gateway_jwt` (the project's legacy anon JWT; confirm the project still issues legacy JWT keys, `verify_jwt=true` needs one), `wp8_dispatch_url` (`https://<project-ref>.supabase.co/functions/v1/service-email-dispatch`).
   - Operator: `deploy_edge_function service-email-dispatch` with the v4 bytes (`verify_jwt=true`), then byte/sha check of the deployed source.
   - Smoke (no send possible: flags are off and caps are 0): GET → 405, POST without auth → 403, anon JWT without token → 403.
   - Deploy order: DB migration first (v4 calls `email_release_claim`), then Edge v4, then secrets, then the scheduler. Edge v4 against a pre-WP8 database is not supported; the v3 Edge against the WP8 database is compatible.
5. **Scheduler** (D2) — owner-approved, one call: `ops/WP8_OPS_extensions_enable.sql` (arm `@@ARM_YES@@`) then `db/WP8_DB_scheduler_optin.sql` (arm). It checks the extensions, the WP8 migration, the 3 Vault names (count only), and afterwards that the scheduling role can execute the sweep, kick and purge and owns the 3 jobs. Still inert: the sweep reports `auto_disabled`, the kick `classes_disabled`.
   - Log check after the first kicks (read-only, Dashboard → Edge logs): the `x-asalocal-dispatch-token` value must never appear; otherwise STOP and move the token into the JSON body (new spec).
6. **Allowlist phase** — §5.
7. **Close** — §5 step 7. Report counts only → WP8 PASS (allowlist phase).
8. Later, separate: public go-live (§8).

---

## 5. Allowlist phase and sequential acceptance (owner setup template)

`db/WP8_DB_owner_setup.sql` is a template. For each call the owner replaces every placeholder in the approved copy: `@@ARM_YES@@` → `YES`, `@@STEP@@` → `enable | allowlist | close`, `@@SUPER_ADMIN_UUID@@` → the owner's super_admin user id, `@@QA_LABEL@@` → `A | B | C` (allowlist only, otherwise `NONE`), `@@QA_USER_UUID@@` → the QA user's id (allowlist only, otherwise the zero uuid). An unreplaced placeholder fails closed. Every step re-checks: WP8 functions equal the stored manifest, template shas, no risky trigger on members/auth, OTP columns present, readiness callable, and (if installed) the 3 cron jobs active.

A **run** is everything since the current boundary (`welcome_enqueue_from`, set by `enable`). The labels `wp8-qa-A/B/C` belong to the run in which they were allowlisted (allowlist `added_at` ≥ boundary): within a run each label is used once, the B gate waits for the A of the same run, and `db/WP8_DB_evidence.sql` judges only the current run (earlier runs' rows are reported as history: `global.this_run.earlier_qa_rows`, `wp8_rows_total`). A user id is never allowlisted twice.

QA users are ordinary accounts the owner creates through the normal site sign-up **after** the enable step (Auth OTP; no direct `auth.users` writes). Existing accounts can never be used: they signed up before the boundary, which is exactly the no-backfill rule. Use mailboxes the owner controls; never write the addresses anywhere. Find the QA user ids in Dashboard → Authentication → Users (copy the UUID only).

1. `enable` — caps 40/1,200 (D3), delay 10 min, max-age 48 h, queue expiry 72 h, `admin_w_welcome_automation_set` (boundary = its own clock), `service_enabled=true`; `essential_enabled` and `public_go_live` stay false. Refuses unless flags are all false, the allowlist is empty and nothing is in flight.
2. Owner signs up QA-A, QA-B, QA-C. QA-A enters first name `O'Neil` in the WP5 profile banner (proves escaping). QA-B leaves first name empty (proves `Merhaba,`). QA-C switches the welcome preference OFF in the e-mail preferences dialog.
3. `allowlist` A, then `allowlist` C (within the delay is fine). The step refuses a user who signed up before the boundary, never logged in, is too old for the window, has outbox rows, has the wrong pref state (A/B on, C off), or when the acceptance window (24 h after enable) is over.
4. After 10–15 min: `execute_sql` `db/WP8_DB_evidence.sql`. Expect `stop=false`; `wp8-qa-A` 1 row, `delivered`, `key_ok`, `template_v32`, `html_greeting_escaped_oneil`, `text_greeting_oneil`; `wp8-qa-C` 0 rows; `global.this_run.wp8_rows` 1; `legacy_rows` 3; ledger errors 0; kick HTTP all 200. Further sweeps add nothing. On the D2 fallback path (no pg_net, as in production today) `global.pg_net_present` and `pg_cron_present` are false and the `kick_http_*` fields are null: the kick evidence is then that every run of the fallback workflow since `enable` is green (it fails on any non-200), and every other STOP rule is still evaluated by the evidence (rehearsed in `wp8_ephemeral.sh` and on PG17 in `wp8_pglite_gate.mjs`).
5. `allowlist` B — refused unless the A of this run is active and its welcome reached `sent`/`delivered`, and only within 24 h of enable (otherwise B is too old: STOP and re-plan). After 10–15 min, evidence again: B 1 row, `delivered`, neutral greeting; `global.this_run.wp8_rows` 2.
6. Dedupe proof: the owner re-sends one delivered webhook from the Resend dashboard. Count it only if Resend reuses the original `svix-id` (check the message id in the Resend UI); then the endpoint answers `duplicate:true` and the event count is unchanged (the evidence `events` per label stays the same). Replay of the enqueue itself is proven in CI (`idempotent:true`, a second key → `unique_violation`).
7. `close` — allowlist rows of A/B/C set inactive (kept as labelled evidence); automation stays on but nobody is eligible without an allowlist row or public go-live (D8); `public_go_live` stays false.

STOP rules during acceptance: evidence `stop=true` (sweep errors or kick HTTP ≠ 200 in this run — with pg_net; on the fallback path a red fallback-workflow run is the same STOP —, a duplicate welcome in any run, backfill in any run — each wp8 row is judged against the boundary in effect when it was created, taken from the setter's audit rows —, QA-C welcomed, a skipped wp8 row from the sweep or a failed wp8 row in this run); the first provider send rejected (403/422 is terminal at once, 401/403 also stop the batch) → soft kill switch, then report. Total Resend sends for the acceptance: 3 OTP + 2 welcomes.

---

## 6. Kill switch

1. Soft (default, safe any time): `ops/WP8_OPS_kill_switch_soft.sql` — automation off + `service_dispatch_paused=true`. No new enqueue, no optional claim; queued welcomes stay queued and are canceled by the claim once older than 72 h (before any pause/cap/flag check), so a later re-enable never sends a stale welcome. Re-enable later moves the boundary forward (no backfill of the paused window).
2. Hard: `ops/WP8_OPS_kill_switch_hard.sql` — `service_enabled=false`, `public_go_live=false`, automation off + paused, every queued (and lease-expired sending) wp8 welcome canceled (`wp8_kill_switch`), wp8 cron jobs unscheduled. Re-run after 2 minutes while the notice reports `still_sending > 0`. Lock order (config → policy → outbox) matches the sweep, so they cannot deadlock.
3. Provider level (owner, Dashboard): remove `RESEND_API_KEY` (503) or `DISPATCH_TRIGGER_TOKEN` (token path 403).

None of these touch Auth SMTP/OTP or marketing.

Resume after a soft kill (owner-approved, one transaction): `update public.email_service_policy set service_dispatch_paused = false where id = 1;` then `select public.admin_w_welcome_automation_set('<super_admin uuid>', true, '<reason>', '<request id>');`. The boundary moves to that moment, so nobody who signed up while automation was off is welcomed later.

Re-run after a hard kill (each step owner-approved; rehearsed end to end in `wp8_ephemeral.sh`):
1. Re-run the hard kill until its notice reports `still_sending=0`.
2. Re-run `db/WP8_DB_scheduler_optin.sql` (armed). The hard kill unscheduled the 3 wp8 jobs, and every owner-setup step refuses with `wp8_setup_scheduler_incomplete:0` until they are back.
3. `close`, then `enable`: the boundary moves forward to that moment and a new run starts.
4. The allowlist phase again (§5) with **new** QA accounts that sign up after this `enable`. The earlier run's QA rows stay inactive as evidence; accounts that already have outbox or allowlist rows, or that signed up before the new boundary, are refused.

---

## 7. Rollback (mandatory order)

1. Kill switch soft, then hard (§6).
2. Redeploy the v3 Edge: `rollback/edge-service-email-dispatch-v3/index.ts` (sha256 `1279d9aa52a8f8cee40d56389baf0e58f1101369ced0188f949d176536a10537`).
3. `db/WP8_DB_rollback.sql` (functional, no DROP, one transaction): `service_enabled=false`, `public_go_live=false`, automation off + paused, queued and lease-expired wp8 rows canceled, wp8 jobs unscheduled, `email_claim_batch`/`email_mark_result` restored to the exact live CDP-3D bodies (md5 `08fc0039…`/`5d34c6af…`), go-live guard trigger disabled. Refuses while a wp8 row is sending under an active lease (wait 2 minutes). Expect `WP8_ROLLBACK_OK`.
4. `db/WP8_DB_post_rollback_assert.sql`: expect `{"wp8_rolled_back": true}`.
5. Optional, separate approval: `db/WP8_DB_rollback_cleanup_optional.sql` (DROP of WP8 functions and the guard trigger; tables, columns, indexes and rows kept as evidence). Its commented HARD section (tables/columns) must run before any CDP-3D down.
6. Owner: delete the Edge secret and the 3 Vault secrets in the Dashboard.

Re-apply after rollback (and after cleanup) is tested; `service_dispatch_paused` stays true until the owner's next `enable`.

---

## 8. Public go-live (later, not needed for WP8 PASS)

Preconditions outside the database: P-1, P-2, P-3 fixed; KVKK text bound to the controller and the service-delivery readiness attestations recorded (CDP-3C readiness must report `ready`). Then `ops/WP8_OPS_public_go_live.sql` (arm + actor). The setter and the trigger both refuse without readiness; the trigger also refuses DELETE of the provider config and records `public_go_live_since` on every false → true transition (insert or update, setter or direct SQL), so only users who sign up after that instant become eligible without an allowlist row. Disable is always allowed.

---

## 9. Owner decisions

| # | Decision | Proposed default |
|---|---|---|
| D1 | Acknowledge STOP-1 (comment-only md5 drift, semantics identical, reproduced by normalization) | acknowledge |
| D2 | Scheduler: pg_cron + pg_net (primary, inside the DB, free) or the GitHub Actions fallback (`scheduler/…disabled`) | pg_cron + pg_net |
| D3 | optional_service caps: daily / monthly (ceilings 50 / 1,500) and the OTP reserve (default 30/day, 600/month; floors 20 / 300). Confirm in the Resend dashboard whether Auth SMTP uses the same Resend team and record the team's actual rate limit (Settings → Usage); the Edge sends at most 1 request/s | 40/day, 1,200/month, reserve 30/600 |
| D4 | Delay after first login / max-age / queue expiry | 10 min / 48 h / 72 h |
| D5 | Approve 3 new labelled QA accounts created through the normal sign-up after `enable` (PRD §2.4 "no new users without permission"), 2 real welcome sends + 3 OTPs, and accept the residue as labelled evidence instead of residue=0: append-only `email_send_events`, the outbox rows they reference, `member_service_pref_events`, members rows, inactive allowlist rows, `admin_write_log` rows, plus whatever the live members/auth triggers write (see the PRE trigger inventory, e.g. `trg_member_ref`). The QA auth accounts may be deleted by the owner afterwards; outbox/event rows stay | approve |
| D6 | Live bounce test (Resend's bounce test recipient would leave a permanent hard_bounce suppression row; it also needs an account that can receive the OTP) | skip (CI covers permanent and transient bounces) |
| D7 | Allowlist phase: `service_enabled=true` (public_go_live and essential stay false) and automation enabled (boundary = that moment) | approve |
| D8 | End state after acceptance: automation on for allowlisted users only (allowlist rows inactive), or automation off + paused | keep on, allowlist inactive |
| D9 | Owner actions without secrets in chat: Edge secret `DISPATCH_TRIGGER_TOKEN`, Vault `wp8_dispatch_token`, `wp8_dispatch_gateway_jwt`, `wp8_dispatch_url`; approve the Edge v4 deploy | — |
| D10 | Add `/WP8_package/*  /  302` to `_redirects` (same serve-block CDP-3D has; outside WP8_package, separate small change). Without it Pages serves the WP8 SQL and docs publicly after merge (no secrets inside) | yes |
| D11 | Public go-live later and separately (P-1, P-2, P-3, KVKK/controller, readiness) via `ops/WP8_OPS_public_go_live.sql` | later |
| D12 | The first purge job run will clear the bodies of the 2026-09-30 legacy rows after 30 days, including outbox row `4cf96896…`, which `welcome_service_email.v3.2.json` names as the AUTHORITATIVE_OUTBOX_COPY provenance source. The v3.2 bytes stay pinned in the repo and in `email_service_templates` (sha256), so provenance survives; approve the purge (or keep the purge job unscheduled) | approve |
| D13 | Template publish approval: `welcome_service_email.v3.2.json` requires a separate approval for the production record, the class and the renderer. Approving the WP8 apply is that approval: the migration inserts v3.2 into `email_service_templates` (class optional_service, immutable, sha-pinned) and installs `welcome_render`; it stays inert until D7 | approve with the apply |
| D14 | Transient bounces are terminal (no retry), as in CDP-3D; a retry would need a new provider key because `outbox-<id>` is deduplicated by Resend for 24 h | accept |

---

## 10. Gates

Run locally (throwaway PostgreSQL on 127.0.0.1, never production; every script refuses `*supabase.co*`):

```
export WP8_NODE_MODULES=<dir with @electric-sql/pglite@0.3.16, pg@8.13.1, esbuild@0.24.0>
bash WP8_package/gates/wp8_pg.sh start
actionlint -shellcheck= -pyflakes= .github/workflows/wp8-gates.yml   # pinned v1.7.7 (CI: go install ...@v1.7.7)
node WP8_package/tools/wp8_build.mjs --check
node WP8_package/gates/wp8_static_check.mjs              # WP8_STATIC_PASS
python3 -I WP8_package/gates/wp8_md5_parity.py           # WP8_MD5_PARITY_PASS
bash WP8_package/gates/wp8_secret_scan_selftest.sh       # WP8_SECRET_SCAN_SELFTEST_PASS
bash WP8_package/gates/wp8_secret_scan.sh                # SECRET_SCAN_CLEAN
bash WP8_package/gates/wp8_ephemeral.sh                  # WP8_EPHEMERAL_PASS
bash WP8_package/gates/wp8_db_suite.sh                   # WP8_DB_SUITE_PASS
bash WP8_package/gates/wp8_scheduler_stub_test.sh        # WP8_SCHED_PASS
node WP8_package/gates/wp8_pglite_gate.mjs               # WP8_PGLITE_PASS
node WP8_package/gates/wp8_edge_harness.mjs              # WP8_EDGE_HARNESS_PASS
bash WP8_package/gates/wp8_cdp3d_regression.sh           # WP8_CDP3D_REGRESSION_PASS
bash WP8_package/gates/wp8_mutation.sh                   # WP8_MUTATION_PASS
bash WP8_package/gates/wp8_pg.sh stop
```

Each suite prints its sentinel only when its pass count equals a hard-coded expected number and nothing failed.

| Gate | What it proves |
|---|---|
| `wp8_static_check.mjs` | Workflow expression contexts valid where used (no `runner.*` in job-level env; checker probed so it is not blind), pinned actionlint step present; no DROP outside the cleanup file; `--` only at column 0 outside bodies; SECURITY DEFINER ⇒ search_path; no net/cron/vault/auth/marketing/allowlist/outbox/member writes or public grants in the migration; build determinism; embedded hex = repo template bytes = SHA256SUMS; subject = JSON; address allowlist; Edge v4 constraints; read-only asserts are single SELECTs; ZF probe self-aborts; no pre-armed file; manifest/ACL consistency; kill-switch lock order; rollback DROP-free; CI workflow without secrets; behaviour-suite clock discipline for PGlite's 1 ms clock (a user that must predate a transition is created 5 ms earlier, a re-enable/reopen waits first; checker probed so it is not blind) |
| `wp8_md5_parity.py` | STOP-1 re-derived from the repo on every run; every guard/assert/rollback carries the same constants |
| `wp8_secret_scan*.sh` | Scoped like `cdp3d_secret_scan.sh` (values, not names: `Deno.env.get("..._KEY")` is not a finding, unlike the generic CDP-3C scanner); runtime-built fake JWT/keys/tokens are caught in the Edge, in SQL and anywhere in the default scope |
| `wp8_ephemeral.sh` (80 checks) | md5 parity on loaded SQL (normalized + raw chains); PRE true; autocommit apply refused with no residue; double apply; POST 43/43; inert sweep/claim/reconcile; trigger inventory; behaviour suite on both chains; ZF probe zero footprint (also inside BEGIN/COMMIT); full owner-setup rehearsal (A, C, then B; evidence; webhook dedupe; close); kill switch; re-run after a hard kill (scheduler opt-in, close, enable, new A/C/B, run-scoped labels, B gate and evidence, backfill still flagged for current and earlier runs); kick STOP rule with pg_net (500 and failed requests flagged, 200s not); D2 fallback path without pg_net/pg_cron (evidence returns on the inert DB, enable → A delivered → stop=false, and failed row, sweep error and backfill still raise STOP; a positive case for each remaining STOP rule: a welcome for this run's QA-C user → exactly `qa_c_pref_off_but_welcomed`, a skipped wp8 row → exactly `sweep_skipped_row` while a `service_pref_disabled` skip is no STOP, two welcome rows for one user → exactly `duplicate_welcome`, every probe rolled back); functional rollback + assert; post-rollback decision on a fresh non-allowlisted user (setup asserted, then skipped/not_in_allowlist, then an allowlisted control); cleanup; re-apply |
| `wp8_behavior.sql` (188 checks, PG16 and PG17) | gates, setters, boundary/no-backfill (1-second guard probes, disable → re-enable moves the boundary past the off window), monthly service cap over 31 days, monthly total with the OTP reserve and 31-day OTP bound, daily cap over 24 h for every class, daily and monthly usage counted by `sent_at` whatever the row became (history built only from rows turned delivered or bounced through the real webhook: both caps and both OTP reserves), one total ceiling shared by both classes, rows at max_attempts never claimed, 429 refund of exactly one attempt, essential re-check at claim, optional (welcome) re-check at claim for every denial flipped after enqueue (service class off, de-allowlisted, unsubscribed, hard bounce, pref row missing, pref OFF; one untouched control claimed), one welcome per user whatever the first row's status, cohort (allowlist, pref, block, max-age, delay, suppression), exact sweep counts, render/escaping, template pins and tamper probes, caps, pause, OTP headroom, essential ceiling, 4xx classification, backoff, 429 releases, lease loop, retry horizon, stale-welcome expiry under pause, late-link and reconcile, go-live trigger (direct SQL, insert, delete, reopen), race without key burn |
| `wp8_db_suite.mjs` (28 checks) | Real concurrency (6 sweepers × 5 runs → 30 rows; busy single-flight; lock-free race → unique_violation; pref flip; parallel claims under a cap; claim serialization with a held-open transaction: 55P03 under lock_timeout, blocking then 0 under the OTP headroom; lease/429/horizon loops) and Supabase default-privilege ACLs |
| `wp8_pglite_gate.mjs` (29 checks) | The whole chain, asserts, acceptance evidence without pg_net/pg_cron, behaviour, ZF, rollback, re-apply on PostgreSQL 17; D2 fallback rehearsal with the real owner setup (enable, allowlist A and C, A delivered) and a positive case for every evidence STOP rule that can fire without pg_net (QA-C welcomed, skipped row, duplicate welcome, failed row, sweep error, backfill) |
| `wp8_edge_harness.mjs` | The real v4 Edge bundled with esbuild against fakes: auth paths, limits, pacing, timeouts, time budget, 429/401/403/422/500/network paths, RPC-error stops, sweep/purge flags, counts-only responses |
| `wp8_scheduler_stub_test.sh` | Arm required, Vault names required, 3 exact jobs, kick conditions, URL and token validation, unschedule, kill switch |
| `wp8_cdp3d_regression.sh` | CDP-3D gates unchanged on the pre-WP8 schema; CDP-3D PGlite gate and node DB suite on CDP-3D+WSE+WP8 with an explicit expected-delta list (lease reclaim now backs off) |
| `wp8_mutation.sh` | 98 mutants (spec M1–M22, one or more per critic amendment, and the fixer-round mutants C2–C21, B5–B7, U6, T1b/T2/T8, P4, R1–R5, W1, K1, C29/C30, E1/E2, R3P6a–c/R4P4/R4P2, R3V1–R3V5, R3F1–R3F5); each must fail a named check |

Other workflows this PR triggers and that must stay green: `cdp3d-gates.yml` and `cdp3d-edge-integration.yml` (paths `CDP3D_package/**`; the latter serves the real v4 Edge on an ephemeral local Supabase and checks GET → 405, no auth → 403, anon without token → 403 with `DISPATCH_TRIGGER_TOKEN` unset, service_role without `RESEND_API_KEY` → 503).

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| OTP starvation | caps default 0; ceilings 50/1,500; OTP reserve + OTP lower bound in every claim; 1 req/s; 429 stops the batch |
| Duplicate welcome after Resend's 24 h idempotency window | 20 h retry horizon; bounded attempts and releases; unique index |
| Webhook before mark_result | late-link in mark_result + reconcile in the sweep; events stay append-only |
| Comment-stripping apply path | no `--` in bodies; hex template; guards accept both md5 forms |
| `apply_migration` not transactional | statement-2 probe aborts before DDL |
| Token or anon JWT in Vault leaks | the token only triggers a run that DB flags gate; rotate in the Dashboard; no service_role key stored |
| Legacy JWT keys deprecated | D9 check; otherwise a new spec (service_role path stays for manual use) |
| First send rejected (custom from-domain) | permanent 4xx terminal at once, 401/403 stop the batch; soft kill switch |
| Unknown production triggers | PRE trigger inventory; owner setup refuses risky triggers |
| Late welcomes after a pause | 48 h max-age at enqueue; 72 h expiry in sweep and claim; boundary moves forward on re-enable; `public_go_live_since` on every opening |
| WP8 package publicly served by Pages | D10 serve-block |
