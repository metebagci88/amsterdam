# WP7 — Production security policy matrix (PRE, 2026-10-07)

Source: a single read-only `execute_sql` batch against project `tosqsabuaomgqjtogdrn`. It returns only aggregates, booleans and md5 values, with no row data or e-mail addresses. The raw evidence is in `evidence/wp7_pre_security_snapshot_2026-10-07.json`. Matrix md5 (canonical JSON of the 57 rows): `79e1b1e3c001a83a9cd2997a2992e27a`.

## Summary verdicts

| check | result | verdict |
|---|---|---|
| public tables with RLS off | 0 of 53 | PASS |
| RLS-off tables with an anon grant | 0 | PASS |
| writable views for anon/authenticated | 0 (closed by SEC-VIEWS) | PASS |
| anon/public INSERT/UPDATE/DELETE/ALL policies in `public` and `storage` | 0 | PASS |
| SECURITY DEFINER functions in `public` | 143; anon EXECUTE 0, authenticated EXECUTE 23, without a pinned search_path 0 | PASS (23 matches the advisor baseline of 23 WARN authenticated-executable SECURITY DEFINER) |
| storage buckets | `media` public read; writes only via service_role (SEC-MEDIA). `email-assets-public` public with 0 objects. `email-assets-draft` private | PASS |
| http/net triggers (outbound calls from DB) | 0 | PASS |
| pg_cron / pg_net installed | no | n/a (WP8 scheduler topic) |
| marketing_enabled / marketing_capture_enabled | false / false | PASS (WP7 #7, #8) |
| email essential / service / public_go_live | false / false / false | PASS (Auth SMTP is separate and unaffected) |
| welcome_service_email default | true (future default, inert while service_enabled=false) | as designed (WP8) |

## Defence-in-depth note (not a blocker)

`anon` still holds table-level INSERT/UPDATE/DELETE grants on `ads`, `cities`, `point_events`, `site_content`, `site_content_versions` and `venues`. RLS is ON for all of them, and none has an anon/public write policy, so these writes are denied. Revoking the grants would be an optional hardening. It is not applied in WP7, because it is a DDL change outside the WP7 scope. It is listed for a follow-up.

## Advisor items accepted for the beta

- `security_definer_view` on the three public projection views. Since SEC-VIEWS they are SELECT-only for anon/authenticated, and they expose only the projected public columns.
- Leaked-password protection is off. It is a paid-plan feature, so it is not enabled (§2.3).

## Matrix (public schema)

| relation | kind | RLS | FORCE | policies | anon/public policies | anon SELECT grant | anon write grant | auth write grant |
|---|---|---|---|---|---|---|---|---|
| admin_access_log | table | yes | no | 0 | 0 | no | no | no |
| admin_rate_events | table | yes | no | 0 | 0 | no | no | no |
| admin_roles | table | yes | no | 0 | 0 | no | no | no |
| admin_settings | table | yes | no | 0 | 0 | no | no | no |
| admin_users | table | yes | no | 0 | 0 | no | no | no |
| admin_write_log | table | yes | no | 0 | 0 | no | no | no |
| admin_write_ops | table | yes | no | 0 | 0 | no | no | no |
| ads | table | yes | no | 2 | 1 | yes | yes | yes |
| anon_consent_current | table | yes | yes | 0 | 0 | no | no | no |
| anon_consent_events | table | yes | yes | 0 | 0 | no | no | no |
| anon_consent_subject | table | yes | yes | 0 | 0 | no | no | no |
| app_privacy_config | table | yes | yes | 0 | 0 | no | no | no |
| audit_log | table | yes | no | 0 | 0 | no | no | no |
| behavior_event_log | table | yes | no | 0 | 0 | no | no | no |
| cities | table | yes | no | 2 | 1 | yes | yes | yes |
| comment_reactions | table | yes | no | 1 | 0 | no | no | yes |
| comments | table | yes | no | 4 | 0 | no | no | yes |
| consent_purpose_doc | table | yes | yes | 0 | 0 | no | no | no |
| consent_text_approvals | table | yes | yes | 0 | 0 | no | no | no |
| consent_text_versions | table | yes | yes | 0 | 0 | no | no | no |
| consent_write_ops | table | yes | yes | 0 | 0 | no | no | no |
| contact_suppression_current | table | yes | yes | 0 | 0 | no | no | no |
| contact_suppression_events | table | yes | yes | 0 | 0 | no | no | no |
| controller_identity_versions | table | yes | yes | 0 | 0 | no | no | no |
| email_assets | table | yes | no | 0 | 0 | no | no | no |
| email_outbox | table | yes | yes | 0 | 0 | no | no | no |
| email_provider_config | table | yes | yes | 0 | 0 | no | no | no |
| email_send_allowlist | table | yes | yes | 0 | 0 | no | no | no |
| email_send_events | table | yes | yes | 0 | 0 | no | no | no |
| email_template_versions | table | yes | no | 0 | 0 | no | no | no |
| email_templates | table | yes | no | 0 | 0 | no | no | no |
| email_version_assets | table | yes | no | 0 | 0 | no | no | no |
| favorites | table | yes | no | 1 | 0 | no | no | yes |
| legal_notice_events | table | yes | yes | 0 | 0 | no | no | no |
| marketing_config | table | yes | yes | 0 | 0 | no | no | no |
| member_admin_metadata | table | yes | no | 0 | 0 | no | no | no |
| member_consent_current | table | yes | yes | 0 | 0 | no | no | no |
| member_consent_events | table | yes | yes | 0 | 0 | no | no | no |
| member_ref | table | yes | no | 0 | 0 | no | no | no |
| member_service_pref_current | table | yes | yes | 0 | 0 | no | no | no |
| member_service_pref_events | table | yes | yes | 0 | 0 | no | no | no |
| members | table | yes | no | 3 | 0 | no | no | yes |
| point_catalog | table | yes | no | 1 | 0 | no | no | no |
| point_events | table | yes | no | 1 | 0 | no | yes | yes |
| readiness_attestations | table | yes | yes | 0 | 0 | no | no | no |
| segments | table | yes | no | 0 | 0 | no | no | no |
| service_pref_defaults | table | yes | yes | 0 | 0 | no | no | no |
| site_content | table | yes | no | 2 | 1 | yes | yes | yes |
| site_content_versions | table | yes | no | 0 | 0 | yes | yes | yes |
| trip_plan_versions | table | yes | no | 2 | 0 | no | no | yes |
| trips | table | yes | no | 4 | 0 | no | no | yes |
| unsubscribe_tokens | table | yes | yes | 0 | 0 | no | no | no |
| venues | table | yes | no | 2 | 1 | yes | yes | yes |
| behavior_events | view | no | no | 0 | 0 | no | no | no |
| comment_reaction_counts | view | no | no | 0 | 0 | yes | no | no |
| comments_public | view | no | no | 0 | 0 | yes | no | no |
| member_public | view | no | no | 0 | 0 | yes | no | no |
