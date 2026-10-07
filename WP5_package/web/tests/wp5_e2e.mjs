// WP5 · ad-soyad ve profil tamamlama — Playwright end-to-end tests.
//
// Serves the repo root with `python3 -m http.server` on 127.0.0.1 and drives the real index.html and
// amsterdam/index.html in Chromium. Every non-local request is answered by a route() stub, exactly like
// WP4_package/tests/wp4_e2e.mjs: supabase-js → WP5 stub (stubs/supabase_stub.js: WP4 stub + signInWithPassword
// accounts, members.first_name/last_name, server-like member_set_name / member_upsert_profile, persisted state,
// backend-missing mode), Leaflet → WP3 stub, fonts/images → empty (Material Symbols → 1em-per-icon stand-in CSS),
// cdn.tailwindcss.com → each page's OWN Tailwind config compiled locally (WP4_package/tests/tailwind_css.mjs),
// so overflow checks see real utility classes.
// Never reaches *.supabase.co or www.asalocal.club.
//
//   NODE_PATH=<playwright + tailwindcss deps> node WP5_package/web/tests/wp5_e2e.mjs
//   env: WP5_VIEWPORTS=desktop,mobile,small (1366 / 390 / 360; default all)  WP5_ONLY=<scenario substring>
//
// Output: one PASS/FAIL line per check and the sentinel WP5_E2E_PASS (exit 0), WP5_E2E_FAIL (exit 1) or
// WP5_E2E_INCOMPLETE (exit 4: Tailwind build deps missing → layout checks could not run; not a PASS).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { tailwindAvailable, buildTailwindCss, cdnShim } from "../../../WP4_package/tests/tailwind_css.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ONLY = process.env.WP5_ONLY || "";
const VIEWPORTS = { desktop: { width: 1366, height: 768 }, mobile: { width: 390, height: 844 }, small: { width: 360, height: 740 } };
const WANT_VP = (process.env.WP5_VIEWPORTS || "desktop,mobile,small").split(",").filter((v) => VIEWPORTS[v]);
const read = (p) => readFileSync(join(REPO, p), "utf8");

const SUPA_STUB = readFileSync(join(HERE, "stubs", "supabase_stub.js"), "utf8");
const LEAFLET_STUB = read("WP3_package/tests/stubs/leaflet_stub.js");
const ICON_FONT_CSS = ".msym,.material-symbols-outlined{display:inline-block;width:1em;overflow:hidden;white-space:nowrap;vertical-align:middle}";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const HAS_CSS = tailwindAvailable();
const HOME_CSS = HAS_CSS ? cdnShim(await buildTailwindCss(read("index.html"))) : null;
const CITY_CSS = HAS_CSS ? cdnShim(await buildTailwindCss(read("amsterdam/index.html"))) : null;

const UID = "00000000-0000-4000-8000-0000000000e1";
const OTHER = "00000000-0000-4000-8000-0000000000e2";
const NEW_UID = "00000000-0000-4000-8000-0000000000e3";
const NULL_UID = "00000000-0000-4000-8000-0000000000e4";
const at = (u) => [u, "example.invalid"].join("@");     // built at runtime; no address literal in the file
const MAIL = at("wp5-member"), NEW_MAIL = at("wp5-new"), NULL_MAIL = at("wp5-noname"), OTHER_MAIL = at("wp5-other");
const PW = ["wp5", "stub", "only"].join("-");           // test-only credential accepted by the stub
const DISMISS_KEY = "asa:name_prompt_dismissed:" + UID;
const OK_TEXT = "Adın ve soyadın kaydedildi.";
const TITLE = "Profilini tamamla: adını ve soyadını ekle.";
const XSS_IMG = '<img src=x onerror="window.__wp5xss=1">';
const XSS_SCRIPT = '"><script>window.__wp5xss=2</script>';
const MSG = {
  firstEmpty: "Ad boş bırakılamaz.", lastEmpty: "Soyad boş bırakılamaz.", firstLong: "Ad en fazla 50 karakter olabilir.",
  noRow: "Üyelik kaydın henüz hazır değil. Sayfayı yenileyip tekrar dene.", net: "Kaydedilemedi. Bağlantını kontrol edip tekrar dene.",
  noAuth: "Oturumun sona ermiş. Tekrar giriş yapıp yeniden dene.", badFirst: "Ad kaydedilemedi: yalnız harf, boşluk, kesme işareti, tire ve nokta kullan (en fazla 50 karakter)."
};

let fails = 0, passes = 0, skips = 0;
const thirdParty = new Map();
function ok(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { fails++; console.log("FAIL " + name + (detail ? "  :: " + detail : "")); }
}
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
}
async function startServer() {
  const port = await freePort();
  const proc = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", REPO], { stdio: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(origin + "/CNAME"); if (r.ok) return { proc, origin }; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  proc.kill(); throw new Error("static server did not start");
}

/* ---------- fixtures ---------- */
const row = (uid, mail, extra = {}) => Object.assign({ user_id: uid, email: mail, display_name: "Deniz", blocked: false, tier: "Kaşif", points: 3, first_name: null, last_name: null }, extra);
const ACCOUNTS = [{ id: UID, email: MAIL, password: PW }, { id: NEW_UID, email: NEW_MAIL, password: PW }, { id: NULL_UID, email: NULL_MAIL, password: PW }];
const supa = (o = {}) => Object.assign({
  user: o.anon ? null : { id: UID, email: MAIL }, accounts: ACCOUNTS,
  tables: { members: o.members || [row(UID, MAIL, o.member || {}), row(OTHER, OTHER_MAIL, { display_name: "Başka" })], trips: [] }, prefs: {}
}, o.supa || {});

async function newContext(browser, origin, vp, s, opts) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], serviceWorkers: "block" });
  const localHits = [];
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === origin) {
      localHits.push(u.pathname);
      if (u.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
      if (opts.libMissing && u.pathname === "/lib/asa-name/asa_name.js") return route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
      return route.continue();
    }
    const key = u.host + u.pathname.replace(/\/[^/]*\.(png|jpe?g|webp|gif)$/i, "/*");
    thirdParty.set(key, (thirdParty.get(key) || 0) + 1);
    if (u.host === "cdn.tailwindcss.com") {
      let doc = ""; try { doc = new URL(req.frame().url()).pathname; } catch {}
      return route.fulfill({ status: 200, contentType: "application/javascript", body: (doc.startsWith("/amsterdam/") ? CITY_CSS : HOME_CSS) || "window.tailwind={config:{}};" });
    }
    if (u.host === "unpkg.com" && u.pathname.includes("leaflet")) {
      if (u.pathname.endsWith(".css")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return route.fulfill({ status: 200, contentType: "application/javascript", body: LEAFLET_STUB });
    }
    if (u.host === "cdn.jsdelivr.net" && u.pathname.includes("supabase-js")) return route.fulfill({ status: 200, contentType: "application/javascript", body: SUPA_STUB });
    const rt = req.resourceType();
    // icon font stand-in: the real Material Symbols font renders each ligature ("account_circle") as ONE 1em glyph;
    // without the font the ligature text is wide and the city header overflows at 390px (also on main, test-only artifact)
    if (u.host === "fonts.googleapis.com" && /Material\+Symbols/.test(u.search)) return route.fulfill({ status: 200, contentType: "text/css", body: ICON_FONT_CSS });
    if (rt === "stylesheet") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (rt === "script") return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (rt === "image") return route.fulfill({ status: 200, contentType: "image/gif", body: GIF });
    if (rt === "font") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 204, body: "" });
  });
  await ctx.addInitScript((c) => { window.__WP5_SUPA = c; }, s || {});
  if (opts.blockLocalStorage) await ctx.addInitScript(() => { Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("site data blocked (test)", "SecurityError"); } }); });
  return { ctx, localHits };
}
function attach(page, bucket) {
  page.on("pageerror", (e) => bucket.push({ kind: "pageerror", text: String((e && e.message) || e) }));
  page.on("console", (m) => { if (m.type() === "error") bucket.push({ kind: "console", text: m.text(), url: (m.location() || {}).url || "" }); });
}

/* ---------- page helpers ---------- */
async function openHome(page, origin, opts = {}) {
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof ASA_DLG !== "undefined" && document.getElementById("countrySel").options.length > 1, null, { timeout: 10000 });
  if (opts.member) await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 10000 });
  if (opts.member && opts.read !== false) await nameRead(page);
  await page.waitForTimeout(60);
}
async function openCity(page, origin, opts = {}) {
  await page.goto(origin + "/amsterdam/?city=Amsterdam", { waitUntil: "load" });
  await page.waitForFunction(() => window.ASA && typeof window.ASA.seg === "function" && window.ASA_ST, null, { timeout: 10000 });
  if (opts.member) { await page.waitForFunction(() => !!window.ASA.session, null, { timeout: 10000 }); if (opts.read !== false) await nameRead(page); }
  await page.waitForTimeout(80);
}
// the page asked for its own first_name/last_name (ASA_NAME.load) and had time to render the answer
async function nameRead(page) {
  await page.waitForFunction(() => (window.__WP5_SUPA_LOG || []).some((e) => e.table === "members" && e.op === "select" && /first_name/.test(e.cols || "")), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(120);
}
const homeBanner = (page) => page.evaluate(() => {
  const b = document.getElementById("namePrompt"), d = document.getElementById("namePromptDone");
  const vis = !!b && !b.hidden && b.offsetParent !== null && b.getBoundingClientRect().height > 0;
  return { visible: vis, count: document.querySelectorAll("#namePrompt").length, forms: document.querySelectorAll("#npForm").length, title: (document.getElementById("namePromptTitle") || {}).textContent, inputs: document.querySelectorAll("#namePrompt input").length, done: d ? d.textContent : null, doneRole: d && d.getAttribute("role"), err: (document.getElementById("npErr") || {}).textContent || "", ok: (document.getElementById("npOk") || {}).textContent || "", modal: !!(b && (b.getAttribute("aria-modal") || b.closest("[role=dialog]") || b.getAttribute("role") === "dialog")) };
});
const cityBanner = (page) => page.evaluate(() => {
  const b = document.getElementById("asaNamePrompt"), d = document.getElementById("asaNpDone");
  return { visible: !!b && !b.classList.contains("hide") && b.offsetParent !== null, inputs: document.querySelectorAll("#asaNamePrompt input").length, title: (document.getElementById("asaNpTitle") || {}).textContent, done: d ? d.textContent : null, err: (document.getElementById("asaNpErr") || {}).textContent || "", ok: (document.getElementById("asaNpOk") || {}).textContent || "" };
});
const active = (page) => page.evaluate(() => { const a = document.activeElement; return { id: (a && a.id) || "", tag: a && a.tagName, dlg: a && a.closest && a.closest('[role="dialog"]') ? a.closest('[role="dialog"]').parentElement.id : null, label: a && a.getAttribute && a.getAttribute("aria-label") }; });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const inView = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || (r.left >= -1 && r.right <= window.innerWidth + 1); }), sel);
const stubState = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("__wp5_stub_state") || "null"));
const own = (st, uid = UID) => ((st && st.tables && st.tables.members) || []).find((r) => r.user_id === uid) || null;
const rpcs = (sink, name) => sink.filter((e) => e.op === "rpc" && e.name === name);
const injected = (page) => page.evaluate(() => ({ img: document.querySelectorAll('img[src="x"], img[src$="/x"]').length, scripts: [...document.scripts].filter((s) => /__wp5xss/.test(s.textContent)).length, flag: window.__wp5xss === undefined ? null : window.__wp5xss }));
const fieldState = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return e ? { value: e.value, invalid: e.getAttribute("aria-invalid"), max: e.getAttribute("maxlength"), ac: e.getAttribute("autocomplete"), label: (document.querySelector('label[for="' + i + '"]') || {}).textContent || null } : null; }, id);
const dlgOverflow = (page, id) => page.evaluate((i) => { const p = document.querySelector("#" + i + ' [role="dialog"]'); return p ? p.scrollWidth > p.clientWidth + 1 : null; }, id);
async function openMenu(page) { await page.click("#acctBtn"); await page.waitForFunction(() => ASA_DLG.isOpen(document.getElementById("acctMenu"))); }
async function openProfile(page) { await openMenu(page); await page.locator("#acctMenu nav button", { hasText: "Profilim" }).click(); await page.waitForFunction(() => ASA_DLG.isOpen(document.getElementById("authModal"))); }
async function logoutHome(page) { if (await page.evaluate(() => ASA_DLG.isOpen(document.getElementById("authModal")))) await page.keyboard.press("Escape"); await openMenu(page); await page.locator("#acctMenu nav button", { hasText: "Çıkış yap" }).click(); await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === null, null, { timeout: 5000 }); }
async function loginHome(page, mail, pw = PW) {
  await page.click("#acctBtn");
  await page.waitForSelector("#amEmail");
  await page.fill("#amEmail", mail); await page.fill("#amPw", pw);
  await page.click("#amAuth");
}
async function loginCity(page, mail, pw = PW) {
  await page.evaluate(() => go("member"));
  await page.waitForSelector("#asaEmail");
  await page.fill("#asaEmail", mail); await page.fill("#asaPw", pw);
  await page.click("#asaAuthBtn");
}
const pageLogCount = (page) => page.evaluate(() => (window.__WP5_SUPA_LOG || []).length);

/* ---------- scenarios ---------- */
const scenarios = [];
const sc = (name, fn, opts = {}) => scenarios.push({ name, fn, opts });
const ALL_VP = ["desktop", "mobile", "small"];

sc("anon: no banner, no name fields, no name query (home + city)", async ({ page, origin, vp, t, sink }) => {
  await openHome(page, origin);
  await page.waitForTimeout(250);
  let b = await homeBanner(page);
  t("home: banner hidden, no inputs", !b.visible && b.inputs === 0 && b.forms === 0, JSON.stringify(b));
  await page.click("#acctBtn");
  t("home: account icon opens the login form (no Profilim, no name fields)", (await page.locator("#amEmail").count()) === 1 && (await page.locator("#amWp5Slot, #profFirst").count()) === 0);
  await page.keyboard.press("Escape");
  await openCity(page, origin);
  await page.waitForTimeout(250);
  const c = await cityBanner(page);
  t("city: banner hidden, no inputs", !c.visible && c.inputs === 0, JSON.stringify(c));
  await page.evaluate(() => go("member"));
  t("city: member view shows the login form only", (await page.locator("#asaEmail").count()) === 1 && (await page.locator("#asaPfFirst, #asaNameSlot").count()) === 0);
  t("no first_name read and no member_set_name for anon", !sink.some((e) => (e.op === "select" && /first_name/.test(e.cols || "")) || (e.op === "rpc" && e.name === "member_set_name")), JSON.stringify(sink.filter((e) => /first_name|member_set_name/.test(JSON.stringify(e)))));
  t("no overflow", await noOverflow(page));
}, { supa: supa({ anon: true }) });

sc("member without a name: one non-modal banner; focus not stolen; Tab Ad→Soyad→Kaydet→Şimdi değil; type + Enter saves; reload, Profilim and city Kart show it; only own row changed", async ({ page, origin, vp, t, sink }) => {
  await openHome(page, origin, { member: true });
  let b = await homeBanner(page);
  t("banner visible with the exact copy", b.visible && b.title === TITLE, JSON.stringify(b));
  t("exactly one banner and one form", b.count === 1 && b.forms === 1 && b.inputs === 2);
  t("banner is not a dialog / not modal", !b.modal);
  t("focus not stolen by the banner", (await active(page)).tag === "BODY");
  t("Ad / Soyad labelled, autocomplete, maxlength 50", await page.evaluate(() => ["npFirst", "npLast"].every((i) => { const e = document.getElementById(i); const l = document.querySelector('label[for="' + i + '"]'); return e && l && e.getAttribute("maxlength") === "50"; })) && (await fieldState(page, "npFirst")).ac === "given-name" && (await fieldState(page, "npLast")).ac === "family-name" && (await fieldState(page, "npFirst")).label === "Ad" && (await fieldState(page, "npLast")).label === "Soyad");
  t("status line role=status, error line role=alert", (await page.getAttribute("#npOk", "role")) === "status" && (await page.getAttribute("#npErr", "role")) === "alert");
  t("no overflow (banner shown)", await noOverflow(page) && await inView(page, "#namePrompt input, #namePrompt button"));
  t("header height unchanged (banner below the header)", (await page.evaluate(() => document.querySelector("header").getBoundingClientRect().height)) <= 81);
  // the rest of the page stays usable while the banner is shown
  await openMenu(page); await page.keyboard.press("Escape");
  t("account menu still opens/closes with the banner shown", (await active(page)).id === "acctBtn");
  // keyboard: Tab order from the top of the page
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.focus("header a");
  const seq = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); seq.push((await active(page)).id); }
  t("Tab order: #acctBtn → Ad → Soyad → Kaydet → Şimdi değil", JSON.stringify(seq.slice(0, 5)) === JSON.stringify(["acctBtn", "npFirst", "npLast", "npSave", "npLater"]), JSON.stringify(seq));
  await page.focus("#npFirst"); await page.keyboard.type("Ayşe");
  await page.keyboard.press("Tab"); await page.keyboard.type("Yılmaz");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("namePromptDone").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  b = await homeBanner(page);
  t("Enter submits → success status shown, banner hidden", !b.visible && b.done === OK_TEXT && b.doneRole === "status", JSON.stringify(b));
  t("focus moved to the success status (not lost to <body>)", (await active(page)).id === "namePromptDone");
  t("no error text anywhere", !(await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].some((e) => e.textContent.trim() && /Ad|Soyad|Kaydedilemedi/.test(e.textContent)))));
  const sets = rpcs(sink, "member_set_name");
  t("exactly one member_set_name(p_first, p_last)", sets.length === 1 && JSON.stringify(sets[0].args) === JSON.stringify({ p_first: "Ayşe", p_last: "Yılmaz" }), JSON.stringify(sets));
  let st = await stubState(page);
  t("own row updated; display_name untouched", own(st).first_name === "Ayşe" && own(st).last_name === "Yılmaz" && own(st).display_name === "Deniz", JSON.stringify(own(st)));
  t("other member's row untouched (RLS own row)", own(st, OTHER).first_name === null && own(st, OTHER).last_name === null && own(st, OTHER).display_name === "Başka");
  t("no overflow (after save)", await noOverflow(page));
  await openProfile(page);
  await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("Profilim shows the saved values", (await fieldState(page, "profFirst") || {}).value === "Ayşe" && (await fieldState(page, "profLast") || {}).value === "Yılmaz");
  t("Profilim: no input outside #amWp5Slot", await page.evaluate(() => { const s = document.getElementById("amWp5Slot"); return [...document.querySelectorAll("#authBody input, #authBody select, #authBody textarea")].every((e) => s && s.contains(e)); }));
  t("Profilim panel: no inner horizontal overflow", (await dlgOverflow(page, "authModal")) === false);
  await page.keyboard.press("Escape");
  await openHome(page, origin, { member: true });
  b = await homeBanner(page);
  t("reload: banner gone, no stale status", !b.visible && b.done === "" && b.inputs === 0, JSON.stringify(b));
  await openProfile(page); await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("reload: Profilim keeps the values", (await fieldState(page, "profFirst") || {}).value === "Ayşe" && (await fieldState(page, "profLast") || {}).value === "Yılmaz");
  await page.keyboard.press("Escape");
  await openCity(page, origin, { member: true });
  t("city: no banner for a complete member", !(await cityBanner(page)).visible);
  await page.evaluate(() => go("member"));
  await page.waitForSelector("#asaPfFirst", { timeout: 5000 }).catch(() => {});
  t("city Kart shows the same values", (await fieldState(page, "asaPfFirst") || {}).value === "Ayşe" && (await fieldState(page, "asaPfLast") || {}).value === "Yılmaz");
  t("only one member_set_name in the whole run", rpcs(sink, "member_set_name").length === 1);
  t("no overflow (city Kart)", await noOverflow(page));
}, { supa: supa(), vps: ALL_VP });

sc("'Şimdi değil' (keyboard): hidden, focus → #acctBtn, flag stored; stays hidden after reload and on the city page; Profilim still saves", async ({ page, origin, t, sink }) => {
  await openHome(page, origin, { member: true });
  t("banner visible", (await homeBanner(page)).visible);
  await page.focus("#npLater"); await page.keyboard.press("Enter");
  const b = await homeBanner(page);
  t("hidden, form removed", !b.visible && b.inputs === 0, JSON.stringify(b));
  t("focus on #acctBtn (Hesabım → Profilim)", (await active(page)).id === "acctBtn");
  t("flag stored as asa:name_prompt_dismissed:<uid>", (await page.evaluate((k) => localStorage.getItem(k), DISMISS_KEY)) === "1");
  t("dismiss writes nothing to the DB", rpcs(sink, "member_set_name").length === 0 && own(await stubState(page)).first_name === null);
  await openHome(page, origin, { member: true });
  t("reload: still hidden", !(await homeBanner(page)).visible);
  await openCity(page, origin, { member: true });
  t("city page: same member → hidden too", !(await cityBanner(page)).visible);
  await openHome(page, origin, { member: true });
  await openProfile(page);
  await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("Profilim still offers empty Ad / Soyad", (await fieldState(page, "profFirst") || {}).value === "" && (await fieldState(page, "profLast") || {}).value === "");
  await page.fill("#profFirst", "Çağrı"); await page.fill("#profLast", "Öztürk-Kaya");
  await page.click("#profSave");
  await page.waitForFunction(() => document.getElementById("profOk").textContent.length > 0 || document.getElementById("profErr").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("Profilim save → success, no error", (await page.textContent("#profOk")) === OK_TEXT && (await page.textContent("#profErr")) === "");
  t("saved for the own row", own(await stubState(page)).first_name === "Çağrı" && own(await stubState(page)).last_name === "Öztürk-Kaya");
}, { supa: supa() });

sc("Profilim save: role=status success (never with an error), banner closes behind the dialog, reload keeps values; Enter submits", async ({ page, origin, t, sink }) => {
  await openHome(page, origin, { member: true });
  t("banner visible first", (await homeBanner(page)).visible);
  await openProfile(page);
  await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("slot shown with labelled fields", await page.evaluate(() => !document.getElementById("amWp5Slot").hidden && !!document.querySelector('label[for="profFirst"]') && !!document.querySelector('label[for="profLast"]')));
  t("no Şimdi değil inside Profilim", (await page.locator("#profLater").count()) === 0);
  await page.fill("#profFirst", "  Jean-Luc  "); await page.fill("#profLast", "O’Neil");
  await page.focus("#profLast"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("profOk").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("success status text + role", (await page.textContent("#profOk")) === OK_TEXT && (await page.getAttribute("#profOk", "role")) === "status");
  t("no error at the same time", (await page.textContent("#profErr")) === "");
  t("normalized value written back", (await fieldState(page, "profFirst")).value === "Jean-Luc");
  t("focus stays in the dialog", (await active(page)).dlg === "authModal");
  t("args normalized (trim) and exactly two", JSON.stringify(rpcs(sink, "member_set_name").map((e) => e.args)) === JSON.stringify([{ p_first: "Jean-Luc", p_last: "O’Neil" }]));
  await page.keyboard.press("Escape");
  t("banner closed after the Profilim save (no success line outside)", !(await homeBanner(page)).visible && (await homeBanner(page)).done === "");
  await openHome(page, origin, { member: true });
  await openProfile(page); await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("reload: values kept", (await fieldState(page, "profFirst")).value === "Jean-Luc" && (await fieldState(page, "profLast")).value === "O’Neil");
  t("reload: no banner", !(await homeBanner(page)).visible);
}, { supa: supa() });

sc("existing member WITH a name: no banner, no write, Profilim prefilled; city page load sends p_display_name null and keeps everything", async ({ page, origin, t, sink }) => {
  await openHome(page, origin, { member: true });
  t("no banner", !(await homeBanner(page)).visible && (await homeBanner(page)).inputs === 0);
  await openProfile(page); await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("Profilim prefilled", (await fieldState(page, "profFirst")).value === "Ayşe" && (await fieldState(page, "profLast")).value === "Yılmaz");
  await page.keyboard.press("Escape");
  await openCity(page, origin, { member: true });
  t("city: no banner", !(await cityBanner(page)).visible);
  const ups = rpcs(sink, "member_upsert_profile");
  t("city session restore: member_upsert_profile sends p_display_name null", ups.length >= 1 && ups.every((e) => e.args.p_display_name === null), JSON.stringify(ups.map((e) => e.args)));
  t("no member_set_name", rpcs(sink, "member_set_name").length === 0);
  const r = own(await stubState(page));
  t("name and display_name unchanged", r.first_name === "Ayşe" && r.last_name === "Yılmaz" && r.display_name === "Deniz Özel", JSON.stringify(r));
}, { supa: supa({ member: { display_name: "Deniz Özel", first_name: "Ayşe", last_name: "Yılmaz" } }) });

sc("home login: existing display_name → p_display_name null; no row / empty name → e-mail local part; banner after login; wrong password unchanged", async ({ page, origin, t, sink }) => {
  await openHome(page, origin);
  await loginHome(page, MAIL, "wrong-" + PW);
  await page.waitForFunction(() => document.getElementById("amErr").textContent.length > 0, null, { timeout: 5000 });
  t("wrong password → existing message, no profile write", (await page.textContent("#amErr")) === "E-posta veya şifre hatalı." && rpcs(sink, "member_upsert_profile").length === 0);
  await page.keyboard.press("Escape");
  // A: row with display_name
  await loginHome(page, MAIL);
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 5000 });
  await nameRead(page);
  let up = rpcs(sink, "member_upsert_profile");
  t("A: one member_upsert_profile with p_display_name null", up.length === 1 && up[0].args.p_display_name === null && up[0].args.p_home_city === null && up[0].args.p_gender === null, JSON.stringify(up.map((e) => e.args)));
  const order = sink.filter((e) => (e.op === "select" && e.table === "members") || (e.op === "rpc" && e.name === "member_upsert_profile")).map((e) => e.op === "rpc" ? "upsert" : e.cols);
  t("A: own display_name read before the upsert", order[0] === "display_name" && order[1] === "upsert", JSON.stringify(order));
  t("A: display_name kept", own(await stubState(page)).display_name === "Deniz Özel" && (await page.getAttribute("#acctBtn", "aria-label")) === "Hesabım: Deniz Özel");
  t("A: Profilim shown after login with the name slot", await page.evaluate(() => ASA_DLG.isOpen(document.getElementById("authModal")) && !!document.getElementById("profFirst")));
  t("A: banner shown after login (name missing)", (await homeBanner(page)).visible);
  t("A: login focus stays in the dialog", (await active(page)).dlg === "authModal");
  await logoutHome(page);
  t("logout: banner and fields gone", !(await homeBanner(page)).visible && (await page.locator("#npFirst, #profFirst").count()) === 0);
  // B: no members row yet (first login after e-mail confirmation)
  await loginHome(page, NEW_MAIL);
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 5000 });
  await nameRead(page);
  up = rpcs(sink, "member_upsert_profile");
  t("B: no row → p_display_name = e-mail local part", up.length === 2 && up[1].args.p_display_name === "wp5-new", JSON.stringify(up.map((e) => e.args)));
  t("B: row created by member_upsert_profile → banner offered", own(await stubState(page), NEW_UID) && own(await stubState(page), NEW_UID).display_name === "wp5-new" && (await homeBanner(page)).visible);
  await logoutHome(page);
  // C: row exists, display_name null
  await loginHome(page, NULL_MAIL);
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 5000 });
  up = rpcs(sink, "member_upsert_profile");
  t("C: empty display_name → local part", up.length === 3 && up[2].args.p_display_name === "wp5-noname", JSON.stringify(up.map((e) => e.args)));
  t("signUp never called; one signIn per attempt", sink.filter((e) => e.op === "signUp").length === 0 && sink.filter((e) => e.op === "signInWithPassword").length === 4);
}, { supa: supa({ anon: true, members: [row(UID, MAIL, { display_name: "Deniz Özel" }), row(NULL_UID, NULL_MAIL, { display_name: null }), row(OTHER, OTHER_MAIL)] }) });

sc("city login: same display_name rule in afterAuth; banner after login; Kart fields; logout hides everything", async ({ page, origin, t, sink }) => {
  await openCity(page, origin);
  await loginCity(page, MAIL);
  await page.waitForFunction(() => !!window.ASA.session, null, { timeout: 5000 });
  await nameRead(page);
  let up = rpcs(sink, "member_upsert_profile");
  t("A: p_display_name null (display_name exists)", up.length === 1 && up[0].args.p_display_name === null, JSON.stringify(up.map((e) => e.args)));
  t("A: display_name kept", own(await stubState(page)).display_name === "Deniz Özel");
  t("A: banner shown after login", (await cityBanner(page)).visible);
  await page.waitForSelector("#asaPfFirst", { timeout: 5000 }).catch(() => {});
  t("A: Kart has labelled Ad / Soyad", (await fieldState(page, "asaPfFirst") || {}).label === "Ad" && (await fieldState(page, "asaPfLast") || {}).label === "Soyad");
  t("A: Görünen Ad field unchanged", (await page.inputValue("#asaName")) === "Deniz Özel");
  await page.click("#asaLogout");
  await page.waitForFunction(() => !window.ASA.session, null, { timeout: 5000 });
  t("logout: banner + Kart fields gone", !(await cityBanner(page)).visible && (await page.locator("#asaNpFirst, #asaPfFirst").count()) === 0);
  await loginCity(page, NEW_MAIL);
  await page.waitForFunction(() => !!window.ASA.session, null, { timeout: 5000 });
  await nameRead(page);
  up = rpcs(sink, "member_upsert_profile");
  t("B: no row → local part", up.length === 2 && up[1].args.p_display_name === "wp5-new", JSON.stringify(up.map((e) => e.args)));
  t("B: banner offered", (await cityBanner(page)).visible);
  t("no overflow", await noOverflow(page));
}, { supa: supa({ anon: true, members: [row(UID, MAIL, { display_name: "Deniz Özel" }), row(OTHER, OTHER_MAIL)] }) });

sc("XSS: payloads rejected client-side (alert, no RPC) and server-side (bad_first/bad_last); server rejection focuses the field; nothing injected", async ({ page, origin, t, sink, localHits }) => {
  await openHome(page, origin, { member: true });
  const scripts0 = await page.evaluate(() => document.scripts.length);
  await page.fill("#npFirst", XSS_IMG); await page.fill("#npLast", XSS_SCRIPT);
  await page.click("#npSave");
  await page.waitForTimeout(150);
  let b = await homeBanner(page);
  t("both rejected with role=alert text, no success", /^Ad yalnız harf/.test(b.err) && /Soyad yalnız harf/.test(b.err) && b.ok === "", JSON.stringify(b));
  t("no RPC for rejected input", rpcs(sink, "member_set_name").length === 0);
  t("payload stays text in the input", (await fieldState(page, "npFirst")).value === XSS_IMG && (await fieldState(page, "npFirst")).invalid === "true");
  t("focus on the first invalid field", (await active(page)).id === "npFirst");
  const srv = await page.evaluate(async ([a, b2]) => [await db.rpc("member_set_name", { p_first: a, p_last: "Yılmaz" }), await db.rpc("member_set_name", { p_first: "Ayşe", p_last: b2 }), await db.rpc("member_set_name", { p_first: "<b>", p_last: "<i>" })].map((r) => r.data), [XSS_IMG, XSS_SCRIPT]);
  t("server model rejects them too (bad_first / bad_last / first wins)", JSON.stringify(srv) === JSON.stringify([{ ok: false, reason: "bad_first" }, { ok: false, reason: "bad_last" }, { ok: false, reason: "bad_first" }]), JSON.stringify(srv));
  t("rejected server calls changed nothing", own(await stubState(page)).first_name === null);
  // a server-side rejection of otherwise valid-looking input is shown and focuses that field
  await page.evaluate(() => { window.__WP5_SUPA_FAIL_NEXT.member_set_name = "reason:bad_first"; });
  await page.fill("#npFirst", "Ayşe"); await page.fill("#npLast", "Yılmaz");
  await page.click("#npSave");
  await page.waitForFunction(() => document.getElementById("npErr").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  b = await homeBanner(page);
  t("server bad_first → alert text, no success, banner stays", b.err === MSG.badFirst && b.ok === "" && b.visible, JSON.stringify(b));
  t("server bad_first → focus + aria-invalid on Ad", (await active(page)).id === "npFirst" && (await fieldState(page, "npFirst")).invalid === "true");
  const inj = await injected(page);
  t("no element injected, no script ran", inj.img === 0 && inj.scripts === 0 && inj.flag === null && (await page.evaluate(() => document.scripts.length)) === scripts0, JSON.stringify(inj));
  t("no request for the injected img src", !localHits.some((p) => p === "/x"));
}, { supa: supa() });

sc("stored XSS-looking values render as text only (home Profilim, city Kart); complete → no banner", async ({ page, origin, t, localHits }) => {
  await openHome(page, origin, { member: true });
  t("no banner (complete)", !(await homeBanner(page)).visible);
  await openProfile(page); await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("Profilim: literal values", (await fieldState(page, "profFirst")).value === XSS_IMG && (await fieldState(page, "profLast")).value === XSS_SCRIPT);
  t("Profilim: nothing injected", (await injected(page)).img === 0 && (await page.locator("#authModal img, #authModal script").count()) === 0);
  await page.keyboard.press("Escape");
  await openCity(page, origin, { member: true });
  await page.evaluate(() => go("member"));
  await page.waitForSelector("#asaPfFirst", { timeout: 5000 }).catch(() => {});
  t("Kart: literal values", (await fieldState(page, "asaPfFirst")).value === XSS_IMG && (await fieldState(page, "asaPfLast")).value === XSS_SCRIPT);
  await page.waitForTimeout(200);
  const inj = await injected(page);
  t("Kart: nothing injected, no script ran", inj.img === 0 && inj.scripts === 0 && inj.flag === null, JSON.stringify(inj));
  t("no request for /x", !localHits.some((p) => p === "/x" || p === "/amsterdam/x"));
}, { supa: supa({ member: { first_name: XSS_IMG, last_name: XSS_SCRIPT } }) });

sc("validation: maxlength 50 for typing; 51 chars / empty / whitespace-only → role=alert, aria-invalid, focus, no RPC; server reasons mapped; then success", async ({ page, origin, t, sink }) => {
  await openHome(page, origin, { member: true });
  await page.focus("#npFirst"); await page.keyboard.type("a".repeat(51));
  t("typing stops at 50 (maxlength)", (await fieldState(page, "npFirst")).value.length === 50 && (await fieldState(page, "npFirst")).max === "50");
  await page.evaluate(() => { document.getElementById("npFirst").value = "a".repeat(51); document.getElementById("npLast").value = "Yılmaz"; });
  await page.click("#npSave"); await page.waitForTimeout(100);
  let b = await homeBanner(page);
  t("51 chars (pasted/scripted) → alert", b.err === MSG.firstLong && b.ok === "" && (await fieldState(page, "npFirst")).invalid === "true" && (await active(page)).id === "npFirst", JSON.stringify(b));
  await page.fill("#npFirst", ""); await page.click("#npSave"); await page.waitForTimeout(80);
  t("empty Ad → alert", (await homeBanner(page)).err === MSG.firstEmpty);
  await page.fill("#npFirst", "Ayşe"); await page.fill("#npLast", "  \t  "); await page.click("#npSave"); await page.waitForTimeout(80);
  b = await homeBanner(page);
  t("whitespace-only Soyad → alert, focus Soyad, Ad not marked", b.err === MSG.lastEmpty && (await active(page)).id === "npLast" && (await fieldState(page, "npLast")).invalid === "true" && (await fieldState(page, "npFirst")).invalid === null);
  await page.fill("#npFirst", " "); await page.fill("#npLast", ""); await page.click("#npSave"); await page.waitForTimeout(80);
  t("both empty → both messages", (await homeBanner(page)).err === MSG.firstEmpty + " " + MSG.lastEmpty);
  t("no RPC for any of these", rpcs(sink, "member_set_name").length === 0);
  const srv = await page.evaluate(async () => [await db.rpc("member_set_name", { p_first: "a".repeat(51), p_last: "B" }), await db.rpc("member_set_name", { p_first: "A", p_last: "   " }), await db.rpc("member_set_name", { p_first: "", p_last: "B" }), await db.rpc("member_set_name", { p_first: "A" + " ".repeat(199) + "B", p_last: "C" }), await db.rpc("member_set_name", { p_first: null, p_last: "C" })].map((r) => r.data.reason));
  t("server model: 51 / whitespace / empty / >200 raw / null rejected", JSON.stringify(srv) === JSON.stringify(["bad_first", "bad_last", "bad_first", "bad_first", "bad_first"]), JSON.stringify(srv));
  const n0 = rpcs(sink, "member_set_name").length;
  for (const [mode, text] of [["reason:no_member_row", MSG.noRow], ["error", MSG.net], ["throw", MSG.net], ["reason:no_auth", MSG.noAuth]]) {
    await page.evaluate((m) => { window.__WP5_SUPA_FAIL_NEXT.member_set_name = m; }, mode);
    await page.fill("#npFirst", "Ayşe"); await page.fill("#npLast", "Yılmaz"); await page.click("#npSave");
    await page.waitForFunction(() => document.getElementById("npErr").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
    b = await homeBanner(page);
    t("server " + mode + " → alert '" + text.slice(0, 24) + "…', no success, banner stays", b.err === text && b.ok === "" && b.visible, JSON.stringify(b));
  }
  await page.fill("#npFirst", "Ayşe"); await page.fill("#npLast", "Yılmaz"); await page.click("#npSave");
  await page.waitForFunction(() => document.getElementById("namePromptDone").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("then success: status only, alert cleared", (await homeBanner(page)).done === OK_TEXT && !(await homeBanner(page)).visible);
  await openProfile(page); await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { document.getElementById("profFirst").value = "b".repeat(51); });
  await page.click("#profSave"); await page.waitForTimeout(80);
  t("Profilim: 51 chars → alert, no success", (await page.textContent("#profErr")) === MSG.firstLong && (await page.textContent("#profOk")) === "" && (await page.getAttribute("#profErr", "role")) === "alert");
  t("UI made exactly 4 failed attempts + 1 successful RPC (none for client-side rejections)", rpcs(sink, "member_set_name").length - n0 === 5, String(rpcs(sink, "member_set_name").length - n0));
}, { supa: supa() });

sc("backend missing (42703 / PGRST202): no banner, no fields (home + city), login still works, nothing blocked", async ({ page, origin, t, sink }) => {
  await openHome(page, origin, { member: true });
  const sel = sink.find((e) => e.op === "select" && /first_name/.test(e.cols || ""));
  t("the name read was attempted (and failed with 42703)", !!sel);
  t("no banner, no inputs", !(await homeBanner(page)).visible && (await homeBanner(page)).inputs === 0);
  await openProfile(page); await page.waitForTimeout(150);
  t("Profilim: slot hidden and empty; WP4 profile intact", await page.evaluate(() => { const s = document.getElementById("amWp5Slot"); return s.hidden && s.childElementCount === 0 && document.querySelectorAll("#authBody input").length === 0 && document.getElementById("amName").textContent === "Deniz"; }));
  await page.keyboard.press("Escape");
  await logoutHome(page);
  await loginHome(page, MAIL);
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 5000 });
  await nameRead(page);
  t("login works; still no banner / fields", !(await homeBanner(page)).visible && (await page.locator("#profFirst, #npFirst").count()) === 0);
  const rpcErr = await page.evaluate(async () => { const r = await db.rpc("member_set_name", { p_first: "A", p_last: "B" }); return r.error && r.error.code; });
  t("stub models the missing RPC (PGRST202)", rpcErr === "PGRST202");
  await page.keyboard.press("Escape");
  await openCity(page, origin, { member: true });
  t("city: no banner", !(await cityBanner(page)).visible && (await cityBanner(page)).inputs === 0);
  await page.evaluate(() => go("member"));
  await page.waitForTimeout(150);
  t("city Kart: slot hidden and empty, existing profile form intact", await page.evaluate(() => { const s = document.getElementById("asaNameSlot"); return !!s && s.classList.contains("hide") && s.childElementCount === 0 && !document.getElementById("asaPfFirst") && !!document.getElementById("asaName"); }));
  t("page never wrote a name", rpcs(sink, "member_set_name").length === 1 && sink.filter((e) => e.op === "rpc" && e.name === "member_set_name")[0].at === "/");
}, { supa: supa({ members: [{ user_id: UID, email: MAIL, display_name: "Deniz", blocked: false, tier: "Kaşif", points: 3 }], supa: { backendMissing: true } }) });

sc("ASA_NAME script missing (404): pages work, no banner, no fields, no name query", async ({ page, origin, t, sink, errs }) => {
  await openHome(page, origin, { member: true, read: false });
  await page.waitForTimeout(300);
  t("home works without the library", (await page.evaluate(() => typeof window.ASA_NAME)) === "undefined" && !(await homeBanner(page)).visible);
  await openProfile(page);
  t("Profilim works, slot empty", await page.evaluate(() => document.getElementById("amWp5Slot").hidden && document.getElementById("amName").textContent === "Deniz"));
  await page.keyboard.press("Escape");
  await openCity(page, origin, { member: true, read: false });
  await page.waitForTimeout(300);
  t("city works without the library", !(await cityBanner(page)).visible && (await page.evaluate(() => !!window.ASA.session)));
  t("no name query without the library", !sink.some((e) => e.op === "select" && /first_name/.test(e.cols || "")));
  const other = errs.filter((e) => !(e.kind === "console" && /404/.test(e.text) && /asa_name\.js/.test(e.url)));
  t("only the expected 404 resource error", other.length === 0 && errs.length >= 1, JSON.stringify(errs.slice(0, 4)));
  errs.length = 0;   // the 404 itself is expected in this scenario
}, { supa: supa(), libMissing: true });

sc("localStorage throws (site data blocked): banner works, 'Şimdi değil' hides it for this page, offered again after reload, no errors", async ({ page, origin, t, sink }) => {
  await openHome(page, origin, { member: true });
  t("banner visible", (await homeBanner(page)).visible);
  await page.click("#npLater");
  t("hidden after Şimdi değil, focus #acctBtn", !(await homeBanner(page)).visible && (await active(page)).id === "acctBtn");
  await page.waitForTimeout(100);
  await openHome(page, origin, { member: true });
  t("cannot persist → offered again after reload (documented)", (await homeBanner(page)).visible);
  await page.fill("#npFirst", "Ayşe"); await page.fill("#npLast", "Yılmaz"); await page.click("#npSave");
  await page.waitForFunction(() => document.getElementById("namePromptDone").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("save still works", (await homeBanner(page)).done === OK_TEXT);
  await openCity(page, origin, { member: true });
  t("city: complete → no banner, WP3 'unavailable' notice shown as before", !(await cityBanner(page)).visible && (await page.evaluate(() => window.ASA_ST.mode())) === "unavailable");
}, { supa: supa(), blockLocalStorage: true });

sc("race: logout while the name read is pending → no banner; slow read with Profilim open → fields appear, focus kept", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true, read: false });
  await openMenu(page);
  await page.locator("#acctMenu nav button", { hasText: "Çıkış yap" }).click();
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === null, null, { timeout: 5000 });
  await page.waitForTimeout(900);
  t("stale read after logout is discarded: no banner, no fields", !(await homeBanner(page)).visible && (await page.locator("#npFirst, #profFirst").count()) === 0);
  await loginHome(page, MAIL);
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 5000 });
  const before = await active(page);
  t("Profilim open while the read is pending (slot hidden)", before.dlg === "authModal" && (await page.evaluate(() => document.getElementById("amWp5Slot").hidden)));
  await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  const after = await active(page);
  t("fields appear later; focus not moved", (await page.locator("#profFirst").count()) === 1 && after.id === before.id && after.dlg === "authModal", JSON.stringify([before, after]));
  t("banner appears behind the dialog", (await homeBanner(page)).visible && (await homeBanner(page)).count === 1);
}, { supa: supa({ supa: { selectDelayMs: { "members:first_name": 700 } } }) });

sc("race: a previous member's slow name read never overrides the next member (logout A → login B)", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true, read: false });          // A's own read is slow (900 ms)
  await logoutHome(page);
  await loginHome(page, NEW_MAIL);                                       // B: fast read, no name → banner
  await page.waitForFunction(() => document.getElementById("acctBtn").getAttribute("aria-haspopup") === "dialog", null, { timeout: 5000 });
  await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  t("B: banner + Profilim fields shown", (await homeBanner(page)).visible && (await page.locator("#profFirst").count()) === 1);
  await page.waitForTimeout(1300);                                       // A's stale answer arrives meanwhile
  t("B: still shown after A's stale read resolved (not overridden)", (await homeBanner(page)).visible && (await page.locator("#profFirst").count()) === 1 && (await page.evaluate(() => !document.getElementById("amWp5Slot").hidden)));
  t("B's Profilim never shows A's values", (await fieldState(page, "profFirst") || {}).value === "");
}, { supa: supa({ member: { first_name: "Ayşe", last_name: "Yılmaz" }, supa: { selectDelayMs: { ["members:first_name@" + UID]: 900 } } }) });

sc("double submit: Kaydet ×2 + Enter while in flight → one member_set_name; focus stays; Şimdi değil ignored meanwhile", async ({ page, origin, t, sink }) => {
  await openHome(page, origin, { member: true });
  await page.fill("#npFirst", "Ayşe"); await page.fill("#npLast", "Yılmaz");
  // aria-disabled makes Playwright wait for "enabled": the repeat clicks are forced, like a user hammering the button
  await page.click("#npSave"); await page.click("#npSave", { force: true }); await page.keyboard.press("Enter");
  const busy = await page.evaluate(() => { const b = document.getElementById("npSave"); return { ad: b.getAttribute("aria-disabled"), busy: b.getAttribute("aria-busy"), text: b.textContent, focus: document.activeElement === b }; });
  t("button busy (aria-disabled, aria-busy, Kaydediliyor…), focus kept", busy.ad === "true" && busy.busy === "true" && busy.text === "Kaydediliyor…" && busy.focus, JSON.stringify(busy));
  await page.click("#npLater", { force: true });
  t("Şimdi değil ignored while saving", (await homeBanner(page)).visible && (await page.evaluate((k) => localStorage.getItem(k), DISMISS_KEY)) === null);
  await page.waitForFunction(() => document.getElementById("namePromptDone").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("exactly one RPC", rpcs(sink, "member_set_name").length === 1, JSON.stringify(rpcs(sink, "member_set_name")));
  t("success once", (await homeBanner(page)).done === OK_TEXT && !(await homeBanner(page)).visible);
}, { supa: supa({ supa: { rpcDelayMs: { member_set_name: 500 } } }) });

sc("city page: banner after session restore (WP3 notice untouched), Tab + Enter save → status + focus, Kart shows it", async ({ page, origin, t, sink }) => {
  await openCity(page, origin, { member: true });
  let c = await cityBanner(page);
  t("banner visible with the exact copy", c.visible && c.title === TITLE && c.inputs === 2, JSON.stringify(c));
  t("WP3 storage notice unchanged (hidden on fresh storage)", await page.evaluate(() => document.getElementById("asaStoreNotice").classList.contains("hide") && window.ASA_ST.mode() === "ok"));
  t("not a dialog; focus not stolen", await page.evaluate(() => { const b = document.getElementById("asaNamePrompt"); return !b.getAttribute("aria-modal") && b.getAttribute("role") !== "dialog" && document.activeElement === document.body; }));
  await page.focus('header.app button[aria-label="Üyelik ve hesabım"]');
  const seq = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); seq.push((await active(page)).id); }
  t("Tab: header member button → Ad → Soyad → Kaydet → Şimdi değil", JSON.stringify(seq) === JSON.stringify(["asaNpFirst", "asaNpLast", "asaNpSave", "asaNpLater"]), JSON.stringify(seq));
  t("no overflow (city banner)", await noOverflow(page) && await inView(page, "#asaNamePrompt input, #asaNamePrompt button"));
  await page.focus("#asaNpFirst"); await page.keyboard.type("Gül"); await page.keyboard.press("Tab"); await page.keyboard.type("Şahin"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("asaNpDone").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  c = await cityBanner(page);
  t("Enter saves → status, banner hidden, focus on status", !c.visible && c.done === OK_TEXT && (await active(page)).id === "asaNpDone", JSON.stringify(c));
  t("one RPC with the typed values", JSON.stringify(rpcs(sink, "member_set_name").map((e) => e.args)) === JSON.stringify([{ p_first: "Gül", p_last: "Şahin" }]));
  await page.evaluate(() => go("member"));
  await page.waitForSelector("#asaPfFirst", { timeout: 5000 }).catch(() => {});
  t("Kart shows the values", (await fieldState(page, "asaPfFirst")).value === "Gül" && (await fieldState(page, "asaPfLast")).value === "Şahin");
  t("Kart's own profile form unchanged", (await page.locator("#asaNameBtn").textContent()) === "Değişiklikleri Kaydet" && (await page.inputValue("#asaName")) === "Deniz");
}, { supa: supa() });

sc("city page: 'Şimdi değil' → focus header member button, stays hidden after reload; Kart save path → status, banner closed", async ({ page, origin, t, sink }) => {
  await openCity(page, origin, { member: true });
  t("banner visible", (await cityBanner(page)).visible);
  await page.focus("#asaNpLater"); await page.keyboard.press("Enter");
  t("hidden; focus on the header member button", !(await cityBanner(page)).visible && (await active(page)).label === "Üyelik ve hesabım");
  t("flag stored", (await page.evaluate((k) => localStorage.getItem(k), DISMISS_KEY)) === "1");
  await openCity(page, origin, { member: true });
  t("reload: still hidden", !(await cityBanner(page)).visible);
  await page.evaluate(() => go("member"));
  await page.waitForSelector("#asaPfFirst", { timeout: 5000 }).catch(() => {});
  await page.fill("#asaPfFirst", "İlkay Nur"); await page.fill("#asaPfLast", "Demir");
  await page.click("#asaPfSave");
  await page.waitForFunction(() => document.getElementById("asaPfOk").textContent.length > 0 || document.getElementById("asaPfErr").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("Kart save → success status, no error", (await page.textContent("#asaPfOk")) === OK_TEXT && (await page.textContent("#asaPfErr")) === "" && (await page.getAttribute("#asaPfOk", "role")) === "status");
  t("own row saved", own(await stubState(page)).first_name === "İlkay Nur");
  await page.evaluate(() => { document.getElementById("asaPfFirst").value = ""; });
  await page.click("#asaPfSave"); await page.waitForTimeout(80);
  t("Kart: empty Ad → alert, success cleared", (await page.textContent("#asaPfErr")) === MSG.firstEmpty && (await page.textContent("#asaPfOk")) === "");
  t("no overflow (Kart)", await noOverflow(page));
}, { supa: supa() });

sc("city Kart re-render (ASA.render / seg): typed value, the form node and an in-flight save survive; one RPC; banner save updates a detached Kart", async ({ page, origin, t, sink }) => {
  await openCity(page, origin, { member: true });
  await page.evaluate(() => go("member"));
  await page.waitForSelector("#asaPfFirst", { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { document.getElementById("asaPfFirst").__wp5mark = 1; });
  await page.fill("#asaPfFirst", "Ayşe");
  await page.evaluate(() => { window.ASA.render(); window.ASA.seg("passport"); });
  t("typed value + same form node after re-render", (await fieldState(page, "asaPfFirst")).value === "Ayşe" && (await page.evaluate(() => document.getElementById("asaPfFirst").__wp5mark === 1)));
  // banner save while the Kart form is detached (another segment) → values land in the cached form
  await page.evaluate(() => window.ASA.seg("points"));
  await page.fill("#asaNpFirst", "Gül"); await page.fill("#asaNpLast", "Şahin"); await page.click("#asaNpSave");
  await page.waitForFunction(() => document.getElementById("asaNpDone").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => window.ASA.seg("passport"));
  t("detached Kart form shows the banner-saved values", (await fieldState(page, "asaPfFirst")).value === "Gül" && (await fieldState(page, "asaPfLast")).value === "Şahin");
  await page.fill("#asaPfFirst", "Gülay");
  await page.click("#asaPfSave");
  await page.evaluate(() => { window.ASA.render(); window.ASA.seg("passport"); });
  await page.click("#asaPfSave", { force: true });
  t("in-flight state survives the re-render (Kaydediliyor…)", (await page.textContent("#asaPfSave")) === "Kaydediliyor…");
  await page.waitForFunction(() => document.getElementById("asaPfOk").textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  t("one RPC for the Kart save despite re-render + second click", JSON.stringify(rpcs(sink, "member_set_name").map((e) => e.args.p_first)) === JSON.stringify(["Gül", "Gülay"]));
  t("success shown in the re-attached form", (await page.textContent("#asaPfOk")) === OK_TEXT && (await page.textContent("#asaPfErr")) === "");
}, { supa: supa({ supa: { rpcDelayMs: { member_set_name: 400 } } }) });

sc("layout: no horizontal overflow with banner + long error, Profilim slot, city banner + Kart", async ({ page, origin, t }) => {
  await openHome(page, origin, { member: true });
  await page.fill("#npFirst", "<x>"); await page.fill("#npLast", ""); await page.click("#npSave"); await page.waitForTimeout(80);
  t("home: banner + two-line error, no page overflow", await noOverflow(page) && (await homeBanner(page)).err.length > 60);
  t("home: banner controls inside the viewport", await inView(page, "#namePrompt input, #namePrompt button, #npErr"));
  await openProfile(page); await page.waitForSelector("#profFirst", { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { document.getElementById("profFirst").value = "x".repeat(50); });
  t("Profilim with slot: no overflow, no inner overflow", await noOverflow(page) && (await dlgOverflow(page, "authModal")) === false);
  await page.keyboard.press("Escape");
  await openCity(page, origin, { member: true });
  await page.fill("#asaNpFirst", "1"); await page.fill("#asaNpLast", "2"); await page.click("#asaNpSave"); await page.waitForTimeout(80);
  t("city: banner + error, no overflow", await noOverflow(page) && (await cityBanner(page)).err.length > 40 && await inView(page, "#asaNamePrompt input, #asaNamePrompt button"));
  await page.evaluate(() => go("member"));
  await page.waitForSelector("#asaPfFirst", { timeout: 5000 }).catch(() => {});
  t("city Kart with slot: no overflow", await noOverflow(page) && await inView(page, "#asaNameSlot input, #asaNameSlot button"));
}, { supa: supa(), vps: ALL_VP });

/* ---------- runner ---------- */
if (!HAS_CSS) console.log("NOTE tailwindcss build deps missing → layout-dependent checks are SKIPPED (WP5_E2E_INCOMPLETE)");
const { proc, origin } = await startServer();
const browser = await chromium.launch(process.env.WP5_CHROMIUM ? { executablePath: process.env.WP5_CHROMIUM } : {});
try {
  for (const vp of WANT_VP) {
    for (const s of scenarios) {
      if (ONLY && !s.name.includes(ONLY)) continue;
      if (!(s.opts.vps || ["desktop", "mobile"]).includes(vp)) continue;
      const label = `[${vp}] ${s.name}`;
      const { ctx, localHits } = await newContext(browser, origin, vp, s.opts.supa, s.opts);
      const page = await ctx.newPage();
      const errs = [], sink = [];
      attach(page, errs);
      await page.exposeBinding("__wp5Sink", (src, e) => { let p = ""; try { p = new URL(src.frame.url()).pathname; } catch {} sink.push(Object.assign({ at: p }, e)); });
      const t = (n, c, d) => {
        if (!HAS_CSS && /overflow|viewport|\(layout\)|header height/.test(n)) { skips++; console.log("SKIP " + label + " :: " + n + " (no Tailwind build)"); return; }
        ok(label + " :: " + n, c, d);
      };
      try { await s.fn({ page, origin, vp, t, ctx, localHits, sink, errs }); }
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
console.log(`WP5_E2E checks pass=${passes} fail=${fails} skip=${skips} (tailwind_build=${HAS_CSS ? "yes" : "no"})`);
if (passes + fails === 0) { console.log("NO_CHECKS_RAN (WP5_ONLY/WP5_VIEWPORTS matched nothing)"); fails++; }
if (fails) { console.log("WP5_E2E_FAIL"); process.exit(1); }
if (skips) { console.log("WP5_E2E_INCOMPLETE"); process.exit(4); }
console.log("WP5_E2E_PASS");
process.exit(0);
