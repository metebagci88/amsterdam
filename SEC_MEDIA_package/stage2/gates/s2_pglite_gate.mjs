// =====================================================================
// SEC-MEDIA · STAGE 2 · gates/s2_pglite_gate.mjs   (v2 — NEUTRALIZE: ALTER POLICY ... TO service_role)
// Gerçek Postgres (PGlite/WASM; 0.3.16 = PG17, 0.5.x = PG18) üzerinde S2 paketinin yerel kapısı.
// Production'a / ağa DOKUNMAZ; ücretli kaynak yok; secret okumaz.
//
//   PGLITE_DIR=<@electric-sql/pglite kurulu dizin> node gates/s2_pglite_gate.mjs
//   (PGLITE_DIR yoksa normal paket çözümlemesi denenir.)
//
// Kapsam: statik içerik kontrolleri (MCP metin kapısı: MCP'ye giden 5 dosyada /drop/i YOK;
// S2_up = tam 3 ALTER POLICY .. TO service_role + 3 COMMENT ON POLICY; DOWN = tam 3 ALTER POLICY
// .. TO public + 3 COMMENT .. IS NULL); storage modeli + prod baseline (policy md5 prod ile birebir);
// baseline'da açığın modellendiği; S2_up sonrası 4 policy kalır, üç yazma policy'si {service_role}
// (cmd/qual/with_check değişmez), POST md5 = s2_prod_assert satır 7 literali; anon/authenticated
// INSERT/UPSERT=42501(RLS), UPDATE/DELETE=0 satır, SELECT izinli, service_role yazar (policy'ler
// service_role için değerlendirilmez = etkisiz); zero-footprint testinin hem açığı yakaladığı (FAIL)
// hem kapanışı kanıtladığı (PASS) ve iz bırakmadığı; S2_up iki kez (idempotent; v2 durumunu kabul
// eder); S2_down_INSECURE silahsızken reddi, armed iken baseline'ın (açıklamalar dahil) birebir geri
// gelmesi; yeniden up; drift/atomiklik negatifleri (karışık roller, v1 durumu (yazma policy'leri
// yok), tanım drift'i, rol yeniden-grant, BYPASSRLS bayrağı, açıklama eksik); satır 20/21 ("diğer
// bucket/policy'lerde değişiklik yok"): S2 döngüsü boyunca PRE == POST, bucket öznitelikleri ==
// production literali, başka tabloda policy / bucket özniteliği değişikliği assert'lerde FAIL
// olarak yakalanır.
// Not: bu harness (MCP'ye gitmez) test durumlarını kurmak için kendi içinde policy silebilir.
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
// v2 beklenen POST matrisi (pre_assert satır 6 formülünün satırları) ve md5'i (= prod_assert satır 7 literali)
const V2_LINES = [
  "media anon delete|DELETE|{service_role}|PERMISSIVE|(bucket_id = 'media'::text)|<null>",
  "media anon insert|INSERT|{service_role}|PERMISSIVE|<null>|(bucket_id = 'media'::text)",
  "media anon read|SELECT|{public}|PERMISSIVE|(bucket_id = 'media'::text)|<null>",
  "media anon update|UPDATE|{service_role}|PERMISSIVE|(bucket_id = 'media'::text)|(bucket_id = 'media'::text)",
];
const POST_MD5_V2 = "74b56eca9c133d987aa2ac056b412473";
const COMMENT_PREFIX = "SEC-MEDIA S2: NEUTRALIZED";

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
const WRITES = ["media anon insert", "media anon update", "media anon delete"];
const sameSet = (arr) => arr.length === 3 && WRITES.every((n) => arr.includes(n));
{
  // MCP metin kapısı: production'a MCP ile giden HER dosyada /drop/i (kod/yorum/string, her harf biçimi) yok
  for (const [n, s] of [["S2_up.sql", UP], ["S2_down_INSECURE.sql", DOWN], ["s2_pre_assert.sql", PRE_ASSERT],
                        ["s2_prod_assert.sql", PROD_ASSERT], ["s2_zero_footprint_test.sql", ZF],
                        ["armed rollback payload", ARM_DOWN + DOWN]]) {
    const hits = s.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /drop/i.test(l)).map(([i]) => i);
    ok(`static(MCP): ${n} /drop/i içermiyor`, hits.length === 0, "satır " + hits.join(","));
  }

  const up = stripComments(UP);
  const upNoLit = stripLiterals(UP);
  ok("static: S2_up dış begin/commit/rollback yok", !/^\s*(begin|commit|rollback|start\s+transaction|end)\s*;/im.test(up));
  const alters = [...up.matchAll(/alter\s+policy\s+"([^"]+)"\s+on\s+storage\.objects\s+to\s+service_role\s*;/gi)].map((m) => m[1]);
  ok("static: S2_up tam 3 ALTER POLICY .. TO service_role (insert/update/delete)", sameSet(alters), alters.join(","));
  ok("static: S2_up başka ALTER POLICY yok (USING/WITH CHECK/RENAME değişmez)", (up.match(/alter\s+policy/gi) || []).length === 3);
  ok("static: S2_up rename yok", !/\brename\b/i.test(upNoLit));
  ok("static: S2_up create policy yok", !/\bcreate\s+policy\b/i.test(upNoLit));
  ok("static: S2_up read policy'ye dokunmaz", !/(alter|comment\s+on)\s+policy\s+"media anon read"/i.test(up));
  const cmts = [...up.matchAll(/comment\s+on\s+policy\s+"([^"]+)"\s+on\s+storage\.objects\s+is\s+'((?:[^']|'')*)'\s*;/gi)];
  ok("static: S2_up tam 3 COMMENT ON POLICY (yazma policy'leri)", sameSet(cmts.map((m) => m[1])) && (up.match(/comment\s+on/gi) || []).length === 3,
     cmts.map((m) => m[1]).join(","));
  ok("static: S2_up açıklamaları 'SEC-MEDIA S2: NEUTRALIZED' + BYPASSRLS + re-grant uyarısı (EN/TR)",
     cmts.length === 3 && cmts.every((m) => m[2].startsWith(COMMENT_PREFIX) && m[2].includes("BYPASSRLS") &&
       m[2].includes("Do NOT re-grant") && m[2].includes("VERMEYİN")));
  ok("static: S2_up bucket/email-assets yazımı yok", !/(insert\s+into|update|delete\s+from)\s+storage\.buckets/i.test(upNoLit));
  ok("static: S2_up grant/revoke/alter table/truncate/set role/RLS disable yok",
     !/\b(grant|revoke|truncate)\b|\balter\s+table\b|\bset\s+(local\s+)?role\b|disable\s+row\s+level\s+security/i.test(upNoLit));
  ok("static: S2_up lock_timeout set local", /set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i.test(up));

  const dn = stripComments(DOWN);
  const dnNoLit = stripLiterals(DOWN);
  ok("static: DOWN arming guard var", /current_setting\('sec_media\.s2_insecure_rollback',\s*true\)/.test(dn) && /S2_DOWN_INSECURE_NOT_ARMED/.test(dn));
  ok("static: DOWN arming guard ilk ifade", dn.trim().toLowerCase().startsWith("do $s2_arm$"));
  const dAlters = [...dn.matchAll(/alter\s+policy\s+"([^"]+)"\s+on\s+storage\.objects\s+to\s+public\s*;/gi)].map((m) => m[1]);
  ok("static: DOWN tam 3 ALTER POLICY .. TO public", sameSet(dAlters) && (dn.match(/alter\s+policy/gi) || []).length === 3, dAlters.join(","));
  const dCmts = [...dn.matchAll(/comment\s+on\s+policy\s+"([^"]+)"\s+on\s+storage\.objects\s+is\s+null\s*;/gi)].map((m) => m[1]);
  ok("static: DOWN tam 3 COMMENT ON POLICY .. IS NULL", sameSet(dCmts) && (dn.match(/comment\s+on/gi) || []).length === 3, dCmts.join(","));
  ok("static: DOWN create policy / rename yok", !/\bcreate\s+policy\b|\brename\b/i.test(dnNoLit));
  ok("static: DOWN read policy'ye dokunmaz", !/(alter|comment\s+on)\s+policy\s+"media anon read"/i.test(dn));
  ok("static: DOWN bucket yazımı yok", !/(insert\s+into|update|delete\s+from)\s+storage\.buckets/i.test(dnNoLit));
  ok("static: DOWN dış begin/commit yok", !/^\s*(begin|commit|rollback|start\s+transaction|end)\s*;/im.test(dn));
  ok("static: DOWN POST guard baseline md5 literali (= pre_assert satır 6)", dn.includes(`'${PROD_BASELINE_MD5}'`) && PRE_ASSERT.includes(`'${PROD_BASELINE_MD5}'`));

  for (const [n, s] of [["s2_pre_assert", PRE_ASSERT], ["s2_prod_assert", PROD_ASSERT]]) {
    const t = stripLiterals(s);
    ok(`static: ${n} salt-okunur (yalnız WITH/SELECT)`,
       /^\s*with\b/i.test(t) && !/\b(insert|update|delete|drop|create|alter|grant|revoke|truncate|copy|call|perform|set_config|do|comment)\b|\bset\s/i.test(t) && (t.match(/;/g) || []).length === 1);
  }
  const md5Expr = (r) => (r || "").trim().replace(/^'[0-9a-f]{32}',\s*/, "");
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
  // prod_assert v2 POST matrisi: satır 3-5 beklenenleri + satır 7 md5 literali (pre_assert satır 6 ile aynı formül)
  ok("static: prod_assert satır 7 md5 sorgusu pre_assert satır 6 ile aynı formül",
     !!rowSql(PRE_ASSERT, 6) && md5Expr(rowSql(PRE_ASSERT, 6)) === md5Expr(rowSql(PROD_ASSERT, 7)) && /order by policyname/.test(md5Expr(rowSql(PRE_ASSERT, 6))),
     JSON.stringify([rowSql(PRE_ASSERT, 6), rowSql(PROD_ASSERT, 7)]));
  ok("static: prod_assert satır 7 beklenen = v2 POST md5 literali (tek)", PROD_ASSERT.split(`'${POST_MD5_V2}'`).length === 2);
  for (const l of V2_LINES.filter((x) => !x.startsWith("media anon read|"))) {
    const exp = "'" + l.slice(l.indexOf("|") + 1).replace(/'/g, "''") + "'";
    ok(`static: prod_assert v2 beklenen satır (${l.split("|")[0]})`, PROD_ASSERT.includes(exp), exp);
  }
  const zf = stripComments(ZF);
  ok("static: ZF tek DO bloğu + REPORT raise ile biter", /^\s*do \$s2zf\$/i.test(zf) && /raise exception using message = 'REPORT:' \|\| rep, errcode = 'P0001';\s*end\s*\$s2zf\$;\s*$/i.test(zf));
  ok("static: ZF commit/bucket yazımı/policy değişikliği yok", !/\bcommit\b/i.test(zf) && !/(insert\s+into|update|delete\s+from)\s+storage\.buckets/i.test(zf) &&
     !/\b(alter|create|comment\s+on)\s+policy\b/i.test(stripLiterals(ZF)));
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
// snapshot = pg_policies tüm kolonlar + policy açıklaması (COMMENT ON POLICY)
const SNAP = `select p.policyname, p.cmd, p.roles::text roles, p.permissive, p.qual, p.with_check, obj_description(c.oid, 'pg_policy') cmt
                from pg_policies p join pg_policy c on c.polrelid = 'storage.objects'::regclass and c.polname = p.policyname
               where p.schemaname='storage' and p.tablename='objects' order by p.policyname`;
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
const rolesOf = async () => (await q(SNAP)).map((r) => r.policyname + ":" + r.roles).join(",");
const comments = async () => Object.fromEntries((await q(SNAP)).map((r) => [r.policyname, r.cmt]));
const ALL4 = "media anon delete,media anon insert,media anon read,media anon update";
const V2_ROLES = "media anon delete:{service_role},media anon insert:{service_role},media anon read:{public},media anon update:{service_role}";
const BASE_ROLES = "media anon delete:{public},media anon insert:{public},media anon read:{public},media anon update:{public}";
const v2Comments = async () => { const c = await comments(); return WRITES.every((n) => typeof c[n] === "string" && c[n].startsWith(COMMENT_PREFIX)) && c["media anon read"] === null; };
const noComments = async () => Object.values(await comments()).every((v) => v === null);

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
  // etkisizlik kanıtı: media-only WITH CHECK'li policy'ler service_role için değerlendirilmez (BYPASSRLS)
  r = await asRole("service_role", `insert into storage.objects(bucket_id,name) values ('email-assets-draft','x/svc-bypass.png')`);
  ok(`${label}: service_role media dışı bucket'a yazar (policy değerlendirilmez = BYPASSRLS)`, r.ok && r.affected === 1, r.message);
  const s = await q(`select count(*)::int c, max(metadata::text) m from storage.objects where id=$1`, [SEED]);
  ok(`${label}: seed değişmedi (rollback'ler iz bırakmadı)`, s[0].c === 1 && s[0].m === '{"k": "seed"}', JSON.stringify(s));
  ok(`${label}: object sayısı sabit (2)`, (await q(`select count(*)::int c from storage.objects`))[0].c === 2);
}

async function runZF() {
  const e = await errOf(() => db.exec(ZF));
  const msg = e ? e.message : "";
  return { e, msg, verdict: (msg.match(/S2_ZF_VERDICT=(\w+)/) || [])[1] };
}
const INJ = "\ndo $inj$ begin raise exception 'S2_TEST_INJECTED_FAILURE'; end $inj$;";

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
  ok("baseline: policy açıklamaları NULL (production 2026-10-07 read-only ile aynı)", await noComments());
  ok("v2 POST md5 literali == beklenen v2 satırlarından hesaplanan md5",
     (await q(`select md5($1) m`, [V2_LINES.join("\n")]))[0].m === POST_MD5_V2);
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
  ok("prod_assert(baseline): FAIL (açık tespit ediliyor: satır 3-7 + 18)",
     a.overall === "S2_PROD_ASSERT_FAIL" && ["3", "4", "5", "6", "7", "18"].every((n) => a.bad.some((x) => x.startsWith(n + ":"))), a.bad.join(" | "));
  ok("prod_assert(baseline): satır 20/21 pre_assert ile aynı değeri hesaplar", envRowIs(a, PRE20) && rowOf(a, 21).actual === PROD_BUCKET_ATTRS);

  // ---- baseline davranışı (açık modellenmiş mi)
  await behavior("baseline", true);

  // ---- ZF testi baseline'da: açığı yakalamalı, iz bırakmamalı
  let z = await runZF();
  ok("zf(baseline): REPORT ile biter", z.e && /REPORT:/.test(z.msg), z.msg.slice(0, 200));
  ok("zf(baseline): VERDICT=FAIL (red-before-green)", z.verdict === "FAIL" && /FAIL anon\.insert ALLOWED/.test(z.msg) && /FAIL authenticated\.insert ALLOWED/.test(z.msg), z.msg);
  ok("zf(baseline): INFO policy rolleri raporda ({public})", z.msg.includes("INFO storage.objects policies=media anon delete:DELETE:{public},media anon insert:INSERT:{public},media anon read:SELECT:{public},media anon update:UPDATE:{public};"), z.msg.slice(0, 400));
  ok("zf(baseline): residue 0 / policy değişmedi", (await q(`select count(*)::int c from storage.objects where name like 'zz-sec-media-s2-zf/%'`))[0].c === 0 && (await snap()) === BASE_SNAP);

  // ---- DOWN silahsız reddedilir
  e = await errOf(() => db.exec(DOWN));
  ok("down: silahsızken S2_DOWN_INSECURE_NOT_ARMED", e && /S2_DOWN_INSECURE_NOT_ARMED/.test(e.message), e && e.message);
  ok("down: silahsız deneme hiçbir şey değiştirmedi", (await snap()) === BASE_SNAP);

  // ---- UP
  e = await errOf(() => db.exec(UP));
  ok("up: uygulandı", !e, e && e.message);
  ok("up: 4 policy kalır (adlar değişmez)", (await policyNames()) === ALL4, await policyNames());
  ok("up: üç yazma policy'si {service_role}, read {public}", (await rolesOf()) === V2_ROLES, await rolesOf());
  ok("up: policy md5 == v2 POST literali (cmd/qual/with_check değişmedi)", (await md5()) === POST_MD5_V2, await md5());
  ok("up: üç yazma policy'sinde S2 açıklaması, read açıklamasız", await v2Comments(), JSON.stringify(await comments()));
  ok("up: buckets/trigger/grant/RLS/rol değişmedi", (await untouched()) === UNT);
  const V2_SNAP = await snap();
  await db.exec(`insert into supabase_migrations.schema_migrations(version,name) values ('20990101000000','sec_media_close_anon_write')`);
  await db.exec(`select set_config('storage.allow_delete_query','true',false); delete from storage.objects where id='${SEED}'; select set_config('storage.allow_delete_query','false',false);`);
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("prod_assert(after up, seed yok): env satırı dışında tümü PASS (production'da S2_PROD_ASSERT_PASS karşılığı)", passModEnv(a, PRE20), a.bad.join(" | "));
  ok("prod_assert(after up): 19 counted satır (1-16, 18, 20, 21)", /\/ 19 counted$/.test(rowOf(a, 99).actual || ""), rowOf(a, 99).actual);
  ok("prod_assert(after up): satır 7 actual == v2 md5, satır 18 == 3", rowOf(a, 7).actual === POST_MD5_V2 && rowOf(a, 18).actual === "3");
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
  // v2'ye özgü prod_assert duyarlılığı: açıklama silinirse satır 18, bir yazma policy'si anon'a
  // yeniden verilirse satır 4/6/7 FAIL
  await db.exec(`comment on policy "media anon delete" on storage.objects is null`);
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("neg(satır 18): açıklama silindi -> yalnız satır 18 FAIL", badExceptEnv(a).map((b) => b.split(":")[0]).join(",") === "18", a.bad.join(" | "));
  e = await errOf(() => db.exec(UP));
  ok("neg(satır 18): S2_up yeniden -> açıklama geri, v2 snapshot birebir", !e && (await snap()) === V2_SNAP, e && e.message);
  await db.exec(`alter policy "media anon update" on storage.objects to anon`);
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("neg(satır 4/6/7): update policy anon'a yeniden verildi -> yakalandı", badExceptEnv(a).map((b) => b.split(":")[0]).join(",") === "4,6,7", a.bad.join(" | "));
  await db.exec(`alter policy "media anon update" on storage.objects to service_role`);
  ok("neg(satır 4/6/7): geri alındı -> v2 snapshot", (await snap()) === V2_SNAP);

  SEED = (await q(`insert into storage.objects(bucket_id,name,metadata) values ('media','venues/seed-1.jpg','{"k":"seed"}') returning id`))[0].id;
  a = await assertRows("post", PROD_ASSERT, "S2_PROD_ASSERT_PASS");
  ok("prod_assert: beklenmeyen media objesi residue satırında yakalanır", !a.pass && badExceptEnv(a).length === 1 && /^13:/.test(badExceptEnv(a)[0]) && envRowIs(a, PRE20), a.bad.join(" | "));
  a = await assertRows("pre", PRE_ASSERT, "S2_PRE_ASSERT_PASS");
  ok("pre_assert(after up): FAIL (durum değişti: satır 3-6)", a.overall === "S2_PRE_ASSERT_FAIL" && ["3", "4", "5", "6"].every((n) => a.bad.some((x) => x.startsWith(n + ":"))), a.bad.join(" | "));

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
                      "PASS in_txn_residue=0",
                      "INFO storage.objects policies=media anon delete:DELETE:{service_role},media anon insert:INSERT:{service_role},media anon read:SELECT:{public},media anon update:UPDATE:{service_role};"]) {
    ok(`zf(after up): '${frag}'`, z.msg.includes(frag));
  }
  ok("zf(after up): residue 0, seed intact, policy değişmedi",
     (await q(`select count(*)::int c from storage.objects where name like 'zz-sec-media-s2-zf/%'`))[0].c === 0 &&
     (await q(`select count(*)::int c from storage.objects`))[0].c === 2 && (await snap()) === V2_SNAP);
  ok("zf: rol/GUC sızmadı (current_user=postgres)", (await q(`select current_user u`))[0].u === "postgres");

  // ---- idempotent ikinci UP (PRE guard v2 durumunu kabul eder)
  e = await errOf(() => db.exec(UP));
  ok("up x2: idempotent (hata yok)", !e, e && e.message);
  ok("up x2: snapshot (açıklamalar dahil) aynı + diğerleri değişmedi", (await snap()) === V2_SNAP && (await md5()) === POST_MD5_V2 && (await untouched()) === UNT);

  // ---- INSECURE rollback (armed) -> baseline birebir
  e = await errOf(() => db.exec(ARM_DOWN + DOWN));
  ok("down(armed): uygulandı", !e, e && e.message);
  ok("down(armed): pg_policies + açıklamalar birebir baseline", (await snap()) === BASE_SNAP);
  ok("down(armed): md5 == production baseline", (await md5()) === PROD_BASELINE_MD5);
  ok("down(armed): açıklamalar NULL", await noComments());
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
  ok("re-up: uygulandı + v2 snapshot birebir", !e && (await snap()) === V2_SNAP, e && e.message);
  await behavior("after_reup", false);

  // ---- drift / atomiklik negatifleri
  const toBaseline = async () => { await db.exec(ARM_FIX + BASE); return (await snap()) === BASE_SNAP; };
  const upRefused = async (label, re) => {
    const before = await snap();
    const unt = await untouched();
    const err = await errOf(() => db.exec(UP));
    ok(`neg: ${label} -> UP ${re.source}, hiçbir şey değişmedi`, err && re.test(err.message) && (await snap()) === before && (await untouched()) === unt, err ? err.message : "UP çalıştı");
  };
  const downRefused = async (label, re) => {
    const before = await snap();
    const err = await errOf(() => db.exec(ARM_DOWN + DOWN));
    ok(`neg: ${label} -> DOWN(armed) ${re.source}, hiçbir şey değişmedi`, err && re.test(err.message) && (await snap()) === before, err ? err.message : "DOWN çalıştı");
  };
  ok("neg: baseline'a dönüldü", await toBaseline());

  await db.exec(`create policy "media extra anon insert" on storage.objects for insert to anon with check (bucket_id = 'media')`);
  await upRefused("beklenmeyen ek policy", /S2_PRE_DRIFT/);
  await downRefused("beklenmeyen ek policy", /S2_DOWN_PRE_DRIFT/);
  await db.exec(`drop policy "media extra anon insert" on storage.objects`);

  await db.exec(`alter policy "media anon insert" on storage.objects to service_role`);
  await upRefused("karışık roller (insert {service_role}, update/delete {public})", /S2_PRE_DRIFT: yazma policy rolleri karışık/);
  e = await errOf(() => db.exec(ARM_DOWN + DOWN));
  ok("neg: karışık roller -> DOWN(armed) birebir baseline'a çevirir", !e && (await snap()) === BASE_SNAP, e && e.message);

  await db.exec(`alter policy "media anon insert" on storage.objects to anon`);
  await upRefused("insert policy roles {anon} (baseline/v2 dışı)", /S2_PRE_DRIFT: yazma policy'si yok veya tanımı/);
  await downRefused("insert policy roles {anon}", /S2_DOWN_PRE_DRIFT/);
  ok("neg: fixture ile baseline", await toBaseline());

  e = await errOf(() => db.exec(UP));
  ok("neg hazırlık: v2 durumu", !e && (await snap()) === V2_SNAP, e && e.message);
  await db.exec(`alter policy "media anon update" on storage.objects to service_role, anon`);
  await upRefused("v2 + update roles {anon,service_role}", /S2_PRE_DRIFT/);
  await downRefused("v2 + update roles {anon,service_role}", /S2_DOWN_PRE_DRIFT/);
  await db.exec(`alter policy "media anon update" on storage.objects to service_role`);
  await db.exec(`alter policy "media anon delete" on storage.objects using (true)`);
  await upRefused("v2 + delete USING tanım drift'i", /S2_PRE_DRIFT/);
  await downRefused("v2 + delete USING tanım drift'i", /S2_DOWN_PRE_DRIFT/);
  ok("neg: fixture ile baseline", await toBaseline());

  await db.exec(`drop policy "media anon insert" on storage.objects; create policy "media anon insert" on storage.objects for insert to public with check ((bucket_id = 'media'::text) and true)`);
  await upRefused("baseline + insert WITH CHECK tanım drift'i", /S2_PRE_DRIFT/);
  await downRefused("baseline + insert WITH CHECK tanım drift'i (v2 DOWN tanım düzeltmez)", /S2_DOWN_PRE_DRIFT/);
  ok("neg: fixture ile baseline", await toBaseline());

  await db.exec(`drop policy "media anon insert" on storage.objects; drop policy "media anon update" on storage.objects; drop policy "media anon delete" on storage.objects;`);
  await upRefused("v1 durumu (yazma policy'leri yok, yalnız read)", /S2_PRE_DRIFT/);
  await downRefused("v1 durumu (DOWN yeniden oluşturmaz)", /S2_DOWN_PRE_DRIFT/);
  ok("neg: fixture ile baseline", await toBaseline());

  await db.exec(`drop policy "media anon read" on storage.objects; create policy "media anon read" on storage.objects for select to anon using (bucket_id = 'media'::text)`);
  await upRefused("read policy drift", /S2_PRE_DRIFT/);
  await downRefused("read policy drift", /S2_DOWN_PRE_DRIFT/);
  ok("neg: fixture ile baseline", await toBaseline());

  await db.exec(`update storage.buckets set public=false where id='media'`);
  await upRefused("media public=false", /S2_PRE_FAIL/);
  await db.exec(`update storage.buckets set public=true where id='media'`);

  await db.exec(`update storage.buckets set public=true where id='email-assets-draft'`);
  e = await errOf(() => db.exec(UP));
  ok("neg: email-assets-draft drift -> S2_PRE_DRIFT, değişiklik yok", e && /S2_PRE_DRIFT/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  await db.exec(`update storage.buckets set public=false where id='email-assets-draft'`);

  await db.exec(`alter table storage.objects disable row level security`);
  e = await errOf(() => db.exec(UP));
  ok("neg: RLS kapalı -> S2_PRE_FAIL, değişiklik yok", e && /S2_PRE_FAIL/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  await db.exec(`alter table storage.objects enable row level security`);

  await db.exec(`alter role service_role nobypassrls`);
  e = await errOf(() => db.exec(UP));
  ok("neg: service_role NOBYPASSRLS (etkisizlik argümanı çöker) -> S2_PRE_FAIL, değişiklik yok", e && /S2_PRE_FAIL: rol BYPASSRLS/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  await db.exec(`alter role service_role bypassrls`);
  await db.exec(`alter role anon bypassrls`);
  e = await errOf(() => db.exec(UP));
  ok("neg: anon BYPASSRLS -> S2_PRE_FAIL, değişiklik yok", e && /S2_PRE_FAIL: rol BYPASSRLS/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);
  await db.exec(`alter role anon nobypassrls`);
  ok("neg: diğerleri baseline'a döndü", (await untouched()) === UNT);

  // POST guard blokları tek başına
  const postBlock = (UP.match(/do \$s2_post\$[\s\S]*?\$s2_post\$;/) || [])[0];
  e = await errOf(() => db.exec(postBlock));
  ok("neg: UP POST guard baseline'da S2_POST_FAIL verir", postBlock && e && /S2_POST_FAIL/.test(e.message), e && e.message);
  // Atomiklik: dosya gövdesi tek transaction'da; ALTER/COMMENT'ten SONRA hata -> hepsi geri alınır
  e = await errOf(() => db.exec(UP + INJ));
  ok("neg: UP gövdesinden sonra hata -> rol + açıklama değişiklikleri geri alındı (atomik)", e && /S2_TEST_INJECTED_FAILURE/.test(e.message) && (await snap()) === BASE_SNAP, e && e.message);

  e = await errOf(() => db.exec(UP));
  ok("neg hazırlık: v2 durumu", !e && (await snap()) === V2_SNAP, e && e.message);
  await db.exec(`comment on policy "media anon insert" on storage.objects is null`);
  e = await errOf(() => db.exec(postBlock));
  ok("neg: v2 + açıklama eksik -> UP POST guard S2_POST_FAIL (açıklama)", e && /S2_POST_FAIL: etkisizleştirme açıklaması/.test(e.message), e && e.message);
  await db.exec(UP);
  ok("neg: S2_up açıklamayı yeniden yazar -> v2 snapshot", (await snap()) === V2_SNAP);
  const downPost = (DOWN.match(/do \$s2_down_post\$[\s\S]*?\$s2_down_post\$;/) || [])[0];
  e = await errOf(() => db.exec(downPost));
  ok("neg: DOWN POST guard v2 durumunda S2_DOWN_POST_FAIL verir", downPost && e && /S2_DOWN_POST_FAIL/.test(e.message), e && e.message);
  e = await errOf(() => db.exec(ARM_DOWN + DOWN + INJ));
  ok("neg: down(armed) gövdesi de atomik (v2 durumu korunur)", e && /S2_TEST_INJECTED_FAILURE/.test(e.message) && (await snap()) === V2_SNAP, e && e.message);

  // ---- son durum: UP uygulanmış
  e = await errOf(() => db.exec(UP));
  ok("final: up uygulanmış durumda bitir", !e && (await snap()) === V2_SNAP, e && e.message);
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
