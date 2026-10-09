// Re-runs the UNCHANGED CDP-3D PGlite gate (CDP3D_package/gates/cdp3d_pglite_gate.mjs) on a
// CDP-3D + WSE + WP8 schema (caps set), and compares its FAIL lines with an explicit
// expected-delta list (critic amendment 12). The gate source is copied to a temp dir and only
// two load hooks are inserted (anchors asserted to occur exactly once); no check is edited.
// usage: node wp8_cdp3d_on_wp8.mjs <tmpdir with a CDP3D_package copy + node_modules link>
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WP8_ROOT || resolve(HERE, "..", "..");
const TMP = resolve(process.argv[2]);
const gate = join(TMP, "CDP3D_package/gates/cdp3d_pglite_gate.mjs");
let src = readFileSync(gate, "utf8");
const py = (args) => { const r = spawnSync("python3", ["-I", ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
writeFileSync(join(TMP, "wp8_cdp3c_fns.sql"), py([join(ROOT, "WP8_package/gates/wp8_cdp3c_fns.py"), ROOT]));
const cleanup = readFileSync(join(ROOT, "WP8_package/db/WP8_DB_rollback_cleanup_optional.sql"), "utf8")
  .split("\n").map((l) => (/^-- (drop |alter table )/.test(l) ? l.slice(3) : l)).join("\n");
writeFileSync(join(TMP, "wp8_hard_cleanup.sql"), cleanup);
const J = JSON.stringify;
const loadWp8 = `
  for (const f of [${J(join(ROOT, "WSE_DEFAULT_package/gates/wse_prereq_extra.sql"))}, ${J(join(ROOT, "WSE_DEFAULT_package/WSE_up.sql"))},
                   ${J(join(ROOT, "WP8_package/gates/wp8_ci_baseline.sql"))}, ${J(join(TMP, "wp8_cdp3c_fns.sql"))}, ${J(join(ROOT, "WP8_package/db/WP8_DB_up.sql"))}]) {
    await db.exec("begin;\\n" + readFileSync(f, "utf8") + "\\ncommit;");
  }
  await db.exec("update public.email_service_policy set service_daily_cap = 50, service_monthly_cap = 1500 where id = 1;");
  log.push("-- WP8 applied on top (caps 50/1500) --");
`;
const unload = `
  await db.exec("begin;\\n" + readFileSync(${J(join(ROOT, "WP8_package/db/WP8_DB_rollback.sql"))}, "utf8") + "\\ncommit;");
  await db.exec("begin;\\n" + readFileSync(${J(join(TMP, "wp8_hard_cleanup.sql"))}, "utf8") + "\\ncommit;");
  log.push("-- WP8 rolled back + hard cleanup before CDP3D down --");
`;
const a1 = 'log.push("-- second apply idempotent OK --");';
const a2 = '  await db.exec(readFileSync("CDP3D_down_soft.sql","utf8"));';
if (src.split(a1).length !== 2 || src.split(a2).length !== 2) { console.log("WP8_CDP3D_ON_WP8_FAIL:anchors"); process.exit(1); }
src = src.replace(a1, a1 + loadWp8).replace(a2, unload + a2);
const out = join(TMP, "CDP3D_package/gates/cdp3d_pglite_gate_on_wp8.mjs");
writeFileSync(out, src);
const r = spawnSync(process.execPath, [out], { cwd: join(TMP, "CDP3D_package"), encoding: "utf8" });
const lines = (r.stdout + r.stderr).split("\n");
const fails = lines.filter((l) => l.startsWith("FAIL ") || l.startsWith("FATAL")).map((l) => l.replace(/^FAIL /, ""));
const passes = lines.filter((l) => l.startsWith("PASS ")).length;
// Expected delta: deliberate WP8 contract changes. Each line: CDP-3D check -> WP8 replacement check.
const DELTA = {
  "lease dolunca reclaim + yeniden claim": "behaviour 'S8 expired lease -> requeued with backoff (not hot-looped)' + db_suite 'lease loop' (Gap A: expired leases back off, no hot loop)",
  "mark ok -> sent": "cascade of the lease backoff: the reclaimed row is queued (not due), so mark_result is ignored; covered by behaviour 'S8 mark ok -> sent'",
  "delivered -> status delivered": "cascade (row still queued); covered by behaviour 'S9 mark ok late-links the orphan -> delivered' and rehearsal 'evidence after A'",
  "geç 'sent' delivered'ı geri düşürmez (monoton)": "cascade (row never delivered here); covered by behaviour 'S9 webhook after delivered keeps delivered'",
};
const unexpected = fails.filter((f) => !Object.keys(DELTA).includes(f));
const missing = Object.keys(DELTA).filter((d) => !fails.includes(d));
for (const [k, v] of Object.entries(DELTA)) console.log(`DELTA ${fails.includes(k) ? "OBSERVED" : "MISSING "} "${k}" -> ${v}`);
for (const u of unexpected) console.log("UNEXPECTED_FAIL " + u);
console.log(`CDP3D-ON-WP8 pglite: pass=${passes} fail=${fails.length} expected_delta=${Object.keys(DELTA).length}`);
const good = unexpected.length === 0 && missing.length === 0 && passes === 47 - Object.keys(DELTA).length;
console.log(good ? "WP8_CDP3D_ON_WP8_PGLITE_PASS" : "WP8_CDP3D_ON_WP8_PGLITE_FAIL");
process.exit(good ? 0 : 1);
