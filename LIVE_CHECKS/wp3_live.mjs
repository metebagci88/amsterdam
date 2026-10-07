// ASALOCAL · WP3 LIVE CHECK — city-scoped browser storage on the real site (real CDNs).
//
// Anonymous, no server writes: every scenario runs in a fresh browser context and only
// touches that context's localStorage on https://www.asalocal.club. Skips itself (exit 0,
// verdict SKIP) when production (origin/main) does not ship the wired library yet.
//
// Usage: node LIVE_CHECKS/wp3_live.mjs   (needs playwright; GitHub Actions installs it)

import { execFileSync } from "node:child_process";

const BASE = (process.env.ASALOCAL_BASE_URL || "https://www.asalocal.club").replace(/\/+$/, "");
const out = [];
const rec = (id, pass, detail = "") => out.push({ id, result: pass === null ? "SKIP" : pass ? "PASS" : "FAIL", detail: String(detail).slice(0, 200) });

function mainShipsWp3() {
  try {
    const html = execFileSync("git", ["show", "origin/main:amsterdam/index.html"], { maxBuffer: 64 << 20 }).toString("utf8");
    return /asa_storage\.js\?v=[0-9a-f]+/.test(html);
  } catch { return null; }
}

const LEGACY = {
  ams_fav: JSON.stringify(["barpif", "chun"]),
  ams_cal: JSON.stringify({ "2026-11-02": "Müze kartı al" }),
  ams_plan: JSON.stringify({ "2026-11-02": "Sabah: kahve" }),
  ams_dayven: JSON.stringify({ "2026-11-02": ["barpif"] }),
  asa_trip: JSON.stringify({ country: "Hollanda", city: "Amsterdam", duration_days: 4, start_date: "2026-11-02", end_date: "2026-11-05", vacation_types: ["Gastronomi"] }),
};
const MAP = { ams_fav: "fav", ams_cal: "cal", ams_plan: "plan", ams_dayven: "dayven", asa_trip: "trip" };

async function run() {
  const ships = mainShipsWp3();
  if (ships !== true) {
    rec("wp3 shipped on origin/main", null, ships === null ? "origin/main not available" : "main does not load asa_storage.js yet");
    return finish();
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const dump = (page) => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
  const notice = (page) => page.evaluate(() => { const el = document.getElementById("asaStoreNotice"); return el ? { visible: !el.classList.contains("hide") && el.offsetParent !== null, text: el.textContent || "" } : null; });
  async function ctxFor(vp) {
    const ctx = await browser.newContext(vp === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(`pageerror: ${String(e.message).slice(0, 120)}`));
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 120)); });
    return { ctx, page, errs };
  }
  async function seed(page, data) {
    await page.goto(`${BASE}/kopenhag/`, { waitUntil: "domcontentloaded" });
    await page.evaluate((d) => { localStorage.clear(); for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); }, data);
  }
  async function openAms(page) {
    await page.goto(`${BASE}/amsterdam/?city=Amsterdam`, { waitUntil: "load", timeout: 45000 });
    await page.waitForFunction(() => window.ASA_ST && typeof window.toggleFav === "function", null, { timeout: 20000 });
    await page.waitForTimeout(400);
  }

  // library is served and pinned
  {
    const html = await (await fetch(`${BASE}/amsterdam/?cb=${Date.now()}`)).text();
    const m = html.match(/src="([^"]*asa_storage\.js\?v=([0-9a-f]+))"/);
    rec("live amsterdam page references pinned asa_storage.js", !!m, m ? m[1] : "no script tag");
    if (m) { const r = await fetch(new URL(m[1], `${BASE}/amsterdam/`)); rec("asa_storage.js served 200", r.status === 200, `http=${r.status}`); }
  }

  for (const vp of ["desktop", "mobile"]) {
    // 1) fresh user
    { const { ctx, page, errs } = await ctxFor(vp);
      await seed(page, {}); await openAms(page);
      const d = await dump(page);
      const m = JSON.parse(d["asa:ams:_migrated"] || "null");
      rec(`${vp} fresh: marker v1 written`, !!m && m.v === 1, JSON.stringify(m || {}).slice(0, 80));
      rec(`${vp} fresh: no legacy keys created`, Object.keys(LEGACY).every((k) => !(k in d)));
      rec(`${vp} fresh: notice hidden`, !(await notice(page))?.visible);
      rec(`${vp} fresh: console errors 0`, errs.length === 0, errs.join(" | "));
      await ctx.close(); }
    // 2) legacy-only user: migrated once, legacy kept, reload idempotent
    { const { ctx, page, errs } = await ctxFor(vp);
      await seed(page, LEGACY); await openAms(page);
      const d1 = await dump(page);
      for (const [k, dom] of Object.entries(MAP)) {
        rec(`${vp} legacy: ${k} -> asa:ams:${dom} byte-identical`, d1[`asa:ams:${dom}`] === LEGACY[k]);
        rec(`${vp} legacy: ${k} kept`, d1[k] === LEGACY[k]);
      }
      const ui = await page.evaluate(() => ({ chun: typeof isFav === "function" && isFav("chun"), barpif: typeof isFav === "function" && isFav("barpif") }));
      rec(`${vp} legacy: favorites visible in UI`, ui.chun && ui.barpif, JSON.stringify(ui));
      await openAms(page);
      const d2 = await dump(page);
      rec(`${vp} legacy: reload byte-identical (no duplication)`, JSON.stringify(d2) === JSON.stringify(d1));
      rec(`${vp} legacy: notice hidden`, !(await notice(page))?.visible);
      rec(`${vp} legacy: console errors 0`, errs.length === 0, errs.join(" | "));
      await ctx.close(); }
    // 3) conflict: new authoritative, notice visible, nothing overwritten
    { const { ctx, page } = await ctxFor(vp);
      await seed(page, { ams_fav: JSON.stringify(["barpif"]), "asa:ams:fav": JSON.stringify(["chun"]) }); await openAms(page);
      const n = await notice(page); const d = await dump(page);
      rec(`${vp} conflict: notice visible`, !!n && n.visible, (n?.text || "").slice(0, 80));
      rec(`${vp} conflict: new kept + legacy kept`, d["asa:ams:fav"] === JSON.stringify(["chun"]) && d.ams_fav === JSON.stringify(["barpif"]));
      const ui = await page.evaluate(() => ({ chun: isFav("chun"), barpif: isFav("barpif") }));
      rec(`${vp} conflict: UI uses new value`, ui.chun && !ui.barpif, JSON.stringify(ui));
      if (vp === "mobile") rec(`${vp} conflict: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await ctx.close(); }
    // 4) wrong-city legacy trip: fail-safe notice, not shown as Amsterdam plan
    { const { ctx, page } = await ctxFor(vp);
      await seed(page, { asa_trip: JSON.stringify({ country: "Danimarka", city: "Kopenhag", duration_days: 3, start_date: "2026-12-01", end_date: "2026-12-03" }) }); await openAms(page);
      const n = await notice(page); const d = await dump(page);
      rec(`${vp} wrong-city: notice visible`, !!n && n.visible, (n?.text || "").slice(0, 80));
      rec(`${vp} wrong-city: not copied into asa:ams:trip`, !("asa:ams:trip" in d));
      await ctx.close(); }
    // 5) Kopenhag stub never writes asa:ams:* nor migrates
    { const { ctx, page, errs } = await ctxFor(vp);
      await seed(page, LEGACY);
      await page.goto(`${BASE}/kopenhag/`, { waitUntil: "load" }); await page.waitForTimeout(300);
      const d = await dump(page);
      rec(`${vp} kopenhag: no asa:* keys written`, Object.keys(d).every((k) => !k.startsWith("asa:")));
      rec(`${vp} kopenhag: legacy untouched`, Object.entries(LEGACY).every(([k, v]) => d[k] === v));
      rec(`${vp} kopenhag: console errors 0`, errs.length === 0, errs.join(" | "));
      await ctx.close(); }
  }
  await browser.close();
  return finish();
}

function finish() {
  const fail = out.filter((r) => r.result === "FAIL").length;
  const skip = out.filter((r) => r.result === "SKIP").length;
  const verdict = fail ? "FAIL" : out.length === skip ? "SKIP" : "PASS";
  console.log("WP3_LIVE_SUMMARY " + JSON.stringify({ base: BASE, total: out.length, pass: out.length - fail - skip, fail, skip, verdict }));
  for (const r of out) console.log(`${r.result.padEnd(4)} ${r.id} :: ${r.detail}`);
  process.exit(fail ? 1 : 0);
}

await run();
