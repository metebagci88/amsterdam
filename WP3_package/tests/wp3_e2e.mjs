// WP3 · browser storage city isolation — Playwright end-to-end tests.
//
// Serves the repo root with `python3 -m http.server` on 127.0.0.1 and drives the
// real amsterdam/index.html and index.html in Chromium. Every non-local request
// is answered by a route() stub (tailwind, fonts, leaflet, supabase-js, images),
// so the run is deterministic and never reaches www.asalocal.club or *.supabase.co.
//
//   NODE_PATH=<dir with playwright> node WP3_package/tests/wp3_e2e.mjs
//   env: WP3_BASE_REF (pre-WP3 commit for the rollback proof, default 7a548e9)
//        WP3_VIEWPORTS=desktop,mobile (default both)  WP3_ONLY=<scenario substring>
//
// Output: one PASS/FAIL line per check, a third-party request list, and the
// sentinel WP3_E2E_PASS (exit 0) or WP3_E2E_FAIL (exit 1).

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const { fingerprint } = require(join(REPO, "lib", "asa-storage", "asa_storage.js"));
const BASE_REF = process.env.WP3_BASE_REF || "7a548e9";
const ONLY = process.env.WP3_ONLY || "";
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };
const WANT_VP = (process.env.WP3_VIEWPORTS || "desktop,mobile").split(",").filter((v) => VIEWPORTS[v]);

const SUPA_STUB = readFileSync(join(HERE, "stubs", "supabase_stub.js"), "utf8");
const LEAFLET_STUB = readFileSync(join(HERE, "stubs", "leaflet_stub.js"), "utf8");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const LEGACY = ["ams_fav", "ams_plan", "ams_dayven", "ams_cal", "ams_calphoto", "asa_trip", "asa_plan_prefs"];
const UID = "00000000-0000-4000-8000-0000000000a1";
const TEST_MAIL = ["wp3-member", "example.invalid"].join("@"); // built at runtime; no address literal in the file

let fails = 0;
let passes = 0;
const thirdParty = new Map();
const consoleNoise = [];
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

function oldAmsterdamPage() {
  return execFileSync("git", ["-C", REPO, "show", `${BASE_REF}:amsterdam/index.html`], { maxBuffer: 64 * 1024 * 1024 });
}

/* ---------- browser context with stubs + storage instrumentation ---------- */
async function newContext(browser, origin, vp, opts = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], serviceWorkers: "block" });
  const old = opts.oldPage || null;
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === origin) {
      if (u.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
      if (u.pathname === "/__wp3_blank__") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>wp3</title>" });
      if (u.pathname.startsWith("/__wp3_old__/amsterdam/") && old) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: old });
      if (u.pathname === "/lib/asa-storage/asa_storage.js" && opts.libMissing) return route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
      return route.continue();
    }
    const key = u.host + u.pathname.replace(/\/[^/]*\.(png|jpe?g|webp|gif)$/i, "/*");
    thirdParty.set(key, (thirdParty.get(key) || 0) + 1);
    if (u.host === "cdn.tailwindcss.com") return route.fulfill({ status: 200, contentType: "application/javascript", body: "window.tailwind={config:{}};" });
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
  await ctx.addInitScript(({ supa, failSet, armOnRemove }) => {
    window.__WP3_SUPA = supa;
    const log = [];
    Object.defineProperty(window, "__WP3_LS_LOG", { value: log });
    const P = Storage.prototype;
    const g = P.getItem, s = P.setItem, r = P.removeItem, c = P.clear;
    Object.defineProperty(window, "__WP3_RAW_GET", { value: (k) => g.call(window.localStorage, k) });
    // armOnRemove {key, fail[, error]}: once per page, the first removeItem(key) arms a forced, non-quota
    // exception (Error, or TypeError with error:"TypeError") for the next setItem of each key in `fail`
    // (a failure between remove and write).
    let armed = [], used = false;
    P.getItem = function (k) { log.push(["get", String(k)]); return g.call(this, k); };
    P.setItem = function (k, v) {
      log.push(["set", String(k)]);
      if (failSet.includes(String(k))) throw new DOMException("quota (test)", "QuotaExceededError");
      const i = armed.indexOf(String(k));
      if (i >= 0) { armed.splice(i, 1); const err = armOnRemove.error === "TypeError" ? new TypeError("forced failure between remove and write (test)") : new Error("forced failure between remove and write (test)"); log.push(["forced", String(k), err.name]); throw err; }
      return s.call(this, k, v);
    };
    P.removeItem = function (k) { log.push(["remove", String(k)]); const out = r.call(this, k); if (armOnRemove && !used && String(k) === armOnRemove.key) { used = true; armed = armOnRemove.fail.slice(); } return out; };
    P.clear = function () { log.push(["clear", ""]); return c.call(this); };
  }, { supa: opts.supa || {}, failSet: opts.failSet || [], armOnRemove: opts.armOnRemove || null });
  return ctx;
}

function attach(page, bucket) {
  page.on("pageerror", (e) => bucket.push({ kind: "pageerror", text: String(e && e.message || e) }));
  page.on("console", (m) => { if (m.type() === "error") bucket.push({ kind: "console", text: m.text(), url: (m.location() || {}).url || "" }); });
}

async function seedStorage(page, origin, data) {
  await page.goto(origin + "/__wp3_blank__");
  await page.evaluate((d) => { localStorage.clear(); for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); }, data);
}
// Reads through the un-instrumented getItem so dumps never show up in __WP3_LS_LOG.
const dump = (page) => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = window.__WP3_RAW_GET(k); } return o; });
const lsLog = (page) => page.evaluate(() => window.__WP3_LS_LOG.slice());
const notice = (page) => page.evaluate(() => { const el = document.getElementById("asaStoreNotice"); return el ? { visible: !el.classList.contains("hide") && el.offsetParent !== null, text: el.textContent, role: el.getAttribute("role"), live: el.getAttribute("aria-live") } : null; });
async function openCity(page, origin, query = "?city=Amsterdam") {
  await page.goto(origin + "/amsterdam/" + query, { waitUntil: "load" });
  await page.waitForFunction(() => window.ASA_ST && typeof window.toggleFav === "function", null, { timeout: 10000 });
  await page.waitForTimeout(150);
}
async function noOverflow(page, vp) {
  if (vp !== "mobile") return true;
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
const trip = (city, s = "2026-11-02", e = "2026-11-05") => JSON.stringify({ country: city === "Kopenhag" ? "Danimarka" : "Hollanda", city, duration_days: 4, start_date: s, end_date: e, vacation_types: ["Gastronomi"] });
const LEGACY_SEED = {
  ams_fav: JSON.stringify(["barpif", "chun"]),
  ams_cal: JSON.stringify({ "2026-11-02": "Müze kartı al" }),
  ams_plan: JSON.stringify({ "2026-11-02": "Sabah: kahve" }),
  ams_dayven: JSON.stringify({ "2026-11-02": ["barpif"] }),
  ams_calphoto: JSON.stringify({ "2026-11-02": ["data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"] }),
  asa_trip: trip("Amsterdam"),
  asa_plan_prefs: JSON.stringify({ tempo: "Sakin", saved: true }),
  asa_session: JSON.stringify({ uid: "session-placeholder" }),
  "sb-wp3ref-auth-token": "token-placeholder"
};

/* ---------- scenarios ---------- */
const scenarios = [];
const sc = (name, fn, opts = {}) => scenarios.push({ name, fn, opts });

sc("fresh user: favorites seeded once into asa:ams:fav only", async ({ page, origin, vp, t }) => {
  await seedStorage(page, origin, {});
  await openCity(page, origin);
  const d1 = await dump(page);
  const fav = JSON.parse(d1["asa:ams:fav"] || "null");
  t("seeded array with barpif", Array.isArray(fav) && fav.includes("barpif") && new Set(fav).size === fav.length);
  t("no legacy key written", LEGACY.every((k) => !(k in d1)));
  const m = JSON.parse(d1["asa:ams:_migrated"] || "null");
  t("marker v1 verified", m && m.v === 1 && m.verified === true && m.legacy_kept === true);
  t("notice hidden", !(await notice(page)).visible);
  await page.evaluate(() => toggleFav("barpif"));
  const afterToggle = (await dump(page))["asa:ams:fav"];
  t("toggle removed barpif", !JSON.parse(afterToggle).includes("barpif"));
  await openCity(page, origin);
  const d2 = await dump(page);
  t("reload does not reseed", d2["asa:ams:fav"] === afterToggle);
  t("reload keeps marker bytes", d2["asa:ams:_migrated"] === d1["asa:ams:_migrated"]);
  t("no overflow", await noOverflow(page, vp));
});

sc("seed guard: an unreadable legacy favorites value is 'not empty' — no seed, legacy kept", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { ams_fav: "{bozuk" });
  await openCity(page, origin);
  const d = await dump(page);
  t("no asa:ams:fav seeded", !("asa:ams:fav" in d));
  t("no seeded favorite in memory", !(await page.evaluate(() => isFav("barpif"))));
  t("corrupt legacy kept byte-identical", d.ams_fav === "{bozuk");
  t("marker records corrupt legacy, not verified", (() => { const m = JSON.parse(d["asa:ams:_migrated"]); return m.keys.ams_fav.state === "corrupt" && m.verified === false; })());
});

sc("legacy-only user: migrated once, legacy kept, marker verified, UI shows data", async ({ page, origin, t }) => {
  await seedStorage(page, origin, LEGACY_SEED);
  await openCity(page, origin);
  const d1 = await dump(page);
  for (const k of ["ams_fav", "ams_cal", "ams_plan", "ams_dayven", "ams_calphoto", "asa_trip", "asa_plan_prefs"]) {
    const dom = { ams_fav: "fav", ams_cal: "cal", ams_plan: "plan", ams_dayven: "dayven", ams_calphoto: "calphoto", asa_trip: "trip", asa_plan_prefs: "plan_prefs" }[k];
    t(`${k} copied byte-identical to asa:ams:${dom}`, d1["asa:ams:" + dom] === LEGACY_SEED[k]);
    t(`${k} kept`, d1[k] === LEGACY_SEED[k]);
  }
  const m = JSON.parse(d1["asa:ams:_migrated"]);
  t("marker verified + all present keys verified", m.verified === true && Object.values(m.keys).every((e) => e.state === "verified"));
  t("notice hidden", !(await notice(page)).visible);
  const ui = await page.evaluate(() => ({ chun: isFav("chun"), barpif: isFav("barpif"), banner: document.getElementById("tripBanner").textContent, cal: CAL.days[0] && CAL.days[0].key, note: calNotes["2026-11-02"], plan: calPlans["2026-11-02"], dv: dayVenues["2026-11-02"], ph: (calPhotos["2026-11-02"] || []).length }));
  t("favorites from legacy visible", ui.chun && ui.barpif);
  t("trip banner shows Amsterdam plan", /Planın: Amsterdam/.test(ui.banner) && /2 Kas/.test(ui.banner));
  t("calendar uses trip dates", ui.cal === "2026-11-02");
  t("day note/plan/venues/photos loaded", ui.note === "Müze kartı al" && ui.plan === "Sabah: kahve" && ui.dv && ui.dv[0] === "barpif" && ui.ph === 1);
  await openCity(page, origin);
  const d2 = await dump(page);
  t("reload: storage byte-identical (no duplication, no rewrite)", JSON.stringify(d2) === JSON.stringify(d1));
  const writes = (await lsLog(page)).filter((e) => e[0] !== "get");
  t("reload: zero storage writes", writes.length === 0, JSON.stringify(writes));
});

sc("conflict (legacy != new): banner shown, new authoritative, nothing overwritten", async ({ page, origin, vp, t }) => {
  await seedStorage(page, origin, { ams_fav: JSON.stringify(["barpif"]), "asa:ams:fav": JSON.stringify(["chun"]), ams_cal: JSON.stringify({ g1: "eski" }), "asa:ams:cal": JSON.stringify({ g1: "yeni" }) });
  await openCity(page, origin);
  const n = await notice(page);
  t("notice visible", n.visible);
  t("notice is a polite status region", n.role === "status" && n.live === "polite");
  t("notice names Favoriler + Takvim notları in Turkish", /iki farklı kopyası/.test(n.text) && /Favoriler/.test(n.text) && /Takvim notları/.test(n.text) && /eski kopya silinmedi/.test(n.text));
  const ui = await page.evaluate(() => ({ chun: isFav("chun"), barpif: isFav("barpif"), g1: calNotes.g1 }));
  t("new value used", ui.chun && !ui.barpif && ui.g1 === "yeni");
  const d = await dump(page);
  t("legacy kept", d.ams_fav === JSON.stringify(["barpif"]) && d.ams_cal === JSON.stringify({ g1: "eski" }));
  t("new kept", d["asa:ams:fav"] === JSON.stringify(["chun"]) && d["asa:ams:cal"] === JSON.stringify({ g1: "yeni" }));
  t("no overflow with notice", await noOverflow(page, vp));
  const btn = page.locator("#asaStoreNotice button", { hasText: "Anladım" });
  await btn.focus();
  await page.keyboard.press("Enter");
  t("dismiss via keyboard hides notice", !(await notice(page)).visible);
  const m = JSON.parse((await dump(page))["asa:ams:_migrated"]);
  t("marker records acknowledgement, not verified", m.keys.ams_fav.state === "acknowledged" && m.keys.ams_cal.state === "acknowledged" && m.verified === false);
  await openCity(page, origin);
  t("after reload notice stays dismissed", !(await notice(page)).visible);
  const d2 = await dump(page);
  t("after dismiss both copies still intact", d2.ams_fav === d.ams_fav && d2["asa:ams:fav"] === d["asa:ams:fav"]);
});

sc("conflict from an old tab writing legacy after migration", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { ams_plan: JSON.stringify({ g1: "ilk" }) });
  await openCity(page, origin);
  t("first load: no notice", !(await notice(page)).visible);
  await page.evaluate(() => { localStorage.setItem("ams_plan", JSON.stringify({ g1: "eski sekme" })); });
  await openCity(page, origin);
  const n = await notice(page);
  t("notice for Gün planı notları", n.visible && /Gün planı notları/.test(n.text));
  t("page uses new value", (await page.evaluate(() => calPlans.g1)) === "ilk");
});

sc("wrong-city legacy trip (Kopenhag) is not shown as Amsterdam's", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { asa_trip: trip("Kopenhag", "2026-12-01", "2026-12-04"), asa_plan_prefs: JSON.stringify({ tempo: "Hızlı", saved: true }) });
  await openCity(page, origin);
  const n = await notice(page);
  t("mismatch notice in Turkish", n.visible && /Kopenhag için/.test(n.text) && /Amsterdam planı olarak gösterilmiyor/.test(n.text));
  t("stranded plan prefs named (not silently hidden)", /kayıtlı plan tercihlerin var/.test(n.text) && /Amsterdam planına aktarabilirsin/.test(n.text));
  t("explicit transfer button offered", (await page.locator("#asaStoreNotice button", { hasText: "Amsterdam planına aktar" }).count()) === 1);
  const ui = await page.evaluate(() => ({ banner: document.getElementById("tripBanner").classList.contains("hide"), cal: CAL.days[0].key, sample: CAL.sample }));
  t("trip banner hidden", ui.banner === true);
  t("calendar does not use Kopenhag dates", ui.cal === "g1" && ui.sample === true);
  const d = await dump(page);
  t("no asa:ams:trip written; prefs not copied without the user", !("asa:ams:trip" in d) && !("asa:ams:plan_prefs" in d));
  t("no cph key written by the Amsterdam page", !Object.keys(d).some((k) => k.startsWith("asa:cph:")));
  t("legacy trip kept", d.asa_trip === trip("Kopenhag", "2026-12-01", "2026-12-04"));
  await page.locator("#asaStoreNotice button", { hasText: "Anladım" }).click();
  await openCity(page, origin);
  t("dismissed mismatch + declined prefs stay dismissed", !(await notice(page)).visible);
  const d2 = await dump(page);
  t("decline copies nothing; legacy prefs kept", !("asa:ams:plan_prefs" in d2) && d2.asa_plan_prefs === JSON.stringify({ tempo: "Hızlı", saved: true }));
});

sc("stranded Amsterdam plan prefs (review #1): Kopenhag legacy trip → homepage Kopenhag → homepage Amsterdam → offered and adopted on request; cph never gets them", async ({ page, origin, vp, t }) => {
  const prefs = JSON.stringify({ tempo: "Sakin", mustSee: ["barpif"], saved: true });
  const oldTrip = trip("Kopenhag", "2026-12-01", "2026-12-04");
  await seedStorage(page, origin, { asa_trip: oldTrip, asa_plan_prefs: prefs });
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.AsaStorage && document.getElementById("countrySel").options.length > 1);
  await page.selectOption("#countrySel", "dk");
  await page.selectOption("#citySel", "Kopenhag");
  await Promise.all([page.waitForURL(/\/kopenhag\//), page.click("#goBtn")]);
  let d = await dump(page);
  t("homepage Kopenhag: trip in asa:cph:trip", JSON.parse(d["asa:cph:trip"] || "{}").city === "Kopenhag");
  t("homepage Kopenhag: no live cph migration (no asa:cph:plan_prefs / marker)", !("asa:cph:plan_prefs" in d) && !("asa:cph:_migrated" in d));
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("countrySel").options.length > 1);
  await page.selectOption("#countrySel", "nl");
  await page.selectOption("#citySel", "Amsterdam");
  await page.fill("#dStart", "2026-11-20");
  await page.dispatchEvent("#dStart", "change");
  await page.fill("#dEnd", "2026-11-22");
  await page.dispatchEvent("#dEnd", "change");
  await Promise.all([page.waitForURL(/\/amsterdam\/\?city=Amsterdam/), page.click("#goBtn")]);
  await page.waitForFunction(() => window.ASA_ST && typeof window.toggleFav === "function");
  await page.waitForTimeout(150);
  const n = await notice(page);
  t("own Amsterdam trip: no trip mismatch, but the prefs notice stays", n.visible && !/seyahat planın Kopenhag için/.test(n.text) && /kayıtlı plan tercihlerin var/.test(n.text));
  t("prefs not used before the user decides", (await page.evaluate(() => ASA_ST.get("plan_prefs", null))) === null);
  t("no overflow with two notice buttons", await noOverflow(page, vp));
  await page.locator("#asaStoreNotice button", { hasText: "Amsterdam planına aktar" }).click();
  d = await dump(page);
  t("adopted byte-identical into asa:ams:plan_prefs", d["asa:ams:plan_prefs"] === prefs);
  t("planner shows the adopted prefs", await page.evaluate(() => PSET.getPrefs().tempo === "Sakin" && PSET.getPrefs().must_see_ids.includes("barpif")));
  t("confirmation shown", /Amsterdam planına aktarıldı/.test((await notice(page)).text));
  await openCity(page, origin);
  t("reload: no notice, prefs still there", !(await notice(page)).visible && (await page.evaluate(() => ASA_ST.get("plan_prefs", {}).tempo)) === "Sakin");
  d = await dump(page);
  t("asa:cph:plan_prefs never written", !("asa:cph:plan_prefs" in d));
  t("legacy asa_plan_prefs / asa_trip kept byte-identical", d.asa_plan_prefs === prefs && d.asa_trip === oldTrip);
});

sc("unknown-city trip (Paris) migrated by policy A is refused on Amsterdam", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { asa_trip: trip("Paris") });
  await openCity(page, origin);
  const n = await notice(page);
  t("mismatch notice names Paris", n.visible && /Paris için/.test(n.text));
  t("banner hidden + sample calendar", await page.evaluate(() => document.getElementById("tripBanner").classList.contains("hide") && CAL.sample === true));
});

sc("?city=Kopenhag on the Amsterdam page: storage locked, nothing read or written", async ({ page, origin, t }) => {
  await seedStorage(page, origin, Object.assign({}, LEGACY_SEED, { "asa:cph:fav": JSON.stringify(["cph-x"]) }));
  const before = await dump(page);
  await openCity(page, origin, "?city=Kopenhag");
  const n = await notice(page);
  t("locked notice", n.visible && /Amsterdam rehberidir/.test(n.text) && /Kopenhag/.test(n.text));
  t("Amsterdam favorites not shown", !(await page.evaluate(() => isFav("barpif"))));
  await page.evaluate(() => toggleFav("barpif"));
  const after = await dump(page);
  t("storage unchanged (no migration, no writes)", JSON.stringify(after) === JSON.stringify(before));
  const log = await lsLog(page);
  t("no asa:* or legacy city key read", !log.some((e) => /^asa:/.test(e[1]) || LEGACY.includes(e[1])), JSON.stringify(log.slice(0, 8)));
});

sc("DB trip of another city via ?trip= is not hydrated into Amsterdam storage", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { "asa:ams:fav": "[]" });
  await openCity(page, origin, "?city=Amsterdam&trip=77");
  await page.waitForFunction(() => !document.getElementById("asaStoreNotice").classList.contains("hide"), null, { timeout: 5000 }).catch(() => {});
  const n = await notice(page);
  t("foreign trip notice", n.visible && /Açılan seyahat Kopenhag için/.test(n.text));
  const d = await dump(page);
  t("asa:ams:trip/plan not written", !("asa:ams:trip" in d) && !("asa:ams:dayven" in d) && !("asa:ams:plan_prefs" in d));
  t("window.TRIP not set", await page.evaluate(() => !window.TRIP));
}, { supa: { tables: { trips: [{ id: 77, city: "Kopenhag", country: "Danimarka", start_date: "2026-12-01", end_date: "2026-12-03", revision: 1, preferences: { plan_prefs: { tempo: "x" } }, plan: { dayven: { "2026-12-01": ["cph-v"] } } }] } } });

sc("AMS/CPH isolation: asa:cph:* never read or changed on the Amsterdam page", async ({ page, origin, t }) => {
  const cph = { "asa:cph:fav": JSON.stringify(["nyhavn"]), "asa:cph:trip": trip("Kopenhag"), "asa:cph:cal": JSON.stringify({ g1: "cph" }), "asa:cph:_migrated": "{}" };
  await seedStorage(page, origin, Object.assign({ ams_fav: JSON.stringify(["chun"]) }, cph));
  await openCity(page, origin);
  await page.evaluate(() => { toggleFav("barpif"); openDay("g1"); });
  await page.fill("#dayNote", "ams not");
  const log = await lsLog(page);
  t("no cph key read/written", !log.some((e) => e[1].startsWith("asa:cph:")), JSON.stringify(log.filter((e) => e[1].startsWith("asa:cph:"))));
  const d = await dump(page);
  t("cph values byte-identical", Object.entries(cph).every(([k, v]) => d[k] === v));
  t("cph favorite not shown as Amsterdam's", !(await page.evaluate(() => isFav("nyhavn"))));
  t("ams write landed in ams", JSON.parse(d["asa:ams:cal"]).g1 === "ams not");
  const stub = await page.goto(origin + "/kopenhag/");
  const body = await stub.body();
  const pinned = readFileSync(join(REPO, "SHA256SUMS"), "utf8").match(/^([0-9a-f]{64})\s+kopenhag\/index\.html$/m)[1];
  t("Kopenhag stub served byte-identical to SHA256SUMS", createHash("sha256").update(body).digest("hex") === pinned);
  t("Kopenhag stub has no storage access", (await lsLog(page)).length === 0);
});

sc("round-trip fav/plan/dayven/cal/calphoto/trip/plan_prefs through UI and page functions", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { ams_fav: "[]" });
  await openCity(page, origin);
  await page.click('#nav button[data-v="list"]');
  await page.locator("#cards [data-venue-id] button").first().click();
  const favAfterClick = JSON.parse((await dump(page))["asa:ams:fav"]);
  t("fav via card heart button", favAfterClick.length === 1);
  await page.evaluate(() => { setActiveView("cal"); });
  await page.waitForTimeout(100);
  await page.evaluate(() => openDay("g2"));
  await page.fill("#dayPlan", "Öğle: test planı");
  await page.fill("#dayNote", "Rezervasyon 19:00");
  await page.evaluate(() => addDayVenue("g2", "chun"));
  await page.setInputFiles("#dayPhotoInput", { name: "p.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => (calPhotos.g2 || []).length === 1, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { PSET.setDate("startDate", "2026-11-10"); PSET.setDate("endDate", "2026-11-12"); TripSync.hydrate({ preferences: { plan_prefs: { tempo: "Sakin", saved: true } } }); });
  const d = await dump(page);
  t("plan saved to asa:ams:plan", JSON.parse(d["asa:ams:plan"] || "{}").g2 === "Öğle: test planı");
  t("note saved to asa:ams:cal", JSON.parse(d["asa:ams:cal"] || "{}").g2 === "Rezervasyon 19:00");
  t("venue saved to asa:ams:dayven", (JSON.parse(d["asa:ams:dayven"] || "{}").g2 || []).includes("chun"));
  t("photo saved to asa:ams:calphoto", (JSON.parse(d["asa:ams:calphoto"] || "{}").g2 || []).length === 1);
  t("trip dates saved to asa:ams:trip", JSON.parse(d["asa:ams:trip"] || "{}").start_date === "2026-11-10");
  t("plan prefs saved to asa:ams:plan_prefs", JSON.parse(d["asa:ams:plan_prefs"] || "{}").tempo === "Sakin");
  t("no legacy key written", LEGACY.every((k) => !(k in d) || (k === "ams_fav" && d[k] === "[]")));
  await openCity(page, origin);
  const back = await page.evaluate((id) => ({ fav: isFav(id), plan: calPlans.g2, note: calNotes.g2, dv: dayVenues.g2, ph: (calPhotos.g2 || []).length, start: (ASA_ST.trip() || {}).start_date, cal0: CAL.days[0].key, tempo: ASA_ST.get("plan_prefs", {}).tempo }), favAfterClick[0]);
  t("reload reads every domain back", back.fav && back.plan === "Öğle: test planı" && back.note === "Rezervasyon 19:00" && back.dv.includes("chun") && back.ph === 1 && back.start === "2026-11-10" && back.cal0 === "2026-11-10" && back.tempo === "Sakin", JSON.stringify(back));
  const writes = (await lsLog(page)).filter((e) => e[0] !== "get");
  t("no remove/clear ever", !writes.some((e) => e[0] === "remove" || e[0] === "clear"));
});

sc("login: cloud favorites union merged into asa:ams:fav; session keys untouched", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { ams_fav: JSON.stringify(["barpif"]), asa_session: JSON.stringify({ uid: "session-placeholder" }), "sb-wp3ref-auth-token": "token-placeholder" });
  await openCity(page, origin);
  await page.waitForFunction(() => window.ASA && window.ASA.session, null, { timeout: 5000 }).catch(() => {});
  const d = await dump(page);
  const fav = JSON.parse(d["asa:ams:fav"]);
  t("union = local + cloud", fav.includes("barpif") && fav.includes("chun") && fav.includes("winkel43") && fav.length === 3, d["asa:ams:fav"]);
  t("legacy ams_fav untouched by merge", d.ams_fav === JSON.stringify(["barpif"]));
  const supaLog = await page.evaluate(() => window.__WP3_SUPA_LOG);
  const up = supaLog.find((e) => e.table === "favorites" && e.op === "upsert");
  t("local-only favorite pushed to cloud", up && up.value.length === 1 && up.value[0].venue_id === "barpif");
  t("sb auth token placeholder untouched", d["sb-wp3ref-auth-token"] === "token-placeholder");
  t("asa_session written only by the page's own saveSession", JSON.parse(d.asa_session).uid === UID);
  const sessWrites = (await lsLog(page)).filter((e) => e[0] !== "get" && /^(asa_session|sb-)/.test(e[1]));
  t("storage layer never wrote auth keys (only saveSession)", sessWrites.every((e) => e[0] === "set" && e[1] === "asa_session"), JSON.stringify(sessWrites));
}, { supa: { user: { id: UID, email: TEST_MAIL }, tables: { favorites: [{ venue_id: "chun" }, { venue_id: "winkel43" }], members: [{ display_name: "wp3", tier: "Kaşif", points: 0, blocked: false }] } } });

sc("anonymous: asa_session and auth placeholders untouched", async ({ page, origin, t }) => {
  await seedStorage(page, origin, LEGACY_SEED);
  await openCity(page, origin);
  await page.evaluate(() => { toggleFav("winkel43"); });
  const d = await dump(page);
  t("asa_session byte-identical", d.asa_session === LEGACY_SEED.asa_session);
  t("sb token byte-identical", d["sb-wp3ref-auth-token"] === LEGACY_SEED["sb-wp3ref-auth-token"]);
  t("no write to auth keys", !(await lsLog(page)).some((e) => e[0] !== "get" && /^(asa_session|sb-|asa-admin-auth)/.test(e[1])));
});

sc("homepage: Trip Policy A (Amsterdam→ams, Kopenhag→cph, Paris→none), no false conflict", async ({ page, origin, t }) => {
  const oldTrip = trip("Amsterdam", "2026-09-01", "2026-09-03");
  await seedStorage(page, origin, { asa_trip: oldTrip, ams_fav: JSON.stringify(["chun"]) });
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.AsaStorage && document.getElementById("countrySel").options.length > 1);
  await page.selectOption("#countrySel", "fr");
  await page.selectOption("#citySel", "Paris");
  // WP7 beta: a "yakında" city has a disabled button and no interest/save promise (was: "ilgimi bırak" + no write).
  t("Paris: button disabled, no interest promise", await page.isDisabled("#goBtn") && !/İlgin kaydedildi/.test(await page.content()));
  await page.evaluate(() => document.getElementById("goBtn").click());
  await page.waitForTimeout(150);
  let d = await dump(page);
  t("Paris writes no trip key", !Object.keys(d).some((k) => /^asa:(ams|cph):trip$/.test(k)) && d.asa_trip === oldTrip);
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("countrySel").options.length > 1);
  await page.selectOption("#countrySel", "nl");
  await page.selectOption("#citySel", "Amsterdam");
  await page.fill("#dStart", "2026-11-20");
  await page.dispatchEvent("#dStart", "change");
  await page.fill("#dEnd", "2026-11-22");
  await page.dispatchEvent("#dEnd", "change");
  await Promise.all([page.waitForURL(/\/amsterdam\/\?city=Amsterdam/), page.click("#goBtn")]);
  await page.waitForFunction(() => window.ASA_ST && typeof window.toggleFav === "function");
  await page.waitForTimeout(150);
  d = await dump(page);
  const at = JSON.parse(d["asa:ams:trip"]);
  t("Amsterdam trip in asa:ams:trip", at.city === "Amsterdam" && at.start_date === "2026-11-20");
  t("legacy asa_trip kept", d.asa_trip === oldTrip);
  t("no cph trip", !("asa:cph:trip" in d));
  t("no false conflict on the city page", !(await notice(page)).visible);
  t("banner shows new dates", /20 Kas/.test(await page.evaluate(() => document.getElementById("tripBanner").textContent)));
  await page.goto(origin + "/", { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("countrySel").options.length > 1);
  await page.selectOption("#countrySel", "dk");
  await page.selectOption("#citySel", "Kopenhag");
  await Promise.all([page.waitForURL(/\/kopenhag\//), page.click("#goBtn")]);
  d = await dump(page);
  t("Kopenhag trip in asa:cph:trip only", JSON.parse(d["asa:cph:trip"]).city === "Kopenhag" && JSON.parse(d["asa:ams:trip"]).start_date === "2026-11-20");
  t("no live cph migration before launch (only asa:cph:trip)", JSON.stringify(Object.keys(d).filter((k) => k.startsWith("asa:cph:"))) === JSON.stringify(["asa:cph:trip"]));
});

sc("synthetic write failure on asa:ams:calphoto: reads fall back; a delete is reverted with a message, nothing lost", async ({ page, origin, t, dialogs }) => {
  await seedStorage(page, origin, { ams_calphoto: LEGACY_SEED.ams_calphoto, asa_trip: LEGACY_SEED.asa_trip });
  await openCity(page, origin);
  const d = await dump(page);
  t("copy not written (quota)", !("asa:ams:calphoto" in d));
  t("marker records copy_failed, not verified", (() => { const m = JSON.parse(d["asa:ams:_migrated"]); return m.keys.ams_calphoto.state === "copy_failed" && m.verified === false; })());
  t("photos still shown from legacy", (await page.evaluate(() => (calPhotos["2026-11-02"] || []).length)) === 1);
  t("no notice for a readable fallback", !(await notice(page)).visible);
  t("legacy kept", d.ams_calphoto === LEGACY_SEED.ams_calphoto);
  await page.evaluate(() => delPhoto("2026-11-02", 0));
  t("refused delete: visible message", dialogs.some((m) => /Fotoğraf silme kaydedilemedi/.test(m)), JSON.stringify(dialogs));
  t("refused delete: screen reverted (photo still shown)", (await page.evaluate(() => (calPhotos["2026-11-02"] || []).length)) === 1);
  t("copy_failed is not 'accounted for': no legacy removal attempted", !(await lsLog(page)).some((e) => e[0] === "remove"));
  t("legacy still byte-identical", (await dump(page)).ams_calphoto === LEGACY_SEED.ams_calphoto);
  await openCity(page, origin);
  t("reload matches what the screen showed", (await page.evaluate(() => (calPhotos["2026-11-02"] || []).length)) === 1);
}, { failSet: ["asa:ams:calphoto"] });

/* Real browser quota (no stubbed failure). Chromium localStorage ≈ 5,242,880 chars per origin (measured). */
const measureQuota = (page) => page.evaluate(() => { localStorage.removeItem("wp3_q"); let lo = 0, hi = 16 * 1024 * 1024; while (lo < hi) { const m = Math.ceil((lo + hi) / 2); try { localStorage.setItem("wp3_q", "q".repeat(m)); lo = m; } catch (e) { hi = m - 1; } } localStorage.removeItem("wp3_q"); return lo + "wp3_q".length; });
const usedChars = (page) => page.evaluate(() => { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + window.__WP3_RAW_GET(k).length; } return n; });
const fillToFull = (page) => page.evaluate(() => { let lo = 0, hi = 16 * 1024 * 1024; while (lo < hi) { const m = Math.ceil((lo + hi) / 2); try { localStorage.setItem("wp3_fill", "f".repeat(m)); lo = m; } catch (e) { hi = m - 1; } } localStorage.setItem("wp3_fill", "f".repeat(lo)); return lo; });
// n photo-sized data URLs of ~5% of the quota each: a valid 1×1 GIF plus base64 padding bytes after its
// trailer (decoders ignore them), so the page renders them without errors; the last char tags the photo.
const GIF_B64 = GIF.toString("base64");
const PREFIX = "data:image/gif;base64," + GIF_B64;
const photoBlob = (quota, n) => { const per = Math.floor(quota * 0.05); const pad = Math.floor((per - PREFIX.length) / 4) * 4; const list = []; for (let i = 0; i < n; i++) list.push(PREFIX + String.fromCharCode(65 + i).repeat(pad)); return JSON.stringify({ "2026-11-02": list }); };
const waitDialog = async (page, dialogs, re) => { for (let i = 0; i < 50 && !dialogs.some((m) => re.test(m)); i++) await page.waitForTimeout(100); return dialogs.some((m) => re.test(m)); };
const photoCount = (page) => page.evaluate(() => (calPhotos["2026-11-02"] || []).length);

const PHOTO_DAY = "2026-11-02";
const removesOf = async (page) => (await lsLog(page)).filter((e) => e[0] === "remove" || e[0] === "clear");
async function openPhotoUser(page, origin, t, n = 11) {
  await seedStorage(page, origin, {});
  const Q = await measureQuota(page);
  const blob = photoBlob(Q, n);
  await seedStorage(page, origin, { ams_calphoto: blob, asa_trip: LEGACY_SEED.asa_trip, ams_fav: JSON.stringify(["chun"]) });
  await openCity(page, origin);
  const used = await usedChars(page);
  const d = await dump(page);
  const m = JSON.parse(d["asa:ams:_migrated"]);
  t("large legacy photos deferred, not duplicated", m.keys.ams_calphoto.state === "deferred" && m.keys.ams_calphoto.fp === fingerprint(blob) && used < Q * 0.6, `state=${m.keys.ams_calphoto.state} used=${used} Q=${Q}`);
  t(`all ${n} photos shown from legacy`, (await photoCount(page)) === n);
  t("page load removed nothing", (await removesOf(page)).length === 0);
  return { Q, blob, marker0: d["asa:ams:_migrated"] };
}
async function addPhotoUI(page) {
  await page.evaluate((day) => openDay(day), PHOTO_DAY);
  await page.setInputFiles("#dayPhotoInput", { name: "p.png", mimeType: "image/png", buffer: PNG });
}

sc("real quota ~55% photos (owner decision: safe move): delete and add persist after reload; legacy ams_calphoto retired once and recorded; other data saves; pre-WP3 page sees no photos (documented)", async ({ page, origin, t, dialogs }) => {
  const { blob } = await openPhotoUser(page, origin, t);
  t("no notice at load", !(await notice(page)).visible);
  await page.evaluate((day) => delPhoto(day, 0), PHOTO_DAY);
  let d = await dump(page);
  t("delete saved without a message", dialogs.length === 0 && (await photoCount(page)) === 10, JSON.stringify(dialogs));
  t("legacy ams_calphoto removed; asa:ams:calphoto holds the 10 photos", !("ams_calphoto" in d) && JSON.parse(d["asa:ams:calphoto"] || "{}")[PHOTO_DAY].length === 10);
  const e = JSON.parse(d["asa:ams:_migrated"]).keys.ams_calphoto;
  t("marker records the retirement: fp of the removed bytes, time, prior state", e.state === "retired" && e.fp === fingerprint(blob) && /^\d{4}-\d\d-\d\dT/.test(e.at || "") && e.from === "deferred" && JSON.parse(d["asa:ams:_migrated"]).legacy_kept === false, JSON.stringify(e));
  t("exactly one removal, of ams_calphoto only", JSON.stringify(await removesOf(page)) === JSON.stringify([["remove", "ams_calphoto"]]));
  await addPhotoUI(page);
  await page.waitForFunction((day) => (calPhotos[day] || []).length === 11, PHOTO_DAY, { timeout: 5000 }).catch(() => {});
  t("add saved without a message", dialogs.length === 0 && (await photoCount(page)) === 11, JSON.stringify(dialogs));
  await page.evaluate(() => { closeDay(); toggleFav("winkel43"); });
  await openCity(page, origin);
  const after = await page.evaluate((day) => { const l = calPhotos[day] || []; return { n: l.length, firstDeleted: !l.some((x) => x.endsWith("AAAA")), added: l.some((x) => x.startsWith("data:image/jpeg") && x.length < 5000) }; }, PHOTO_DAY);
  t("reload: delete and add both persisted", after.n === 11 && after.firstDeleted && after.added, JSON.stringify(after));
  t("favorite saved", await page.evaluate(() => isFav("winkel43") && isFav("chun")));
  t("no notice after reload", !(await notice(page)).visible);
  t("reload: zero storage writes (retirement record stable)", (await lsLog(page)).filter((x) => x[0] !== "get").length === 0);
  d = await dump(page);
  t("reload: record kept, ams_calphoto still absent, other legacy byte-identical", JSON.parse(d["asa:ams:_migrated"]).keys.ams_calphoto.state === "retired" && !("ams_calphoto" in d) && d.ams_fav === JSON.stringify(["chun"]) && d.asa_trip === LEGACY_SEED.asa_trip);
  await page.goto(origin + "/__wp3_old__/amsterdam/?city=Amsterdam", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.isFav === "function");
  await page.waitForTimeout(150);
  t("rollback cost: pre-WP3 page shows no calendar photos after the retirement (documented)", await page.evaluate(() => !window.AsaStorage && Object.keys(calPhotos).length === 0));
  t("pre-WP3 page leaves asa:ams:calphoto untouched", (await dump(page))["asa:ams:calphoto"] === d["asa:ams:calphoto"]);
  await openCity(page, origin);
  t("roll-forward: all 11 photos back", (await photoCount(page)) === 11);
}, { needsOld: true });

sc("real quota ~55% photos + full storage: an add that still cannot fit after the move writes ams_calphoto back byte-identical; a delete then moves", async ({ page, origin, t, dialogs }) => {
  const { blob, marker0 } = await openPhotoUser(page, origin, t);
  await fillToFull(page);
  await addPhotoUI(page);
  t("add that cannot be stored: existing message", await waitDialog(page, dialogs, /Fotoğraf kaydedilemedi: cihaz depolaması dolu/), JSON.stringify(dialogs));
  t("add that cannot be stored: screen reverted", (await photoCount(page)) === 11);
  let d = await dump(page);
  t("legacy written back byte-identical; no partial new key", d.ams_calphoto === blob && !("asa:ams:calphoto" in d));
  t("marker rolled back byte-identical (no retirement claimed)", d["asa:ams:_migrated"] === marker0);
  const log = (await lsLog(page)).filter((x) => x[0] !== "get" && x[1] !== "wp3_fill").map((x) => x.join(" "));
  t("sequence: remove → record → retry → record rolled back → legacy restored", JSON.stringify(log.slice(-6)) === JSON.stringify(["set asa:ams:calphoto", "remove ams_calphoto", "set asa:ams:_migrated", "set asa:ams:calphoto", "set asa:ams:_migrated", "set ams_calphoto"]), JSON.stringify(log.slice(-8)));
  await page.evaluate((day) => { closeDay(); delPhoto(day, 0); }, PHOTO_DAY);
  d = await dump(page);
  t("delete in a full storage moves cleanly (smaller than the freed legacy)", dialogs.length === 1 && (await photoCount(page)) === 10 && !("ams_calphoto" in d) && JSON.parse(d["asa:ams:_migrated"]).keys.ams_calphoto.state === "retired", JSON.stringify(dialogs));
  await page.evaluate(() => localStorage.removeItem("wp3_fill"));
  await openCity(page, origin);
  t("reload: 10 photos, as the screen showed", (await photoCount(page)) === 10);
});

sc("forced failure between the legacy remove and the new write (~55%): ams_calphoto restored byte-identical, message, screen reverted; the next save moves cleanly", async ({ page, origin, t, dialogs }) => {
  const { blob, marker0 } = await openPhotoUser(page, origin, t);
  await page.evaluate((day) => delPhoto(day, 0), PHOTO_DAY);
  t("existing delete message", await waitDialog(page, dialogs, /Fotoğraf silme kaydedilemedi/), JSON.stringify(dialogs));
  t("screen reverted: 11 photos", (await photoCount(page)) === 11);
  const d = await dump(page);
  t("legacy restored byte-identical; no new key; marker byte-identical", d.ams_calphoto === blob && !("asa:ams:calphoto" in d) && d["asa:ams:_migrated"] === marker0);
  t("the failure really hit between remove and write", (await lsLog(page)).some((x) => x[0] === "forced" && x[1] === "asa:ams:calphoto"));
  await page.evaluate((day) => delPhoto(day, 0), PHOTO_DAY);
  t("next save moves cleanly", dialogs.length === 1 && (await photoCount(page)) === 10);
  await openCity(page, origin);
  const d2 = await dump(page);
  t("reload: 10 photos, legacy retired and recorded", (await photoCount(page)) === 10 && !("ams_calphoto" in d2) && JSON.parse(d2["asa:ams:_migrated"]).keys.ams_calphoto.state === "retired");
}, { armOnRemove: { key: "ams_calphoto", fail: ["asa:ams:calphoto"] } });

const restoreFailedFlow = (errorName) => async ({ page, origin, t, dialogs }) => {
  await openPhotoUser(page, origin, t);
  await page.evaluate((day) => delPhoto(day, 0), PHOTO_DAY);
  t("restore-failed message, not the 'unchanged' one", await waitDialog(page, dialogs, /eski fotoğraf kaydı geri yazılamadı/) && !dialogs.some((m) => /kayıtlı fotoğrafların değişmedi/.test(m)), JSON.stringify(dialogs));
  const forced = (await lsLog(page)).filter((x) => x[0] === "forced").map((x) => x.slice(1).join(" "));
  t(`both forced ${errorName}s hit: the retry and the restore`, JSON.stringify(forced) === JSON.stringify([`asa:ams:calphoto ${errorName}`, `ams_calphoto ${errorName}`]), JSON.stringify(forced));
  t("photos still in the tab", (await photoCount(page)) === 11);
  await page.evaluate((day) => delPhoto(day, 0), PHOTO_DAY);
  t("the advised next save stores them", dialogs.length === 1 && (await photoCount(page)) === 10);
  await openCity(page, origin);
  t("reload: 10 photos", (await photoCount(page)) === 10);
};
sc("forced failure of the write AND the restore: the page says so honestly (no 'unchanged' claim) and the photos stay in the tab until the next save", restoreFailedFlow("Error"), { armOnRemove: { key: "ams_calphoto", fail: ["asa:ams:calphoto", "ams_calphoto"] } });
sc("forced TypeError on the retry AND a failed restore (review LOW): still the honest restore-failed message, never 'unchanged'", restoreFailedFlow("TypeError"), { armOnRemove: { key: "ams_calphoto", fail: ["asa:ams:calphoto", "ams_calphoto"], error: "TypeError" } });

// Another tab of the same browser context (same localStorage), instrumented like `page`.
async function otherTab(ctx, errs, dialogs) {
  const p = await ctx.newPage();
  attach(p, errs);
  p.on("dialog", (dlg) => { dialogs.push(dlg.message()); dlg.dismiss().catch(() => {}); });
  return p;
}
sc("stale reader (review MEDIUM, ~55%, 3 tabs): legacy a pre-WP3 tab wrote after Tab A loaded is never retired by Tab A, even after another Amsterdam load re-recorded the marker", async ({ page, origin, t, dialogs, ctx }) => {
  const { blob } = await openPhotoUser(page, origin, t); // Tab A read L (11 photos)
  const errs = [], otherDialogs = [];
  const old = await otherTab(ctx, errs, otherDialogs);
  await old.goto(origin + "/__wp3_old__/amsterdam/?city=Amsterdam", { waitUntil: "load" });
  await old.waitForFunction(() => typeof window.addPhoto === "function" && typeof window.openDay === "function");
  await old.waitForTimeout(150);
  await addPhotoUI(old);
  await old.waitForFunction((day) => (calPhotos[day] || []).length === 12, PHOTO_DAY, { timeout: 5000 }).catch(() => {});
  const L2 = await old.evaluate(() => window.__WP3_RAW_GET("ams_calphoto"));
  t("pre-WP3 tab wrote ams_calphoto itself (its own add: 12 photos)", (await old.evaluate(() => !window.AsaStorage)) && !!L2 && L2 !== blob && JSON.parse(L2)[PHOTO_DAY].length === 12);
  const tabB = await otherTab(ctx, errs, otherDialogs);
  await openCity(tabB, origin); // another WP3 load reconciles
  const mB = JSON.parse((await dump(tabB))["asa:ams:_migrated"]).keys.ams_calphoto;
  t("second Amsterdam tab re-recorded the shared marker with the old tab's bytes", mB.state === "deferred" && mB.fp === fingerprint(L2), JSON.stringify(mB));
  await tabB.close();
  await old.close();
  await page.waitForFunction((n) => (window.__WP3_RAW_GET("ams_calphoto") || "").length === n, L2.length, { timeout: 5000 }).catch(() => {});
  await addPhotoUI(page); // Tab A still shows its 11 and adds one at quota
  t("Tab A: existing 'not saved; saved photos unchanged' message", await waitDialog(page, dialogs, /Fotoğraf kaydedilemedi: cihaz depolaması dolu/), JSON.stringify(dialogs));
  t("Tab A: screen reverted to its 11", (await photoCount(page)) === 11);
  const d = await dump(page);
  t("the old tab's photos kept byte-identical; no new key", d.ams_calphoto === L2 && !("asa:ams:calphoto" in d));
  t("Tab A removed nothing", (await removesOf(page)).length === 0, JSON.stringify(await removesOf(page)));
  const m = JSON.parse(d["asa:ams:_migrated"]).keys.ams_calphoto;
  t("no retirement claimed: marker still the second tab's record", m.state === "deferred" && m.fp === fingerprint(L2), JSON.stringify(m));
  await openCity(page, origin); // Tab A reloads: now it has read the old tab's bytes
  t("reload: the old tab's photo is shown (12)", (await photoCount(page)) === 12);
  await page.evaluate((day) => delPhoto(day, 0), PHOTO_DAY);
  const d2 = await dump(page);
  const e2 = JSON.parse(d2["asa:ams:_migrated"]).keys.ams_calphoto;
  t("after the reload the move works: delete saved, ams_calphoto retired with the old tab's fp", dialogs.length === 1 && (await photoCount(page)) === 11 && !("ams_calphoto" in d2) && e2.state === "retired" && e2.fp === fingerprint(L2), JSON.stringify([dialogs, e2]));
  t("other tabs: no dialogs, console/page errors = 0", otherDialogs.length === 0 && errs.length === 0, JSON.stringify([otherDialogs, errs.slice(0, 3)]));
}, { needsOld: true });

sc("real quota ~45% photos (review #2/#3): no duplicate at load; delete and add persist; a favorite refused by a full storage is undone with a message", async ({ page, origin, t, dialogs }) => {
  await seedStorage(page, origin, {});
  const Q = await measureQuota(page);
  const blob = photoBlob(Q, 9);
  await seedStorage(page, origin, { ams_calphoto: blob, asa_trip: LEGACY_SEED.asa_trip, ams_fav: JSON.stringify(["chun"]) });
  await openCity(page, origin);
  const used = await usedChars(page);
  t("no duplicate at load (free space not halved)", used < Q * 0.5, `used=${used} Q=${Q}`);
  t("9 photos shown", (await photoCount(page)) === 9);
  await page.evaluate(() => delPhoto("2026-11-02", 0));
  await page.evaluate(() => openDay("2026-11-02"));
  await page.setInputFiles("#dayPhotoInput", { name: "p.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => (calPhotos["2026-11-02"] || []).length === 9, null, { timeout: 5000 }).catch(() => {});
  t("no storage message for edits that fit", dialogs.length === 0, JSON.stringify(dialogs));
  t("edits that fit next to the kept legacy never remove it", (await removesOf(page)).length === 0);
  await openCity(page, origin);
  const after = await page.evaluate(() => { const l = calPhotos["2026-11-02"] || []; return { n: l.length, firstDeleted: !l.some((x) => x.endsWith("AAAA")), added: l.some((x) => x.startsWith("data:image/jpeg") && x.length < 5000) }; });
  t("reload: delete and add both persisted", after.n === 9 && after.firstDeleted && after.added, JSON.stringify(after));
  const d = await dump(page);
  t("legacy photos kept byte-identical", d.ams_calphoto === blob && JSON.parse(d["asa:ams:_migrated"]).keys.ams_calphoto.state === "superseded");
  await fillToFull(page);
  await page.evaluate(() => toggleFav("winkel43"));
  t("refused favorite: message", await waitDialog(page, dialogs, /Favorin kaydedilemedi/), JSON.stringify(dialogs));
  t("refused favorite: undone on screen", !(await page.evaluate(() => isFav("winkel43"))));
  await page.evaluate(() => localStorage.removeItem("wp3_fill"));
  await openCity(page, origin);
  t("reload: favorites as the screen showed", await page.evaluate(() => !isFav("winkel43") && isFav("chun")));
});

sc("library unavailable (404): fail-safe notice, no writes, no seed", async ({ page, origin, t }) => {
  await seedStorage(page, origin, { ams_fav: JSON.stringify(["chun"]) });
  const before = await dump(page);
  await openCity(page, origin);
  const n = await notice(page);
  t("unavailable notice", n.visible && /yüklenemedi/.test(n.text));
  await page.evaluate(() => toggleFav("barpif"));
  t("storage unchanged", JSON.stringify(await dump(page)) === JSON.stringify(before));
}, { libMissing: true, expectConsole: /asa_storage\.js|404/ });

sc("rollback: pre-WP3 page still finds its data after migration; new edits survive roll-forward", async ({ page, origin, t }) => {
  await seedStorage(page, origin, LEGACY_SEED);
  await openCity(page, origin);
  await page.evaluate(() => { toggleFav("winkel43"); });
  const migrated = await dump(page);
  await page.goto(origin + "/__wp3_old__/amsterdam/?city=Amsterdam", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.isFav === "function");
  await page.waitForTimeout(150);
  const old = await page.evaluate(() => ({ chun: isFav("chun"), barpif: isFav("barpif"), w: isFav("winkel43"), note: calNotes["2026-11-02"], cal0: CAL.days[0].key, hasLib: !!window.AsaStorage }));
  t("old page is the pre-WP3 code", old.hasLib === false);
  t("old page reads legacy favorites/notes/trip", old.chun && old.barpif && old.note === "Müze kartı al" && old.cal0 === "2026-11-02", JSON.stringify(old));
  t("post-migration edit not visible to old page (expected, documented)", old.w === false);
  const afterOld = await dump(page);
  t("old page left asa:ams:* untouched", Object.keys(migrated).filter((k) => k.startsWith("asa:ams:")).every((k) => afterOld[k] === migrated[k]));
  await openCity(page, origin);
  t("roll-forward: new edit back", await page.evaluate(() => isFav("winkel43") && isFav("chun")));
}, { needsOld: true });

/* ---------- runner ---------- */
const { proc, origin } = await startServer();
let oldHtml = null;
try { oldHtml = oldAmsterdamPage(); } catch (e) { console.log("NOTE cannot read " + BASE_REF + ":amsterdam/index.html (" + String(e.message).split("\n")[0] + ")"); }
const browser = await chromium.launch(process.env.WP3_CHROMIUM ? { executablePath: process.env.WP3_CHROMIUM } : {});
try {
  for (const vp of WANT_VP) {
    for (const s of scenarios) {
      if (ONLY && !s.name.includes(ONLY)) continue;
      const label = `[${vp}] ${s.name}`;
      if (s.opts.needsOld && !oldHtml) { ok(label + " :: base page available", false, "git show " + BASE_REF + " failed"); continue; }
      const ctx = await newContext(browser, origin, vp, { supa: s.opts.supa, libMissing: s.opts.libMissing, failSet: s.opts.failSet, armOnRemove: s.opts.armOnRemove, oldPage: s.opts.needsOld ? oldHtml : null });
      const page = await ctx.newPage();
      const errs = [];
      attach(page, errs);
      const dialogs = [];
      page.on("dialog", (dlg) => { dialogs.push(dlg.message()); dlg.dismiss().catch(() => {}); });
      const t = (n, c, d) => ok(label + " :: " + n, c, d);
      try { await s.fn({ page, origin, vp, t, dialogs, ctx }); }
      catch (e) { t("scenario completed", false, String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
      const pageErrs = errs.filter((e) => !(s.opts.expectConsole && s.opts.expectConsole.test(e.text + " " + (e.url || ""))));
      for (const e of errs) if (!pageErrs.includes(e)) consoleNoise.push(label + " (expected) " + e.kind + ": " + e.text.slice(0, 160));
      t("console/page errors = 0", pageErrs.length === 0, JSON.stringify(pageErrs.slice(0, 4)));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  proc.kill();
}
console.log("--- third-party requests (all answered by stubs) ---");
for (const [k, v] of [...thirdParty.entries()].sort()) console.log(`  ${v}x ${k}`);
console.log("--- expected console messages ---");
for (const n of consoleNoise) console.log("  " + n);
console.log(`WP3_E2E checks pass=${passes} fail=${fails}`);
console.log(fails ? "WP3_E2E_FAIL" : "WP3_E2E_PASS");
process.exit(fails ? 1 : 0);
