// =====================================================================
// SEC-MEDIA · STAGE 2 · gates/s2_pglite_gate.mjs
// Gerçek Postgres (PGlite/WASM, PG17) üzerinde S2 paketinin yerel kapısı.
// Production'a / ağa DOKUNMAZ; ücretli kaynak yok; secret okumaz.
//
//   PGLITE_DIR=<@electric-sql/pglite kurulu dizin> node gates/s2_pglite_gate.mjs
//   (PGLITE_DIR yoksa normal paket çözümlemesi denenir.)
//
// Kapsam: statik içerik kontrolleri; storage modeli + prod baseline (policy md5 prod ile
// birebir); baseline'da açığın modellendiği; S2_up sonrası anon/authenticated
// INSERT/UPSERT=42501(RLS), UPDATE/DELETE=0 satır, SELECT izinli, service_role yazar;
// zero-footprint testinin hem açığı yakaladığı (FAIL) hem kapanışı kanıtladığı (PASS) ve
// iz bırakmadığı; S2_up iki kez (idempotent); S2_down_INSECURE silahsızken reddi, armed
// iken baseline'ın birebir geri gelmesi; yeniden up; drift/atomiklik negatifleri;
// satır 20/21 ("diğer bucket/policy'lerde değişiklik yok"): S2 döngüsü boyunca PRE == POST,
// bucket öznitelikleri == production literali, başka tabloda policy / bucket özniteliği
// değişikliği assert'lerde FAIL olarak yakalanır.
// Sentinel: S2_LOCAL_PGLITE_GATE_PASS
// =====================================================================
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const rd = (p) => readFileSync(path.join(PKG, p), "utf8");

async function loadPGlite() {
  const dir = process.env.PGLITE_DIR;
  if (dir) {
    const req = createRequire(path.join(path.resolve(dir), "package.json"));
    const m = await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href);
    return m.PGlite ?? m.default?.PGlite;
  }
  const m = await import("@electric-sql/pglite");
  return m.PGlite ?? m.default?.PGlite;
}

const UP = rd("S2_up.sql");
const DOWN = rd("S2_down_INSECURE.sql");
const MODEL = rd("gates/s2_fixture_storage_model.sql");
const BASE = rd("gates/s2_fixture_baseline.sql");
const PRE_ASSERT = rd("gates/s2_pre_assert.sql");
const PROD_ASSERT = rd("gates/s2_prod_assert.sql");
const ZF = rd("gates/s2_zero_footprint_test.sql");

const ARM_DOWN = "set local sec_media.s2_insecure_rollback = 'REOPEN_ANON_WRITE';\n";
const ARM_FIX = "set local sec_media.s2_fixture = 'EPHEMERAL_ONLY';\n";
// production'da 2026-10-07 read-only ölçülen storage.objects policy matrisi md5'i (4 policy)
const PROD_BASELINE_MD5 = "677c0f6b0f4fd37bb8b4fb7959a495fb";
// production'da 2026-10-07 read-only ölçülen satır 20/21 beklenenleri (= PRE, P1). Satır 21 yerel
// fixture'da birebir üretilir; satır 20 (25 uygulama policy'si) yerelde üretilemez -> "env satırı":
// yerelde değeri PRE olarak kaydedilir ve her POST'ta PRE ile birebir karşılaştırılır.
const PROD_OTHER_POLICIES = "25:45f0c3ac7e466783e9e3fa3702183b28";
const PROD_BUCKET_ATTRS = "3:e112c7b7523616c45bd38bf2c8c45064";
const ENV_ROW = 20;

let pass = 0, fail = 0;
const log = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; log.push("PASS " + name); }
  else { fail++; log.push("FAIL " + name + (detail ? " :: " + detail : "")); }
};

// ---------------------------------------------------------------- statik
function stripComments(sql) { return sql.replace(/--[^\n]*/g, ""); }
function stripLiterals(sql) {
  return stripComments(sql)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}
{
  const up = stripComments(UP);
  ok("static: S2_up dış begin/commit/rollback yok", !/^\s*(begin|commit|rollback|start\s+transaction|end)\s*;/im.test(up));
  const drops = [...up.matchAll(/drop\s+policy\s+if\s+exists\s+"([^"]+)"\s+on\s+storage\.objects\s*;/gi)].map((m) => m[1]);
  ok("static: S2_up tam 3 DROP POLICY IF EXISTS (insert/update/delete)",
     drops.length === 3 && ["media anon insert", "media anon update", "media anon delete"].every((n) => drops.includes(n)), drops.join(","));
  ok("static: S2_up başka drop policy yok", (up.match(/drop\s+policy/gi) || []).length === 3);
  ok("static: S2_up read policy'ye DROP yok", !/drop\s+policy[^;]*media anon read/i.test(up));
  ok("static: S2_up create/alter policy yok", !/\b(create|alter)\s+policy\b/i.test(up));
  ok("static: S2_up bucket/email-assets yazımı yok", !/(insert\s+into|update|delete\s+from)\s+storage\.buckets/i.test(up));
  ok("static: S2_up grant/revoke/alter table/truncate/set role/RLS disable yok",
     !/\b(grant|revoke|truncate)\b|\balter\s+table\b|\bset\s+(local\s+)?role\b|disable\s+row\s+level\s+security/i.test(up));
  ok("static: S2_up lock_timeout set local", /set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i.test(up));

  const dn = stripComments(DOWN);
  ok("static: DOWN arming guard var", /current_setting\('sec_media\.s2_insecure_rollback',\s*true\)/.test(dn) && /S2_DOWN_INSECURE_NOT_ARMED/.test(dn));
  ok("static: DOWN arming guard ilk ifade", dn.trim().toLowerCase().startsWith("do $s2_arm$"));
  const creates = [...dn.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+storage\.objects\s+as\s+permissive\s+for\s+(\w+)\s+to\s+public/gi)].map((m) => m[1] + ":" + m[2].toLowerCase());
  ok("static: DOWN tam 3 create policy (to public)", creates.length === 3 &&
     ["media anon insert:insert", "media anon update:update", "media anon delete:delete"].every((c) => creates.includes(c)), creates.join(","));
  ok("static: DOWN read policy'ye dokunmaz", !/(drop|create|alter)\s+policy[^;]*media anon read/i.test(dn));
  ok("static: DOWN bucket yazımı yok", !/(insert\s+into|update|delete\s+from)\s+storage\.buckets/i.test(dn));
  ok("static: DOWN dış begin/commit yok", !/^\s*(begin|commit|rollback|start\s+transaction|end)\s*;/im.test(dn));

  for (const [n, s] of [["s2_pre_assert", PRE_ASSERT], ["s2_prod_assert", PROD_ASSERT]]) {
    const t = stripLiterals(s);
    ok(`static: ${n} salt-okunur (yalnız WITH/SELECT)`,
       /^\s*with\b/i.test(t) && !/\b(insert|update|delete|drop|create|alter|grant|revoke|truncate|copy|call|perform|set_config|do)\b|\bset\s/i.test(t) && (t.match(/;/g) || []).length === 1);
  }
  const rowSql = (s, n) => (stripComments(s).match(new RegExp(`select ${n}, '[^']*',([\\s\\S]*?), true\\n`)) || [])[1];
  for (const [n, s] of [["s2_pre_assert", PRE_ASSERT], ["s2_prod_assert", PROD_ASSERT]]) {
    ok(`static: ${n} satır 20 beklenen = production PRE literali (tek)`, s.split(`'${PROD_OTHER_POLICIES}'`).length === 2);
    ok(`static: ${n} satır 21 beklenen = production PRE literali (tek)`, s.split(`'${PROD_BUCKET_ATTRS}'`).length === 2);
  }
  ok("static: satır 20 SQL'i pre/prod assert'te birebir aynı", !!rowSql(PRE_ASSERT, 20) && rowSql(PRE_ASSERT, 20) === rowSql(PROD_ASSERT, 20));
  ok("static: satır 21 SQL'i pre/prod assert'te birebir aynı", !!rowSql(PRE_ASSERT, 21) && rowSql(PRE_ASSERT, 21) === rowSql(PROD_ASSERT, 21));
  ok("static: satır 20 kapsamı storage.objects hariç tüm pg_policies; sıralama açık (order by 1 değil)",
     /from pg_policies\s+where not \(schemaname = 'storage' and tablename = 'objects'\)/.test(rowSql(PRE_ASSERT, 20) || "") &&
     /order by schemaname, tablename, policyname/.test(rowSql(PRE_ASSERT, 20) || ""));
  ok("static: satır 21 file_size_limit/allowed_mime_types/type/versioning_status içerir",
     ["file_size_limit", "allowed_mime_types", "type::text", "versioning_status", "public::text"].every((c) => (rowSql(PRE_ASSERT, 21) || "").includes(c)));
  const zf = stripComments(ZF);
  ok("static: ZF tek DO bloğu + REPORT raise ile biter", /^\s*do \$s2zf\$/i.test(zf) && /raise exception using message = 'REPORT:' \|\| rep, errcode = 'P0001';\s*end\s*\$s2zf\$;\s*$/i.test(zf));
  ok("static: ZF commit/bucket yazımı yok", !/\bcommit\b/i.test(zf) && !/(insert\s+into|update|delete\s+from)\s+storage\.buckets/i.test(zf));
  const zfNames = [...zf.matchAll(/values\s*\(\s*(?:v_seed,\s*)?'media',\s*([^,)]+)/gi)].map((m) => m[1].trim());
  ok("static: ZF yalnız zz-sec-media-s2-zf/ adları yazar", zfNames.length >= 2 && zfNames.every((x) => x === "v_seed_name" || x.startsWith("'zz-sec-media-s2-zf/'")), zfNames.join(" | "));
}

// ---------------------------------------------------------------- DB
const PGlite = await loadPGlite();
const db = await new PGlite();
const version = (await db.query("select version() v")).rows[0].v.split(" on ")[0];
log.push("-- engine: " + version);

const q = async (sql, params) => (await db.query(sql, params)).rows;
async function errOf(fn) { try { await fn(); return null; } catch (e) { return { code: e.code, message: String(e.message || e) }; } }
const MATRIX_MD5 = `select coalesce(md5(string_agg(policyname||'|'||cmd||'|'||roles::text||'|'||permissive||'|'||coalesce(qual,'<null>')||'|'||coalesce(with_check,'<null>'), E'\\n' order by policyname)),'<none>') m
                     from pg_policies where schemaname='storage' and tablename='objects'`;
const SNAP = `select policyname, cmd, roles::text roles, permissive, qual, with_check from pg_policies where schemaname='storage' and tablename='objects' order by policyname`;
const UNTOUCHED = `select md5(
   coalesce((select string_agg(id||':'||coalesce(public::text,'')||':'||name||':'||coalesce(file_size_limit::text,'')||':'||coalesce(allowed_mime_types::text,''), ',' order by id) from storage.buckets),'') || '#' ||
   coalesce((select string_agg(tgname||':'||tgenabled::text||':'||pg_get_triggerdef(oid), ',' order by tgname) from pg_trigger where tgrelid='storage.objects'::regclass and not tgisinternal),'') || '#' ||
   coalesce((select string_agg(grantee||':'||privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants where table_schema='storage' and table_name='objects'),'') || '#' ||
   (select relrowsecurity::text||relforcerowsecurity::text||relowner::regrole::text from pg_class where oid='storage.objects'::regclass) || '#' ||
   coalesce((select string_agg(rolname||':'||rolbypassrls::text, ',' order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role')),'')
 ) m`;
const md5 = async () => (await q(MATRIX_MD5))[0].m;
const snap = async () => JSON.stringify(await q(SNAP));
const untouched = async () => (await q(UNTOUCHED))[0].m;
const policyNames = async () => (await q(SNAP)).map((r) => r.policyname).join(",");
const POST_MD5 = (await q(`select md5('media anon read|SELECT|{public}|PERMISSIVE|(bucket_id = ''media''::text)|<null>') m`))[0].m;

async function assertRows(name, sql, sentinel) {
  const r = await q(sql);
  const overall = r.find((x) => x.check_name === "OVERALL");
  const bad = r.filter((x) => x.result === "FAIL").map((x) => `${x.ord}:${x.check_name}=${x.actual}`);
  return { overall: overall && overall.result, bad, rows: r, pass: overall && overall.result === sentinel };
}
const rowOf = (a, n) => a.rows.find((x) => Number(x.ord) === n) || {};
const badExceptEnv = (a) => a.bad.filter((b) => !b.startsWith(`${ENV_ROW}:`));
// env satırı: beklenen = production literali, actual = yerel PRE değeri (tek fark budur)
const envRowIs = (a, pre) => rowOf(a, ENV_ROW).expected === PROD_OTHER_POLICIES && rowOf(a, ENV_ROW).actual === pre;
// "production'da PASS"ın yerel karşılığı: env satırı dışında FAIL yok + env satırı == PRE + satır 21 PASS
const passModEnv = (a, pre) => badExceptEnv(a).length === 0 && envRowIs(a, pre) &&
  rowOf(a, 21).result === "PASS" && /^1 FAIL \//.test(rowOf(a, 99).actual || "");
let PRE20;

// rolle tek ifade; her zaman ROLLBACK (iz bırakmaz)
async function asRole(role, sql, { guc = false } = {}) {
  await db.exec("begin");
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })]);
    await db.query(`select set_config('storage.allow_delete_query', $1, true)`, [guc ? "true" : "false"]);
    await db.exec(`set local role ${role}`);
    const r = await db.query(sql);
    return { ok: true, affected: r.affectedRows ?? 0, rows: r.rows };
  } catch (e) {
    return { ok: false, code: e.code, message: String(e.message || e) };
  } finally {
    await db.exec("rollback");
  }
}
const RLS_RE = /new row violates row-level security policy/;
const PD_RE = /Direct deletion from storage tables is not allowed/;
let SEED, SEED_DRAFT;

async function behavior(label, open) {
  for (const role of ["anon", "authenticated"]) {
    let r = await asRole(role, `insert into storage.objects(bucket_id,name) values ('media','venues/${role}-new.jpg')`);
    if (open) ok(`${label}: ${role} INSERT media İZİNLİ (baseline açık)`, r.ok, r.message);
    else ok(`${label}: ${role} INSERT media 42501 RLS`, !r.ok && r.code === "42501" && RLS_RE.test(r.message), `${r.code} ${r.message}`);
    r = await asRole(role, `insert into storage.objects(id,bucket_id,name) values ('${SEED}','media','venues/seed-1.jpg') on conflict (id) do update set metadata='{"x":"upsert"}'`);
    if (open) ok(`${label}: ${role} UPSERT media İZİNLİ`, r.ok && r.affected === 1, r.message);
    else ok(`${label}: ${role} UPSERT media 42501 RLS`, !r.ok && r.code === "42501" && RLS_RE.test(r.message), `${r.code} ${r.message}`);
    r = await asRole(role, `update storage.objects set metadata='{"x":"tampered"}' where id='${SEED}'`);
    ok(`${label}: ${role} UPDATE rows=${open ? 1 : 0}`, r.ok && r.affected === (open ? 1 : 0), JSON.stringify(r));
    r = await asRole(role, `update storage.objects set name='venues/moved.jpg' where id='${SEED}'`);
    ok(`${label}: ${role} MOVE(rename) rows=${open ? 1 : 0}`, r.ok && r.affected === (open ? 1 : 0), JSON.stringify(r));
    r = await asRole(role, `delete from storage.objects where id='${SEED}'`, { guc: true });
    ok(`${label}: ${role} DELETE(guc=true) rows=${open ? 1 : 0}`, r.ok && r.affected === (open ? 1 : 0), JSON.stringify(r));
    r = await asRole(role, `delete from storage.objects where id='${SEED}'`);
    ok(`${label}: ${role} DELETE(guc yok) protect_delete 42501 (RLS değil)`, !r.ok && r.code === "42501" && PD_RE.test(r.message), `${r.code} ${r.message}`);
    r = await asRole(role, `select id from storage.objects where id='${SEED}'`);
    ok(`${label}: ${role} SELECT media görünür`, r.ok && r.rows.length === 1, JSON.stringify(r));
    r = await asRole(role, `select id from storage.objects where id='${SEED_DRAFT}'`);
    ok(`${label}: ${role} SELECT email-assets-draft görünmez`, r.ok && r.rows.length === 0, JSON.stringify(r));
    r = await asRole(role, `insert into storage.objects(bucket_id,name) values ('email-assets-public','x/${role}.png')`);
    ok(`${label}: ${role} INSERT email-assets-public 42501 (başka bucket açılmadı)`, !r.ok && r.code === "42501", `${r.code} ${r.message}`);
  }
  let r = await asRole("service_role", `insert into storage.objects(bucket_id,name) values ('media','venues/svc-new.jpg')`);
  ok(`${label}: service_role INSERT media`, r.ok && r.affected === 1, r.message);
  r = await asRole("service_role", `update storage.objects set metadata='{"x":"svc"}' where id='${SEED}'`);
  ok(`${label}: service_role UPDATE rows=1`, r.ok && r.affected === 1, JSON.stringify(r));
  r = await asRole("service_role", `delete from storage.objects where id='${SEED}'`, { guc: true });
  ok(`${label}: service_role DELETE(guc=true) rows=1`, r.ok && r.affected === 1, JSON.stringify(r));
  const s = await q(`select count(*)::int c, max(metadata::text) m from storage.objects where id=$1`, [SEED]);
  ok(`${label}: seed değişmedi (rollback'ler iz bırakmadı)`, s[0].c === 1 && s[0].m === '{"k": "seed"}', JSON.stringify(s));
  ok(`${label}: object sayısı sabit (2)`, (await q(`select count(*)::int c from storage.objects`))[0].c === 2);
}

async function runZF() {
  const e = await errOf(() => db.exec(ZF));
  const msg = e ? e.message : "";
  return { e, msg, verdict: (msg.match(/S2_ZF_VERDICT=(\w+)/) || [])[1] };
}

try {
  // ---- fixture
  let e = await errOf(() => db.exec(MODEL));
  ok("fixture: storage modeli yüklendi", !e, e && e.message);
  e = await errOf(() => db.exec(BASE));
  ok("fixture: baseline arming olmadan reddedilir", e && /S2_FIXTURE_NOT_ARMED/.test(e.message), e && e.message);
  ok("fixture: reddedilen baseline iz bırakmadı", (await q(`select count(*)::int c from storage.buckets`))[0].c === 0);
  await db.exec(ARM_FIX + BASE);
  SEED = (await q(`insert into storage.objects(bucket_id,name,metadata) values ('media','venues/seed-1.jpg','{"k":"seed"}') returning id`))[0].id;
  SEED_DRAFT = (await q(`insert into storage.objects(bucket_id,name) values ('email-assets-draft','d/seed.png') returning id`))[0].id;
  // "diğer policy" kümesi boş olmasın: başka tabloda kanarya policy (S2 buna dokunmamalı)
  await db.exec(`create table public.s2_canary (id int);
                 alter table public.s2_canary enable row level security;
                 create policy "s2 canary read" on public.s2_canary for select to anon using (true);`);

  const BASE_SNAP = await snap();
  ok("baseline: policy md5 == production baseline (birebir tanım)", (await md5()) === PROD_BASELINE_MD5, await md5());
  const UNT = await untouched();

  // ---- PRE assert (seed objesi nedeniyle satır 12 (media count) beklenen FAIL)
  let a = await assertRows("pre", PRE_ASSERT, "S2_PRE_ASSERT_PASS");
  PRE20 = rowOf(a, ENV_ROW).actual;
  ok("pre_assert(baseline): satır 20 PRE kaydı (yerel: yalnız kanarya policy) ve env farkı olarak FAIL",
     /^1:[0-9a-f]{32}$/.test(PRE20 || "") && rowOf(a, ENV_ROW).result === "FAIL", PRE20);
  ok("pre_assert(baseline): env satırı dışında yalnız media object count farkı (yerel seed)",
     badExceptEnv(a).length === 1 && /^12:/.test(badExceptEnv(a)[0]), a.bad.join(" | "));
  ok("pre_assert(baseline): policy/bucket/rol satırları PASS",
     a.rows.filter((x) => x.ord >= 1 && x.ord <= 11 || x.ord === 13 || x.ord === 14 || x.ord === 21).every((x) => x.result === "PASS"));
  ok("pre_assert(baseline): satır 21 bucket öznitelikleri == production literali (fixture birebir)",
     rowOf(a, 21).result === "PASS" && rowOf(a, 21).actual === PROD_BUCKET_ATTRS, rowOf(a, 21).actual);
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("prod_assert(baseline): FAIL (açık tespit ediliyor)", a.overall === "S2_PROD_ASSERT_FAIL" && a.bad.some((x) => /^3:/.test(x)), a.bad.join(" | "));
  ok("prod_assert(baseline): satır 20/21 pre_assert ile aynı değeri hesaplar", envRowIs(a, PRE20) && rowOf(a, 21).actual === PROD_BUCKET_ATTRS);

  // ---- baseline davranışı (açık modellenmiş mi)
  await behavior("baseline", true);

  // ---- ZF testi baseline'da: açığı yakalamalı, iz bırakmamalı
  let z = await runZF();
  ok("zf(baseline): REPORT ile biter", z.e && /^REPORT:/.test(z.msg.replace(/^.*?REPORT:/, "REPORT:")), z.msg.slice(0, 200));
  ok("zf(baseline): VERDICT=FAIL (red-before-green)", z.verdict === "FAIL" && /FAIL anon\.insert ALLOWED/.test(z.msg) && /FAIL authenticated\.insert ALLOWED/.test(z.msg), z.msg);
  ok("zf(baseline): residue 0 / policy değişmedi", (await q(`select count(*)::int c from storage.objects where name like 'zz-sec-media-s2-zf/%'`))[0].c === 0 && (await snap()) === BASE_SNAP);

  // ---- DOWN silahsız reddedilir
  e = await errOf(() => db.exec(DOWN));
  ok("down: silahsızken S2_DOWN_INSECURE_NOT_ARMED", e && /S2_DOWN_INSECURE_NOT_ARMED/.test(e.message), e && e.message);
  ok("down: silahsız deneme hiçbir şey değiştirmedi", (await snap()) === BASE_SNAP);

  // ---- UP
  e = await errOf(() => db.exec(UP));
  ok("up: uygulandı", !e, e && e.message);
  ok("up: policy kümesi yalnız 'media anon read'", (await policyNames()) === "media anon read", await policyNames());
  ok("up: policy md5 == beklenen POST", (await md5()) === POST_MD5);
  ok("up: buckets/trigger/grant/RLS/rol değişmedi", (await untouched()) === UNT);
  await db.exec(`insert into supabase_migrations.schema_migrations(version,name) values ('20990101000000','sec_media_close_anon_write')`);
  await db.exec(`select set_config('storage.allow_delete_query','true',false); delete from storage.objects where id='${SEED}'; select set_config('storage.allow_delete_query','false',false);`);
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("prod_assert(after up, seed yok): env satırı dışında tümü PASS (production'da S2_PROD_ASSERT_PASS karşılığı)", passModEnv(a, PRE20), a.bad.join(" | "));
  ok("prod_assert(after up): satır 20 POST == PRE (S2 diğer policy'lere dokunmadı)", envRowIs(a, PRE20), rowOf(a, ENV_ROW).actual);
  ok("prod_assert(after up): satır 21 PASS (bucket öznitelikleri değişmedi)", rowOf(a, 21).result === "PASS");

  // ---- satır 20/21 duyarlılık negatifleri (her biri geri alınır)
  const sens = async (label, mutate, revert, expectRow) => {
    await db.exec(mutate);
    const p = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
    const r = await assertRows("pre", PRE_ASSERT, "S2_PRE_ASSERT_PASS");
    const caught = expectRow === ENV_ROW
      ? rowOf(p, ENV_ROW).actual !== PRE20 && rowOf(r, ENV_ROW).actual === rowOf(p, ENV_ROW).actual && badExceptEnv(p).length === 0
      : badExceptEnv(p).length === 1 && badExceptEnv(p)[0].startsWith(`${expectRow}:`) && rowOf(r, expectRow).result === "FAIL";
    ok(`neg(satır ${expectRow}): ${label} -> yakalandı`, caught, p.bad.join(" | "));
    await db.exec(revert);
    ok(`neg(satır ${expectRow}): ${label} geri alındı -> PRE değerine döndü`, passModEnv(await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS"), PRE20));
  };
  await sens("başka tabloda yeni policy", `create policy "s2 stray write" on public.s2_canary for insert to anon with check (true)`,
             `drop policy "s2 stray write" on public.s2_canary`, ENV_ROW);
  await sens("başka tablodaki policy ifadesi değişti", `alter policy "s2 canary read" on public.s2_canary using (false)`,
             `alter policy "s2 canary read" on public.s2_canary using (true)`, ENV_ROW);
  await sens("başka tablodaki policy rolü değişti", `alter policy "s2 canary read" on public.s2_canary to authenticated`,
             `alter policy "s2 canary read" on public.s2_canary to anon`, ENV_ROW);
  await sens("media file_size_limit", `update storage.buckets set file_size_limit = 5242880 where id = 'media'`,
             `update storage.buckets set file_size_limit = null where id = 'media'`, 21);
  await sens("email-assets-public allowed_mime_types", `update storage.buckets set allowed_mime_types = array['image/png'] where id = 'email-assets-public'`,
             `update storage.buckets set allowed_mime_types = null where id = 'email-assets-public'`, 21);
  await sens("email-assets-draft versioning_status", `update storage.buckets set versioning_status = 'ENABLED' where id = 'email-assets-draft'`,
             `update storage.buckets set versioning_status = 'DISABLED' where id = 'email-assets-draft'`, 21);
  await sens("media type", `update storage.buckets set type = 'ANALYTICS' where id = 'media'`,
             `update storage.buckets set type = 'STANDARD' where id = 'media'`, 21);

  SEED = (await q(`insert into storage.objects(bucket_id,name,metadata) values ('media','venues/seed-1.jpg','{"k":"seed"}') returning id`))[0].id;
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("prod_assert: beklenmeyen media objesi residue satırında yakalanır", !a.pass && badExceptEnv(a).length === 1 && /^13:/.test(badExceptEnv(a)[0]) && envRowIs(a, PRE20), a.bad.join(" | "));
  a = await assertRows("pre", PRE_ASSERT, "S2_PRE_ASSERT_PASS");
  ok("pre_assert(after up): FAIL (durum değişti)", a.overall === "S2_PRE_ASSERT_FAIL");

  // ---- kapalı davranış
  await behavior("after_up", false);

  // ---- ZF testi: PASS + iz yok
  z = await runZF();
  ok("zf(after up): VERDICT=PASS fails=0", z.verdict === "PASS" && /fails=0/.test(z.msg), z.msg);
  for (const frag of ["PASS anon.insert denied 42501 RLS", "PASS authenticated.insert denied 42501 RLS",
                      "PASS anon.upsert denied 42501 RLS", "PASS authenticated.upsert denied 42501 RLS",
                      "PASS anon.update rows=0", "PASS authenticated.update rows=0",
                      "PASS anon.delete rows=0", "PASS authenticated.delete rows=0",
                      "PASS anon.delete_no_guc blocked_by_protect_delete_trigger(not_RLS)",
                      "PASS anon.select media visible", "PASS authenticated.select media visible",
                      "PASS service_role.insert", "PASS service_role.update rows=1", "PASS service_role.delete rows=1",
                      "PASS in_txn_residue=0"]) {
    ok(`zf(after up): '${frag}'`, z.msg.includes(frag));
  }
  ok("zf(after up): residue 0, seed intact, policy değişmedi",
     (await q(`select count(*)::int c from storage.objects where name like 'zz-sec-media-s2-zf/%'`))[0].c === 0 &&
     (await q(`select count(*)::int c from storage.objects`))[0].c === 2 && (await policyNames()) === "media anon read");
  ok("zf: rol/GUC sızmadı (current_user=postgres)", (await q(`select current_user u`))[0].u === "postgres");

  // ---- idempotent ikinci UP
  e = await errOf(() => db.exec(UP));
  ok("up x2: idempotent (hata yok)", !e, e && e.message);
  ok("up x2: matris aynı + diğerleri değişmedi", (await md5()) === POST_MD5 && (await untouched()) === UNT);

  // ---- INSECURE rollback (armed) -> baseline birebir
  e = await errOf(() => db.exec(ARM_DOWN + DOWN));
  ok("down(armed): uygulandı", !e, e && e.message);
  ok("down(armed): pg_policies birebir baseline (tüm kolonlar)", (await snap()) === BASE_SNAP);
  ok("down(armed): md5 == production baseline", (await md5()) === PROD_BASELINE_MD5);
  ok("down(armed): diğerleri değişmedi", (await untouched()) === UNT);
  a = await assertRows("pre", PRE_ASSERT, "S2_PRE_ASSERT_PASS");
  ok("down(armed): pre_assert satır 1–11/14/21 PASS, satır 20 == PRE (yalnız 12 seed, 13 ledger farkı)",
     a.rows.filter((x) => x.ord >= 1 && x.ord <= 11 || x.ord === 14 || x.ord === 21).every((x) => x.result === "PASS") &&
     envRowIs(a, PRE20) && badExceptEnv(a).map((b) => b.split(":")[0]).join(",") === "12,13", a.bad.join(" | "));
  await behavior("after_down", true);
  e = await errOf(() => db.exec(ARM_DOWN + DOWN));
  ok("down x2 (armed): idempotent", !e && (await snap()) === BASE_SNAP, e && e.message);

  // ---- yeniden UP
  e = await errOf(() => db.exec(UP));
  ok("re-up: uygulandı + POST matris", !e && (await md5()) === POST_MD5, e && e.message);
  await behavior("after_reup", false);

  // ---- drift / atomiklik negatifleri (her biri baseline'dan)
  const toBaseline = async () => { await db.exec(ARM_DOWN + DOWN); return (await snap()) === BASE_SNAP; };
  ok("neg: baseline'a dönüldü", await toBaseline());

  await db.exec(`create policy "media extra anon insert" on storage.objects for insert to anon with check (bucket_id = 'media')`);
  let before = await snap();
  e = await errOf(() => db.exec(UP));
  ok("neg: beklenmeyen policy -> S2_PRE_DRIFT, hiçbir şey değişmedi", e && /S2_PRE_DRIFT/.test(e.message) && (await snap()) === before, e && e.message);
  e = await errOf(() => db.exec(ARM_DOWN + DOWN));
  ok("neg: DOWN da beklenmeyen policy'de durur", e && /S2_DOWN_PRE_DRIFT/.test(e.message) && (await snap()) === before, e && e.message);
  await db.exec(`drop policy "media extra anon insert" on storage.objects`);

  await db.exec(`drop policy "media anon insert" on storage.objects; create policy "media anon insert" on storage.objects for insert to public with check ((bucket_id = 'media'::text) and true)`);
  before = await snap();
  e = await errOf(() => db.exec(UP));
  ok("neg: yazma policy tanım drift'i -> S2_PRE_DRIFT, değişiklik yok", e && /S2_PRE_DRIFT/.test(e.message) && (await snap()) === before, e && e.message);
  ok("neg: DOWN(armed) tanımı birebir baseline'a düzeltir", await toBaseline());

  await db.exec(`drop policy "media anon read" on storage.objects; create policy "media anon read" on storage.objects for select to anon using (bucket_id = 'media'::text)`);
  before = await snap();
  e = await errOf(() => db.exec(UP));
  ok("neg: read policy drift -> S2_PRE_DRIFT, değişiklik yok", e && /S2_PRE_DRIFT/.test(e.message) && (await snap()) === before, e && e.message);
  await db.exec(ARM_FIX + BASE);
  ok("neg: fixture ile baseline", (await snap()) === BASE_SNAP);

  await db.exec(`update storage.buckets set public=false where id='media'`);
  e = await errOf(() => db.exec(UP));
  ok("neg: media public=false -> S2_PRE_FAIL, değişiklik yok", e && /S2_PRE_FAIL/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  await db.exec(`update storage.buckets set public=true where id='media'`);

  await db.exec(`update storage.buckets set public=true where id='email-assets-draft'`);
  e = await errOf(() => db.exec(UP));
  ok("neg: email-assets-draft drift -> S2_PRE_DRIFT, değişiklik yok", e && /S2_PRE_DRIFT/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  await db.exec(`update storage.buckets set public=false where id='email-assets-draft'`);

  await db.exec(`alter table storage.objects disable row level security`);
  e = await errOf(() => db.exec(UP));
  ok("neg: RLS kapalı -> S2_PRE_FAIL, değişiklik yok", e && /S2_PRE_FAIL/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  await db.exec(`alter table storage.objects enable row level security`);
  ok("neg: diğerleri baseline'a döndü", (await untouched()) === UNT);

  // POST guard bloğu tek başına baseline'da çalışırsa reddetmeli
  const postBlock = (UP.match(/do \$s2_post\$[\s\S]*?\$s2_post\$;/) || [])[0];
  e = await errOf(() => db.exec(postBlock));
  ok("neg: POST guard baseline'da S2_POST_FAIL verir", postBlock && e && /S2_POST_FAIL/.test(e.message), e && e.message);
  // Atomiklik: dosya gövdesi tek transaction'da; drop'lardan SONRA hata -> drop'lar geri alınır
  e = await errOf(() => db.exec(UP + "\ndo $inj$ begin raise exception 'S2_TEST_INJECTED_FAILURE'; end $inj$;"));
  ok("neg: drop sonrası hata -> tüm gövde geri alındı (atomik)", e && /S2_TEST_INJECTED_FAILURE/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  e = await errOf(() => db.exec(ARM_DOWN + DOWN + "\ndo $inj$ begin raise exception 'S2_TEST_INJECTED_FAILURE'; end $inj$;"));
  ok("neg: down(armed) gövdesi de atomik", e && /S2_TEST_INJECTED_FAILURE/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);

  // ---- son durum: UP uygulanmış
  e = await errOf(() => db.exec(UP));
  ok("final: up uygulanmış durumda bitir", !e && (await policyNames()) === "media anon read", e && e.message);
  z = await runZF();
  ok("final: zf PASS", z.verdict === "PASS", z.msg);
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("final: tüm up/down/drift döngüsü sonrası satır 20 == PRE, satır 21 PASS", envRowIs(a, PRE20) && rowOf(a, 21).result === "PASS", a.bad.join(" | "));
} catch (err) {
  fail++;
  log.push("FATAL " + (err && err.stack || err));
}

console.log(log.join("\n"));
console.log(`\nRESULT pass=${pass} fail=${fail}`);
console.log(fail === 0 ? "S2_LOCAL_PGLITE_GATE_PASS" : "S2_LOCAL_PGLITE_GATE_FAIL");
process.exit(fail === 0 ? 0 : 1);
