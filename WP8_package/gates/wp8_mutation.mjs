// WP8 mutation suite. Each mutant patches a temp copy of the repo (src SQL then rebuild, or the
// generated migration, an ops/db file, or the Edge source), runs the suite that must catch it,
// and is KILLED only when that suite reports one of the NAMED failures listed for the mutant.
// A mutant whose anchor text is missing (or not unique) is INVALID, which fails the suite, so the
// table cannot silently rot when the sources change. Baselines: every runner first passes on the
// unmutated copy. Local throwaway PostgreSQL only (refuses *supabase.co*). Nothing is sent.
//   node WP8_package/gates/wp8_mutation.mjs [--only M1,M5]
// Env: WP8_PG_PORT (default 55432), WP8_NODE_MODULES (pglite, pg, esbuild). Sentinel WP8_MUTATION_PASS.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WP8_ROOT || resolve(HERE, "..", "..");
if (/supabase\.co/.test(`${process.env.DATABASE_URL || ""}${process.env.SUPABASE_DB_URL || ""}${process.env.PGHOST || ""}`)) { console.log("REFUSED_PRODUCTION"); process.exit(1); }
const PORT = process.env.WP8_PG_PORT || "55432";
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? new Set(process.argv[i + 1].split(",")) : null; })();
const TMP = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "wp8mut-"));
const SRC = "WP8_package/db/WP8_DB_up.src.sql";
const UP = "WP8_package/db/WP8_DB_up.sql";
const EDGE = "CDP3D_package/edge/service-email-dispatch/index.ts";

// ---------------------------------------------------------------- mutant table
const R = (find, repl, count = 1) => ({ find, repl, count });
const MUTANTS = [
  // Spec 11.3 (M1-M22)
  { id: "M1", desc: "sweep candidates without the allowlist predicate", file: SRC, edits: [R("and (exists (select 1 from public.email_send_allowlist a where a.user_id = m.user_id and a.active)", "and (true")],
    run: "behavior", kill: ["FAIL S5 sweep: A,B,E enqueued; J denied by decision"] },
  { id: "M2", desc: "sweep without the auth.users.created_at >= boundary predicate (backfill)", file: SRC, edits: [R("where u.created_at >= v_from", "where true")],
    run: "behavior", kill: ["FAIL S5 auth before boundary (G): no row (no backfill)", "FAIL S5 sweep: A,B,E enqueued"] },
  { id: "M3", desc: "sweep without pc.enabled and without the decision pre-check", file: SRC,
    edits: [R("pc.enabled is true", "pc.enabled is not null"), R("if not coalesce((v_dec->>'allow')::boolean, false) then", "if false then")],
    run: "behavior", kill: ["FAIL S5 sweep: A,B,E enqueued; J denied by decision"] },
  { id: "M4", desc: "no email_outbox_welcome_once_uk (index and its POST guard removed)", file: SRC,
    edits: [R("create unique index if not exists email_outbox_welcome_once_uk on public.email_outbox (user_id)\n  where service_pref_key = 'welcome_service_email'::public.service_pref_key\n    and created_at >= timestamptz '2026-10-01 00:00:00+00';\n", ""),
            R("  if not exists (select 1 from pg_index where indexrelid = to_regclass('public.email_outbox_welcome_once_uk') and indisvalid and indisunique) then\n    raise exception 'WP8_POST_FAIL:welcome_once_index';\n  end if;\n", "")],
    run: "behavior", kill: ["FAIL S5 second welcome for A under another key -> unique_violation"] },
  { id: "M4b", desc: "no email_outbox_welcome_once_uk (index only)", file: SRC,
    edits: [R("create unique index if not exists email_outbox_welcome_once_uk on public.email_outbox (user_id)\n  where service_pref_key = 'welcome_service_email'::public.service_pref_key\n    and created_at >= timestamptz '2026-10-01 00:00:00+00';\n", "")],
    run: "behavior", kill: ["APPLY_FAILED", "WP8_POST_FAIL:welcome_once_index"], all: true },
  { id: "M5", desc: "sweep without the single-flight try-lock", file: SRC, edits: [R("if not pg_try_advisory_xact_lock(hashtextextended('wp8|welcome_enqueue_sweep', 0)) then", "if false then")],
    run: "dbsuite", kill: ["FAIL busy: sweep returns exactly {ok:true, gate:busy}"] },
  { id: "M6", desc: "render without HTML escaping", file: SRC, edits: [R("public._wp8_html_escape(v_name)", "v_name")],
    run: "behavior", kill: ["FAIL S3 render O'Neil: html escaped, text raw"] },
  { id: "M7", desc: "neutral greeting 'Merhaba ,'", file: SRC,
    edits: [R("v_h := replace(t.body_html, 'Merhaba {{first_name}},', 'Merhaba,');\n    v_t := replace(t.body_text, 'Merhaba {{first_name}},', 'Merhaba,');",
              "v_h := replace(t.body_html, 'Merhaba {{first_name}},', 'Merhaba ,');\n    v_t := replace(t.body_text, 'Merhaba {{first_name}},', 'Merhaba ,');")],
    run: "behavior", kill: ["FAIL S3 render NULL -> neutral greeting"] },
  { id: "M8", desc: "lease reclaim without the attempts < max_attempts split", file: SRC,
    edits: [R("     and o.attempts >= o.max_attempts;", "     and false;"), R("     and o.attempts < o.max_attempts;", "     and true;")],
    run: "behavior", kill: ["FAIL S8 expired lease at max attempts -> failed lease_expired_max_attempts"] },
  { id: "M9", desc: "optional budget ignored (v_budget := p_limit)", file: SRC,
    edits: [R("v_budget := least(v_pol.service_daily_cap - v_used_day - v_n,\n                    v_pol.service_monthly_cap - v_used_month - v_n,\n                    v_total - v_n);", "v_budget := p_limit;")],
    run: "behavior", kill: ["FAIL S7 in-flight counts against the daily cap", "FAIL S7 cap reached -> 0 claims"] },
  { id: "M10", desc: "claim ignores service_dispatch_paused", file: SRC, edits: [R("  if v_pol.service_dispatch_paused then return; end if;\n", "")],
    run: "behavior", kill: ["FAIL S7 pause holds optional rows queued"] },
  { id: "M11", desc: "release without the 6-release cap", file: SRC, edits: [R("if v.rate_limit_releases >= 6 then", "if false then")],
    run: "behavior", kill: ["FAIL S8 429 loop is bounded"] },
  { id: "M12", desc: "go-live guard trigger not created", file: SRC,
    edits: [R("create or replace trigger email_provider_config_golive_guard before insert or update or delete on public.email_provider_config\n  for each row execute function public._email_provider_config_golive_guard();\nalter table public.email_provider_config enable trigger email_provider_config_golive_guard;\n", "")],
    run: "behavior", kill: ["APPLY_FAILED", "WP8_POST_FAIL:guard_triggers"], all: true },
  { id: "M12b", desc: "go-live guard trigger without the readiness check", file: SRC,
    edits: [R("  if new.public_go_live and (tg_op = 'INSERT' or not coalesce(old.public_go_live, false)) then\n    if coalesce((public.service_delivery_readiness_check()->>'ready')::boolean, false) is not true then",
              "  if new.public_go_live and (tg_op = 'INSERT' or not coalesce(old.public_go_live, false)) then\n    if false then")],
    run: "behavior", kill: ["FAIL S10 direct go-live refused without readiness"] },
  { id: "M13", desc: "the word 'Drop' in a comment of the generated migration", file: UP, edits: [R("set local statement_timeout = '60s';", "-- Drop nothing here.\nset local statement_timeout = '60s';")],
    run: "static", kill: ["FAIL no 'DROP' text (any case) in production SQL except the optional cleanup file"] },
  { id: "M14", desc: "one hex digit of the embedded html flipped", file: UP, custom: (s) => { const i = s.indexOf("convert_from(decode('\n") + "convert_from(decode('\n".length; if (s.slice(i, i + 4) !== "3c21") throw new Error("anchor"); return s.slice(0, i) + "3d21" + s.slice(i + 4); },
    run: "behavior", kill: ["APPLY_FAILED", "email_service_templates_html_sha_ck"], all: true },
  { id: "M15", desc: "a '--' comment inside a function body", file: SRC, edits: [R("  v_name := public._wp8_greeting_name(p_first_name);", "  -- mutant note\n  v_name := public._wp8_greeting_name(p_first_name);")],
    run: "static", kill: ["FAIL '--' only at column 0 of comment lines"] },
  { id: "M16", desc: "sweep without the service_enabled gate", file: SRC, edits: [R("if cfg.id is null or not cfg.service_enabled then", "if cfg.id is null then")],
    run: "behavior", kill: ["FAIL S4 gate service_disabled (no writes)"] },
  { id: "M17", desc: "mark_result without the late-link", file: SRC, edits: [R("v_linked := public._email_link_orphans_for(p_outbox_id, 'mark_result_late_link');", "v_linked := 0;")],
    run: "behavior", kill: ["FAIL S9 mark ok late-links the orphan -> delivered"] },
  { id: "M18", desc: "sweep without max-age", file: SRC, edits: [R("and m.created_at >= now() - make_interval(hours => pol.welcome_max_age_hours)", "and true")],
    run: "behavior", kill: ["FAIL S5 member older than max-age (H): no row"] },
  { id: "M19", desc: "a JWT-shaped string (built at runtime) in a WP8 file", file: "WP8_package/ops/WP8_OPS_kill_switch_soft.sql", custom: (s) => s + "\n-- " + fakeJwt() + "\n",
    run: "secret", kill: ["SECRET_LEAK[", "GATE_FAILED:secret_scan"], all: true },
  { id: "M20", desc: "Edge: 429 -> mark_result(false) (the v3 file)", file: EDGE, custom: () => readFileSync(join(ROOT, "WP8_package/rollback/edge-service-email-dispatch-v3/index.ts"), "utf8"),
    run: "harness", kill: ["FAIL 429: batch stops, sent=1 released=2 rate_limited"] },
  { id: "M21", desc: "boundary setter uses now() - interval '1 day'", file: SRC, edits: [R("else greatest(coalesce(welcome_enqueue_from, clock_timestamp()), clock_timestamp()) end", "else now() - interval '1 day' end")],
    run: "behavior", kill: ["wp8_boundary_cannot_precede_change"] },
  { id: "M22", desc: "the $wp8_post$ guard block removed from the migration", file: UP, custom: (s) => { const i = s.indexOf("do $wp8_post$"); if (i < 0) throw new Error("anchor"); return s.slice(0, i); },
    run: "static", kill: ["FAIL migration carries the PRE, single-transaction and POST guards"] },
  // Critic amendments 1-20
  { id: "A1a", desc: "policy guard lets NULL -> past boundary through", file: SRC, edits: [R("if new.welcome_enqueue_from < transaction_timestamp() then", "if false then")],
    run: "behavior", kill: ["FAIL S2 boundary NULL -> past refused"] },
  { id: "A1b", desc: "policy DELETE allowed", file: SRC, edits: [R("raise exception 'wp8_policy_delete_refused';", "return old;")],
    run: "behavior", kill: ["FAIL S2 policy delete refused"] },
  { id: "A1c", desc: "service_role keeps write grants on WP8 tables", file: SRC, edits: [R("revoke all on public.%I from public, anon, authenticated, service_role", "revoke all on public.%I from public, anon, authenticated")],
    run: "behavior", kill: ["APPLY_FAILED", "WP8_POST_FAIL:table_acl_service_role"], all: true },
  { id: "A2a", desc: "go-live trigger does not record public_go_live_since", file: SRC,
    edits: [R("set public_go_live_since = greatest(coalesce(public_go_live_since, clock_timestamp()), clock_timestamp())", "set public_go_live_since = public_go_live_since")],
    run: "behavior", kill: ["FAIL S10 direct go-live records public_go_live_since"] },
  { id: "A2b", desc: "sweep ignores public_go_live_since for non-allowlisted users", file: SRC,
    edits: [R("or (cfg.public_go_live and pol.public_go_live_since is not null and u.created_at >= pol.public_go_live_since))", "or (cfg.public_go_live))")],
    run: "behavior", kill: ["FAIL S10 after direct go-live: R (signed up after) enqueued, Q (before) not", "FAIL S10 Q has no welcome", "FAIL S10 after reopen"] },
  { id: "A3a", desc: "claim does not cancel stale wp8 welcomes", file: SRC,
    edits: [R("and o.created_at < now() - make_interval(hours => coalesce(v_pol.welcome_queue_expiry_hours, 72));", "and o.created_at < now() - make_interval(hours => coalesce(v_pol.welcome_queue_expiry_hours, 72)) and false;")],
    run: "behavior", kill: ["FAIL S8 paused 73 h: claim still cancels stale wp8 welcomes first"] },
  { id: "A3b", desc: "hard kill switch does not cancel queued wp8 welcomes", file: "WP8_package/ops/WP8_OPS_kill_switch_hard.sql",
    edits: [R("update public.email_outbox\n   set status = 'canceled', last_error = 'wp8_kill_switch', updated_at = now()\n where idempotency_key like 'wp8:welcome_service_email:v1:%'\n   and (status = 'queued' or (status = 'sending' and lease_expires_at is not null and lease_expires_at < now()));\n", "")],
    run: "ephemeral", kill: ["FAIL kill switch hard -> queued wp8 welcome canceled"] },
  { id: "A4a", desc: "functional rollback leaves service_enabled on", file: "WP8_package/db/WP8_DB_rollback.sql",
    edits: [R("update public.email_provider_config set service_enabled = false, public_go_live = false, updated_at = now() where id = 1;", "update public.email_provider_config set public_go_live = false, updated_at = now() where id = 1;")],
    run: "static", kill: ["FAIL rollback file: no DROP, restores claim/mark, disables the go-live guard, sets service off"] },
  { id: "A4b", desc: "functional rollback contains a DROP", file: "WP8_package/db/WP8_DB_rollback.sql", custom: (s) => s + "\ndrop function if exists public.email_release_claim(uuid, int, boolean);\n",
    run: "static", kill: ["FAIL no 'DROP' text (any case) in production SQL except the optional cleanup file"] },
  { id: "A5", desc: "sweep persists the skipped row of a raced decision (key burn)", file: SRC,
    edits: [R("raise exception using errcode = 'WP8R1', message = 'wp8_sweep_race',\n          detail = coalesce(v_res->>'skip_reason', v_res->>'status', 'unknown');", "n_race := n_race + 1;")],
    run: "behavior", kill: ["FAIL S12 no skipped row persisted for the raced user (key not burned)"] },
  { id: "A6", desc: "sweep limit applied before the decision (head-of-line starvation)", file: SRC, edits: [R("limit v_window", "limit v_lim")],
    run: "behavior", kill: ["FAIL S6 limit 2, 3 denied first, K4 still enqueued"] },
  { id: "A7a", desc: "claim budget ignores the OTP lower bound", file: SRC, edits: [R("v_total := least(100 - v_pol.otp_reserve_daily - v_otp[1] - v_used_day,", "v_total := least(100 - v_pol.otp_reserve_daily - v_used_day,")],
    run: "behavior", kill: ["FAIL S7 OTP headroom: 100 - 30 reserve - 61 OTP - 9 in flight = 0 -> no claim"] },
  { id: "A7b", desc: "daily cap ceiling raised to 90", file: SRC, edits: [R("service_daily_cap between 0 and 50", "service_daily_cap between 0 and 90")],
    run: "behavior", kill: ["FAIL S2 daily cap ceiling 50"] },
  { id: "A7c", desc: "essential claims not bounded by the total ceiling", file: SRC,
    edits: [R("  if v_total < 1 then return; end if;\n", ""), R("order by o.created_at for update skip locked limit v_total", "order by o.created_at for update skip locked limit p_limit")],
    run: "behavior", kill: ["FAIL S7 essential bounded by the same total ceiling"] },
  { id: "A8a", desc: "Edge pacing 250 ms", file: EDGE, edits: [R("const PACE_MS = 1000;", "const PACE_MS = 250;")],
    run: "harness", kill: ["FAIL pacing: >= 1000 ms between sends"] },
  { id: "A8b", desc: "Edge provider fetch without timeout", file: EDGE, edits: [R("        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),\n", "")],
    run: "harness", kill: ["FAIL every provider request has an abort signal (timeout)"] },
  { id: "A8c", desc: "Edge ignores a mark_result RPC error", file: EDGE,
    edits: [R("      if (error) { stopped = \"rpc_error\"; await releaseFrom(i + 1, 60); break; }\n      sent++;", "      sent++;")],
    run: "harness", kill: ["FAIL mark_result RPC error -> batch stops"] },
  { id: "A8d", desc: "Edge token path limit 100", file: EDGE, edits: [R("const TOKEN_MAX_LIMIT = 10;", "const TOKEN_MAX_LIMIT = 100;")],
    run: "harness", kill: ["FAIL token path: limit capped at 10"] },
  { id: "A9a", desc: "permanent 4xx not terminal", file: SRC, edits: [R("v_terminal := v_err ~ '^resend_4[0-9][0-9]$' and v_err not in ('resend_408', 'resend_409', 'resend_429');", "v_terminal := false;")],
    run: "behavior", kill: ["FAIL S8 mark(false): 400/401/403/404/405/422 terminal"] },
  { id: "A9b", desc: "Edge keeps sending after 401/403", file: EDGE, edits: [R("if (status === 401 || status === 403) {", "if (false) {")],
    run: "harness", kill: ["FAIL 401 -> mark_result(false,'resend_401'), rest released not attempted, batch stops"] },
  { id: "A10", desc: "sweep does not pin the text sha", file: SRC, edits: [R("     or tpl.text_sha256 <> '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'\n", "")],
    run: "behavior", kill: ["FAIL S4 gate template_unverified (pinned v3.2 row, text part tampered, stored sha re-matched)"] },
  { id: "A10b", desc: "sweep does not pin the html sha", file: SRC, edits: [R("     or tpl.html_sha256 <> '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'\n", "")],
    run: "behavior", kill: ["FAIL S4 gate template_unverified (pinned v3.2 row, html part tampered, stored sha re-matched)"] },
  { id: "A11", desc: "one revoke removed (reconcile stays executable by anon/authenticated)", file: SRC, edits: [R("revoke all on function public.email_reconcile_orphan_events(int) from public, anon, authenticated;\n", "")],
    run: "behavior", kill: ["APPLY_FAILED", "WP8_POST_FAIL:function_acl_public"], all: true },
  { id: "A15", desc: "ZF probe ends with a notice instead of an exception", file: "WP8_package/db/WP8_DB_zf_probe.sql", edits: [R("raise exception 'WP8_ZF_DONE:%'", "raise notice 'WP8_ZF_DONE:%'")],
    run: "static", kill: ["FAIL ZF probe: one DO block that always ends with RAISE EXCEPTION WP8_ZF_DONE, no COMMIT"] },
  { id: "A16", desc: "open sweep writes no run-ledger row", file: SRC,
    edits: [R("  insert into public.email_wp8_run_ledger(job, gate, candidates, enqueued, idempotent, not_eligible, race, errors, expired, reconciled, reasons)\n  values ('welcome_enqueue_sweep', 'open', n_cand, n_enq, n_idem, n_deny, n_race, n_err, n_exp, n_rec, v_reasons);\n", "")],
    run: "behavior", kill: ["FAIL S4 open sweep writes one counts-only ledger row"] },
  { id: "A18a", desc: "owner setup lets B be allowlisted before A's welcome", file: "WP8_package/db/WP8_DB_owner_setup.sql",
    edits: [R("      raise exception 'wp8_setup_b_requires_a_first';", "      null;")],
    run: "ephemeral", kill: ["FAIL allowlist B before A -> refused (sequential acceptance)"] },
  { id: "A18b", desc: "owner setup allowlists a user who signed up before the boundary", file: "WP8_package/db/WP8_DB_owner_setup.sql",
    edits: [R("if v_auth < pol.welcome_enqueue_from then raise exception 'wp8_setup_qa_user_signed_up_before_boundary'; end if;", "")],
    run: "ephemeral", kill: ["FAIL allowlist refuses a user who signed up before the boundary (no backfill)"] },
  { id: "A20", desc: "migration PRE guard no longer pins service_pref_set", file: SRC,
    edits: [R("  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('public.service_pref_set(public.service_pref_key,boolean,text,uuid)');\n  if v_md5 is null or v_md5 <> 'f171f1ab1a2c183f861f63060a1ad5de' then raise exception 'WP8_PRE_DRIFT:service_pref_set:%', v_md5; end if;\n", "")],
    run: "md5", kill: ["FAIL migration PRE guard pins service_pref_set"] },
  // Fixer round 1: quota windows and ceilings (C*), claim lock, boundary tolerance and re-enable (B*),
  // index predicate (U6), attempt caps and refund (T*), essential re-check (P4), run scoping (R*), CI (W1)
  { id: "C2", desc: "claim budget without the monthly service cap", file: SRC,
    edits: [R("v_budget := least(v_pol.service_daily_cap - v_used_day - v_n,\n                    v_pol.service_monthly_cap - v_used_month - v_n,\n", "v_budget := least(v_pol.service_daily_cap - v_used_day - v_n,\n")],
    run: "behavior", kill: ["FAIL S7q monthly service cap counts sends of the last 31 days"] },
  { id: "C4", desc: "claim total without the monthly (3,000 shared with OTP) term", file: SRC, edits: [R("                   3000 - v_pol.otp_reserve_monthly - v_otp[2] - v_used_month,\n", "")],
    run: "behavior", kill: ["FAIL S7q monthly total keeps the OTP reserve"] },
  { id: "C5", desc: "claim monthly total ignores the 31-day OTP lower bound", file: SRC, edits: [R("3000 - v_pol.otp_reserve_monthly - v_otp[2] - v_used_month", "3000 - v_pol.otp_reserve_monthly - v_used_month")],
    run: "behavior", kill: ["FAIL S7q monthly total keeps the OTP reserve"] },
  { id: "C6", desc: "claim monthly total ignores otp_reserve_monthly", file: SRC, edits: [R("3000 - v_pol.otp_reserve_monthly - v_otp[2] - v_used_month", "3000 - v_otp[2] - v_used_month")],
    run: "behavior", kill: ["FAIL S7q monthly total keeps the OTP reserve"] },
  { id: "C9", desc: "daily usage window 1 hour instead of 24 hours", file: SRC,
    edits: [R("into v_used_day from public.email_outbox o where o.sent_at > now() - interval '24 hours';", "into v_used_day from public.email_outbox o where o.sent_at > now() - interval '1 hour';")],
    run: "behavior", kill: ["FAIL S7q daily service cap counts every class sent in 24 h"] },
  { id: "C10", desc: "monthly usage window 1 day instead of 31 days", file: SRC,
    edits: [R("into v_used_month from public.email_outbox o where o.sent_at > now() - interval '31 days';", "into v_used_month from public.email_outbox o where o.sent_at > now() - interval '1 day';")],
    run: "behavior", kill: ["FAIL S7q monthly service cap counts sends of the last 31 days"] },
  { id: "C16", desc: "monthly provider quota 30,000 instead of 3,000", file: SRC, edits: [R("3000 - v_pol.otp_reserve_monthly", "30000 - v_pol.otp_reserve_monthly")],
    run: "behavior", kill: ["FAIL S7q monthly total keeps the OTP reserve"] },
  { id: "C17", desc: "daily usage counts only optional_service sends", file: SRC,
    edits: [R("into v_used_day from public.email_outbox o where o.sent_at > now() - interval '24 hours';", "into v_used_day from public.email_outbox o where o.sent_at > now() - interval '24 hours' and o.message_class = 'optional_service';")],
    run: "behavior", kill: ["FAIL S7q daily service cap counts every class sent in 24 h"] },
  { id: "C19", desc: "optional budget ignores what the essential loop already took (v_total - v_n -> v_total)", file: SRC, edits: [R("                    v_total - v_n);", "                    v_total);")],
    run: "behavior", kill: ["FAIL S7q one total ceiling for both classes"] },
  { id: "C21", desc: "claim without the serialization lock", file: SRC, edits: [R("  perform pg_advisory_xact_lock(hashtextextended('wp8|email_claim_batch', 0));\n", "")],
    run: "dbsuite", kill: ["FAIL claim serialization: a claim while another claim's transaction is open waits", "FAIL claim serialization with the OTP headroom binding"] },
  { id: "B5", desc: "boundary guard tolerates 1 hour before the changing transaction", file: SRC,
    edits: [R("if new.welcome_enqueue_from < transaction_timestamp() then", "if new.welcome_enqueue_from < transaction_timestamp() - interval '1 hour' then")],
    run: "behavior", kill: ["FAIL S2 boundary NULL -> 1 second before the changing transaction refused"] },
  { id: "B6", desc: "boundary guard tolerates 3 days before the changing transaction", file: SRC,
    edits: [R("if new.welcome_enqueue_from < transaction_timestamp() then", "if new.welcome_enqueue_from < transaction_timestamp() - interval '3 days' then")],
    run: "behavior", kill: ["FAIL S2 boundary NULL -> 1 second before the changing transaction refused"] },
  { id: "B5g", desc: "go-live-since guard tolerates 1 hour before the changing transaction", file: SRC,
    edits: [R("if new.public_go_live_since < transaction_timestamp() then", "if new.public_go_live_since < transaction_timestamp() - interval '1 hour' then")],
    run: "behavior", kill: ["FAIL S2 go-live since NULL -> 1 second before the changing transaction refused"] },
  { id: "B7", desc: "setter keeps the old boundary on disable -> re-enable (backfill of the off window)", file: SRC,
    edits: [R("welcome_enqueue_from = case when pol.welcome_auto_enqueue_enabled then welcome_enqueue_from\n                                       else greatest(coalesce(welcome_enqueue_from, clock_timestamp()), clock_timestamp()) end,",
              "welcome_enqueue_from = coalesce(welcome_enqueue_from, clock_timestamp()),")],
    run: "behavior", kill: ["FAIL S4 setter disable -> re-enable moves the boundary forward", "FAIL S5 signed up while automation was off"] },
  { id: "U6", desc: "one-welcome index narrowed to queued rows", file: SRC,
    edits: [R("    and created_at >= timestamptz '2026-10-01 00:00:00+00';\ncreate index if not exists email_outbox_sent_at_idx", "    and created_at >= timestamptz '2026-10-01 00:00:00+00' and status = 'queued';\ncreate index if not exists email_outbox_sent_at_idx")],
    run: "behavior", kill: ["FAIL S8 second welcome for A after its welcome was sent -> unique_violation", "FAIL S8 second welcome row for A refused whatever"] },
  { id: "T1b", desc: "optional claim loop without attempts < max_attempts", file: SRC,
    edits: [R("o.attempts < o.max_attempts\n       and o.message_class = 'optional_service'", "true\n       and o.message_class = 'optional_service'")],
    run: "behavior", kill: ["FAIL S7a optional row queued at max_attempts is never claimed"] },
  { id: "T2", desc: "essential claim loop without attempts < max_attempts", file: SRC,
    edits: [R("o.attempts < o.max_attempts\n       and o.message_class = 'essential_transactional'", "true\n       and o.message_class = 'essential_transactional'")],
    run: "behavior", kill: ["FAIL S7a essential row queued at max_attempts is never claimed"] },
  { id: "T8", desc: "429 release resets attempts to 0 instead of refunding one", file: SRC, edits: [R("attempts = greatest(attempts - 1, 0), rate_limit_releases", "attempts = 0, rate_limit_releases")],
    run: "behavior", kill: ["FAIL S7a 429 release refunds exactly the consumed attempt"] },
  { id: "P4", desc: "essential claim loop without the decision re-check", file: SRC,
    edits: [R("       and o.message_class = 'essential_transactional'\n     order by o.created_at for update skip locked limit v_total\n  loop\n    v_dec := public._email_send_decision(r.user_id, r.message_class, r.service_pref_key);\n    if not (v_dec->>'allow')::boolean then",
              "       and o.message_class = 'essential_transactional'\n     order by o.created_at for update skip locked limit v_total\n  loop\n    v_dec := public._email_send_decision(r.user_id, r.message_class, r.service_pref_key);\n    if false then")],
    run: "behavior", kill: ["FAIL S7a essential re-check at claim: de-allowlisted", "FAIL S7a essential re-check at claim: class disabled"] },
  { id: "R1", desc: "owner setup refuses a label used in ANY earlier run (re-run after a hard kill impossible)", file: "WP8_package/db/WP8_DB_owner_setup.sql",
    edits: [R("    if exists (select 1 from public.email_send_allowlist where user_id = v_user) then raise exception 'wp8_setup_qa_already_allowlisted'; end if;\n    if exists (select 1 from public.email_send_allowlist where note = v_note and (active or added_at >= pol.welcome_enqueue_from)) then",
              "    if exists (select 1 from public.email_send_allowlist where note = v_note or user_id = v_user) then raise exception 'wp8_setup_qa_already_allowlisted'; end if;\n    if false then")],
    run: "ephemeral", kill: ["FAIL re-run: allowlist A and C for NEW accounts"] },
  { id: "R1b", desc: "owner setup lets one label be used twice in the same run", file: "WP8_package/db/WP8_DB_owner_setup.sql",
    edits: [R("where note = v_note and (active or added_at >= pol.welcome_enqueue_from)) then", "where false) then")],
    run: "ephemeral", kill: ["FAIL re-run: label A cannot be used twice in one run"] },
  { id: "R2", desc: "owner setup B gate satisfied by an earlier run's delivered A", file: "WP8_package/db/WP8_DB_owner_setup.sql",
    edits: [R("          where a.note = 'wp8-qa-A' and a.active and a.added_at >= pol.welcome_enqueue_from\n            and o.idempotency_key = 'wp8:welcome_service_email:v1:' || a.user_id::text\n            and o.created_at >= pol.welcome_enqueue_from and o.status in ('sent', 'delivered')) then",
              "          where a.note = 'wp8-qa-A' and o.idempotency_key = 'wp8:welcome_service_email:v1:' || a.user_id::text and o.status in ('sent', 'delivered')) then")],
    run: "ephemeral", kill: ["FAIL re-run: allowlist B refused until the NEW A's welcome is sent"] },
  { id: "R3", desc: "evidence QA rows not scoped to the current run", file: "WP8_package/db/WP8_DB_evidence.sql",
    edits: [R("   where a.note in ('wp8-qa-A', 'wp8-qa-B', 'wp8-qa-C') and a.added_at >= (select welcome_enqueue_from from pol)\n", "   where a.note in ('wp8-qa-A', 'wp8-qa-B', 'wp8-qa-C')\n")],
    run: "ephemeral", kill: ["FAIL re-run evidence: stop=false"] },
  { id: "R4", desc: "evidence backfill judged against the current boundary for every run", file: "WP8_package/db/WP8_DB_evidence.sql",
    edits: [R("where u.created_at < coalesce(o.boundary_at_enqueue, (select welcome_enqueue_from from pol))) then 'backfill' end", "where u.created_at < (select welcome_enqueue_from from pol)) then 'backfill' end")],
    run: "ephemeral", kill: ["FAIL re-run evidence: stop=false"] },
  { id: "R5", desc: "evidence backfill blind to earlier runs", file: "WP8_package/db/WP8_DB_evidence.sql",
    edits: [R("where u.created_at < coalesce(o.boundary_at_enqueue, (select welcome_enqueue_from from pol))) then 'backfill' end", "where o.this_run and u.created_at < (select welcome_enqueue_from from pol)) then 'backfill' end")],
    run: "ephemeral", kill: ["FAIL re-run evidence still flags backfill"] },
  { id: "W1", desc: "runner.temp in job-level env (invalid workflow file: no gate would run)", file: ".github/workflows/wp8-gates.yml",
    edits: [R("    env:\n      WP8_PG_PORT: \"55432\"\n", "    env:\n      WP8_NODE_MODULES: ${{ runner.temp }}/wp8deps/node_modules\n      WP8_PG_DIR: ${{ runner.temp }}/wp8pg\n      WP8_PG_PORT: \"55432\"\n")],
    run: "static", kill: ["FAIL workflows: every ${{ }} context allowed where it is used"] },
  { id: "K1", desc: "dispatch kick without the Vault URL validation", file: "WP8_package/db/WP8_DB_scheduler_optin.sql",
    edits: [R("\n     or v_url !~ '^https://[a-z0-9]+\\.supabase\\.co/functions/v1/service-email-dispatch$' then", " then")],
    run: "sched", kill: ["FAIL kick: foreign URL refused"] },
  // Fixer round 2: quota usage counted by sent_at whatever the row became (C29/C30); evidence without
  // pg_net (E1) and the kick STOP rule with pg_net (E2)
  { id: "C29", desc: "daily usage counts only rows still in status 'sent' (delivered/bounced sends ignored)", file: SRC,
    edits: [R("into v_used_day from public.email_outbox o where o.sent_at > now() - interval '24 hours';", "into v_used_day from public.email_outbox o where o.sent_at > now() - interval '24 hours' and o.status = 'sent';")],
    run: "behavior", kill: ["FAIL S7q daily service cap counts delivered and bounced sends", "FAIL S7q daily OTP reserve counts delivered and bounced sends"], all: true },
  { id: "C30", desc: "monthly usage counts only rows still in status 'sent' (delivered/bounced sends ignored)", file: SRC,
    edits: [R("into v_used_month from public.email_outbox o where o.sent_at > now() - interval '31 days';", "into v_used_month from public.email_outbox o where o.sent_at > now() - interval '31 days' and o.status = 'sent';")],
    run: "behavior", kill: ["FAIL S7q monthly service cap counts delivered and bounced sends", "FAIL S7q monthly OTP reserve counts delivered and bounced sends"], all: true },
  { id: "E1", desc: "evidence kick rule reads the JSON null of a missing pg_net (round-1 guard)", file: "WP8_package/db/WP8_DB_evidence.sql",
    edits: [R("select case when jsonb_typeof(v->'kick_http_this_run_24h') = 'object' then v->'kick_http_this_run_24h' else '{}'::jsonb end as codes from glob", "select v->'kick_http_this_run_24h' as codes from glob")],
    run: "ephemeral", kill: ["FAIL fallback path (no pg_net, no pg_cron): evidence on the inert DB returns", "FAIL fallback path: STOP rules still evaluated without pg_net"], all: true },
  { id: "E2", desc: "evidence kick rule blind to non-200 responses", file: "WP8_package/db/WP8_DB_evidence.sql",
    edits: [R("jsonb_object_keys((select codes from kick)) k where k <> '200')", "jsonb_object_keys((select codes from kick)) k where false)")],
    run: "ephemeral", kill: ["FAIL with pg_net: kick HTTP 500 or a failed request"] },
];

function fakeJwt() {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b({ iss: "supabase", role: "service_role", ref: randomBytes(10).toString("hex") })}.${randomBytes(32).toString("base64url")}`;
}

// ---------------------------------------------------------------- helpers
const sh = (cmd, args, env = {}, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { rc: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const psql = (db, args) => sh("psql", ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, ...args], { PGOPTIONS: "-c client_min_messages=warning" });
function copyRoot(dst) {
  for (const d of ["WP8_package", "CDP3D_package", "WSE_DEFAULT_package", "CDP3C_package"]) {
    cpSync(join(ROOT, d), join(dst, d), { recursive: true, filter: (p) => !p.includes("node_modules") });
  }
  mkdirSync(join(dst, ".github/workflows"), { recursive: true });
  const wf = join(ROOT, ".github/workflows/wp8-gates.yml");
  if (existsSync(wf)) copyFileSync(wf, join(dst, ".github/workflows/wp8-gates.yml"));
}
const TPL = `wp8mut_tpl_${process.pid}`;
const libTmp = (tag) => { const d = join(TMP, "lib_" + tag); mkdirSync(d, { recursive: true }); return d; };
function behavior(root, tag) {
  const db = `wp8mut_${tag.toLowerCase()}_${process.pid}`;
  psql("postgres", ["-c", `drop database if exists ${db} with (force)`, "-c", `create database ${db} template ${TPL}`]);
  try {
    const a = psql(db, ["-1", "-f", join(root, UP)]);
    if (a.rc !== 0) return "APPLY_FAILED\n" + a.out;
    return sh("bash", ["-c", `source "${root}/WP8_package/gates/wp8_lib.sh" && wp8_behavior "${db}"`], { WP8_ROOT: root, WP8_TMP: libTmp(tag) }).out;
  } finally { psql("postgres", ["-c", `drop database if exists ${db} with (force)`]); }
}
const RUNNERS = {
  behavior: (root, tag) => behavior(root, tag),
  static: (root) => sh(process.execPath, [join(root, "WP8_package/gates/wp8_static_check.mjs")], { WP8_ROOT: root }).out,
  md5: (root) => sh("python3", ["-I", join(root, "WP8_package/gates/wp8_md5_parity.py")], { WP8_ROOT: root }).out,
  harness: (root) => sh(process.execPath, [join(root, "WP8_package/gates/wp8_edge_harness.mjs")], { WP8_ROOT: root }).out,
  secret: (root) => sh("bash", [join(root, "WP8_package/gates/wp8_secret_scan.sh")], { WP8_ROOT: root }).out,
  dbsuite: (root) => sh("bash", [join(root, "WP8_package/gates/wp8_db_suite.sh")], { WP8_ROOT: root }).out,
  ephemeral: (root) => sh("bash", [join(root, "WP8_package/gates/wp8_ephemeral.sh")], { WP8_ROOT: root }).out,
  sched: (root) => sh("bash", [join(root, "WP8_package/gates/wp8_scheduler_stub_test.sh")], { WP8_ROOT: root }).out,
};
const behaviorExpected = (readFileSync(join(ROOT, "WP8_package/gates/wp8_lib.sh"), "utf8").match(/WP8_BEHAVIOR_EXPECTED=(\d+)/) || [])[1];
const BASELINE_OK = {
  behavior: `BEHAVIOR_COUNT pass=${behaviorExpected} fail=0`, static: "WP8_STATIC_PASS", md5: "WP8_MD5_PARITY_PASS", harness: "WP8_EDGE_HARNESS_PASS",
  secret: "SECRET_SCAN_CLEAN", dbsuite: "WP8_DB_SUITE_PASS", ephemeral: "WP8_EPHEMERAL_PASS", sched: "WP8_SCHED_PASS",
};

// ---------------------------------------------------------------- main
const list = MUTANTS.filter((m) => !ONLY || ONLY.has(m.id));
let killed = 0, survived = 0, invalid = 0, basefail = 0;
const base = join(TMP, "base");
copyRoot(base);
try {
  const t = sh("bash", ["-c", `source "${base}/WP8_package/gates/wp8_lib.sh" && wp8_newdb ${TPL} && wp8_load_chain ${TPL} norm && wp8_fixture ${TPL}`], { WP8_ROOT: base, WP8_TMP: libTmp("tpl") });
  if (t.rc !== 0) { console.log("FATAL template database: " + t.out.slice(0, 800)); process.exit(1); }
  for (const r of [...new Set(list.map((m) => m.run))]) {
    const out = RUNNERS[r](base, "base");
    const good = out.includes(BASELINE_OK[r]) && !/^FAIL /m.test(out);
    console.log(`${good ? "BASELINE_OK" : "BASELINE_FAIL"} ${r}`);
    if (!good) { basefail++; console.log(out.split("\n").filter((l) => /^(FAIL|ERROR|APPLY_FAILED)/.test(l)).slice(0, 10).join("\n")); }
  }
  for (const m of list) {
    const root = join(TMP, "m_" + m.id);
    rmSync(root, { recursive: true, force: true });
    cpSync(base, root, { recursive: true });
    const f = join(root, m.file);
    let s = readFileSync(f, "utf8"); const before = s; let bad = null;
    try {
      if (m.custom) s = m.custom(s);
      for (const e of m.edits || []) {
        const n = s.split(e.find).length - 1;
        if (n !== e.count) { bad = `anchor count ${n} != ${e.count}: ${JSON.stringify(e.find.slice(0, 80))}`; break; }
        s = s.split(e.find).join(e.repl);
      }
    } catch (err) { bad = "custom edit failed: " + err.message; }
    if (!bad && s === before) bad = "mutation changed nothing";
    if (!bad) {
      writeFileSync(f, s);
      if (m.file === SRC) {
        const b = sh(process.execPath, [join(root, "WP8_package/tools/wp8_build.mjs"), "--root", root]);
        if (b.rc !== 0) bad = "rebuild failed: " + b.out.trim().slice(0, 200);
      }
    }
    if (bad) { invalid++; console.log(`INVALID ${m.id} ${m.desc} :: ${bad}`); rmSync(root, { recursive: true, force: true }); continue; }
    const out = RUNNERS[m.run](root, m.id);
    const hits = m.kill.filter((k) => out.includes(k));
    const isKilled = m.all ? hits.length === m.kill.length : hits.length > 0;
    if (isKilled) { killed++; console.log(`KILLED ${m.id} ${m.desc} :: ${m.run} -> ${JSON.stringify(hits[0])}`); }
    else { survived++; console.log(`SURVIVED ${m.id} ${m.desc} :: ${m.run}`); console.log(out.split("\n").filter((l) => /^(FAIL|ERROR|APPLY_FAILED|psql)/.test(l)).slice(0, 8).join("\n")); }
    rmSync(root, { recursive: true, force: true });
  }
} finally {
  psql("postgres", ["-c", `drop database if exists ${TPL} with (force)`]);
  rmSync(TMP, { recursive: true, force: true });
}
const EXPECTED = ONLY ? list.length : 83;
console.log(`\nMUTATION RESULT killed=${killed} survived=${survived} invalid=${invalid} baseline_fail=${basefail} expected=${EXPECTED}`);
const passOk = killed === EXPECTED && survived === 0 && invalid === 0 && basefail === 0 && list.length === EXPECTED;
console.log(passOk ? "WP8_MUTATION_PASS" : "WP8_MUTATION_FAIL");
process.exit(passOk ? 0 : 1);
