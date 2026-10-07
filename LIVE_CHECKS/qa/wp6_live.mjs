// ASALOCAL · WP6 LIVE ACCEPTANCE — İş Paketi 6 end-to-end matrix with the dedicated QA accounts.
//
// Runs inside the QA runner exactly like wp4_live.mjs: playwright from $QA_DEPS, passwords only from
// $RUNNER_TEMP/qa_secrets.env (ASALOCAL_MEMBER_PASSWORD / ASALOCAL_ADMIN_PASSWORD), e-mails from env
// (ASALOCAL_MEMBER_EMAIL / ASALOCAL_ADMIN_EMAIL; never printed), target ASALOCAL_BASE_URL.
// Writes $S1_OUT_DIR/wp6_live_result.json {base, verdict, pass, fail, skip, checks:[{id,result,detail}], cleanup, side_effects}
// and prints one WP6_LIVE_SUMMARY line + one line per check. Exit 0 PASS, 1 FAIL.
//
// Accounts: "member" = QA member. "second" = the QA admin account used as a NORMAL second member (fresh context,
// normal login UI) for the isolation tests; logging in through the site creates its members row (accepted).
//
// Matrix (desktop 1366 + mobile 390; overflow-only smoke also at 360 and 768):
//   anon        home / Amsterdam / Kopenhag open · teaser "B" (first 10 catalog ids, map==list, paywall gate +N, scenarios 1+gate,
//               favourites view exempt) · login CTA opens the login UI · private areas unreachable, no member data in DOM
//   member-ro   login via the real UI · account menu · Profilim · e-mail prefs · trips · full venue list (+map==list) ·
//               all scenarios · favourites view · city member area (Beğeniler, E-posta Tercihleri) — NO writes
//   write       (desktop, QA member; every write undone in this run and verified):
//               favourite add -> reload -> present (asa:ams:fav + favorites table) ... -> remove -> reload -> absent;
//               trip create (home search form, 2099-01-10..12) -> trip page -> reopen from "Kayıtlı seyahatlerim";
//               plan save "Planımı oluştur" (trip_save + snapshot) -> server check -> "Planı temizle" -> archive trip via UI;
//               e-mail preference OFF/ON round trip only on a key whose start state is boolean (never on not_configured);
//               logout -> login on a fresh device -> trip / favourite / plan persisted -> cleanup
//   isolation   second member must not see the member's trip/favourite (UI + RLS reads) and vice versa (second member's
//               own favourite + 2099-02-10..12 trip, both undone)
//   technical   console errors 0 per scenario · no 4xx/5xx on critical requests (site documents/scripts/xhr, supabase
//               rest/auth) · third-party hosts listed · no horizontal overflow 360/390/768/1366 · keyboard (Tab reaches the
//               account button and the main CTA, Enter activates)
//   wp5         name completion PLACEHOLDER (feature-detected window.ASA_NAME; SKIP until WP5 ships)
// Side effects that are normal site behaviour (not undone): member_upsert_profile on login, log_city_view events,
// service_pref_set audit rows for the round trip, Supabase sessions (closed by the UI logout).
// Anything that could not be undone is listed in result.cleanup (ids + owner label only, never e-mails).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const BASE = (process.env.ASALOCAL_BASE_URL || "https://www.asalocal.club").replace(/\/+$/, "");
const SITE = new URL(BASE);
const SUPA_HOST = "tosqsabuaomgqjtogdrn.supabase.co";
const SECRETS = join(process.env.RUNNER_TEMP || "/tmp", "qa_secrets.env");
const OUT_FILE = join(process.env.S1_OUT_DIR || ".", "wp6_live_result.json");
const T = { nav: 60000, app: 30000, short: 10000, server: 25000 };
const HARD_LIMIT_MS = Number(process.env.WP6_TIME_LIMIT_MS || 30 * 60 * 1000);
const QA_TRIP = { start: "2099-01-10", end: "2099-01-12", label: "10 Oca–12 Oca", days: ["2099-01-10", "2099-01-11", "2099-01-12"] };
const QA_TRIP2 = { start: "2099-02-10", end: "2099-02-12", label: "10 Şub–12 Şub" };
const QA_YEAR = "2099-";
const VPS = {
  d1366: { width: 1366, height: 900, mobile: false },
  m390: { width: 390, height: 844, mobile: true },
  m360: { width: 360, height: 780, mobile: true },
  t768: { width: 768, height: 1024, mobile: true },
};
const MENU = ["Profilim", "E-posta tercihlerim", "Kayıtlı seyahatlerim", "Yeni seyahat oluştur", "Çıkış yap"];

// ------------------------------------------------------------------------------------------------ results
const checks = [];
const cleanup = [];
const sideEffects = new Set(["member_upsert_profile on each site login (normal behaviour)", "log_city_view event per logged-in Amsterdam page view (server-collapsed)"]);
const jsClicks = [];
const thirdHosts = new Map();
const minorBad = [];
let MASK = [];
function scrub(v) {
  let s = String(v == null ? "" : v);
  for (const m of MASK) if (m) s = s.split(m).join("[qa]");
  return s
    .replace(/eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)*/g, "[jwt]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, "$1")
    .replace(/file:\/\//gi, "file:").replace(/\/var\/tmp\//g, "/var-tmp/").replace(/Deno\./g, "Deno-")
    .replace(/ReferenceError/g, "Reference-Error").replace(/TypeError/g, "Type-Error")
    .replace(/service_role/gi, "service-role").replace(/SUPABASE_SERVICE/gi, "SUPABASE-SERVICE")
    .replace(/\bstack\b/gi, "stk").replace(/\bat(\s+\S+\s+)\(/g, "at$1[")
    .replace(/\s+/g, " ").trim();
}
function rec(id, ok, detail = "") {
  const result = ok === null ? "SKIP" : ok === "INFO" ? "INFO" : ok ? "PASS" : "FAIL";
  checks.push({ id, result, detail: scrub(detail).slice(0, 200) });
  return ok === true;
}
const errMsg = (e) => scrub((e && e.message) || e).slice(0, 160);
async function step(id, fn) {
  try { return await fn(); } catch (e) { rec(`${id}: scenario error`, false, errMsg(e)); return undefined; }
}

// ------------------------------------------------------------------------------------------------ setup
function readSecrets() {
  const o = {};
  for (const l of readFileSync(SECRETS, "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1).trim(); }
  return o;
}
let ACC = null;
try {
  const s = readSecrets();
  ACC = {
    member: { label: "qa_member", email: process.env.ASALOCAL_MEMBER_EMAIL || "", pw: s.ASALOCAL_MEMBER_PASSWORD || "" },
    second: { label: "qa_admin_as_member", email: process.env.ASALOCAL_ADMIN_EMAIL || "", pw: s.ASALOCAL_ADMIN_PASSWORD || "" },
  };
  for (const a of Object.values(ACC)) { a.local = a.email.split("@")[0]; MASK.push(a.email, a.email.toLowerCase(), a.pw); if (a.local.length >= 4) MASK.push(a.local); }
  MASK = MASK.filter((m) => m && m.length >= 4).sort((a, b) => b.length - a.length);
} catch (e) { rec("setup: secrets file readable", false, "qa_secrets.env missing or unreadable"); }
const setupOk = !!ACC && rec("setup: QA accounts configured", !!(ACC.member.email && ACC.member.pw && ACC.second.email && ACC.second.pw), ACC ? `member=${!!(ACC.member.email && ACC.member.pw)} second=${!!(ACC.second.email && ACC.second.pw)}` : "");

let chromium = null;
try { ({ chromium } = createRequire(join(process.env.QA_DEPS || process.cwd(), "noop.js"))("playwright")); }
catch (e) { rec("setup: playwright available in $QA_DEPS", false, errMsg(e)); }
let browser = null;
const openContexts = new Set();

// pending writes (undo bookkeeping); removed once the undo is verified
const pending = { favs: [], trips: [], plans: [], prefs: [] };
const drop = (arr, pred) => { const i = arr.findIndex(pred); if (i >= 0) arr.splice(i, 1); };

// ------------------------------------------------------------------------------------------------ browser helpers
async function newCtx(vp, { preseedFav = false } = {}) {
  const o = VPS[vp];
  const ctx = await browser.newContext({ viewport: { width: o.width, height: o.height }, isMobile: o.mobile, hasTouch: o.mobile });
  ctx.setDefaultTimeout(T.app);
  ctx.setDefaultNavigationTimeout(T.nav);
  // A member's device without local favourites: the city page would otherwise seed its default favourites into
  // asa:ams:fav and upload them to the favorites table on login (syncOnLogin). Only set when the key is absent.
  if (preseedFav) await ctx.addInitScript((origin) => { try { if (location.origin === origin && localStorage.getItem("asa:ams:fav") === null) localStorage.setItem("asa:ams:fav", "[]"); } catch (e) {} }, SITE.origin);
  openContexts.add(ctx);
  return ctx;
}
async function closeCtx(ctx) { if (!ctx) return; openContexts.delete(ctx); await ctx.close().catch(() => {}); }
function critical(u, rt) {
  if (u.host === SUPA_HOST) return /^\/(rest|auth|functions)\/v1\//.test(u.pathname);
  if (u.host === SITE.host) return !u.pathname.startsWith("/cdn-cgi/") && ["document", "script", "stylesheet", "fetch", "xhr"].includes(rt);
  return false;
}
// supabase-js: select = GET; insert/upsert = POST, update = PATCH, delete = DELETE on /rest/v1/<table>; rpc = POST /rest/v1/rpc/<fn>
const RO_RPC = new Set(["consent_get_my_state", "member_upsert_profile", "log_city_view", "similar_brains"]); // reads + accepted login/page-view side effects
function monitor(page) {
  const b = { console: [], bad: [], writes: [] };
  page.on("request", (q) => {
    try {
      const u = new URL(q.url()); const m = q.method();
      if (u.host !== SUPA_HOST || !u.pathname.startsWith("/rest/v1/") || ["GET", "HEAD", "OPTIONS"].includes(m)) return;
      if (u.pathname.startsWith("/rest/v1/rpc/")) { const fn = decodeURIComponent(u.pathname.slice(13)); if (!RO_RPC.has(fn)) b.writes.push(`rpc:${fn}`); }
      else b.writes.push(`${m}:${decodeURIComponent(u.pathname.slice(9))}`);
    } catch {}
  });
  page.on("console", (m) => { if (m.type() === "error") b.console.push(scrub(m.text()).slice(0, 120)); });
  page.on("pageerror", (e) => b.console.push("pageerror: " + scrub(e && e.message).slice(0, 120)));
  page.on("response", (r) => {
    try {
      const u = new URL(r.url()); const st = r.status(); const rt = r.request().resourceType();
      if (u.host !== SITE.host && u.host !== SUPA_HOST) thirdHosts.set(u.host, (thirdHosts.get(u.host) || 0) + 1);
      if (st < 400) return;
      const line = `${st} ${r.request().method()} ${u.host}${u.pathname}`.slice(0, 110);
      if (critical(u, rt)) b.bad.push(line); else minorBad.push(line);
    } catch {}
  });
  page.on("requestfailed", (q) => {
    try {
      const f = (q.failure() && q.failure().errorText) || "";
      if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(f)) return;
      const u = new URL(q.url()); const line = `failed ${q.method()} ${u.host}${u.pathname} ${f}`.slice(0, 110);
      if (critical(u, q.resourceType())) b.bad.push(line); else minorBad.push(line);
    } catch {}
  });
  return b;
}
function noWrites(id, mons) { const wr = mons.flatMap((m) => m.writes); rec(id, wr.length === 0, wr.length ? `${wr.length}: ${[...new Set(wr)].slice(0, 5).join(" ")}` : "no table writes / write RPCs (allowed: member_upsert_profile, log_city_view)"); }
function techChecks(scn, mons) {
  const con = mons.flatMap((m) => m.console), bad = mons.flatMap((m) => m.bad);
  rec(`tech/console-errors-0/${scn}`, con.length === 0, con.length ? `${con.length}: ${[...new Set(con)].slice(0, 3).join(" | ")}` : "none");
  rec(`tech/no-4xx-5xx-critical/${scn}`, bad.length === 0, bad.length ? `${bad.length}: ${[...new Set(bad)].slice(0, 4).join(" | ")}` : "none");
}
async function openPage(ctx) { const page = await ctx.newPage(); return { page, mon: monitor(page) }; }
const vis = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
async function press(page, sel, { text = null, timeout = 10000 } = {}) {
  const loc = text ? page.locator(sel, { hasText: text }).first() : page.locator(sel).first();
  try { await loc.click({ timeout }); return "click"; }
  catch (e) {
    const ok = await page.evaluate(([s, t]) => { const el = [...document.querySelectorAll(s)].find((x) => !t || (x.textContent || "").includes(t)); if (!el) return false; el.click(); return true; }, [sel, text]).catch(() => false);
    if (!ok) throw new Error(`UI element not found: ${sel}${text ? ` "${text}"` : ""}`);
    jsClicks.push(`${sel}${text ? `:${text}` : ""}`.slice(0, 60));
    return "js-click";
  }
}
async function poll(page, fn, arg, { timeout = T.server, every = 700 } = {}) {
  const end = Date.now() + timeout; let last = { ok: false };
  while (Date.now() < end) {
    try { last = await page.evaluate(fn, arg); if (last && last.ok) return last; } catch (e) { last = { ok: false, err: errMsg(e) }; }
    await page.waitForTimeout(every);
  }
  return last || { ok: false };
}
const memberLabel = () => /^Hesabım: /.test(document.getElementById("acctBtn")?.getAttribute("aria-label") || "");
async function gotoHome(page, { member = null } = {}) {
  const r = await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: "load" });
  await page.waitForFunction(() => typeof ASA_DLG !== "undefined" && !!document.getElementById("acctBtn") && (document.getElementById("countrySel")?.options.length || 0) > 1, null, { timeout: T.app });
  if (member === true) await page.waitForFunction(memberLabel, null, { timeout: T.app });
  if (member === false) await page.waitForTimeout(1200);
  return r;
}
async function gotoAms(page, { qs = "", member = null } = {}) {
  const r = await page.goto(`${BASE}/amsterdam/?city=Amsterdam${qs}&cb=${Date.now()}`, { waitUntil: "load" });
  await page.waitForFunction(() => !!(window.ASA_ST && window.ASA && typeof renderCards === "function" && document.querySelectorAll("#cards [data-venue-id]").length > 0), null, { timeout: T.app });
  if (member === true) await page.waitForFunction(() => !!(window.ASA && window.ASA.session), null, { timeout: T.app });
  // the page merges the venues table at 0 / 300 / 2000 ms; compare only after the last merge settled
  await page.waitForFunction(() => performance.now() > 2800 && !!window.__mv && (window.__mv.rows !== undefined || window.__mv.err !== undefined || window.__mv.ex !== undefined), null, { timeout: T.app }).catch(() => {});
  await page.waitForTimeout(member === false ? 1200 : 400);
  return r;
}
async function view(page, v) {
  await press(page, `#nav button[data-v="${v}"]`);
  await page.waitForFunction((x) => !!document.getElementById("v-" + x)?.classList.contains("active"), v, { timeout: T.short });
  if (v === "map") await page.waitForFunction(() => typeof MAP !== "undefined" && MAP.ready && MAP.layer && typeof MAP.layer.getLayers === "function", null, { timeout: T.app });
  await page.waitForTimeout(450);
}
// one consistent snapshot of what the city page shows (list cards, map markers, catalog, gates)
const SNAP = () => {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const markers = (typeof MAP !== "undefined" && MAP && MAP.layer && typeof MAP.layer.getLayers === "function") ? MAP.layer.getLayers() : null;
  return {
    cards: [...document.querySelectorAll("#cards [data-venue-id]")].map((e) => e.getAttribute("data-venue-id")),
    markers: markers ? markers.map((l) => l && l.asaVenueId).filter(Boolean) : null,
    otherPins: markers ? markers.filter((l) => !(l && l.asaVenueId)).length : null,
    domPins: document.querySelectorAll("#lmap path.leaflet-interactive, #lmap .leaflet-marker-icon").length,
    catalog: typeof cityCatalogIds === "function" ? cityCatalogIds() : [],
    teaser: typeof teaserIdList === "function" ? teaserIdList() : [],
    teaserMax: typeof TEASER_MAX !== "undefined" ? TEASER_MAX : null,
    fav: typeof favSet !== "undefined" ? [...favSet] : [],
    favView: typeof favView === "function" ? favView() : null,
    member: !!(window.ASA && window.ASA.session),
    gate: txt(document.querySelector("#cards .gate")),
    notes: [...document.querySelectorAll("#cards .note")].map(txt),
    count: txt(document.getElementById("count")),
    aria: txt(document.getElementById("mapTeaserAria")),
    scnCards: document.querySelectorAll("#scnGrid h3").length,
    scnTotal: typeof SCN !== "undefined" ? SCN.length : null,
    scnGate: txt(document.querySelector("#scnGrid .gate")),
  };
};
async function snap(page) {
  let prev = null, cur = null;
  for (let i = 0; i < 10; i++) { cur = await page.evaluate(SNAP); const k = JSON.stringify([cur.cards, cur.markers, cur.catalog]); if (k === prev) return cur; prev = k; await page.waitForTimeout(500); }
  return cur;
}
const sameSet = (a, b) => !!a && !!b && a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
const diffTxt = (a, b) => { const A = new Set(a || []), B = new Set(b || []); return `only-list=${[...A].filter((x) => !B.has(x)).slice(0, 3).join(",") || "-"} only-map=${[...B].filter((x) => !A.has(x)).slice(0, 3).join(",") || "-"}`; };
async function overflow(page, w) {
  return page.evaluate((w) => {
    const de = document.documentElement, b = document.body; const sw = Math.max(de.scrollWidth, b ? b.scrollWidth : 0);
    const off = [];
    if (sw > w + 1) for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 1 && getComputedStyle(el).position !== "fixed") { off.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList[0] ? "." + el.classList[0] : "")); if (off.length >= 3) break; }
    }
    return { ok: sw <= w + 1, sw, off };
  }, w);
}
async function recOverflow(id, page, w) { const o = await overflow(page, w); rec(id, o.ok, o.ok ? `scrollWidth=${o.sw}` : `scrollWidth=${o.sw} > ${w}: ${o.off.join(" ")}`); }
async function tabTo(page, selector, max = 80) {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((s) => !!document.activeElement && document.activeElement !== document.body && document.activeElement.matches(s), selector)) return i;
  }
  return 0;
}
async function focusTop(page) { await page.evaluate(() => { try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch (e) {} window.scrollTo(0, 0); }); await page.mouse.click(2, 2).catch(() => {}); await page.evaluate(() => { try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch (e) {} }); }
// RLS-scoped read through the page's own Supabase client (verification only; never writes)
const READ = async ({ table, cols, filters }) => {
  const c = (typeof window.asaDB === "function" && window.asaDB()) || (typeof db !== "undefined" ? db : null);
  if (!c) return { error: "no client" };
  const s = await c.auth.getSession(); const uid = s && s.data && s.data.session && s.data.session.user ? s.data.session.user.id : null;
  let q = c.from(table).select(cols);
  for (const [k, col, v] of filters || []) q = q[k](col, v);
  const r = await q;
  if (r.error) return { error: String(r.error.message || r.error).slice(0, 80) };
  const rows = r.data || [];
  return { rows, signedIn: !!uid, foreign: uid ? rows.filter((x) => x && x.user_id !== undefined && x.user_id !== uid).length : null };
};
const read = (page, table, cols, filters = []) => page.evaluate(READ, { table, cols, filters });

// ------------------------------------------------------------------------------------------------ UI flows
async function loginHome(page, who) {
  await gotoHome(page);
  if (await page.evaluate(memberLabel)) return "already";
  await press(page, "#acctBtn");
  await page.waitForSelector("#amEmail", { state: "visible", timeout: T.short });
  await page.fill("#amEmail", who.email);
  await page.fill("#amPw", who.pw);
  await press(page, "#amAuth");
  await page.waitForFunction(() => /^Hesabım: /.test(document.getElementById("acctBtn")?.getAttribute("aria-label") || "") || (document.getElementById("amErr")?.textContent || "").trim().length > 0, null, { timeout: T.app });
  if (!(await page.evaluate(memberLabel))) throw new Error("home login failed: " + (await page.evaluate(() => document.getElementById("amErr")?.textContent || "")).slice(0, 60));
  if (await vis(page, "#authModal [role=dialog]")) { await page.keyboard.press("Escape"); await page.waitForTimeout(250); }
  return "ui";
}
async function loginCity(page, who) {
  await gotoAms(page, { member: false });
  if (await page.evaluate(() => !!(window.ASA && window.ASA.session))) return "already";
  await press(page, 'header button[aria-label="Üyelik ve hesabım"]');
  await page.waitForSelector("#asaEmail", { state: "visible", timeout: T.short });
  await page.fill("#asaEmail", who.email);
  await page.fill("#asaPw", who.pw);
  await press(page, "#asaAuthBtn");
  await page.waitForFunction(() => !!(window.ASA && window.ASA.session) || (document.getElementById("asaErr")?.textContent || "").trim().length > 0, null, { timeout: T.app });
  if (!(await page.evaluate(() => !!(window.ASA && window.ASA.session)))) throw new Error("city login failed: " + (await page.evaluate(() => document.getElementById("asaErr")?.textContent || "")).slice(0, 60));
  return "ui";
}
async function closeDialogs(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => typeof ASA_DLG !== "undefined" && !!ASA_DLG.top()).catch(() => false);
    if (!open) return;
    await page.keyboard.press("Escape"); await page.waitForTimeout(220);
  }
}
async function openMenu(page) {
  await closeDialogs(page);
  await press(page, "#acctBtn");
  await page.waitForFunction(() => ASA_DLG.isOpen(document.getElementById("acctMenu")), null, { timeout: T.short });
}
async function menuAction(page, key) { await openMenu(page); await press(page, `#acctMenu [data-acct="${key}"]`); }
async function openTrips(page) {
  await menuAction(page, "trips");
  await page.waitForFunction(() => { const l = document.getElementById("tripsList"); const e = document.getElementById("tripsErr"); return (e && e.textContent.trim()) || (l && l.textContent.trim() && !/Yükleniyor/.test(l.textContent)); }, null, { timeout: T.app });
  return page.evaluate(() => ({
    rows: [...document.querySelectorAll("#tripsList [data-trip-row]")].map((r) => ({ id: r.getAttribute("data-trip-row"), text: r.textContent.replace(/\s+/g, " ").trim() })),
    err: (document.getElementById("tripsErr")?.textContent || "").trim(), empty: !!document.getElementById("tripsEmptyNew"),
  }));
}
async function archiveTripUI(page, id) {
  const before = await openTrips(page);
  if (!before.rows.some((r) => r.id === String(id))) { await closeDialogs(page); return { ok: false, why: "row not listed" }; }
  await press(page, `#tripsList [data-trip-act="archive"][data-trip-id="${id}"]`);
  await page.waitForFunction((i) => !document.querySelector(`#tripsList [data-trip-row="${i}"]`) || (document.getElementById("tripsErr")?.textContent || "").trim(), String(id), { timeout: T.app }).catch(() => {});
  const r = await page.evaluate((i) => ({ gone: !document.querySelector(`#tripsList [data-trip-row="${i}"]`), okTxt: (document.getElementById("tripsOk")?.textContent || "").trim(), err: (document.getElementById("tripsErr")?.textContent || "").trim() }), String(id));
  await closeDialogs(page);
  return { ok: r.gone && !r.err, ...r };
}
async function openPrefs(page) {
  await menuAction(page, "prefs");
  await page.waitForFunction(() => (document.getElementById("prefsBody")?.querySelectorAll("[data-pref-row]").length || 0) > 0 || /Gösterilecek/.test(document.getElementById("prefsBody")?.textContent || "") || (document.getElementById("prefsErr")?.textContent || "").trim().length > 0, null, { timeout: T.app });
  return page.evaluate(() => ({
    states: Object.fromEntries([...document.querySelectorAll("#prefsBody [data-pref-row]")].map((r) => [r.getAttribute("data-pref-row"), r.querySelector("[data-pref-state]")?.getAttribute("data-pref-state") || "?"])),
    err: (document.getElementById("prefsErr")?.textContent || "").trim(), body: (document.getElementById("prefsBody")?.textContent || "").trim().length,
  }));
}
async function createTripUI(page, t) {
  await gotoHome(page, { member: true });
  await page.selectOption("#countrySel", "nl");
  await page.waitForFunction(() => !document.getElementById("citySel").disabled, null, { timeout: T.short });
  await page.selectOption("#citySel", "Amsterdam");
  await page.fill("#dStart", t.start);
  await page.fill("#dEnd", t.end);
  await page.waitForFunction(() => !document.getElementById("goBtn").disabled, null, { timeout: T.short });
  const info = await page.evaluate(() => (document.getElementById("dInfo")?.textContent || "").trim());
  await Promise.all([page.waitForURL(/\/amsterdam\//, { timeout: T.nav }), press(page, "#goBtn")]);
  const id = new URL(page.url()).searchParams.get("trip");
  return { id: id && /^\d+$/.test(id) ? id : null, info };
}
async function heart(page, id) {
  await view(page, "list");
  const sel = `#cards [data-venue-id="${id}"] button`;
  if (!(await page.locator(`#cards [data-venue-id="${id}"]`).count())) throw new Error(`venue card ${id} not rendered`);
  await page.locator(sel, { hasText: "favorite" }).first().scrollIntoViewIfNeeded().catch(() => {});
  return press(page, sel, { text: "favorite" });
}
const favState = (page, id) => page.evaluate((v) => {
  let local = null; try { local = JSON.parse(localStorage.getItem("asa:ams:fav") || "null"); } catch (e) {}
  const card = document.querySelector(`#cards [data-venue-id="${v}"]`);
  const icon = card ? [...card.querySelectorAll("button .msym")].map((s) => s.textContent.trim()).find((t) => /^favorite/.test(t)) : null;
  return { mem: typeof isFav === "function" ? isFav(v) : null, local: Array.isArray(local) ? local.includes(v) : null, icon };
}, id);
async function cloudHas(page, venue) { const r = await read(page, "favorites", "venue_id,user_id", [["eq", "venue_id", venue]]); return r.error ? null : r.rows.length > 0; }
async function waitCloud(page, venue, want) {
  const end = Date.now() + T.server; let v = null;
  while (Date.now() < end) { v = await cloudHas(page, venue).catch(() => null); if (v === want) return true; await page.waitForTimeout(700); }
  return v === want;
}
async function logoutHome(page) {
  await menuAction(page, "logout");
  await page.waitForFunction(() => /Giriş yap/.test(document.getElementById("acctBtn")?.getAttribute("aria-label") || ""), null, { timeout: T.app });
  return page.evaluate(() => ({ label: document.getElementById("acctBtn").getAttribute("aria-label"), asaSession: localStorage.getItem("asa_session"), sbKeys: Object.keys(localStorage).filter((k) => /^sb-.*-auth-token$/.test(k)).length, focus: document.activeElement && document.activeElement.id }));
}

// ------------------------------------------------------------------------------------------------ facts shared between scenarios
const facts = { anonCards: null, catalog: null, memberTrip: null, X: null };

// ================================================================================================ ANONYMOUS
async function anonScenario(vp) {
  const P = `anon/${vp}`;
  const ctx = await newCtx(vp);
  const { page, mon } = await openPage(ctx);
  try {
    await step(`${P}/home`, async () => {
      const r = await gotoHome(page, { member: false });
      const t = await page.title();
      rec(`${P}/home-opens`, !!r && r.status() === 200 && /asalocal/i.test(t), `http=${r && r.status()} title="${t}"`);
      const label = await page.getAttribute("#acctBtn", "aria-label");
      rec(`${P}/home-account-button-is-login-entry`, /Giriş yap \/ üye ol/.test(label || "") && !(await page.getAttribute("#acctBtn", "aria-haspopup")), label);
      await press(page, "#acctBtn");
      await page.waitForTimeout(350);
      rec(`${P}/home-login-cta-opens-login-dialog`, (await vis(page, "#authModal [role=dialog]")) && (await vis(page, "#amEmail")) && (await vis(page, "#amPw")) && !(await vis(page, "#acctMenu [role=dialog]")));
      await closeDialogs(page);
      // private areas: the page's own entry points must route an anonymous visitor to the login dialog
      const priv = await page.evaluate(() => {
        const shown = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== "none"; };
        const res = {};
        try { openAcctMenu(); } catch (e) {}
        res.menu = shown("acctMenu"); try { ASA_DLG.close(document.getElementById("acctMenu")); } catch (e) {}
        try { openTripsModal(); } catch (e) {}
        res.trips = shown("tripsModal"); res.tripsToLogin = shown("authModal"); try { closeAuth(); } catch (e) {}
        try { openPrefs(); } catch (e) {}
        res.prefs = shown("prefsModal"); res.prefsToLogin = shown("authModal"); try { closeAuth(); } catch (e) {}
        res.data = ["tripHub", "tripsList", "prefsBody", "acctMenuWho"].map((id) => (document.getElementById(id)?.textContent || "").trim().length).reduce((a, b) => a + b, 0);
        res.sb = Object.keys(localStorage).filter((k) => /^sb-.*-auth-token$/.test(k)).length;
        return res;
      });
      rec(`${P}/home-private-areas-not-reachable`, !priv.menu && !priv.trips && priv.tripsToLogin && !priv.prefs && priv.prefsToLogin && priv.data === 0 && priv.sb === 0, JSON.stringify(priv));
      await closeDialogs(page);
    });
    await step(`${P}/amsterdam`, async () => {
      const r = await gotoAms(page, { member: false });
      const t = await page.title();
      let s = await snap(page);
      rec(`${P}/amsterdam-opens`, !!r && r.status() === 200 && /Amsterdam/.test(t) && s.cards.length > 0 && !s.member, `http=${r && r.status()} title="${t}" cards=${s.cards.length}`);
      facts.catalog = s.catalog.length;
      const total = s.catalog.length, max = s.teaserMax || 10, hidden = Math.max(0, total - max);
      await view(page, "list");
      s = await snap(page);
      facts.anonCards = s.cards.length;
      if (total > max) {
        rec(`${P}/teaser-list-is-first-${max}-catalog-ids`, s.cards.length === max && sameSet(s.cards, s.teaser) && sameSet(s.teaser, s.catalog.slice(0, max)), `cards=${s.cards.length} catalog=${total} ${diffTxt(s.cards, s.teaser)}`);
        rec(`${P}/teaser-paywall-gate`, /Devamı üyeler için/.test(s.gate) && s.gate.includes(`+${hidden} mekân daha üyeler için`) && /Üye ol veya giriş yap/.test(s.gate) && /Favorilerime git/.test(s.gate) && s.notes.some((n) => /İlk 10 mekân gösteriliyor/.test(n)) && /^10 mekan/.test(s.count), `gate="${s.gate.slice(0, 90)}" count="${s.count}"`);
      } else {
        rec(`${P}/teaser-list-all-when-catalog-small`, s.cards.length === total && !s.gate, `catalog=${total} cards=${s.cards.length}`);
      }
      await view(page, "map");
      const m = await snap(page);
      rec(`${P}/map-equals-list-teaser`, sameSet(m.markers, s.cards), `markers=${m.markers ? m.markers.length : "n/a"} list=${s.cards.length} adPins=${m.otherPins} domPins=${m.domPins} ${diffTxt(s.cards, m.markers)}`);
      if (total > max) rec(`${P}/map-teaser-note`, m.aria === "Harita ile liste aynı 10 mekânı gösterir.", m.aria);
      await view(page, "pano");
      const p = await snap(page);
      rec(`${P}/scenarios-teaser-1-plus-gate`, p.scnTotal > 1 ? p.scnCards === 1 && p.scnGate.includes(`${p.scnTotal - 1} rota daha üyelere özel`) : p.scnCards === p.scnTotal, `cards=${p.scnCards}/${p.scnTotal} gate="${p.scnGate.slice(0, 60)}"`);
      // favourites view ("Favorilerime git" in the gate) is exempt from the teaser, list == map
      await view(page, "list");
      if (total > max) {
        await press(page, "#cards .gate-sec", { text: "Favorilerime git" });
        await page.waitForFunction(() => typeof favView === "function" && favView(), null, { timeout: T.short });
        await page.waitForTimeout(300);
        const f = await snap(page);
        const expect = f.catalog.filter((id) => f.fav.includes(id));
        const noteOk = expect.length ? f.notes.some((n) => /Favorilerin bu cihazda/.test(n)) : f.notes.some((n) => /Henüz favorin yok/.test(n));
        rec(`${P}/favourites-view-device-favs-no-paywall`, sameSet(f.cards, expect) && !f.gate && noteOk, `cards=${f.cards.length} deviceFavs=${expect.length} gate=${!!f.gate}`);
        await view(page, "map");
        const fm = await snap(page);
        rec(`${P}/favourites-view-map-equals-list`, sameSet(fm.markers, f.cards), `markers=${fm.markers ? fm.markers.length : "n/a"} list=${f.cards.length} ${diffTxt(f.cards, fm.markers)}`);
        await view(page, "list");
        await press(page, '#chips .chip[data-k="fav"]');
        await page.waitForFunction(() => !favView(), null, { timeout: T.short });
        await page.waitForTimeout(300);
        // join/login CTA in the paywall gate opens the city page's login form
        await press(page, "#cards .gate-b", { text: "Üye ol veya giriş yap" });
        await page.waitForFunction(() => !!document.getElementById("v-member")?.classList.contains("active"), null, { timeout: T.short });
        await page.waitForTimeout(300);
        rec(`${P}/paywall-cta-opens-login-form`, (await vis(page, "#asaEmail")) && (await vis(page, "#asaPw")) && (await vis(page, "#asaAuthBtn")));
      }
      await view(page, "member");
      const pv = await page.evaluate(() => ({ session: !!(window.ASA && window.ASA.session), logout: !!document.getElementById("asaLogout"), seg: !!document.getElementById("segBody"), prefs: !!document.getElementById("asaPrefsBody"), trip: !!window.TRIP, banner: !document.getElementById("tripBanner")?.classList.contains("hide"), form: !!document.getElementById("asaEmail"), sb: Object.keys(localStorage).filter((k) => /^sb-.*-auth-token$/.test(k)).length }));
      rec(`${P}/amsterdam-no-member-data`, !pv.session && !pv.logout && !pv.seg && !pv.prefs && !pv.trip && !pv.banner && pv.form && pv.sb === 0, JSON.stringify(pv));
    });
    await step(`${P}/kopenhag`, async () => {
      const r = await page.goto(`${BASE}/kopenhag/?cb=${Date.now()}`, { waitUntil: "load" });
      await page.waitForTimeout(500);
      const h = await page.evaluate(() => ({ t: document.title, h1: (document.querySelector("h1")?.textContent || "").trim() }));
      rec(`${P}/kopenhag-stub-opens`, !!r && r.status() === 200 && /Kopenhag/.test(h.t) && /Kopenhag/.test(h.h1), `http=${r && r.status()} title="${h.t}"`);
    });
  } finally {
    noWrites(`${P}/no-writes`, [mon]);
    techChecks(P, [mon]);
    await closeCtx(ctx);
  }
}

// ================================================================================================ OVERFLOW SMOKE (anon)
async function overflowSmoke(vp) {
  const P = `tech/no-horizontal-overflow/${VPS[vp].width}`;
  const w = VPS[vp].width;
  const ctx = await newCtx(vp);
  const { page, mon } = await openPage(ctx);
  try {
    await step(P, async () => {
      await gotoHome(page, { member: false });
      await recOverflow(`${P}/home`, page, w);
      await gotoAms(page, { member: false });
      await recOverflow(`${P}/amsterdam-pano`, page, w);
      await view(page, "list"); await recOverflow(`${P}/amsterdam-list`, page, w);
      await view(page, "map"); await recOverflow(`${P}/amsterdam-map`, page, w);
      await page.goto(`${BASE}/kopenhag/?cb=${Date.now()}`, { waitUntil: "load" }); await page.waitForTimeout(400);
      await recOverflow(`${P}/kopenhag`, page, w);
    });
  } finally { techChecks(`overflow-${w}`, [mon]); await closeCtx(ctx); }
}

// ================================================================================================ KEYBOARD (anon, desktop)
async function keyboardAnon() {
  const P = "tech/keyboard/anon";
  const ctx = await newCtx("d1366");
  const { page, mon } = await openPage(ctx);
  try {
    await step(`${P}/home`, async () => {
      await gotoHome(page, { member: false });
      await focusTop(page);
      const n = await tabTo(page, "#acctBtn", 20);
      rec(`${P}/tab-reaches-home-account-button`, n > 0, `tabs=${n}`);
      if (n) { await page.keyboard.press("Enter"); await page.waitForTimeout(350); rec(`${P}/enter-opens-login-dialog`, (await vis(page, "#authModal [role=dialog]")) && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "amEmail"); await closeDialogs(page); }
      // main CTA: country + city chosen with the keyboard (ArrowDown on the focused select), then Tab to "Keşfet"
      await focusTop(page);
      const c = await tabTo(page, "#countrySel", 30);
      let how = "keyboard";
      if (c) { await page.keyboard.press("ArrowDown"); await page.waitForTimeout(150); }
      if (await page.evaluate(() => document.getElementById("countrySel").value !== "nl")) { how = "selectOption"; await page.selectOption("#countrySel", "nl"); }
      await page.focus("#countrySel");
      const ci = await tabTo(page, "#citySel", 5);
      if (ci) { await page.keyboard.press("ArrowDown"); await page.waitForTimeout(150); }
      if (await page.evaluate(() => document.getElementById("citySel").value !== "Amsterdam")) { how = "selectOption"; await page.selectOption("#citySel", "Amsterdam"); await page.focus("#citySel"); }
      const g = await tabTo(page, "#goBtn", 40);
      rec(`${P}/tab-reaches-home-main-cta`, g > 0 && c > 0, `countrySel@${c} goBtn+${g} select=${how}`);
      if (g) {
        await Promise.all([page.waitForURL(/\/amsterdam\//, { timeout: T.nav }).catch(() => {}), page.keyboard.press("Enter")]);
        rec(`${P}/enter-activates-home-main-cta`, /\/amsterdam\//.test(new URL(page.url()).pathname) && !new URL(page.url()).searchParams.get("trip"), new URL(page.url()).pathname);
      }
    });
    await step(`${P}/amsterdam`, async () => {
      await gotoAms(page, { member: false });
      await focusTop(page);
      const n = await tabTo(page, 'header button[aria-label="Üyelik ve hesabım"]', 20);
      rec(`${P}/tab-reaches-city-account-button`, n > 0, `tabs=${n}`);
      if (n) { await page.keyboard.press("Enter"); await page.waitForTimeout(400); rec(`${P}/enter-opens-city-member-view`, (await page.evaluate(() => !!document.getElementById("v-member")?.classList.contains("active"))) && (await vis(page, "#asaEmail"))); }
      await view(page, "list");
      await focusTop(page);
      const g = await tabTo(page, "#cards .gate-b", 260);
      rec(`${P}/tab-reaches-city-paywall-cta`, g > 0, `tabs=${g}`);
      if (g) { await page.keyboard.press("Enter"); await page.waitForTimeout(400); rec(`${P}/enter-activates-city-paywall-cta`, (await page.evaluate(() => !!document.getElementById("v-member")?.classList.contains("active"))) && (await vis(page, "#asaEmail"))); }
    });
  } finally { techChecks("keyboard-anon", [mon]); await closeCtx(ctx); }
}

// ================================================================================================ WP5 PLACEHOLDER
// WP5 · name completion — PLACEHOLDER. Fill the selectors after WP5 lands (operator). Guarded by feature detection:
// without window.ASA_NAME every check is SKIP. Read-only until the write round trip below is filled in.
async function wp5NameChecks(page, P) {
  const has = await page.evaluate(() => typeof window.ASA_NAME !== "undefined" && window.ASA_NAME !== null).catch(() => false);
  if (!has) { rec(`${P}/wp5-name-completion`, null, "window.ASA_NAME not present (WP5 not deployed)"); return; }
  const SEL = {
    slot: "#amWp5Slot",     // WP4 slot inside Profilim (data-wp5-slot="profile-name")
    first: null,            // WP5-TODO: first-name input selector
    last: null,             // WP5-TODO: last-name input selector
    save: null,             // WP5-TODO: save button selector
    prompt: null,           // WP5-TODO: "Profilini tamamla" prompt selector (if any)
  };
  await menuAction(page, "profile");
  await page.waitForTimeout(400);
  const slot = await page.evaluate((s) => { const el = document.querySelector(s); return el ? { hidden: el.hidden || getComputedStyle(el).display === "none", inputs: el.querySelectorAll("input,select,textarea").length } : null; }, SEL.slot);
  rec(`${P}/wp5-slot-visible-in-profilim`, !!slot && !slot.hidden && slot.inputs > 0, JSON.stringify(slot));
  await closeDialogs(page);
  if (!SEL.first || !SEL.last || !SEL.save) { rec(`${P}/wp5-name-write-roundtrip`, null, "WP5-TODO: selectors not filled in yet; no write performed"); return; }
  // WP5-TODO: read current values -> write QA test value -> reload -> verify -> restore exact start values -> verify.
}

// ================================================================================================ MEMBER READ-ONLY
async function memberReadOnly(vp) {
  const P = `member-ro/${vp}`;
  const w = VPS[vp].width;
  const ctx = await newCtx(vp, { preseedFav: true });
  const { page, mon } = await openPage(ctx);
  let loggedIn = false;
  try {
    await step(`${P}/home`, async () => {
      const how = await loginHome(page, ACC.member);
      loggedIn = true;
      const label = await page.getAttribute("#acctBtn", "aria-label");
      rec(`${P}/login-via-ui`, how === "ui" && /^Hesabım: /.test(label || ""), (label || "").replace(/:.*/, ": ***"));
      await openMenu(page);
      const items = await page.locator("#acctMenu [data-acct]").allInnerTexts();
      rec(`${P}/member-menu-visible`, (await vis(page, "#acctMenu [role=dialog]")) && JSON.stringify(items.map((t) => t.trim())) === JSON.stringify(MENU), items.join(" | "));
      await recOverflow(`tech/no-horizontal-overflow/${w}/member-home-menu`, page, w);
      await closeDialogs(page);
      await menuAction(page, "profile");
      await page.waitForFunction(() => document.getElementById("authTitle")?.textContent === "Profilim", null, { timeout: T.short });
      const prof = await page.evaluate((em) => ({ title: document.getElementById("authTitle")?.textContent, mail: (document.getElementById("amEmailRo")?.textContent || "") === em, name: (document.getElementById("amName")?.textContent || "").length > 0 }), ACC.member.email.toLowerCase());
      rec(`${P}/profilim-opens`, prof.title === "Profilim" && prof.mail && prof.name, JSON.stringify(prof));
      await closeDialogs(page);
      const pr = await openPrefs(page);
      rec(`${P}/prefs-open`, !pr.err && Object.keys(pr.states).length > 0, `keys=${Object.keys(pr.states).length} states=${[...new Set(Object.values(pr.states))].join("/")} ${pr.err}`);
      await closeDialogs(page);
      const tr = await openTrips(page);
      rec(`${P}/trips-open`, !tr.err && (tr.rows.length > 0 || tr.empty), `rows=${tr.rows.length} empty=${tr.empty} ${tr.err}`);
      await closeDialogs(page);
      if (vp === "d1366") {
        await focusTop(page);
        const n = await tabTo(page, "#acctBtn", 20);
        if (n) await page.keyboard.press("Enter");
        await page.waitForTimeout(350);
        const k = await page.evaluate(() => ({ open: ASA_DLG.isOpen(document.getElementById("acctMenu")), focus: document.activeElement && document.activeElement.getAttribute("data-acct") }));
        rec("tech/keyboard/member/tab-enter-opens-account-menu", n > 0 && k.open && k.focus === "profile", `tabs=${n} ${JSON.stringify(k)}`);
        if (k.open) { await page.keyboard.press("Enter"); await page.waitForTimeout(350); rec("tech/keyboard/member/enter-on-profilim-opens-profile", (await page.evaluate(() => document.getElementById("authTitle")?.textContent)) === "Profilim"); }
        await closeDialogs(page);
      }
      await wp5NameChecks(page, P);
    });
    if (loggedIn) await step(`${P}/amsterdam`, async () => {
      await gotoAms(page, { member: true });
      await view(page, "list");
      const s = await snap(page);
      rec(`${P}/amsterdam-full-list`, s.member && sameSet(s.cards, s.catalog) && !s.gate && /Tüm mekânlar açık/.test(s.count) && (facts.anonCards == null || s.catalog.length <= 10 || s.cards.length > facts.anonCards), `cards=${s.cards.length} catalog=${s.catalog.length} anon=${facts.anonCards} count="${s.count}"`);
      await recOverflow(`tech/no-horizontal-overflow/${w}/member-amsterdam-list`, page, w);
      await view(page, "map");
      const m = await snap(page);
      rec(`${P}/map-equals-list-member`, sameSet(m.markers, s.cards), `markers=${m.markers ? m.markers.length : "n/a"} list=${s.cards.length} ${diffTxt(s.cards, m.markers)}`);
      await view(page, "pano");
      const p = await snap(page);
      rec(`${P}/scenarios-all-visible`, p.scnCards === p.scnTotal && !p.scnGate, `cards=${p.scnCards}/${p.scnTotal}`);
      await view(page, "list");
      await press(page, '#chips .chip[data-k="fav"]');
      await page.waitForFunction(() => favView(), null, { timeout: T.short });
      await page.waitForTimeout(300);
      const f = await snap(page);
      const expect = f.catalog.filter((id) => f.fav.includes(id));
      rec(`${P}/favourites-view-works`, sameSet(f.cards, expect) && !f.gate && (expect.length > 0 || f.notes.some((n) => /Henüz favorin yok/.test(n))), `cards=${f.cards.length} accountFavs=${expect.length}`);
      await view(page, "map");
      const fm = await snap(page);
      rec(`${P}/favourites-view-map-markers`, "INFO", `member fav view: list=${f.cards.length} map=${fm.markers ? fm.markers.length : "n/a"} (code: members' map ignores the fav filter)`);
      await view(page, "list");
      await press(page, '#chips .chip[data-k="fav"]');
      await page.waitForFunction(() => !favView(), null, { timeout: T.short });
      await view(page, "member");
      await press(page, "#memberBody button", { text: "Beğeniler" });
      await page.waitForTimeout(400);
      const likes = await page.evaluate(() => ({ rows: document.querySelectorAll("#segBody .likerow").length, empty: /Henüz bir yeri kaydetmedin/.test(document.getElementById("segBody")?.textContent || ""), fav: typeof favSet !== "undefined" ? favSet.size : -1, logout: !!document.getElementById("asaLogout") }));
      rec(`${P}/city-member-area-likes`, likes.logout && (likes.fav === 0 ? likes.empty : likes.rows === likes.fav), JSON.stringify(likes));
      await press(page, "#memberBody button", { text: "E-posta Tercihleri" });
      await page.waitForFunction(() => { const b = document.getElementById("asaPrefsBody"); return b && b.textContent.trim() && !/Yükleniyor/.test(b.textContent); }, null, { timeout: T.app });
      const cp = await page.evaluate(() => ({ rows: document.querySelectorAll("#asaPrefsBody button[data-prefkey]").length, err: (document.getElementById("asaPrefsErr")?.textContent || "").trim(), failed: /yüklenemedi/.test(document.getElementById("asaPrefsBody")?.textContent || "") }));
      rec(`${P}/city-member-area-prefs`, cp.rows > 0 && !cp.err && !cp.failed, JSON.stringify(cp));
      await recOverflow(`tech/no-horizontal-overflow/${w}/member-amsterdam-member`, page, w);
      noWrites(`${P}/no-writes-in-read-only-part`, [mon]);
    });
    if (loggedIn) await step(`${P}/logout`, async () => {
      await gotoHome(page, { member: true });
      const o = await logoutHome(page);
      loggedIn = false;
      rec(`${P}/logout`, /Giriş yap/.test(o.label || "") && o.asaSession === null && o.sbKeys === 0 && o.focus === "acctBtn", JSON.stringify(o));
    });
  } finally { techChecks(P, [mon]); await closeCtx(ctx); }
}

// ================================================================================================ WRITES + ISOLATION + PERSISTENCE
async function writeScenario() {
  const W = await newCtx("d1366", { preseedFav: true });
  const S = await newCtx("d1366", { preseedFav: true });
  const w = await openPage(W), s = await openPage(S);
  const wp = w.page, sp = s.page;
  const mons = [w.mon, s.mon];
  let memberTrip = null, secondTrip = null, X = null, Y = null, wIn = false, sIn = false;
  try {
    // ---------------- baselines + leftovers from aborted runs
    const ok0 = await step("write/setup", async () => {
      await loginHome(wp, ACC.member); wIn = true;
      const lt = await read(wp, "trips", "id,start_date,archived_at,user_id", [["is", "archived_at", null]]);
      const left = (lt.rows || []).filter((t) => String(t.start_date || "").startsWith(QA_YEAR)).map((t) => String(t.id));
      for (const id of left) { const a = await archiveTripUI(wp, id); cleanup.push({ table: "trips", id: Number(id), owner: ACC.member.label, state: a.ok ? "leftover_archived_by_ui" : "leftover_active", note: "QA trip from an earlier run" }); }
      rec("write/setup/member-leftover-qa-trips", "INFO", left.length ? `archived ${left.length} leftover 2099 trip(s): ${left.join(",")}` : "none");
      await loginCity(sp, ACC.second); sIn = true;
      rec("iso/second-member-login-via-city-page-ui", true, "city page Üye form");
      await gotoHome(sp, { member: true });
      const lt2 = await read(sp, "trips", "id,start_date,archived_at,user_id", [["is", "archived_at", null]]);
      const left2 = (lt2.rows || []).filter((t) => String(t.start_date || "").startsWith(QA_YEAR)).map((t) => String(t.id));
      for (const id of left2) { const a = await archiveTripUI(sp, id); cleanup.push({ table: "trips", id: Number(id), owner: ACC.second.label, state: a.ok ? "leftover_archived_by_ui" : "leftover_active", note: "QA trip from an earlier run" }); }
      rec("write/setup/second-leftover-qa-trips", "INFO", left2.length ? `archived ${left2.length}: ${left2.join(",")}` : "none");
      await gotoAms(wp, { member: true });
      await gotoAms(sp, { member: true });
      const mw = await wp.evaluate(() => ({ cat: cityCatalogIds(), fav: [...favSet] }));
      const ms = await sp.evaluate(() => ({ fav: [...favSet] }));
      const cw = await read(wp, "favorites", "venue_id,user_id"); const cs = await read(sp, "favorites", "venue_id,user_id");
      if (cw.error || cs.error) throw new Error(`favorites read failed: ${cw.error || cs.error}`);
      const taken = new Set([...mw.fav, ...ms.fav, ...cw.rows.map((r) => r.venue_id), ...cs.rows.map((r) => r.venue_id)]);
      const free = mw.cat.filter((id) => !taken.has(id));
      X = free[0] || null; Y = free[1] || null; facts.X = X;
      rec("write/setup/test-venues-chosen", !!X && !!Y, `X=${X} Y=${Y} memberCloud=${cw.rows.length} secondCloud=${cs.rows.length}`);
      return !!X && !!Y;
    });
    if (!ok0) return;

    // ---------------- favourite add -> reload -> present (device + server)
    const favAdded = await step("write/fav-add", async () => {
      await heart(wp, X);
      pending.favs.push({ owner: "member", venue: X });
      await wp.waitForFunction((v) => isFav(v), X, { timeout: T.short });
      const st = await favState(wp, X);
      const cloud = await waitCloud(wp, X, true);
      rec("write/fav/add-via-heart", st.mem && st.local && st.icon === "favorite" && cloud, `${JSON.stringify(st)} cloud=${cloud}`);
      await gotoAms(wp, { member: true });
      await view(wp, "list");
      const st2 = await favState(wp, X);
      rec("write/fav/present-after-reload", st2.mem && st2.local && st2.icon === "favorite" && (await cloudHas(wp, X)) === true, JSON.stringify(st2));
      return true;
    });

    // ---------------- trip create via the home search form -> trip page -> reopen from the trips list
    await step("write/trip", async () => {
      const r = await createTripUI(wp, QA_TRIP);
      if (!r.id) { rec("write/trip/create-via-search-form", false, `no trip id after Keşfet (url=${new URL(wp.url()).pathname}) ${r.info}`); return; }
      memberTrip = r.id; facts.memberTrip = r.id;
      pending.trips.push({ owner: "member", id: r.id });
      await wp.waitForFunction((id) => window.TRIP && String(window.TRIP.id) === String(id), r.id, { timeout: T.app });
      const t = await wp.evaluate(() => ({ s: TRIP.start_date, e: TRIP.end_date, city: TRIP.city, banner: (document.getElementById("tripBanner")?.textContent || "").trim(), shown: !document.getElementById("tripBanner").classList.contains("hide") }));
      rec("write/trip/create-via-search-form", t.s === QA_TRIP.start && t.e === QA_TRIP.end && t.city === "Amsterdam", `id=${r.id} ${t.s}..${t.e} ${t.city}`);
      rec("write/trip/trip-page-banner", t.shown && t.banner.includes(QA_TRIP.label) && /Amsterdam/.test(t.banner), t.banner.slice(0, 90));
      await gotoHome(wp, { member: true });
      const list = await openTrips(wp);
      const row = list.rows.find((x) => x.id === String(r.id));
      rec("write/trip/listed-in-kayitli-seyahatlerim", !!row && row.text.includes(QA_TRIP.label), row ? row.text.slice(0, 80) : `rows=${list.rows.length}`);
      if (row) {
        await Promise.all([wp.waitForURL(/\/amsterdam\/.*trip=/, { timeout: T.nav }), press(wp, `#tripsList [data-trip-act="open"][data-trip-id="${r.id}"]`)]);
        const re = await wp.waitForFunction((id) => window.TRIP && String(window.TRIP.id) === String(id), r.id, { timeout: T.app }).then(() => true).catch(() => false);
        rec("write/trip/reopen-from-list", re && new URL(wp.url()).searchParams.get("trip") === String(r.id), new URL(wp.url()).search.replace(/&cb=\d+/, ""));
      } else await closeDialogs(wp);
    });

    // ---------------- plan save (+snapshot) on the QA trip
    if (memberTrip) await step("write/plan", async () => {
      if (!/trip=/.test(wp.url())) await gotoAms(wp, { qs: `&trip=${memberTrip}`, member: true });
      await wp.waitForFunction((id) => window.TRIP && String(window.TRIP.id) === String(id), memberTrip, { timeout: T.app });
      await view(wp, "cal");
      await wp.waitForSelector("#planPrimaryCta", { timeout: T.app });
      const enabled = await wp.waitForFunction(() => { const b = document.getElementById("planPrimaryCta"); return b && !b.disabled; }, null, { timeout: T.short }).then(() => true).catch(() => false);
      if (!enabled) { rec("write/plan/save-via-planimi-olustur", false, "Planımı oluştur stays disabled: " + (await wp.evaluate(() => (document.getElementById("planSetup")?.textContent || "").slice(-120)))); return; }
      pending.plans.push({ owner: "member", trip: memberTrip });
      await press(wp, "#planPrimaryCta");
      const sv = await poll(wp, async ({ id, days }) => { const t = await window.TripStore.get(id); if (!t) return { ok: false, why: "not visible" }; const dv = (t.plan && t.plan.dayven) || {}; const filled = days.filter((d) => Array.isArray(dv[d]) && dv[d].length).length; return { ok: !!t.setup_completed && filled > 0 && !!(t.preferences && t.preferences.plan_prefs && t.preferences.plan_prefs.saved), setup: !!t.setup_completed, filled, rev: t.revision }; }, { id: memberTrip, days: QA_TRIP.days });
      rec("write/plan/save-via-planimi-olustur", sv.ok, JSON.stringify(sv));
      const snp = await wp.waitForFunction(() => window.TRIP && window.TRIP.plan_version >= 1, null, { timeout: 20000 }).then(() => true).catch(() => false);
      const pv = await wp.evaluate(() => ({ pv: window.TRIP && window.TRIP.plan_version, sync: window.TripSync && window.TripSync.status }));
      rec("write/plan/snapshot-recorded", snp, JSON.stringify(pv));
      if (snp) { cleanup.push({ table: "trip_plan_versions", trip_id: Number(memberTrip), owner: ACC.member.label, state: "created_by_plan_snapshot", note: "no UI delete; remove with the archived QA trip" }); sideEffects.add("trip_plan_versions snapshot row(s) on the QA trip (listed in cleanup)"); }
    });

    // ---------------- isolation: second member vs the member's trip + favourite (both exist now)
    await step("iso/second-cannot-see-member-data", async () => {
      await gotoHome(sp, { member: true });
      const list = await openTrips(sp); await closeDialogs(sp);
      const r1 = memberTrip ? await read(sp, "trips", "id,user_id", [["eq", "id", Number(memberTrip)]]) : { rows: [] };
      rec("iso/second-trips-list-lacks-member-trip", !!memberTrip && !list.err && !list.rows.some((x) => x.id === String(memberTrip)) && !r1.error && r1.rows.length === 0, `listed=${list.rows.length} rls_rows=${r1.rows ? r1.rows.length : r1.error}`);
      if (memberTrip) {
        await gotoAms(sp, { qs: `&trip=${memberTrip}`, member: true });
        await sp.waitForTimeout(1500);
        const t = await sp.evaluate((id) => ({ trip: !!(window.TRIP && String(window.TRIP.id) === String(id)), banner: (document.getElementById("tripBanner")?.textContent || "") }), memberTrip);
        rec("iso/second-trip-link-does-not-open-member-trip", !t.trip && !t.banner.includes(QA_TRIP.label), JSON.stringify({ trip: t.trip, banner: t.banner.slice(0, 50) }));
      } else await gotoAms(sp, { member: true });
      const fs = await favState(sp, X);
      const fc = await read(sp, "favorites", "venue_id,user_id");
      rec("iso/second-does-not-see-member-favourite", fs.mem === false && !fc.error && !fc.rows.some((r) => r.venue_id === X) && fc.foreign === 0, `ui=${fs.mem} rows=${fc.rows ? fc.rows.length : fc.error} foreign=${fc.foreign}`);
      const ft = await read(sp, "trips", "id,user_id");
      rec("iso/second-rls-reads-only-own-rows", !ft.error && ft.foreign === 0 && !fc.error && fc.foreign === 0, `trips=${ft.rows ? ft.rows.length : ft.error} foreignTrips=${ft.foreign} foreignFavs=${fc.foreign}`);
    });

    // ---------------- vice versa: the second member's own favourite + trip must be invisible to the member
    await step("iso/member-cannot-see-second-data", async () => {
      await gotoAms(sp, { member: true });
      await heart(sp, Y);
      pending.favs.push({ owner: "second", venue: Y });
      const yc = await waitCloud(sp, Y, true);
      rec("iso/second-favourite-added", yc, `Y=${Y}`);
      const r = await createTripUI(sp, QA_TRIP2);
      if (r.id) { secondTrip = r.id; pending.trips.push({ owner: "second", id: r.id }); }
      rec("iso/second-trip-created", !!r.id, `id=${r.id}`);
      await gotoHome(wp, { member: true });
      const list = await openTrips(wp); await closeDialogs(wp);
      const rr = secondTrip ? await read(wp, "trips", "id,user_id", [["eq", "id", Number(secondTrip)]]) : { rows: [] };
      rec("iso/member-trips-list-lacks-second-trip", !!secondTrip && !list.rows.some((x) => x.id === String(secondTrip)) && !rr.error && rr.rows.length === 0, `listed=${list.rows.length} rls_rows=${rr.rows ? rr.rows.length : rr.error}`);
      if (secondTrip) {
        await gotoAms(wp, { qs: `&trip=${secondTrip}`, member: true });
        await wp.waitForTimeout(1500);
        const t = await wp.evaluate((id) => ({ trip: !!(window.TRIP && String(window.TRIP.id) === String(id)), banner: (document.getElementById("tripBanner")?.textContent || "") }), secondTrip);
        rec("iso/member-trip-link-does-not-open-second-trip", !t.trip && !t.banner.includes(QA_TRIP2.label), JSON.stringify({ trip: t.trip, banner: t.banner.slice(0, 50) }));
      }
      await gotoAms(wp, { member: true });
      const fs = await favState(wp, Y);
      const fc = await read(wp, "favorites", "venue_id,user_id");
      const ft = await read(wp, "trips", "id,user_id");
      rec("iso/member-does-not-see-second-favourite", fs.mem === false && !fc.error && !fc.rows.some((x) => x.venue_id === Y), `ui=${fs.mem} rows=${fc.rows ? fc.rows.length : fc.error}`);
      rec("iso/member-rls-reads-only-own-rows", !fc.error && fc.foreign === 0 && !ft.error && ft.foreign === 0, `foreignFavs=${fc.foreign} foreignTrips=${ft.foreign}`);
    });

    // ---------------- second member undoes its writes via the UI, then logs out (city page)
    await step("iso/second-cleanup", async () => {
      if (pending.favs.some((f) => f.owner === "second")) {
        await gotoAms(sp, { member: true });
        if ((await favState(sp, Y)).mem) await heart(sp, Y);
        const gone = await waitCloud(sp, Y, false);
        await gotoAms(sp, { member: true }); await view(sp, "list");
        const st = await favState(sp, Y);
        const ok = gone && st.mem === false && st.local === false;
        rec("iso/second-favourite-removed-and-verified", ok, JSON.stringify(st));
        if (ok) drop(pending.favs, (f) => f.owner === "second");
      }
      if (secondTrip) {
        await gotoHome(sp, { member: true });
        const a = await archiveTripUI(sp, secondTrip);
        const db = await read(sp, "trips", "id,archived_at", [["eq", "id", Number(secondTrip)]]);
        const archived = !db.error && db.rows.length === 1 && !!db.rows[0].archived_at;
        rec("iso/second-trip-archived-via-ui", a.ok && archived, `${a.okTxt || a.err || a.why} archived_at=${archived}`);
        if (a.ok && archived) { drop(pending.trips, (t) => t.owner === "second"); cleanup.push({ table: "trips", id: Number(secondTrip), owner: ACC.second.label, state: "archived_by_ui", note: "row kept with archived_at; optional hard delete" }); }
      }
      await gotoAms(sp, { member: true });
      await view(sp, "member");
      await press(sp, "#asaLogout");
      await sp.waitForFunction(() => !(window.ASA && window.ASA.session), null, { timeout: T.app });
      sIn = false;
      await view(sp, "list");
      const an = await snap(sp);
      rec("iso/second-logout-via-city-page", !an.member && (an.catalog.length <= 10 || an.cards.length === 10) && (await sp.evaluate(() => Object.keys(localStorage).filter((k) => /^sb-.*-auth-token$/.test(k)).length)) === 0, `cards=${an.cards.length}`);
    });

    // ---------------- e-mail preference round trip (only on a boolean start state)
    await step("write/prefs", async () => {
      await gotoHome(wp, { member: true });
      const st0 = await openPrefs(wp);
      const key = Object.keys(st0.states).find((k) => st0.states[k] === "on" || st0.states[k] === "off");
      if (st0.err || !key) { await closeDialogs(wp); rec("write/prefs/off-on-roundtrip", null, st0.err ? `prefs error: ${st0.err}` : "every key is not_configured: toggling would leave a configured value"); return; }
      const start = st0.states[key];
      const other = start === "on" ? "off" : "on";
      const flip = async (want) => {
        await press(wp, `#prefsBody button[data-prefkey="${key}"]`);
        await wp.waitForFunction(([k, s]) => document.querySelector(`#prefsBody [data-pref-row="${k}"] [data-pref-state]`)?.getAttribute("data-pref-state") === s || (document.getElementById("prefsErr")?.textContent || "").trim(), [key, want], { timeout: T.app }).catch(() => {});
        return wp.evaluate((k) => ({ state: document.querySelector(`#prefsBody [data-pref-row="${k}"] [data-pref-state]`)?.getAttribute("data-pref-state"), ok: (document.getElementById("prefsOk")?.textContent || "").trim().length > 0, err: (document.getElementById("prefsErr")?.textContent || "").trim() }), key);
      };
      pending.prefs.push({ key, start });
      sideEffects.add("service_pref_set audit rows for the e-mail preference round trip");
      const a = await flip(other);
      const b = a.state === other ? await flip(start) : a;
      await closeDialogs(wp);
      const st1 = await openPrefs(wp);
      await closeDialogs(wp);
      const back = JSON.stringify(st1.states) === JSON.stringify(st0.states);
      rec("write/prefs/off-on-roundtrip", a.state === other && a.ok && b.state === start && back, `key=${key} ${start}->${a.state}->${b.state} reread_equal=${back} ${a.err || b.err}`);
      if (back) drop(pending.prefs, (p) => p.key === key);
    });

    // ---------------- logout -> anonymous again
    await step("persist/logout", async () => {
      await gotoHome(wp, { member: true });
      const o = await logoutHome(wp); wIn = false;
      rec("persist/logout-via-menu", /Giriş yap/.test(o.label || "") && o.asaSession === null && o.sbKeys === 0, JSON.stringify(o));
      await gotoAms(wp, { member: false });
      await view(wp, "list");
      const an = await snap(wp);
      rec("persist/after-logout-city-page-is-anonymous", !an.member && (an.catalog.length <= 10 || an.cards.length === 10), `member=${an.member} cards=${an.cards.length}`);
    });
  } finally {
    techChecks("write-member", [w.mon]);
    techChecks("write-second", [s.mon]);
    if (sIn) await step("iso/second-logout-fallback", async () => { await gotoHome(sp); if (await sp.evaluate(memberLabel)) await logoutHome(sp); });
    await closeCtx(S);
    await closeCtx(W);
  }
}

async function persistAndUndo() {
  const { memberTrip, X } = facts;
  // fresh context = a second device: everything below must come from the server
  const ctx = await newCtx("d1366", { preseedFav: true });
  const { page, mon } = await openPage(ctx);
  let inn = false;
  try {
    await step("persist", async () => {
      await loginHome(page, ACC.member); inn = true;
      rec("persist/login-again-new-device", true);
      if (memberTrip) {
        const list = await openTrips(page); await closeDialogs(page);
        rec("persist/trip-still-listed", list.rows.some((x) => x.id === String(memberTrip)), `rows=${list.rows.length}`);
      }
      if (X && pending.favs.some((f) => f.owner === "member")) {
        await gotoAms(page, { member: true });
        await view(page, "list");
        const st = await favState(page, X);
        rec("persist/favourite-restored-from-account", st.mem === true && st.local === true && st.icon === "favorite", JSON.stringify(st));
      }
      if (memberTrip && pending.plans.length) {
        await gotoAms(page, { qs: `&trip=${memberTrip}`, member: true });
        await page.waitForFunction((id) => window.TRIP && String(window.TRIP.id) === String(id), memberTrip, { timeout: T.app });
        const srv = await page.evaluate(async ({ id, days }) => { const t = await window.TripStore.get(id); const dv = (t && t.plan && t.plan.dayven) || {}; return days.map((d) => (dv[d] || []).join(",")); }, { id: memberTrip, days: QA_TRIP.days });
        const pl = await page.evaluate((days) => { let dv = {}; try { dv = JSON.parse(localStorage.getItem("asa:ams:dayven") || "{}") || {}; } catch (e) {} let pp = {}; try { pp = JSON.parse(localStorage.getItem("asa:ams:plan_prefs") || "{}") || {}; } catch (e) {} return { days: days.map((d) => (dv[d] || []).join(",")), saved: !!pp.saved }; }, QA_TRIP.days);
        rec("persist/plan-restored-from-trip-to-device", srv.some(Boolean) && JSON.stringify(pl.days) === JSON.stringify(srv) && pl.saved, `serverDays=${srv.filter(Boolean).length} deviceEqual=${JSON.stringify(pl.days) === JSON.stringify(srv)} prefsSaved=${pl.saved}`);
        // what the user sees: open the Plan tab of the reopened trip (no extra reload)
        await view(page, "cal");
        await page.waitForTimeout(600);
        const shown = await page.evaluate((days) => days.map((d) => ((typeof dayVenues !== "undefined" && dayVenues[d]) || []).join(",")), QA_TRIP.days);
        rec("persist/plan-tab-shows-saved-plan-on-new-device", srv.some(Boolean) && JSON.stringify(shown) === JSON.stringify(srv), JSON.stringify(shown) === JSON.stringify(srv) ? "equal" : `differs: shown=${shown.map((x) => x.split(",").filter(Boolean).length).join("/")} server=${srv.map((x) => x.split(",").filter(Boolean).length).join("/")} (in-memory plan not refreshed by TripSync.hydrate)`);
      }
    });
    if (inn) await undoAll(page, "member");
    if (inn) await step("persist/logout-end", async () => { await gotoHome(page, { member: true }); const o = await logoutHome(page); inn = false; rec("persist/logout-end", o.asaSession === null && o.sbKeys === 0, JSON.stringify(o)); });
  } finally { techChecks("persist-undo", [mon]); await closeCtx(ctx); }
}

// Undo every pending write of one owner through the UI (plan clear -> favourite remove -> trip archive -> pref restore).
async function undoAll(page, owner) {
  const P = owner === "member" ? "undo" : `undo-${owner}`;
  for (const pl of pending.plans.filter((x) => x.owner === owner)) await step(`${P}/plan`, async () => {
    await gotoAms(page, { qs: `&trip=${pl.trip}`, member: true });
    await page.waitForFunction((id) => window.TRIP && String(window.TRIP.id) === String(id), pl.trip, { timeout: T.app });
    await view(page, "cal");
    await press(page, "#planCtl button", { text: "Planı temizle" });
    const r = await poll(page, async ({ id, days }) => { const t = await window.TripStore.get(id); const dv = (t && t.plan && t.plan.dayven) || {}; const filled = days.filter((d) => Array.isArray(dv[d]) && dv[d].length).length; return { ok: !!t && filled === 0, filled }; }, { id: pl.trip, days: QA_TRIP.days });
    rec(`${P}/plan-cleared-via-plani-temizle`, r.ok, JSON.stringify(r));
    if (r.ok) drop(pending.plans, (x) => x === pl);
  });
  for (const f of pending.favs.filter((x) => x.owner === owner)) await step(`${P}/favourite`, async () => {
    await gotoAms(page, { member: true });
    await view(page, "list");
    if ((await favState(page, f.venue)).mem) await heart(page, f.venue);
    const gone = await waitCloud(page, f.venue, false);
    await gotoAms(page, { member: true });
    await view(page, "list");
    const st = await favState(page, f.venue);
    const ok = gone && st.mem === false && st.local === false && st.icon === "favorite_border";
    rec(`${P}/favourite-removed-absent-after-reload`, ok, `${JSON.stringify(st)} cloudGone=${gone}`);
    if (ok) drop(pending.favs, (x) => x === f);
  });
  for (const t of pending.trips.filter((x) => x.owner === owner)) await step(`${P}/trip`, async () => {
    await gotoHome(page, { member: true });
    const a = await archiveTripUI(page, t.id);
    const db = await read(page, "trips", "id,archived_at", [["eq", "id", Number(t.id)]]);
    const archived = !db.error && db.rows.length === 1 && !!db.rows[0].archived_at;
    rec(`${P}/trip-archived-via-arsivle`, a.ok && archived && /arşivlendi/.test(a.okTxt), `${a.okTxt || a.err || a.why} archived_at=${archived}`);
    if (a.ok && archived) { drop(pending.trips, (x) => x === t); cleanup.push({ table: "trips", id: Number(t.id), owner: owner === "member" ? ACC.member.label : ACC.second.label, state: "archived_by_ui", note: "row kept with archived_at; optional hard delete (with its trip_plan_versions)" }); }
  });
  if (owner === "member") for (const p of [...pending.prefs]) await step(`${P}/pref`, async () => {
    await gotoHome(page, { member: true });
    let st = await openPrefs(page);
    for (let i = 0; i < 2 && st.states[p.key] !== p.start; i++) {
      await press(page, `#prefsBody button[data-prefkey="${p.key}"]`);
      await page.waitForTimeout(1500);
      await closeDialogs(page); st = await openPrefs(page);
    }
    await closeDialogs(page);
    rec(`${P}/pref-restored`, st.states[p.key] === p.start, `${p.key}=${st.states[p.key]} start=${p.start}`);
    if (st.states[p.key] === p.start) drop(pending.prefs, (x) => x === p);
  });
}

// Final safety net: anything still pending gets one more UI undo attempt in a fresh context, the rest goes to cleanup.
async function finalCleanup() {
  for (const owner of ["member", "second"]) {
    const has = pending.favs.some((x) => x.owner === owner) || pending.trips.some((x) => x.owner === owner) || pending.plans.some((x) => x.owner === owner) || (owner === "member" && pending.prefs.length);
    if (!has || !browser) continue;
    let ctx = null;
    try {
      ctx = await newCtx("d1366", { preseedFav: true });
      const { page, mon } = await openPage(ctx);
      await loginHome(page, ACC[owner]);
      await undoAll(page, owner);
      await step(`cleanup/${owner}-logout`, async () => { await gotoHome(page, { member: true }); await logoutHome(page); });
      void mon;
    } catch (e) { rec(`cleanup/${owner}: retry failed`, false, errMsg(e)); }
    finally { await closeCtx(ctx); }
  }
  const lab = (o) => (o === "member" ? ACC.member.label : ACC.second.label);
  for (const t of pending.trips) cleanup.push({ table: "trips", id: Number(t.id), owner: lab(t.owner), state: "active_not_undone", note: "archive or delete via SQL" });
  for (const p of pending.plans) cleanup.push({ table: "trips", id: Number(p.trip), owner: lab(p.owner), state: "plan_not_cleared", note: "plan/preferences written by the QA run" });
  for (const f of pending.favs) cleanup.push({ table: "favorites", venue_id: f.venue, owner: lab(f.owner), state: "not_removed" });
  for (const p of pending.prefs) cleanup.push({ table: "service_prefs", key: p.key, owner: ACC.member.label, state: "not_restored", start_state: p.start });
  rec("cleanup/all-writes-undone-via-ui", pending.trips.length + pending.plans.length + pending.favs.length + pending.prefs.length === 0, `remaining: trips=${pending.trips.length} plans=${pending.plans.length} favs=${pending.favs.length} prefs=${pending.prefs.length}`);
}

// ------------------------------------------------------------------------------------------------ finish
let finished = false;
function finish(code) {
  if (finished) return; finished = true;
  if (thirdHosts.size) rec("info/third-party-hosts", "INFO", [...thirdHosts.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h}(${n})`).join(" "));
  rec("info/non-critical-4xx-5xx", "INFO", minorBad.length ? `${minorBad.length}: ${[...new Set(minorBad)].slice(0, 5).join(" | ")}` : "none");
  if (jsClicks.length) rec("info/ui-clicks-needing-js-fallback", "INFO", [...new Set(jsClicks)].join(" "));
  const fail = checks.filter((c) => c.result === "FAIL").length;
  const pass = checks.filter((c) => c.result === "PASS").length;
  const skip = checks.filter((c) => c.result === "SKIP").length;
  const res = { base: BASE, verdict: fail || !pass ? "FAIL" : "PASS", pass, fail, skip, checks, cleanup, side_effects: [...sideEffects] };
  let body = JSON.stringify(res, null, 2);
  if (/eyJ[A-Za-z0-9_-]{10,}\.|\bat\s+\S+\s+\(|file:\/\/|ReferenceError|TypeError|service_role/i.test(body) || MASK.some((m) => body.includes(m))) {
    try { body = JSON.stringify(JSON.parse(scrub(body)), null, 2); } catch { body = JSON.stringify({ base: BASE, verdict: "FAIL", pass, fail: fail + 1, skip, checks: [{ id: "run: result scrub", result: "FAIL", detail: "result contained token/stack-like text; details dropped" }], cleanup }, null, 2); }
  }
  writeFileSync(OUT_FILE, body + "\n");
  console.log("WP6_LIVE_SUMMARY " + JSON.stringify({ base: BASE, total: checks.length, pass, fail, skip, cleanup: cleanup.length, verdict: res.verdict }));
  for (const c of checks) console.log(`${c.result.padEnd(4)} ${c.id} :: ${c.detail}`);
  for (const c of cleanup) console.log(`CLEANUP ${JSON.stringify(c)}`);
  process.exit(code != null ? code : fail || !pass ? 1 : 0);
}
const hard = setTimeout(async () => {
  rec("run: global time limit reached", false, `${HARD_LIMIT_MS} ms`);
  const lab = (o) => (o === "member" ? "qa_member" : "qa_admin_as_member");
  for (const t of pending.trips) cleanup.push({ table: "trips", id: Number(t.id), owner: lab(t.owner), state: "active_not_undone" });
  for (const f of pending.favs) cleanup.push({ table: "favorites", venue_id: f.venue, owner: lab(f.owner), state: "not_removed" });
  for (const p of pending.prefs) cleanup.push({ table: "service_prefs", key: p.key, owner: "qa_member", state: "not_restored", start_state: p.start });
  finish(1);
}, HARD_LIMIT_MS);
hard.unref();

if (setupOk && chromium) {
  try {
    browser = await chromium.launch();
    for (const vp of ["d1366", "m390"]) await step(`anon/${vp}`, () => anonScenario(vp));
    for (const vp of ["m360", "m390", "t768", "d1366"]) await step(`overflow/${vp}`, () => overflowSmoke(vp));
    await step("keyboard", () => keyboardAnon());
    for (const vp of ["d1366", "m390"]) await step(`member-ro/${vp}`, () => memberReadOnly(vp));
    await step("write", () => writeScenario());
    await step("persist", () => persistAndUndo());
  } catch (e) {
    rec("run: unexpected error", false, errMsg(e));
  } finally {
    try { await finalCleanup(); } catch (e) { rec("cleanup: unexpected error", false, errMsg(e)); }
    for (const c of [...openContexts]) await closeCtx(c);
    if (browser) await browser.close().catch(() => {});
  }
}
finish();
