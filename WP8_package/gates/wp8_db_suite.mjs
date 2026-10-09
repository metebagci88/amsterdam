// WP8 real-concurrency suite (node-postgres, several connections) on a throwaway PostgreSQL.
// DBURL must point at a local database prepared by wp8_db_suite.sh (CI chain + fixture + WP8).
// Sentinel WP8_DB_SUITE_PASS only when pass == EXPECTED and fail == 0.
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(process.env.WP8_NODE_MODULES || join(HERE, "node_modules"), "_wp8_resolve.js"));
const pg = req("pg");
const { Client, Pool } = pg;
const DBURL = process.env.DBURL;
if (!DBURL || /supabase\.co/.test(DBURL)) { console.log("REFUSED"); process.exit(2); }
const EXPECTED = 28;
let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (info !== undefined ? " :: " + JSON.stringify(info) : "")); } };
const pool = new Pool({ connectionString: DBURL, max: 12 });
const Q = (sql, p) => pool.query(sql, p);
const one = async (sql, p) => (await Q(sql, p)).rows[0];
const client = async () => { const c = new Client({ connectionString: DBURL }); await c.connect(); return c; };
const uid = (l) => `md5('wp8-db-${l}')::uuid`;
async function mkuser(l, { allow = true } = {}) {
  await Q(`insert into auth.users(id, email, created_at) values (${uid(l)}, 'db-${l.toLowerCase()}@example.test', clock_timestamp())`);
  await Q(`insert into public.members(user_id, email) values (${uid(l)}, 'db-${l.toLowerCase()}@example.test')`);
  if (allow) await Q(`insert into public.email_send_allowlist(user_id, note, active) values (${uid(l)}, 'wp8-db-${l}', true)`);
}
const sweep = async (c) => (await (c || pool).query("select public.welcome_enqueue_sweep() s")).rows[0].s;

try {
  await Q(`update public.email_service_policy set service_daily_cap = 50, service_monthly_cap = 1500, welcome_delay_minutes = 0 where id = 1`);
  await Q(`select public.admin_w_welcome_automation_set('0000000a-0000-4000-8000-00000000a001', true, 'db suite', 'db-suite-1')`);
  await Q(`update public.email_provider_config set service_enabled = true where id = 1`);

  // 1) 6 parallel sweepers x 5 runs over 30 eligible users
  for (let i = 1; i <= 30; i++) await mkuser("P" + i);
  const results = await Promise.all(Array.from({ length: 6 }, async () => {
    const c = await client(); const out = [];
    try { for (let r = 0; r < 5; r++) out.push(await sweep(c)); } finally { await c.end(); }
    return out;
  }));
  const flat = results.flat();
  const open = flat.filter((s) => s.gate === "open"), busy = flat.filter((s) => s.gate === "busy");
  const sum = (k) => open.reduce((a, s) => a + (s[k] || 0), 0);
  const rows = await one(`select count(*)::int n, count(distinct user_id)::int u from public.email_outbox where idempotency_key like 'wp8:%' and user_id in (select ${uid("P")} union all select md5('wp8-db-P' || g)::uuid from generate_series(1, 30) g)`);
  ok("parallel sweeps: exactly 30 rows for 30 distinct users", rows.n === 30 && rows.u === 30, rows);
  ok("parallel sweeps: every run is open or busy", open.length + busy.length === 30, { open: open.length, busy: busy.length });
  ok("parallel sweeps: sum(enqueued)=30, idempotent=0, race=0, errors=0", sum("enqueued") === 30 && sum("idempotent") === 0 && sum("race") === 0 && sum("errors") === 0,
     { enq: sum("enqueued"), idem: sum("idempotent"), race: sum("race"), err: sum("errors") });
  ok("parallel sweeps: every open run is recorded in the ledger", (await one(`select count(*)::int n from public.email_wp8_run_ledger`)).n === open.length);

  // 2) busy: the sweep key is held by another session -> busy with zero writes
  await mkuser("BUSY");
  const h = await client(); await h.query("begin"); await h.query(`select pg_advisory_xact_lock(hashtextextended('wp8|welcome_enqueue_sweep', 0))`);
  const ledgerBefore = (await one(`select count(*)::int n from public.email_wp8_run_ledger`)).n;
  const sb = await sweep();
  ok("busy: sweep returns exactly {ok:true, gate:busy}", JSON.stringify(sb) === JSON.stringify({ ok: true, gate: "busy" }), sb);
  ok("busy: no ledger row and no outbox row written", (await one(`select count(*)::int n from public.email_wp8_run_ledger`)).n === ledgerBefore
     && (await one(`select count(*)::int n from public.email_outbox where user_id = ${uid("BUSY")}`)).n === 0);
  await h.query("rollback"); await h.end();
  const sb2 = await sweep();
  ok("busy released: next sweep enqueues the user", sb2.gate === "open" && sb2.enqueued === 1, sb2);

  // 3) lock-free race: two sessions, same user, different keys -> one row + unique_violation
  await mkuser("RACE");
  const c1 = await client(), c2 = await client();
  await c1.query("begin"); await c2.query("begin");
  await c1.query(`select public.email_enqueue(${uid("RACE")}, 'optional_service', 'welcome_service_email', 's', '<p>a</p>', 'a', null, 'race-key-1', 'r')`);
  const p2 = c2.query(`select public.email_enqueue(${uid("RACE")}, 'optional_service', 'welcome_service_email', 's', '<p>b</p>', 'b', null, 'race-key-2', 'r')`).then(() => "ok", (e) => e.code);
  await new Promise((r) => setTimeout(r, 300));
  await c1.query("commit");
  const code2 = await p2; await c2.query("rollback").catch(() => {});
  await c1.end(); await c2.end();
  ok("lock-free race: second session gets unique_violation (23505)", code2 === "23505", code2);
  ok("lock-free race: exactly one welcome row", (await one(`select count(*)::int n from public.email_outbox where user_id = ${uid("RACE")}`)).n === 1);

  // 4) pref OFF racing the sweep (same uid|welcome_service_email advisory lock as service_pref_set)
  await mkuser("FLIP");
  const f = await client(); await f.query("begin");
  await f.query(`select set_config('request.jwt.claims', json_build_object('sub', ${uid("FLIP")}, 'role', 'authenticated')::text, true)`);
  await f.query(`select public.service_pref_set('welcome_service_email', false, 'db-flip', md5('db-flip')::uuid)`);
  const sp = sweep();
  await new Promise((r) => setTimeout(r, 300));
  await f.query("commit"); await f.end();
  const sf = await sp;
  ok("pref flip during the sweep: decision sees OFF after the lock, nothing written",
     sf.gate === "open" && sf.enqueued === 0 && JSON.stringify(sf.reasons) === JSON.stringify({ service_pref_disabled: 1 })
     && (await one(`select count(*)::int n from public.email_outbox where user_id = ${uid("FLIP")}`)).n === 0, sf);

  // 5) kill switch waits for a running sweep (config/policy read FOR SHARE)
  const k1 = await client(); await k1.query("begin"); await k1.query("select public.welcome_enqueue_sweep()");
  const k2 = await client(); await k2.query("set lock_timeout = '400ms'");
  const kc = await k2.query(`update public.email_service_policy set service_dispatch_paused = true where id = 1`).then(() => "ok", (e) => e.code);
  await k1.query("commit"); await k1.end(); await k2.end();
  ok("kill switch update waits while a sweep holds the policy row (lock_timeout 55P03)", kc === "55P03", kc);

  // 6) two parallel claims under a daily cap of N never exceed N
  await Q(`update public.email_outbox set status = 'canceled' where status = 'queued'`);
  for (let i = 1; i <= 10; i++) await mkuser("CAP" + i);
  const sc = await sweep();
  const usedDay = (await one(`select count(*)::int n from public.email_outbox where sent_at > now() - interval '24 hours' or status = 'sending'`)).n;
  await Q(`update public.email_service_policy set service_daily_cap = $1, service_monthly_cap = 1500 where id = 1`, [usedDay + 3]);
  const [a, b] = await Promise.all([Q("select count(*)::int n from public.email_claim_batch(10)"), Q("select count(*)::int n from public.email_claim_batch(10)")]);
  ok("parallel claims under daily cap N=3: total claimed exactly 3", sc.enqueued === 10 && a.rows[0].n + b.rows[0].n === 3, { enq: sc.enqueued, a: a.rows[0].n, b: b.rows[0].n });
  ok("rows over the cap stay queued with attempts 0", (await one(`select count(*)::int n from public.email_outbox where idempotency_key like 'wp8:%' and status = 'queued' and attempts = 0`)).n === 7);
  await Q(`update public.email_service_policy set service_daily_cap = 50 where id = 1`);
  await Q(`update public.email_outbox set status = 'canceled' where status in ('queued', 'sending')`);

  // 6b) claim serialization, deterministic: session 1 claims inside an OPEN transaction; a second
  // claim must wait for it (lock_timeout -> 55P03) and, after the commit, claim only what is left.
  // (Promise.all on a pool above usually runs the two claims one after the other.)
  const usedNow = async () => (await one(`select count(*)::int n from public.email_outbox where sent_at > now() - interval '24 hours' or status = 'sending'`)).n;
  for (let i = 1; i <= 6; i++) await mkuser("HO" + i);
  const sho = await sweep();
  await Q(`update public.email_service_policy set service_daily_cap = $1 where id = 1`, [(await usedNow()) + 3]);
  const s1 = await client(), s2 = await client();
  await s1.query("begin");
  const n1 = (await s1.query("select count(*)::int n from public.email_claim_batch(10)")).rows[0].n;
  await s2.query("set lock_timeout = '700ms'");
  const e2 = await s2.query("select count(*)::int n from public.email_claim_batch(10)").then((r) => r.rows[0].n, (e) => e.code);
  await s1.query("commit");
  await s2.query("reset lock_timeout");
  const n2 = (await s2.query("select count(*)::int n from public.email_claim_batch(10)")).rows[0].n;
  await s1.end(); await s2.end();
  const sending1 = (await one(`select count(*)::int n from public.email_outbox where status = 'sending'`)).n;
  ok("claim serialization: a claim while another claim's transaction is open waits (55P03), then claims only the remaining headroom (cap N=3)",
     sho.enqueued === 6 && n1 === 3 && e2 === "55P03" && n2 === 0 && sending1 === 3, { enq: sho.enqueued, n1, e2, n2, sending1 });
  await Q(`update public.email_service_policy set service_daily_cap = 50 where id = 1`);
  await Q(`update public.email_outbox set status = 'canceled' where status in ('queued', 'sending')`);

  // 6c) the same with the Resend-shared OTP headroom as the binding limit (service cap 50): no
  // lock_timeout; the second claim blocks until the first commits, then claims 0 (reserve kept).
  for (let i = 1; i <= 6; i++) await mkuser("HF" + i);
  const shf = await sweep();
  const otp = (await one(`select public._wp8_auth_otp_load() v`)).v;
  const reserve = 100 - otp[0] - (await usedNow()) - 3;
  await Q(`update public.email_service_policy set otp_reserve_daily = $1 where id = 1`, [reserve]);
  const f1 = await client(), f2 = await client();
  await f1.query("begin");
  const m1 = (await f1.query("select count(*)::int n from public.email_claim_batch(10)")).rows[0].n;
  let done2 = false;
  const p2c = f2.query("select count(*)::int n from public.email_claim_batch(10)").then((r) => { done2 = true; return r.rows[0].n; }, (e) => { done2 = true; return e.code; });
  await new Promise((r) => setTimeout(r, 600));
  const blocked = !done2;
  await f1.query("commit");
  const m2 = await p2c;
  await f1.end(); await f2.end();
  const sending2 = (await one(`select count(*)::int n from public.email_outbox where status = 'sending'`)).n;
  ok("claim serialization with the OTP headroom binding: the second claim blocks until the first commits, then claims 0 (OTP reserve kept)",
     shf.enqueued === 6 && reserve >= 20 && m1 === 3 && blocked && m2 === 0 && sending2 === 3, { enq: shf.enqueued, reserve, m1, blocked, m2, sending2 });
  await Q(`update public.email_service_policy set otp_reserve_daily = 30 where id = 1`);
  await Q(`update public.email_outbox set status = 'canceled' where status in ('queued', 'sending')`);

  // 7) lease loop: repeated dispatcher deaths end failed at max attempts (Gap A)
  await mkuser("LEASE");
  await sweep();
  const lid = (await one(`select id from public.email_outbox where user_id = ${uid("LEASE")}`)).id;
  let claims = 0;
  for (let i = 0; i < 12; i++) {
    await Q(`update public.email_outbox set next_attempt_at = now() where id = $1 and status = 'queued'`, [lid]);
    const n = (await one(`select count(*)::int n from public.email_claim_batch(10) c where c.outbox_id = $1`, [lid])).n;
    claims += n;
    await Q(`update public.email_outbox set lease_expires_at = now() - interval '1 second' where id = $1 and status = 'sending'`, [lid]);
  }
  await Q("select count(*) from public.email_claim_batch(1)");
  const lr = await one(`select status::text s, attempts, last_error from public.email_outbox where id = $1`, [lid]);
  ok("lease loop: 5 claims, then failed lease_expired_max_attempts (no infinite retry)", claims === 5 && lr.s === "failed" && lr.attempts === 5 && lr.last_error === "lease_expired_max_attempts", { claims, lr });

  // 8) 429 loop: 6 free releases, the 7th consumes an attempt; bounded
  await mkuser("R429"); await sweep();
  const rid = (await one(`select id from public.email_outbox where user_id = ${uid("R429")}`)).id;
  let cycles = 0;
  for (; cycles < 30; cycles++) {
    const st = (await one(`select status::text s from public.email_outbox where id = $1`, [rid])).s;
    if (st !== "queued") break;
    await Q(`update public.email_outbox set next_attempt_at = now() where id = $1`, [rid]);
    const got = (await one(`select count(*)::int n from public.email_claim_batch(10) c where c.outbox_id = $1`, [rid])).n;
    if (got) await Q(`select public.email_release_claim($1, 60, false)`, [rid]);
  }
  const r4 = await one(`select status::text s, attempts, rate_limit_releases rl from public.email_outbox where id = $1`, [rid]);
  ok("429 loop: ends failed after 6 releases and 5 attempts (11 claims)", r4.s === "failed" && r4.rl === 6 && r4.attempts === 5 && cycles === 11, { r4, cycles });

  // 9) retry horizon
  await mkuser("HZ"); await sweep();
  await Q(`update public.email_outbox set attempts = 1, first_attempt_at = now() - interval '21 hours' where user_id = ${uid("HZ")}`);
  await Q("select count(*) from public.email_claim_batch(1)");
  ok("retry horizon: first attempt 21 h ago -> failed retry_window_exceeded", (await one(`select status::text s, last_error e from public.email_outbox where user_id = ${uid("HZ")}`)).e === "retry_window_exceeded");

  // 10) privileges on a real connection
  const pr = await client();
  const tryAs = async (role, sql) => { try { await pr.query(`set role ${role}`); await pr.query(sql); return "ok"; } catch (e) { return e.code; } finally { await pr.query("reset role").catch(() => {}); } };
  ok("service_role direct UPDATE on the policy -> 42501", (await tryAs("service_role", `update public.email_service_policy set welcome_enqueue_from = timestamptz '2026-10-01' where id = 1`)) === "42501");
  ok("service_role DELETE/INSERT on the policy -> 42501", (await tryAs("service_role", `delete from public.email_service_policy`)) === "42501" && (await tryAs("service_role", `insert into public.email_service_policy(id) values (1)`)) === "42501");
  ok("service_role can run the sweep (Edge fallback path)", (await tryAs("service_role", `select public.welcome_enqueue_sweep()`)) === "ok");
  ok("service_role can claim/mark/release (Edge path)", (await tryAs("service_role", `select count(*) from public.email_claim_batch(1)`)) === "ok");
  ok("anon cannot sweep/claim/release -> 42501", (await tryAs("anon", `select public.welcome_enqueue_sweep()`)) === "42501" && (await tryAs("anon", `select count(*) from public.email_claim_batch(1)`)) === "42501"
     && (await tryAs("anon", `select public.email_release_claim(gen_random_uuid(), 60, false)`)) === "42501");
  ok("authenticated cannot read the policy or the ledger -> 42501", (await tryAs("authenticated", `select * from public.email_service_policy`)) === "42501" && (await tryAs("authenticated", `select * from public.email_wp8_run_ledger`)) === "42501");
  const acl = await one(`select bool_and(not has_function_privilege('anon', to_regprocedure(signature), 'execute') and not has_function_privilege('authenticated', to_regprocedure(signature), 'execute')) ok, count(*)::int n from public.email_wp8_manifest where object_kind = 'function'`);
  ok("manifest ACL holds under Supabase default privileges (14 functions)", acl.ok === true && acl.n === 14, acl);
  await pr.end();

  // 11) boundary guard on a real connection (direct SQL backfill attempt)
  const bq = await Q(`update public.email_service_policy set welcome_enqueue_from = timestamptz '2026-10-01' where id = 1`).then(() => "ok", (e) => e.message);
  ok("direct boundary backdating by the owner role refused", /wp8_boundary_cannot_move_backwards|wp8_boundary_cannot_precede_change/.test(bq), bq);
  const dq = await Q(`delete from public.email_service_policy`).then(() => "ok", (e) => e.message);
  ok("policy DELETE refused even for the owner role", /wp8_policy_delete_refused/.test(dq), dq);
  ok("no wp8 row was ever skipped by a sweep", (await one(`select count(*)::int n from public.email_outbox where idempotency_key like 'wp8:%' and status = 'skipped'`)).n === 0);
} catch (e) {
  fail++; console.log("FATAL " + e.message + "\n" + (e.stack || ""));
}
await pool.end().catch(() => {});
console.log(`\nDB SUITE RESULT pass=${pass} fail=${fail} expected=${EXPECTED}`);
if (fail === 0 && pass === EXPECTED) console.log("WP8_DB_SUITE_PASS"); else console.log("WP8_DB_SUITE_FAIL");
process.exit(fail === 0 && pass === EXPECTED ? 0 : 1);
