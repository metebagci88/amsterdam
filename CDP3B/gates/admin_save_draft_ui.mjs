// ASALOCAL · CDP-3B · T2 — Playwright UI test of the REAL admin.html "Taslak kaydet" flow against an EPHEMERAL stack.
//   node gates/admin_save_draft_ui.mjs                      (CI: cdp3b-gates, after supabase start + functions serve)
//   SAVE_DRAFT_UI_MODE=local node gates/admin_save_draft_ui.mjs   (docker-free; via gates/local_stack/run_local.sh)
// The page is served from this checkout as https://www.asalocal.club/CDP3B/admin.html (so the real email-api CORS
// allowlist applies). EVERY request is routed or explicitly fulfilled; any other host or unknown path is aborted and FAILS:
//   www.asalocal.club            -> files of this checkout (+ the /vendor/grapesjs/* rewrite from _redirects)
//   cdn.jsdelivr.net supabase-js -> pinned local copy (@supabase/supabase-js@2.117.2 UMD); cdnjs leaflet -> empty
//   <prod project>/auth/v1/*     -> CI: local GoTrue via route.fetch, apikey + anon Authorization rewritten to the local
//                                   ANON_KEY (user Bearer kept); local mode: GoTrue double (fixed test user)
//   <prod project>/rest/v1/rpc/{is_current_user_admin,current_user_has_admin_role,_can_*} -> per-role fixture (crm)
//   <prod project>/rest/v1/{venues,cities,comments,ads,site_content} -> [] ; /functions/v1/admin-api -> 503 (explicit)
//   <prod project>/functions/v1/email-api -> route.fetch to $EMAIL_API_URL (127.0.0.1/localhost only), Origin + user
//                                   Bearer kept; only actions list/get/validate/create/save are allowed (else FAIL)
// No trace, HAR, video or screenshots are recorded (they would capture Authorization headers). Credentials come from env and
// are never printed. Synthetic fixtures only. Output: "ADMIN_SAVE_DRAFT_UI_OK" or non-zero exit.
// Waits follow what the PAGE renders (row text, save button re-enabled), never only the router log: a request is logged
// before its response reaches the page. SAVE_DRAFT_UI_LIST_LAG_MS (test-only, default 0) delays every 'list' response AFTER
// it is logged, to prove that (run_local.sh t2lag).
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const CDP3B = join(HERE, ".."), SITE = join(CDP3B, "..");
const LOCAL = process.env.SAVE_DRAFT_UI_MODE === "local";
const need = LOCAL ? ["EMAIL_API_URL", "CRM_EMAIL", "CRM_PW", "CRM_JWT", "CRM_UID"] : ["EMAIL_API_URL", "API_URL", "ANON_KEY", "CRM_EMAIL", "CRM_PW"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.log("GATE_FAILED:admin_save_draft_ui_env_missing:" + missing.join(",")); process.exit(1); }
const E = process.env;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
for (const k of LOCAL ? ["EMAIL_API_URL"] : ["EMAIL_API_URL", "API_URL"]) {
  if (!LOCAL_HOSTS.has(hostOf(E[k]))) { console.log("GATE_FAILED:admin_save_draft_ui_non_local_host:" + k); process.exit(1); }
}
const SITE_ORIGIN = "https://www.asalocal.club";
const ADMIN = readFileSync(join(CDP3B, "admin.html"), "utf8");
const PROD = (ADMIN.match(/const CFG=\{url:"(https:\/\/[a-z0-9]+\.supabase\.co)"/) || [])[1];
const PROD_ANON = (ADMIN.match(/const CFG=\{url:"[^"]+",key:"([^"]+)"/) || [])[1];
if (!PROD || !PROD_ANON) { console.log("GATE_FAILED:admin_save_draft_ui_cfg_parse"); process.exit(1); }
const PROD_HOST = new URL(PROD).host;
const EM_SAMPLE = (ADMIN.match(/const EM_SAMPLE='([^']*)';/) || [])[1];
const FIXTURE = readFileSync(join(HERE, "fixtures/save_draft_synthetic.html"), "utf8");
const require = createRequire(import.meta.url);
if (!E.SUPABASE_JS_UMD && require("@supabase/supabase-js/package.json").version !== "2.117.2") { console.log("GATE_FAILED:admin_save_draft_ui_supabase_js_pin"); process.exit(1); }
const SUPA_UMD = readFileSync(E.SUPABASE_JS_UMD || require.resolve("@supabase/supabase-js/dist/umd/supabase.js"));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const SECRETS = [E.CRM_PW, E.CRM_JWT, E.ANON_KEY, E.SERVICE_KEY, E.SUPER_JWT, E.MEMBER_JWT, E.ANALYST_JWT, PROD_ANON].filter((s) => s && s.length >= 8);
const ALLOWED_ACTIONS = new Set(["list", "get", "validate", "create", "save"]);
const ALLOWED_VARS = ["first_name", "city_name", "trip_start_date", "trip_end_date", "days_until_trip", "unsubscribe_url"];
const LEAK_RE = /validation_failed|internal_error|bad_|P0001|supabase|postgres|\brpc\b|admin_w_|admin_q_|stack|Error:|TypeError|undefined|\[object|style-prop-unlisted|style-decl-denied|bad-proto|\battr:/i;

const fails = []; const net = []; const violations = []; const dialogs = []; const consoleLines = [];
let delayMs = 0;
const LIST_LAG = Math.max(0, Number(E.SAVE_DRAFT_UI_LIST_LAG_MS || 0) || 0);
let hold = null;   // holds the NEXT email-api POST of one action at the router until the test releases it
function holdNext(action) { let reached, release; const r = new Promise((x) => { reached = x; }), g = new Promise((x) => { release = x; });
  hold = { action, reached, gate: g }; return { reached: r, release: () => release() }; }
const check = (name, cond, extra) => { if (cond) console.log("PASS " + name); else { fails.push(name); console.log("FAIL " + name + (extra ? " :: " + String(extra).slice(0, 300) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function leakFree(text) {
  let t = String(text); for (const v of ALLOWED_VARS) t = t.split(v).join("");
  return !/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(t) && !LEAK_RE.test(t);
}
function secretFree(text) { const t = String(text); return !/Bearer\s|eyJ[A-Za-z0-9_-]{6,}/.test(t) && SECRETS.every((s) => !t.includes(s)); }

// ---------- request router ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
const corsFor = (req) => ({ "access-control-allow-origin": req.headers()["origin"] || SITE_ORIGIN, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "vary": "Origin" });
async function routeAll(route) {
  const req = route.request(); const u = new URL(req.url());
  try {
    if (u.host === "www.asalocal.club") {
      let p = decodeURIComponent(u.pathname);
      if (p.startsWith("/vendor/grapesjs/")) p = "/CDP3B/vendor/grapesjs/" + p.slice("/vendor/grapesjs/".length);
      const f = normalize(join(SITE, p));
      if (req.method() !== "GET" || !f.startsWith(SITE + "/") || /\/\.|node_modules/.test(p) || !existsSync(f) || statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({ status: 200, headers: { "content-type": MIME[extname(f)] || "application/octet-stream" }, body: readFileSync(f) });
    }
    if (u.host === "cdn.jsdelivr.net" && u.pathname.startsWith("/npm/@supabase/supabase-js@2")) return route.fulfill({ status: 200, headers: { "content-type": "application/javascript", "access-control-allow-origin": "*" }, body: SUPA_UMD });
    if (u.host === "cdnjs.cloudflare.com" && u.pathname.includes("/leaflet/")) return route.fulfill({ status: 200, headers: { "content-type": u.pathname.endsWith(".css") ? "text/css" : "application/javascript" }, body: "" });
    if (u.host === PROD_HOST) return await routeProject(route, req, u);
    violations.push("unrouted host " + u.host); return route.abort("blockedbyclient");
  } catch (e) { violations.push("router error " + u.host + u.pathname + " " + String(e && e.message || e).slice(0, 120)); return route.abort("failed"); }
}
async function routeProject(route, req, u) {
  const p = u.pathname, m = req.method();
  if (p === "/functions/v1/email-api") return await routeEmailApi(route, req);
  if (m === "OPTIONS") return route.fulfill({ status: 204, headers: corsFor(req), body: "" });
  if (p.startsWith("/auth/v1/")) return LOCAL ? fakeAuth(route, req, u) : await realAuth(route, req, u);
  if (p.startsWith("/rest/v1/rpc/")) {
    const fn = p.slice("/rest/v1/rpc/".length); let a = {}; try { a = JSON.parse(req.postData() || "{}"); } catch { /* */ }
    const crm = { is_current_user_admin: true }; let v;
    if (fn === "current_user_has_admin_role") v = a.role_name === "crm"; else if (fn in crm) v = crm[fn]; else if (fn.startsWith("_can_")) v = false;
    else { violations.push("unexpected rpc " + fn); return route.abort("blockedbyclient"); }
    return route.fulfill({ status: 200, headers: { "content-type": "application/json", ...corsFor(req) }, body: JSON.stringify(v) });
  }
  if (/^\/rest\/v1\/(venues|cities|comments|ads|site_content)$/.test(p) && m === "GET") return route.fulfill({ status: 200, headers: { "content-type": "application/json", ...corsFor(req) }, body: "[]" });
  if (p === "/functions/v1/admin-api") return route.fulfill({ status: 503, headers: { "content-type": "application/json", ...corsFor(req) }, body: JSON.stringify({ ok: false, error: "not_in_test" }) });
  violations.push("unrouted project path " + m + " " + p); return route.abort("blockedbyclient");
}
function rewriteHeaders(h, keepUserBearer) {
  const out = { ...h }; for (const k of Object.keys(out)) if (k.startsWith(":") || k === "host" || k === "content-length") delete out[k];
  if (!LOCAL) out["apikey"] = E.ANON_KEY;
  const auth = out["authorization"] || "";
  if (!LOCAL && (!keepUserBearer || auth === "Bearer " + PROD_ANON)) out["authorization"] = "Bearer " + E.ANON_KEY;   // anon Authorization -> local anon
  return out;
}
async function realAuth(route, req, u) {
  const target = E.API_URL.replace(/\/$/, "") + u.pathname + u.search;
  const resp = await route.fetch({ url: target, headers: rewriteHeaders(await req.allHeaders(), true) });
  const headers = { ...resp.headers(), ...corsFor(req) }; delete headers["content-encoding"]; delete headers["content-length"];
  return route.fulfill({ response: resp, headers });
}
function fakeAuth(route, req, u) {
  const json = (s, b) => route.fulfill({ status: s, headers: { "content-type": "application/json", ...corsFor(req) }, body: s === 204 ? "" : JSON.stringify(b) });
  const user = { id: E.CRM_UID, aud: "authenticated", role: "authenticated", email: E.CRM_EMAIL, app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password") {
    let b = {}; try { b = JSON.parse(req.postData() || "{}"); } catch { /* */ }
    if (b.email !== E.CRM_EMAIL || b.password !== E.CRM_PW) return json(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
    return json(200, { access_token: E.CRM_JWT, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "local-refresh-" + randomUUID(), user });
  }
  if (u.pathname === "/auth/v1/user") return (req.headers()["authorization"] === "Bearer " + E.CRM_JWT) ? json(200, user) : json(401, { msg: "invalid" });
  if (u.pathname === "/auth/v1/logout") return json(204);
  violations.push("unrouted auth path " + u.pathname); return route.abort("blockedbyclient");
}
async function routeEmailApi(route, req) {
  const m = req.method(); let action = null, tid = null, cls = null;
  if (m === "POST") { try { const b = JSON.parse(req.postData() || "{}"); action = b.action || null; tid = b.template_id || null; cls = b.email_class || null; } catch { /* */ } }
  if (m === "POST" && !ALLOWED_ACTIONS.has(action)) { violations.push("email-api action not allowed: " + action); return route.abort("blockedbyclient"); }
  if (m !== "POST" && m !== "OPTIONS") { violations.push("email-api method " + m); return route.abort("blockedbyclient"); }
  if (delayMs && m === "POST") await sleep(delayMs);
  if (hold && m === "POST" && hold.action === action) { const h = hold; hold = null; h.reached(); await h.gate; }
  const resp = await route.fetch({ url: E.EMAIL_API_URL, headers: rewriteHeaders(await req.allHeaders(), true) });   // Origin + user Bearer kept
  if (m === "POST") net.push({ action, status: resp.status(), tid, cls });
  if (LIST_LAG && m === "POST" && action === "list") await sleep(LIST_LAG);
  if (m === "OPTIONS" && resp.status() !== 200 && resp.status() !== 204) violations.push("email-api preflight " + resp.status());
  return route.fulfill({ response: resp });
}

// ---------- run ----------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });   // no recordVideo/recordHar, no tracing
const page = await context.newPage();
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
page.on("console", (msg) => consoleLines.push(msg.text()));
page.on("pageerror", (e) => consoleLines.push("pageerror " + String(e && e.message || e)));
await context.route("**/*", routeAll);
const calls = (from) => net.slice(from).map((n) => n.action);
const ui = () => page.evaluate(() => ({ status: (document.getElementById("emStatus") || {}).innerText || "", report: (document.getElementById("emReport") || {}).innerText || "",
  list: (document.getElementById("emList") || {}).innerText || "", listStatus: (document.getElementById("emListStatus") || {}).innerText || "", nav: (document.querySelector("#nav button.on") || {}).innerText || "" }));
async function waitFor(fn, ms = 15000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } }
async function openEmail() { await page.click('#nav button:has-text("E-posta")'); await waitFor(async () => !/Yükleniyor/.test((await ui()).list)); }
async function newImport() { await page.click('button:has-text("+ HTML içe aktar")'); await page.waitForSelector("#em_src"); }
// the previous save has fully ended (busy state cleared after its list refresh rendered): the editor's save button is enabled again
const idle = () => page.waitForFunction(() => [...document.querySelectorAll("#emEditor button")].some((b) => /^emSave\b/.test(b.getAttribute("onclick") || "") && !b.disabled), null, { timeout: 15000 });
const tag = randomUUID().slice(0, 8);
const NAME = "TEST UI save-draft " + tag;

try {
  // login through the real form
  await page.goto(SITE_ORIGIN + "/CDP3B/admin.html", { waitUntil: "load" });
  await page.waitForSelector("#le");
  await page.fill("#le", E.CRM_EMAIL); await page.fill("#lp", E.CRM_PW); await page.click("#abtn");
  check("login via the real form (crm user) -> nav", !!(await waitFor(() => page.$("#nav button"))), (await ui()).nav);

  // U1 — '+ HTML içe aktar' starts empty; fill test-named template, Transactional, synthetic fixture
  await openEmail(); await newImport();
  const f0 = await page.evaluate(() => ({ name: em_name.value, subject: em_subject.value, src: em_src.value, cls: em_class.value }));
  check("U1 fields empty (no 'Claude Design', no EM_SAMPLE) and class unselected", f0.name === "" && f0.subject === "" && f0.src === "" && f0.cls === "", JSON.stringify(f0).slice(0, 200));
  await page.fill("#em_name", NAME); await page.selectOption("#em_class", "transactional"); await page.fill("#em_src", FIXTURE);

  // U2 — one click -> exactly 1 validate, 1 create, 1 save; status line; no dialog; row appears, editor stays open
  let n0 = net.length; const d0 = dialogs.length;
  await page.click('#emEditor button:has-text("Taslak kaydet")');
  const st = await waitFor(async () => { const s = (await ui()).status; return /Taslak kaydedildi/.test(s) || /notice err/.test(await page.innerHTML("#emStatus")) ? s : null; });
  await waitFor(async () => (await ui()).list.includes(NAME), 5000);
  check("U2 status 'Taslak kaydedildi: «name» · taslak (yayınlanmadı) · e-posta gönderilmedi'", st && st.includes("Taslak kaydedildi: «" + NAME + "» · taslak (yayınlanmadı) · e-posta gönderilmedi"), st);
  check("U2 network: exactly validate, create, save (+ list refresh), no publish", JSON.stringify(calls(n0).filter((a) => a !== "list")) === '["validate","create","save"]' && net.slice(n0).every((n) => n.status === 200), JSON.stringify(net.slice(n0)));
  check("U2 no dialog on success", dialogs.length === d0, dialogs.slice(d0).join(" | "));
  const u2 = await ui();
  check("U2 sanitizer summary shown (style block, meta, background/opacity/overflow)", ["<style> bloğu (mobil kurallar dahil) kaldırıldı", "meta etiketleri kaldırıldı", "background/opacity/overflow stilleri kaldırıldı"].every((s) => u2.status.includes(s) && u2.report.includes(s)), u2.report.slice(0, 300));
  check("U2 row in #emList while the editor stays open", u2.list.includes(NAME) && (await page.$("#em_src")) !== null && (await page.inputValue("#em_src")) === FIXTURE);
  check("U2 class locked after create", await page.evaluate(() => em_class.disabled));
  check("U2 visible text leak-free", leakFree(u2.status + u2.report + u2.list), (u2.status + u2.report).slice(0, 300));

  // U3 — reload lands on E-posta (F9); row visible; 'Aç' restores the byte-exact source; class locked showing transactional
  await page.reload({ waitUntil: "load" });
  const u3nav = await waitFor(async () => { const x = await ui(); return x.nav === "E-posta" && x.list.includes(NAME) ? x : null; });
  check("U3 reload -> E-posta tab with the saved row", !!u3nav, JSON.stringify(await ui()).slice(0, 300));
  const row = page.locator("#emList tr", { hasText: NAME });
  check("U3 list row: Draft 1, unpublished", (await row.count()) === 1 && /Transactional\s+HTML içe aktarma\s+Taslak\s+1\s+–/.test(await row.innerText()), await row.innerText().catch(() => ""));
  n0 = net.length; await row.locator('button:has-text("Aç")').click();
  await page.waitForSelector("#em_src"); await waitFor(async () => (await ui()).report.length > 0);
  const opened = await page.evaluate(() => ({ src: em_src.value, cls: em_class.value, dis: em_class.disabled, name: em_name.value, ro: em_name.readOnly && em_desc.readOnly }));
  check("U3 'Aç' fills em_src byte-exact (sha256) and the locked class shows transactional", sha(opened.src) === sha(FIXTURE) && opened.cls === "transactional" && opened.dis && opened.name === NAME, JSON.stringify({ cls: opened.cls, dis: opened.dis }));
  check("U3 name/description read-only on reopen (save never renames)", opened.ro);
  check("U3 reopen requests: get + validate only (F10: no asset_preview)", JSON.stringify(calls(n0)) === '["get","validate"]', JSON.stringify(calls(n0)));

  // U4 — edit and save: status updates, still one row with Draft 1
  await page.fill("#em_src", FIXTURE.replace("sentetik bir test", "güncellenmiş sentetik bir test"));
  n0 = net.length; await page.click('#emEditor button:has-text("Taslak kaydet")');
  const st4 = await waitFor(async () => { const s = (await ui()).status; return /Taslak kaydedildi/.test(s) ? s : null; });
  await waitFor(async () => calls(n0).includes("list"), 5000); await idle();
  check("U4 second save: validate + save only, status updated", st4 && JSON.stringify(calls(n0).filter((a) => a !== "list")) === '["validate","save"]', JSON.stringify(calls(n0)));
  const rows4 = page.locator("#emList tr", { hasText: NAME });
  check("U4 still exactly one row, Draft 1", (await rows4.count()) === 1 && /Taslak\s+1\s+–/.test(await rows4.innerText()));

  // U6 — bad inputs: marketing without unsubscribe -> NO create; empty name / no class / reply_to 'x' / EM_SAMPLE -> 0 requests
  await openEmail(); await newImport();
  await page.fill("#em_name", "TEST UI marketing " + tag); await page.selectOption("#em_class", "marketing"); await page.fill("#em_src", FIXTURE);
  n0 = net.length; await page.click('#emEditor button:has-text("Taslak kaydet")');
  const st6 = await waitFor(async () => { const s = (await ui()).status; return /Kaydedilmedi/.test(s) ? s : null; });
  check("U6 marketing w/o unsubscribe: validate only, NO create", JSON.stringify(calls(n0)) === '["validate"]', JSON.stringify(calls(n0)));
  check("U6 plain unsubscribe sentence", st6 && st6.includes("Marketing e-postasında abonelikten çıkış bağlantısı ({{unsubscribe_url}}) yok."), st6);
  const u6 = await ui(); check("U6 visible text leak-free after failure", leakFree(u6.status + u6.report + u6.list), (u6.status + u6.report).slice(0, 300));
  const bad = [
    [{ name: "", cls: "transactional", src: FIXTURE }, "Şablon adı gerekli."],
    [{ name: "TEST UI x " + tag, cls: "", src: FIXTURE }, "E-posta sınıfını seç (Marketing / Transactional)."],
    [{ name: "TEST UI x " + tag, cls: "transactional", src: FIXTURE, reply: "x" }, "Reply-to boş bırakılmalı"],
    [{ name: "TEST UI x " + tag, cls: "marketing", src: EM_SAMPLE }, "Bu, editörün örnek içeriği."],
  ];
  for (const [v, msg] of bad) {
    await newImport();
    await page.fill("#em_name", v.name); if (v.cls) await page.selectOption("#em_class", v.cls); await page.fill("#em_src", v.src); if (v.reply) await page.fill("#em_reply", v.reply);
    n0 = net.length; await page.click('#emEditor button:has-text("Taslak kaydet")');
    const s = await waitFor(async () => { const t = (await ui()).status; return t.includes(msg) ? t : null; }, 5000);
    check("U6 '" + msg.slice(0, 30) + "' -> plain message, 0 requests", !!s && net.length === n0, (await ui()).status);
    check("U6 leak-free (" + msg.slice(0, 20) + ")", leakFree((await ui()).status));
  }

  // U7 — double click on a NEW template: buttons disabled in flight; 1 validate, 1 create, 1 save; 1 row
  await newImport(); const NAME7 = "TEST UI dblclick " + tag;
  await page.fill("#em_name", NAME7); await page.selectOption("#em_class", "transactional"); await page.fill("#em_src", FIXTURE);
  delayMs = 400; n0 = net.length;
  await page.dblclick('#emEditor button:has-text("Taslak kaydet")');
  await sleep(150);
  const disabledInFlight = await page.evaluate(() => [...document.querySelectorAll("#emEditor button")].filter((b) => /^(emSave|emPublish|emValidate)\b/.test(b.getAttribute("onclick") || "")).every((b) => b.disabled));
  await waitFor(async () => /Taslak kaydedildi/.test((await ui()).status), 15000); await waitFor(async () => calls(n0).includes("list"), 5000);
  await idle(); await waitFor(async () => (await ui()).list.includes(NAME7), 5000); delayMs = 0;   // rendered list, not just the logged request
  check("U7 buttons disabled while in flight", disabledInFlight);
  check("U7 dblclick -> exactly 1 validate, 1 create, 1 save", JSON.stringify(calls(n0).filter((a) => a !== "list")) === '["validate","create","save"]', JSON.stringify(calls(n0)));
  check("U7 exactly one row for that name", (await page.locator("#emList tr", { hasText: NAME7 }).count()) === 1);

  // U8 — race: save of the reopened NAME in flight, then 'Aç' on NAME7 -> refused with a plain sentence; the save keeps NAME's id
  n0 = net.length; await page.locator("#emList tr", { hasText: NAME }).first().locator('button:has-text("Aç")').click();
  await waitFor(async () => calls(n0).includes("validate"));
  const idA = (net.slice(n0).find((x) => x.action === "get") || {}).tid;
  const SRC8 = FIXTURE.replace("sentetik bir test", "yarış sentetik bir test");
  await page.fill("#em_src", SRC8); delayMs = 700; n0 = net.length;
  await page.click('#emEditor button:has-text("Taslak kaydet")'); await sleep(150);
  await page.locator("#emList tr", { hasText: NAME7 }).locator('button:has-text("Aç")').click();
  const busy8 = await waitFor(async () => (await ui()).listStatus.includes("Kaydetme sürüyor; bitince tekrar dene.") ? true : null, 3000);
  const st8 = await waitFor(async () => { const s = (await ui()).status; return /Taslak kaydedildi/.test(s) ? s : null; }, 15000);
  await waitFor(async () => calls(n0).includes("list"), 5000); await idle(); delayMs = 0;
  const save8 = net.slice(n0).find((x) => x.action === "save") || {};
  check("U8 'Aç' on another row while saving -> plain busy sentence, no get", !!busy8 && !calls(n0).includes("get"), JSON.stringify(calls(n0)));
  check("U8 the in-flight save keeps the original template id and names it", !!idA && save8.tid === idA && !!st8 && st8.includes("«" + NAME + "»"), JSON.stringify({ same: save8.tid === idA }));
  check("U8 editor still shows the saved template", (await page.inputValue("#em_src")) === SRC8 && leakFree((await ui()).listStatus + (await ui()).status));
  n0 = net.length; await page.locator("#emList tr", { hasText: NAME7 }).locator('button:has-text("Aç")').click();
  await waitFor(async () => calls(n0).includes("validate"));
  const tid7 = (net.slice(n0).find((x) => x.action === "get") || {}).tid;
  check("U8 the other template's draft is unchanged after the race", !!tid7 && tid7 !== idA && sha(await page.inputValue("#em_src")) === sha(FIXTURE));
  check("U8 busy notice cleared after the save", !(await ui()).listStatus.includes("Kaydetme sürüyor"));

  // U9 — F4 mid-flight: class/name/description changed (real selectOption/fill) while the validate of a NEW template is held ->
  //      after create the locked select and read-only fields show what create stored; the next save validates/saves under it
  await idle(); await newImport(); const NAME9 = "TEST UI class lock " + tag;
  await page.fill("#em_name", NAME9); await page.selectOption("#em_class", "transactional"); await page.fill("#em_src", FIXTURE);
  const h9 = holdNext("validate"); n0 = net.length;
  await page.click('#emEditor button:has-text("Taslak kaydet")');
  const held9 = await Promise.race([h9.reached.then(() => true), sleep(15000).then(() => false)]); if (!held9) hold = null;
  check("U9 the new template's validate is held at the router", held9);
  const mid9 = await page.evaluate(() => ({ dis: em_class.disabled, ro: em_name.readOnly || em_desc.readOnly }));
  if (!mid9.dis && !mid9.ro) {   // editable in flight (current design) -> the user can change them; a design that locks them in flight is safe too
    await page.selectOption("#em_class", "marketing"); await page.fill("#em_name", NAME9 + " yeniden"); await page.fill("#em_desc", "uçuşta değişti");
  }
  h9.release();
  const st9 = await waitFor(async () => { const s = (await ui()).status; return /Taslak kaydedildi/.test(s) ? s : null; }); await idle();
  const after9 = await page.evaluate(() => ({ cls: em_class.value, dis: em_class.disabled, name: em_name.value, desc: em_desc.value, ro: em_name.readOnly && em_desc.readOnly }));
  const create9 = net.slice(n0).find((x) => x.action === "create") || {}, save9 = net.slice(n0).find((x) => x.action === "save") || {};
  check("U9 create and save used the class at click time (transactional)", create9.cls === "transactional" && save9.cls === "transactional" && !!save9.tid && !!st9 && st9.includes("«" + NAME9 + "»"), JSON.stringify({ c: create9.cls, s: save9.cls }));
  check("U9 locked select + read-only name/description show what create stored (not the mid-flight edits)", after9.cls === "transactional" && after9.dis && after9.name === NAME9 && after9.desc === "" && after9.ro, JSON.stringify(after9));
  await waitFor(async () => (await ui()).list.includes(NAME9), 5000);
  const row9 = page.locator("#emList tr", { hasText: NAME9 });
  check("U9 one row, stored class Transactional, stored name unchanged", (await row9.count()) === 1 && /Transactional/.test(await row9.innerText()) && !(await ui()).list.includes(NAME9 + " yeniden"), await row9.first().innerText().catch(() => ""));
  await page.fill("#em_src", FIXTURE.replace("sentetik bir test", "kilit sentetik bir test")); n0 = net.length;
  await page.click('#emEditor button:has-text("Taslak kaydet")'); await waitFor(async () => calls(n0).includes("save")); await idle();
  const nx9 = net.slice(n0).filter((x) => x.action === "validate" || x.action === "save");
  check("U9 next save: validate + save under the stored class, same template", JSON.stringify(nx9.map((x) => x.action)) === '["validate","save"]' && nx9.every((x) => x.cls === "transactional" && x.status === 200) && nx9[1].tid === save9.tid, JSON.stringify(nx9.map((x) => [x.action, x.cls, x.status])));

  // U5 — CAPS.crm=false: no 'Taslak kaydet' button; emSave() false + 'Bu veriye erişim yetkiniz yok.'; 0 requests
  n0 = net.length;
  const u5 = await page.evaluate(async () => { CAPS.crm = false; emNewImport(); const hasBtn = [...document.querySelectorAll("#emEditor button")].some((b) => /Taslak kaydet/.test(b.textContent));
    const r = await emSave(); return { hasBtn, r, st: document.getElementById("emStatus").innerText }; });
  check("U5 crm=false: no save button, emSave false, plain 403 text, 0 requests", !u5.hasBtn && u5.r === false && u5.st.includes("Bu veriye erişim yetkiniz yok.") && net.length === n0, JSON.stringify(u5));

  // secrets / leaks across the whole run
  const bodyText = await page.evaluate(() => document.body.innerText);
  check("no token/key/Bearer in page text", secretFree(bodyText));
  check("no token/key/Bearer in console output", consoleLines.every(secretFree), consoleLines.filter((l) => !secretFree(l)).length + " lines");
  check("no token/key/Bearer in dialogs (and no dialogs at all)", dialogs.every(secretFree) && dialogs.length === 0, dialogs.join(" | "));
  check("no page errors", !consoleLines.some((l) => l.startsWith("pageerror")), consoleLines.filter((l) => l.startsWith("pageerror")).join(" | "));
  check("network allowlist: only list/get/validate/create/save reached email-api; every host/path routed", violations.length === 0 && net.every((x) => ALLOWED_ACTIONS.has(x.action)), violations.join(" | "));
} catch (e) {
  fails.push("harness"); console.log("FAIL harness :: " + String(e && e.message || e).split("\n")[0].slice(0, 300));
} finally {
  await context.close(); await browser.close();
}
if (fails.length) { console.log("ADMIN_SAVE_DRAFT_UI_FAIL " + fails.length); process.exit(1); }
console.log("ADMIN_SAVE_DRAFT_UI_OK");
