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
//   wp5         name completion: Profilim slot read-only check + one labelled write round trip (operator resets to NULL)
//   sync (WP6)  plan / trip sync integrity on the QA member's QA trip: a browsing reference (List neighbourhood) never rewrites
//               the saved accommodation · revision conflict between two devices (device B saves; the stale device edits →
//               newer server plan kept, #tripSyncNotice + kept local copy in asa:ams:plan_sync, upload only via explicit
//               "Bu cihazdaki sürümü geri yükle") and between two tabs of one browser (stale tab never wins; "Sunucudaki planla
//               devam et" writes nothing) · trip_save never overlaps on one page · a new trip (2099-03-10..12) opened on the
//               device of the QA trip starts empty locally and on the server (forced flush), then archived via the UI · guest
//               search overlapping the QA trip with other dates + city login adopts the DB trip (dates kept, user told, nothing
//               pushed, no duplicate; a ?trip= page never runs the guest import) · device storage full while opening the trip
//               blocks uploads and says so · Plan tab opened before the delayed ?trip= fetch shows the saved plan and dates
//   fav (WP6)   a device's 7 seeded default favourites are never uploaded at login · logout clears the account's favourites
//               on the device · nothing is carried into the next account · a favourite removed on one device does not come
//               back when an older device reloads. Unexpected cloud rows (regressions) are removed via the heart UI.
// Side effects that are normal site behaviour (not undone): member_upsert_profile on login, log_city_view events,
// service_pref_set audit rows for the round trip, Supabase sessions (closed by the UI logout).
// Anything that could not be undone is listed in result.cleanup (ids + owner label only, never e-mails).
// Console check = JS errors (console.error + uncaught); "Failed to load resource" lines are covered by the network checks.
// Env: WP6_XFAIL="<id>,<id>" marks operator-acknowledged product defects as XFAIL (shown, not counted in the verdict);
//      WP6_TIME_LIMIT_MS (default 30 min hard limit; pending writes are then listed in cleanup).

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
// WP6_XFAIL="<check id>,<check id>": operator-acknowledged product defects -> "XFAIL" (listed, not counted in the verdict)
const XFAIL = new Set(String(process.env.WP6_XFAIL || "").split(",").map((x) => x.trim()).filter(Boolean));
function rec(id, ok, detail = "") {
  let result = ok === null ? "SKIP" : ok === "INFO" ? "INFO" : ok ? "PASS" : "FAIL";
  if (result === "FAIL" && XFAIL.has(id)) result = "XFAIL";
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
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/^Failed to load resource/.test(t)) { b.resource = (b.resource || 0) + 1; return; } // covered by the 4xx/5xx network checks
    b.console.push(scrub(t).slice(0, 120));
  });
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
  const resN = mons.reduce((a, m) => a + (m.resource || 0), 0);
  rec(`tech/console-errors-0/${scn}`, con.length === 0, (con.length ? `${con.length}: ${[...new Set(con)].slice(0, 3).join(" | ")}` : "none") + (resN ? ` (+${resN} resource-load messages, see network checks)` : ""));
  rec(`tech/no-4xx-5xx-critical/${scn}`, bad.length === 0, bad.length ? `${bad.length}: ${[...new Set(bad)].slice(0, 4).join(" | ")}` : "none");
}
async function openPage(ctx) { const page = await ctx.newPage(); return { page, mon: monitor(page) }; }
const vis = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
async function press(page, sel, { text = null, timeout = 10000 } = {}) {
  const loc = text ? page.locator(sel, { hasText: text }).first() : page.locator(sel).first();
  try { await loc.click({ timeout }); return "click"; }
  catch (e) {
    const why = ((String((e && e.message) || "").match(/(intercepts pointer events|not visible|not stable|outside of the viewport|not enabled|detached|Timeout \d+ms exceeded)/) || [])[1]) || "click failed";
    const ok = await page.evaluate(([s, t]) => { const el = [...document.querySelectorAll(s)].find((x) => !t || (x.textContent || "").includes(t)); if (!el) return false; el.click(); return true; }, [sel, text]).catch(() => false);
    if (!ok) throw new Error(`UI element not found: ${sel}${text ? ` "${text}"` : ""}`);
    const blocker = /intercepts/.test(String(e && e.message)) ? (String(e.message).match(/<(\w+)[^>]*?(?:id="([^"]+)")?[^>]*?(?:class="([^" ]+))?[^>]*> (?:from <[^>]+> subtree )?intercepts pointer events/) || []).slice(1, 4).filter(Boolean).join(".") : "";
    jsClicks.push(`${sel}${text ? `:${text}` : ""} (${why}${blocker ? " by " + blocker : ""})`.slice(0, 110));
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
  await page.waitForFunction(() => (document.getElementById("tripsOk")?.textContent || "").trim() || (document.getElementById("tripsErr")?.textContent || "").trim(), null, { timeout: T.app }).catch(() => {});
  const r = await page.evaluate((i) => ({ gone: !document.querySelector(`#tripsList [data-trip-row="${i}"]`), okTxt: (document.getElementById("tripsOk")?.textContent || "").trim(), err: (document.getElementById("tripsErr")?.textContent || "").trim() }), String(id));
  await closeDialogs(page);
  return { ok: r.gone && !r.err && /arşivlendi/.test(r.okTxt), ...r };
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

// ================================================================================================ WP5 NAME (read-only part)
// WP5 · name completion (shipped in e1bfd04). Read-only here: the Profilim slot shows Ad/Soyad fields whose values equal the
// member's own row (RLS self-select through the page's own client). The write round trip runs in the write phase (wp5NameWrite).
const OWN_NAME = (page) => page.evaluate(async () => {
  try { const { data: s } = await db.auth.getSession(); const uid = s && s.session && s.session.user && s.session.user.id;
        const r = await db.from("members").select("first_name,last_name").eq("user_id", uid).maybeSingle();
        return r.error ? { error: r.error.code || "err" } : (r.data || { none: true }); } catch (e) { return { error: "throw" }; } });
async function wp5NameChecks(page, P) {
  const has = await page.evaluate(() => typeof window.ASA_NAME !== "undefined" && window.ASA_NAME !== null).catch(() => false);
  if (!has) { rec(`${P}/wp5-name-completion`, null, "window.ASA_NAME not present (WP5 not deployed)"); return; }
  await menuAction(page, "profile");
  await page.waitForFunction(() => { const s = document.getElementById("amWp5Slot"); return !!s && !s.hidden && !!document.getElementById("profFirst"); }, null, { timeout: T.app }).catch(() => {});
  const slot = await page.evaluate(() => { const el = document.getElementById("amWp5Slot"); return el ? { hidden: el.hidden || getComputedStyle(el).display === "none", inputs: el.querySelectorAll("input").length, first: (document.getElementById("profFirst") || {}).value, last: (document.getElementById("profLast") || {}).value } : null; });
  rec(`${P}/wp5-slot-visible-in-profilim`, !!slot && !slot.hidden && slot.inputs === 2, JSON.stringify({ hidden: slot && slot.hidden, inputs: slot && slot.inputs }));
  const own = await OWN_NAME(page);
  rec(`${P}/wp5-profilim-values-equal-own-row`, !!slot && !own.error && (slot.first || "") === (own.first_name || "") && (slot.last || "") === (own.last_name || ""), own.error ? `read error ${own.error}` : "equal");
  await closeDialogs(page);
}
// Write round trip (desktop, write phase): save a labelled QA name through Profilim, re-read the own row, reload and re-check.
// member_set_name cannot clear a name (empty is rejected by design), so the operator resets first/last to NULL afterwards;
// the run lists it in cleanup.
async function wp5NameWrite(page) {
  const has = await page.evaluate(() => typeof window.ASA_NAME !== "undefined" && window.ASA_NAME !== null).catch(() => false);
  if (!has) { rec("write/wp5/name-save-via-profilim", null, "window.ASA_NAME not present"); return; }
  const before = await OWN_NAME(page);
  await menuAction(page, "profile");
  await page.waitForFunction(() => !!document.getElementById("profFirst"), null, { timeout: T.app }).catch(() => {});
  await page.fill("#profFirst", "Qa"); await page.fill("#profLast", "Wp Altı");
  await press(page, "#profSave");
  await page.waitForFunction(() => (document.getElementById("profOk")?.textContent || "").length > 0 || (document.getElementById("profErr")?.textContent || "").length > 0, null, { timeout: T.app }).catch(() => {});
  const res = await page.evaluate(() => ({ ok: document.getElementById("profOk")?.textContent || "", err: document.getElementById("profErr")?.textContent || "" }));
  await closeDialogs(page);
  cleanup.push({ table: "members", owner: ACC.member.label, state: "names_set_by_wp6", note: `first_name/last_name set to the QA label; operator resets to their start values (start: ${before.first_name == null ? "NULL" : "set"}/${before.last_name == null ? "NULL" : "set"})` });
  const after = await OWN_NAME(page);
  rec("write/wp5/name-save-via-profilim", res.ok.length > 0 && !res.err && after.first_name === "Qa" && after.last_name === "Wp Altı", `ok=${!!res.ok} err=${res.err.slice(0, 40)} row=${after.first_name === "Qa" && after.last_name === "Wp Altı"}`);
  await gotoHome(page, { member: true });
  await menuAction(page, "profile");
  await page.waitForFunction(() => !!document.getElementById("profFirst") && document.getElementById("profFirst").value !== "", null, { timeout: T.app }).catch(() => {});
  const v = await page.evaluate(() => ({ f: document.getElementById("profFirst")?.value, l: document.getElementById("profLast")?.value, banner: !!(document.getElementById("namePrompt") && !document.getElementById("namePrompt").hidden) }));
  rec("write/wp5/name-persists-after-reload-no-banner", v.f === "Qa" && v.l === "Wp Altı" && !v.banner, JSON.stringify({ persisted: v.f === "Qa" && v.l === "Wp Altı", banner: v.banner }));
  await closeDialogs(page);
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
    });
    if (loggedIn) await step(`${P}/logout`, async () => {
      await gotoHome(page, { member: true });
      const o = await logoutHome(page);
      loggedIn = false;
      rec(`${P}/logout`, /Giriş yap/.test(o.label || "") && o.asaSession === null && o.sbKeys === 0 && o.focus === "acctBtn", JSON.stringify(o));
    });
  } finally { noWrites(`${P}/no-writes-in-read-only-part`, [mon]); techChecks(P, [mon]); await closeCtx(ctx); }
}

// ================================================================================================ WP6 SYNC INTEGRITY (D1–D7)
// Plan/trip/favourite sync checks for the WP6 fix. They run inside the write / persist phases on the QA member's own QA trip
// (2099-01-10..12) and the two QA accounts only. Every write is undone in-run through the UI or listed in `cleanup`.
const QA_TRIP3 = { start: "2099-03-10", end: "2099-03-12", label: "10 Mar–12 Mar" };
const SRV = async (id) => {
  const t = await window.TripStore.get(id); if (!t) return null;
  const pr = t.preferences || {}, pp = pr.plan_prefs || null;
  return { rev: t.revision, start: t.start_date, end: t.end_date, setup: !!t.setup_completed, plan: t.plan || null, dayven: (t.plan && t.plan.dayven) || {}, pp,
    acc: pr.accommodation === undefined ? null : pr.accommodation, ppAcc: pp && pp.accommodation !== undefined ? pp.accommodation : null };
};
const srv = (page, id) => page.evaluate(SRV, id);
const cnt = (dv, d) => (dv && Array.isArray(dv[d]) ? dv[d].length : 0);
const norm = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
const nSaves = (mon) => mon.writes.filter((x) => x === "rpc:trip_save").length;
const onTrip = (page, id) => page.waitForFunction((i) => window.TRIP && String(window.TRIP.id) === String(i), id, { timeout: T.app }).then(() => true).catch(() => false);
// what the page offers after a sync problem: #tripSyncNotice + the kept copies in asa:ams:plan_sync
const SYNC_UI = (id) => {
  const n = document.getElementById("tripSyncNotice");
  let ps = null; try { ps = JSON.parse(localStorage.getItem("asa:ams:plan_sync") || "null"); } catch (e) { ps = "corrupt"; }
  const its = ps && Array.isArray(ps.items) ? ps.items : [];
  const mine = its.filter((x) => x && String(x.trip_id) === String(id));
  return {
    exists: !!n, vis: !!n && !n.classList.contains("hide") && getComputedStyle(n).display !== "none", role: n ? n.getAttribute("role") : null,
    reason: n ? n.getAttribute("data-reason") : null, restore: !!document.getElementById("tripSyncRestore"), discard: !!document.getElementById("tripSyncDiscard"),
    items: its.length, mine: mine.length, first: mine[0] ? { trip_id: mine[0].trip_id, reason: mine[0].reason, dayven: mine[0].dayven || null } : null,
    status: window.TripSync ? window.TripSync.status : null, focus: document.activeElement ? document.activeElement.id : null,
  };
};
const syncUi = (page, id) => page.evaluate(SYNC_UI, id);
// remove the first stop of one plan day through the Plan tab UI (day chip -> "Aç / düzenle" -> "Çıkar" -> close)
async function removeFirstStop(page, day) {
  await view(page, "cal");
  await press(page, `#cal button[onclick="selectPlanDay('${day}')"]`);
  await page.waitForTimeout(250);
  await press(page, "#dayFlow button", { text: "Aç / düzenle" });
  await page.waitForFunction(() => !document.getElementById("dayModal").classList.contains("hide"), null, { timeout: T.short });
  await press(page, '#dayModal button[title="Çıkar"]');
  await press(page, "#dayModal .dayclose");
}
const serverDayIs = (page, id, d, n) => poll(page, async ({ id, d, n }) => { const t = await window.TripStore.get(id); const dv = (t && t.plan && t.plan.dayven) || {}; const got = Array.isArray(dv[d]) ? dv[d].length : 0; return { ok: got === n, got }; }, { id, d, n });
// POST rpc/trip_save requests of one page: max in flight (the page must never overlap its own saves)
function trackTripSaves(page) {
  const t = { max: 0, n: 0 }, live = new Set();
  const is = (q) => { try { const u = new URL(q.url()); return q.method() === "POST" && u.host === SUPA_HOST && u.pathname === "/rest/v1/rpc/trip_save"; } catch { return false; } };
  page.on("request", (q) => { if (!is(q)) return; live.add(q); t.n++; t.max = Math.max(t.max, live.size); });
  const end = (q) => { live.delete(q); };
  page.on("requestfinished", end); page.on("requestfailed", end);
  return t;
}
const qaTripIds = async (page) => { const r = await read(page, "trips", "id,start_date,archived_at,user_id", [["is", "archived_at", null]]); return r.error ? null : r.rows.filter((t) => String(t.start_date || "").startsWith(QA_YEAR)).map((t) => String(t.id)).sort(); };
const cloudIds = async (page) => { const r = await read(page, "favorites", "venue_id,user_id"); return r.error ? null : r.rows.map((x) => x.venue_id).sort(); };

// D7 · a browsing reference (List "Neredesin?" neighbourhood) must not rewrite the trip's saved accommodation
async function syncBrowseRef(wp, mon, memberTrip) {
  if (!new URL(wp.url()).searchParams.get("trip")) await gotoAms(wp, { qs: `&trip=${memberTrip}`, member: true });
  await onTrip(wp, memberTrip);
  await wp.waitForTimeout(1500); // pending autosave / snapshot of the plan step settle first
  const s0 = await srv(wp, memberTrip), n0 = nSaves(mon);
  await view(wp, "list");
  const val = await wp.evaluate(() => [...document.querySelectorAll("#refList option")].map((o) => o.value).find((v) => v && v !== "home" && v !== "gps") || null);
  if (!val) { rec("sync/browse-ref-keeps-accommodation", false, "no neighbourhood option in #refList"); return; }
  await wp.selectOption("#refList", val);
  await wp.waitForTimeout(2500); // > TripSync debounce 1.2 s + save
  const s1 = await srv(wp, memberTrip), n1 = nSaves(mon);
  const same = !!s0 && !!s1 && s1.rev === s0.rev && JSON.stringify(s1.acc) === JSON.stringify(s0.acc) && JSON.stringify(s1.ppAcc) === JSON.stringify(s0.ppAcc);
  rec("sync/browse-ref-keeps-accommodation", same && n1 === n0, `ref=${val} rev ${s0 && s0.rev}->${s1 && s1.rev} accommodation ${JSON.stringify(s0 && s0.acc)}->${JSON.stringify(s1 && s1.acc)} trip_save +${n1 - n0}`);
  await wp.selectOption("#refList", "home").catch(() => {});
  await wp.waitForTimeout(400);
}

// D1 · revision conflict between two devices of the same member: device B saves a newer plan; the stale device W then edits.
// The newer server plan must survive, W must show the notice and keep its own version, and only an explicit Restore uploads it.
async function syncConflict(wp, memberTrip) {
  const [, d2, d3] = QA_TRIP.days;
  const s0 = await srv(wp, memberTrip);
  const n2 = cnt(s0 && s0.dayven, d2), n3 = cnt(s0 && s0.dayven, d3);
  if (!(n2 > 0 && n3 > 0)) { rec("sync/conflict-server-plan-kept", false, `precondition: saved plan has day2=${n2} day3=${n3} stops`); return; }
  const B = await newCtx("d1366", { preseedFav: true });
  const b = await openPage(B);
  let bIn = false;
  try {
    await loginHome(b.page, ACC.member); bIn = true;
    await gotoAms(b.page, { qs: `&trip=${memberTrip}`, member: true });
    if (!(await onTrip(b.page, memberTrip))) { rec("sync/conflict-server-plan-kept", false, "device B could not open the QA trip"); return; }
    await removeFirstStop(b.page, d2);
    const bs = await serverDayIs(b.page, memberTrip, d2, n2 - 1);
    if (!bs.ok) { rec("sync/conflict-server-plan-kept", false, `device B's edit did not reach the server (day2 ${n2}->${bs.got})`); return; }
    await wp.bringToFront().catch(() => {});
    await removeFirstStop(wp, d3);           // W still holds the older revision in memory (no reload)
    const sawConflict = await wp.waitForFunction(() => window.TripSync && window.TripSync.status === "conflict", null, { timeout: T.server }).then(() => true).catch(() => false);
    await wp.waitForTimeout(1500);
    const s1 = await srv(wp, memberTrip);
    const shown = await wp.evaluate((days) => days.map((d) => ((typeof dayVenues !== "undefined" && dayVenues[d]) || []).join(",")), QA_TRIP.days);
    const shownEq = !!s1 && JSON.stringify(shown) === JSON.stringify(QA_TRIP.days.map((d) => (s1.dayven[d] || []).join(",")));
    rec("sync/conflict-server-plan-kept", !!s1 && cnt(s1.dayven, d2) === n2 - 1 && cnt(s1.dayven, d3) === n3 && shownEq,
      `status=${sawConflict ? "conflict" : "no conflict"} server day2 ${n2}->${s1 && cnt(s1.dayven, d2)} (B removed one) day3 ${n3}->${s1 && cnt(s1.dayven, d3)} (stale W must not win) W shows server plan=${shownEq}`);
    const u = await syncUi(wp, memberTrip);
    const keptD3 = u.first && u.first.dayven ? cnt(u.first.dayven, d3) : null;
    rec("sync/conflict-local-copy-offered", u.vis && u.role === "alert" && u.reason === "conflict" && u.restore && u.discard && !!u.first && u.first.trip_id === String(memberTrip) && keptD3 === n3 - 1,
      JSON.stringify({ vis: u.vis, role: u.role, reason: u.reason, restore: u.restore, discard: u.discard, kept: u.first ? `trip ${u.first.trip_id} ${u.first.reason} day3=${keptD3}` : null }));
    if (u.restore && u.first && u.first.dayven) {
      const want = u.first.dayven;
      await press(wp, "#tripSyncRestore");
      const rs = await poll(wp, async ({ id, want }) => { const t = await window.TripStore.get(id); const dv = (t && t.plan && t.plan.dayven) || {}; const nz = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]])); return { ok: nz(dv) === nz(want) }; }, { id: memberTrip, want });
      const after = await syncUi(wp, memberTrip);
      rec("sync/conflict-restore-explicit", rs.ok && after.mine === 0 && after.focus === "tripSyncClose", JSON.stringify({ serverEqualsKeptCopy: rs.ok, keptLeft: after.mine, focus: after.focus }));
      await press(wp, "#tripSyncClose").catch(() => {});
    } else rec("sync/conflict-restore-explicit", false, "no kept version / no Restore button to press");
  } finally {
    if (bIn) await step("sync/conflict-device-b-logout", async () => { await gotoHome(b.page, { member: true }); await logoutHome(b.page); });
    techChecks("sync-device-b", [b.mon]);
    await closeCtx(B);
  }
}

// D1 (critic 1) · two tabs of ONE browser (shared localStorage): the stale tab must not overwrite the other tab's save
async function syncTwoTabs(W, wp, memberTrip) {
  const [d1, d2] = QA_TRIP.days;
  const s0 = await srv(wp, memberTrip);
  const n1 = cnt(s0 && s0.dayven, d1), n2 = cnt(s0 && s0.dayven, d2);
  if (!(n1 > 0 && n2 > 0)) { rec("sync/two-tabs-stale-tab-does-not-overwrite", false, `precondition: day1=${n1} day2=${n2} stops`); return; }
  const t2 = await openPage(W);
  try {
    await gotoAms(t2.page, { qs: `&trip=${memberTrip}`, member: true });
    if (!(await onTrip(t2.page, memberTrip))) { rec("sync/two-tabs-stale-tab-does-not-overwrite", false, "second tab could not open the QA trip"); return; }
    await removeFirstStop(t2.page, d1);
    const ok2 = await serverDayIs(t2.page, memberTrip, d1, n1 - 1);
    if (!ok2.ok) { rec("sync/two-tabs-stale-tab-does-not-overwrite", false, `second tab's edit did not reach the server (day1 ${n1}->${ok2.got})`); return; }
    await wp.bringToFront().catch(() => {});
    await removeFirstStop(wp, d2);           // first tab: stale memory, same device storage
    await wp.waitForFunction(() => window.TripSync && window.TripSync.status === "conflict", null, { timeout: T.server }).catch(() => {});
    await wp.waitForTimeout(1500);
    const s1 = await srv(wp, memberTrip);
    const u = await syncUi(wp, memberTrip);
    rec("sync/two-tabs-stale-tab-does-not-overwrite", !!s1 && cnt(s1.dayven, d1) === n1 - 1 && cnt(s1.dayven, d2) === n2 && u.vis && u.reason === "conflict",
      `server day1 ${n1}->${s1 && cnt(s1.dayven, d1)} (tab 2 removed one) day2 ${n2}->${s1 && cnt(s1.dayven, d2)} (stale tab must not win) notice=${u.vis}/${u.reason} status=${u.status}`);
    if (u.discard) {
      const r0 = s1 && s1.rev;
      await press(wp, "#tripSyncDiscard");
      await wp.waitForTimeout(2000);
      const s2 = await srv(wp, memberTrip), a = await syncUi(wp, memberTrip);
      rec("sync/two-tabs-discard-keeps-server-plan", !!s2 && s2.rev === r0 && a.mine === 0 && a.focus === "tripSyncClose", `rev ${r0}->${s2 && s2.rev} keptLeft=${a.mine} focus=${a.focus}`);
      await press(wp, "#tripSyncClose").catch(() => {});
    }
  } finally {
    techChecks("sync-second-tab", [t2.mon]);
    await t2.page.close().catch(() => {});
  }
}

// D4 · a new DB trip opened on a device that holds another trip's plan starts empty (local + server)
async function syncNewTrip(wp, memberTrip) {
  const r = await createTripUI(wp, QA_TRIP3);
  if (!r.id) { rec("sync/new-trip-starts-empty", false, `no trip id after Keşfet (${r.info})`); return; }
  pending.trips.push({ owner: "member", id: r.id });
  try {
    if (!(await onTrip(wp, r.id))) { rec("sync/new-trip-starts-empty", false, "new trip not opened"); return; }
    await wp.waitForTimeout(600);
    const loc = await wp.evaluate(({ days, mt }) => {
      const j = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return "corrupt"; } };
      const dv = j("asa:ams:dayven"), pp = j("asa:ams:plan_prefs"), tr = j("asa:ams:trip"), ps = j("asa:ams:plan_sync");
      return { dayven: localStorage.getItem("asa:ams:dayven"), qaDays: dv && typeof dv === "object" ? days.filter((d) => d in dv).length : -1, prefsSaved: !!(pp && pp.saved),
        tripMirror: !!(tr && typeof tr === "object" && "plan_prefs" in tr), keptForQaTrip: ps && Array.isArray(ps.items) ? ps.items.filter((x) => x && String(x.trip_id) === String(mt)).length : 0 };
    }, { days: QA_TRIP.days, mt: memberTrip });
    // Plan tab NOT opened. Force the autosave (critic 15) so the server half can fail too.
    await wp.evaluate(async () => { try { if (window.TripSync && window.TripSync.flush) await window.TripSync.flush(); } catch (e) {} });
    await wp.waitForTimeout(2500);
    const s = await srv(wp, r.id);
    const dvKeys = s && s.plan && s.plan.dayven ? Object.keys(s.plan.dayven).length : 0, ppKeys = s && s.pp ? Object.keys(s.pp).length : 0;
    rec("sync/new-trip-starts-empty", loc.dayven === "{}" && loc.qaDays === 0 && !loc.prefsSaved && !loc.tripMirror && loc.keptForQaTrip === 0 && !!s && dvKeys === 0 && !s.setup && ppKeys === 0,
      JSON.stringify({ ...loc, server: s ? { dayvenKeys: dvKeys, setup: s.setup, planPrefsKeys: ppKeys } : null }));
  } finally {
    await step("sync/new-trip-archive", async () => {
      await gotoHome(wp, { member: true });   // "Kayıtlı seyahatlerim" lives in the home account menu
      const a = await archiveTripUI(wp, r.id);
      if (a.ok) { drop(pending.trips, (t) => String(t.id) === String(r.id)); cleanup.push({ table: "trips", id: Number(r.id), owner: ACC.member.label, state: "archived_by_ui", note: "WP6 new-trip check (2099-03-10..12); row kept with archived_at" }); }
      rec("sync/new-trip-archived-via-ui", a.ok, a.okTxt || a.err || a.why);
    });
  }
}

// D3 · guest search overlapping the member's QA trip with OTHER dates, then login on the city page:
// the DB trip opens with its own dates (user told), nothing is pushed, no duplicate trip; a ?trip= page never imports.
async function syncGuestImport(wp, memberTrip) {
  const G = await newCtx("d1366", { preseedFav: true });
  const g = await openPage(G);
  let gIn = false;
  try {
    const before = await qaTripIds(wp);
    const s0 = await srv(wp, memberTrip);
    await gotoHome(g.page, { member: false });
    await g.page.selectOption("#countrySel", "nl");
    await g.page.waitForFunction(() => !document.getElementById("citySel").disabled, null, { timeout: T.short });
    await g.page.selectOption("#citySel", "Amsterdam");
    await g.page.fill("#dStart", "2099-01-11");
    await g.page.fill("#dEnd", "2099-01-14");
    await g.page.waitForFunction(() => !document.getElementById("goBtn").disabled, null, { timeout: T.short });
    await Promise.all([g.page.waitForURL(/\/amsterdam\//, { timeout: T.nav }), press(g.page, "#goBtn")]);
    const guestUrl = !new URL(g.page.url()).searchParams.get("trip");
    await loginCity(g.page, ACC.member); gIn = true;
    const opened = await onTrip(g.page, memberTrip);
    await g.page.waitForTimeout(1200);
    const st = await g.page.evaluate(() => { const t = (window.ASA_ST && ASA_ST.trip()) || {}; return { s: t.start_date, e: t.end_date, notice: (document.getElementById("asaStoreNotice")?.textContent || "").replace(/\s+/g, " ") }; });
    const savesAtLogin = nSaves(g.mon), inserts = g.mon.writes.filter((x) => x === "POST:trips").length;
    await g.page.evaluate(async () => { try { if (window.TripSync && window.TripSync.flush) await window.TripSync.flush(); } catch (e) {} });   // critic 15
    await g.page.waitForTimeout(2500);
    const s1 = await srv(g.page, memberTrip), after = await qaTripIds(g.page);
    for (const id of (after || []).filter((x) => !(before || []).includes(x))) pending.trips.push({ owner: "member", id });
    const datesKept = !!s0 && !!s1 && s1.start === s0.start && s1.end === s0.end;
    if (s0 && s1 && !datesKept) cleanup.push({ table: "trips", id: Number(memberTrip), owner: ACC.member.label, state: "dates_changed_by_guest_import", note: `${s0.start}..${s0.end} -> ${s1.start}..${s1.end}; the QA trip is archived by this run` });
    rec("sync/guest-import-adopts-db-trip", guestUrl && opened && st.s === QA_TRIP.start && st.e === QA_TRIP.end && /farklı/.test(st.notice) && /Hesabındaki seyahat açıldı/.test(st.notice) && savesAtLogin === 0 && inserts === 0 && !!before && JSON.stringify(after) === JSON.stringify(before) && datesKept,
      `guestUrl=${guestUrl} opened=${opened} device=${st.s}..${st.e} notice=${/farklı/.test(st.notice)} trip_save@login=${savesAtLogin} POST:trips=${inserts} qaTrips ${before && before.length}->${after && after.length} server ${s0 && s0.start}..${s0 && s0.end}->${s1 && s1.start}..${s1 && s1.end}`);
    const p0 = g.mon.writes.filter((x) => x === "POST:trips").length;
    await g.page.evaluate(() => ASA_ST.set("trip", { city: "Amsterdam", country: "Hollanda", start_date: "2099-03-01", end_date: "2099-03-03" }));
    await gotoAms(g.page, { qs: `&trip=${memberTrip}`, member: true });
    const op2 = await onTrip(g.page, memberTrip);
    await g.page.waitForTimeout(1500);
    const p1 = g.mon.writes.filter((x) => x === "POST:trips").length, after2 = await qaTripIds(g.page);
    for (const id of (after2 || []).filter((x) => !(before || []).includes(x) && !pending.trips.some((t) => String(t.id) === x))) pending.trips.push({ owner: "member", id });
    rec("sync/guest-import-no-duplicate-on-trip-param", op2 && p1 === p0 && !!before && JSON.stringify(after2) === JSON.stringify(before), `opened=${op2} POST:trips +${p1 - p0} qaTrips ${before && before.length}->${after2 && after2.length}`);
  } finally {
    if (gIn) await step("sync/guest-device-logout", async () => { await gotoHome(g.page, { member: true }); await logoutHome(g.page); });
    techChecks("sync-guest-import", [g.mon]);
    await closeCtx(G);
  }
}

// D5 · device storage full while opening the trip: DB plan shown from memory, uploads blocked, user told
async function syncStorageFull(memberTrip) {
  const Q = await newCtx("d1366", { preseedFav: true });
  await Q.addInitScript(() => { try { const s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k) === "asa:ams:dayven") throw new DOMException("quota (qa)", "QuotaExceededError"); return s.call(this, k, v); }; } catch (e) {} });
  const q = await openPage(Q);
  let qIn = false;
  try {
    await loginHome(q.page, ACC.member); qIn = true;
    const r0 = await srv(q.page, memberTrip);
    await gotoAms(q.page, { qs: `&trip=${memberTrip}`, member: true });
    const opened = await onTrip(q.page, memberTrip);
    await q.page.waitForTimeout(800);
    const st = await q.page.evaluate((days) => {
      const n = document.getElementById("asaStoreNotice");
      return { blocked: window.TripSync ? window.TripSync.blocked : undefined, vis: !!n && !n.classList.contains("hide"), notice: n ? n.textContent.replace(/\s+/g, " ") : "", mem: days.map((d) => ((typeof dayVenues !== "undefined" && dayVenues[d]) || []).join(",")) };
    }, QA_TRIP.days);
    const srvDays = r0 ? QA_TRIP.days.map((d) => (r0.dayven[d] || []).join(",")) : null;
    await view(q.page, "cal");
    await q.page.waitForTimeout(2500);
    const r1 = await srv(q.page, memberTrip);
    rec("sync/storage-full-blocks-upload", opened && st.blocked === String(memberTrip) && st.vis && st.notice.includes("Cihaz depolaması dolu: bu seyahatin kayıtlı planı bu cihaza yazılamadı") && JSON.stringify(st.mem) === JSON.stringify(srvDays) && !!r1 && r1.rev === r0.rev && nSaves(q.mon) === 0,
      `blocked=${st.blocked} notice=${st.vis} memory=server:${JSON.stringify(st.mem) === JSON.stringify(srvDays)} rev ${r0 && r0.rev}->${r1 && r1.rev} trip_save=${nSaves(q.mon)}`);
  } finally {
    if (qIn) await step("sync/storage-full-logout", async () => { await gotoHome(q.page, { member: true }); await logoutHome(q.page); });
    techChecks("sync-storage-full", [q.mon]);
    await closeCtx(Q);
  }
}

// D2 · Plan tab opened BEFORE the ?trip= fetch returns (trips GET delayed): the saved plan and the trip's dates must win
async function syncPlanTabBeforeTripLoad(memberTrip) {
  const ctx = await newCtx("d1366", { preseedFav: true });
  const { page, mon } = await openPage(ctx);
  const match = (u) => u.hostname === SUPA_HOST && u.pathname === "/rest/v1/trips";
  const delay = async (r) => { await new Promise((s) => setTimeout(s, 2500)); await r.fallback(); };   // fallback: the dry-run shim's context route still answers
  let inn = false, routed = false;
  try {
    await loginHome(page, ACC.member); inn = true;
    const s0 = await srv(page, memberTrip);
    await page.route(match, delay); routed = true;
    await page.goto(`${BASE}/amsterdam/?city=Amsterdam&trip=${memberTrip}&cb=${Date.now()}`, { waitUntil: "load" });
    await page.waitForFunction(() => !!(window.ASA_ST && typeof ensurePlan === "function" && document.querySelector('#nav button[data-v="cal"]')), null, { timeout: T.app });
    await view(page, "cal");
    const early = await page.evaluate((id) => !(window.TRIP && String(window.TRIP.id) === String(id)), memberTrip);
    const opened = await onTrip(page, memberTrip);
    await page.waitForTimeout(800);
    const ui = await page.evaluate((days) => {
      const n = document.getElementById("tripSyncNotice"); let items = -1;
      try { const ps = JSON.parse(localStorage.getItem("asa:ams:plan_sync") || "null"); items = ps && Array.isArray(ps.items) ? ps.items.length : 0; } catch (e) {}
      let pr = null; try { const g = PSET.getPrefs(); pr = [g.startDate, g.endDate]; } catch (e) {}
      return { sample: CAL.sample, keys: CAL.days.map((d) => d.key), btns: document.querySelectorAll('#cal button[onclick^="selectPlanDay("]').length,
        sel: typeof planSelDay !== "undefined" ? planSelDay : null, stops: document.querySelectorAll("#dayFlow .pl-6 > .relative").length,
        empty: /Bu güne henüz plan yok\./.test(document.getElementById("dayFlow")?.textContent || ""), mem: days.map((d) => ((typeof dayVenues !== "undefined" && dayVenues[d]) || []).join(",")),
        prefs: pr, noticeHidden: n ? n.classList.contains("hide") : null, items };
    }, QA_TRIP.days);
    await page.waitForTimeout(2500);
    await page.unroute(match, delay).catch(() => {}); routed = false;
    const s1 = await srv(page, memberTrip);
    const srvSel = s0 ? cnt(s0.dayven, ui.sel) : -1;
    const memEq = !!s0 && JSON.stringify(ui.mem) === JSON.stringify(QA_TRIP.days.map((d) => (s0.dayven[d] || []).join(",")));
    const unchanged = !!s0 && !!s1 && norm(s1.dayven) === norm(s0.dayven) && Object.keys(s1.dayven).every((k) => /^\d{4}-\d\d-\d\d$/.test(k));
    rec("sync/plan-tab-open-before-trip-load", opened && ui.sample === false && JSON.stringify(ui.keys) === JSON.stringify(QA_TRIP.days) && ui.btns === 3 && ui.stops === srvSel && ui.empty === (srvSel === 0) && memEq &&
      !!ui.prefs && ui.prefs[0] === QA_TRIP.start && ui.prefs[1] === QA_TRIP.end && ui.noticeHidden === true && ui.items === 0 && unchanged,
      JSON.stringify({ planTabBeforeTrip: early, sample: ui.sample, days: ui.keys.join(","), chips: ui.btns, shownStops: `${ui.stops}/${srvSel}`, memoryEqualsServer: memEq, prefs: ui.prefs, noticeHidden: ui.noticeHidden, kept: ui.items, serverUnchanged: unchanged }));
  } finally {
    if (routed) await page.unroute(match, delay).catch(() => {});
    if (inn) await step("sync/plan-tab-logout", async () => { await gotoHome(page, { member: true }); await logoutHome(page); });
    techChecks("sync-plan-tab", [mon]);
    await closeCtx(ctx);
  }
}

// D6 · favourites: unexpected cloud rows created by a regression are removed through the heart UI (else listed in cleanup)
async function undoExtraFavs(page, owner, ids, P) {
  for (const id of ids) pending.favs.push({ owner, venue: id });
  const left = [];
  for (const id of ids) {
    try { await gotoAms(page, { member: true }); await view(page, "list"); if ((await favState(page, id)).mem) await heart(page, id); } catch (e) {}
    if (await waitCloud(page, id, false)) drop(pending.favs, (f) => f.owner === owner && f.venue === id); else left.push(id);
  }
  rec(`${P}/unexpected-favourites-removed-via-ui`, left.length === 0, `${ids.length - left.length}/${ids.length} removed${left.length ? "; left: " + left.join(",") : ""}`);
}
// D6 flow F: a device WITHOUT preseeded favourites (the page seeds its 7 defaults) logs in as the member, logs out, then logs
// in as the second member. Seeds must never reach an account; logout must not carry the member's favourites to the next one.
async function favFlow(wp, secondCloud0, X) {
  const F = await newCtx("d1366");
  const f = await openPage(F), fp = f.page;
  let who = null;
  const cityLogout = async () => { await view(fp, "member"); await press(fp, "#asaLogout"); await fp.waitForFunction(() => !(window.ASA && window.ASA.session), null, { timeout: T.app }); who = null; };
  try {
    await gotoAms(fp, { member: false });
    const seeds = await fp.evaluate(() => { try { return JSON.parse(localStorage.getItem("asa:ams:fav") || "null"); } catch (e) { return null; } });
    const memberBefore = await cloudIds(wp);
    if (!memberBefore) { rec("fav/seed-defaults-not-uploaded", false, "member favourites not readable"); return; }
    await loginCity(fp, ACC.member); who = "member";
    await fp.waitForTimeout(2000);
    const mc = await cloudIds(fp), dev = await fp.evaluate(() => [...favSet].sort());
    const extraM = mc ? mc.filter((id) => !memberBefore.includes(id)) : [];
    rec("fav/seed-defaults-not-uploaded", Array.isArray(seeds) && seeds.length > 0 && !!mc && JSON.stringify(mc) === JSON.stringify(memberBefore) && JSON.stringify(dev) === JSON.stringify(mc),
      `device seeds=${seeds && seeds.length} account ${memberBefore.length}->${mc && mc.length}${extraM.length ? " uploaded: " + extraM.join(",") : ""} device=${dev.length}`);
    if (extraM.length) await undoExtraFavs(fp, "member", extraM, "fav/member");
    await cityLogout();
    await fp.waitForTimeout(600);
    const lo = await fp.evaluate(() => { let fs = null; try { fs = JSON.parse(localStorage.getItem("asa:ams:fav_sync") || "null"); } catch (e) {} return { fav: localStorage.getItem("asa:ams:fav"), mem: [...favSet].length, syncUid: fs ? fs.uid : "absent" }; });
    rec("fav/logout-clears-account-favourites", lo.fav === "[]" && lo.mem === 0 && lo.syncUid === null, JSON.stringify(lo));
    await loginCity(fp, ACC.second); who = "second";
    await fp.waitForTimeout(2000);
    const sc = await cloudIds(fp), base = [...(secondCloud0 || [])].sort();
    const extraS = sc ? sc.filter((id) => !base.includes(id)) : [];
    rec("fav/not-carried-to-other-account", !!secondCloud0 && !!sc && JSON.stringify(sc) === JSON.stringify(base) && !sc.includes(X), `second account ${base.length}->${sc && sc.length}${extraS.length ? " carried: " + extraS.join(",") : ""}`);
    if (extraS.length) await undoExtraFavs(fp, "second", extraS, "fav/second");
  } finally {
    if (who) await step("fav/flow-logout", cityLogout);
    techChecks("fav-flow", [f.mon]);
    await closeCtx(F);
  }
}

// ================================================================================================ WRITES + ISOLATION + PERSISTENCE
async function writeScenario() {
  const W = await newCtx("d1366", { preseedFav: true });
  const S = await newCtx("d1366", { preseedFav: true });
  const w = await openPage(W), s = await openPage(S);
  const wp = w.page, sp = s.page;
  let memberTrip = null, secondTrip = null, X = null, Y = null, wIn = false, sIn = false, secondCloud0 = null;
  const saveTrack = trackTripSaves(wp);   // WP6/D1: this page must never overlap its own trip_save requests
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
      secondCloud0 = cs.rows.map((r) => r.venue_id);
      const taken = new Set([...mw.fav, ...ms.fav, ...cw.rows.map((r) => r.venue_id), ...cs.rows.map((r) => r.venue_id)]);
      const free = mw.cat.filter((id) => !taken.has(id));
      X = free[0] || null; Y = free[1] || null; facts.X = X;
      rec("write/setup/test-venues-chosen", !!X && !!Y, `X=${X} Y=${Y} memberCloud=${cw.rows.length} secondCloud=${cs.rows.length}`);
      return !!X && !!Y;
    });
    if (!ok0) return;

    // ---------------- favourite add -> reload -> present (device + server)
    await step("write/fav-add", async () => {
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
      // edit the saved plan through the day editor (remove the first stop of day 1), so a later "plan restored" check
      // can tell the saved plan apart from a freshly auto-generated one
      const d1 = QA_TRIP.days[0];
      const before = await wp.evaluate((d) => (dayVenues[d] || []).slice(), d1);
      await press(wp, "#dayFlow button", { text: "Aç / düzenle" });
      await wp.waitForFunction(() => !document.getElementById("dayModal").classList.contains("hide"), null, { timeout: T.short });
      await press(wp, '#dayModal button[title="Çıkar"]');
      await press(wp, "#dayModal .dayclose");
      const ed = await poll(wp, async ({ id, d, n }) => { const t = await window.TripStore.get(id); const dv = (t && t.plan && t.plan.dayven) || {}; return { ok: Array.isArray(dv[d]) ? dv[d].length === n - 1 : n === 1, server: (dv[d] || []).length }; }, { id: memberTrip, d: d1, n: before.length });
      rec("write/plan/edit-day-remove-stop-saved", before.length > 0 && ed.ok, `day1 ${before.length}->${ed.server}`);
      if (snp) { cleanup.push({ table: "trip_plan_versions", trip_id: Number(memberTrip), owner: ACC.member.label, state: "created_by_plan_snapshot", note: "no UI delete; remove with the archived QA trip" }); sideEffects.add("trip_plan_versions snapshot row(s) on the QA trip (listed in cleanup)"); }
    });

    // ---------------- WP6 sync integrity on the QA trip (D7 browsing reference, D1 conflicts, D4 new trip, D3 guest import, D5 quota)
    if (memberTrip) await step("sync/browse-ref", () => syncBrowseRef(wp, w.mon, memberTrip));
    if (memberTrip && pending.plans.length) {
      sideEffects.add("WP6 sync checks: a deliberate two-device and two-tab plan conflict on the QA trip, one explicit restore (the plan is cleared by the undo step)");
      await step("sync/conflict", () => syncConflict(wp, memberTrip));
      await step("sync/two-tabs", () => syncTwoTabs(W, wp, memberTrip));
    }
    if (memberTrip) {
      sideEffects.add("WP6 sync checks: an extra QA trip 2099-03-10..12 created via the search form and archived via the UI");
      await step("sync/new-trip", () => syncNewTrip(wp, memberTrip));
      await step("sync/guest-import", () => syncGuestImport(wp, memberTrip));
    }
    if (memberTrip && pending.plans.length) await step("sync/storage-full", () => syncStorageFull(memberTrip));

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
        const archived = !db.error && (db.rows.length === 0 || !!db.rows[0].archived_at);
        rec("iso/second-trip-archived-via-ui", a.ok && archived, `${a.okTxt || a.err || a.why} ${db.error ? db.error : db.rows.length ? (db.rows[0].archived_at ? "archived_at set" : "archived_at NULL") : "row no longer readable"}`);
        if (a.ok && archived) { drop(pending.trips, (t) => t.owner === "second"); cleanup.push({ table: "trips", id: Number(secondTrip), owner: ACC.second.label, state: "archived_by_ui", note: "row kept with archived_at; optional hard delete" }); }
      }
      await sweepQaTrips(sp, "second", "iso");
      await gotoAms(sp, { member: true });
      await view(sp, "member");
      await press(sp, "#asaLogout");
      await sp.waitForFunction(() => !(window.ASA && window.ASA.session), null, { timeout: T.app });
      sIn = false;
      await view(sp, "list");
      const an = await snap(sp);
      rec("iso/second-logout-via-city-page", !an.member && (an.catalog.length <= 10 || an.cards.length === 10) && (await sp.evaluate(() => Object.keys(localStorage).filter((k) => /^sb-.*-auth-token$/.test(k)).length)) === 0, `cards=${an.cards.length}`);
    });

    // ---------------- WP6/D6 favourites: seeds never uploaded, logout clears the account's copy, nothing carried to the next account
    if (X) await step("fav/flow", () => favFlow(wp, secondCloud0, X));

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

    // ---------------- WP5: name completion round trip (own row only; operator resets afterwards)
    await step("write/wp5", async () => { await gotoHome(wp, { member: true }); await wp5NameWrite(wp); });

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
    rec("sync/trip-save-never-overlaps", saveTrack.max <= 1, `trip_save requests=${saveTrack.n} max in flight=${saveTrack.max}`);
  } finally {
    techChecks("write-member", [w.mon]);
    techChecks("write-second", [s.mon]);
    if (sIn) await step("iso/second-logout-fallback", async () => { await gotoHome(sp); if (await sp.evaluate(memberLabel)) await logoutHome(sp); });
    if (wIn) await step("write/member-logout-fallback", async () => { await gotoHome(wp); if (await wp.evaluate(memberLabel)) await logoutHome(wp); });
    await closeCtx(S);
    await closeCtx(W);
  }
}

async function persistAndUndo() {
  const { memberTrip, X } = facts;
  // WP6/D2: own fresh device, Plan tab opened before the ?trip= fetch returns
  if (memberTrip && pending.plans.length) await step("sync/plan-tab", () => syncPlanTabBeforeTripLoad(memberTrip));
  // fresh context = a second device: everything below must come from the server
  const ctx = await newCtx("d1366", { preseedFav: true });
  const { page, mon } = await openPage(ctx);
  let inn = false;
  try {
    await step("persist", async () => {
      await loginHome(page, ACC.member); inn = true;
      rec("persist/login-again-new-device", true);
      let onTrip = false;
      if (memberTrip) {
        const list = await openTrips(page);
        const listed = list.rows.some((x) => x.id === String(memberTrip));
        rec("persist/trip-still-listed", listed, `rows=${list.rows.length}`);
        if (listed) {
          await Promise.all([page.waitForURL(/\/amsterdam\/.*trip=/, { timeout: T.nav }), press(page, `#tripsList [data-trip-act="open"][data-trip-id="${memberTrip}"]`)]);
          onTrip = await page.waitForFunction((id) => window.TRIP && String(window.TRIP.id) === String(id), memberTrip, { timeout: T.app }).then(() => true).catch(() => false);
          rec("persist/trip-reopens-on-new-device", onTrip, new URL(page.url()).search.replace(/&cb=\d+/, ""));
        } else await closeDialogs(page);
      }
      if (!onTrip) await gotoAms(page, { member: true });
      if (X && pending.favs.some((f) => f.owner === "member")) {
        await page.waitForFunction(() => !!(window.ASA && window.ASA.session), null, { timeout: T.app });
        const st = await favState(page, X);
        rec("persist/favourite-restored-from-account", st.mem === true && st.local === true && st.icon === "favorite", JSON.stringify(st));
      }
      if (onTrip && pending.plans.length) {
        const srvDays = async () => page.evaluate(async ({ id, days }) => { const t = await window.TripStore.get(id); const dv = (t && t.plan && t.plan.dayven) || {}; return days.map((d) => (dv[d] || []).join(",")); }, { id: memberTrip, days: QA_TRIP.days });
        const srv = await srvDays();
        const pl = await page.evaluate((days) => { let dv = {}; try { dv = JSON.parse(localStorage.getItem("asa:ams:dayven") || "{}") || {}; } catch (e) {} let pp = {}; try { pp = JSON.parse(localStorage.getItem("asa:ams:plan_prefs") || "{}") || {}; } catch (e) {} return { days: days.map((d) => (dv[d] || []).join(",")), saved: !!pp.saved }; }, QA_TRIP.days);
        rec("persist/plan-restored-from-trip-to-device", srv.some(Boolean) && JSON.stringify(pl.days) === JSON.stringify(srv) && pl.saved, `serverDays=${srv.filter(Boolean).length} deviceEqual=${JSON.stringify(pl.days) === JSON.stringify(srv)} prefsSaved=${pl.saved}`);
        // what the user sees: the Plan tab of the reopened trip (no extra reload), and the server plan must survive it
        const cnt = (a) => a.map((x) => x.split(",").filter(Boolean).length).join("/");
        await view(page, "cal");
        await page.waitForTimeout(600);
        const shown = await page.evaluate((days) => days.map((d) => ((typeof dayVenues !== "undefined" && dayVenues[d]) || []).join(",")), QA_TRIP.days);
        const same = JSON.stringify(shown) === JSON.stringify(srv);
        rec("persist/plan-tab-shows-saved-plan-on-new-device", srv.some(Boolean) && same, same ? `equal ${cnt(srv)}` : `shown=${cnt(shown)} saved=${cnt(srv)}: Plan tab regenerated the plan (TripSync.hydrate writes asa:ams:dayven but not the page's in-memory dayVenues)`);
        await page.waitForTimeout(2500); // TripSync debounce 1.2 s + save
        const after = await srvDays();
        rec("persist/saved-plan-not-overwritten-by-plan-tab", JSON.stringify(after) === JSON.stringify(srv), JSON.stringify(after) === JSON.stringify(srv) ? "server plan unchanged" : `server plan changed ${cnt(srv)} -> ${cnt(after)} (regenerated plan autosaved over the saved one)`);
      }
    });
    // WP6/D6: an older device that still holds favourite X must not bring it back after X is removed on this device
    let OLD = null, old = null, oldIn = false, xBefore = null;
    if (inn && X && pending.favs.some((f) => f.owner === "member" && f.venue === X)) await step("fav/deleted-elsewhere-setup", async () => {
      OLD = await newCtx("d1366", { preseedFav: true }); old = await openPage(OLD);
      await loginHome(old.page, ACC.member); oldIn = true;
      await gotoAms(old.page, { member: true }); await view(old.page, "list");
      xBefore = await favState(old.page, X);
    });
    if (inn) await undoAll(page, "member");
    if (OLD) {
      await step("fav/deleted-elsewhere", async () => {
        if (!oldIn) return;
        await gotoAms(old.page, { member: true }); await view(old.page, "list");
        await old.page.waitForTimeout(2000);
        const back = await cloudHas(old.page, X), st = await favState(old.page, X);
        rec("fav/deleted-elsewhere-stays-deleted", !!xBefore && xBefore.mem === true && back === false && st.mem === false && st.local === false, `before=${JSON.stringify(xBefore)} cloudAfterReload=${back} device=${JSON.stringify(st)}`);
        if (back !== false) await undoExtraFavs(old.page, "member", [X], "fav/deleted-elsewhere");
      });
      if (oldIn) await step("fav/old-device-logout", async () => { await gotoHome(old.page, { member: true }); await logoutHome(old.page); });
      techChecks("fav-old-device", [old.mon]);
      await closeCtx(OLD);
    }
    if (inn) await step("persist/logout-end", async () => { await gotoHome(page, { member: true }); const o = await logoutHome(page); inn = false; rec("persist/logout-end", o.asaSession === null && o.sbKeys === 0, JSON.stringify(o)); });
  } finally { techChecks("persist-undo", [mon]); await closeCtx(ctx); }
}

// Safety sweep: any still-active trip of this owner starting in 2099 (the QA marker) is archived through the UI —
// catches a trip whose id was lost (e.g. a timeout right after "Keşfet") and leftovers of aborted runs.
async function sweepQaTrips(page, owner, prefix = "cleanup") {
  const lab = owner === "member" ? ACC.member.label : ACC.second.label;
  const id0 = `${prefix}/${owner}-qa-trip-sweep`;
  await step(id0, async () => {
    await gotoHome(page, { member: true });
    const r = await read(page, "trips", "id,start_date,archived_at,user_id", [["is", "archived_at", null]]);
    if (r.error) { rec(id0, false, r.error); return; }
    const ids = r.rows.filter((t) => String(t.start_date || "").startsWith(QA_YEAR)).map((t) => String(t.id));
    const left = [];
    for (const id of ids) {
      const a = await archiveTripUI(page, id);
      drop(pending.trips, (x) => x.owner === owner && String(x.id) === id);
      if (a.ok) cleanup.push({ table: "trips", id: Number(id), owner: lab, state: "archived_by_ui", note: "QA trip found by the 2099 sweep; row kept with archived_at" });
      else { left.push(id); pending.trips.push({ owner, id }); }
    }
    rec(id0, left.length === 0, ids.length ? `archived ${ids.length - left.length}/${ids.length}: ${ids.join(",")}` : "no active 2099 trips");
  });
}

// Undo every pending write of one owner through the UI (plan clear -> favourite remove -> trip archive -> pref restore).
async function undoAll(page, owner, P = owner === "member" ? "undo" : `undo-${owner}`) {
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
    const archived = !db.error && (db.rows.length === 0 || !!db.rows[0].archived_at);
    rec(`${P}/trip-archived-via-arsivle`, a.ok && archived, `${a.okTxt || a.err || a.why} ${db.error ? db.error : db.rows.length ? (db.rows[0].archived_at ? "archived_at set" : "archived_at NULL") : "row no longer readable"}`);
    if (a.ok && archived) { drop(pending.trips, (x) => x === t); cleanup.push({ table: "trips", id: Number(t.id), owner: owner === "member" ? ACC.member.label : ACC.second.label, state: "archived_by_ui", note: "row kept with archived_at; optional hard delete (with its trip_plan_versions)" }); }
  });
  await sweepQaTrips(page, owner, P);
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
      const { page } = await openPage(ctx);
      await loginHome(page, ACC[owner]);
      await undoAll(page, owner, `cleanup-retry/${owner}`);
      await step(`cleanup-retry/${owner}/logout`, async () => { await gotoHome(page, { member: true }); await logoutHome(page); });
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
  const xfail = checks.filter((c) => c.result === "XFAIL").length;
  const res = { base: BASE, verdict: fail || !pass ? "FAIL" : "PASS", pass, fail, skip, xfail, checks, cleanup, side_effects: [...sideEffects] };
  let body = JSON.stringify(res, null, 2);
  if (/eyJ[A-Za-z0-9_-]{10,}\.|\bat\s+\S+\s+\(|file:\/\/|ReferenceError|TypeError|service_role/i.test(body) || MASK.some((m) => body.includes(m))) {
    try { body = JSON.stringify(JSON.parse(scrub(body)), null, 2); } catch { body = JSON.stringify({ base: BASE, verdict: "FAIL", pass, fail: fail + 1, skip, checks: [{ id: "run: result scrub", result: "FAIL", detail: "result contained token/stack-like text; details dropped" }], cleanup }, null, 2); }
  }
  writeFileSync(OUT_FILE, body + "\n");
  console.log("WP6_LIVE_SUMMARY " + JSON.stringify({ base: BASE, total: checks.length, pass, fail, skip, xfail, cleanup: cleanup.length, verdict: res.verdict }));
  for (const c of checks) console.log(`${c.result.padEnd(5)} ${c.id} :: ${c.detail}`);
  for (const c of cleanup) console.log(`CLEANUP ${JSON.stringify(c)}`);
  process.exit(code != null ? code : fail || !pass ? 1 : 0);
}
const hard = setTimeout(async () => {
  rec("run: global time limit reached", false, `${HARD_LIMIT_MS} ms`);
  const lab = (o) => (o === "member" ? "qa_member" : "qa_admin_as_member");
  for (const t of pending.trips) cleanup.push({ table: "trips", id: Number(t.id), owner: lab(t.owner), state: "active_not_undone" });
  for (const p of pending.plans) cleanup.push({ table: "trips", id: Number(p.trip), owner: lab(p.owner), state: "plan_not_cleared" });
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
