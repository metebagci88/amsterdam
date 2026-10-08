// WP7 · PUBLIC LEAK GATE — internal / admin / legacy wording must not reach a public visitor.
// Local only: serves a checkout with python3 http.server; EVERY non-local request is answered by a stub (supabase-js →
// WP5 test stub, Leaflet → WP3 stub, Tailwind/fonts/images → empty). Never contacts production; prints no secrets.
//
//   NODE_PATH=<playwright@1.56.1> PLAYWRIGHT_BROWSERS_PATH=<chromium> node scripts/public_leak_gate.mjs [--root DIR] [--quick] [--selftest]
//
// Runs: {anon, member} × {1280, 390} × {embedded data, stub-DB sentinel rows}. Surfaces per run: /, /kopenhag/, /amsterdam/,
// /amsterdam/?city=Amsterdam (whole body incl. HIDDEN views), every view, the Listem chip view, cardHtml + venue modal +
// map popup for EVERY venue, the day modal, the decision engine 7 modes × 5 times, every member segment, notices, dialogs,
// the sync pill, <title>/meta/og. Extraction: a clone of the element minus script/style/noscript/template/.msym, plus
// title/aria-label/placeholder/alt attributes (option texts are part of the clone) — NOT innerText. Text is NFC and is
// scanned twice (toLocaleLowerCase('tr') and toLowerCase()).
// Families: F1 internal (anywhere; render artefacts like 'undefined' only in rendered text) · F2 admin vocabulary (anywhere) · F3 escaped markup shown as text · F4 legacy list words,
// only inside the Listem / own-note feature selectors (F4_SCOPE). Positive assertions for the new labels and behaviour.
// Raw bytes of /, /amsterdam/, /kopenhag/: F1 + F2 must be 0; the only tolerated raw F2 hits are the 6 embedded fallback
// tips pinned in RAW_TIP_EXEMPT (tip data is not edited without the owner; publicNote rewrites them on screen, which the
// rendered scan proves). Any other raw hit, or a changed pinned tip, fails.
// --selftest: mutates a temporary copy of the served files (one mutation at a time) and requires every mutation to FAIL
// and the unmutated copy to PASS.
// Output: one line per hit (≤40 chars of context, e-mails masked). Exit 0 PUBLIC_LEAK_GATE_PASS · 1 FAIL · 4 INCOMPLETE.
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, cpSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import net from "node:net";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ROOT = opt("--root") || REPO;
const QUICK = argv.includes("--quick");
const SELFTEST = argv.includes("--selftest");

/* ---------------- patterns ---------------- */
const F1 = [/veri not(u|ları)/, /whatsapp/, /whisper/, /huggingface/, /file:\/\//, /\/home\//, /\/users\//, /\/tmp\//, /\b[a-z]:\\/,
  /\.(md|sql|mjs)\b/, /wp\d_package/, /live_checks/, /senin notun/, /senin verdiğin/, /önceki araştırma(m|ndan)/, /\bek araştırma/,
  /araştırma ile eklendi/, /araştırmada bazı/, /\(araştırma:/, /ses kaydı/, /benim listem/, /11[–-]31 temmuz/];
// Render artefacts: meaningful only in rendered text (served JS legitimately contains e.g. typeof x!=="undefined").
const F1_RENDER = [/\btodo\b/, /\bfixme\b/, /\blorem\b/, /\bundefined\b/, /\[object object\]/];
const F2 = [/araştırma notu/, /sesli not/, /teyit et/, /yayına hazır/, /kaynak gerekli/, /kontrol et/, /kontrol edilmeli/, /editör notu/];
const F3 = [/<\/?(b|i|br|span)\b/, /&lt;/, /&amp;(lt|gt|amp|quot);/];
const F4 = [/favori/, /kayıtlı(?! seyahat)/, /beğeniler/, /kişisel not/, /takvim notları/, /gün planı notları/, /kaydettik/, /🤍\s*kaydet\b/];
// The Listem (heart) feature and the user's own notes: legacy list words are checked only here (venue descriptions and the
// editorial scenarios may legitimately say "favori").
const F4_SCOPE = ["#chips", "#ctaGrid", "#v-map .legend", "#v-map > .section-sub", "#v-cal > .section-sub", "#v-member > .section-sub",
  "#cards > .note", "#cards .gate", "#cards [aria-pressed]", "#vFav", "#venueBody .vlogin", "#deOut .dewhy", "#deOut button",
  "#memberBody", "#dayBody .font-kicker", "#dayBody button", "#dayNoteStatus", "#tripSyncPill"];
// (#asaStoreNotice is F1/F2/F3-scanned; its storage names — "Listem", "Kendi notların", "Plan notların" — are pinned by WP3 e2e.)
// Embedded fallback tips that still carry an editorial to-do in the served bytes (pinned by venue id + sha256 of the tip).
const RAW_TIP_EXEMPT = {
  shiraz: "4b412ff6b617442d0bd39395988be2aa7e56ae241c700d0159d75fdce5481636",
  cheznina: "0ea74ac77457de3d06c604943936ca5ec425c82434a18be12db5c590ca79b7a2",
  escobar: "0fea3479fc9666468848b5d76842838420da8b39413ec95fb627928ebcf53115",
  barracuda: "b986bd92a04e14880303937473ffbf2ebb1439fa8470c69bd606ce363f13a577",
  fabus: "ad7ede9dece039d4532072b013254cfb5b275e4558ca9bd2cfc14bb6a30641b4",
  september: "10ef9214f3a137e39dc6baa4fb145c028cfacf850de84508982b51563f5c1d78",
};
const NOTE_TOKEN = "note_sentinel_7f3a";   // put into EVERY stub-DB note; must never be rendered

const mask = (s) => String(s).replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, "<email>").replace(/\s+/g, " ");
const hits = [], fails = [], passes = [];
function scan(fam, rxs, run, surface, text) {
  const t = String(text || "").normalize("NFC");
  const seen = new Set();
  for (const low of [t.toLocaleLowerCase("tr"), t.toLowerCase()]) {
    for (const rx of rxs) {
      const g = new RegExp(rx.source, "gu"); let m;
      while ((m = g.exec(low))) {
        const ctx = low.slice(Math.max(0, m.index - 16), m.index + m[0].length + 16);
        const key = rx.source + "|" + m.index + "|" + low.length;
        const k2 = rx.source + "|" + ctx;
        if (seen.has(key) || seen.has(k2)) continue; seen.add(key); seen.add(k2);
        hits.push(`HIT ${fam} ${run} ${surface} "${m[0]}" …${mask(ctx).slice(0, 40)}…`);
        if (m[0] === "") g.lastIndex++;
      }
    }
  }
}
const check = (name, ok, detail = "") => { (ok ? passes : fails).push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + mask(detail).slice(0, 160) : ""}`); };

/* ---------------- self-test: every mutation must FAIL ---------------- */
if (SELFTEST) {
  const FILES = ["index.html", "amsterdam", "kopenhag", "lib", "CNAME", "_redirects"];
  const MUT = [
    ["(none) unmutated copy passes", null, 0],
    ["M1 raw F1: an internal note value is embedded again", (s) => s.replace('note:""', 'note:"<b>Senin notun:</b> selftest"'), 1],
    // M2 is injected at run time with a split literal, so only the rendered scan of the HIDDEN map view can see it.
    ["M2 hidden view F1 (DOM only): 'Benim listem' option added to #mapSrc at run time", (s) => s.replace('function srcGroup(s){', 'try{document.getElementById("mapSrc").insertAdjacentHTML("beforeend",\'<option value="u">Ben\'+\'im listem</option>\');}catch(e){}\nfunction srcGroup(s){'), 1],
    ["M3 F2: publicNote no longer rewrites editorial to-dos", (s) => s.replace('function publicNote(t){\n let x=String(t==null?"":t);', 'function publicNote(t){ return String(t==null?"":t);\n let x="";'), 1],
    ["M4 F4: legacy chip label '❤️ Favori'", (s) => s.replace('{k:"fav",l:"❤️ Listem",cls:"fav"}', '{k:"fav",l:"❤️ Favori",cls:"fav"}'), 1],
    ["M5 positive: heart button loses its accessible name", (s) => s.replace('aria-label="Listeme ekle" aria-pressed=', 'aria-pressed='), 1],
    ["M6 positive: the editor's picks are seeded into a fresh list", (s) => s.replace("  // kullanıcı kalbe dokunana kadar asa:ams:fav yazılmaz (eski kayıtlar okunur, silinmez).\n})();", "  V.forEach(function(v){ if(v&&v.fav) favSet.add(v.id); }); ASA_ST.set(\"fav\",[...favSet]);\n})();"), 1],
    ["M7 venues.note rendered again (tip||note fallback)", (s) => s.replace("const km=distKm(v);const noteTxt=publicNote(v.tip||'');", "const km=distKm(v);const noteTxt=publicNote(v.tip||v.note||'');"), 1],
    ["M8 'Notun kaydedildi' shown although the device write failed", (s) => s.replace("local=saveLS(\"cal\",calNotes,true)===true;", "saveLS(\"cal\",calNotes,true); local=true;"), 1],
  ];
  let bad = 0;
  for (const [name, fn, want] of MUT) {
    const dir = mkdtempSync(join(tmpdir(), "leakgate-"));
    try {
      for (const f of FILES) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
      if (fn) {
        const p = join(dir, "amsterdam/index.html"), s = readFileSync(p, "utf8"), m = fn(s);
        if (m === s) { console.log(`SELFTEST_BROKEN ${name}: mutation did not apply`); bad++; continue; }
        writeFileSync(p, m);
      }
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--root", dir, "--quick"], { encoding: "utf8", env: process.env, timeout: 600000 });
      const got = r.status === 0 ? 0 : r.status === 1 ? 1 : r.status;
      const why = (r.stdout || "").split("\n").filter((l) => /^(HIT|FAIL) /.test(l)).slice(0, 2).join(" | ");
      if (got === want) console.log(`SELFTEST_OK ${name} -> ${got ? "FAIL (expected)" : "PASS"}${why ? " :: " + why.slice(0, 220) : ""}`);
      else { bad++; console.log(`SELFTEST_WRONG ${name} -> exit ${r.status} (wanted ${want}) ${(r.stdout || "").split("\n").slice(-3).join(" ")} ${(r.stderr || "").slice(0, 300)}`); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(bad ? "PUBLIC_LEAK_GATE_SELFTEST_FAIL" : "PUBLIC_LEAK_GATE_SELFTEST_PASS");
  process.exit(bad ? 1 : 0);
}

/* ---------------- deps ---------------- */
let chromium;
try { ({ chromium } = createRequire(import.meta.url)("playwright")); }
catch (e) { console.log("MISSING_DEP playwright (NODE_PATH)"); console.log("PUBLIC_LEAK_GATE_INCOMPLETE"); process.exit(4); }
const SUPA_STUB = readFileSync(join(REPO, "WP5_package/web/tests/stubs/supabase_stub.js"), "utf8");
const LEAFLET_STUB = readFileSync(join(REPO, "WP3_package/tests/stubs/leaflet_stub.js"), "utf8");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/* ---------------- static: retired / blocked paths ---------------- */
{
  const red = existsSync(join(ROOT, "_redirects")) ? readFileSync(join(ROOT, "_redirects"), "utf8") : "";
  check("legacy personal page deleted", !existsSync(join(ROOT, "amsterdam_index_UID.html")));
  check("_redirects: /amsterdam_index_UID.html → /amsterdam/ 301", /^\/amsterdam_index_UID\.html\s+\/amsterdam\/\s+301$/m.test(red));
  for (const p of ["/CDP3D_package/*", "/CDP3C_package/*", "/LIVE_CHECKS/*", "/scripts/*", "/WP7_package/*", "/CDP3B/admin_email_module.html"])
    check(`_redirects: ${p} → / 302 (never 200)`, new RegExp("^" + p.replace(/[.*]/g, (c) => "\\" + c) + "\\s+/\\s+302$", "m").test(red));
}

/* ---------------- data for the stub-DB run ---------------- */
function embeddedVenues() {
  const src = readFileSync(join(ROOT, "amsterdam/index.html"), "utf8");
  const a = src.indexOf("let V=["), b = src.indexOf("\nconst TRIPS={};", a);
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(a, b).replace("let V=", "var V="), ctx);
  return JSON.parse(JSON.stringify(ctx.V));
}
function dbRows() {
  return embeddedVenues().map((v, i) => ({
    id: v.id, name: v.name, city: v.city || "Amsterdam", area: v.area, type: v.type, tags: v.tags || [], cats: v.cats || [], best: v.best || [],
    hours: v.hours, garden: !!v.garden, description: v.desc || null,
    tip: i === 0 ? "" : i === 1 ? "Gate tüyosu; adresini kontrol et." : i === 2 ? "<b>Kalın</b> tüyo · Teyit et." : (v.tip || null),
    note: `<b>Senin notun:</b> ${NOTE_TOKEN} (Önceki araştırmandan) WhatsApp ses kaydı. ❤️ Favori.`,
    src: i === 1 ? null : i === 2 ? "audio" : i === 3 ? "zz_unknown" : v.src, resv: i === 3 ? null : v.resv,
    walk_in: !!v.walkIn, work: !!v.work, lat: v.lat, lng: v.lng, conf: i === 2 ? "medium" : v.conf, web: v.web || null, ig: v.ig || null,
    sponsored: false, active: true, temporarily_closed: false, closed_until: null, photo_url: null,
  }));
}

/* ---------------- server + browser ---------------- */
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function serve() {
  const port = await freePort();
  const proc = spawn("python3", ["-I", "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", ROOT], { stdio: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + "/CNAME")).ok) return { proc, origin }; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  proc.kill(); console.log("MISSING_DEP python3 http.server did not start"); console.log("PUBLIC_LEAK_GATE_INCOMPLETE"); process.exit(4);
}
const UID = "00000000-0000-4000-8000-0000000000a7", TRIP_ID = "00000000-0000-4000-8000-00000000c0de";
async function newCtx(browser, origin, width, supa) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, geolocation: { latitude: 52.3676, longitude: 4.8897 }, permissions: ["geolocation"], serviceWorkers: "block" });
  const offsite = [];
  await ctx.route("**/*", (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin === origin) return u.pathname === "/favicon.ico" ? route.fulfill({ status: 204, body: "" }) : route.continue();
    offsite.push(u.host);
    if (u.host === "cdn.tailwindcss.com") return route.fulfill({ status: 200, contentType: "application/javascript", body: "window.tailwind={config:{}};" });
    if (u.host === "unpkg.com" && u.pathname.includes("leaflet")) return route.fulfill({ status: 200, contentType: u.pathname.endsWith(".css") ? "text/css" : "application/javascript", body: u.pathname.endsWith(".css") ? "" : LEAFLET_STUB });
    if (u.host === "cdn.jsdelivr.net" && u.pathname.includes("supabase-js")) return route.fulfill({ status: 200, contentType: "application/javascript", body: SUPA_STUB });
    const rt = req.resourceType();
    if (rt === "stylesheet") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (rt === "script") return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    if (rt === "image") return route.fulfill({ status: 200, contentType: "image/gif", body: GIF });
    return route.fulfill({ status: 204, body: "" });
  });
  await ctx.addInitScript((c) => { window.__WP5_SUPA = c; }, supa);
  return ctx;
}

// in-page extraction (clone, not innerText; hidden views included)
const SNAP = (sel) => {
  const roots = sel ? [...document.querySelectorAll(sel)] : [document.body];
  let out = "";
  for (const root of roots) {
    const c = root.cloneNode(true);
    c.querySelectorAll("script,style,noscript,template,.msym").forEach((n) => n.remove());
    out += c.textContent + "\n";
    for (const e of [root, ...root.querySelectorAll("*")]) {
      if (e.closest && e.closest("script,style,noscript,template")) continue;
      for (const a of ["title", "aria-label", "placeholder", "alt"]) { const v = e.getAttribute && e.getAttribute(a); if (v) out += v + "\n"; }
    }
  }
  if (!sel) {
    out += document.title + "\n";
    for (const m of document.querySelectorAll('meta[name="description"],meta[property^="og:"],meta[name^="twitter:"]')) out += (m.getAttribute("content") || "") + "\n";
  }
  return out;
};

async function cityWalk(page, origin, run, member, db, S, F4S) {
  const url = origin + "/amsterdam/?city=Amsterdam" + (member ? "&trip=" + TRIP_ID : "");
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.ASA && window.ASA_ST && typeof setActiveView === "function", null, { timeout: 20000 });
  if (member) await page.waitForFunction(() => !!(window.ASA && window.ASA.session), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);
  // fresh visitor: no pre-filled list
  const fresh = await page.evaluate(() => ({ raw: localStorage.getItem("asa:ams:fav"), n: V.filter((v) => isFav(v.id)).length }));
  check(`${run}: fresh visitor's asa:ams:fav is empty (no seeded picks)`, (fresh.raw === null || fresh.raw === "[]") && fresh.n === 0, `raw=${fresh.raw} n=${fresh.n}`);
  if (db) {
    const loaded = await page.evaluate((tok) => V.filter((v) => String(v.note || "").toLowerCase().includes(tok)).length, NOTE_TOKEN);
    check(`${run}: stub-DB sentinel rows are loaded into the page (run is not vacuous)`, loaded > 50, `rows with sentinel note=${loaded}`);
  }
  S["page:/amsterdam/?city=Amsterdam (load)"] = await page.evaluate(SNAP, null);
  for (const v of ["pano", "map", "list", "cal", "de", "member"]) {
    await page.evaluate((x) => setActiveView(x), v);
    await page.waitForTimeout(v === "de" || v === "cal" || v === "member" ? 900 : 350);
    S["view:" + v] = await page.evaluate(SNAP, "#v-" + v);
  }
  // decision engine: 7 modes × 5 times
  S["de:7x5"] = await page.evaluate(async () => {
    let t = ""; const modes = ["Çalışmak", "Kahve", "Yemek", "İçki", "Yürüyüş", "Park", "Alışveriş"], times = ["Sabah", "Öğlen", "Öğleden sonra", "Akşam", "Gece"];
    if (!deLoc) deLoc = { lat: 52.3676, lng: 4.8897 };
    for (const m of modes) for (const tm of times) { try { deSel.mode = m; deSel.time = tm; runDE(); } catch (e) {} const o = document.getElementById("deOut"); if (o) { const c = o.cloneNode(true); c.querySelectorAll(".msym").forEach((n) => n.remove()); t += c.textContent + "\n" + [...o.querySelectorAll("[title],[aria-label]")].map((e) => (e.getAttribute("title") || "") + " " + (e.getAttribute("aria-label") || "")).join(" ") + "\n"; } }
    return t;
  });
  F4S["de:why+buttons"] = await page.evaluate(SNAP, "#deOut .dewhy, #deOut button");
  // list: Listem chip (empty state), then add two venues with the heart button
  await page.evaluate(() => setActiveView("list"));
  await page.evaluate(() => setOnlyChip("fav"));
  const emptyTxt = await page.evaluate(() => document.getElementById("cards").textContent);
  check(`${run}: Listem chip view, empty state`, /Listen henüz boş/.test(emptyTxt), emptyTxt.slice(0, 80));
  F4S["list:favChip(empty)"] = await page.evaluate(SNAP, "#cards > .note, #chips");
  await page.evaluate(() => { activeChips = new Set(); applyFilters(); });
  const heart = await page.evaluate(() => {
    const bs = [...document.querySelectorAll("#cards [data-venue-id] button[aria-pressed]")];
    const all = [...document.querySelectorAll("#cards [data-venue-id]")].length;
    const ok = bs.length === all && bs.length > 0 && bs.every((b) => b.getAttribute("aria-label") === "Listeme ekle" && b.getAttribute("aria-pressed") === "false" && b.querySelector('.msym[aria-hidden="true"]'));
    return { n: bs.length, all, ok };
  });
  check(`${run}: every card heart has aria-label "Listeme ekle" + aria-pressed=false + aria-hidden icon`, heart.ok, JSON.stringify(heart));
  for (let i = 0; i < 2; i++) await page.locator("#cards [data-venue-id] button[aria-pressed='false']").first().click();
  const after = await page.evaluate(() => ({ pressed: document.querySelectorAll("#cards button[aria-pressed='true']").length, n: V.filter((v) => isFav(v.id)).length, raw: localStorage.getItem("asa:ams:fav") }));
  check(`${run}: heart click → aria-pressed=true and the venue is in Listem`, after.pressed === 2 && after.n === 2 && JSON.parse(after.raw || "[]").length === 2, JSON.stringify(after));
  await page.evaluate(() => setOnlyChip("fav"));
  S["list:favChip(2)"] = await page.evaluate(SNAP, "#v-list");
  F4S["list:favChip(2)"] = await page.evaluate(SNAP, "#cards > .note, #cards .gate, #cards [aria-pressed], #chips");
  if (!member) check(`${run}: anon Listem note`, /Listen bu cihazda/.test(S["list:favChip(2)"]));
  await page.evaluate(() => { activeChips = new Set(); applyFilters(); });
  const chipCta = await page.evaluate(() => ({ chip: [...document.querySelectorAll("#chips .chip")].some((c) => c.dataset.k === "fav" && c.textContent.trim() === "❤️ Listem"),
    cta: /Listem/.test(document.getElementById("ctaGrid").textContent), legend: /Listem/.test(document.querySelector("#v-map .legend").textContent) }));
  check(`${run}: '❤️ Listem' chip, 'Listem' CTA and legend present`, chipCta.chip && chipCta.cta && chipCta.legend, JSON.stringify(chipCta));
  S["list:paywall/notes"] = await page.evaluate(SNAP, "#v-list");
  // every venue: card (no gate), venue modal, map popup
  S["cards:all"] = await page.evaluate(() => { const d = document.createElement("div"); let t = ""; for (const v of V.filter((x) => x.city === CITY)) { try { d.innerHTML = cardHtml(v); d.querySelectorAll(".msym").forEach((n) => n.remove()); t += d.textContent + " " + [...d.querySelectorAll("[aria-label],[title],[alt]")].map((e) => (e.getAttribute("aria-label") || "") + " " + (e.getAttribute("title") || "") + " " + (e.getAttribute("alt") || "")).join(" ") + "\n"; } catch (e) { t += "[cardHtml threw " + e.message + "]\n"; } } return t; });
  S["popup:all"] = await page.evaluate(() => { const d = document.createElement("div"); let t = ""; for (const v of V.filter((x) => x.city === CITY)) { try { d.innerHTML = popupHtml(v); t += d.textContent + "\n"; } catch (e) { t += "[popupHtml threw " + e.message + "]\n"; } } return t; });
  const vm = await page.evaluate(async () => { let t = "", f4 = "", toggles = 0, n = 0; for (const v of V.filter((x) => x.city === CITY)) { try { VEN.open(v.id); n++; const b = document.getElementById("venueBody"); const c = b.cloneNode(true); c.querySelectorAll(".msym").forEach((x) => x.remove()); t += c.textContent + " " + [...b.querySelectorAll("[placeholder],[title],[aria-label],[alt]")].map((e) => (e.getAttribute("placeholder") || "") + " " + (e.getAttribute("title") || "") + " " + (e.getAttribute("aria-label") || "")).join(" ") + "\n"; const fb = document.getElementById("vFav"); if (fb) { f4 += fb.textContent + "\n"; if (fb.textContent === (isFav(v.id) ? "❤️ Listemde" : "🤍 Listeme ekle")) toggles++; } VEN.close(); } catch (e) { t += "[VEN.open threw " + e.message + "]\n"; } } return { t, f4, toggles, n }; });
  S["venueModal:all"] = vm.t; F4S["venueModal:vFav"] = vm.f4;
  check(`${run}: venue modal list toggle reads '🤍 Listeme ekle' / '❤️ Listemde' for every venue`, vm.n > 0 && vm.toggles === vm.n, `${vm.toggles}/${vm.n}`);
  if (db) {
    const s1 = await page.evaluate(() => { const v = V[1]; const d = document.createElement("div"); d.innerHTML = cardHtml(v); VEN.open(v.id); const m = document.getElementById("venueBody").textContent; VEN.close(); return d.textContent + " || " + m; });
    check(`${run}: a DB tip with 'kontrol et' renders in reader wording`, /adres bilgisi henüz doğrulanmadı/.test(s1) && !/kontrol et/i.test(s1), s1.slice(0, 120));
    const s2 = await page.evaluate(() => [1, 2, 3].map((i) => { const v = V[i]; const d = document.createElement("div"); d.innerHTML = cardHtml(v); return { src: v.src, grp: srcGroup(v.src), lbl: SRCLBL[v.src] || SRCLBL.user, raw: /\b(audio|zz_unknown|deck|extra)\b/.test(d.textContent) }; }));
    check(`${run}: src null / 'audio' / unknown → public group 'editor' ('Editör seçimi'), raw code never shown`, s2.every((x) => x.grp === "editor" && x.lbl === "Editör seçimi" && !x.raw), JSON.stringify(s2));
  }
  // day modal: 'Kendi notun' + 'Notumu kaydet' (existing save path; 'Notun kaydedildi' only on a real success)
  await page.evaluate(() => setActiveView("cal"));
  await page.waitForTimeout(500);
  await page.evaluate(() => { try { ensurePlan(); } catch (e) {} openDay(CAL.days[0].key); });
  const dm = await page.evaluate(() => ({ kicker: [...document.querySelectorAll("#dayBody .font-kicker")].map((e) => e.textContent.trim()), btn: (document.getElementById("dayNoteSave") || {}).textContent, role: (document.getElementById("dayNoteStatus") || { getAttribute() { return null; } }).getAttribute("role") }));
  check(`${run}: day modal shows '🗒️ Kendi notun' + 'Notumu kaydet' + role=status line`, dm.kicker.includes("🗒️ Kendi notun") && dm.kicker.includes("📝 Plan notu") && dm.btn === "Notumu kaydet" && dm.role === "status", JSON.stringify(dm));
  await page.fill("#dayNote", "Gate notu bir");
  await page.click("#dayNoteSave");
  await page.waitForFunction(() => !/Kaydediliyor/.test(document.getElementById("dayNoteStatus").textContent), null, { timeout: 10000 }).catch(() => {});
  const ok1 = await page.evaluate(() => ({ st: document.getElementById("dayNoteStatus").textContent, cal: localStorage.getItem("asa:ams:cal") || "", trip: !!window.TRIP, sync: window.TripSync && window.TripSync.status, pill: (document.getElementById("tripSyncPill") || {}).textContent || "" }));
  const wantSynced = member;   // the member run opens a stub trip (?trip=): the flush goes through TripSync
  check(`${run}: 'Notumu kaydet' → 'Notun kaydedildi' after a real save`, /^Notun kaydedildi/.test(ok1.st) && ok1.cal.includes("Gate notu bir") && (wantSynced ? ok1.trip && ok1.sync === "saved" && ok1.st === "Notun kaydedildi." : ok1.st === "Notun kaydedildi (bu cihazda)."), JSON.stringify(ok1));
  if (wantSynced) check(`${run}: member sync pill says 'Notun kaydedildi' after a note save`, ok1.pill === "Notun kaydedildi", ok1.pill);
  // failure paths: device write refused, then (member) server write refused → plain failure line, never 'Notun kaydedildi'
  await page.fill("#dayNote", "Gate notu iki");
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__gateRealSet = ASA_ST.set; ASA_ST.set = function () { return false; }; });
  await page.click("#dayNoteSave");
  await page.waitForFunction(() => !/Kaydediliyor/.test(document.getElementById("dayNoteStatus").textContent), null, { timeout: 10000 }).catch(() => {});
  const bad1 = await page.evaluate(() => { const s = document.getElementById("dayNoteStatus").textContent; ASA_ST.set = window.__gateRealSet; return s; });
  check(`${run}: device write refused → failure line, not 'Notun kaydedildi'`, !/Notun kaydedildi/.test(bad1) && /kaydedilemedi/.test(bad1), bad1);
  if (member) {
    await page.evaluate(() => { window.__WP5_SUPA_FAIL_NEXT.trip_save = "notok"; });
    await page.click("#dayNoteSave");
    await page.waitForFunction(() => !/Kaydediliyor/.test(document.getElementById("dayNoteStatus").textContent), null, { timeout: 10000 }).catch(() => {});
    const bad2 = await page.evaluate(() => document.getElementById("dayNoteStatus").textContent);
    check(`${run}: server write refused → failure line, not 'Notun kaydedildi'`, !/Notun kaydedildi/.test(bad2) && /kaydedilemedi/.test(bad2), bad2);
  }
  S["dayModal"] = await page.evaluate(SNAP, "#dayBody");
  F4S["dayModal"] = await page.evaluate(SNAP, "#dayBody .font-kicker, #dayBody button, #dayNoteStatus");
  await page.evaluate(() => closeDay());
  S["plan:setup"] = await page.evaluate(SNAP, "#v-cal");
  // member segments
  if (member) {
    const segTxt = {};
    for (const k of ["passport", "points", "likes", "posts", "taste", "prefs"]) {
      await page.evaluate((x) => { setActiveView("member"); ASA.seg(x); }, k);
      await page.waitForTimeout(450);
      segTxt[k] = await page.evaluate(SNAP, "#memberBody");
      S["member:" + k] = segTxt[k];
      F4S["member:" + k] = segTxt[k];
    }
    const tabs = await page.evaluate(() => [...document.querySelectorAll("#memberBody button")].map((b) => b.textContent.trim()));
    check(`${run}: member tab 'Listem' (not 'Beğeniler')`, tabs.includes("Listem") && !tabs.includes("Beğeniler"), tabs.join("|"));
    check(`${run}: member Listem segment header 'Listem (2)'`, /Listem \(2\)/.test(segTxt.likes), segTxt.likes.slice(0, 120));
  } else {
    await page.evaluate(() => setActiveView("member"));
    await page.waitForTimeout(300);
    F4S["member:login"] = await page.evaluate(SNAP, "#memberBody");
  }
  F4S["static scope"] = await page.evaluate(SNAP, F4_SCOPE.join(","));
  S["notice+pill"] = await page.evaluate(() => ((document.getElementById("asaStoreNotice") || {}).textContent || "") + "\n" + ((document.getElementById("tripSyncPill") || {}).textContent || ""));
  S["page:after walk (body)"] = await page.evaluate(SNAP, null);
  // plain /amsterdam/ load
  await page.goto(origin + "/amsterdam/", { waitUntil: "load" });
  await page.waitForTimeout(700);
  S["page:/amsterdam/ (load)"] = await page.evaluate(SNAP, null);
}

/* ---------------- main ---------------- */
const RUNS = [];
for (const member of [false, true]) for (const width of [1280, 390]) for (const db of [false, true]) RUNS.push({ member, width, db });
const runs = QUICK ? [{ member: false, width: 1280, db: true }] : RUNS;
const { proc, origin } = await serve();
let browser;
try {
  browser = await chromium.launch();
  // raw served bytes
  for (const p of ["/", "/amsterdam/", "/amsterdam/?city=Amsterdam", "/kopenhag/"]) {
    const res = await fetch(origin + p); const raw = await res.text();
    check(`raw ${p}: HTTP 200 from the local server`, res.status === 200, String(res.status));
    const before = hits.length;
    scan("F1", F1, "raw", p, raw);
    const f2start = hits.length;
    scan("F2", F2, "raw", p, raw);
    // Tolerate only the pinned embedded fallback tips: a raw F2 hit is exempt when it sits on a venue data line whose
    // tip literal holds ALL of that line's F2 hits and whose (id, sha256(tip)) is pinned in RAW_TIP_EXEMPT.
    const f2 = hits.splice(f2start);
    const count = (str) => { const t = str.normalize("NFC"); return Math.max(...[t.toLocaleLowerCase("tr"), t.toLowerCase()].map((x) => F2.reduce((a, rx) => a + (x.match(new RegExp(rx.source, "gu")) || []).length, 0))); };
    let exempt = 0, outside = 0; const bad = [];
    raw.split("\n").forEach((l, i) => {
      const n = count(l); if (!n) return;
      const id = (l.match(/^\s*\{id:"([^"]+)"/) || [])[1];
      const lit = (l.match(/tip:"((?:[^"\\]|\\.)*)"/) || [])[1];
      const tip = lit === undefined ? null : JSON.parse('"' + lit + '"');
      if (p.startsWith("/amsterdam/") && id && tip !== null && count(tip) === n && RAW_TIP_EXEMPT[id] === createHash("sha256").update(tip).digest("hex")) exempt += n;
      else { outside += n; bad.push(`HIT F2 raw ${p} line ${i + 1}${id ? " (" + id + (tip !== null && RAW_TIP_EXEMPT[id] ? ": pinned tip changed" : "") + ")" : ""} …${mask(l.normalize("NFC").toLocaleLowerCase("tr").match(/.{0,16}(araştırma notu|sesli not|teyit et|yayına hazır|kaynak gerekli|kontrol e|editör notu).{0,16}/u)?.[0] || "").slice(0, 40)}…`); }
    });
    if (outside) hits.push(...bad);
    if (p.startsWith("/amsterdam/")) console.log(`RAW_F2_PINNED_TIPS ${p} exempt=${exempt} outside=${outside} (owner decision: reword the 6 fallback tips in DB + embedded copy)`);
    check(`raw ${p}: F2 = 0 outside the ${Object.keys(RAW_TIP_EXEMPT).length} pinned fallback tips`, outside === 0 && exempt <= 6, `exempt=${exempt} outside=${outside}`);
    check(`raw ${p}: F1 = 0`, hits.slice(before).filter((h) => h.startsWith("HIT F1")).length === 0);
  }
  for (const r of runs) {
    const run = `${r.member ? "member" : "anon"}@${r.width}/${r.db ? "db-sentinel" : "embedded"}`;
    const supa = { user: r.member ? { id: UID, email: ["leakgate", "example.invalid"].join("@") } : null, persist: false,
      tables: { members: r.member ? [{ user_id: UID, display_name: "leakgate", tier: "Kaşif", points: 0, blocked: false, first_name: "Gate", last_name: "Üye" }] : [],
        trips: r.member ? [{ id: TRIP_ID, user_id: UID, city: "Amsterdam", country: "Hollanda", start_date: "2026-11-02", end_date: "2026-11-05", timezone: "Europe/Amsterdam", revision: 1, setup_completed: true, preferences: {}, plan: {}, archived_at: null }] : [],
        favorites: [], comments: [] } };
    if (r.db) supa.tables.venues = dbRows();
    const ctx = await newCtx(browser, origin, r.width, supa);
    const page = await ctx.newPage();
    const errs = [], dialogs = [];
    page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 140)));
    page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    const S = {}, F4S = {};
    try {
      for (const p of ["/", "/kopenhag/"]) { await page.goto(origin + p, { waitUntil: "load" }); await page.waitForTimeout(500); S["page:" + p] = await page.evaluate(SNAP, null); }
      await cityWalk(page, origin, run, r.member, r.db, S, F4S);
    } catch (e) { check(`${run}: walk completed`, false, String(e && e.message)); }
    S["dialogs"] = dialogs.join("\n");
    for (const [k, t] of Object.entries(S)) { scan("F1", F1.concat(F1_RENDER), run, k, t); scan("F2", F2, run, k, t); scan("F3", F3, run, k, t); }
    for (const [k, t] of Object.entries(F4S)) scan("F4", F4, run, k, t);
    if (r.db) { const all = Object.values(S).join("\n").toLowerCase(); check(`${run}: venues.note sentinel never rendered`, !all.includes(NOTE_TOKEN), all.includes(NOTE_TOKEN) ? "note text reached the page" : ""); }
    check(`${run}: no page errors`, errs.length === 0, errs.slice(0, 3).join(" | "));
    await ctx.close();
  }
} finally { if (browser) await browser.close(); proc.kill(); }

for (const l of passes) console.log(l);
for (const l of fails) console.log(l);
for (const l of hits) console.log(l);
const bad = fails.length + hits.length;
console.log(`PUBLIC_LEAK_GATE_SUMMARY ${JSON.stringify({ root: ROOT === REPO ? "repo" : "custom", runs: runs.length, checks: passes.length + fails.length, failed_checks: fails.length, hits: hits.length })}`);
console.log(bad ? "PUBLIC_LEAK_GATE_FAIL" : "PUBLIC_LEAK_GATE_PASS");
process.exit(bad ? 1 : 0);
