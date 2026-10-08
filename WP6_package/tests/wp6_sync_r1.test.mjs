// WP6 · sync integrity, fixer round 1 (review findings on the first fix). Same harness as wp6_sync_integrity.test.mjs:
// the city page's REAL code in a vm sandbox (./_page.mjs), fake Storage shared between "tabs", fake Supabase, fake timers.
//   R1 two tabs of one browser (shared storage)      R2 trip dates are part of the synced version
//   R3 pre-WP6 (legacy) edited plans are not "auto"  R5 WP3 stranded plan-prefs adopt still works after opening a DB trip
//   R6 one-time legacy favourites merge never uploads the seeded defaults
//   node --test WP6_package/tests/
// Test data only: user ids like "u1", trip ids 1..20, years 2099; no e-mail addresses, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, bootLike, fakeStorage, settle, J, SEEDS } from "./_page.mjs";

const T = { timeout: 10000 };
const P0 = { "2099-01-10": ["barpif", "chun"], "2099-01-11": ["coba"] };
const P2 = { "2099-01-10": ["chun"], "2099-01-11": ["coba", "x2"], "2099-01-12": ["x3"] };
function row(o = {}) {
  return Object.assign({
    id: 7, revision: 5, user_id: "u1", city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12",
    timezone: "Europe/Amsterdam", setup_completed: true, archived_at: null, plan_version: 0,
    preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli" } },
    plan: { dayven: J(P0), cal: {}, plan: { "2099-01-10": "Kahve molası" } },
  }, J(o));
}
const rowB = () => row({ id: 2, revision: 3, start_date: "2099-02-10", end_date: "2099-02-12", plan: { dayven: { "2099-02-10": ["pllek"], "2099-02-11": ["oeuf", "x1"] }, cal: {}, plan: {} } });
const rowE = () => row({ id: 2, revision: 1, start_date: "2099-02-01", end_date: "2099-02-02", setup_completed: false, preferences: {}, plan: null });
const row9 = () => row({ id: 9, revision: 4, start_date: "2099-03-01", end_date: "2099-03-10", preferences: { plan_prefs: { saved: true, tempo: "Yoğun" } }, plan: { dayven: { "2099-03-02": ["a"] }, cal: {}, plan: {} } });
function tripOn(r, opts = {}) { const h = boot(opts); if (!h.server.trip(r.id)) h.server.tables.trips.push(J(r)); h.useDb(); h.open(r); return h; }
function serverEdit(h, id, patch) { const r = h.server.trip(id); Object.assign(r, J(patch)); r.revision++; return J(r); }
function secondTab(h, r = row()) { const b = bootLike(h); b.useDb(); b.open(r); return b; }
async function reopen(h, id = 7) { const k = bootLike(h, { search: `?trip=${id}&city=Amsterdam` }); k.useDb(); await k.asa.ev("loadTripContext()"); await settle(); k.runTimers(); await settle(); return k; }
const items = (h) => ((h.sync() || {}).items || []);
const OFF = (n) => (n === "trip_save" ? { data: null, error: { message: "offline (test)" } } : undefined);
const days = (h) => h.val("CAL.days.map(d=>d.key)");
const AB = { "2099-01-10": "A notu", "2099-01-11": "B notu" };

// ================================================================================================ R1 two tabs, one browser
test("R1.1 two tabs edit different days inside the debounce: both reach the server, nothing kept, no notice", T, async () => {
  const a = tripOn(row()), b = secondTab(a);
  a.run('calNotes["2099-01-10"]="A notu"; saveLS("cal",calNotes)');
  b.run('calNotes["2099-01-11"]="B notu"; saveLS("cal",calNotes)');          // no storage event yet: tab B's memory lacks A's note
  assert.deepEqual(a.ls("cal"), AB, "tab B's save applied only its own day onto the shared storage");
  assert.deepEqual(b.val("calNotes"), AB, "tab B's memory now holds both notes");
  a.runTimers(); await settle(60);                                         // tab A's autosave uploads the shared storage
  b.runTimers(); await settle(60);                                         // tab B: revision conflict, same content → silent adopt
  assert.deepEqual(a.server.trip(7).plan.cal, AB);
  assert.equal(items(a).length, 0); assert.equal(a.notice().hidden, true); assert.equal(b.notice().hidden, true);
  a.run('calNotes["2099-01-12"]="A notu 2"; saveLS("cal",calNotes)');      // tab A's memory still lacks B's note
  a.runTimers(); await settle(60);
  assert.deepEqual(a.server.trip(7).plan.cal, Object.assign({}, AB, { "2099-01-12": "A notu 2" }), "B's note survives A's next edit");
  assert.equal(items(a).length, 0);
});
test("R1.2 two tabs offline: tab B's later edit keeps tab A's unsynced note; after reconnect the server has both", T, async () => {
  const a = tripOn(row()), b = secondTab(a);
  a.server.hooks.rpc = OFF;
  a.run('calNotes["2099-01-10"]="A notu"; saveLS("cal",calNotes)'); a.runTimers(); await settle(30);
  b.run('calNotes["2099-01-11"]="B notu"; saveLS("cal",calNotes)'); b.runTimers(); await settle(30);
  assert.deepEqual(a.ls("cal"), AB, "A's unsynced note still in storage");
  a.server.hooks.rpc = undefined;
  await a.run("TripSync.flush()"); await settle(60); await b.run("TripSync.flush()"); await settle(60);
  assert.deepEqual(a.server.trip(7).plan.cal, AB);
  assert.equal(items(a).length, 0); assert.equal(a.notice().hidden, true); assert.equal(b.notice().hidden, true);
});
test("R1.3 same day changed in both tabs: the overwritten version is kept, an accessible notice offers it, restore brings it back", T, async () => {
  const a = tripOn(row()), b = secondTab(a);
  a.run('calNotes["2099-01-10"]="A notu"; saveLS("cal",calNotes)');
  b.run('calNotes["2099-01-10"]="B notu"; saveLS("cal",calNotes)');        // tab B never saw A's text for that day
  assert.deepEqual(b.ls("cal"), { "2099-01-10": "B notu" }, "the latest edit is used");
  const it = items(b).find((x) => x.reason === "tab");
  assert.ok(it, "tab A's version kept before it was overwritten"); assert.equal(it.trip_id, "7"); assert.deepEqual(it.cal, { "2099-01-10": "A notu" });
  const n = b.notice();
  assert.equal(n.hidden, false); assert.equal(n.role, "alert"); assert.equal(n.reason, "tab");
  assert.ok(n.text.includes("iki sekmede aynı anda değiştirildi") && n.text.includes("Saklanan sürümü geri yükle"), n.text);
  assert.deepEqual(a.fireStorage("asa:ams:plan_sync"), [true]);              // the other tab shows it too
  assert.equal(a.notice().reason, "tab");
  a.runTimers(); await settle(60); b.runTimers(); await settle(60);
  assert.deepEqual(a.server.trip(7).plan.cal, { "2099-01-10": "B notu" });
  assert.ok(items(b).some((x) => x.reason === "tab"), "kept version survives both flushes");
  b.el("tripSyncRestore").click(); await settle(60);
  assert.deepEqual(b.server.trip(7).plan.cal, { "2099-01-10": "A notu" }, "explicit restore uploads the kept version");
  assert.ok(!items(b).some((x) => x.reason === "tab"));
});
test("R1.4 storage event: the other tab's write reaches this tab's memory and re-renders; an open setup form is not reset", T, async () => {
  const a = tripOn(row()), b = secondTab(a);
  b.run('dayVenues["2099-01-12"]=["pllek"]; saveLS("dayven",dayVenues)');
  assert.equal(a.val('dayVenues["2099-01-12"]'), undefined, "precondition: event not delivered yet");
  const r0 = a.sb.__renderCal.length;
  assert.deepEqual(a.fireStorage("asa:ams:dayven"), [true]);
  assert.deepEqual(a.val('dayVenues["2099-01-12"]'), ["pllek"]); assert.ok(a.sb.__renderCal.length > r0, "calendar re-rendered");
  assert.deepEqual(a.fireStorage("asa:cph:dayven"), [false], "other city's keys ignored");
  b.run('PSET.setDate("endDate","2099-01-13")');
  a.fireStorage("asa:ams:trip");
  assert.equal(days(a).at(-1), "2099-01-13", "CAL follows the other tab's dates");
  assert.equal(a.val("PSET.getPrefs().endDate"), "2099-01-13", "closed setup form reloaded");
  a.run("PSET.edit()");
  b.run('PSET.setDate("startDate","2099-01-11")');
  a.fireStorage("asa:ams:trip");
  assert.equal(a.val("PSET.getPrefs().startDate"), "2099-01-10", "open (being edited) form keeps the user's input");
});
test("R1.5 another tab opens another DB trip: this tab writes nothing to that trip's storage and uploads nothing; user told", T, async () => {
  const a = tripOn(row());
  a.server.tables.trips.push(rowB());
  const b = secondTab(a, rowB());                                             // shared storage now holds trip 2
  const before = { dv: a.storage.raw("asa:ams:dayven"), cal: a.storage.raw("asa:ams:cal") };
  assert.deepEqual(a.fireStorage("asa:ams:dayven"), [false], "trip 2's plan is not loaded into trip 7's tab");
  assert.deepEqual(a.val("dayVenues"), P0);
  assert.equal(a.storeNotice().hidden, false);
  assert.ok(a.storeNotice().text.includes("başka bir sekmede başka bir seyahat açıldı") && a.storeNotice().text.includes("sayfayı yenile"), a.storeNotice().text);
  assert.equal(a.run('saveLS("dayven",Object.assign(dayVenues,{"2099-01-11":["coba","escobar"]}))'), false);
  a.run('calNotes["2099-01-10"]="not"; saveLS("cal",calNotes)');
  assert.equal(a.storage.raw("asa:ams:dayven"), before.dv); assert.equal(a.storage.raw("asa:ams:cal"), before.cal);
  await a.run("TripSync.flush()"); a.runTimers(); await settle(60);
  assert.equal(a.saves().length, 0, "tab A uploads nothing");
  assert.deepEqual(a.server.trip(7).plan.dayven, P0); assert.deepEqual(a.server.trip(2).plan.dayven, rowB().plan.dayven);
  assert.equal(a.val("TripSync.status"), "error");
  assert.equal(b.val("TripSync.detached()"), false, "the tab that owns the storage is unaffected");
});
test("R1.5b home page picks new dates in another tab (orphan trip, no id): this tab never uploads them into its trip", T, async () => {
  const a = tripOn(row());
  a.storage.setItem("asa:ams:trip", JSON.stringify({ country: "Hollanda", city: "Amsterdam", start_date: "2099-05-01", end_date: "2099-05-03", vacation_types: [] }));
  a.run('calNotes["2099-01-10"]="not"; saveLS("cal",calNotes)');
  await a.run("TripSync.flush()"); a.runTimers(); await settle(60);
  assert.equal(a.saves().length, 0);
  assert.equal(a.server.trip(7).start_date, "2099-01-10"); assert.equal(a.server.trip(7).end_date, "2099-01-12");
  assert.equal(a.storeNotice().hidden, false);
});
test("R1.6 the other tab's date change is kept when a stale open setup form is saved over it", T, async () => {
  const a = tripOn(row()), b = secondTab(a);
  a.run("PSET.edit()");                                                       // tab A's form loaded with 01-10..12
  b.run('PSET.setDate("endDate","2099-01-14")');                              // tab B: unsynced date change
  a.fireStorage("asa:ams:trip");                                              // A's open form is not reset
  a.run("PSET.submit()");                                                     // A saves its (stale) dates
  assert.equal(a.ls("trip").end_date, "2099-01-12");
  const it = items(a).find((x) => x.reason === "tab");
  assert.ok(it, "tab B's version kept"); assert.equal(it.end_date, "2099-01-14");
  assert.equal(a.notice().reason, "tab");
  assert.ok(a.notice().text.includes("Geri yüklersen seyahatinin tarihleri de"), a.notice().text);
  // the same kind of check for plan preferences
  const c = tripOn(row()), d = secondTab(c);
  c.run("PSET.edit()");
  d.run('ASA_ST.set("plan_prefs",{saved:true,tempo:"Yoğun",updated_at:"2099-01-01T00:00:00Z"})');
  c.run("PSET.submit()");
  assert.ok(items(c).some((x) => x.reason === "tab" && x.plan_prefs.tempo === "Yoğun"), JSON.stringify(items(c)));
  // no false alarm in a single tab
  const e = tripOn(row());
  e.run('PSET.setDate("endDate","2099-01-13")'); e.run("PSET.edit()"); e.run("PSET.submit()");
  assert.equal(items(e).length, 0, "own date change is not another tab's");
});

// ================================================================================================ R2 dates are part of the synced version
test("R2.1 unsynced date change + plan days, save failed: reopening keeps the local dates and uploads them with the plan", T, async () => {
  const h = tripOn(row());
  h.server.hooks.rpc = OFF;
  h.run('PSET.setDate("endDate","2099-01-14")');
  const E = J(P0); E["2099-01-13"] = ["oeuf"]; E["2099-01-14"] = ["x1"];
  h.edit("dayven", E);
  await h.run("TripSync.flush()"); await settle();
  assert.equal(h.val("TripSync.status"), "error");
  h.server.hooks.rpc = undefined;
  const k = await reopen(h);
  assert.equal(k.ls("trip").end_date, "2099-01-14", "local dates kept");
  assert.equal(k.server.trip(7).end_date, "2099-01-14", "dates uploaded"); assert.deepEqual(k.server.trip(7).plan.dayven, E);
  assert.deepEqual(days(k), ["2099-01-10", "2099-01-11", "2099-01-12", "2099-01-13", "2099-01-14"]);
  assert.equal(items(k).length, 0); assert.equal(k.notice().hidden, true);
});
test("R2.2 a date change alone (tab closed before any save) is not dropped on reopen", T, async () => {
  const h = tripOn(row());
  h.run('PSET.setDate("endDate","2099-01-14")');
  assert.equal(h.val("TripSync.localState()"), "unsynced", "a date-only change is an unsynced change");
  const k = await reopen(h);
  assert.equal(k.ls("trip").end_date, "2099-01-14");
  assert.equal(k.server.trip(7).end_date, "2099-01-14");
  assert.deepEqual(k.server.trip(7).plan.dayven, P0);
  assert.equal(k.val("TripSync.localState()"), "synced");
});
test("R2.3 restoring a version with other dates, then a failed save and a reopen: the restored dates are kept and saved", T, async () => {
  const h = tripOn(row());
  h.run('PSET.setDate("endDate","2099-01-14")');
  const E = J(P0); E["2099-01-14"] = ["x1"]; h.edit("dayven", E);
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });               // another device saved first
  await h.run("TripSync.flush()"); await settle(60);
  assert.equal(h.notice().reason, "conflict"); assert.equal(h.ls("trip").end_date, "2099-01-12", "DB dates shown");
  assert.ok(h.notice().text.includes("Geri yüklersen seyahatinin tarihleri de"), h.notice().text);
  h.server.hooks.rpc = OFF;
  h.el("tripSyncRestore").click(); await settle(60);
  assert.equal(h.ls("trip").end_date, "2099-01-14"); assert.equal(h.val("TripSync.status"), "error");
  h.server.hooks.rpc = undefined;
  const k = await reopen(h);
  assert.equal(k.ls("trip").end_date, "2099-01-14");
  assert.equal(k.server.trip(7).end_date, "2099-01-14"); assert.deepEqual(k.server.trip(7).plan.dayven, E);
  assert.equal(items(k).length, 0);
});
test("R2.4 date-only local change while the server moved: kept as a version with its dates, user told", T, async () => {
  const h = tripOn(row());
  h.run('PSET.setDate("endDate","2099-01-14")');
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  const k = await reopen(h);
  assert.equal(k.ls("trip").end_date, "2099-01-12", "DB dates and plan shown"); assert.deepEqual(k.val("dayVenues"), P2);
  const it = items(k)[0];
  assert.ok(it); assert.equal(it.trip_id, "7"); assert.equal(it.reason, "replaced"); assert.equal(it.end_date, "2099-01-14");
  assert.equal(k.notice().hidden, false);
  assert.ok(k.notice().text.includes("Geri yüklersen seyahatinin tarihleri de"), k.notice().text);
  assert.equal(k.server.trip(7).end_date, "2099-01-12", "nothing pushed");
});
test("R2.5 the synced marker covers the dates (signature)", T, () => {
  const h = tripOn(row());
  assert.equal(h.val("TripSync.localState()"), "synced");
  h.run('var t=ASA_ST.trip(); t.end_date="2099-01-13"; ASA_ST.set("trip",t)');
  assert.notEqual(h.val("TripSync.localState()"), "synced");
});

// ================================================================================================ R3 legacy "auto" means exactly the generator output
const GUEST_TRIP = { city: "Amsterdam", country: "Hollanda", start_date: "2099-03-03", end_date: "2099-03-05" };
const AUTO_DV = { "2099-03-03": ["oeuf", "x2", "pllek"], "2099-03-04": ["chun"] };
const AUTO_PL = { "2099-03-03": "Sabah: Mekan oeuf (Merkez)\nÖğleden sonra: Mekan x2 (Merkez)\nAkşam: Mekan pllek (Merkez)", "2099-03-04": "Sabah: Mekan chun (Merkez)" };
function legacyGuest(dv, pl, extra = {}) {
  return boot({ storage: fakeStorage(Object.assign({ "asa:ams:trip": JSON.stringify(GUEST_TRIP), "asa:ams:dayven": JSON.stringify(dv), "asa:ams:plan": JSON.stringify(pl) }, extra)) });
}
test("R3.1 (probe L1) legacy guest's edited plan: login creates the trip WITH that plan (nothing wiped)", T, async () => {
  const DV = { "2099-03-03": ["barpif", "chun", "coba", "x1"], "2099-03-04": ["oeuf", "pllek"] };
  const PL = { "2099-03-03": "Sabah: Mekan barpif\nÖğle: Mekan chun\nNOT: 19:30 rezervasyon var!", "2099-03-04": "Sabah: Mekan pllek" };
  const h = legacyGuest(DV, PL); h.useDb();
  assert.equal(h.val("TripSync.localState()"), "unsynced");
  await h.asa.ev("importGuestTrip()"); await settle(); h.runTimers(); await settle();
  const t = h.server.tables.trips[0];
  assert.ok(t, "trip created");
  assert.deepEqual(t.plan.dayven, DV); assert.deepEqual(t.plan.plan, PL);
  assert.deepEqual(h.ls("dayven"), DV); assert.deepEqual(h.ls("plan"), PL);
});
test("R3.2 legacy guest's edited plan + overlapping DB trip: the guest plan is kept as a guest version (not dropped)", T, async () => {
  const PL = Object.assign({}, AUTO_PL, { "2099-03-04": AUTO_PL["2099-03-04"] + "\nNOT: müze kartı al" });
  const h = legacyGuest(AUTO_DV, PL); h.useDb();
  h.server.tables.trips.push(row9());
  await h.asa.ev("importGuestTrip()"); await settle();
  assert.equal(h.val("TRIP && TRIP.id"), 9);
  const it = items(h)[0];
  assert.ok(it, "guest version kept"); assert.equal(it.trip_id, null); assert.deepEqual(it.plan, PL);
  assert.equal(h.notice().reason, "guest");
  assert.deepEqual(h.server.trip(9).plan.dayven, row9().plan.dayven, "nothing pushed");
});
test("R3.3 legacy classification: exact generator output is 'auto'; any edit is 'unsynced'", T, () => {
  assert.equal(legacyGuest(AUTO_DV, AUTO_PL).val("TripSync.localState()"), "auto", "untouched output");
  const variants = {
    "appended line": [AUTO_DV, Object.assign({}, AUTO_PL, { "2099-03-04": AUTO_PL["2099-03-04"] + "\n19:30 rezervasyon" })],
    "extra venue": [Object.assign({}, AUTO_DV, { "2099-03-04": ["chun", "x1"] }), AUTO_PL],
    "removed venue": [Object.assign({}, AUTO_DV, { "2099-03-03": ["oeuf", "pllek"] }), AUTO_PL],
    "reordered venues": [Object.assign({}, AUTO_DV, { "2099-03-03": ["x2", "oeuf", "pllek"] }), AUTO_PL],
    "edited text": [AUTO_DV, Object.assign({}, AUTO_PL, { "2099-03-04": "Sabah: Mekan chun (Merkez) erken git" })],
    "text without venues": [AUTO_DV, Object.assign({}, AUTO_PL, { "2099-03-05": "Sabah: serbest" })],
    "unknown venue": [Object.assign({}, AUTO_DV, { "2099-03-04": ["gone1"] }), Object.assign({}, AUTO_PL, { "2099-03-04": "Sabah: Kapanan yer" })],
  };
  for (const [name, [dv, pl]] of Object.entries(variants)) assert.equal(legacyGuest(dv, pl).val("TripSync.localState()"), "unsynced", name);
  const n = legacyGuest(AUTO_DV, AUTO_PL, { "asa:ams:cal": JSON.stringify({ "2099-03-03": "not" }) });
  assert.equal(n.val("TripSync.localState()"), "unsynced", "a calendar note is a user edit");
});
test("R3.4 the real generator's output on a legacy device is still 'auto' (never kept, never pushed)", T, async () => {
  const h = boot({ gen: true });
  h.run(`ASA_ST.set("trip",${JSON.stringify(GUEST_TRIP)})`); h.run("autoGeneratePlan(false)");
  assert.ok(Object.keys(h.ls("dayven") || {}).length > 0, "precondition: generated");
  assert.equal(h.sync(), null, "no marker: legacy rule applies");
  assert.equal(h.val("TripSync.localState()"), "auto");
});

// ================================================================================================ R5 WP3 stranded plan_prefs
test("R5.1 opening a DB trip without plan_prefs keeps the WP3 'Amsterdam planına aktar' adopt working", T, () => {
  const storage = fakeStorage({ asa_trip: JSON.stringify({ city: "Kopenhag", start_date: "2099-05-01", end_date: "2099-05-03" }), asa_plan_prefs: JSON.stringify({ tempo: "Sakin", saved: true }) });
  const h = boot({ storage });
  assert.equal(storage.raw("asa:ams:plan_prefs"), null, "precondition: stranded, no city key");
  assert.ok(h.storeNotice().text.includes("Amsterdam planına aktarabilirsin"), "precondition: WP3 stranded notice");
  h.server.tables.trips.push(rowE()); h.useDb(); h.open(rowE());
  assert.equal(storage.raw("asa:ams:plan_prefs"), null, "no empty {} written over the stranded legacy value");
  assert.deepEqual(h.val("TripSync.collect().preferences.plan_prefs"), {}, "nothing inherited");
  const btn = h.el("asaStoreNotice").children.find((c) => c.textContent === "Amsterdam planına aktar");
  assert.ok(btn, "WP3 adopt button still offered"); btn.click();
  assert.equal(h.ls("plan_prefs").tempo, "Sakin", "legacy prefs adopted on request");
  assert.ok(h.storeNotice().text.includes("Plan tercihlerin Amsterdam planına aktarıldı"), h.storeNotice().text);
  // library view of the same rule
  const k = boot({ storage: fakeStorage({ asa_trip: JSON.stringify({ city: "Kopenhag" }), asa_plan_prefs: JSON.stringify({ tempo: "Sakin", saved: true }) }) });
  k.open(rowE());
  assert.equal(k.val("AsaStorage.adoptLegacy(localStorage,'ams','plan_prefs').reason"), "adopted");
});

// ================================================================================================ R6 legacy favourites merge
const fav = (list) => boot({ storage: fakeStorage({ "asa:ams:fav": JSON.stringify(list) }) });
test("R6.1 legacy device with the seeded defaults + one own favourite: only the own favourite is uploaded", T, async () => {
  assert.deepEqual(fav([...SEEDS, "x1"]).val('favLoginPlan(["x2"],"u1")').adds, ["x1"]);
  assert.deepEqual(fav([...SEEDS.slice(1), "x1"]).val('favLoginPlan(["x2"],"u1")').adds, ["x1"], "one default removed: the rest are still defaults");
  const h = fav([...SEEDS, "x1"]);
  h.server.tables.favorites.push({ user_id: "u1", venue_id: "x2", city: "Amsterdam" });
  h.useRealAsa(); h.asa.set("db", h.db);
  await h.asa.ev('syncOnLogin("u1","qa",false)'); await settle();
  assert.deepEqual(h.server.favIds("u1"), ["x1", "x2"], "no seed reached the account");
  assert.equal(h.favSync().base, "synced", "one-time merge: the device is synced afterwards");
  const k = bootLike(h); k.useRealAsa(); k.asa.set("db", k.db);
  await k.asa.ev('syncOnLogin("u1","qa",false)'); await settle();
  assert.equal(k.server.rest("favorites", "upsert").length, h.server.rest("favorites", "upsert").length, "no further uploads on the next load");
});
test("R6.2 a curated legacy list (most defaults removed) is uploaded as the user's own favourites (WP3 login union)", T, () => {
  assert.deepEqual(fav(["barpif"]).val('favLoginPlan(["chun","winkel43"],"u1")').adds, ["barpif"], "WP3 contract");
  assert.deepEqual(fav(["barpif", "x1"]).val('favLoginPlan([],"u1")').adds, ["barpif", "x1"]);
  assert.deepEqual(fav(SEEDS).val('favLoginPlan([],"u1")').adds, [], "untouched defaults");
});
