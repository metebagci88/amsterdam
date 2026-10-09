// WP8 static gate (Node built-ins only). Sentinel WP8_STATIC_PASS only when pass == EXPECTED, fail == 0.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WP8_ROOT || resolve(HERE, "..", "..");
const PKG = join(ROOT, "WP8_package");
const EXPECTED = 49;
let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (info !== undefined ? " :: " + String(typeof info === "string" ? info : JSON.stringify(info)).slice(0, 400) : "")); } };
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); if (f === "node_modules") return []; return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(PKG).map((p) => relative(ROOT, p)).sort();
const sqlProd = files.filter((f) => /^WP8_package\/(db|ops)\/.*\.sql$/.test(f));
const DROP_ALLOWED = "WP8_package/db/WP8_DB_rollback_cleanup_optional.sql";

// Lexer: returns { violations, code } where code has comments and literals blanked.
function lex(sql) {
  const v = []; let out = ""; let i = 0; let line = 1;
  const at0 = (k) => k === 0 || sql[k - 1] === "\n";
  while (i < sql.length) {
    const c = sql[i];
    if (c === "\n") { line++; out += c; i++; continue; }
    if (sql.startsWith("--", i)) {
      if (!at0(i)) v.push(`line ${line}: '--' not at column 0`);
      const e = sql.indexOf("\n", i); const end = e < 0 ? sql.length : e; out += " ".repeat(end - i); i = end; continue;
    }
    if (sql.startsWith("/*", i)) { v.push(`line ${line}: block comment`); const e = sql.indexOf("*/", i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (c === "'") {
      let j = i + 1; while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } if (sql[j] === "'") break; j++; }
      const lit = sql.slice(i, j + 1); if (lit.includes("--")) v.push(`line ${line}: '--' inside a string literal`);
      line += (lit.match(/\n/g) || []).length; out += "'" + lit.slice(1, -1).replace(/[^\n]/g, "x") + "'"; i = j + 1; continue;
    }
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
    if (m) {
      const tag = m[0]; const e = sql.indexOf(tag, i + tag.length);
      const body = sql.slice(i + tag.length, e < 0 ? sql.length : e);
      if (body.includes("--")) v.push(`line ${line}: '--' inside dollar-quoted body ${tag}`);
      line += (body.match(/\n/g) || []).length; out += tag + body.replace(/[^\n]/g, " ") + tag; i = (e < 0 ? sql.length : e + tag.length); continue;
    }
    out += c; i++;
  }
  return { violations: v, code: out };
}

// 1) DROP only in the optional cleanup file
const dropHits = sqlProd.filter((f) => f !== DROP_ALLOWED && /drop/i.test(rd(f)));
ok("no 'DROP' text (any case) in production SQL except the optional cleanup file", dropHits.length === 0, dropHits);
ok("the optional cleanup file is the one place with DROP", /drop function/i.test(rd(DROP_ALLOWED)));
ok("migration (generated) has no 'drop' even inside hex", !/drop/i.test(rd("WP8_package/db/WP8_DB_up.sql")));
// 2) comment discipline
const lexBad = sqlProd.map((f) => [f, lex(rd(f)).violations]).filter(([, v]) => v.length);
ok("'--' only at column 0 of comment lines, never in strings or bodies (all db/ops SQL)", lexBad.length === 0, lexBad.map(([f, v]) => f + ": " + v.slice(0, 2).join("; ")));
// 3) security definer => set search_path
const secBad = [];
for (const f of sqlProd) {
  const code = lex(rd(f)).code;
  for (const m of code.matchAll(/create\s+or\s+replace\s+function[\s\S]*?\bas\s+\$/gi)) if (/security\s+definer/i.test(m[0]) && !/set\s+search_path/i.test(m[0])) secBad.push(f);
}
ok("every SECURITY DEFINER function sets search_path", secBad.length === 0, secBad);
// 4) forbidden constructs in the inert migration
const up = rd("WP8_package/db/WP8_DB_up.sql"); const upCode = lex(up).code.toLowerCase();
// Word-bounded patterns ("insert into public." must not read as a grant "to public").
const forbidden = [/\bnet\.http_post\b/, /\bcron\./, /\binsert\s+into\s+auth\./, /\bupdate\s+auth\./, /\bdelete\s+from\s+auth\./,
  /\b(update|insert\s+into|delete\s+from)\s+public\.marketing_config\b/, /\bvault\./, /\bcreate\s+extension\b/, /\balter\s+role\b/,
  /\bto\s+(anon|authenticated|public)\b/, /\bsecurity\s+invoker\b/, /\bupdate\s+public\.email_provider_config\b/,
  /\binsert\s+into\s+public\.email_send_allowlist\b/, /\binsert\s+into\s+public\.email_outbox\b/, /\b(insert\s+into|update|delete\s+from)\s+public\.members\b/,
  /\bmember_service_pref_current\s+set\b/, /\binsert\s+into\s+public\.member_service_pref_(current|events)\b/];
const forbiddenHits = forbidden.filter((re) => re.test(upCode)).map(String);
ok("inert migration: no net/cron/vault/auth/marketing/allowlist/outbox/member writes, no grants to anon/authenticated/public", forbiddenHits.length === 0, forbiddenHits);
ok("forbidden-construct scan is not blind (a grant to anon in a probe is detected)", forbidden.some((re) => re.test("grant execute on function public.x() to anon;")) && !forbidden.some((re) => re.test("insert into public.email_service_policy(id) values (1);")));
ok("inert migration is ASCII only", !/[^\x09\x0a\x0d\x20-\x7e]/.test(up));
ok("migration carries the PRE, single-transaction and POST guards", ["do $wp8_pre$", "do $wp8_txn$", "do $wp8_post$", "WP8_UP_OK", "WP8_NOT_SINGLE_TRANSACTION"].every((t) => up.includes(t)));
ok("the POST guard is the last statement", up.trimEnd().endsWith("$wp8_post$;"));
// 5) determinism
const b = spawnSync(process.execPath, [join(PKG, "tools/wp8_build.mjs"), "--check", "--root", ROOT], { encoding: "utf8" });
ok("WP8_DB_up.sql and WP8_MANIFEST.json equal the build output byte-for-byte", b.status === 0 && /WP8_BUILD_CHECK_OK/.test(b.stdout), (b.stdout + b.stderr).trim());
// 6) template bytes
const html = readFileSync(join(ROOT, "CDP3D_package/email/templates/welcome_service_email.v3.2.html"));
const txt = readFileSync(join(ROOT, "CDP3D_package/email/templates/welcome_service_email.v3.2.txt"));
const meta = JSON.parse(rd("CDP3D_package/email/templates/welcome_service_email.v3.2.json"));
const sums = Object.fromEntries(rd("CDP3D_package/SHA256SUMS").trim().split("\n").map((l) => { const [h, p] = l.split(/\s+/); return [p.replace(/^\.\//, ""), h]; }));
const hexBlocks = [...up.matchAll(/decode\('\n([0-9a-f\n]+)\n', 'hex'\)/g)].map((m) => Buffer.from(m[1].replace(/\n/g, ""), "hex"));
ok("embedded html hex decodes to the repo v3.2 html bytes", hexBlocks.length === 2 && Buffer.compare(hexBlocks[0], html) === 0);
ok("embedded text hex decodes to the repo v3.2 text bytes", hexBlocks.length === 2 && Buffer.compare(hexBlocks[1], txt) === 0);
ok("template sha256 = CDP3D SHA256SUMS = migration CHECK constants", sha256(html) === sums["email/templates/welcome_service_email.v3.2.html"] && sha256(txt) === sums["email/templates/welcome_service_email.v3.2.txt"]
   && up.includes(sha256(html)) && up.includes(sha256(txt)) && sha256(html) === "77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb" && sha256(txt) === "818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56");
const subjHex = Buffer.from(meta.subject, "utf8").toString("hex");
ok("subject (hex) equals the .json subject", up.includes(`decode('${subjHex}', 'hex')`) && meta.subject === "Aramıza hoş geldin");
ok("template: exactly one {{first_name}} per part, inside 'Merhaba {{first_name}},'", [html.toString("utf8"), txt.toString("utf8")].every((s) => s.split("{{first_name}}").length === 2 && s.includes("Merhaba {{first_name}},")));
// 7) addresses
const addrRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const allowedEverywhere = new Set(["no-reply@send.asalocal.club", "destek@asalocal.club"]);
const addrBad = [];
for (const f of files) {
  if (/\.(png|jpg)$/.test(f)) continue;
  for (const a of rd(f).match(addrRe) || []) {
    if (allowedEverywhere.has(a)) continue;
    if (a.endsWith("@example.test") && f.startsWith("WP8_package/gates/")) continue;
    addrBad.push(f + ": " + a);
  }
}
ok("addresses: only the fixed service addresses; @example.test only in gates/", addrBad.length === 0, addrBad.slice(0, 5));
// 8) Edge v4
const edge = rd("CDP3D_package/edge/service-email-dispatch/index.ts");
ok("Edge: no console.* (recipient never logged)", !/console\./.test(edge));
ok("Edge: responses never carry recipient fields or error detail", [...edge.matchAll(/jsonResp\([^;]*\)/g)].every((m) => !/recipient|toEmail|detail|message/.test(m[0])));
ok("Edge: pacing >= 1000 ms, 15 s fetch timeout, lease time budget, token limit 10", /const PACE_MS = (\d+);/.test(edge) && Number(edge.match(/const PACE_MS = (\d+);/)[1]) >= 1000
   && edge.includes("AbortSignal.timeout(FETCH_TIMEOUT_MS)") && /TIME_BUDGET_MS = \(LEASE_SECONDS - 30\) \* 1000/.test(edge) && /TOKEN_MAX_LIMIT = 10;/.test(edge));
ok("Edge: token path timing-safe, disabled under 32 chars; 429 releases; idempotency key outbox-<id>", edge.includes("timingSafeEqual(presented, token)") && /TOKEN_MIN_LEN = 32/.test(edge)
   && edge.includes('"email_release_claim"') && edge.includes("`outbox-${row.outbox_id}`"));
ok("rollback copy of Edge v3 is byte-exact (sha 1279d9aa...)", sha256(readFileSync(join(PKG, "rollback/edge-service-email-dispatch-v3/index.ts"))) === "1279d9aa52a8f8cee40d56389baf0e58f1101369ced0188f949d176536a10537");
ok("CDP3D SHA256SUMS dispatch line = current Edge v4 bytes", sums["edge/service-email-dispatch/index.ts"] === sha256(Buffer.from(edge, "utf8")));
// 9) read-only asserts
for (const f of ["WP8_package/db/WP8_DB_pre_assert.sql", "WP8_package/db/WP8_DB_post_assert.sql", "WP8_package/db/WP8_DB_post_rollback_assert.sql", "WP8_package/db/WP8_DB_evidence.sql"]) {
  const code = lex(rd(f)).code.replace(/^\s+/, "");
  const semis = (code.match(/;/g) || []).length;
  const dml = code.match(/\b(insert|update|delete|create|alter|grant|revoke|truncate|do|call|copy|set_config|merge|vacuum|lock)\b/gi) || [];
  ok(`${f.split("/").pop()}: one read-only SELECT`, /^(with|select)\b/i.test(code) && semis === 1 && code.trimEnd().endsWith(";") && dml.length === 0, { semis, dml });
}
// 10) ZF probe self-aborting
const zf = lex(rd("WP8_package/db/WP8_DB_zf_probe.sql")).code;
ok("ZF probe: one DO block that always ends with RAISE EXCEPTION WP8_ZF_DONE, no COMMIT", (rd("WP8_package/db/WP8_DB_zf_probe.sql").match(/raise exception 'WP8_ZF_DONE:%'/g) || []).length === 1
   && !/\bcommit\b/i.test(zf) && (zf.match(/;/g) || []).length === 1 && /^\s*do \$wp8_zf\$/m.test(zf));
// 11) placeholders and arms
const phAllowed = ["WP8_package/db/WP8_DB_up.src.sql", "WP8_package/db/WP8_DB_owner_setup.sql", "WP8_package/db/WP8_DB_scheduler_optin.sql", "WP8_package/ops/WP8_OPS_extensions_enable.sql", "WP8_package/ops/WP8_OPS_public_go_live.sql"];
const phBad = files.filter((f) => /\.sql$/.test(f) && !phAllowed.includes(f) && /@@[A-Z_]+@@/.test(rd(f)));
ok("@@placeholders@@ only in the src and the owner-armed templates", phBad.length === 0, phBad);
const armed = sqlProd.filter((f) => /set_config\('wp8\.allow_[a-z_]+', 'YES'/.test(rd(f)));
ok("no committed file is pre-armed (arm values are placeholders)", armed.length === 0, armed);
ok("owner-armed templates refuse without the arm", phAllowed.slice(1).every((f) => /refused_without_explicit_arm/.test(rd(f))));
// 12) manifest consistency
const man = JSON.parse(rd("WP8_package/db/WP8_MANIFEST.json"));
const post = rd("WP8_package/db/WP8_DB_post_assert.sql");
ok("manifest: 14 functions, 5 tables; POST assert and owner setup expect the same", man.functions.length === 14 && man.tables.length === 5
   && post.includes("'manifest_functions_14', (select count(*) = 14 from fn)") && post.includes("'manifest_tables_5', (select count(*) = 5 from tb)")
   && rd("WP8_package/db/WP8_DB_owner_setup.sql").includes("where object_kind = 'function') <> 14"));
ok("manifest: service_role EXECUTE only on the 7 entry points", JSON.stringify(man.functions.filter((x) => x.service_role_execute).map((x) => x.signature).sort())
   === JSON.stringify(["public.admin_w_email_public_go_live_set(uuid,boolean,text,text)", "public.admin_w_welcome_automation_set(uuid,boolean,text,text)", "public.email_claim_batch(int)",
     "public.email_mark_result(uuid,boolean,text,text)", "public.email_reconcile_orphan_events(int)", "public.email_release_claim(uuid,int,boolean)", "public.welcome_enqueue_sweep(int)"]));
ok("every function created by the migration is revoked from public/anon/authenticated", man.functions.every((x) => {
  const name = x.signature.split("(")[0]; return new RegExp(`revoke all on function ${name.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated`).test(up);
}));
// 13) scheduler fallback stays inert; CI workflow has no secrets
ok("GitHub fallback scheduler is NOT under .github/workflows (inert)", existsSync(join(PKG, "scheduler/wp8-dispatch-fallback.yml.disabled")) && !existsSync(join(ROOT, ".github/workflows/wp8-dispatch-fallback.yml")));
const wf = existsSync(join(ROOT, ".github/workflows/wp8-gates.yml")) ? rd(".github/workflows/wp8-gates.yml") : "";
ok("wp8-gates.yml exists, uses no secrets, refuses production hosts", wf.length > 0 && !/secrets\./.test(wf) && wf.includes("REFUSED_PRODUCTION"));
// 14) package integrity and consistency
const wsums = existsSync(join(PKG, "SHA256SUMS")) ? rd("WP8_package/SHA256SUMS").trim().split("\n").map((l) => l.split(/\s+/)[1].replace(/^\.\//, "WP8_package/")) : [];
const expectFiles = files.filter((f) => f !== "WP8_package/SHA256SUMS");
ok("WP8 SHA256SUMS lists every WP8 file", JSON.stringify([...wsums].sort()) === JSON.stringify(expectFiles), expectFiles.filter((f) => !wsums.includes(f)).concat(wsums.filter((f) => !expectFiles.includes(f))));
ok("behaviour expected count identical in lib and PGlite gate", (rd("WP8_package/gates/wp8_lib.sh").match(/WP8_BEHAVIOR_EXPECTED=(\d+)/) || [])[1] === (rd("WP8_package/gates/wp8_pglite_gate.mjs").match(/BEHAVIOR_EXPECTED = (\d+);/) || [])[1]);
ok("CDP3D package: only the dispatch Edge changed (template gate scope intact)", existsSync(join(ROOT, "CDP3D_package/email/templates/welcome_service_email.v3.2.html")) && readdirSync(join(ROOT, "CDP3D_package/email/templates")).length === 3);
ok("rollback file: no DROP, restores claim/mark, disables the go-live guard, sets service off", (() => { const r = rd("WP8_package/db/WP8_DB_rollback.sql"); return !/drop/i.test(r)
   && r.includes("create or replace function public.email_claim_batch") && r.includes("create or replace function public.email_mark_result")
   && r.includes("disable trigger email_provider_config_golive_guard") && r.includes("set service_enabled = false, public_go_live = false"); })());
ok("kill switch hard: config, then policy, then cancels queued wp8 welcomes, before unscheduling", (() => { const k = rd("WP8_package/ops/WP8_OPS_kill_switch_hard.sql");
   const a = k.indexOf("update public.email_provider_config set service_enabled = false, public_go_live = false"), b = k.indexOf("update public.email_service_policy set welcome_auto_enqueue_enabled = false, service_dispatch_paused = true"),
         c = k.indexOf("set status = 'canceled', last_error = 'wp8_kill_switch'"), d = k.indexOf("cron.unschedule");
   return a > 0 && a < b && b < c && c < d; })());
ok("migration: claim cancels stale wp8 welcomes before any return", (() => { const c = up.slice(up.indexOf("create or replace function public.email_claim_batch"), up.indexOf("create or replace function public.email_mark_result"));
   return c.indexOf("wp8_queue_expired") > 0 && c.indexOf("wp8_queue_expired") < c.indexOf("return;"); })());

// 15) runbook, gates and CI completeness
const readme = existsSync(join(PKG, "WP8_README.md")) ? rd("WP8_package/WP8_README.md") : "";
ok("WP8_README.md covers STOP-1, apply, acceptance, kill switch, rollback, go-live and owner decisions D1-D14",
   ["STOP-1", "Apply runbook", "Allowlist phase", "Kill switch", "Rollback", "Public go-live", "Owner decisions"].every((t) => readme.includes(t))
   && Array.from({ length: 14 }, (_, i) => `| D${i + 1} |`).every((t) => readme.includes(t)));
ok("gate files present (mutation suite, scoped secret scan + runtime-fake self-test)", ["wp8_mutation.mjs", "wp8_mutation.sh", "wp8_secret_scan.sh", "wp8_secret_scan_selftest.sh"].every((f) => existsSync(join(PKG, "gates", f))));
ok("wp8-gates.yml runs every suite and checks each sentinel", ["WP8_STATIC_PASS", "WP8_MD5_PARITY_PASS", "WP8_SECRET_SCAN_SELFTEST_PASS", "SECRET_SCAN_CLEAN", "WP8_EPHEMERAL_PASS", "WP8_DB_SUITE_PASS",
   "WP8_SCHED_PASS", "WP8_PGLITE_PASS", "WP8_EDGE_HARNESS_PASS", "WP8_CDP3D_REGRESSION_PASS", "WP8_MUTATION_PASS", "WP8_GATES_PASS", "wp8_build.mjs --check", "sha256sum -c"].every((t) => wf.includes(t))
   && /permissions:\s*\n\s*contents: read/.test(wf));
// GitHub expression contexts per workflow key (subset of GitHub's context-availability table, the
// same table actionlint encodes). A context outside its key's list makes the whole workflow file
// invalid (for example runner.* in job-level env), so no gate would run at all.
const CTX_ALLOWED = {
  "env": ["github", "inputs", "vars", "secrets"], "concurrency": ["github", "inputs", "vars"], "run-name": ["github", "inputs", "vars"],
  "jobs.*.env": ["github", "inputs", "matrix", "needs", "secrets", "strategy", "vars"],
  "jobs.*.runs-on": ["github", "inputs", "matrix", "needs", "strategy", "vars"], "jobs.*.concurrency": ["github", "inputs", "matrix", "needs", "strategy", "vars"],
  "jobs.*.timeout-minutes": ["github", "inputs", "matrix", "needs", "strategy", "vars"], "jobs.*.name": ["github", "inputs", "matrix", "needs", "strategy", "vars"],
  "jobs.*.defaults": ["github", "inputs", "matrix", "needs", "strategy", "vars"], "jobs.*.if": ["github", "inputs", "needs", "vars"],
  "jobs.*.permissions": [], "permissions": [], "on": ["github", "inputs", "vars"],
};
function wfContextViolations(yml) {
  const bad = []; const stack = [];
  yml.split("\n").forEach((line, i) => {
    if (/^\s*(#.*)?$/.test(line)) return;
    const m = /^(\s*)(-\s+)?([A-Za-z0-9_.-]+)\s*:(\s|$)/.exec(line);
    if (m) {
      const ind = m[1].length + (m[2] ? m[2].length : 0);
      while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
      stack.push({ ind, key: m[3] });
    }
    const path = stack.map((x) => x.key);
    const key = path[0] === "jobs" ? (path.length >= 3 ? "jobs.*." + path[2] : "jobs") : path[0];
    for (const e of line.matchAll(/\$\{\{(.*?)\}\}/g)) {
      const expr = e[1].replace(/'(?:[^']|'')*'/g, "''");
      const ctx = [...expr.matchAll(/(?<![\w.])([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[.[])/g)].map((x) => x[1]);
      if (key === "jobs.*.steps" || key === "jobs.*.services" || key === "jobs.*.container" || key === "jobs.*.outputs" || key === "jobs.*.strategy") continue;
      const allow = CTX_ALLOWED[key];
      if (!allow) { bad.push(`line ${i + 1}: expression under unchecked key ${key}`); continue; }
      for (const c of ctx) if (!allow.includes(c)) bad.push(`line ${i + 1}: context ${c} not allowed in ${key}`);
    }
  });
  return bad;
}
const fallback = rd("WP8_package/scheduler/wp8-dispatch-fallback.yml.disabled");
ok("workflows: every ${{ }} context allowed where it is used (job-level env has no runner.*); wp8-gates.yml and the inert fallback",
   wf.length > 0 && wfContextViolations(wf).length === 0 && wfContextViolations(fallback).length === 0, wfContextViolations(wf).concat(wfContextViolations(fallback)));
ok("workflow context check is not blind (runner.temp in job-level env flagged; in a step run and step env not flagged)",
   wfContextViolations("jobs:\n  gates:\n    runs-on: ubuntu-24.04\n    env:\n      WP8_PG_DIR: ${{ runner.temp }}/wp8pg\n    steps:\n      - run: echo hi\n").length === 1
   && wfContextViolations("env:\n  X: ${{ runner.os }}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ${{ runner.temp }}\n        env:\n          Y: ${{ runner.temp }}\n").length === 1
   && wfContextViolations("jobs:\n  a:\n    runs-on: ubuntu-24.04\n    env:\n      Z: ${{ github.ref }}\n").length === 0);
ok("wp8-gates.yml lints with a pinned actionlint before any gate", /go install github\.com\/rhysd\/actionlint\/cmd\/actionlint@v1\.7\.7\b/.test(wf) && wf.includes("ACTIONLINT_OK")
   && wf.indexOf("ACTIONLINT_OK") < wf.indexOf("wp8_static_check.mjs"));
const mut = rd("WP8_package/gates/wp8_mutation.mjs");
ok("mutation suite: hard-coded expected count equals the mutant table", Number((mut.match(/const EXPECTED = ONLY \? list\.length : (\d+);/) || [])[1]) === (mut.match(/^  \{ id: "/gm) || []).length);

console.log(`\nSTATIC RESULT pass=${pass} fail=${fail} expected=${EXPECTED}`);
if (fail === 0 && pass === EXPECTED) console.log("WP8_STATIC_PASS"); else console.log("WP8_STATIC_FAIL");
process.exit(fail === 0 && pass === EXPECTED ? 0 : 1);
