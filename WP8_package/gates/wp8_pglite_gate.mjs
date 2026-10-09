// WP8 PGlite gate (@electric-sql/pglite 0.3.16, PostgreSQL 17, WASM, single connection).
// PG17 compatibility of the whole WP8 package: CI chain (normalized and raw CDP-3D), PRE/POST
// asserts, double apply, inert proof, the acceptance evidence without pg_net/pg_cron, the shared
// behaviour suite, ZF probe, functional rollback, cleanup and re-apply, and a D2 fallback
// rehearsal (real owner setup, A delivered) with a positive case for every evidence STOP rule that
// can fire without pg_net. No network, nothing is sent. Sentinel WP8_PGLITE_PASS.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WP8_ROOT || resolve(HERE, "..", "..");
const req = createRequire(join(process.env.WP8_NODE_MODULES || join(HERE, "node_modules"), "_wp8_resolve.js"));
const { PGlite } = req("@electric-sql/pglite");
const { pgcrypto } = req("@electric-sql/pglite/contrib/pgcrypto");
const EXPECTED = 29;
const BEHAVIOR_EXPECTED = 188;

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (info !== undefined ? " :: " + String(typeof info === "string" ? info : JSON.stringify(info)).slice(0, 600) : "")); } };
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const py = (args) => { const r = spawnSync("python3", ["-I", ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error("python failed: " + r.stderr); return r.stdout; };
const txn = (sql) => "begin;\n" + sql + "\ncommit;";

async function chain(mode) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  const cdp3d = mode === "norm" ? py([join(ROOT, "WP8_package/tools/wp8_normalize.py"), join(ROOT, "CDP3D_package/CDP3D_up.sql")]) : rd("CDP3D_package/CDP3D_up.sql");
  for (const sql of [rd("CDP3D_package/gates/cdp3d_prereq_stub.sql"), cdp3d, rd("WSE_DEFAULT_package/gates/wse_prereq_extra.sql"),
    rd("WSE_DEFAULT_package/WSE_up.sql"), rd("WP8_package/gates/wp8_ci_baseline.sql"),
    py([join(ROOT, "WP8_package/gates/wp8_cdp3c_fns.py"), ROOT]), rd("WP8_package/gates/wp8_fixture_pre.sql")]) {
    await db.exec(txn(sql));
  }
  return db;
}
const one = async (db, sql) => (await db.query(sql)).rows[0];
const json = async (db, file) => Object.values(await one(db, rd(file)))[0];
async function apply(db) { await db.exec(txn(rd("WP8_package/db/WP8_DB_up.sql"))); return true; }
async function behavior(db) {
  await db.exec("begin");
  try {
    await db.exec(rd("WP8_package/gates/wp8_behavior.sql"));
    const rows = (await db.query("select name, pass, info from wp8_t order by seq")).rows;
    return rows;
  } finally { await db.exec("rollback"); }
}

try {
  const db = await chain("norm");
  const ver = (await one(db, "select current_setting('server_version_num')::int v")).v;
  ok("PGlite runs PostgreSQL 17", ver >= 170000 && ver < 180000, ver);
  const pre = await json(db, "WP8_package/db/WP8_DB_pre_assert.sql");
  ok("PRE assert on the fixture -> wp8_pre true", pre.wp8_pre === true, pre.failed);
  ok("apply #1 (normalized) succeeds", await apply(db));
  ok("apply #2 is a no-op", await apply(db));
  const post = await json(db, "WP8_package/db/WP8_DB_post_assert.sql");
  ok("POST assert -> wp8_post true, n=43", post.wp8_post === true && post.n === 43, post.failed);
  let ev; try { ev = await json(db, "WP8_package/db/WP8_DB_evidence.sql"); } catch (e) { ev = { error: e.message }; }
  ok("evidence without pg_net and pg_cron (PG17, D2 fallback) returns stop=false with the kick fields null", ev.stop === false && Array.isArray(ev.stop_reasons) && ev.stop_reasons.length === 0
     && ev.global.pg_net_present === false && ev.global.pg_cron_present === false && ev.global.kick_http_this_run_24h === null && ev.global.cron_jobs === null, ev);
  const s = await one(db, "select public.welcome_enqueue_sweep() s");
  ok("inert: sweep -> auto_disabled", JSON.stringify(s.s) === JSON.stringify({ ok: true, gate: "auto_disabled", expired: 0, reconciled: 0 }), s.s);
  ok("inert: claim -> 0 rows", (await one(db, "select count(*)::int n from public.email_claim_batch(10)")).n === 0);
  ok("inert: outbox 3 / events 6 / allowlist 0 / ledger 0", JSON.stringify(await one(db, "select (select count(*)::int from public.email_outbox) o, (select count(*)::int from public.email_send_events) e, (select count(*)::int from public.email_send_allowlist) a, (select count(*)::int from public.email_wp8_run_ledger) l")) === JSON.stringify({ o: 3, e: 6, a: 0, l: 0 }));
  const b = await behavior(db);
  const bf = b.filter((r) => !r.pass);
  ok(`behaviour suite on PG17: ${BEHAVIOR_EXPECTED}/${BEHAVIOR_EXPECTED}`, b.length === BEHAVIOR_EXPECTED && bf.length === 0, bf.map((r) => r.name + " :: " + r.info).slice(0, 10));
  ok("behaviour suite rolled back", (await one(db, "select count(*)::int n from public.email_outbox")).n === 3);
  let zf = "";
  try { await db.exec(rd("WP8_package/db/WP8_DB_zf_probe.sql")); } catch (e) { zf = e.message; }
  ok("ZF probe raises WP8_ZF_DONE with pass=true", zf.includes("WP8_ZF_DONE") && zf.includes('"pass": true'), zf);
  ok("ZF probe left the policy inert", (await one(db, "select (not welcome_auto_enqueue_enabled and welcome_enqueue_from is null and service_daily_cap = 0) ok from public.email_service_policy")).ok === true
     && (await one(db, "select not service_enabled ok from public.email_provider_config")).ok === true);
  await db.exec(rd("WP8_package/db/WP8_DB_rollback.sql").replace(/^/, "begin;\n") + "\ncommit;");
  const rb = await json(db, "WP8_package/db/WP8_DB_post_rollback_assert.sql");
  ok("functional rollback -> post-rollback assert true", rb.wp8_rolled_back === true, rb.failed);
  ok("rollback restored the live CDP-3D claim/mark md5", JSON.stringify(await one(db, "select (select md5(prosrc) from pg_proc where oid = 'public.email_claim_batch(int)'::regprocedure) c, (select md5(prosrc) from pg_proc where oid = 'public.email_mark_result(uuid,boolean,text,text)'::regprocedure) m"))
     === JSON.stringify({ c: "08fc00397182c86929bcb9afa6a6a995", m: "5d34c6af5d4934e23f6508a4a56a562c" }));
  await db.exec(txn(rd("WP8_package/db/WP8_DB_rollback_cleanup_optional.sql")));
  ok("optional cleanup removed WP8 functions, kept data", (await one(db, "select to_regprocedure('public.welcome_enqueue_sweep(int)') is null and to_regclass('public.email_service_policy') is not null ok")).ok === true);
  ok("re-apply after rollback + cleanup", await apply(db));
  const post2 = await json(db, "WP8_package/db/WP8_DB_post_assert.sql");
  ok("POST assert after re-apply -> true", post2.wp8_post === true, post2.failed);
  await db.close();

  const raw = await chain("raw");
  ok("apply #1 (raw repo chain) succeeds", await apply(raw));
  ok("apply #2 (raw) no-op", await apply(raw));
  const postr = await json(raw, "WP8_package/db/WP8_DB_post_assert.sql");
  ok("POST assert (raw chain) -> true", postr.wp8_post === true, postr.failed);
  const br = await behavior(raw);
  const brf = br.filter((r) => !r.pass);
  ok(`behaviour suite on PG17 (raw chain): ${BEHAVIOR_EXPECTED}/${BEHAVIOR_EXPECTED}`, br.length === BEHAVIOR_EXPECTED && brf.length === 0, brf.map((r) => r.name + " :: " + r.info).slice(0, 10));
  const pfx = await json(raw, "WP8_package/db/WP8_DB_pre_assert.sql");
  ok("PRE assert refuses a database where WP8 is already applied", pfx.wp8_pre === false && pfx.failed.includes("wp8_tables_absent"), pfx.failed);
  await raw.close();

  // D2 fallback rehearsal on PG17 (no pg_net, no pg_cron, as in production today), one autocommit
  // transaction per step: the real owner setup template (enable, allowlist A and C), A enqueued,
  // claimed and delivered. Then every evidence STOP rule that can fire without pg_net gets a
  // positive case, each inside a transaction that is rolled back.
  const fb = await chain("norm");
  await apply(fb);
  const setup = (step, label = "NONE", user = "00000000-0000-0000-0000-000000000000") => txn(rd("WP8_package/db/WP8_DB_owner_setup.sql")
    .replaceAll("@@ARM_YES@@", "YES").replaceAll("@@STEP@@", step).replaceAll("@@SUPER_ADMIN_UUID@@", "0000000a-0000-4000-8000-00000000a001")
    .replaceAll("@@QA_LABEL@@", label).replaceAll("@@QA_USER_UUID@@", user));
  const qaUser = (x) => `insert into auth.users(id, email, created_at) values (md5('wp8-qa-${x}')::uuid, 'qa-${x.toLowerCase()}@example.test', clock_timestamp());
    insert into public.members(user_id, email) values (md5('wp8-qa-${x}')::uuid, 'qa-${x.toLowerCase()}@example.test');`;
  const uid = async (x) => (await one(fb, `select md5('wp8-qa-${x}')::uuid::text u`)).u;
  await fb.exec(setup("enable"));
  await fb.exec(txn(qaUser("A") + qaUser("C") + "\nupdate public.members set first_name = 'O''Neil' where user_id = md5('wp8-qa-A')::uuid;"));
  await fb.exec(txn("select set_config('request.jwt.claims', json_build_object('sub', md5('wp8-qa-C')::uuid, 'role', 'authenticated')::text, true);\n"
    + "select public.service_pref_set('welcome_service_email', false, 'qa-c-off', md5('qa-c-off')::uuid);"));
  await fb.exec(setup("allowlist", "A", await uid("A")));
  await fb.exec(setup("allowlist", "C", await uid("C")));
  const st = await one(fb, "select (select count(*)::int from public.email_send_allowlist where active and note in ('wp8-qa-A', 'wp8-qa-C')) a, (select service_enabled and not essential_enabled and not public_go_live from public.email_provider_config where id = 1) f, (select welcome_auto_enqueue_enabled and welcome_enqueue_from is not null from public.email_service_policy where id = 1) p");
  await fb.exec(txn("update public.members set created_at = now() - interval '11 minutes' where user_id in (md5('wp8-qa-A')::uuid, md5('wp8-qa-C')::uuid);"));
  const sw = (await one(fb, "select public.welcome_enqueue_sweep() s")).s;
  const cl = (await one(fb, "select count(*)::int n from public.email_claim_batch(10)")).n;
  await fb.exec(txn("select public.email_mark_result((select id from public.email_outbox where user_id = md5('wp8-qa-A')::uuid), true, 'prov-qa-fa', null);\n"
    + "select public.email_ingest_provider_event('svix-qa-fa-2', 'email.delivered', 'prov-qa-fa', 'qa-a@example.test', now(), null);"));
  const evq = rd("WP8_package/db/WP8_DB_evidence.sql");
  const ev0 = Object.values(await one(fb, evq))[0];
  const qa0 = ev0.qa || {};
  ok("D2 rehearsal on PG17 (real owner setup: enable, allowlist A and C): A enqueued once, claimed and delivered; evidence stop=false, escaped greeting, C 0 rows, kick fields null",
     st.a === 2 && st.f === true && st.p === true && sw.enqueued === 1 && sw.candidates === 1 && cl === 1 && ev0.stop === false && ev0.stop_reasons.length === 0
     && qa0["wp8-qa-A"]?.welcome_rows === 1 && JSON.stringify(qa0["wp8-qa-A"]?.statuses) === '{"delivered":1}' && qa0["wp8-qa-A"]?.html_greeting_escaped_oneil === true
     && qa0["wp8-qa-C"]?.welcome_rows === 0 && qa0["wp8-qa-C"]?.pref_enabled === false && ev0.global.this_run.wp8_rows === 1
     && ev0.global.kick_http_this_run_24h === null && ev0.global.pg_net_present === false, { st, sw, cl, ev0 });
  const evRb = async (sql) => { await fb.exec("begin;\n" + sql); try { return Object.values(await one(fb, evq))[0]; } finally { await fb.exec("rollback"); } };
  const ins = (key, user, status, extraCols = "", extraVals = "") => `insert into public.email_outbox(idempotency_key, intent_fingerprint, message_class, service_pref_key, subject, user_id, recipient_hmac, status${extraCols})
    values (${key}, 'x', 'optional_service', 'welcome_service_email', 's', ${user}, repeat('a', 64), '${status}'${extraVals});`;
  const reasons = (e) => JSON.stringify(e.stop_reasons);
  const eQc = await evRb(ins("'wp8:welcome_service_email:v1:' || md5('wp8-qa-C')::uuid", "md5('wp8-qa-C')::uuid", "sent", ", sent_at, provider_message_id", ", now(), 'prov-qa-fc'"));
  ok("evidence STOP on PG17: a welcome row for this run's QA-C user (pref OFF) -> stop=true with exactly qa_c_pref_off_but_welcomed",
     eQc.stop === true && reasons(eQc) === '["qa_c_pref_off_but_welcomed"]' && eQc.qa["wp8-qa-C"].welcome_rows === 1, eQc.stop_reasons);
  const eSk = await evRb(ins("'wp8:welcome_service_email:v1:' || md5('wp8-qa-Z')::uuid", "md5('wp8-qa-Z')::uuid", "skipped", ", skip_reason", ", 'recipient_missing_email'"));
  const eSp = await evRb(ins("'wp8:welcome_service_email:v1:' || md5('wp8-qa-Z')::uuid", "md5('wp8-qa-Z')::uuid", "skipped", ", skip_reason", ", 'service_pref_disabled'"));
  ok("evidence STOP on PG17: a skipped wp8 row of this run (recipient_missing_email) -> stop=true with exactly sweep_skipped_row; a service_pref_disabled skip -> no STOP",
     eSk.stop === true && reasons(eSk) === '["sweep_skipped_row"]' && eSp.stop === false && reasons(eSp) === "[]", [eSk.stop_reasons, eSp.stop_reasons]);
  const eDu = await evRb("drop index public.email_outbox_welcome_once_uk;\n" + ins("'ci-dup-A'", "md5('wp8-qa-A')::uuid", "canceled"));
  ok("evidence STOP on PG17: two welcome rows for one user (one-welcome index removed inside the rolled-back probe) -> stop=true with exactly duplicate_welcome",
     eDu.stop === true && reasons(eDu) === '["duplicate_welcome"]', eDu.stop_reasons);
  const eTri = await evRb(ins("'wp8:welcome_service_email:v1:' || md5('wp8-qa-Z')::uuid", "md5('wp8-qa-Z')::uuid", "failed")
    + ins("'wp8:welcome_service_email:v1:0000000f-0000-4000-8000-0000000000f3'", "'0000000f-0000-4000-8000-0000000000f3'::uuid", "canceled")
    + "insert into public.email_wp8_run_ledger(job, gate, errors) values ('welcome_enqueue_sweep', 'open', 1);");
  ok("evidence STOP on PG17: failed row, sweep error and backfill -> stop=true with exactly those 3 reasons",
     eTri.stop === true && JSON.stringify([...eTri.stop_reasons].sort()) === '["backfill","sweep_errors","wp8_failed_row"]', eTri.stop_reasons);
  const ev1 = Object.values(await one(fb, evq))[0];
  ok("evidence probes rolled back (stop=false, one wp8 row, the one-welcome index still in place)", ev1.stop === false && ev1.global.wp8_rows_total === 1
     && (await one(fb, "select to_regclass('public.email_outbox_welcome_once_uk') is not null ok")).ok === true, ev1.stop_reasons);
  await fb.close();
} catch (e) {
  fail++; console.log("FATAL " + e.message + "\n" + (e.stack || ""));
}
console.log(`\nPGLITE RESULT pass=${pass} fail=${fail} expected=${EXPECTED}`);
if (fail === 0 && pass === EXPECTED) console.log("WP8_PGLITE_PASS"); else console.log("WP8_PGLITE_FAIL");
process.exit(fail === 0 && pass === EXPECTED ? 0 : 1);
