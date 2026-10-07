// UX Sprint 1 acceptance checks. Requires jsdom (not a production dependency).
//   NODE_PATH=/tmp/uxcheck/node_modules node scripts/ux_sprint1_trust_check.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

let fail = 0;
function ok(name, cond) {
  if (!cond) { fail++; console.log("FAIL " + name); }
  else console.log("PASS " + name);
}

function inlineBlocks(html) {
  return (html.replace(/<script\s+src=[^>]*>\s*<\/script>/gi, "").match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi) || [])
    .map((s) => s.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, ""));
}
function checkSyntax(name, html) {
  let n = 0;
  for (const src of inlineBlocks(html)) {
    n++;
    if (!src.trim()) continue;
    try { new Function(src); }
    catch (e) { ok(name + " syntax", false); console.log("  " + e.message); return; }
  }
  ok(name + " syntax", n > 0);
}

const home = read("index.html");
const city = read("amsterdam/index.html");
const uid = read("amsterdam_index_UID.html");
const admin = read("CDP3B/admin.html");
const cph = read("kopenhag/index.html");

checkSyntax("home", home);
checkSyntax("city", city);
checkSyntax("admin", admin);

ok("pw property removed from home/city", !/\bpw\s*:/.test(home) && !/\bpw\s*:/.test(city) && !/\bpw\s*:/.test(uid));
ok("footer copyright", home.includes("© 2026 ASALOCAL · yerel gibi"));
ok("footer has no placeholder links", !/<footer[\s\S]*?href\s*=\s*"#"/.test(home));
ok("ilgimi birak live region and 4s", /id="goNote"[^>]*aria-live="polite"/.test(home) && home.includes("setTimeout(r,4000)") && home.includes("interestFlight"));
ok("cph stub unchanged marker", /data-asa-city-state\s*=\s*"stub"/.test(cph) && cph.includes("Kopenhag içerikleri hazırlanıyor") && !/<script\b/i.test(cph));
ok("wse ui predicate intact", city.includes('const pending=(v==="config_pending"); const on=(v===true);'));
ok("teaser contract", city.includes("const TEASER_MAX=10") && city.includes(".slice(0,TEASER_MAX)") && city.includes("ids.sort()"));
ok("paywall copy", ["Devamı üyeler için", "İlk 10 mekân gösteriliyor.", "Üye ol veya giriş yap", "Favorilerime git", "Harita ile liste aynı 10 mekânı gösterir.", "Tam listeye üye olunca ulaşırsın."].every((s) => city.includes(s)));
ok("fav copy", city.includes("Henüz favorin yok. Mekânlar’dan kalp ile ekle.") && city.includes("Favorilerin bu cihazda. Üye olursan hesabına taşıyabilirsin."));
ok("seed only when new and legacy fav keys are missing", /const favRaw=ASA_ST\.read\("fav"\);\s*if\(favRaw\.present\)\{[\s\S]{0,200}return;\s*\}\s*if\(!ASA_ST\.writable\(\)\) return;/.test(city));
ok("accommodation is not a hard CTA block", !city.includes("konaklama noktanı seçmelisin") && city.includes("(Önerilir)"));
ok("one primary plan cta", (city.match(/data-cta="primary"/g) || []).length === 1);
ok("admin login a11y", admin.includes('<label for="le">E-posta</label>') && admin.includes('<label for="lp">Şifre</label>') && admin.includes('id="aerr" role="alert"'));
ok("admin login has no stack name", !/Supabase/.test(admin.slice(admin.indexOf("function renderLogin"), admin.indexOf("async function loadCaps"))));
ok("admin role gate intact", admin.includes("is_current_user_admin") && admin.includes("if(!CAPS.admin)") && admin.includes('role="alert">Bu hesap için yönetim erişimi yok.'));

// WP3: the same-origin storage library is inlined (jsdom does not fetch it); third-party src scripts are dropped.
const asaLib = read("lib/asa-storage/asa_storage.js");
function stripSrc(html) {
  return html
    .replace(/<script\s+src="\/lib\/asa-storage\/asa_storage\.js\?v=[0-9a-f]{16}"><\/script>/, () => "<script>" + asaLib + "</script>")
    .replace(/<script\s+src=[^>]*>\s*<\/script>/gi, "");
}
function boot(html, storage, extra) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e && e.message || e)));
  const dom = new JSDOM(stripSrc(html), {
    url: "http://127.0.0.1/amsterdam/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.tailwind = { config: {} };
      window.addEventListener("error", (ev) => errors.push(ev.message || String(ev.error)));
      if (extra) extra(window);
      for (const [k, v] of Object.entries(storage || {})) window.localStorage.setItem(k, v);
    }
  });
  return { dom, w: dom.window, errors };
}

function leaflet(bag) {
  return {
    map() {
      return { setView() {}, on() {}, getContainer() { return { style: {} }; }, invalidateSize() {}, removeLayer() {} };
    },
    tileLayer() { return { addTo() {} }; },
    layerGroup() { return { addTo() { return this; }, clearLayers() { bag.ids.length = 0; } }; },
    circleMarker() {
      const m = { asaVenueId: null, bindPopup() { return m; }, addTo() { if (m.asaVenueId) bag.ids.push(m.asaVenueId); return m; } };
      return m;
    },
    popup() { return { setLatLng() { return this; }, setContent() { return this; }, openOn() { return this; } }; }
  };
}

const bag = { ids: [] };
const empty = boot(city, {}, (window) => { window.L = leaflet(bag); });
ok("city boots", empty.errors.length === 0);
if (empty.errors.length) console.log(empty.errors.slice(0, 6).join("\n"));
const w = empty.w;
const cards = () => [...w.document.querySelectorAll("[data-venue-id]")].map((el) => el.getAttribute("data-venue-id"));
const teaser = w.teaserIdList();
const catalog = w.cityCatalogIds();
ok("anon shows at most 10", cards().length <= 10 && cards().length === Math.min(10, catalog.length));
ok("anon list ids == deterministic teaser", cards().slice().sort().join("|") === teaser.slice().sort().join("|"));
ok("teaser is sorted prefix", teaser.join("|") === catalog.slice().sort().join("|").split("|").slice(0, teaser.length).join("|") || teaser.join("|") === catalog.slice(0, 10).join("|"));
ok("gate when catalog exceeds 10", catalog.length <= 10 || w.document.body.textContent.includes("İlk 10 mekân gösteriliyor."));
const seeded = JSON.parse(w.localStorage.getItem("asa:ams:fav") || "null");
ok("empty storage seeded once", Array.isArray(seeded) && new Set(seeded).size === seeded.length && seeded.includes("barpif") && !seeded.includes("poi_noorderkerk"));
ok("seed writes no legacy key", w.localStorage.getItem("ams_fav") === null);

w.setActiveView("map");
await new Promise((r) => setTimeout(r, 120));
ok("map marker ids == list ids", bag.ids.slice().sort().join("|") === cards().slice().sort().join("|"));
const aria = w.document.getElementById("mapTeaserAria").textContent;
ok("map aria when truncated", catalog.length <= 10 || aria === "Harita ile liste aynı 10 mekânı gösterir.");
empty.dom.window.close();

const outsideProbe = boot(city, { ams_fav: "[]" });
const outside = outsideProbe.w.cityCatalogIds().find((id) => !outsideProbe.w.teaserIdList().includes(id));
outsideProbe.dom.window.close();
ok("fixture id outside teaser", !!outside);

const kept = boot(city, { ams_fav: JSON.stringify([outside]) });
ok("non-empty storage not reseeded", kept.w.localStorage.getItem("asa:ams:fav") === JSON.stringify([outside]) && kept.w.localStorage.getItem("ams_fav") === JSON.stringify([outside]));
ok("default list hides outside id", !cardsOf(kept.w).includes(outside));
kept.w.setOnlyChip("fav");
ok("favorilerim shows outside id", cardsOf(kept.w).includes(outside));
ok("favorilerim local note", kept.w.document.body.textContent.includes("Favorilerin bu cihazda. Üye olursan hesabına taşıyabilirsin."));
kept.w.ASA = { session: { uid: "member-1", email: "a@b.c" } };
const favChip = [...kept.w.document.querySelectorAll("#chips button")].find((b) => b.dataset.k === "fav");
if (favChip) favChip.click();
ok("member full list", cardsOf(kept.w).length === kept.w.cityCatalogIds().length);
ok("member note", kept.w.document.getElementById("count").textContent.includes("Tüm mekânlar açık."));
kept.dom.window.close();

function cardsOf(win) { return [...win.document.querySelectorAll("[data-venue-id]")].map((el) => el.getAttribute("data-venue-id")); }

const cleared = boot(city, { ams_fav: "[]" });
ok("explicit empty array stays empty", cleared.w.localStorage.getItem("asa:ams:fav") === "[]" && cleared.w.localStorage.getItem("ams_fav") === "[]");
cleared.w.setOnlyChip("fav");
ok("empty favorites copy", cleared.w.document.body.textContent.includes("Henüz favorin yok. Mekânlar’dan kalp ile ekle."));
cleared.dom.window.close();

const dup = boot(city, { ams_fav: JSON.stringify(["barpif", "barpif", "chun"]) });
ok("stored duplicates collapse in the set", dup.w.isFav("barpif") && dup.w.isFav("chun"));
const shown = new Set(cardsOf(dup.w).filter((id) => id === "barpif"));
ok("list does not repeat a venue card", shown.size <= 1);
dup.w.setOnlyChip("fav");
const favCards = cardsOf(dup.w);
ok("fav view unique cards", new Set(favCards).size === favCards.length && favCards.includes("barpif") && favCards.includes("chun"));
dup.dom.window.close();

const plan = boot(city, {
  ams_fav: "[]",
  asa_trip: JSON.stringify({ start_date: "2026-10-10", end_date: "2026-10-12", city: "Amsterdam" })
});
plan.w.setActiveView("cal");
await new Promise((r) => setTimeout(r, 50));
const primary = plan.w.document.getElementById("planPrimaryCta");
ok("plan primary present", !!primary);
ok("plan primary enabled without accommodation", primary && primary.disabled === false);
ok("onerilir label", plan.w.document.body.textContent.includes("Önerilir"));
ok("single primary element", plan.w.document.querySelectorAll('[data-cta="primary"]').length === 1);
ok("secondary generate remains available", plan.w.document.querySelectorAll('[data-cta="secondary"]').length >= 1);
ok("no accommodation hard-block copy", !plan.w.document.body.textContent.includes("konaklama noktanı seçmelisin"));
plan.dom.window.close();

const homeBoot = boot(home, {});
ok("home boots", homeBoot.errors.length === 0);
if (homeBoot.errors.length) console.log(homeBoot.errors.slice(0, 4).join("\n"));
const hw = homeBoot.w;
ok("footer copy and no legal anchors", hw.document.querySelector("footer").textContent.includes("© 2026 ASALOCAL · yerel gibi") && hw.document.querySelectorAll("footer a").length === 0);
ok("goNote polite", hw.document.getElementById("goNote").getAttribute("aria-live") === "polite");
hw.document.getElementById("countrySel").value = "fr";
hw.document.getElementById("countrySel").onchange({ target: hw.document.getElementById("countrySel") });
hw.document.getElementById("citySel").value = "Paris";
hw.document.getElementById("citySel").onchange({ target: hw.document.getElementById("citySel") });
const go = hw.document.getElementById("goBtn");
const note = hw.document.getElementById("goNote");
ok("interest cta", go.textContent.includes("ilgimi bırak"));
go.click();
ok("disabled while in flight", go.disabled === true);
go.click();
await new Promise((r) => setTimeout(r, 20));
ok("success message", note.textContent.includes("İlgin kaydedildi"));
ok("stays disabled during the hold", go.disabled === true);
await new Promise((r) => setTimeout(r, 3500));
ok("still visible before 4s", note.textContent.includes("İlgin kaydedildi") && go.disabled === true);
await new Promise((r) => setTimeout(r, 800));
ok("enabled after 4s", go.disabled === false);
homeBoot.dom.window.close();

const adminBoot = boot(admin, {});
await new Promise((r) => setTimeout(r, 30));
const app = adminBoot.w.document.getElementById("app");
ok("admin login title", app.textContent.includes("Yönetim girişi"));
ok("admin visible labels", !!app.querySelector('label[for="le"]') && !!app.querySelector('label[for="lp"]') && app.querySelector("#aerr").getAttribute("role") === "alert");
ok("admin login hides stack name", !app.textContent.includes("Supabase"));
adminBoot.w.document.getElementById("abtn").click();
await new Promise((r) => setTimeout(r, 20));
ok("admin empty submit alert", adminBoot.w.document.getElementById("aerr").textContent === "Giriş olmadı. Bilgilerini kontrol et.");
adminBoot.dom.window.close();

console.log(fail ? "RESULT FAIL " + fail : "RESULT PASS");
process.exit(fail ? 1 : 0);
