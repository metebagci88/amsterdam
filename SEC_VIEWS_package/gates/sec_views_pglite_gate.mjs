// SEC-VIEWS · gates/sec_views_pglite_gate.mjs — local PGlite gate (production'a DOKUNMAZ)
//
//   PGLITE_DIR=<@electric-sql/pglite kurulu dizin> node SEC_VIEWS_package/gates/sec_views_pglite_gate.mjs
//
// Model: production'daki 3 view birebir aynı SQL ile (pg_get_viewdef md5'leri production ile eşit olmalı),
// aynı ACL (arwdDxtm), aynı reloptions, sahip postgres; members RLS açık, FORCE kapalı.
// Akış: baseline ZF = VULNERABLE + gerçek anon DELETE satır siler (açığın modeldeki kanıtı)
//       -> up -> ZF = PASS, gerçek anon DELETE/authenticated UPDATE 42501, okuma çalışır
//       -> up tekrar (idempotent) -> drift (ACL ve view tanımı) PRE reddi, değişiklik yok
//       -> down kurulmadan reddeder -> down armed baseline'a döner -> ZF = VULNERABLE -> up tekrar PASS.
// Çıkış: SEC_VIEWS_PGLITE_GATE_PASS / _FAIL
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const UP = readFileSync(join(PKG, "SEC_VIEWS_up.sql"), "utf8");
const DOWN = readFileSync(join(PKG, "SEC_VIEWS_down_INSECURE.sql"), "utf8");
const ZF = readFileSync(join(HERE, "sec_views_zero_footprint_test.sql"), "utf8");
const ASSERT = readFileSync(join(HERE, "sec_views_prod_assert.sql"), "utf8");

async function loadPGlite() {
  const dir = process.env.PGLITE_DIR;
  if (!dir) throw new Error("PGLITE_DIR gerekli");
  const req = createRequire(join(dir, "noop.js"));
  const m = await import(pathToFileURL(req.resolve("@electric-sql/pglite")).href);
  return m.PGlite;
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); } };

const FIXTURE = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create table public.members (user_id uuid primary key, display_name text, tier text default 'Kaşif', blocked boolean not null default false, email text);
alter table public.members enable row level security;
create policy members_self_select on public.members for select to authenticated using (user_id = nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid);
create policy members_self_update on public.members for update to authenticated using (user_id = nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid);
grant select, insert, update, delete on public.members to authenticated;
create table public.comments (id bigint primary key, venue_id text, city text, display_name text, body text, photo_url text, created_at timestamptz default now(), user_id uuid, hidden boolean not null default false);
create table public.comment_reactions (comment_id bigint, user_id uuid, reaction text);
alter table public.comments enable row level security; alter table public.comment_reactions enable row level security;
create view public.member_public with (security_invoker=false, security_barrier=true) as
 SELECT display_name, tier FROM members WHERE blocked = false;
create view public.comments_public with (security_invoker=false, security_barrier=true) as
 SELECT c.id, c.venue_id, c.city, c.display_name, c.body, c.photo_url, c.created_at
   FROM comments c LEFT JOIN members m ON m.user_id = c.user_id
  WHERE c.hidden = false AND COALESCE(m.blocked, false) = false;
create view public.comment_reaction_counts with (security_invoker=false, security_barrier=true) as
 SELECT cr.comment_id, cr.reaction, count(*)::integer AS n
   FROM comment_reactions cr JOIN comments c ON c.id = cr.comment_id AND c.hidden = false
   LEFT JOIN members m ON m.user_id = cr.user_id
  WHERE COALESCE(m.blocked, false) = false
  GROUP BY cr.comment_id, cr.reaction;
grant all on public.member_public, public.comments_public, public.comment_reaction_counts to anon, authenticated, service_role;
insert into public.members (user_id, display_name) values
 ('00000000-0000-4000-8000-0000000000a1', 'Ayse'), ('00000000-0000-4000-8000-0000000000b2', 'Bora');
insert into public.comments (id, venue_id, city, display_name, body, user_id) values (1, 'v1', 'Amsterdam', 'Ayse', 'iyi', '00000000-0000-4000-8000-0000000000a1');
create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text, name text);
`;

const zf = async (db) => { try { await db.exec(ZF); return "NO_REPORT"; } catch (e) { const m = String(e.message); return m.slice(m.indexOf("REPORT:")); } };
const acl = async (db) => (await db.query(`select string_agg(relname::text || '=' || relacl::text, ';' order by relname) a from pg_class where relname in ('member_public','comments_public','comment_reaction_counts')`)).rows[0].a;
const tryExec = async (db, sql) => { try { await db.exec(sql); return "ok"; } catch (e) { await db.exec("rollback").catch(() => {}); return "ERR:" + (e.code || "") + ":" + String(e.message).slice(0, 80); } };
const asRole = (role, sub, sql) => `begin; select set_config('request.jwt.claims', '${role === "anon" ? '{"role":"anon"}' : `{"role":"authenticated","sub":"${sub}"}`}', true); set local role ${role}; ${sql}; commit;`;

const PGlite = await loadPGlite();
const db = new PGlite();
const ver = (await db.query("select version() v")).rows[0].v;
console.log("-- engine: " + ver.split(" on ")[0]);
await db.exec(FIXTURE);
const BASE_ACL = await acl(db);

// view tanımları production ile birebir (PRE guard md5'leri)
const md5s = (await db.query(`select string_agg(relname::text || ':' || md5(pg_get_viewdef(oid, true)), ',' order by relname) s from pg_class where relname in ('member_public','comments_public','comment_reaction_counts')`)).rows[0].s;
ok("model view definitions == production md5", md5s === "comment_reaction_counts:240f9780784dbce197e977c3279ec4f6,comments_public:1d109aaeddd96e0ad746fb7a177d5da1,member_public:bfb056b40e300dbb32edb4606f348ad2", md5s);
ok("model ACL == production baseline", BASE_ACL.split(";").every((x) => x.endsWith("={postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}")), BASE_ACL);

// baseline: vulnerable
const z0 = await zf(db);
ok("baseline ZF verdict VULNERABLE", /SV_ZF_VERDICT=VULNERABLE/.test(z0) && /opens=6/.test(z0), z0);
const membersBefore = (await db.query("select count(*)::int n from public.members")).rows[0].n;
ok("baseline: real anon DELETE through member_public succeeds (hole reproduced)", (await tryExec(db, asRole("anon", null, "delete from public.member_public where display_name = 'Bora'"))) === "ok" && (await db.query("select count(*)::int n from public.members")).rows[0].n === membersBefore - 1);
await db.exec("insert into public.members (user_id, display_name) values ('00000000-0000-4000-8000-0000000000b2', 'Bora')");
ok("baseline: authenticated A renames B through member_public (hole reproduced)", (await tryExec(db, asRole("authenticated", "00000000-0000-4000-8000-0000000000a1", "update public.member_public set display_name = 'hacked' where display_name = 'Bora'"))) === "ok" && (await db.query("select display_name from public.members where user_id = '00000000-0000-4000-8000-0000000000b2'")).rows[0].display_name === "hacked");
await db.exec("update public.members set display_name = 'Bora' where user_id = '00000000-0000-4000-8000-0000000000b2'");

// apply
const up1 = await tryExec(db, "begin;" + UP + "commit;");
ok("up applies (PRE_OK + POST_OK)", up1 === "ok", up1);
await db.exec("insert into supabase_migrations.schema_migrations values ('20261007000000', 'sec_public_views_readonly')");
const T = "{postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}";
ok("after up: ACL target on all 3 views", (await acl(db)) === `comment_reaction_counts=${T};comments_public=${T};member_public=${T}`, await acl(db));
const z1 = await zf(db);
ok("after up: ZF verdict PASS", /SV_ZF_VERDICT=PASS/.test(z1) && /opens=0 fails=0/.test(z1), z1);
ok("after up: member_public writes denied with 42501 for anon+authenticated", (z1.match(/:denied;/g) || []).length === 6, z1);
const nBefore = (await db.query("select count(*)::int n from public.members")).rows[0].n;
const d1 = await tryExec(db, asRole("anon", null, "delete from public.member_public where display_name = 'Bora'"));
ok("after up: real anon DELETE rejected 42501, no row lost", d1.startsWith("ERR:42501") && (await db.query("select count(*)::int n from public.members")).rows[0].n === nBefore, d1);
const u1 = await tryExec(db, asRole("authenticated", "00000000-0000-4000-8000-0000000000a1", "update public.member_public set display_name = 'hacked' where display_name = 'Bora'"));
ok("after up: authenticated cross-user rename rejected 42501", u1.startsWith("ERR:42501") && (await db.query("select display_name from public.members where user_id = '00000000-0000-4000-8000-0000000000b2'")).rows[0].display_name === "Bora", u1);
const r1 = await tryExec(db, asRole("anon", null, "select * from public.comments_public; select * from public.comment_reaction_counts; select * from public.member_public"));
ok("after up: anon reads still work", r1 === "ok", r1);
ok("after up: service_role ACL untouched", (await acl(db)).includes("service_role=arwdDxtm/postgres"));
ok("after up: members table ACL untouched", (await db.query("select relacl::text a from pg_class where oid = 'public.members'::regclass")).rows[0].a.includes("authenticated=arwd/postgres"));

// prod assert (rows that the model can satisfy; row 9 is production-only)
const ar = (await db.query(ASSERT)).rows;
const failsA = ar.filter((r) => r.ord !== 99 && r.result !== "PASS").map((r) => r.ord);
ok("prod assert: only production-specific row 9 differs in the model", JSON.stringify(failsA) === "[9]", JSON.stringify(failsA));

// idempotent
const up2 = await tryExec(db, "begin;" + UP + "commit;");
ok("up is idempotent (second run passes, same ACL)", up2 === "ok" && (await acl(db)) === `comment_reaction_counts=${T};comments_public=${T};member_public=${T}`, up2);

// drift: unexpected ACL -> PRE refuses, nothing changes
await db.exec("grant select on public.member_public to service_role; create role drift_role nologin; grant select on public.member_public to drift_role;");
const aclDrift = await acl(db);
const up3 = await tryExec(db, "begin;" + UP + "commit;");
ok("drift (ACL): PRE refuses", /SEC_VIEWS_PRE_DRIFT/.test(up3), up3);
ok("drift (ACL): nothing changed", (await acl(db)) === aclDrift);
await db.exec("revoke select on public.member_public from drift_role;");
// drift: changed view definition -> PRE refuses
await db.exec("create or replace view public.member_public with (security_invoker=false, security_barrier=true) as SELECT display_name, tier FROM members WHERE blocked = false AND tier IS NOT NULL;");
const up4 = await tryExec(db, "begin;" + UP + "commit;");
ok("drift (view definition): PRE refuses", /SEC_VIEWS_PRE_DRIFT/.test(up4), up4);
await db.exec("create or replace view public.member_public with (security_invoker=false, security_barrier=true) as SELECT display_name, tier FROM members WHERE blocked = false;");

// rollback
const dn0 = await tryExec(db, "begin;" + DOWN + "commit;");
ok("down refuses when not armed", /SEC_VIEWS_DOWN_NOT_ARMED/.test(dn0), dn0);
ok("down not armed: nothing changed", (await acl(db)) === `comment_reaction_counts=${T};comments_public=${T};member_public=${T}`);
const dn1 = await tryExec(db, "begin; select set_config('sec_views.rollback_armed', 'YES-REOPEN-HOLE', true);" + DOWN + "commit;");
ok("down armed restores the exact baseline ACL", dn1 === "ok" && (await acl(db)) === BASE_ACL, dn1);
ok("after down: ZF verdict VULNERABLE again", /SV_ZF_VERDICT=VULNERABLE/.test(await zf(db)));
const up5 = await tryExec(db, "begin;" + UP + "commit;");
ok("re-apply after down passes", up5 === "ok" && /SV_ZF_VERDICT=PASS/.test(await zf(db)), up5);

// atomicity: a POST failure rolls everything back
const broken = UP.replace("anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}';\n  v_bad", "anon=X/postgres}';\n  v_bad");
ok("mutation harness: POST target literal replaced", broken !== UP);
await db.exec("begin; select set_config('sec_views.rollback_armed', 'YES-REOPEN-HOLE', true);" + DOWN + "commit;");
const up6 = await tryExec(db, "begin;" + broken + "commit;");
ok("atomic: POST failure rolls back the revoke (baseline ACL intact)", /SEC_VIEWS_POST_FAIL/.test(up6) && (await acl(db)) === BASE_ACL, up6 + " | " + (await acl(db)));

console.log(`RESULT pass=${pass} fail=${fail}`);
console.log(fail ? "SEC_VIEWS_PGLITE_GATE_FAIL" : "SEC_VIEWS_PGLITE_GATE_PASS");
process.exit(fail ? 1 : 0);
