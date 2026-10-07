// WP4 · üye hesabı ve profil navigasyonu — Playwright end-to-end tests.
//
// Serves the repo root with `python3 -m http.server` on 127.0.0.1 and drives the real index.html (and
// amsterdam/index.html for the prefs label) in Chromium. Every non-local request is answered by a route()
// stub: supabase-js → WP4 stub (auth session, members/trips select with RLS-like filtering,
// consent_get_my_state / service_pref_set / trip_save), Leaflet → WP3 stub, fonts/images → empty.
// cdn.tailwindcss.com → the page's own Tailwind config compiled locally (tailwind_css.mjs), so layout checks
// (390px overflow, fixed overlays, outside click) see real utility classes. Never reaches *.supabase.co.
//
//   NODE_PATH=<playwright + tailwindcss deps> node WP4_package/tests/wp4_e2e.mjs
//   env: WP4_VIEWPORTS=desktop,mobile (default both)  WP4_ONLY=<scenario substring>
//        WP4_SCOPE_CHECKS=1 → also run the one-shot "this PR only" checks (Profilim has no form field at all, WP5 slot
//        still hidden). Off by default so a later package (WP5 adds name fields to the slot) does not turn this gate red.
//
// Output: one PASS/FAIL line per check and the sentinel WP4_E2E_PASS (exit 0), WP4_E2E_FAIL (exit 1) or
// WP4_E2E_INCOMPLETE (exit 4: Tailwind build deps missing → layout checks could not run; not a PASS).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { tailwindAvailable, buildTailwindCss, cdnShim } from "./tailwind_css.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const ONLY = process.env.WP4_ONLY || "";
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };
const WANT_VP = (process.env.WP4_VIEWPORTS || "desktop,mobile").split(",").filter((v) => VIEWPORTS[v]);
const SCOPE = process.env.WP4_SCOPE_CHECKS === "1";

const SUPA_STUB = readFileSync(join(HERE, "stubs", "supabase_stub.js"), "utf8");
const LEAFLET_STUB = readFileSync(join(REPO, "WP3_package", "tests", "stubs", "leaflet_stub.js"), "utf8");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const HAS_CSS = tailwindAvailable();
const HOME_CSS = HAS_CSS ? cdnShim(await buildTailwindCss(readFileSync(join(REPO, "index.html"), "utf8"))) : null;

const UID = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const TEST_MAIL = ["wp4-member", "example.invalid"].join("@"); // built at runtime; no address literal in the file
const MENU = ["Profilim", "E-posta tercihlerim", "Kayıtlı seyahatlerim", "Yeni seyahat oluştur", "Çıkış yap"];
const PREF_KEYS = ["trip_created_confirmation", "trip_updated_confirmation", "trip_start_minus_7_days", "trip_start_minus_1_day", "plan_saved_confirmation", "plan_reminder"];
const LIVE_PREFS = Object.assign(Object.fromEntries(PREF_KEYS.map((k) => [k, "not_configured"])), { welcome_service_email: true });
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const XSS_NAME = '<img src=x onerror="window.__wp4xss=1">';
const XSS_CITY = "<img src=x onerror=window.__wp4xss=2>');window.__wp4xss=3;//";
const DATES_HINT = "Seyahatin kaydedilmesi için gidiş ve dönüş tarihlerini seç.";
const ymd = (d) => d.toISOString().slice(0, 10);
const inDays = (n) => ymd(new Date(Date.now() + n * 86400000));

let fails = 0, passes = 0, skips = 0;
const thirdParty = new Map();
function ok(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { fails++; console.log("FAIL " + name + (detail ? "  :: " + detail : "")); }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}
async function startServer() {
  const port = await freePort();
  const proc = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", REPO], { stdio: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(origin + "/CNAME"); if (r.ok) return { proc, origin }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("static server did not start");
}

const member = (extra = {}) => Object.assign({ user_id: UID, display_name: "Deniz", blocked: false, tier: "Kaşif", points: 3, email: TEST_MAIL }, extra);
const tripRow = (id, city, s, e, uid = UID) => ({ id, user_id: uid, city, country: city === "Kopenhag" ? "Danimarka" : "Hollanda", start_date: s, end_date: e, timezone: "Europe/Amsterdam", setup_completed: true, revision: 1, archived_at: null, preferences: {} });
const memberSupa = (o = {}) => Object.assign({ user: { id: UID, email: TEST_MAIL }, tables: { members: [member(o.member)], trips: o.trips || [] }, prefs: LIVE_PREFS }, o.supa || {});

async function newContext(browser, origin, vp, supa) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], serviceWorkers: "block" });
  const localHits = [];
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === origin) {
      localHits.push(u.pathname);
      if (u.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
      return route.continue();
    }
    const key = u.host + u.pathname.replace(/\/[^/]*\.(png|jpe?g|webp|gif)$/i, "/*");
    thirdParty.set(key, (thirdParty.get(key) || 0) + 1);
    if (u.host === "cdn.tailwindcss.com") return route.fulfill({ status: 200, contentType: "application/javascript", body: HOME_CSS || "window.tailwind={config:{}};" });
    if (u.host === "unpkg.com" && u.pathname.includes("leaflet")) {
      if (u.pathname.endsWith(".css")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return route.fulfill({ status: 200, contentType: "application/javascript", body: LEAFLET_STUB });
    }
    if (u.host === "cdn.jsdelivr.net" && u.pathname.includes("supabase-js")) return route.fulfill({ status: 200, contentType: "application/javascript", body: SUPA_STUB });
    const rt = req.resourceType();
    if (rt === "stylesheet") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (rt === "script") return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (rt === "image") return route.fulfill({ status: 200, contentType: "image/gif", body: GIF });
    if (rt === "font") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 204, body: "" });
  });
  await ctx.addInitScript((s) => { window.__WP4_SUPA = s; }, supa || {});
  return { ctx, localHits };
}
function attach(page, bucket) {
  page.on("pageerror", (e) => bucket.push({ kind: "pageerror", text: String((e && e.message) || e) }));
  page.on("console", (m) => { if (m.type() === "error") bucket.push({ kind: "console", text: m.text(), url: (m.location() || {}).url || "" }); });
}

/* ---------- page helpers ---------- */
async function openHome(page, origin, opts = {}) {
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => ASA_DLG && document.getElementById("countrySel").options.length > 1, null, { timeout: 10000 });
  if (opts.member) await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 10000 });
  await page.waitForTimeout(80);
}
const supaLog = (page) => page.evaluate(() => (window.__WP4_SUPA_LOG || []).slice());
const writes = (log) => log.filter((e) => ["insert", "upsert", "update", "delete"].includes(e.op) || (e.op === "rpc" && !["consent_get_my_state"].includes(e.name)));
const isOpen = (page, id) => page.evaluate((i) => { const el = document.getElementById(i); return !!el && getComputedStyle(el).display !== "none" && ASA_DLG.isOpen(el); }, id);
// role, aria-modal and the accessible name taken from aria-labelledby
const dlgInfo = (page, id) => page.evaluate((i) => {
  const p = document.querySelector("#" + i + ' [role="dialog"]'); if (!p) return null;
  const lb = p.getAttribute("aria-labelledby"); const t = lb && document.getElementById(lb);
  return { role: p.getAttribute("role"), modal: p.getAttribute("aria-modal"), name: t ? t.textContent.trim() : null, overflowX: p.scrollWidth > p.clientWidth + 1 };
}, id);
const active = (page) => page.evaluate(() => { const a = document.activeElement; return { id: a && a.id, text: a && a.textContent.trim(), acct: a && a.getAttribute("data-acct"), inMenu: !!(a && a.closest && a.closest('#acctMenu [role="dialog"]')), dlg: a && a.closest && a.closest('[role="dialog"]') ? a.closest('[role="dialog"]').parentElement.id : null }; });
const noOverflow = (page, vp) => vp !== "mobile" ? Promise.resolve(true) : page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const acctAttrs = (page) => page.evaluate(() => { const b = document.getElementById("acctBtn"); return { label: b.getAttribute("aria-label"), haspopup: b.getAttribute("aria-haspopup"), expanded: b.getAttribute("aria-expanded"), controls: b.getAttribute("aria-controls"), text: b.textContent, children: b.children.length }; });
async function openMenu(page) { await page.click("#acctBtn"); await page.waitForFunction(() => ASA_DLG.isOpen(document.getElementById("acctMenu"))); }
async function menuItem(page, label) { await page.locator("#acctMenu nav button", { hasText: label }).click(); }
// a point on the dark backdrop outside the dialog panel, verified with elementFromPoint
async function backdropPoint(page, id) {
  return page.evaluate((i) => {
    const ov = document.getElementById(i);
    for (const [x, y] of [[4, 4], [6, Math.floor(innerHeight / 2)], [innerWidth - 4, innerHeight - 4], [4, innerHeight - 4]]) if (document.elementFromPoint(x, y) === ov) return { x, y };
    return null;
  }, id);
}
async function waitPrefsRows(page) { await page.waitForFunction(() => document.querySelectorAll("#prefsBody [data-pref-row]").length > 0 || document.getElementById("prefsErr").textContent.length > 0, null, { timeout: 5000 }); }
const prefRows = (page) => page.evaluate(() => [...document.querySelectorAll("#prefsBody [data-pref-row]")].map((r) => { const b = r.querySelector("button"); return { key: r.getAttribute("data-pref-row"), state: r.querySelector("[data-pref-state]").getAttribute("data-pref-state"), stateText: r.querySelector("[data-pref-state]").textContent, btn: b.textContent, btnLabel: b.getAttribute("aria-label"), disabled: b.disabled }; }));

/* ---------- scenarios ---------- */
const scenarios = [];
const sc = (name, fn, opts = {}) => scenarios.push({ name, fn, opts });

sc("anon: account icon opens login/signup only — no private menu, no private data", async ({ page, origin, vp, t }) => {
  await openHome(page, origin);
  const a = await acctAttrs(page);
  t("anon label", a.label === "Giriş yap / üye ol" && a.text === "Giriş", JSON.stringify(a));
  t("anon has no menu popup attrs", a.haspopup === null && a.expanded === null && a.controls === null);
  await page.click("#acctBtn");
  t("auth dialog open", await isOpen(page, "authModal"));
  const d = await dlgInfo(page, "authModal");
  t("auth dialog role/modal/name", d.role === "dialog" && d.modal === "true" && d.name === "asalocal üyeliği", JSON.stringify(d));
  t("focus moved into dialog (email field)", (await active(page)).id === "amEmail");
  t("inputs have labels", await page.evaluate(() => ["amEmail", "amPw"].every((id) => { const l = document.querySelector('label[for="' + id + '"]'); return l && l.textContent.trim().length > 0; })));
  t("error region role=alert", (await page.getAttribute("#amErr", "role")) === "alert");
  t("close button named Kapat", (await page.getAttribute("#authX", "aria-label")) === "Kapat");
  t("no private menu open", !(await isOpen(page, "acctMenu")) && !(await isOpen(page, "prefsModal")) && !(await isOpen(page, "tripsModal")));
  t("no private copy visible", await page.evaluate(() => !/Profilim|E-posta tercihlerim|Kayıtlı seyahatlerim/.test(document.body.innerText)));
  await page.click("#atSignup");
  t("tab switch keeps focus on the tab", (await active(page)).id === "atSignup");
  t("signup fields labelled", await page.evaluate(() => ["amEmail", "amPw", "amGender", "amCity"].every((id) => !!document.querySelector('label[for="' + id + '"]'))));
  await page.click("#atLogin");
  await page.click("#amAuth");
  t("existing validation copy unchanged (alert)", (await page.textContent("#amErr")) === "Geçerli bir e-posta gir.");
  t("no overflow (auth open)", await noOverflow(page, vp));
  t("auth panel has no inner horizontal overflow", !(await dlgInfo(page, "authModal")).overflowX);
  await page.keyboard.press("Escape");
  t("ESC closes auth", !(await isOpen(page, "authModal")));
  t("focus back on account button", (await active(page)).id === "acctBtn");
  // private entry points called directly as anon fall back to the login dialog
  await page.evaluate(() => { openPrefs(); });
  t("anon openPrefs → login dialog, prefs stays closed", (await isOpen(page, "authModal")) && !(await isOpen(page, "prefsModal")));
  await page.keyboard.press("Escape");
  await page.evaluate(() => openTripsModal());
  t("anon openTripsModal → login dialog, trips stays closed", (await isOpen(page, "authModal")) && !(await isOpen(page, "tripsModal")));
  await page.keyboard.press("Escape");
  await page.evaluate(() => acctAction("profile"));
  t("anon acctAction → login form, never Profilim", (await isOpen(page, "authModal")) && (await dlgInfo(page, "authModal")).name === "asalocal üyeliği");
  const log = await supaLog(page);
  t("anon: no prefs RPC, no trips/members query", !log.some((e) => (e.op === "rpc" && e.name === "consent_get_my_state") || (e.op === "select" && (e.table === "trips" || e.table === "members"))), JSON.stringify(log));
  t("anon: no writes", writes(log).length === 0, JSON.stringify(writes(log)));
}, { supa: { user: null } });

sc("member: account button names the user and opens a menu with exactly the 5 items", async ({ page, origin, vp, t }) => {
  await openHome(page, origin, { member: true });
  const a = await acctAttrs(page);
  t("aria-label Hesabım: <ad>", a.label === "Hesabım: Deniz", JSON.stringify(a));
  t("aria-haspopup=dialog, aria-expanded=false, aria-controls", a.haspopup === "dialog" && a.expanded === "false" && a.controls === "acctMenu");
  await openMenu(page);
  t("aria-expanded=true while open", (await acctAttrs(page)).expanded === "true");
  const d = await dlgInfo(page, "acctMenu");
  t("menu is a named modal dialog", d.role === "dialog" && d.modal === "true" && d.name === "Hesabım", JSON.stringify(d));
  const items = await page.evaluate(() => [...document.querySelectorAll("#acctMenu nav button")].map((b) => b.textContent.trim()));
  t("exactly the 5 items in order", JSON.stringify(items) === JSON.stringify(MENU), JSON.stringify(items));
  t("focus on first item (Profilim)", (await active(page)).text === "Profilim");
  t("menu shows the member name as text", (await page.textContent("#acctMenuWho")) === "Deniz");
  t("no overflow (menu open)", await noOverflow(page, vp));
  t("menu panel has no inner horizontal overflow", !d.overflowX);
  t("no writes at boot/menu", writes(await supaLog(page)).length === 0, JSON.stringify(writes(await supaLog(page))));
}, { supa: memberSupa() });

sc("Profilim: reached in 2 interactions with ZERO trips; read-only; no DB write", async ({ page, origin, vp, t }) => {
  await openHome(page, origin, { member: true });
  t("zero trips → trip hub renders nothing", (await page.evaluate(() => document.getElementById("tripHub").innerHTML)) === "");
  let clicks = 0;
  await page.click("#acctBtn"); clicks++;
  await menuItem(page, "Profilim"); clicks++;
  t("menu closed after choosing", !(await isOpen(page, "acctMenu")));
  t("Profilim open in <= 2 interactions", clicks <= 2 && (await isOpen(page, "authModal")));
  const d = await dlgInfo(page, "authModal");
  t("dialog named Profilim", d.name === "Profilim" && d.role === "dialog" && d.modal === "true", JSON.stringify(d));
  await page.waitForFunction(() => /puan/.test(document.getElementById("amTier").textContent), null, { timeout: 3000 }).catch(() => {});
  const p = await page.evaluate(() => { const F = "input, select, textarea, [contenteditable]"; const slot = document.getElementById("amWp5Slot"); return { name: document.getElementById("amName").textContent, email: document.getElementById("amEmailRo").textContent, tier: document.getElementById("amTier").textContent, slot: slot ? { hidden: slot.hidden, mark: slot.getAttribute("data-wp5-slot") } : null, fields: document.querySelectorAll("#authBody input, #authBody select, #authBody textarea").length, outside: [...document.querySelectorAll("#authBody " + F.split(", ").join(", #authBody "))].filter((el) => !(slot && slot.contains(el))).length }; });
  t("name, email, tier/points shown", p.name === "Deniz" && p.email === TEST_MAIL && p.tier === "🧭 Kaşif · 3 puan", JSON.stringify(p));
  t("WP5 slot present (data-wp5-slot=profile-name)", !!p.slot && p.slot.mark === "profile-name", JSON.stringify(p.slot));
  t("email is display-only: no editable field outside the WP5 slot", p.outside === 0, JSON.stringify(p));
  if (SCOPE) {
    t("[scope] WP5 slot still hidden", p.slot && p.slot.hidden === true);
    t("[scope] profile is read-only in this PR (no form fields at all, no name editing)", p.fields === 0);
  }
  t("focus inside the profile dialog", (await active(page)).dlg === "authModal");
  t("no overflow (profile open)", await noOverflow(page, vp));
  const log = await supaLog(page);
  t("no DB write (no member_upsert_profile, no insert/update)", writes(log).length === 0, JSON.stringify(writes(log)));
  await page.click("#authX");
  t("✕ closes, focus returns to account button", !(await isOpen(page, "authModal")) && (await active(page)).id === "acctBtn");
}, { supa: memberSupa({ trips: [] }) });

sc("E-posta tercihlerim: not_configured → 'Varsayılan belirlenmedi'; toggle → service_pref_set args; error → alert + revert", async ({ page, origin, vp, t }) => {
  await openHome(page, origin, { member: true });
  await openMenu(page);
  await menuItem(page, "E-posta tercihlerim");
  t("prefs dialog open + named", (await isOpen(page, "prefsModal")) && (await dlgInfo(page, "prefsModal")).name === "E-posta tercihlerim");
  await waitPrefsRows(page);
  let rows = await prefRows(page);
  t("7 rows (catalog keys)", rows.length === 7, JSON.stringify(rows));
  t("six not_configured keys → 'Varsayılan belirlenmedi'", PREF_KEYS.every((k) => { const r = rows.find((x) => x.key === k); return r && r.state === "unset" && r.stateText === "Varsayılan belirlenmedi" && r.btn === "Aç"; }), JSON.stringify(rows));
  t("never 'Kapalı' for not_configured", !rows.some((r) => r.stateText === "Kapalı"));
  const w = rows.find((r) => r.key === "welcome_service_email");
  t("welcome_service_email true → Açık / Kapat", w && w.state === "on" && w.stateText === "Açık" && w.btn === "Kapat");
  t("buttons carry the row name", rows.every((r) => /^(Aç|Kapat): .+/.test(r.btnLabel)));
  t("prefs error region role=alert", (await page.getAttribute("#prefsErr", "role")) === "alert");
  t("no overflow (prefs open)", await noOverflow(page, vp));
  t("prefs panel has no inner horizontal overflow", !(await dlgInfo(page, "prefsModal")).overflowX);
  // toggle ON a not_configured key
  await page.click('#prefsBody button[data-prefkey="trip_created_confirmation"]');
  await page.waitForFunction(() => /kaydedildi/.test(document.getElementById("prefsOk").textContent) || document.getElementById("prefsErr").textContent, null, { timeout: 5000 });
  let log = await supaLog(page);
  const sets = log.filter((e) => e.op === "rpc" && e.name === "service_pref_set");
  const a = sets[0] && sets[0].args;
  t("one service_pref_set call", sets.length === 1, JSON.stringify(sets));
  t("args: exactly p_key/p_enabled/p_request_id/p_idem", a && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(["p_enabled", "p_idem", "p_key", "p_request_id"]), JSON.stringify(a));
  t("args values", a && a.p_key === "trip_created_confirmation" && a.p_enabled === true && /^pc-home-\d+$/.test(a.p_request_id) && a.p_request_id.length <= 80 && UUID4.test(a.p_idem), JSON.stringify(a));
  rows = await prefRows(page);
  const tc = rows.find((r) => r.key === "trip_created_confirmation");
  t("row reflects the server result (Açık / Kapat)", tc.state === "on" && tc.stateText === "Açık" && tc.btn === "Kapat" && !tc.disabled, JSON.stringify(tc));
  t("success status, no error", /Seyahat oluşturuldu bilgisi: açık olarak kaydedildi\./.test(await page.textContent("#prefsOk")) && (await page.textContent("#prefsErr")) === "");
  t("focus stays on the toggled row's button", await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-prefkey") === "trip_created_confirmation"));
  // error path: RPC error → alert, row unchanged, no success claim
  await page.evaluate(() => { window.__WP4_SUPA_FAIL_NEXT.service_pref_set = "error"; });
  await page.click('#prefsBody button[data-prefkey="welcome_service_email"]');
  await page.waitForFunction(() => document.getElementById("prefsErr").textContent.length > 0, null, { timeout: 5000 });
  rows = await prefRows(page);
  const w2 = rows.find((r) => r.key === "welcome_service_email");
  t("error → alert text", (await page.textContent("#prefsErr")) === "İşlem tamamlanamadı. Tekrar dene.");
  t("error → state reverted/unchanged (Açık / Kapat, enabled)", w2.state === "on" && w2.stateText === "Açık" && w2.btn === "Kapat" && !w2.disabled, JSON.stringify(w2));
  t("error → no success message", (await page.textContent("#prefsOk")) === "");
  t("error → all buttons re-enabled", rows.every((r) => !r.disabled));
  // {ok:false} response is an error too
  await page.evaluate(() => { window.__WP4_SUPA_FAIL_NEXT.service_pref_set = "notok"; });
  await page.click('#prefsBody button[data-prefkey="plan_reminder"]');
  await page.waitForFunction(() => document.getElementById("prefsErr").textContent.length > 0, null, { timeout: 5000 });
  const pr = (await prefRows(page)).find((r) => r.key === "plan_reminder");
  t("ok:false → alert, still 'Varsayılan belirlenmedi'", pr.state === "unset" && pr.stateText === "Varsayılan belirlenmedi" && (await page.textContent("#prefsOk")) === "");
  log = await supaLog(page);
  const idems = log.filter((e) => e.op === "rpc" && e.name === "service_pref_set").map((e) => e.args.p_idem);
  t("a fresh idempotency uuid per action", idems.length === 3 && new Set(idems).size === 3 && idems.every((x) => UUID4.test(x)), JSON.stringify(idems));
  t("only prefs RPCs were called", writes(log).every((e) => e.op === "rpc" && e.name === "service_pref_set"), JSON.stringify(writes(log)));
  await page.keyboard.press("Escape");
  t("ESC closes prefs, focus to account button", !(await isOpen(page, "prefsModal")) && (await active(page)).id === "acctBtn");
}, { supa: memberSupa() });

sc("E-posta tercihlerim: load error → alert, no rows, nothing claimed", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true });
  await openMenu(page);
  await menuItem(page, "E-posta tercihlerim");
  await waitPrefsRows(page);
  t("load error alert", (await page.textContent("#prefsErr")) === "Tercihler yüklenemedi. Biraz sonra tekrar dene.");
  t("no rows rendered", (await prefRows(page)).length === 0);
  t("no success text", (await page.textContent("#prefsOk")) === "");
}, { supa: memberSupa({ supa: { rpcError: { consent_get_my_state: "stub failure" } } }) });

sc("Kayıtlı seyahatlerim: zero trips → empty state; 'Yeni seyahat oluştur' closes and focuses the search form", async ({ page, origin, vp, t }) => {
  await openHome(page, origin, { member: true });
  await openMenu(page);
  await menuItem(page, "Kayıtlı seyahatlerim");
  await page.waitForSelector("#tripsEmptyNew", { timeout: 5000 });
  const d = await dlgInfo(page, "tripsModal");
  t("trips dialog open + named", (await isOpen(page, "tripsModal")) && d.name === "Kayıtlı seyahatlerim" && d.role === "dialog" && d.modal === "true", JSON.stringify(d));
  const empty = await page.textContent("#tripsList");
  t("empty state copy says a trip needs country, city AND both dates", empty.includes("Henüz kayıtlı seyahatin yok. Ülke, şehir ve gidiş–dönüş tarihlerini seçip keşfet düğmesiyle ilk seyahatini oluştur.") && /tarih/.test(empty), empty);
  t("empty state does not quote a button label that changes (“Keşfet” → “Amsterdam'ı keşfet →”)", !/“Keşfet”/.test(empty));
  t("trips ✕ named Kapat", (await page.getAttribute('#tripsModal button[onclick="closeTripsModal()"]', "aria-label")) === "Kapat");
  t("no overflow (trips open)", await noOverflow(page, vp));
  await page.click("#tripsEmptyNew");
  t("CTA closes the dialog", !(await isOpen(page, "tripsModal")));
  t("CTA focuses the trip search (#countrySel)", (await active(page)).id === "countrySel");
  t("CTA shows the dates hint next to the search button", (await page.textContent("#dInfo")) === DATES_HINT);
  await page.evaluate(() => { document.getElementById("dInfo").textContent = ""; });
  await openMenu(page);
  await menuItem(page, "Yeni seyahat oluştur");
  t("menu item closes the menu", !(await isOpen(page, "acctMenu")) && (await acctAttrs(page)).expanded === "false");
  t("menu item focuses the trip search (#countrySel)", (await active(page)).id === "countrySel");
  t("menu item shows the dates hint too", (await page.textContent("#dInfo")) === DATES_HINT);
  t("no writes", writes(await supaLog(page)).length === 0);
}, { supa: memberSupa({ trips: [] }) });

sc("Kayıtlı seyahatlerim: only the member's own trips (even if the server returned more); archive via data attributes", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true });
  await page.waitForFunction(() => /Seyahatlerim \(2\)/.test(document.getElementById("tripHub").textContent), null, { timeout: 5000 }).catch(() => {});
  t("hub counts own trips only", /Seyahatlerim \(2\)/.test(await page.textContent("#tripHub")), await page.textContent("#tripHub"));
  t("hub never shows another user's trip", !/Başkasının/.test(await page.textContent("#tripHub")));
  await openMenu(page);
  await menuItem(page, "Kayıtlı seyahatlerim");
  await page.waitForFunction(() => document.querySelectorAll("#tripsList [data-trip-row]").length > 0, null, { timeout: 5000 });
  const ids = await page.evaluate(() => [...document.querySelectorAll("#tripsList [data-trip-row]")].map((r) => r.getAttribute("data-trip-row")));
  t("list = own trips only (11, 12)", JSON.stringify(ids.slice().sort()) === JSON.stringify(["11", "12"]), JSON.stringify(ids));
  t("list never shows another user's trip", !/Başkasının/.test(await page.textContent("#tripsList")));
  t("no inline JS with trip data", await page.evaluate(() => ![...document.querySelectorAll("#tripsList [onclick], #tripHub [onclick]")].some((b) => /openTrip\(|archiveTrip\(/.test(b.getAttribute("onclick")))));
  await page.focus('#tripsList button[data-trip-act="archive"][data-trip-id="12"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#tripsList [data-trip-row]").length === 1, null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById("tripsOk").textContent.length > 0 || document.getElementById("tripsErr").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  const log = await supaLog(page);
  const save = log.find((e) => e.op === "rpc" && e.name === "trip_save");
  t("archive → trip_save(p_id=12 number, p_expected_rev=1, archived_at)", save && save.args.p_id === 12 && save.args.p_expected_rev === 1 && typeof save.args.p_patch.archived_at === "string", JSON.stringify(save));
  t("list refreshed (1 row left)", (await page.evaluate(() => document.querySelectorAll("#tripsList [data-trip-row]").length)) === 1);
  const fa = await page.evaluate(() => { const a = document.activeElement; return { tag: a && a.tagName, act: a && a.getAttribute("data-trip-act"), id: a && a.getAttribute("data-trip-id"), dlg: !!(a && a.closest && a.closest('#tripsModal [role="dialog"]')) }; });
  t("focus stays inside the trips dialog (never <body>)", fa.dlg && fa.tag !== "BODY", JSON.stringify(fa));
  t("focus moves to the remaining row's Arşivle (same position)", fa.act === "archive" && fa.id === "11", JSON.stringify(fa));
  t("archive announced (role=status), no error", (await page.textContent("#tripsOk")) === "Seyahat arşivlendi." && (await page.getAttribute("#tripsOk", "role")) === "status" && (await page.textContent("#tripsErr")) === "");
  await Promise.all([page.waitForURL(/\/amsterdam\/\?trip=11&city=Amsterdam$/, { timeout: 10000 }), page.click('#tripsList button[data-trip-act="open"][data-trip-id="11"]')]);
  t("open → city page with ?trip=<id>", /\/amsterdam\/\?trip=11&city=Amsterdam$/.test(page.url()), page.url());
}, { supa: memberSupa({ trips: [tripRow(11, "Amsterdam", "2026-11-20", "2026-11-23"), tripRow(12, "Kopenhag", "2026-12-01", "2026-12-04"), tripRow(13, "Başkasının seyahati", "2026-11-01", "2026-11-02", OTHER)], supa: { rls: false } }) });

sc("keyboard + pointer: Tab trap, ESC and outside click close, focus returns to the opener", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true });
  await page.focus("#acctBtn");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => ASA_DLG.isOpen(document.getElementById("acctMenu")));
  t("Enter opens the menu, focus on Profilim", (await active(page)).text === "Profilim");
  let inside = true; const seen = new Set();
  for (let i = 0; i < 9; i++) { await page.keyboard.press("Tab"); const a = await active(page); seen.add(a.acct || a.id); if (!a.inMenu) inside = false; }
  t("Tab ×9 stays inside the menu", inside, JSON.stringify([...seen]));
  t("Tab cycles through all items + ✕", ["profile", "prefs", "trips", "newtrip", "logout", "acctMenuX"].every((k) => seen.has(k)), JSON.stringify([...seen]));
  inside = true;
  for (let i = 0; i < 9; i++) { await page.keyboard.press("Shift+Tab"); if (!(await active(page)).inMenu) inside = false; }
  t("Shift+Tab ×9 stays inside the menu", inside);
  await page.focus("#acctMenu [data-acct=logout]");
  await page.keyboard.press("Tab");
  t("Tab from the last control wraps to the first (✕)", (await active(page)).id === "acctMenuX");
  await page.keyboard.press("Shift+Tab");
  t("Shift+Tab from the first wraps to the last (Çıkış yap)", (await active(page)).acct === "logout");
  await page.keyboard.press("Escape");
  t("ESC closes the menu", !(await isOpen(page, "acctMenu")));
  t("ESC: focus back on #acctBtn, aria-expanded=false", (await active(page)).id === "acctBtn" && (await acctAttrs(page)).expanded === "false");
  await openMenu(page);
  const pt = await backdropPoint(page, "acctMenu");
  t("menu backdrop reachable", !!pt);
  if (pt) await page.mouse.click(pt.x, pt.y);
  t("outside click closes the menu, focus back", !(await isOpen(page, "acctMenu")) && (await active(page)).id === "acctBtn");
  if (await isOpen(page, "acctMenu")) await page.keyboard.press("Escape"); // keep going when the check above was skipped/failed
  await openMenu(page);
  await page.mouse.click(...(await page.evaluate(() => { const r = document.querySelector("#acctMenuTitle").getBoundingClientRect(); return [r.left + 5, r.top + 5]; })));
  t("click inside the panel does not close", await isOpen(page, "acctMenu"));
  await page.keyboard.press("Escape");
  // the other dialogs: ESC + outside click + Tab trap
  for (const [label, id] of [["Profilim", "authModal"], ["E-posta tercihlerim", "prefsModal"], ["Kayıtlı seyahatlerim", "tripsModal"]]) {
    await openMenu(page); await menuItem(page, label);
    await page.waitForFunction((i) => ASA_DLG.isOpen(document.getElementById(i)), id);
    await page.waitForTimeout(100);
    let ins = true;
    for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); if ((await active(page)).dlg !== id) ins = false; }
    t(label + ": Tab trap", ins);
    await page.keyboard.press("Escape");
    t(label + ": ESC closes, focus to #acctBtn", !(await isOpen(page, id)) && (await active(page)).id === "acctBtn");
    await openMenu(page); await menuItem(page, label);
    await page.waitForFunction((i) => ASA_DLG.isOpen(document.getElementById(i)), id);
    const p = await backdropPoint(page, id);
    if (p) await page.mouse.click(p.x, p.y);
    t(label + ": outside click closes, focus to #acctBtn", !!p && !(await isOpen(page, id)) && (await active(page)).id === "acctBtn");
    if (await isOpen(page, id)) await page.keyboard.press("Escape");
  }
}, { supa: memberSupa({ trips: [] }) });

sc("anon login dialog: Tab trap + outside click", async ({ page, origin, t }) => {
  await openHome(page, origin);
  await page.click("#acctBtn");
  let ins = true;
  for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); if ((await active(page)).dlg !== "authModal") ins = false; }
  t("Tab trap in login dialog", ins);
  const p = await backdropPoint(page, "authModal");
  if (p) await page.mouse.click(p.x, p.y);
  t("outside click closes login, focus to #acctBtn", !!p && !(await isOpen(page, "authModal")) && (await active(page)).id === "acctBtn");
}, { supa: { user: null } });

sc("Kayıtlı seyahatlerim: archive from the hub-opened dialog keeps focus in the dialog; last trip → empty-state CTA; failure → alert", async ({ page, origin, vp, t }) => {
  await openHome(page, origin, { member: true });
  await page.waitForSelector("#tripHub [data-hub-trips]", { timeout: 5000 });
  await page.click("#tripHub [data-hub-trips]");
  await page.waitForFunction(() => document.querySelectorAll("#tripsList [data-trip-row]").length === 2, null, { timeout: 5000 });
  // failure first: trip_save {ok:false} → alert, row stays, focus stays on the button, no success claim
  await page.evaluate(() => { window.__WP4_SUPA_FAIL_NEXT.trip_save = "notok"; });
  await page.focus('#tripsList button[data-trip-act="archive"][data-trip-id="41"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("tripsErr").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("archive failure → role=alert text", (await page.textContent("#tripsErr")) === "Seyahat arşivlenemedi. Tekrar dene." && (await page.getAttribute("#tripsErr", "role")) === "alert");
  t("archive failure → no success status, both rows still listed", (await page.textContent("#tripsOk")) === "" && (await page.evaluate(() => document.querySelectorAll("#tripsList [data-trip-row]").length)) === 2);
  t("archive failure → focus stays on that Arşivle", await page.evaluate(() => { const a = document.activeElement; return a && a.getAttribute("data-trip-act") === "archive" && a.getAttribute("data-trip-id") === "41"; }));
  // first row: focus moves to the row now at the same position
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#tripsList [data-trip-row]").length === 1 && document.getElementById("tripsOk").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  let a = await active(page);
  t("archive 1/2 → focus inside the dialog, on the next Arşivle", a.dlg === "tripsModal" && (await page.evaluate(() => document.activeElement.getAttribute("data-trip-id"))) === "42", JSON.stringify(a));
  t("archive 1/2 → status 'Seyahat arşivlendi.', alert cleared", (await page.textContent("#tripsOk")) === "Seyahat arşivlendi." && (await page.textContent("#tripsErr")) === "");
  t("no overflow (trips dialog with status line)", await noOverflow(page, vp) && !(await dlgInfo(page, "tripsModal")).overflowX);
  // last row: list becomes the empty state, focus goes to its CTA (hub button disappears)
  await page.keyboard.press("Enter");
  await page.waitForSelector("#tripsEmptyNew", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(50);
  a = await active(page);
  t("archive 2/2 → focus on the empty-state CTA, still inside the dialog", a.id === "tripsEmptyNew" && a.dlg === "tripsModal", JSON.stringify(a));
  t("archive 2/2 → hub is empty (opener gone)", (await page.evaluate(() => document.getElementById("tripHub").innerHTML)) === "");
  const saves = (await supaLog(page)).filter((e) => e.op === "rpc" && e.name === "trip_save");
  t("trip_save calls: 1 failed + 2 archives (ids 41, 41, 42)", JSON.stringify(saves.map((e) => e.args.p_id)) === JSON.stringify([41, 41, 42]), JSON.stringify(saves.map((e) => e.args)));
  await page.keyboard.press("Escape");
  t("ESC after the opener vanished → focus to #acctBtn", !(await isOpen(page, "tripsModal")) && (await active(page)).id === "acctBtn");
}, { supa: memberSupa({ trips: [tripRow(41, "Amsterdam", "2026-11-20", "2026-11-23"), tripRow(42, "Kopenhag", "2026-12-01", "2026-12-04")] }) });

sc("Yeni seyahat: country+city only → no trip is saved; with both dates → exactly one trips insert", async ({ page, origin, vp, t }) => {
  // The stub's tables are per page load, so the city page cannot see the row the homepage just inserted and its own
  // guest-trip import would add a second, stub-only insert. Count only what the HOMEPAGE wrote.
  const sink = [];
  await page.exposeBinding("__wp4Sink", (src, e) => { sink.push(Object.assign({ at: new URL(src.frame.url()).pathname }, e)); });
  const inserts = () => sink.filter((e) => e.at === "/" && e.table === "trips" && e.op === "insert");
  await openHome(page, origin, { member: true });
  await openMenu(page); await menuItem(page, "Yeni seyahat oluştur");
  t("menu → search focused, dates hint shown", (await active(page)).id === "countrySel" && (await page.textContent("#dInfo")) === DATES_HINT);
  await page.selectOption("#countrySel", "nl");
  await page.selectOption("#citySel", "Amsterdam");
  t("dates hint still visible after choosing country + city", (await page.textContent("#dInfo")) === DATES_HINT);
  t("no overflow (dates hint shown)", await noOverflow(page, vp));
  await Promise.all([page.waitForURL(/\/amsterdam\/\?city=Amsterdam$/, { timeout: 10000 }), page.click("#goBtn")]);
  t("no dates → city page without ?trip", /\/amsterdam\/\?city=Amsterdam$/.test(page.url()), page.url());
  t("no dates → no trips insert", inserts().length === 0, JSON.stringify(inserts()));
  await openHome(page, origin, { member: true });
  await page.selectOption("#countrySel", "nl");
  await page.selectOption("#citySel", "Amsterdam");
  const s = inDays(40), e = inDays(43);
  await page.fill("#dStart", s);
  await page.fill("#dEnd", e);
  t("both dates → hint replaced by the duration", (await page.textContent("#dInfo")) === "Seçilen: 4 gün (3 gece)", await page.textContent("#dInfo"));
  await Promise.all([page.waitForURL(/\/amsterdam\/\?trip=\d+&city=Amsterdam$/, { timeout: 10000 }), page.click("#goBtn")]);
  const ins = inserts();
  t("both dates → exactly one trips insert", ins.length === 1, JSON.stringify(ins));
  const v = ins[0] && ins[0].value;
  t("insert row: own user, city, both dates", v && v.user_id === UID && v.city === "Amsterdam" && v.start_date === s && v.end_date === e, JSON.stringify(v));
  t("both dates → city page with ?trip=<id>", /\/amsterdam\/\?trip=\d+&city=Amsterdam$/.test(page.url()), page.url());
}, { supa: memberSupa({ trips: [] }) });

sc("XSS: HTML in display_name / trip city renders as text, never as markup", async ({ page, origin, vp, t, localHits }) => {
  await openHome(page, origin, { member: true });
  const a = await acctAttrs(page);
  t("account button: literal text, no child element", a.text === "👤 " + XSS_NAME && a.children === 0 && a.label === "Hesabım: " + XSS_NAME, JSON.stringify(a));
  t("no overflow with a long name", await noOverflow(page, vp));
  const bh = await page.evaluate(() => { const b = document.getElementById("acctBtn"); const lh = parseFloat(getComputedStyle(b).lineHeight) || 20; return { h: b.getBoundingClientRect().height, lh, header: document.querySelector("header").getBoundingClientRect().height }; });
  t("long name: account button stays one line (truncated), header height unchanged (layout)", bh.h <= bh.lh * 1.5 + 20 && bh.header <= 81, JSON.stringify(bh));
  await openMenu(page);
  t("menu: literal name, no <img>", (await page.textContent("#acctMenuWho")) === XSS_NAME && (await page.locator("#acctMenu img").count()) === 0);
  await menuItem(page, "Profilim");
  t("Profilim: name as text", (await page.textContent("#amName")) === XSS_NAME);
  t("Profilim: no <img> injected", (await page.locator("#authModal img").count()) === 0);
  await page.keyboard.press("Escape");
  await openMenu(page); await menuItem(page, "Kayıtlı seyahatlerim");
  await page.waitForFunction(() => document.querySelectorAll("#tripsList [data-trip-row]").length > 0, null, { timeout: 5000 });
  t("trip city as text in list", (await page.textContent("#tripsList")).includes(XSS_CITY));
  t("no <img> in list or hub", (await page.locator("#tripsList img, #tripHub img").count()) === 0);
  await page.waitForTimeout(200);
  t("no script ran (window.__wp4xss undefined)", (await page.evaluate(() => window.__wp4xss)) === undefined);
  t("no request for the injected img src", !localHits.some((p) => p === "/x"));
}, { supa: memberSupa({ member: { display_name: XSS_NAME }, trips: [tripRow(21, XSS_CITY, "2026-11-20", "2026-11-23")] }) });

sc("logout from the menu: signOut + asa_session removed, menu closed, focus to #acctBtn, private areas gone", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true });
  await page.evaluate(() => localStorage.setItem("asa_session", JSON.stringify({ uid: "placeholder" })));
  await openMenu(page); await menuItem(page, "E-posta tercihlerim"); await waitPrefsRows(page);
  await page.keyboard.press("Escape");
  await openMenu(page);
  await page.locator("#acctMenu nav button", { hasText: "Çıkış yap" }).dblclick();
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === null, null, { timeout: 5000 });
  const log = await supaLog(page);
  t("signOut called once (even on double click)", log.filter((e) => e.op === "signOut").length === 1, JSON.stringify(log.filter((e) => e.op === "signOut")));
  t("asa_session removed", (await page.evaluate(() => localStorage.getItem("asa_session"))) === null);
  t("menu closed", !(await isOpen(page, "acctMenu")));
  const a = await acctAttrs(page);
  t("button back to anon (label/text, no popup attrs)", a.label === "Giriş yap / üye ol" && a.text === "Giriş" && a.haspopup === null && a.expanded === null, JSON.stringify(a));
  t("focus on #acctBtn", (await active(page)).id === "acctBtn");
  t("private content cleared", await page.evaluate(() => document.getElementById("prefsBody").innerHTML === "" && document.getElementById("tripsList").innerHTML === "" && document.getElementById("tripHub").innerHTML === "" && document.getElementById("acctMenuWho").textContent === ""));
  await page.click("#acctBtn");
  t("icon now opens the login form, not the menu", (await isOpen(page, "authModal")) && !(await isOpen(page, "acctMenu")) && (await page.locator("#amEmail").count()) === 1);
}, { supa: memberSupa({ trips: [tripRow(31, "Amsterdam", "2026-11-20", "2026-11-23")], supa: { signOutDelayMs: 300 } }) });

sc("logout from Profilim: same semantics, dialog closes, focus to #acctBtn", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true });
  await openMenu(page); await menuItem(page, "Profilim");
  await page.click("#amLogout");
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === null, null, { timeout: 5000 });
  t("signOut called", (await supaLog(page)).some((e) => e.op === "signOut"));
  t("profile dialog closed, focus #acctBtn", !(await isOpen(page, "authModal")) && (await active(page)).id === "acctBtn");
}, { supa: memberSupa() });

sc("city page: not_configured → 'Varsayılan belirlenmedi' (not 'Kapalı'); header member button has a name", async ({ page, origin, t }) => {
  await page.goto(origin + "/amsterdam/?city=Amsterdam", { waitUntil: "load" });
  await page.waitForFunction(() => window.ASA && typeof window.ASA.seg === "function", null, { timeout: 10000 });
  t("header member button accessible name", (await page.getByRole("button", { name: "Üyelik ve hesabım", exact: true }).count()) === 1);
  await page.getByRole("button", { name: "Üyelik ve hesabım", exact: true }).click();
  await page.waitForFunction(() => /E-posta Tercihleri/.test(document.getElementById("memberBody").textContent), null, { timeout: 10000 });
  await page.evaluate(() => window.ASA.seg("prefs"));
  await page.waitForFunction(() => document.querySelectorAll("#asaPrefsBody button[data-prefkey]").length === 7, null, { timeout: 5000 });
  const txt = await page.evaluate(() => [...document.querySelectorAll("#asaPrefsBody button[data-prefkey]")].map((b) => ({ k: b.getAttribute("data-prefkey"), s: b.parentElement.querySelector(".text-\\[12\\.5px\\]").textContent })));
  t("six keys 'Varsayılan belirlenmedi'", txt.filter((x) => x.s === "Varsayılan belirlenmedi").length === 6, JSON.stringify(txt));
  t("none 'Kapalı'", !txt.some((x) => x.s === "Kapalı"));
  t("welcome Açık", txt.find((x) => x.k === "welcome_service_email").s === "Açık");
}, { supa: memberSupa() });

/* ---------- runner ---------- */
if (!HAS_CSS) console.log("NOTE tailwindcss build deps missing → layout-dependent checks are SKIPPED (WP4_E2E_INCOMPLETE)");
const { proc, origin } = await startServer();
const browser = await chromium.launch(process.env.WP4_CHROMIUM ? { executablePath: process.env.WP4_CHROMIUM } : {});
try {
  for (const vp of WANT_VP) {
    for (const s of scenarios) {
      if (ONLY && !s.name.includes(ONLY)) continue;
      const label = `[${vp}] ${s.name}`;
      const { ctx, localHits } = await newContext(browser, origin, vp, s.opts.supa);
      const page = await ctx.newPage();
      const errs = [];
      attach(page, errs);
      const t = (n, c, d) => {
        if (!HAS_CSS && /overflow|outside click|backdrop|\(layout\)/.test(n)) { skips++; console.log("SKIP " + label + " :: " + n + " (no Tailwind build)"); return; }
        ok(label + " :: " + n, c, d);
      };
      try { await s.fn({ page, origin, vp, t, ctx, localHits }); }
      catch (e) { t("scenario completed", false, String((e && e.stack) || e).split("\n").slice(0, 3).join(" | ")); }
      t("console/page errors = 0", errs.length === 0, JSON.stringify(errs.slice(0, 4)));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  proc.kill();
}
console.log("--- third-party requests (all answered by stubs) ---");
for (const [k, v] of [...thirdParty.entries()].sort()) console.log(`  ${v}x ${k}`);
console.log(`WP4_E2E checks pass=${passes} fail=${fails} skip=${skips} (tailwind_build=${HAS_CSS ? "yes" : "no"})`);
if (passes + fails === 0) { console.log("NO_CHECKS_RAN (WP4_ONLY/WP4_VIEWPORTS matched nothing)"); fails++; }
if (fails) { console.log("WP4_E2E_FAIL"); process.exit(1); }
if (skips) { console.log("WP4_E2E_INCOMPLETE"); process.exit(4); }
console.log("WP4_E2E_PASS");
process.exit(0);
