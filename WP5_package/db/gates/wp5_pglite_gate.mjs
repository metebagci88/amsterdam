// =====================================================================
// ASALOCAL · WP5 (İŞ PAKETİ 5) · gates/wp5_pglite_gate.mjs
// Gerçek Postgres (PGlite/WASM; 0.3.16 = PG17, 0.5.x = PG18) üzerinde WP5 DB paketinin yerel kapısı.
// Production'a / ağa DOKUNMAZ; ücretli kaynak yok; secret okumaz.
//
//   PGLITE_DIR=<@electric-sql/pglite kurulu dizin> node gates/wp5_pglite_gate.mjs
//
// Model: gates/wp5_fixture_baseline.sql (production'ın 2026-10-07 read-only ölçümüne dayalı birebir
// members modeli; guard/upsert/complete_profile gövdeleri kopya ve md5'leri production literaliyle
// eşleşir). auth.uid()/auth.jwt()/auth.role() GUC 'request.jwt.claims' ile; roller anon /
// authenticated / service_role(BYPASSRLS) gerçek SET ROLE ile.
// Kapsam: statik (MCP /drop/i, gövde diff'i, salt-okunur assert'ler), fixture sadakati (pre_assert
// production kanıtıyla birebir), red-before-green, up x2 (idempotent), CHECK kabul/ret matrisi,
// member_set_name (kendi satırı / anon / sub'sız / satırsız / normalizasyon / audit yok), e-posta
// kilidi (PATCH, INSERT, JWT senkronu, service_role, trusted), member_upsert_profile + complete_profile
// baseline ile davranış eşdeğerliği, view'lar isim açmaz, prod_assert + zero-footprint (iz yok),
// drift negatifleri, atomiklik, down (silahsız ret, silahlı birebir baseline + guard md5), yeniden up.
// Ön-mevcut bulgu (WP5 kapsamı DIŞI; FAIL sayılmaz): member_public üzerinden RLS'siz DML.
// Sentinel: WP5_LOCAL_PGLITE_GATE_PASS
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

const UP = rd("WP5_DB_up.sql");
const DOWN = rd("WP5_DB_down.sql");
const FIX = rd("gates/wp5_fixture_baseline.sql");
const PRE = rd("gates/wp5_pre_assert.sql");
const PROD = rd("gates/wp5_prod_assert.sql");
const ZF = rd("gates/wp5_zero_footprint_test.sql");
const EVID = JSON.parse(rd("evidence/wp5_pre_assert_prod_readonly_2026-10-07.json"));

const ARM_LINE_OFF = "-- set local wp5.down_confirm = 'DELETE_PRIVATE_NAMES';";
const ARM_LINE_ON = "set local wp5.down_confirm = 'DELETE_PRIVATE_NAMES';";
const DOWN_ARMED = DOWN.replace(ARM_LINE_OFF, ARM_LINE_ON);

// production 2026-10-07 read-only literalleri
const PROD_GUARD_SRC = "9bba990aa5a30cd94c93f7609babb7d2";
const PROD_GUARD_DEF = "48bd6e33c6becde922a033d6093a81b5";
const PROD_UPSERT_SRC = "ef472f2ed6dd8398be7c3ed54007ec8a";
const PROD_UPSERT_DEF = "441e150eed40b50b5c0fcd5c26f47fc7";
const PROD_COMPLETE_SRC = "631b3b67ae91b914c377684724e65f59";
const PROD_COMPLETE_DEF = "0678ab70409b74d002ff0f3a4c6abf56";
// WP5 literalleri
const WP5_GUARD_SRC = "ef160b239cd9dc207a7f78313b0a3242";
const WP5_SETNAME_SRC = "993b6a358e3ed58f478af75853d4e7fe";

const TOKEN = "dr" + "op";
const cp = (...c) => String.fromCodePoint(...c);
const em = (tag) => tag + "@" + "example.invalid";

let pass = 0, fail = 0;
const log = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; log.push("PASS " + name); }
  else { fail++; log.push("FAIL " + name + (detail ? " :: " + String(detail).slice(0, 600) : "")); }
};
const finding = (name, detail) => log.push("FINDING(pre-existing, not counted) " + name + (detail ? " :: " + detail : ""));

// ---------------------------------------------------------------- statik
function stripComments(sql) { return sql.replace(/--[^\n]*/g, ""); }
function stripLiterals(sql) {
  return stripComments(sql).replace(/\$([a-z0-9_]*)\$[\s\S]*?\$\1\$/gi, "$$$$").replace(/'(?:[^']|'')*'/g, "''");
}
function stripSQ(sql) { return stripComments(sql).replace(/'(?:[^']|'')*'/g, "''"); }
function fnBlock(sql, name) {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (i < 0) return null;
  const j = sql.indexOf("$function$\n;", i);
  return j < 0 ? null : sql.slice(i, j + "$function$\n;".length);
}
const WP5_ADDED = [
  "    -- WP5: client INSERT email = verified JWT email claim (same value member_upsert_profile inserts)",
  "    NEW.email:=(auth.jwt()->>'email');",
  "    -- WP5: client UPDATE may only sync email to its own verified JWT email claim; anything else is pinned to OLD",
  "    IF NEW.email IS DISTINCT FROM (auth.jwt()->>'email') THEN NEW.email:=OLD.email; END IF;",
];
{
  for (const [n, s] of [["WP5_DB_up.sql", UP], ["wp5_pre_assert.sql", PRE], ["wp5_prod_assert.sql", PROD], ["wp5_zero_footprint_test.sql", ZF]]) {
    const hits = s.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => l.toLowerCase().includes(TOKEN)).map(([i]) => i);
    ok(`static(MCP): ${n} /${TOKEN}/i içermiyor`, hits.length === 0, "satır " + hits.join(","));
  }
  ok("static: DOWN DROP içerir + OWNER-RUN / MCP'ye gönderilmez etiketi", DOWN.toLowerCase().includes(TOKEN) &&
     DOWN.includes("OWNER-RUN ROLLBACK") && DOWN.includes("SUPABASE MCP (apply_migration/execute_sql) İLE GÖNDERİLMEZ"));
  ok("static: DOWN arming satırı varsayılan olarak yorumda (tek)", DOWN.split(ARM_LINE_OFF).length === 2 && !/^set local wp5\.down_confirm/m.test(DOWN));
  ok("static: DOWN kendi begin/commit'ini içerir", /^begin;$/m.test(DOWN) && /^commit;$/m.test(DOWN));

  const up = stripComments(UP);
  const upNL = stripSQ(UP);   // DO/fonksiyon gövdeleri DAHİL taranır; yalnız yorum + string literalleri çıkarılır
  ok("static: UP dış begin/commit/rollback yok (dollar-quote gövdeleri dışında)", !/^\s*(begin|commit|rollback|start\s+transaction|end)\s*;/im.test(stripLiterals(UP)));
  ok("static: UP set local lock_timeout = '5s' (ilk ifade)", /^\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i.test(up.replace(/^\s+/, "")));
  ok("static: UP policy/view/tablo-grant/rol/RLS değişikliği yok",
     !/\b(create|alter)\s+policy\b|\bcreate\s+(or\s+replace\s+)?view\b|\balter\s+view\b|\bgrant\b[^;]*\bon\s+(table\s+)?public\.members\b|\brevoke\b[^;]*\bon\s+(table\s+)?public\.members\b|\bset\s+(local\s+)?role\b|row\s+level\s+security|\btruncate\b|\balter\s+role\b/i.test(upNL));
  ok("static: UP veri yazımı yok (insert/delete yok; tek UPDATE member_set_name gövdesinde)",
     !/\binsert\s+into\b|\bdelete\s+from\b/i.test(stripComments(UP)) && (stripComments(UP).match(/\bupdate\s+public\.members\b/gi) || []).length === 1 &&
     /\$wp5_set_name\$[\s\S]*update public\.members m[\s\S]*\$wp5_set_name\$;/.test(UP));
  const fns = [...UP.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_]+)\(/gi)].map((m) => m[1]).sort();
  ok("static: UP tam 2 fonksiyon (guard_member_admin_fields, member_set_name); upsert/complete_profile/admin RPC yok",
     JSON.stringify(fns) === JSON.stringify(["guard_member_admin_fields", "member_set_name"]) && !/\balter\s+function\b/i.test(upNL), fns.join(","));
  const baseG = fnBlock(FIX, "guard_member_admin_fields"), upG = fnBlock(UP, "guard_member_admin_fields"), dnG = fnBlock(DOWN, "guard_member_admin_fields");
  ok("static: DOWN guard metni = production kopyası (fixture) birebir", !!baseG && baseG === dnG);
  const bl = (baseG || "").split("\n"), ul = (upG || "").split("\n");
  const added = ul.filter((l) => !bl.includes(l));
  const ulMinus = ul.filter((l) => !WP5_ADDED.includes(l));
  ok("static: UP guard = production gövdesi + YALNIZ 4 WP5 satırı (2 yorum + 2 e-posta ifadesi); diğer her satır birebir ve aynı sırada",
     !!upG && JSON.stringify(ulMinus) === JSON.stringify(bl) && JSON.stringify(added) === JSON.stringify(WP5_ADDED), JSON.stringify(added));
  const sn = (UP.match(/create or replace function public\.member_set_name[\s\S]*?\$wp5_set_name\$;/) || [""])[0];
  ok("static: member_set_name SECURITY INVOKER + search_path sabit + jsonb",
     /\n security invoker\n/.test(sn) && /\n set search_path to 'pg_catalog', 'pg_temp'\n/.test(sn) && /\n returns jsonb\n/.test(sn));
  ok("static: member_set_name REVOKE public/anon/service_role + GRANT yalnız authenticated",
     /revoke all on function public\.member_set_name\(text, text\) from public, anon, service_role;/.test(UP) &&
     /grant execute on function public\.member_set_name\(text, text\) to authenticated;/.test(UP) &&
     (UP.match(/grant execute on function public\.member_set_name/g) || []).length === 1);
  ok("static: member_set_name audit/log tablosuna yazmaz", !/insert/i.test(stripComments(sn)));
  const ck = (c) => (UP.match(new RegExp(`add constraint members_${c}_wp5_policy check \\(([\\s\\S]*?)\\n    \\);`)) || [])[1];
  ok("static: iki CHECK ifadesi kolon adı dışında birebir aynı",
     !!ck("first_name") && ck("first_name").replaceAll("first_name", "X") === ck("last_name").replaceAll("last_name", "X"));
  ok("static: CHECK locale sınıfı kullanmaz ([[:alpha:]] vb. yok; yalnız kod noktası aralıkları)", !/\[\[:/.test(ck("first_name") || "[[:"));
  ok("static: UP'ta \\u kaçışı yok (araç dönüşümüne karşı; \\x kullanılır)", !/\\u[0-9a-f]{4}/i.test(UP));
  for (const [n, s] of [["wp5_pre_assert", PRE], ["wp5_prod_assert", PROD]]) {
    const t = stripLiterals(s);
    ok(`static: ${n} salt-okunur (tek WITH/SELECT)`,
       /^\s*with\b/i.test(t) && !/\b(insert|update|delete|create|alter|grant|revoke|truncate|copy|call|perform|set_config|do|comment)\b|\bset\s/i.test(t) &&
       (t.match(/;/g) || []).length === 1);
  }
  const zf = stripComments(ZF);
  ok("static: ZF tek DO bloğu + REPORT raise ile biter, commit yok",
     /^\s*do \$wp5zf\$/i.test(zf) && /raise exception using message = 'REPORT:' \|\| rep, errcode = 'P0001';\s*end\s*\$wp5zf\$;\s*$/i.test(zf) && !/\bcommit\b/i.test(zf));
  const emailLit = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
  const files = { UP, DOWN, FIX, PRE, PROD, ZF, GATE: readFileSync(fileURLToPath(import.meta.url), "utf8") };
  const withEmail = Object.entries(files).filter(([, s]) => emailLit.test(s)).map(([k]) => k);
  ok("static: paket dosyalarında e-posta literali yok (sentetik adresler çalışma anında birleştirilir)", withEmail.length === 0, withEmail.join(","));
}

// ---------------------------------------------------------------- DB yardımcıları
const PGlite = await loadPGlite();
async function errOf(fn) { try { await fn(); return null; } catch (e) { return { code: e.code, message: String(e.message || e) }; } }

const U = {
  A: "00000000-0000-4000-8000-00000000000a",
  B: "00000000-0000-4000-8000-00000000000b",
  C: "00000000-0000-4000-8000-00000000000c",
  D: "00000000-0000-4000-8000-00000000000d",
};
const E = { A: em("wp5-gate-a"), A2: em("wp5-gate-a2"), B: em("wp5-gate-b"), C: em("wp5-gate-c"), D: em("wp5-gate-d"), EVIL: em("wp5-gate-evil"), SVC: em("wp5-gate-svc") };
const claims = (k, email = E[k]) => ({ sub: U[k], role: "authenticated", email });

async function fresh() {
  const db = await new PGlite();
  await db.exec(FIX);
  await db.query(`insert into auth.users(id, email, aud, role) values ($1,$2,'authenticated','authenticated'),($3,$4,'authenticated','authenticated'),
                  ($5,$6,'authenticated','authenticated'),($7,$8,'authenticated','authenticated')`,
                 [U.A, E.A, U.B, E.B, U.C, E.C, U.D, E.D]);
  await db.exec("begin");
  await db.query("select set_config('asalocal.trusted','1',true)");
  await db.query(`insert into public.members(email, user_id, display_name, home_city, gender) values ($1,$2,'Ali','Amsterdam',null),($3,$4,'Berk','Kopenhag','m')`,
                 [E.A, U.A, E.B, U.B]);
  await db.exec("commit");
  return db;
}
const q = async (db, sql, p) => (await db.query(sql, p)).rows;
async function applyUp(db, sql = UP) {
  try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
  catch (e) { await db.exec("rollback").catch(() => {}); return { code: e.code, message: String(e.message || e) }; }
}
async function runDown(db, sql) {
  try { await db.exec(sql); return null; }
  catch (e) { await db.exec("rollback").catch(() => {}); return { code: e.code, message: String(e.message || e) }; }
}
// tek transaction; her ifade savepoint ile (hata transaction'ı bozmaz); sonunda ROLLBACK (iz yok) veya COMMIT
async function tx(db, fn, { commit = false } = {}) {
  await db.exec("begin");
  const t = {
    as: async (c, role = "authenticated") => { await db.query("select set_config('request.jwt.claims', $1, true)", [c ? JSON.stringify(c) : ""]); await db.exec(`set local role ${role}`); },
    su: async () => { await db.exec("reset role"); await db.query("select set_config('request.jwt.claims', '', true)"); },
    run: async (sql, p) => {
      await db.exec("savepoint wp5_sp");
      try { const r = await db.query(sql, p); await db.exec("release savepoint wp5_sp"); return { ok: true, rows: r.rows, n: r.affectedRows ?? 0 }; }
      catch (e) { await db.exec("rollback to savepoint wp5_sp"); return { ok: false, code: e.code, message: String(e.message || e) }; }
    },
  };
  try { const r = await fn(t); await db.exec(commit ? "commit" : "rollback"); return r; }
  catch (e) { await db.exec("rollback").catch(() => {}); throw e; }
}
const rowOf = async (db, k) => (await q(db, "select * from public.members where user_id = $1", [U[k]]))[0];
const strip = (r, ...keys) => { if (!r) return r; const o = { ...r }; for (const k of keys) delete o[k]; return o; };

// katalog snapshot (search_path'ten bağımsız; dropped kolonlar hariç)
const CAT_SNAP = `select md5(concat_ws('#',
  (select string_agg(column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'<null>')||':'||coalesce(col_description('public.members'::regclass, ordinal_position::int),'<nc>'), ',' order by column_name)
     from information_schema.columns where table_schema='public' and table_name='members'),
  (select coalesce(string_agg(conname||':'||pg_get_constraintdef(oid)||':'||convalidated::text||':'||coalesce(obj_description(oid,'pg_constraint'),'<nc>'), ',' order by conname),'<none>') from pg_constraint where conrelid='public.members'::regclass),
  (select string_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):'||md5(p.prosrc)||':'||p.prosecdef::text||':'||coalesce(array_to_string(p.proconfig,';'),'')||':'||coalesce(p.proacl::text,'')||':'||coalesce(obj_description(p.oid,'pg_proc'),'<nc>'), ',' order by p.proname, pg_get_function_identity_arguments(p.oid))
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth')),
  (select string_agg(policyname||cmd||roles::text||coalesce(qual,'')||coalesce(with_check,''), ',' order by policyname) from pg_policies where schemaname='public'),
  (select string_agg(tgname||':'||pg_get_triggerdef(oid), ',' order by tgname) from pg_trigger where not tgisinternal),
  (select string_agg(c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text||c.relforcerowsecurity::text||':'||coalesce(array_to_string(c.reloptions,','),''), ',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth') and c.relkind in ('r','v')),
  (select string_agg(c.relname||':'||pg_get_viewdef(c.oid), ',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v'),
  (select string_agg(a.attrelid::regclass::text||'.'||a.attname, ',' order by a.attrelid::regclass::text, a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' and a.attnum>0)
)) m`;
const DATA_SNAP = `select md5(concat_ws('#',
  (select string_agg((to_jsonb(m) - 'updated_at' - 'first_name' - 'last_name')::text, ',' order by email) from public.members m),
  (select string_agg(user_id::text, ',' order by user_id) from public.member_ref),
  (select string_agg(id::text||':'||coalesce(email,''), ',' order by id) from auth.users),
  (select count(*)::text from public.point_events),
  (select count(*)::text from supabase_migrations.schema_migrations)
)) m`;
const FULL_DATA_SNAP = DATA_SNAP.replace("(to_jsonb(m) - 'updated_at' - 'first_name' - 'last_name')", "to_jsonb(m)");
const catSnap = async (db) => (await q(db, CAT_SNAP))[0].m;
const dataSnap = async (db) => (await q(db, DATA_SNAP))[0].m;
const fullSnap = async (db) => (await q(db, CAT_SNAP))[0].m + "/" + (await q(db, FULL_DATA_SNAP))[0].m;
const otherTablesSnap = async (db) => {
  const ts = await q(db, `select c.oid::regclass::text t from pg_class c join pg_namespace s on s.oid=c.relnamespace
                           where s.nspname in ('public','auth','supabase_migrations') and c.relkind='r' and c.relname <> 'members' order by 1`);
  const out = [];
  for (const { t } of ts) out.push(t + "=" + (await q(db, `select count(*)::int n from ${t}`))[0].n);
  return out.join(",");
};

async function assertRows(db, sql) {
  const r = await q(db, sql);
  const overall = r.find((x) => x.check_name === "OVERALL");
  const bad = r.filter((x) => x.result === "FAIL").map((x) => `${x.ord}:${x.check_name}=${x.actual}`);
  return { overall: overall && overall.result, summary: overall && overall.actual, bad, rows: r };
}
async function runZF(db) {
  const e = await errOf(() => db.exec(ZF));
  const msg = e ? e.message : "<no error: ZF must always raise REPORT>";
  const m = /WP5_ZF_VERDICT=(\w+) fails=(\d+)/.exec(msg);
  return { msg, verdict: m ? m[1] : "NONE", fails: m ? Number(m[2]) : -1, isReport: !!e && msg.startsWith("REPORT:") };
}

// isim politikası test vektörleri
const ACCEPT = ["Ayşe", "Çağrı", "O'Neil", "Jean-Luc", "İlkay Nur", "O" + cp(0x2019) + "Neil", "Ğülşen", "Øyvind", "José María", "J. R.",
  "Nguyễn", "Αλέξανδρος", "Владимир", "محمد", "李小龍", "a".repeat(50), "Jean" + cp(0x2010) + "Luc", "Zoë"];
const REJECT = [["<script>", "<script>"], ["  a", "lead-space"], ["a  ", "trail-space"], ["", "empty"], ["a".repeat(51), "51chars"],
  ["a" + cp(1) + "b", "ctl-01"], ["a\tb", "tab"], ["a\nb", "newline"], ["a" + cp(0x7f) + "b", "DEL"], ["a" + cp(0x85) + "b", "C1-NEL"],
  ["{", "{"], ["a{b}", "{}"], ['"', '"'], ['a"b', 'quote'], ["a<b", "<"], ["a>b", ">"], ["a&b", "&"], ["a\\b", "backslash"], ["a`b", "backtick"],
  ["Ali2", "digit"], ["-Ali", "lead-hyphen"], ["Ali-", "trail-hyphen"], ["'Ali", "lead-apos"], ["a  b", "double-space"], ["a--b", "double-sep"],
  ["a" + cp(0x200b) + "b", "ZWSP"], ["a" + cp(0x202e) + "b", "RLO"], ["a" + cp(0xa0) + "b", "NBSP"], ["a" + cp(0xfeff) + "b", "BOM"],
  [cp(0x1f600), "emoji"], ["a" + cp(0xe0041), "tag-char"], ["C" + cp(0x327) + "a", "non-NFC"], [cp(0x301) + "a", "lead-combining"],
  [cp(0xff21, 0xff22), "fullwidth"], ["a" + cp(0x2014) + "b", "em-dash"], ["a" + cp(0xab) + "b", "guillemet"], [cp(0x1d400), "math-bold"]];

try {
  // ============================================================ 1) fixture sadakati
  let db = await fresh();
  const version = (await q(db, "select version() v"))[0].v.split(" on ")[0];
  log.push("-- engine: " + version);
  let fx = await q(db, `select p.proname, md5(p.prosrc) s, md5(pg_get_functiondef(p.oid)) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where n.nspname='public' and p.proname in ('guard_member_admin_fields','member_upsert_profile','complete_profile') order by 1`);
  const fxm = Object.fromEntries(fx.map((r) => [r.proname, r.s + "/" + r.d]));
  ok("fixture: guard md5(prosrc)+md5(functiondef) = production", fxm.guard_member_admin_fields === `${PROD_GUARD_SRC}/${PROD_GUARD_DEF}`, fxm.guard_member_admin_fields);
  ok("fixture: member_upsert_profile md5'leri = production", fxm.member_upsert_profile === `${PROD_UPSERT_SRC}/${PROD_UPSERT_DEF}`, fxm.member_upsert_profile);
  ok("fixture: complete_profile md5'leri = production", fxm.complete_profile === `${PROD_COMPLETE_SRC}/${PROD_COMPLETE_DEF}`, fxm.complete_profile);
  let a = await assertRows(db, PRE);
  ok("fixture: wp5_pre_assert -> WP5_PRE_ASSERT_PASS (0 FAIL / 20 counted)", a.overall === "WP5_PRE_ASSERT_PASS" && a.summary === "0 FAIL / 20 counted", a.bad.join(" | "));
  const evid = Object.fromEntries(EVID.rows.filter((r) => r.result === "PASS").map((r) => [r.ord, r.actual]));
  const diffs = a.rows.filter((r) => r.result === "PASS" && evid[r.ord] !== r.actual).map((r) => r.ord);
  ok("fixture: pre_assert counted satırlarının actual değerleri production kanıtıyla birebir (20/20)",
     Object.keys(evid).length === 20 && diffs.length === 0 && a.rows.filter((r) => r.result === "PASS").length === 20, "fark: " + diffs.join(","));
  const BASE_CAT = await catSnap(db);
  const BASE_DATA = await dataSnap(db);
  const BASE_OTHER = await otherTablesSnap(db);

  // ============================================================ 2) red-before-green (baseline'da açık var)
  let r = await tx(db, async (t) => { await t.as(claims("A")); const u = await t.run("update public.members set email = $1 where user_id = $2", [E.EVIL, U.A]); await t.su(); return { u, row: await rowOf(db, "A") }; });
  ok("baseline (açık kanıtı): sahip doğrudan PATCH ile members.email'i değiştirebiliyor", r.u.ok && r.u.n === 1 && r.row.email === E.EVIL, JSON.stringify(r.u));
  let z = await runZF(db);
  ok("baseline: zero-footprint testi açığı yakalar (VERDICT=FAIL) ve REPORT ile biter", z.isReport && z.verdict === "FAIL" && /FAIL A\.patch_email_other changed/.test(z.msg) && /FAIL A\.set_name/.test(z.msg), z.msg);
  log.push("-- zf report (baseline, red-before-green): " + z.msg);
  ok("baseline: ZF iz bırakmadı (katalog + veri + diğer tablolar)", (await catSnap(db)) === BASE_CAT && (await dataSnap(db)) === BASE_DATA && (await otherTablesSnap(db)) === BASE_OTHER);

  // baseline davranış kaydı (upsert + complete_profile) — WP5 sonrası birebir karşılaştırılacak
  async function behaviourScenario(d) {
    return tx(d, async (t) => {
      const out = {};
      const r1 = async (sql) => { const x = await t.run(sql); return x.ok ? x.rows[0].r : "ERR " + x.code; };
      await t.as(claims("D"));
      out.d_insert = await r1("select public.member_upsert_profile('Dora', null, 'Amsterdam', 'f') r");
      out.d_update = await r1("select public.member_upsert_profile(null, 'bio-1', null, null) r");
      await t.as(claims("A"));
      out.a_update = await r1("select public.member_upsert_profile('Ali2', null, null, null) r");
      await t.as(claims("A", E.A2));
      out.a_jwt_sync = await r1("select public.member_upsert_profile(null, null, null, null) r");
      await t.as({ sub: U.C, role: "authenticated" });
      out.c_no_email_claim = await r1("select public.member_upsert_profile('C', null, null, null) r");
      await t.as({ role: "authenticated" });
      out.no_sub = await r1("select public.member_upsert_profile('X', null, null, null) r");
      await t.as(claims("A", E.A2));
      out.a_incomplete = await r1("select public.complete_profile() r");
      out.a_gender = await r1("select public.member_upsert_profile(null, null, null, 'm') r");
      out.a_complete = await r1("select public.complete_profile() r");   // son: _recompute_points trusted GUC'u açar
      await t.su();
      const rows = (await q(d, "select * from public.members order by user_id")).map((x) => strip(x, "updated_at", "created_at", "first_name", "last_name"));
      const pts = await q(d, "select beneficiary_user_id, event_type, points from public.point_events order by id");
      return JSON.stringify({ out, rows, pts });
    });
  }
  const BASE_BEHAVIOUR = await behaviourScenario(db);

  // ============================================================ 3) UP x2 (idempotent)
  let e = await applyUp(db);
  ok("up#1: uygulandı (PRE baseline -> POST OK)", !e, e && e.message);
  const CAT1 = await catSnap(db), FULL1 = await fullSnap(db);
  e = await applyUp(db);
  ok("up#2: idempotent (PRE applied kabul) ve durum birebir aynı", !e && (await fullSnap(db)) === FULL1, e && e.message);
  ok("up: veri değişmedi (isim dışı tüm members alanları + diğer tablolar)", (await dataSnap(db)) === BASE_DATA && (await otherTablesSnap(db)) === BASE_OTHER);
  let rows = await q(db, "select count(*)::int n, count(first_name)::int f, count(last_name)::int l from public.members");
  ok("up: mevcut satırlarda first_name/last_name NULL (backfill yok)", rows[0].n === 2 && rows[0].f === 0 && rows[0].l === 0, JSON.stringify(rows));
  rows = await q(db, `select md5(prosrc) s from pg_proc where oid='public.guard_member_admin_fields()'::regprocedure
                      union all select md5(prosrc) from pg_proc where oid='public.member_set_name(text,text)'::regprocedure`);
  ok("up: guard ve member_set_name md5 = WP5 literalleri", rows[0].s === WP5_GUARD_SRC && rows[1].s === WP5_SETNAME_SRC, JSON.stringify(rows));
  rows = await q(db, `select has_function_privilege('anon','public.member_set_name(text,text)','EXECUTE') a,
                             has_function_privilege('authenticated','public.member_set_name(text,text)','EXECUTE') u,
                             has_function_privilege('service_role','public.member_set_name(text,text)','EXECUTE') s,
                             (select proacl::text from pg_proc where oid='public.member_set_name(text,text)'::regprocedure) acl`);
  ok("up: member_set_name EXECUTE yalnız authenticated (Supabase varsayılan anon/service_role EXECUTE geri alındı)",
     rows[0].a === false && rows[0].u === true && rows[0].s === false && rows[0].acl === "{postgres=X/postgres,authenticated=X/postgres}", JSON.stringify(rows));

  // ============================================================ 4) CHECK kabul/ret matrisi (sahip, doğrudan PATCH)
  for (const col of ["first_name", "last_name"]) {
    const res = await tx(db, async (t) => {
      await t.as(claims("A"));
      const acc = [], rej = [];
      for (const v of ACCEPT) { const x = await t.run(`update public.members set ${col} = $1 where user_id = $2`, [v, U.A]); if (!(x.ok && x.n === 1)) acc.push(JSON.stringify(v) + ":" + (x.code || x.n)); }
      for (const [v, n] of REJECT) { const x = await t.run(`update public.members set ${col} = $1 where user_id = $2`, [v, U.A]); if (!(!x.ok && x.code === "23514" && x.message.includes(`members_${col}_wp5_policy`))) rej.push(n + ":" + (x.code || "ACCEPTED")); }
      const nul = await t.run(`update public.members set ${col} = null where user_id = $1`, [U.A]);
      return { acc, rej, nul: nul.ok && nul.n === 1 };
    });
    ok(`check(${col}): ${ACCEPT.length} geçerli isim kabul (Ayşe, Çağrı, O'Neil, O’Neil, Jean-Luc, İlkay Nur, ...)`, res.acc.length === 0, res.acc.join(" | "));
    ok(`check(${col}): ${REJECT.length} geçersiz değer 23514 ile ret (<script>, '  a', 'a  ', '', 51, kontrol, '{', '"', ...)`, res.rej.length === 0, res.rej.join(" | "));
    ok(`check(${col}): NULL (girilmedi) izinli`, res.nul);
  }

  // ============================================================ 5) member_set_name
  const BEFORE_B = await rowOf(db, "B");
  const OTHER0 = await otherTablesSnap(db);
  r = await tx(db, async (t) => {
    await t.as(claims("A"));
    const s1 = (await t.run("select public.member_set_name($1, $2) r", ["  Ayşe  ", "Yılmaz"])).rows[0].r;
    await t.su();
    return { s1, row: await rowOf(db, "A") };
  }, { commit: true });
  ok("set_name: sahip -> {ok:true}; trim uygulanır; e-posta/tier/points/blocked/user_id değişmez",
     JSON.stringify(r.s1) === '{"ok":true}' && r.row.first_name === "Ayşe" && r.row.last_name === "Yılmaz" && r.row.email === E.A &&
     r.row.tier === "Kaşif" && r.row.points === 0 && r.row.blocked === false && r.row.user_id === U.A, JSON.stringify(r));
  ok("set_name: başka kullanıcının satırı (B) birebir aynı", JSON.stringify(await rowOf(db, "B")) === JSON.stringify(BEFORE_B));
  ok("set_name: audit/log/başka tablo satırı yazılmadı (PII çoğaltılmadı)", (await otherTablesSnap(db)) === OTHER0);
  r = await tx(db, async (t) => {
    await t.as(claims("A"));
    const o = {};
    o.nfc = (await t.run("select public.member_set_name($1, $2) r", ["C" + cp(0x327) + "ağrı", "İlkay" + cp(0xa0) + "\t Nur"])).rows[0].r;
    await t.su(); o.row = await rowOf(db, "A"); await t.as(claims("A"));
    const cases = [["<script>", "X", "bad_first"], ["X", "<b>", "bad_last"], ["<a>", "<b>", "bad_first"], ["", "X", "bad_first"], [null, "X", "bad_first"],
      ["   ", "X", "bad_first"], ["X", "", "bad_last"], ["X", null, "bad_last"], ["a".repeat(51), "X", "bad_first"], ["X", "b".repeat(51), "bad_last"],
      ["a".repeat(201), "X", "bad_first"], ["a" + cp(1) + "b", "X", "bad_first"], ["{x}", "X", "bad_first"], ['a"b', "X", "bad_first"],
      ["X", "a" + cp(0x200b) + "b", "bad_last"], ["Al1", "X", "bad_first"], ["a".repeat(50), "b".repeat(50), "ok"]];
    o.bad = [];
    for (const [f, l, exp] of cases) {
      const x = await t.run("select public.member_set_name($1, $2) r", [f, l]);
      const got = x.ok ? (x.rows[0].r.ok ? "ok" : x.rows[0].r.reason) : "ERR " + x.code;
      if (got !== exp) o.bad.push(`${JSON.stringify(f)?.slice(0, 20)}/${JSON.stringify(l)?.slice(0, 20)} got=${got} exp=${exp}`);
    }
    await t.su(); o.after = await rowOf(db, "A");
    return o;
  });
  ok("set_name: NFC + boşluk normalizasyonu (C+U+0327 -> Ç; NBSP/TAB dizisi -> tek boşluk)",
     JSON.stringify(r.nfc) === '{"ok":true}' && r.row.first_name === "Çağrı" && r.row.last_name === "İlkay Nur", JSON.stringify(r.row));
  ok("set_name: ret nedenleri (bad_first/bad_last; ikisi de geçersizse bad_first; boş/NULL/51/201/kontrol/HTML)", r.bad.length === 0, r.bad.join(" | "));
  r = await tx(db, async (t) => {
    const o = {};
    await t.as({ role: "anon" }, "anon"); o.anon = await t.run("select public.member_set_name('Ayşe','Kaya') r");
    await t.as({ role: "authenticated" }); o.nosub = await t.run("select public.member_set_name('Ayşe','Kaya') r");
    await t.as(claims("C")); o.norow = await t.run("select public.member_set_name('Can','Demir') r");
    await t.as({ role: "service_role" }, "service_role"); o.svc = await t.run("select public.member_set_name('Ayşe','Kaya') r");
    await t.su(); o.c = await q(db, "select count(*)::int n from public.members where user_id = $1", [U.C]);
    return o;
  });
  ok("set_name: anon -> 42501 permission denied (EXECUTE yok)", !r.anon.ok && r.anon.code === "42501", JSON.stringify(r.anon));
  ok("set_name: sub'sız authenticated -> no_auth", r.nosub.ok && r.nosub.rows[0].r.reason === "no_auth", JSON.stringify(r.nosub));
  ok("set_name: satırı olmayan kullanıcı -> no_member_row (satır oluşturmaz)", r.norow.ok && r.norow.rows[0].r.reason === "no_member_row" && r.c[0].n === 0, JSON.stringify(r.norow));
  ok("set_name: service_role EXECUTE yok (42501; gereksiz yetki verilmedi)", !r.svc.ok && r.svc.code === "42501", JSON.stringify(r.svc));
  r = await tx(db, async (t) => {
    await t.as(claims("A"));
    const u = await t.run("update public.members set first_name = 'Hacked', last_name = 'X', email = $1, display_name = 'x' where user_id = $2", [E.EVIL, U.B]);
    await t.su(); return { u, b: await rowOf(db, "B") };
  });
  ok("rls: A, B'nin satırını doğrudan güncelleyemez (0 satır; B aynı)", r.u.ok && r.u.n === 0 && JSON.stringify(r.b) === JSON.stringify(BEFORE_B), JSON.stringify(r.u));

  // ============================================================ 6) e-posta kilidi
  r = await tx(db, async (t) => {
    const o = {};
    await t.as(claims("A"));
    o.patch = await t.run("update public.members set email = $1, display_name = 'Ali-new' where user_id = $2", [E.EVIL, U.A]);
    await t.su(); o.row1 = await rowOf(db, "A");
    await t.as(claims("A", E.A2));
    o.patch2 = await t.run("update public.members set email = $1 where user_id = $2", [E.EVIL, U.A]);
    await t.su(); o.row2 = await rowOf(db, "A");
    await t.as(claims("A", E.A2));
    o.sync = await t.run("update public.members set email = $1 where user_id = $2", [E.A2, U.A]);
    await t.su(); o.row3 = await rowOf(db, "A");
    await t.as(claims("C"));
    o.ins = await t.run("insert into public.members(email, user_id, display_name, tier, points, blocked) values ($1, $2, 'Can', 'Insider', 999, true)", [E.EVIL, U.C]);
    await t.su(); o.rowC = await rowOf(db, "C");
    await t.as({ sub: U.D, role: "authenticated" });
    o.insNoClaim = await t.run("insert into public.members(email, user_id) values ($1, $2)", [E.EVIL, U.D]);
    await t.as({ role: "service_role" }, "service_role");
    o.svc = await t.run("update public.members set email = $1 where user_id = $2", [E.SVC, U.B]);
    await t.su(); o.rowB = await rowOf(db, "B");
    await db.query("select set_config('asalocal.trusted','1',true)");
    o.trusted = await t.run("update public.members set email = $1 where user_id = $2", [E.EVIL, U.B]);
    await db.query("select set_config('asalocal.trusted','',true)");
    o.rowB2 = await rowOf(db, "B");
    return o;
  });
  ok("email: sahip doğrudan PATCH email -> satır güncellenir, e-posta DEĞİŞMEZ (display_name değişir)",
     r.patch.ok && r.patch.n === 1 && r.row1.email === E.A && r.row1.display_name === "Ali-new", JSON.stringify(r.row1));
  ok("email: JWT e-postası değişmişken başka değere PATCH -> yine OLD'a sabit", r.patch2.ok && r.row2.email === E.A, r.row2.email);
  ok("email: kendi doğrulanmış JWT e-postasına eşitleme izinli (member_upsert_profile semantiği)", r.sync.ok && r.row3.email === E.A2, r.row3.email);
  ok("email: yeni kullanıcı sahte e-posta + admin alanlarıyla INSERT -> email=JWT, tier/points/blocked sabit",
     r.ins.ok && r.rowC.email === E.C && r.rowC.tier === "Kaşif" && r.rowC.points === 0 && r.rowC.blocked === false, JSON.stringify(r.rowC));
  ok("email: JWT'de email claim'i yoksa client INSERT 23502 (sahte e-posta yazılamaz; bilinçli)", !r.insNoClaim.ok && r.insNoClaim.code === "23502", JSON.stringify(r.insNoClaim));
  ok("email: service_role e-postayı değiştirebilir (admin/Edge yolu değişmedi)", r.svc.ok && r.svc.n === 1 && r.rowB.email === E.SVC, JSON.stringify(r.svc));
  ok("email: trusted GUC yolu (asalocal.trusted=1) değişmedi", r.trusted.ok && r.rowB2.email === E.EVIL, JSON.stringify(r.trusted));

  // ============================================================ 7) upsert + complete_profile davranışı baseline ile birebir
  const WP5_BEHAVIOUR = await behaviourScenario(db);
  ok("davranış: member_upsert_profile (insert/update/COALESCE/JWT e-posta senkronu/claim'siz) + complete_profile (eksik/tam, puan, tier) baseline ile birebir",
     WP5_BEHAVIOUR === BASE_BEHAVIOUR, `\nBASE=${BASE_BEHAVIOUR}\nWP5 =${WP5_BEHAVIOUR}`);
  const bj = JSON.parse(WP5_BEHAVIOUR);
  ok("davranış: upsert insert -> email=JWT; JWT senkronu; claim'siz 23502; sub'sız no_auth; complete_profile tam profil -> ok, points=5, tier=Şehirli",
     bj.rows.find((x) => x.user_id === U.D)?.email === E.D && bj.rows.find((x) => x.user_id === U.A)?.email === E.A2 &&
     bj.out.c_no_email_claim === "ERR 23502" && bj.out.no_sub?.reason === "no_auth" && bj.out.a_incomplete?.reason === "incomplete_profile" &&
     bj.out.a_complete?.ok === true && bj.out.a_complete?.points === 5 && bj.out.a_complete?.tier === "Şehirli", JSON.stringify(bj.out));

  // ============================================================ 8) view'lar isimleri açmaz
  r = await tx(db, async (t) => {
    await db.query("select set_config('asalocal.trusted','1',true)");
    await db.query("update public.members set first_name='Gizli', last_name='Soyad' where user_id=$1", [U.A]);
    await db.query("insert into public.comments(id, venue_id, display_name, body, user_id) values (1, 'v1', 'Ali', 'merhaba', $1)", [U.A]);
    await db.query("select set_config('asalocal.trusted','',true)");
    const o = {};
    await t.as({ role: "anon" }, "anon");
    o.mp = await t.run("select to_jsonb(m) j from public.member_public m");
    o.cp = await t.run("select to_jsonb(c) j from public.comments_public c");
    o.mpf = await t.run("select first_name from public.member_public");
    o.cpl = await t.run("select last_name from public.comments_public");
    o.mem = await t.run("select first_name from public.members");
    await t.as(claims("B"));
    o.bsel = await t.run("select first_name from public.members where user_id = $1", [U.A]);
    await t.su();
    return o;
  });
  const flat = JSON.stringify([r.mp.rows, r.cp.rows]);
  ok("view: member_public/comments_public satırlarında isim anahtarı/değeri yok", r.mp.ok && r.cp.ok && r.mp.rows.length >= 1 && r.cp.rows.length === 1 &&
     !/first_name|last_name|Gizli|Soyad/.test(flat), flat);
  ok("view: anon first_name/last_name sorgusu 42703 (kolon yok)", !r.mpf.ok && r.mpf.code === "42703" && !r.cpl.ok && r.cpl.code === "42703");
  ok("rls: anon members okuyamaz (42501); B, A'nın ismini göremez (0 satır)", !r.mem.ok && r.mem.code === "42501" && r.bsel.ok && r.bsel.rows.length === 0);

  // ============================================================ 9) prod_assert + zero-footprint
  await db.query("insert into supabase_migrations.schema_migrations(version, name) values ('20991231000000', 'wp5_member_private_name')");
  a = await assertRows(db, PROD);
  ok("prod_assert (fixture, up sonrası): WP5_PROD_ASSERT_PASS (0 FAIL / 23 counted)", a.overall === "WP5_PROD_ASSERT_PASS" && a.summary === "0 FAIL / 23 counted", a.bad.join(" | "));
  const CAT_Z = await catSnap(db), DATA_Z = await fullSnap(db), OTHER_Z = await otherTablesSnap(db);
  z = await runZF(db);
  ok("zf: WP5 sonrası VERDICT=PASS fails=0 (REPORT ile biter)", z.isReport && z.verdict === "PASS" && z.fails === 0, z.msg);
  ok("zf: iz yok (katalog + tüm veri + diğer tablolar birebir)", (await catSnap(db)) === CAT_Z && (await fullSnap(db)) === DATA_Z && (await otherTablesSnap(db)) === OTHER_Z);
  a = await assertRows(db, PROD);
  ok("prod_assert: ZF sonrası da PASS (satır 22 kalıntı 0|0)", a.overall === "WP5_PROD_ASSERT_PASS" && a.rows.find((x) => Number(x.ord) === 22)?.actual === "0|0", a.bad.join(" | "));
  log.push("-- zf report (WP5 sonrası): " + z.msg);

  // ============================================================ 10) DOWN: silahsız ret, silahlı baseline
  const APPLIED_FULL = await fullSnap(db);
  e = await runDown(db, DOWN);
  ok("down: silahsız -> WP5_DOWN_NOT_ARMED, hiçbir şey değişmedi", e && /WP5_DOWN_NOT_ARMED/.test(e.message) && (await fullSnap(db)) === APPLIED_FULL, e && e.message);
  e = await runDown(db, DOWN_ARMED);
  ok("down: silahlı -> uygulandı", !e, e && e.message);
  ok("down: katalog production baseline'ına BİREBİR döndü (kolon/constraint/fonksiyon/ACL/policy/trigger/view)", (await catSnap(db)) === BASE_CAT);
  rows = await q(db, "select md5(prosrc) s, md5(pg_get_functiondef(oid)) d from pg_proc where oid='public.guard_member_admin_fields()'::regprocedure");
  ok("down: guard md5(prosrc) == yakalanan production md5 (9bba99..) ve md5(functiondef) == 48bd6e..", rows[0].s === PROD_GUARD_SRC && rows[0].d === PROD_GUARD_DEF, JSON.stringify(rows));
  a = await assertRows(db, PRE);
  ok("down: wp5_pre_assert yalnız ledger satırı (20) FAIL (beklenen; ledger kaydı kalır), diğer 19 PASS",
     a.bad.length === 1 && a.bad[0].startsWith("20:"), a.bad.join(" | "));
  e = await runDown(db, DOWN_ARMED);
  ok("down: ikinci kez (baseline'da) idempotent", !e && (await catSnap(db)) === BASE_CAT, e && e.message);

  // ============================================================ 11) yeniden up (dropped attnum'lara rağmen)
  e = await applyUp(db);
  ok("re-up: down sonrası yeniden uygulanır; katalog ilk up ile aynı", !e && (await catSnap(db)) === CAT1, e && e.message);
  z = await runZF(db);
  ok("re-up: zf PASS", z.verdict === "PASS", z.msg);
  await db.close();

  // ============================================================ 12) down: veri kaybı yalnız isimler (taze fixture)
  db = await fresh();
  const D0 = await dataSnap(db);
  await applyUp(db);
  await tx(db, async (t) => { await t.as(claims("A")); await t.run("select public.member_set_name('Ayşe','Yılmaz')"); await t.as(claims("B")); await t.run("select public.member_set_name('Berk','Kaya')"); }, { commit: true });
  e = await runDown(db, DOWN_ARMED);
  ok("down(veri): isimler silindi; diğer tüm members alanları ve tablolar değişmedi (updated_at hariç)", !e && (await dataSnap(db)) === D0 && (await catSnap(db)) === BASE_CAT, e && e.message);
  await db.close();

  // ============================================================ 13) PRE guard drift negatifleri + atomiklik
  const drifts = [
    ["guard gövdesi drift", `CREATE OR REPLACE FUNCTION public.guard_member_admin_fields() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$ BEGIN RETURN NEW; END $f$;`, /WP5_PRE_DRIFT: karışık/],
    ["first_name kolonu CHECK'siz (yarım durum)", "alter table public.members add column first_name text;", /WP5_PRE_DRIFT: karışık/],
    ["isimli + CHECK'siz kolon", "alter table public.members add column first_name text; alter table public.members add column last_name text; select set_config('asalocal.trusted','1',false); update public.members set first_name='<b>'; select set_config('asalocal.trusted','',false);", /WP5_PRE_DRIFT: karışık/],
    ["ek policy", "create policy members_anon_read on public.members for select to anon using (true);", /policy matrisi/],
    ["member_upsert_profile değişmiş", "create or replace function public.member_upsert_profile(p_display_name text, p_bio text, p_home_city text, p_gender text) returns jsonb language plpgsql set search_path to 'public', 'pg_temp' as $f$ begin return '{}'::jsonb; end $f$;", /member_upsert_profile/],
    ["anon members yetkisi", "grant select on public.members to anon;", /anon public\.members/],
    ["kolon düzeyi ACL", "grant update (display_name) on public.members to anon;", /anon public\.members|kolon düzeyi/],
    ["FORCE RLS", "alter table public.members force row level security;", /RLS/],
    ["başka member_set_name overload", "create function public.member_set_name(p text) returns jsonb language sql as $f$ select '{}'::jsonb $f$;", /karışık/],
    ["member_public isim/e-posta açıyor", "create or replace view public.member_public with (security_invoker = false, security_barrier = true) as select display_name, tier, email from public.members where blocked = false;", /member_public/],
    ["guard ACL drift", "grant execute on function public.guard_member_admin_fields() to anon;", /öznitelikleri/],
    ["trigger drift", "alter table public.members disable trigger trg_member_ref;", /trigger/],
  ];
  for (const [name, mut, re] of drifts) {
    const d = await fresh();
    await d.exec(mut);
    const before = await fullSnap(d);
    const er = await applyUp(d);
    ok(`drift: ${name} -> UP reddeder, hiçbir şey değişmez`, er && re.test(er.message) && (await fullSnap(d)) === before, er ? er.message : "UYGULANDI");
    await d.close();
  }
  {
    const d = await fresh();
    const before = await fullSnap(d);
    const tampered = UP.replace("c_chk_first   constant text := '7614490ed320884bf7d453bbcb61ccd8'", "c_chk_first   constant text := 'ffffffffffffffffffffffffffffffff'");
    const er = await applyUp(d, tampered);
    ok("atomik: POST guard hatası (tanım md5 uyuşmazlığı) -> kolon/constraint/fonksiyon değişiklikleri tamamen geri alındı",
       tampered !== UP && er && /WP5_POST_FAIL: members_first_name_wp5_policy/.test(er.message) && (await fullSnap(d)) === before, er && er.message);
    const er2 = await applyUp(d, UP + "\ndo $inj$ begin raise exception 'WP5_TEST_INJECTED_FAILURE'; end $inj$;");
    ok("atomik: UP sonrası enjekte hata -> her şey geri alındı", er2 && /WP5_TEST_INJECTED_FAILURE/.test(er2.message) && (await fullSnap(d)) === before, er2 && er2.message);
    await applyUp(d);
    await d.exec("alter table public.members alter column first_name set default 'x'");
    const mixed = await fullSnap(d);
    const er3 = await runDown(d, DOWN_ARMED);
    ok("down: silinecek kolondaki ek drift (varsayılan) zararsız -> down baseline'a birebir döner",
       !er3 && mixed !== (await fullSnap(d)) && (await catSnap(d)) === BASE_CAT, er3 && er3.message);
    await d.close();
  }
  {
    const d = await fresh();
    await applyUp(d);
    await d.exec("create or replace function public.member_set_name(p_first text, p_last text) returns jsonb language sql as $f$ select '{}'::jsonb $f$;");
    const before = await fullSnap(d);
    const er = await runDown(d, DOWN_ARMED);
    ok("down drift: member_set_name gövdesi değişmiş -> WP5_DOWN_DRIFT, hiçbir şey değişmez", er && /WP5_DOWN_DRIFT/.test(er.message) && (await fullSnap(d)) === before, er && er.message);
    await d.close();
  }

  // ============================================================ 14) ön-mevcut bulgu (WP5 kapsamı DIŞI; sayılmaz)
  {
    const d = await fresh();
    await applyUp(d);
    const o = await tx(d, async (t) => {
      const x = {};
      await t.as({ role: "anon" }, "anon");
      x.upd = await t.run("update public.member_public set display_name = 'x' where display_name = 'Ali'");
      await t.as(claims("A"));
      x.updB = await t.run("update public.member_public set display_name = 'renamed-by-A' where display_name = 'Berk'");
      x.namesViaView = await t.run("update public.member_public set first_name = 'x'");
      await t.as({ role: "anon" }, "anon");
      x.del = await t.run("delete from public.member_public where display_name = 'renamed-by-A'");
      await t.su();
      x.b = await rowOf(d, "B");
      return x;
    });
    finding("member_public otomatik-güncellenebilir + security_invoker=false + anon/authenticated DML yetkisi: anon DELETE (RLS atlanır)",
            `rows=${o.del.ok ? o.del.n : o.del.code}`);
    finding("anon UPDATE member_public -> guard 'auth required' ile reddedilir", o.upd.ok ? `rows=${o.upd.n}` : `${o.upd.code} ${o.upd.message}`);
    finding("authenticated A, member_public üzerinden B'nin display_name'ini değiştirebilir (RLS atlanır)", o.updB.ok ? `rows=${o.updB.n}` : o.updB.code);
    ok("bulgu sınırı: WP5 isim kolonlarına view üzerinden erişim yok (42703)", !o.namesViaView.ok && o.namesViaView.code === "42703", JSON.stringify(o.namesViaView));
    await d.close();
  }
} catch (err) {
  fail++;
  log.push("FATAL " + (err && err.stack || err));
}

console.log(log.join("\n"));
console.log(`\nRESULT pass=${pass} fail=${fail}`);
console.log(fail === 0 ? "WP5_LOCAL_PGLITE_GATE_PASS" : "WP5_LOCAL_PGLITE_GATE_FAIL");
process.exit(fail === 0 ? 0 : 1);
