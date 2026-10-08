// WP7 (5/n + 6/n) · label mapping unit tests (node --test; jsdom for the admin venue editor). No network, no production.
//   NODE_PATH=<dir with jsdom> node --test scripts/wp7_labels_unit.test.mjs
// Covers: publicNote / srcGroup / SRCLBL on the city page (the rendered tip is the only public note), the embedded fallback
// data (no venue note values shipped), the Listem / Kendi notun vocabulary, and the admin venue editor's labelled Güven /
// Kaynak selects (the stored code is preserved — 'medium' no longer becomes 'high' on save).
// Scope checks (one-time, WP7 branch only; WP7_SCOPE_CHECKS=1, default on when the checked-out branch is wp7-beta-launch):
// the admin e-mail module region is byte-identical to the WP7 base commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const city = read("amsterdam/index.html");
const admin = read("CDP3B/admin.html");
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");   // fail-closed: a missing jsdom is an error, not a skip

const F1 = /veri not(u|ları)|whatsapp|whisper|file:\/\/|senin notun|senin verdiğin|önceki araştırma(m|ndan)|\bek araştırma|araştırma ile eklendi|araştırmada bazı|\(araştırma:|ses kaydı|benim listem/iu;
const F2 = /araştırma notu|sesli not|teyit et|yayına hazır|kaynak gerekli|kontrol et|kontrol edilmeli|editör notu/iu;
const F3 = /<\/?(b|i|br|span)\b|&lt;/iu;
const low = (s) => String(s).normalize("NFC").toLocaleLowerCase("tr");

// --- city helpers, evaluated from the real page source ---
const a = city.indexOf("const SRCLBL="), b = city.indexOf("function byId(id)", a);
assert.ok(a > 0 && b > a, "SRCLBL/srcGroup/publicNote block found");
const ctx = {}; vm.createContext(ctx); vm.runInContext(city.slice(a, b).replace("const SRCLBL=", "var SRCLBL="), ctx);
const { publicNote, srcGroup, SRCLBL } = ctx;
function embedded() {
  const s = city.indexOf("let V=["), e = city.indexOf("\nconst TRIPS={};", s);
  const c = {}; vm.createContext(c); vm.runInContext(city.slice(s, e).replace("let V=", "var V="), c);
  return JSON.parse(JSON.stringify(c.V));
}

test("publicNote: the 6 embedded tips with an editorial to-do read as reader wording", () => {
  const V = embedded(), tip = (id) => V.find((v) => v.id === id).tip;
  const want = {
    shiraz: "Kanal kenarı; şarap + peynir/kanepe. Rezervasyon bilgisi henüz doğrulanmadı.",
    cheznina: "Rezervasyonla. 'Noof' olarak yenilenmiş olabilir; bu bilgi henüz doğrulanmadı.",
    escobar: "22:00 sonrası eğlence modu. ⚠️ Hâlâ açık olup olmadığı henüz doğrulanmadı.",
    barracuda: "Rezervasyonla; adres ve Instagram bilgisi henüz doğrulanmadı.",
    fabus: "Natürel şarap + Levanten tabaklar; adres bilgisi henüz doğrulanmadı.",
    september: "Mevsimsel, yerel ürün; adres bilgisi henüz doğrulanmadı.",
  };
  for (const [id, w] of Object.entries(want)) assert.equal(publicNote(tip(id)), w, id);
});

test("publicNote: no embedded tip renders internal (F1), admin (F2) or markup (F3) text", () => {
  for (const v of embedded()) {
    const out = low(publicNote(v.tip || ""));
    assert.equal(F1.test(out) || F2.test(out) || F3.test(out), false, v.id + ": " + out.slice(0, 60));
  }
});

test("publicNote: legacy prefixes, the old favourite marker and markup are removed; to-dos become 'henüz doğrulanmadı'", () => {
  const cases = [
    ["<b>Senin notun:</b> Walk-in. ❤️ Öncelikli favori.", "Walk-in."],
    ["Senin notun: Rezervasyonla. ❤️ Favori.", "Rezervasyonla."],
    ["<b>Editör notu:</b> Sakin bir yer.", "Sakin bir yer."],
    ["<b>Ek araştırma.</b> Bahçesi var.", "Bahçesi var."],
    ["Ek araştırma. Bahçesi var.", "Bahçesi var."],
    ["<b>Araştırma ile eklendi</b> (senin verdiğin isimden). Kanal kenarı.", "Kanal kenarı."],
    ["Eski adı X (Araştırmada bazı kaynaklar 2019 diyor).", "Eski adı X (Bazı kaynaklar 2019 diyor)."],
    ["Eski adı X (Araştırma: 2019).", "Eski adı X (Bazı kaynaklara göre: 2019)."],
    ["Adres kontrol edilmeli.", "Adres bilgisi henüz doğrulanmadı."],
    ["Adres/IG kontrol edilmeli.", "Adres ve Instagram bilgisi henüz doğrulanmadı."],
    ["Saatleri teyit et.", "Saatleri henüz doğrulanmadı."],
    ["Hafta sonu kontrol etmeli.", "Hafta sonu henüz doğrulanmadı."],
    ["<i>Kalın</i> tüyo", "Kalın tüyo"],
    [null, ""], [undefined, ""], ["", ""],
  ];
  for (const [inp, w] of cases) assert.equal(publicNote(inp), w, String(inp));
  for (const [inp] of cases) { const o = low(publicNote(inp)); assert.equal(F1.test(o) || F2.test(o) || F3.test(o), false, String(inp)); }
});

test("srcGroup / SRCLBL: two public groups; raw research source names never shown", () => {
  for (const s of ["user", "deck", "extra", "audio", null, undefined, "zz_unknown"]) {
    assert.equal(srcGroup(s), "editor", String(s));
    assert.equal(SRCLBL[s] || SRCLBL.user, "Editör seçimi", String(s));
  }
  assert.equal(srcGroup("poi"), "poi"); assert.equal(SRCLBL.poi, "Gezilecek yer");
  for (const sel of ["mapSrc", "fSrc"]) {
    const m = city.match(new RegExp('<select class="asasel" id="' + sel + '">([\\s\\S]*?)</select>'));
    assert.ok(m, sel);
    assert.deepEqual([...m[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((x) => x[1].trim()), ["Tüm kaynaklar", "Editör seçimi", "Gezilecek yer"], sel);
  }
});

test("embedded fallback data: no venue note VALUES are shipped (DB keeps them; git history keeps the old bytes)", () => {
  const V = embedded();
  assert.equal(V.length, 109);
  assert.equal(V.filter((v) => "note" in v).length, 49, "note keys kept (shape unchanged)");
  assert.equal(V.filter((v) => v.note).length, 0, "every embedded note is empty");
  assert.equal(V.filter((v) => v.tip).length, 49, "tips untouched");
});

test("venues.note is never rendered: card, venue modal and popup render v.tip only, escaped", () => {
  assert.equal(/publicNote\([^)]*\.note/.test(city), false, "no publicNote(…note)");
  assert.equal((city.match(/const noteTxt=publicNote\(v\.tip\|\|''\);/g) || []).length, 2, "card + modal");
  assert.ok(city.includes("<span>'+esc(noteTxt)+'</span></div>':'')"), "card escapes the tip");
  assert.ok(city.includes("💡 '+esc(publicNote(v.tip))+'</div>"), "popup escapes the tip");
});

test("Listem / Kendi notun vocabulary on the city page", () => {
  for (const s of ['{k:"fav",l:"❤️ Listem",cls:"fav"}', '{e:"❤️",l:"Listem",d:"Eklediğin yerler",', '["likes","Listem"]',
    'aria-label="Listeme ekle" aria-pressed="', '<span class="msym text-[22px] text-secondary" aria-hidden="true">',
    '"❤️ Listemde":"🤍 Listeme ekle"', "'❤️ Listemde':'🤍 Listeme ekle'", "Listeme git</button>", "🗒️ Kendi notun",
    ">Notumu kaydet</button>", 'id="dayNoteStatus" role="status" aria-live="polite"', 'var NAMES={fav:"Listem",plan:"Plan notların",',
    'cal:"Kendi notların"', "Editörün favorilerinden kısa rota", "'⚠ Saat bilgisi doğrulanmadı'", "why.push('Listende')"]) assert.ok(city.includes(s), s);
  for (const s of ["❤️ Favori\"", "Favorilerime git", "🗒️ Kişisel not", '"Beğeniler"', "Kaydettiklerin (", "🤍 Kaydet", "❤️ Kayıtlı",
    "Saat bilgisini kontrol et", "'Favorilerinde'", "Favorin kaydedilemedi", "Henüz favorin yok"]) assert.equal(city.includes(s), false, s);
});

test("'Notumu kaydet' reuses the existing save path and only claims success after a real write", () => {
  const f = city.slice(city.indexOf("async function saveDayNoteNow(d){"), city.indexOf("\n}\n", city.indexOf("async function saveDayNoteNow(d){")));
  assert.ok(f.length > 200);
  assert.ok(f.includes('local=saveLS("cal",calNotes,true)===true;'), "same storage key/path (asa:ams:cal via saveLS)");
  assert.ok(f.includes("await window.TripSync.flush(); synced=(window.TripSync.status===\"saved\");"), "member: existing TripSync flush");
  assert.ok(/if\(ok\) st\.textContent=\(synced===true\)\?"Notun kaydedildi\.":"Notun kaydedildi \(bu cihazda\)\.";/.test(f));
  assert.equal(/localStorage|setItem\(/.test(f), false, "no new storage keys");
});

test("fresh visitor: the editor's picks (v.fav) are not seeded into the list", () => {
  const i = city.indexOf("(function initFav(){"), j = city.indexOf("})();", i);
  assert.ok(i > 0 && j > i);
  const body = city.slice(i, j).replace(/\/\/[^\n]*/g, "");   // code only (the comment explains the rule)
  assert.equal(/v\.fav/.test(body), false); assert.equal(/ASA_ST\.set\("fav"/.test(body), false);
});

// --- admin venue editor: the real editVenue + saveVenue in jsdom ---
function adminEditor() {
  const ev = admin.slice(admin.indexOf("function editVenue(id){"), admin.indexOf("let _vmap=null"));
  const sv = admin.slice(admin.indexOf("async function saveVenue(isNew){"), admin.indexOf("\nfunction venuePhotoPrev("));
  assert.ok(ev.length > 1000 && sv.length > 500, "editVenue/saveVenue extracted");
  const helpers = admin.split("\n").filter((l) => /^const (\$|esc|arr)=/.test(l)).join("\n");
  assert.equal(helpers.split("\n").length, 3, "$ / esc / arr helpers");
  const dom = new JSDOM('<body><div id="modal" class="hide"><div id="sheet"></div></div></body>', { runScripts: "outside-only" });
  const w = dom.window;
  w.eval(helpers.replace(/^const /gm, "var ") + `
    var DATA={venues:[],cities:[]}; var saved=[]; var db={from:function(){return{upsert:function(row){saved.push(row);return Promise.resolve({error:null});}};}};
    function venueById(id){ return DATA.venues.find(function(v){return v.id===id;}); }
    function openModal(){} function closeModal(){} function renderVenues(){} function venuePhotoPrev(){} function initVenueMap(){} function vClosureTypeChange(){}
    ` + ev + "\n" + sv + "\nwindow.__t={DATA:DATA,saved:saved,editVenue:editVenue,saveVenue:saveVenue};");
  return w;
}
const lbl = (w, id) => { const s = w.document.getElementById(id); return s.options[s.selectedIndex].textContent; };

test("admin Güven: Yüksek/Orta/Düşük; the stored value is preserved on open and on save ('medium' no longer becomes 'high')", async () => {
  const w = adminEditor(), T = w.__t;
  const want = { high: "Yüksek", medium: "Orta", med: "Orta", low: "Düşük", "": "(boş)", zz: "(diğer: zz)" };
  for (const [conf, label] of Object.entries(want)) {
    T.DATA.venues = [{ id: "v1", name: "Test", city: "Amsterdam", conf: conf === "" ? null : conf, src: "user", tags: [], cats: [], best: [] }];
    T.saved.length = 0;
    T.editVenue("v1");
    assert.equal(w.document.getElementById("f_conf").value, conf, "select keeps " + conf);
    assert.equal(lbl(w, "f_conf"), label, conf);
    await T.saveVenue(false);
    assert.equal(T.saved.length, 1, "one upsert");
    assert.equal(T.saved[0].conf, conf === "" ? null : conf, "saved conf for " + conf);
  }
  T.editVenue(null);
  assert.equal(w.document.getElementById("f_conf").value, "high", "new venue default unchanged");
});

test("admin Kaynak: labelled select over the unchanged codes; unknown codes shown as '(diğer: code)' and never rewritten", async () => {
  const w = adminEditor(), T = w.__t;
  const want = { user: "Editör seçimi", deck: "Araştırma notu · önceki", extra: "Araştırma notu · ek", audio: "Sesli not", poi: "Gezilecek yer", "": "(seçilmedi)", "x<y": "(diğer: x<y)" };
  for (const [src, label] of Object.entries(want)) {
    T.DATA.venues = [{ id: "v1", name: "Test", city: "Amsterdam", conf: "high", src: src === "" ? null : src, tags: [], cats: [], best: [] }];
    T.saved.length = 0;
    T.editVenue("v1");
    assert.equal(w.document.getElementById("f_src").value, src);
    assert.equal(lbl(w, "f_src"), label, src);
    await T.saveVenue(false);
    assert.equal(T.saved[0].src, src === "" ? null : src, "saved src for " + src);
  }
  const opts = [...w.document.querySelectorAll("#f_src option")].map((o) => o.value + "=" + o.textContent);
  assert.ok(opts.includes("user=Editör seçimi") && opts.includes("poi=Gezilecek yer"));
});

test("admin venue editor labels say what is public", () => {
  const w = adminEditor(), T = w.__t;
  T.DATA.venues = [{ id: "v1", name: "Test", city: "Amsterdam", conf: "low", src: "deck", tags: [], cats: [], best: [] }];
  T.editVenue("v1");
  const labels = [...w.document.querySelectorAll("#sheet label")].map((l) => l.textContent);
  for (const s of ["Yerli tüyosu (sitede görünür)", "Açıklama (sitede görünür)", "Editör notu (sitede gösterilmez)", "Fotoğraf (boşsa sitede nötr yer tutucu gösterilir)", "Güven", "Kaynak"])
    assert.ok(labels.includes(s), s);
  assert.ok(admin.includes(`<span class="pill soon">Teyit et</span>`) && !admin.includes(`<span class="pill soon">kontrol</span>`), "pill");
  assert.ok(admin.includes(`stat(ck,"Teyit bekleyen")`) && !admin.includes(`"Kontrol gereken"`), "stat");
  for (const s of ["Kaynak gerekli", "Yayına hazır"]) assert.equal(admin.includes(s), false, s + " is an owner-decision proposal, not built");
});

const SCOPE = process.env.WP7_SCOPE_CHECKS != null ? process.env.WP7_SCOPE_CHECKS === "1"
  : (() => { try { return execFileSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim() === "wp7-beta-launch"; } catch { return false; } })();
test("[scope] admin e-mail module region byte-identical to the WP7 base (PR A owns it)", { skip: !SCOPE && "WP7_SCOPE_CHECKS=0" }, () => {
  const BASE = process.env.WP7_BASE_REF || "7ae9030";
  const prev = execFileSync("git", ["-C", REPO, "show", BASE + ":CDP3B/admin.html"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const tail = (h) => h.slice(h.indexOf("async function emailApi(action, fields){"));
  assert.equal(tail(admin), tail(prev));
});
