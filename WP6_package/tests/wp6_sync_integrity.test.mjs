// WP6 · sync integrity (D1–D7 + critic amendments). Runs the city page's REAL code (amsterdam/index.html, and the
// TripStore helper of index.html) in a vm sandbox through ./_page.mjs: real ASA_ST + lib/asa-storage on a fake Storage,
// real FAVORITES / TripStore / TripSync / KONUM / CALENDAR / PSET blocks and the real membership closure, a fake Supabase
// client whose trip_save/trip_snapshot_plan semantics copy the dry-run shim (revision conflict), fake timers, a mini DOM.
//   node --test WP6_package/tests/
// Test data only: user ids like "u1", trip ids 1..20, years 2099; no e-mail addresses, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { boot, bootLike, fakeStorage, fakeDb, read, fnSrc, pageBlock, asaClosureBody, settle, J, SEEDS } from "./_page.mjs";

const CITY_HTML = read("amsterdam/index.html");
const HOME_HTML = read("index.html");
const T = { timeout: 10000 };

// ------------------------------------------------------------------------------------------------ fixtures
const P0 = { "2099-01-10": ["barpif", "chun"], "2099-01-11": ["coba"] };                       // last synced plan
const P1 = { "2099-01-10": ["barpif", "chun", "x1"], "2099-01-11": ["coba"] };                 // this device's unsynced edit
const P2 = { "2099-01-10": ["chun"], "2099-01-11": ["coba", "x2"], "2099-01-12": ["x3"] };     // newer plan from another device
function row(o = {}) {
  return Object.assign({
    id: 7, revision: 5, user_id: "u1", city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12",
    timezone: "Europe/Amsterdam", setup_completed: true, archived_at: null, plan_version: 0,
    preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli" } },
    plan: { dayven: J(P0), cal: {}, plan: { "2099-01-10": "Kahve molası" } },
  }, J(o));
}
const CAL_A = { "2099-01-10": "Müze bileti 10:00" };   // trip A's calendar note (D4.1: must never be inherited by another trip)
const rowA = () => row({ id: 1, revision: 5, preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli", accommodation: { lat: 1, lng: 2, label: "X" } } }, plan: { dayven: J(P0), cal: J(CAL_A), plan: { "2099-01-10": "Kahve molası" } } });
const rowE = () => row({ id: 2, revision: 1, start_date: "2099-02-01", end_date: "2099-02-02", setup_completed: false, preferences: {}, plan: null });
const rowB = () => row({ id: 2, revision: 3, start_date: "2099-02-10", end_date: "2099-02-12", plan: { dayven: { "2099-02-10": ["pllek"], "2099-02-11": ["oeuf", "x1"] }, cal: {}, plan: {} } });
const row9 = () => row({ id: 9, revision: 4, start_date: "2099-03-01", end_date: "2099-03-10", preferences: { plan_prefs: { saved: true, tempo: "Yoğun" } }, plan: { dayven: { "2099-03-02": ["a"] }, cal: {}, plan: {} } });
const GUEST_TRIP = { city: "Amsterdam", country: "Hollanda", start_date: "2099-03-03", end_date: "2099-03-05" };
const G = { "2099-03-03": ["x1", "x2"] };

// a device that has opened `r` (TRIP=r, TripSync.adopt(r)); the fake server holds the same row
function tripOn(r, opts = {}) {
  const h = boot(opts);
  if (!h.server.trip(r.id)) h.server.tables.trips.push(J(r));
  h.useDb();
  h.open(r);
  return h;
}
// another device saves the trip: patch + revision bump (what trip_save does on the server)
function serverEdit(h, id, patch) { const r = h.server.trip(id); Object.assign(r, J(patch)); r.revision++; return J(r); }
function spyStore(h, gate) {
  const S = h.useDb(), calls = [];
  for (const k of ["findOverlap", "findOverlapChecked", "create", "get"]) {
    if (typeof S[k] !== "function") continue;
    const f = S[k];
    S[k] = async (...a) => { calls.push([k, J(a)]); if (gate && /findOverlap/.test(k) && gate.first) { gate.first = false; await gate.p; } return f(...a); };
  }
  return calls;
}
function gateP() { const g = { first: true }; g.p = new Promise((r) => (g.open = r)); return g; }
function storeFor(html, db) { const c = vm.createContext({}); c.window = c; vm.runInContext(pageBlock(html, "TRIPSTORE"), c); return c.createTripStore(db); }
const timers1200 = (h) => h.timers().filter((t) => t.ms === 1200).length;
const items = (h) => ((h.sync() || {}).items || []);
async function conflictState(opts) {
  const h = tripOn(row(), opts);
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });            // rev 6 on the server (another device)
  h.edit("dayven", P1);                                                     // stale device edits rev 5
  await h.run("TripSync.flush()");
  await settle();
  return h;
}
const NOTICE_HEAD = "Bu cihazda kaydedilmemiş bir plan sürümü var";

// ================================================================================================ S0 aux store
test("S0.1 aux store: plan_sync / fav_sync round trip under asa:ams:<name>", T, () => {
  const h = boot();
  assert.equal(h.run('ASA_ST.aux.set("plan_sync",{a:1})'), true);
  assert.equal(h.storage.raw("asa:ams:plan_sync"), '{"a":1}');
  assert.deepEqual(h.val('ASA_ST.aux.read("plan_sync")'), { present: true, value: { a: 1 } });
  assert.deepEqual(h.val('ASA_ST.aux.read("fav_sync")'), { present: false, value: null });
  assert.equal(h.run('ASA_ST.aux.set("fav_sync",{v:1})'), true);
  assert.equal(h.storage.raw("asa:ams:fav_sync"), '{"v":1}');
});
test("S0.2 aux store: unknown names throw TypeError invalid_aux", T, () => {
  const h = boot();
  for (const c of ['ASA_ST.aux.read("x")', 'ASA_ST.aux.set("x",{})', 'ASA_ST.aux.read("trip")', 'ASA_ST.aux.set("fav",[])'])
    assert.throws(() => h.run(c), (e) => e && e.name === "TypeError" && /invalid_aux/.test(e.message), c);
});
test("S0.3 aux store: locked city (Kopenhag) and missing library touch no asa:* key", T, () => {
  for (const o of [{ city: "Kopenhag" }, { lib: false }]) {
    const h = boot(o);
    h.storage.log.length = 0;
    assert.deepEqual(h.val('ASA_ST.aux.read("plan_sync")'), { present: false, value: null }, JSON.stringify(o));
    assert.equal(h.run('ASA_ST.aux.set("plan_sync",{a:1})'), false, JSON.stringify(o));
    assert.equal(h.run('ASA_ST.aux.set("fav_sync",{a:1})'), false, JSON.stringify(o));
    assert.deepEqual(h.storage.log.filter(([, k]) => k.startsWith("asa:")), [], JSON.stringify(o));
  }
});
test("S0.4 aux store: corrupt or non-object value reads as present with value null", T, () => {
  for (const raw of ["{bad", "[1,2]", '"x"']) {
    const h = boot({ storage: fakeStorage({ "asa:ams:plan_sync": raw }) });
    assert.deepEqual(h.val('ASA_ST.aux.read("plan_sync")'), { present: true, value: null }, raw);
  }
});
test("S0.5 static: raw localStorage literal keys stay asa_session only (WP5 rule); lib untouched by the page", T, () => {
  const calls = CITY_HTML.match(/localStorage\.(getItem|setItem|removeItem)\(\s*["'][^"']*["']/g) || [];
  for (const c of calls) assert.match(c, /"asa_session"$/, c);
  assert.ok(!/["']asa:ams:(plan_sync|fav_sync)["']/.test(CITY_HTML), "aux keys are built by ASA_ST (asa:+CODE+:name), never literal");
});
test("S0.6 contract: anonymous reload + init make zero storage writes (WP3 'reload: zero writes')", T, async () => {
  const h0 = boot(); // first visit seeds favourites once
  const h = bootLike(h0);
  h.server.session = { data: { session: null }, error: null };
  h.storage.log.length = 0;
  await h.asa.ev("init()");
  await settle();
  assert.deepEqual(h.storage.log.filter(([op]) => op !== "get"), []);
});

// ================================================================================================ D1 conflicts
test("D1.1 TripStore.saveWithRetry never re-sends on a conflict (both pages, identical helper)", T, async () => {
  assert.equal(pageBlock(CITY_HTML, "TRIPSTORE"), pageBlock(HOME_HTML, "TRIPSTORE"), "TripStore helper byte-identical in amsterdam/index.html and index.html");
  for (const [name, html] of [["amsterdam", CITY_HTML], ["home", HOME_HTML]]) {
    const { db, server } = fakeDb();
    server.tables.trips.push(row({ revision: 6, plan: { dayven: P2, cal: {}, plan: {} } }));
    const S = storeFor(html, db);
    const res = J(await S.saveWithRetry(7, 5, { plan: { dayven: P1 } }));
    assert.equal(server.rpcs("trip_save").length, 1, name + ": exactly one trip_save");
    assert.equal(res.ok, false, name); assert.equal(res.reason, "conflict", name); assert.equal(res.conflict, true, name);
    assert.deepEqual(server.trip(7).plan.dayven, P2, name + ": server plan unchanged");
    assert.equal(server.trip(7).revision, 6, name);
  }
});
test("D1.1b static: no blind retry left (saveWithRetry, flush, snapshot)", T, () => {
  const ts = pageBlock(CITY_HTML, "TRIPSTORE");
  const swr = ts.slice(ts.indexOf("T.saveWithRetry="), ts.indexOf("\n", ts.indexOf("T.saveWithRetry=")));
  assert.equal((swr.match(/T\.save\(/g) || []).length, 1, "one T.save in saveWithRetry");
  assert.ok(!/reconciled/.test(ts), "res.reconciled is gone");
  const sync = pageBlock(CITY_HTML, "TRIPSYNC");
  assert.ok(/TS\.serial\s*=/.test(sync), "TS.serial defined");
  assert.ok(!/res\.server\.revision/.test(sync), "TripSync never adopts res.server.revision");
  const snap = sync.slice(sync.indexOf("window.__snapshotPlan="));
  assert.ok(!/res\.server/.test(snap), "__snapshotPlan never retries with res.server");
});
test("D1.2 conflict: newer server plan kept, local version preserved, accessible notice", T, async () => {
  const h = await conflictState();
  assert.equal(h.saves().length, 1, "exactly one trip_save (no re-send with the server revision)");
  assert.deepEqual(h.server.trip(7).plan.dayven, P2, "server plan NOT overwritten");
  assert.deepEqual(h.ls("dayven"), P2, "device storage adopted the server plan");
  assert.deepEqual(h.val("dayVenues"), P2, "page memory adopted the server plan");
  assert.equal(h.val("TRIP.revision"), 6);
  const it = items(h)[0];
  assert.ok(it, "a plan_sync record exists");
  assert.equal(it.trip_id, "7"); assert.equal(it.reason, "conflict"); assert.deepEqual(it.dayven, P1);
  assert.equal(h.val("TripSync.status"), "conflict");
  const n = h.notice();
  assert.equal(n.hidden, false); assert.equal(n.role, "alert"); assert.equal(n.reason, "conflict");
  assert.ok(n.text.includes(NOTICE_HEAD), n.text);
  assert.ok(n.text.includes("Bu seyahatin planı başka bir cihazda ya da sekmede değiştirildi. Sunucudaki daha yeni plan yüklendi ve şu an o gösteriliyor."), n.text);
  assert.ok(n.text.includes("Bu cihazdaki sürüm silinmedi; bu cihazda saklanıyor ("), n.text);
  assert.equal(h.el("tripSyncRestore").textContent, "Bu cihazdaki sürümü geri yükle");
  assert.equal(h.el("tripSyncDiscard").textContent, "Sunucudaki planla devam et");
  h.runTimers(); await settle();
  assert.equal(h.saves().length, 1, "no further trip_save after all timers ran");
  assert.deepEqual(h.server.trip(7).plan.dayven, P2);
});
test("D1.3 restore is explicit: Restore uploads the kept version with the server revision", T, async () => {
  const h = await conflictState();
  const n0 = h.saves().length;
  h.el("tripSyncRestore").click();
  await settle();
  const s = h.saves()[n0];
  assert.ok(s, "restore triggers a trip_save");
  assert.equal(s.args.p_expected_rev, 6);
  assert.deepEqual(s.args.p_patch.plan.dayven, P1);
  assert.deepEqual(h.server.trip(7).plan.dayven, P1);
  assert.equal(items(h).length, 0, "record dropped after restore");
  assert.equal(h.dom.document.activeElement && h.dom.document.activeElement.id, "tripSyncClose", "focus on Kapat");
  assert.ok(h.notice().text.includes("Bu cihazdaki sürüm geri yüklendi ve seyahatine kaydediliyor."), h.notice().text);
  h.el("tripSyncClose").click();
  assert.equal(h.notice().hidden, true);
});
test("D1.4 discard keeps the server plan and makes no server write", T, async () => {
  const h = await conflictState();
  const n0 = h.saves().length;
  h.el("tripSyncDiscard").click();
  await settle(); h.runTimers(); await settle();
  assert.equal(items(h).length, 0);
  assert.equal(h.saves().length, n0, "no trip_save");
  assert.deepEqual(h.ls("dayven"), P2);
  assert.ok(h.notice().text.includes("Sunucudaki planla devam ediliyor. Bu cihazdaki sürüm silindi."), h.notice().text);
  assert.equal(h.dom.document.activeElement && h.dom.document.activeElement.id, "tripSyncClose");
});
test("D1.5 identical content with a stale revision adopts silently", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P1, cal: {}, plan: { "2099-01-10": "Kahve molası" } } });
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  assert.equal(items(h).length, 0, "no record");
  assert.equal(h.notice().hidden, true);
  assert.equal(h.val("TripSync.status"), "saved");
  assert.equal(h.val("TRIP.revision"), 6);
  assert.deepEqual(h.server.trip(7).plan.dayven, P1);
});
test("D1.6 rebase when only the revision moved (snapshot elsewhere)", T, async () => {
  const h = tripOn(row());
  await h.db.rpc("trip_snapshot_plan", { p_id: 7, p_reason: "initial", p_expected_rev: 5 });   // rev 6, same content
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle(60);
  assert.deepEqual(h.saves().map((s) => s.args.p_expected_rev), [5, 6]);
  assert.deepEqual(h.server.trip(7).plan.dayven, P1, "local edit reached the server");
  assert.equal(h.notice().hidden, true); assert.equal(items(h).length, 0);
  assert.equal(h.val("TripSync.status"), "saved");
});
test("D1.7 a non-conflict failure never adopts res.server.revision", T, async () => {
  const h = tripOn(row());
  h.server.hooks.rpc = (n) => (n === "trip_save" ? { data: { ok: false, reason: "net", server: { revision: 9 } }, error: null } : undefined);
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  assert.equal(h.val("TRIP.revision"), 5);
  assert.equal(h.val("TripSync.status"), "error");
});
test("D1.8 conflict with an unreadable server row: error, nothing adopted, nothing overwritten", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.server.hooks.rest = (c) => (c.table === "trips" && c.op === "select" && c.filters.some((f) => f[1] === "id") ? { data: null, error: null } : undefined);
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  assert.equal(h.val("TripSync.status"), "error");
  assert.equal(h.val("TRIP.revision"), 5);
  assert.deepEqual(h.ls("dayven"), P1, "local storage unchanged");
  assert.equal(items(h).length, 0, "no record");
  assert.equal(h.saves().length, 1);
  assert.deepEqual(h.server.trip(7).plan.dayven, P2, "server plan not overwritten");
});
test("D1.9 in-flight guard: flushes never overlap and coalesce while queued", T, async () => {
  const h = tripOn(row());
  h.server.hold = true;
  h.edit("dayven", P1);
  const p1 = h.run("TripSync.flush()");
  await settle(8);
  assert.equal(h.saves().length, 1, "first save in flight");
  const P1b = J(P1); P1b["2099-01-12"] = ["pllek"];
  h.edit("dayven", P1b);
  const p2 = h.run("TripSync.flush()"), p3 = h.run("TripSync.flush()");
  assert.ok(p2 === p3, "a queued flush is returned again (coalesced)");
  assert.ok(p1 !== p2);
  for (let i = 0; i < 8; i++) { h.server.release(); await settle(10); }
  await p1; await p2; await settle();
  assert.equal(h.server.maxInflight, 1, "never two trip_save at once");
  assert.equal(h.saves().length, 2);
  assert.deepEqual(h.saves()[1].args.p_patch.plan.dayven, P1b, "second save carries the edit made during the first");
  assert.deepEqual(h.server.trip(7).plan.dayven, P1b);
});
test("D1.10 a snapshot conflict is never retried with the server revision", T, async () => {
  const h = tripOn(row());
  let bumped = false;
  h.server.hooks.afterSave = (r) => { if (!bumped) { bumped = true; r.revision++; } };   // another tab writes right after our save
  await h.run("__snapshotPlan()"); await settle(60);
  const calls = h.server.calls;
  const snaps = calls.map((c, i) => [c, i]).filter(([c]) => c.kind === "rpc" && c.name === "trip_snapshot_plan");
  assert.equal(snaps.length, 1, "one trip_snapshot_plan");
  const reread = calls.findIndex((c, i) => i > snaps[0][1] && c.kind === "rest" && c.table === "trips" && c.op === "select" && c.filters.some((f) => f[1] === "id"));
  assert.ok(reread > 0, "the client re-reads the trip after the snapshot conflict");
});
test("D1.11 (critic 1 · r2) two tabs on one device: the stale tab rebases onto the other tab's save; nothing overwritten, no copy", T, async () => {
  const t1 = tripOn(row());
  const t2 = bootLike(t1); t2.useDb(); t2.open(row());
  const TAB2 = J(P0); TAB2["2099-01-12"] = ["pllek"];
  t2.edit("dayven", TAB2);
  await t2.run("TripSync.flush()"); await settle();
  assert.equal(t1.server.trip(7).revision, 6);
  assert.equal(String((t1.sync().synced || {}).rev), "6", "plan_sync.synced records the saved revision");
  t1.run('dayVenues["2099-01-11"]=["coba","escobar"]; saveLS("dayven",dayVenues)');   // stale tab: its memory still holds rev 5
  const TAB1 = J(P0); TAB1["2099-01-11"] = ["coba", "escobar"];
  await t1.run("TripSync.flush()"); await settle(60);
  // tab 1's save applied only its own day onto the shared storage (which already holds tab 2's saved rev 6), so after the
  // conflict tab 1 moves onto rev 6 (same device saved it) and sends the merge once: both tabs' edits reach the server
  const BOTH = Object.assign(J(TAB2), { "2099-01-11": TAB1["2099-01-11"] });
  assert.deepEqual(t1.server.trip(7).plan.dayven, BOTH, "server keeps tab 2's day and gets tab 1's day");
  const s1 = t1.saves().slice(1);
  assert.equal(s1.length, 2, "tab 1: one conflicting save, one rebased save");
  assert.equal(s1[0].args.p_expected_rev, 5); assert.equal(s1[1].args.p_expected_rev, 6);
  assert.deepEqual(s1[1].args.p_patch.plan.dayven, BOTH, "the rebased save never drops tab 2's day");
  assert.equal(items(t1).length, 0, "no conflict copy for a same-device tab");
  assert.equal(t1.notice().hidden, true);
  assert.equal(t1.val("TripSync.status"), "saved");
  assert.equal(t1.val("TRIP.revision"), 7);
});
test("D1.12 (critic 2) the rebase/conflict loop is bounded", T, async () => {
  // A: server revision moved (content = base) but every trip_save conflicts → exactly 2 saves, then error
  const h = tripOn(row());
  h.server.trip(7).revision = 6;
  h.server.hooks.rpc = (n) => (n === "trip_save" ? { data: { ok: false, reason: "conflict", server: { revision: 99 } }, error: null } : undefined);
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle(120);
  h.runTimers(); await settle(60);
  assert.equal(h.saves().length, 2, "rebase at most once");
  assert.equal(h.val("TripSync.status"), "error");
  assert.notEqual(h.val("TRIP.revision"), 99, "never adopts res.server.revision");
  assert.ok(h.server.rest("trips", "select").length >= 1, "re-read the row");
  // B: the server revision does not move at all → no rebase
  const k = tripOn(row());
  k.server.hooks.rpc = (n) => (n === "trip_save" ? { data: { ok: false, reason: "conflict" }, error: null } : undefined);
  k.edit("dayven", P1);
  await k.run("TripSync.flush()"); await settle(120); k.runTimers(); await settle(60);
  assert.ok(k.saves().length <= 2, "bounded: " + k.saves().length);
  assert.equal(k.val("TripSync.status"), "error");
});
test("D1.13 (critic 10) Discard acts only on the version shown; the next one is offered after Kapat", T, async () => {
  const h = boot();
  h.edit("dayven", G);                                 // guest plan, never synced
  h.server.tables.trips.push(row()); h.useDb(); h.open(row());
  assert.equal(h.notice().reason, "guest");
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  assert.equal(h.val("TripSync.pending().length"), 2);
  assert.equal(h.notice().reason, "conflict", "newest record shown first");
  h.el("tripSyncDiscard").click(); await settle();
  const left = items(h);
  assert.equal(left.length, 1, "only the shown record was discarded");
  assert.equal(left[0].trip_id, null); assert.deepEqual(left[0].dayven, G);
  h.el("tripSyncClose").click();
  assert.equal(h.notice().hidden, false); assert.equal(h.notice().reason, "guest");
  assert.equal(h.saves().length, 1);
});
async function guestOnTrip9(opts = {}) {
  const h = boot(opts);
  h.run(`ASA_ST.set("trip",${JSON.stringify(GUEST_TRIP)})`);      // home search form (guest)
  h.edit("dayven", G); h.edit("cal", { "2099-03-03": "Müzeye git" });
  h.server.tables.trips.push(row9());
  const calls = spyStore(h);
  await h.asa.ev("importGuestTrip()"); await settle();
  return { h, calls };
}
test("D1.14 (critic 10) restoring a version with other dates warns first or keeps the trip's dates", T, async () => {
  const { h } = await guestOnTrip9();
  const txt = h.notice().text;
  const warned = txt.includes("Geri yüklersen seyahatinin tarihleri de 3 Mar–5 Mar 2099 olarak değişir.");
  assert.ok(txt.includes("Bu sürümün tarihleri: 3 Mar–5 Mar 2099."), txt);
  h.el("tripSyncRestore").click(); await settle();
  const s = h.saves()[0];
  assert.ok(s, "restore saves");
  assert.deepEqual(s.args.p_patch.plan.dayven, G);
  assert.ok(warned || s.args.p_patch.start_date === "2099-03-01", "dates silently changed without a warning: " + s.args.p_patch.start_date);
});
test("D1.15 (critic 10) Restore while the trip is blocked (storage full) tells the user", T, async () => {
  const h = await conflictState();
  const srv = J(h.server.trip(7));
  const k = bootLike(h);
  k.storage.failOn("asa:ams:dayven");
  k.useDb(); k.open(srv);
  assert.equal(k.val("TripSync.blocked"), "7");
  const b = k.el("tripSyncRestore");
  if (b && !b.disabled && !b.classList.contains("hide")) {
    k.sb.__alerts.length = 0;
    b.click(); await settle();
    assert.ok(k.sb.__alerts.some((m) => /depolaması dolu/.test(m)), "storage-full message shown: " + JSON.stringify(k.sb.__alerts));
  }
  assert.equal(k.saves().length, 1, "no upload while blocked");
});

// ================================================================================================ D2 dates before hydrate
const TRIP_A_LOCAL = { id: 1, revision: 2, city: "Amsterdam", country: "Hollanda", start_date: "2099-01-01", end_date: "2099-01-03" };
test("D2.1 adopt writes the DB dates before PSET and CAL reload; open Plan tab re-renders the saved plan", T, () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(TRIP_A_LOCAL), "asa:ams:dayven": JSON.stringify({ "2099-01-01": ["barpif"] }) }) });
  h.run("PSET._reload()");
  h.run("var __seen=[]; var __o=PSET._reload; PSET._reload=function(){ __seen.push((ASA_ST.trip()||{}).start_date); return __o.apply(this,arguments); };");
  h.sb.__renderCal.length = 0;
  h.server.tables.trips.push(rowB()); h.useDb();
  h.open(rowB());
  assert.deepEqual(h.val("__seen"), ["2099-02-10"], "PSET reloads after asa:ams:trip has the DB dates");
  assert.deepEqual(J(h.sb.__renderCal.at(-1)), ["2099-02-10", "2099-02-11", "2099-02-12"], "CAL rebuilt from the DB trip and re-rendered");
  assert.equal(h.val("CAL.sample"), false);
  const p = h.val("PSET.getPrefs()");
  assert.equal(p.startDate, "2099-02-10"); assert.equal(p.endDate, "2099-02-12");
  assert.deepEqual(h.val("dayVenues"), rowB().plan.dayven);
});
test("D2.2 fresh device: sample calendar before, DB trip days after adopt", T, () => {
  const h = boot();
  assert.equal(h.val("CAL.sample"), true);
  h.useDb(); h.open(rowB());
  assert.equal(h.val("CAL.sample"), false);
  assert.deepEqual(h.val("CAL.days.map(d=>d.key)"), ["2099-02-10", "2099-02-11", "2099-02-12"]);
});
test("D2.3 after adopt, collect() and savePrefs carry the DB trip's dates (never the previous trip's)", T, async () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(TRIP_A_LOCAL) }) });
  h.server.tables.trips.push(rowB()); h.useDb();
  h.open(rowB());
  const c = h.val("TripSync.collect()");
  assert.equal(c.start_date, "2099-02-10"); assert.equal(c.end_date, "2099-02-12");
  h.run("PSET.submit()");
  assert.equal(h.ls("trip").start_date, "2099-02-10");
  await h.run("TripSync.flush()"); await settle();
  const s = h.saves().at(-1);
  assert.equal(s.args.p_patch.start_date, "2099-02-10"); assert.equal(s.args.p_patch.end_date, "2099-02-12");
  assert.equal(h.server.trip(2).start_date, "2099-02-10");
});
test("D2.4 static: loadTripContext delegates to TripSync.adopt; afterAuth routes ?trip= to loadTripContext", T, () => {
  const body = asaClosureBody(CITY_HTML);
  const ltc = fnSrc(body, "  async function loadTripContext(){");
  assert.ok(ltc.includes("TripSync.adopt(t)"), "adopt");
  assert.ok(!ltc.includes(".hydrate("), "no direct hydrate");
  assert.ok(!ltc.includes('ASA_ST.set("trip"'), "no stale trip merge");
  const aa = fnSrc(body, "  async function afterAuth(user){");
  assert.ok(aa.includes("if(asaTripParam()) await loadTripContext(); else await importGuestTrip();"), "afterAuth routing");
});
test("D2.5 loadTripContext: opens ?trip=, writes its dates, guarded against a second fetch", T, async () => {
  const h = boot({ search: "?trip=2&city=Amsterdam" });
  h.server.tables.trips.push(rowB()); h.useDb();
  await h.asa.ev("loadTripContext()"); await settle();
  assert.equal(h.val("TRIP.id"), 2);
  assert.equal(h.ls("trip").start_date, "2099-02-10");
  assert.deepEqual(h.val("dayVenues"), rowB().plan.dayven);
  const gets = h.server.rest("trips", "select").length;
  await h.asa.ev("loadTripContext()"); await settle();
  assert.equal(h.server.rest("trips", "select").length, gets, "already loaded: no second fetch");
});
test("D2.6 Plan tab opened before the trip loads: no generated plan kept, DB plan shown, nothing uploaded", T, async () => {
  const h = boot({ gen: true, search: "?trip=7&city=Amsterdam" });
  h.server.tables.trips.push(row()); h.useDb();
  h.run("ensurePlan()");                                     // sample days g1..g5 auto-generated
  assert.ok(Object.keys(h.ls("dayven") || {}).some((k) => /^g\d+$/.test(k)), "precondition: auto plan written");
  await h.asa.ev("loadTripContext()"); await settle();
  assert.deepEqual(h.val("CAL.days.map(d=>d.key)"), ["2099-01-10", "2099-01-11", "2099-01-12"]);
  assert.deepEqual(h.val("dayVenues"), P0);
  assert.equal(items(h).length, 0, "auto output is not kept as an unsaved version");
  assert.equal(h.notice().hidden, true);
  h.runTimers(); await settle();
  for (const s of h.saves()) assert.ok(!Object.keys((s.args.p_patch.plan || {}).dayven || {}).some((k) => /^g\d+$/.test(k)), "no g-keys uploaded");
  assert.deepEqual(h.server.trip(7).plan.dayven, P0);
});

// ================================================================================================ D3 guest import
test("D3.1 ?trip= page: importGuestTrip does nothing (no overlap query, no create, storage unchanged)", T, async () => {
  const h = boot({ search: "?trip=9&city=Amsterdam" });
  h.run(`ASA_ST.set("trip",${JSON.stringify(GUEST_TRIP)})`);
  h.server.tables.trips.push(row9());
  const calls = spyStore(h);
  const before = JSON.stringify(h.storage.dump());
  await h.asa.ev("importGuestTrip()"); await settle();
  assert.deepEqual(calls.filter(([k]) => /findOverlap|create/.test(k)), []);
  assert.equal(JSON.stringify(h.storage.dump()), before);
});
test("D3.1b login on a ?trip= page opens that trip and never runs the guest import first", T, async () => {
  const h = boot({ search: "?trip=9&city=Amsterdam" });
  h.run(`ASA_ST.set("trip",${JSON.stringify(GUEST_TRIP)})`);
  h.server.tables.trips.push(row9());
  const calls = spyStore(h);
  h.asa.set("db", h.db);
  await h.asa.ev('afterAuth({id:"u1",email:"qa"})'); await settle();
  assert.equal(h.val("TRIP && TRIP.id"), 9);
  assert.deepEqual(calls.filter(([k]) => /findOverlap|create/.test(k)), [], "no guest import on a ?trip= page");
  assert.equal(h.server.rest("trips", "insert").length, 0);
  assert.equal(h.ls("trip").id, 9);
  assert.equal(h.ls("trip").start_date, "2099-03-01");
});
test("D3.2 a failed overlap check is never 'no overlap' (no create); helper contract on both pages", T, async () => {
  const h = boot();
  h.run(`ASA_ST.set("trip",${JSON.stringify(GUEST_TRIP)})`);
  const S = h.useDb(); let created = 0;
  S.findOverlapChecked = async () => ({ ok: false });
  S.findOverlap = async () => null;                       // the old contract: null on error
  const cr = S.create; S.create = async (...a) => { created++; return cr(...a); };
  await h.asa.ev("importGuestTrip()"); await settle();
  assert.equal(created, 0, "no create after a failed overlap check");
  assert.equal(h.val("typeof TRIP==='undefined' || !TRIP"), true);
  for (const [name, html] of [["amsterdam", CITY_HTML], ["home", HOME_HTML]]) {
    const { db, server } = fakeDb();
    server.hooks.rest = (c) => (c.table === "trips" && c.op === "select" ? { data: null, error: { message: "x" } } : undefined);
    const TS = storeFor(html, db);
    assert.equal(typeof TS.findOverlapChecked, "function", name);
    assert.deepEqual(J(await TS.findOverlapChecked("Amsterdam", "2099-03-03", "2099-03-05")), { ok: false }, name);
    assert.equal(await TS.findOverlap("Amsterdam", "2099-03-03", "2099-03-05"), null, name);
    const r = J(await TS.create({ city: "Amsterdam", start_date: "2099-03-03", end_date: "2099-03-05" }));
    assert.equal(r.ok, false, name); assert.equal(r.reason, "dup_check_failed", name);
    assert.equal(server.rest("trips", "insert").length, 0, name + ": no insert");
  }
});
test("D3.3 existing overlapping DB trip: its dates/prefs/plan win, guest plan kept, user told, nothing pushed", T, async () => {
  const { h } = await guestOnTrip9();
  const t = h.ls("trip");
  assert.equal(t.id, 9); assert.equal(t.start_date, "2099-03-01"); assert.equal(t.end_date, "2099-03-10");
  assert.deepEqual(h.ls("dayven"), row9().plan.dayven);
  assert.equal(h.ls("plan_prefs").tempo, "Yoğun");
  const it = items(h)[0];
  assert.ok(it, "guest record"); assert.equal(it.trip_id, null); assert.deepEqual(it.dayven, G);
  const sn = h.storeNotice();
  assert.equal(sn.hidden, false);
  for (const s of ["farklı", "3 Mar–5 Mar 2099", "1 Mar–10 Mar 2099", "Hesabındaki seyahat açıldı"]) assert.ok(sn.text.includes(s), s + " in " + sn.text);
  assert.equal(h.notice().reason, "guest");
  assert.ok(h.notice().text.includes("Bu cihazda hesabına bağlı olmayan bir plan vardı."), h.notice().text);
  assert.equal(h.saves().length, 0, "no trip_save");
  assert.equal(h.val("TripSync.collect()").start_date, "2099-03-01");
  h.runTimers(); await settle();
  assert.equal(h.server.trip(9).start_date, "2099-03-01", "DB dates untouched");
});
test("D3.4 guest trip re-read after the overlap await; a create never uses stale dates", T, async () => {
  const h = boot();
  h.run(`ASA_ST.set("trip",${JSON.stringify(GUEST_TRIP)})`);
  h.edit("dayven", G);
  const g = gateP();
  const calls = spyStore(h, g);
  const p = h.asa.ev("importGuestTrip()");
  await settle(6);
  h.run('var __t=ASA_ST.trip(); __t.start_date="2099-03-04"; ASA_ST.set("trip",__t)');   // e.g. the Plan form, during the await
  g.open(); await p; await settle();
  const ins = h.server.rest("trips", "insert");
  assert.ok(ins.length <= 1, "at most one trip created");
  if (ins.length === 1) {
    assert.equal(ins[0].value.start_date || [].concat(ins[0].value)[0].start_date, "2099-03-04", "created with the re-read dates");
    const ci = calls.findIndex(([k]) => k === "create");
    const lastCheck = calls.slice(0, ci).filter(([k]) => /findOverlap/.test(k)).at(-1);
    assert.ok(lastCheck && lastCheck[1][1] === "2099-03-04", "overlap re-checked for the dates actually created: " + JSON.stringify(lastCheck));
    const t = h.ls("trip");
    assert.ok(t.id != null); assert.equal(t.start_date, "2099-03-04");
    const sv = h.saves();
    assert.equal(sv.length, 1, "guest plan pushed once");
    assert.equal(sv[0].args.p_patch.start_date, "2099-03-04");
    assert.deepEqual(sv[0].args.p_patch.plan.dayven, G);
  } else {
    assert.equal(h.saves().length, 0);
    assert.equal(h.ls("trip").start_date, "2099-03-04", "the newer local dates are kept");
  }
});
test("D3.5 (critic 3) create branch after home saveTrip (other dates): another trip's synced plan is not pushed", T, async () => {
  const h1 = tripOn(rowA());
  h1.storage.setItem("asa:ams:trip", JSON.stringify({ country: "Hollanda", city: "Amsterdam", start_date: "2099-03-01", end_date: "2099-03-03", vacation_types: [] }));   // home writes the new search (no id)
  const h = bootLike(h1);
  spyStore(h);
  await h.asa.ev("importGuestTrip()"); await settle();
  const ins = h.server.rest("trips", "insert");
  assert.equal(ins.length, 1, "guest trip created");
  assert.equal(h.storage.raw("asa:ams:dayven"), "{}", "new trip starts empty");
  for (const s of h.saves()) assert.notDeepEqual(((s.args.p_patch || {}).plan || {}).dayven, rowA().plan.dayven, "trip 1's plan pushed into the new trip");
  const t = h.ls("trip"); assert.ok(t.id != null && String(t.id) !== "1"); assert.equal(t.start_date, "2099-03-01");
  assert.equal(items(h).length, 0, "a synced copy of another trip is cleared silently");
});

// ================================================================================================ D4 DB authoritative
test("D4.1 a new / empty DB trip inherits nothing from the previous trip", T, () => {
  const h = tripOn(rowA());
  assert.deepEqual(h.val("calNotes"), CAL_A, "precondition: trip A's note is on the device");
  h.server.tables.trips.push(rowE());
  h.open(rowE());
  for (const k of ["dayven", "cal", "plan", "plan_prefs"]) assert.equal(h.storage.raw("asa:ams:" + k), "{}", k);
  assert.deepEqual(h.val("TripSync.collect().plan.cal"), {}, "no calendar note of trip A in the upload");
  assert.deepEqual(h.val("calNotes"), {}, "no calendar note of trip A in memory");
  const t = h.ls("trip");
  assert.equal(t.id, 2); assert.ok(!("plan_prefs" in t), "no plan_prefs mirror"); assert.ok(!("vacation_types" in t), "no vacation_types");
  const c = h.val("TripSync.collect()");
  assert.deepEqual(c.plan.dayven, {}); assert.deepEqual(c.preferences.plan_prefs, {});
  assert.equal(c.preferences.accommodation, null); assert.equal(c.setup_completed, false);
  assert.equal(items(h).length, 0); assert.equal(h.notice().hidden, true);
  assert.deepEqual(h.val("dayVenues"), {});
});
test("D4.2 an unsynced previous plan is kept for its own trip, not uploaded, not offered elsewhere", T, async () => {
  const EDITED = J(P0); EDITED["2099-01-12"] = ["x2"];
  const h = tripOn(rowA());
  h.edit("dayven", EDITED);
  h.server.tables.trips.push(rowE());
  h.open(rowE());
  const it = items(h)[0];
  assert.ok(it); assert.equal(it.trip_id, "1"); assert.equal(it.reason, "replaced");
  assert.deepEqual(h.val("TripSync.pending()"), []); assert.equal(h.notice().hidden, true);
  h.open(rowA());
  assert.equal(h.notice().hidden, false); assert.equal(h.notice().reason, "replaced");
  assert.ok(h.notice().text.includes("Bu cihazda henüz kaydedilmemiş değişiklikler vardı."), h.notice().text);
  h.el("tripSyncRestore").click(); await settle();
  const s = h.saves().filter((x) => x.args.p_id === 1).at(-1);
  assert.ok(s); assert.deepEqual(s.args.p_patch.plan.dayven, EDITED);
  assert.ok(!h.saves().some((x) => x.args.p_id === 2 && JSON.stringify(x.args.p_patch.plan.dayven) === JSON.stringify(EDITED)), "never uploaded into trip 2");
});
test("D4.3 a kept record equal to the DB row is pruned on adopt", T, () => {
  const EDITED = J(P0); EDITED["2099-01-12"] = ["x2"];
  const h = tripOn(rowA());
  h.edit("dayven", EDITED);
  h.server.tables.trips.push(rowE()); h.open(rowE());
  assert.equal(items(h).length, 1);
  const a6 = serverEdit(h, 1, { plan: { dayven: EDITED, cal: J(CAL_A), plan: { "2099-01-10": "Kahve molası" } } });   // the same edit reached the server
  h.open(a6);
  assert.deepEqual(items(h).filter((x) => x.trip_id === "1"), []);
  assert.equal(h.notice().hidden, true);
});
test("D4.4 legacy hydrate(t) without options is unchanged (WP3 round trip)", T, () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:plan": JSON.stringify({ g2: "x" }) }) });
  h.storage.log.length = 0;
  h.run("TripSync.hydrate({preferences:{plan_prefs:{tempo:'Sakin',saved:true}}})");
  assert.deepEqual(h.ls("plan"), { g2: "x" });
  assert.equal(h.ls("plan_prefs").tempo, "Sakin");
  assert.ok(!h.storage.log.some(([op, k]) => op === "set" && k === "asa:ams:plan_sync"));
});
test("D4.5 (critic 9) server unchanged since this device's last sync: local edits fast-forward, no record", T, async () => {
  const E1 = J(P0); E1["2099-01-12"] = ["oeuf"];
  const h1 = tripOn(row());
  h1.edit("dayven", E1);                                   // tab closed within the 1.2 s debounce
  const h = bootLike(h1); h.useDb();
  h.open(row());                                           // reopen: server still rev 5 = last sync
  await settle(); h.runTimers(); await settle();
  assert.equal(items(h).length, 0, "no record"); assert.equal(h.notice().hidden, true);
  assert.equal(h.saves().length, 1, "one trip_save");
  assert.deepEqual(h.saves()[0].args.p_patch.plan.dayven, E1);
  assert.deepEqual(h.server.trip(7).plan.dayven, E1);
  assert.deepEqual(h.val("dayVenues"), E1);
});
test("D4.6 (critic 3) home saveTrip orphan: reopening trip A shows no notice and no record", T, async () => {
  const h1 = tripOn(rowA());
  h1.storage.setItem("asa:ams:trip", JSON.stringify({ country: "Hollanda", city: "Amsterdam", start_date: "2099-02-01", end_date: "2099-02-02", vacation_types: [] }));
  h1.server.tables.trips.push(rowE());
  const h2 = bootLike(h1, { search: "?trip=2&city=Amsterdam" }); h2.useDb();
  await h2.asa.ev("loadTripContext()"); await settle();
  assert.equal(h2.val("TRIP.id"), 2);
  assert.equal(h2.storage.raw("asa:ams:dayven"), "{}");
  assert.equal(items(h2).length, 0, "trip 1's synced copy is not filed as unsaved");
  const h3 = bootLike(h1, { search: "?trip=1&city=Amsterdam" }); h3.useDb();
  await h3.asa.ev("loadTripContext()"); await settle();
  assert.equal(h3.notice().hidden, true); assert.deepEqual(h3.val("TripSync.pending()"), []);
  assert.deepEqual(h3.val("dayVenues"), rowA().plan.dayven);
  h3.runTimers(); await settle();
  assert.equal(h3.server.trip(1).start_date, "2099-01-10", "trip 1's dates never rewritten");
});

// ================================================================================================ D5 storage failure
test("D5.1 quota while adopting: DB plan in memory, upload blocked, user told", T, async () => {
  const NEW = { "2099-01-10": ["oeuf"], "2099-01-11": ["escobar", "x3"] };
  const h1 = tripOn(row());
  const srv = serverEdit(h1, 7, { plan: { dayven: NEW, cal: {}, plan: {} } });
  const h = bootLike(h1);
  h.storage.failOn("asa:ams:dayven");
  h.useDb();
  assert.equal(h.open(srv), false, "adopt reports the failure");
  assert.equal(h.val("TripSync.blocked"), "7");
  assert.deepEqual(h.val("dayVenues"), NEW, "memory holds the DB plan, not the stale storage");
  assert.equal(h.run("CAL.days.some(D=>(dayVenues[D.key]||[]).length)"), true, "ensurePlan would not regenerate");
  const sn = h.storeNotice();
  assert.equal(sn.hidden, false);
  assert.ok(sn.text.includes("Cihaz depolaması dolu: bu seyahatin kayıtlı planı bu cihaza yazılamadı"), sn.text);
  const t0 = timers1200(h);
  h.run("TripSync.schedule()");
  assert.equal(timers1200(h), t0, "no autosave timer");
  assert.equal(h.val("TripSync.status"), "error");
  await h.run("TripSync.flush()"); await settle();
  assert.equal(h.saves().length, 0, "no trip_save while blocked");
  assert.deepEqual(h.server.trip(7).plan.dayven, NEW);
  // D5.5: the next successful adopt of that trip clears the block
  h.storage.allow("asa:ams:dayven");
  assert.equal(h.open(srv), true);
  assert.equal(h.val("TripSync.blocked"), null);
});
test("D5.2 saveLS schedules a flush only when its write succeeded", T, () => {
  const h = boot();
  h.storage.failOn("asa:ams:cal");
  h.run("var __td=0; window.__tripDirty=function(){ __td++; };");
  assert.equal(h.run('saveLS("cal",{a:"x"},true)'), false);
  assert.equal(h.run("__td"), 0);
  assert.equal(h.run('saveLS("plan",{a:"x"},true)'), true);
  assert.equal(h.run("__td"), 1);
});
test("D5.3 savePrefs write failure: nothing scheduled, user told", T, () => {
  const h = boot();
  h.run('ASA_ST.set("trip",{city:"Amsterdam",start_date:"2099-01-10",end_date:"2099-01-12"})');
  h.storage.failOn("asa:ams:plan_prefs");
  h.run("PSET._reload()");
  h.run("var __td=0; window.__tripDirty=function(){ __td++; };");
  h.run("PSET.submit()");
  assert.equal(h.run("__td"), 0);
  assert.ok(h.sb.__alerts.some((m) => m.includes("Plan tercihlerin bu cihaza kaydedilemedi")), JSON.stringify(h.sb.__alerts));
});
test("D5.4 (r2) plan_sync write fails during a conflict: local plan kept on the device, server plan shown, restorable", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  h.storage.failOn("asa:ams:plan_sync");
  await h.run("TripSync.flush()"); await settle();
  assert.deepEqual(h.server.trip(7).plan.dayven, P2);
  assert.deepEqual(h.ls("dayven"), P1, "the only durable copy (local plan) is not overwritten");
  assert.deepEqual(h.val("dayVenues"), P2, "the newer server plan is shown from memory");
  assert.equal(h.val("TripSync.blocked"), "7", "uploads and plan writes of this tab stop");
  assert.ok(h.storeNotice().text.includes("Cihaz depolaması dolu: bu cihazdaki kaydedilmemiş plan değişikliklerin ayrıca saklanamadı."), h.storeNotice().text);
  assert.ok(h.notice().text.includes("Cihaz depolaması dolu olduğu için bu sürüm ayrıca saklanamadı; kaybolmasın diye bu cihazdaki plan değiştirilmedi."), h.notice().text);
  assert.equal(h.val("TripSync.pending()[0].mem"), true);
  // a later edit in this tab writes nothing to storage (the kept local plan stays intact)
  h.run('dayVenues["2099-01-11"]=["coba","p2"]; saveLS("dayven",dayVenues)');
  assert.deepEqual(h.ls("dayven"), P1);
  h.el("tripSyncRestore").click(); await settle();
  assert.deepEqual(h.saves().at(-1).args.p_patch.plan.dayven, P1);
  assert.equal(h.saves().at(-1).args.p_expected_rev, 6);
  assert.deepEqual(h.server.trip(7).plan.dayven, P1);
  assert.equal(h.val("TripSync.blocked"), null, "restore lifted the lock");
});
test("D5.6 (critic 11) only the trip write fails: CAL and PSET still use the DB trip's dates", T, () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(TRIP_A_LOCAL) }) });
  h.storage.failOn("asa:ams:trip");
  h.useDb();
  assert.equal(h.open(rowB()), false);
  assert.deepEqual(h.val("CAL.days.map(d=>d.key)"), ["2099-02-10", "2099-02-11", "2099-02-12"]);
  const p = h.val("PSET.getPrefs()");
  assert.equal(p.startDate, "2099-02-10"); assert.equal(p.endDate, "2099-02-12");
  assert.deepEqual(h.val("dayVenues"), rowB().plan.dayven);
  assert.equal(h.val("TripSync.blocked"), "2");
});

// ================================================================================================ D6 favourites
const favs = (h) => h.val("[...favSet].sort()");
const sorted = (a) => [...a].sort();
test("D6.1 seeded default favourites are never uploaded", T, () => {
  const h = boot();
  assert.deepEqual(favs(h), sorted(SEEDS));
  const p = h.val('favLoginPlan(["c9"],"u1")');
  assert.deepEqual(p.adds, []); assert.deepEqual(p.dels, []);
  h.run('favLoginCommit("u1",["c9"],favLoginPlan(["c9"],"u1"),[],[])');
  assert.equal(h.storage.raw("asa:ams:fav"), '["c9"]');
  const fs = h.favSync(); assert.equal(fs.uid, "u1"); assert.deepEqual(fs.ops, []);
});
test("D6.2 only explicit logged-out changes are applied on login (pending ops)", T, () => {
  const h = boot();
  h.run('toggleFav("x1"); toggleFav("barpif");');
  const ops = h.favSync().ops;
  const a = ops.find((o) => o.id === "x1"), d = ops.find((o) => o.id === "barpif");
  assert.ok(a && d, JSON.stringify(ops));
  assert.equal(a.op, "add"); assert.equal(a.uid, null); assert.equal(d.op, "del"); assert.equal(d.uid, null);
  assert.ok(d.n > a.n, "increasing sequence");
  const p = h.val('favLoginPlan(["barpif","c9"],"u1")');
  assert.deepEqual(sorted(p.adds), ["x1"]); assert.deepEqual(sorted(p.dels), ["barpif"]);
});
test("D6.3 a favourite deleted on another device stays deleted after the next load", T, () => {
  const h1 = boot({ storage: fakeStorage({ "asa:ams:fav": '["a","b"]' }) });
  h1.run('favLoginCommit("u1",["a","b"],favLoginPlan(["a","b"],"u1"),[],[])');   // first sync
  const h = bootLike(h1);                                                        // later page load; "b" was deleted elsewhere
  assert.deepEqual(h.val('favLoginPlan(["a"],"u1")').adds, []);
  h.run('favLoginCommit("u1",["a"],favLoginPlan(["a"],"u1"),[],[])');
  assert.deepEqual(favs(h), ["a"]);
});
test("D6.4 WP3 baseline kept: pre-WP6 local-only favourite uploaded once; untouched seeds are not", T, () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:fav": '["barpif"]' }) });
  const p = h.val('favLoginPlan(["chun","winkel43"],"u1")');
  assert.deepEqual(p.adds, ["barpif"]);
  h.run('favLoginCommit("u1",["chun","winkel43"],favLoginPlan(["chun","winkel43"],"u1"),[],[])');
  assert.equal(h.run("favSet.size"), 3);
  const k = boot({ storage: fakeStorage({ "asa:ams:fav": JSON.stringify(SEEDS) }) });
  assert.deepEqual(k.val('favLoginPlan(["c9"],"u1")').adds, []);
});
test("D6.5 logout clears the account's favourites from the device; never carried to the next account", T, () => {
  const h = boot();
  h.run('favLoginCommit("u1",["c9","x1"],favLoginPlan(["c9","x1"],"u1"),[],[])');
  assert.equal(h.run("favLogoutReset()"), true);
  assert.equal(h.run("favSet.size"), 0);
  assert.equal(h.storage.raw("asa:ams:fav"), "[]");
  assert.equal(h.favSync().uid, null);
  assert.deepEqual(h.val('favLoginPlan(["q"],"u2")').adds, []);
  const k = boot();                                       // never-synced device: untouched
  assert.equal(k.run("favLogoutReset()"), false);
  assert.deepEqual(favs(k), sorted(SEEDS));
});
test("D6.6 heart toggles during login (late ops) survive the commit", T, () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:fav": "[]", "asa:ams:fav_sync": JSON.stringify({ v: 1, uid: null, ops: [] }) }) });
  h.run('var P1=favLoginPlan(["c9"],"u1"); toggleFav("x2");');
  const c = h.val('favLoginCommit("u1",["c9"],P1,[],[])');
  assert.equal(c.late[0].id, "x2");
  assert.ok(h.run('favSet.has("x2")'));
  assert.ok(h.favSync().ops.some((o) => o.id === "x2" && o.op === "add"), "op kept until replayed");
});
test("D6.7 a failed server write is retried for its own account only", T, () => {
  const h = boot();
  h.run('favOpRecord("x3","del","u1")');
  assert.deepEqual(h.val('favLoginPlan(["x3"],"u2")').dels, []);
  assert.deepEqual(h.val('favLoginPlan(["x3"],"u1")').dels, ["x3"]);
  h.run('favLoginCommit("u1",["x3"],favLoginPlan(["x3"],"u1"),[],["x3"])');
  assert.ok(h.favSync().ops.some((o) => o.id === "x3" && o.op === "del" && o.uid === "u1"), JSON.stringify(h.favSync().ops));
});
test("D6.8 locked city / missing library: favourites write nothing to asa:*", T, () => {
  for (const o of [{ city: "Kopenhag" }, { lib: false }]) {
    const h = boot(o);
    h.storage.log.length = 0;
    h.run('toggleFav("x1")');
    assert.deepEqual(h.storage.log.filter(([, k]) => k.startsWith("asa:")), [], JSON.stringify(o));
  }
});
test("D6.9 (critic 4) pre-WP6 personal favourites survive an anonymous heart tap before the first login", T, () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:fav": '["p1","p2"]' }) });
  h.run('toggleFav("x1")');
  assert.deepEqual(sorted(h.val('favLoginPlan(["c9"],"u1")').adds), ["p1", "p2", "x1"]);
  h.run('favLoginCommit("u1",["c9"],favLoginPlan(["c9"],"u1"),[],[])');
  assert.deepEqual(favs(h), ["c9", "p1", "p2", "x1"]);
});
test("D6.10 (critic 5) seed check uses a fixed snapshot: a closed seed venue removed from V changes nothing", T, () => {
  const h = boot();
  h.run('V.splice(V.findIndex(v=>v.id==="barpif"),1)');    // mergeDbVenues drops a closed venue
  assert.deepEqual(h.val('favLoginPlan(["c9"],"u1")').adds, []);
});
test("D6.11 (critic 6) a failed late-op replay is never applied to a second account", T, async () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:fav": "[]", "asa:ams:fav_sync": JSON.stringify({ v: 1, uid: null, ops: [] }) }) });
  h.run('var P1=favLoginPlan(["c9"],"u1"); toggleFav("x2"); favLoginCommit("u1",["c9"],P1,[],[]);');
  h.asa.set("db", h.db); h.asa.ev('session={uid:"u1",email:"qa",display_name:null}');
  h.server.hooks.rest = (c) => (c.table === "favorites" && c.op === "upsert" ? { data: null, error: { message: "rls" } } : undefined);
  await h.asa.ev('onFav("x2",true)'); await settle();
  h.run("favLogoutReset()");
  assert.deepEqual(h.val('favLoginPlan([],"u2")').adds, [], "x2 must not be added to another account");
  assert.ok(h.val('favLoginPlan([],"u1")').adds.includes("x2"), "still retried for u1");
});
test("D6.12 (critic 7a) anonymous heart: if the pending op cannot be stored, the toggle is reverted and the user told", T, () => {
  const h = boot();
  h.storage.failOn("asa:ams:fav_sync");
  h.run('toggleFav("x1")');
  assert.equal(h.run('isFav("x1")'), false);
  assert.ok(h.sb.__alerts.some((m) => m.includes("Favorin kaydedilemedi")), JSON.stringify(h.sb.__alerts));
  assert.ok(!JSON.parse(h.storage.raw("asa:ams:fav")).includes("x1"), "device list reverted too");
});
test("D6.13 (critic 7b) init: no session clears account favourites; a getSession error does not", T, async () => {
  const synced = () => { const h = boot(); h.run('favLoginCommit("u1",["c9","x1"],favLoginPlan(["c9","x1"],"u1"),[],[])'); return h; };
  const a = bootLike(synced()); a.server.session = { data: { session: null }, error: null };
  await a.asa.ev("init()"); await settle();
  assert.equal(a.run("favSet.size"), 0, "logged out elsewhere: account favourites cleared");
  assert.equal(a.storage.raw("asa:ams:fav"), "[]");
  const b = bootLike(synced()); b.server.session = { data: { session: null }, error: { message: "refresh failed" } };
  await b.asa.ev("init()"); await settle();
  assert.deepEqual(favs(b), ["c9", "x1"], "transient error: untouched");
  const c = bootLike(synced()); c.server.session = new Error("network");
  await c.asa.ev("init()"); await settle();
  assert.deepEqual(favs(c), ["c9", "x1"]);
});
test("D6.14 (critic 7c) onFav still re-renders in both branches", T, async () => {
  const h = boot(); h.asa.set("db", h.db);
  h.sb.__asaRenders = 0;
  await h.asa.ev('onFav("x1",true)');
  assert.equal(h.sb.__asaRenders, 1, "no session");
  h.asa.ev('session={uid:"u1",email:"qa",display_name:null}');
  h.sb.__asaRenders = 0;
  await h.asa.ev('onFav("x1",true)'); await settle();
  assert.equal(h.sb.__asaRenders, 1, "with session");
  assert.deepEqual(h.server.favIds("u1"), ["x1"]);
});
async function loginFavs(h, cloud = []) {
  for (const id of cloud) h.server.tables.favorites.push({ user_id: "u1", venue_id: id, city: "Amsterdam" });
  h.useRealAsa(); h.asa.set("db", h.db);
  await h.asa.ev('syncOnLogin("u1","qa",false)'); await settle();
}
test("D6.15 (critic 7d) syncOnLogin: a failed cloud read leaves favourites untouched", T, async () => {
  const h = boot(); h.run('toggleFav("x1")');
  const before = h.storage.raw("asa:ams:fav");
  h.server.hooks.rest = (c) => (c.table === "favorites" && c.op === "select" ? { data: null, error: { message: "x" } } : undefined);
  await loginFavs(h);
  assert.equal(h.server.rest("favorites", "upsert").length + h.server.rest("favorites", "delete").length, 0);
  assert.equal(h.storage.raw("asa:ams:fav"), before);
  assert.ok(h.favSync().ops.some((o) => o.id === "x1" && o.op === "add"), "pending op kept");
});
test("D6.16 (critic 7d) syncOnLogin: deletes one id at a time, seeds never uploaded", T, async () => {
  const h = boot(); h.run('toggleFav("barpif"); toggleFav("shiraz");');
  await loginFavs(h, ["barpif", "shiraz", "c9"]);
  const dels = h.server.rest("favorites", "delete");
  assert.equal(dels.length, 2);
  for (const d of dels) { assert.ok(d.filters.some((f) => f[0] === "eq" && f[1] === "user_id" && f[2] === "u1")); assert.ok(d.filters.some((f) => f[0] === "eq" && f[1] === "venue_id")); assert.ok(!d.filters.some((f) => f[0] === "in")); }
  assert.equal(h.server.rest("favorites", "upsert").length, 0, "no seed upload");
  assert.deepEqual(h.server.favIds("u1"), ["c9"]);
  assert.deepEqual(favs(h), ["c9"]);
});
test("D6.17 (critic 7d) syncOnLogin: failed upsert re-recorded for this account; late toggles replayed", T, async () => {
  const h = boot(); h.run('toggleFav("x1")');
  let first = true;
  h.server.hooks.rest = (c) => {
    if (c.table === "favorites" && c.op === "upsert" && first) { first = false; h.run('toggleFav("x2")'); return { data: null, error: { message: "rls" } }; }
    return undefined;
  };
  await loginFavs(h, ["c9"]);
  const ops = h.favSync().ops;
  assert.ok(ops.some((o) => o.id === "x1" && o.op === "add" && o.uid === "u1"), "failed add kept for u1: " + JSON.stringify(ops));
  assert.ok(!ops.some((o) => o.id === "x1" && o.uid === null), "no anonymous duplicate");
  assert.ok(h.run('favSet.has("x2")'), "late toggle kept on the device");
  assert.ok(h.server.favIds("u1").includes("x2"), "late toggle replayed to the server after login");
});
test("D6.18 contract: WP3 login union through syncOnLogin (local-only favourite pushed once)", T, async () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:fav": '["barpif"]' }) });
  await loginFavs(h, ["chun", "winkel43"]);
  assert.equal(h.server.rest("favorites", "upsert").length, 1);
  assert.deepEqual(h.server.favIds("u1"), ["barpif", "chun", "winkel43"]);
  assert.equal(h.run("favSet.size"), 3);
});
test("D6.19 logout (city page) clears the account favourites mirrored on the device", T, async () => {
  const h = boot(); await loginFavs(h, ["c9", "x1"]);
  assert.deepEqual(favs(h), ["c9", "x1"]);
  await h.asa.ev("logout()"); await settle();
  assert.equal(h.run("favSet.size"), 0);
  assert.equal(h.storage.raw("asa:ams:fav"), "[]");
  assert.equal(h.favSync().uid, null);
  assert.ok(!asaClosureBody(CITY_HTML).includes("new Set([...cloud,...local])"), "old union gone");
});

// ================================================================================================ D7 browsing reference
const ACC_A = { lat: 52.1, lng: 4.1, label: "A" };
function prefsDevice(pp = { accommodation: ACC_A, base_area: "A", saved: true }) {
  const h = boot();
  h.run('ASA_ST.set("trip",{city:"Amsterdam",start_date:"2099-01-10",end_date:"2099-01-12"})');
  if (pp) h.run(`ASA_ST.set("plan_prefs",${JSON.stringify(pp)})`);
  h.run("PSET._reload()");
  return h;
}
test("D7.1 collect() ignores the browsing reference location", T, () => {
  const h = prefsDevice();
  h.run('userLoc={lat:9,lng:9,label:"GPS konumun"}');
  const c = h.val("TripSync.collect()");
  assert.deepEqual(c.preferences.accommodation, ACC_A);
  assert.equal(c.preferences.plan_prefs.base_area, "A");
  assert.ok(!fnSrc(pageBlock(CITY_HTML, "TRIPSYNC"), "TS.collect=function(){").includes("__asaGetAccommodation"));
});
test("D7.2 setRef / clearRef (GPS, neighbourhood list) never schedule an upload", T, async () => {
  const h = tripOn(row());
  const t0 = timers1200(h);
  h.run('setRef(9,9,"GPS konumun")'); h.run("clearRef()");
  assert.equal(timers1200(h), t0, "no autosave scheduled");
  h.runTimers(); await settle();
  assert.equal(h.saves().length, 0);
  const click = CITY_HTML.slice(CITY_HTML.indexOf('MAP.map.on("click"'), CITY_HTML.indexOf("\n", CITY_HTML.indexOf('MAP.map.on("click"')));
  assert.ok(click.includes('MAP.pickFor==="acc"'), "map click sets accommodation only after 'Haritadan pin'");
  h.run("PSET.pin()");
  assert.equal(h.run("MAP.pickFor"), "acc");
});
test("D7.3 savePrefs saves only the explicit accommodation (saved / neighbourhood / map pin)", T, () => {
  const h = prefsDevice();
  h.run('setRef(9,9,"GPS konumun")');
  h.run("PSET.submit()");
  let pp = h.ls("plan_prefs");
  assert.equal(pp.accommodation.lat, ACC_A.lat); assert.equal(pp.accommodation.lng, ACC_A.lng);
  assert.deepEqual(h.ls("trip").plan_prefs.accommodation, { lat: ACC_A.lat, lng: ACC_A.lng });
  h.run('PSET.nb("Jordaan")'); h.run("PSET.submit()");
  pp = h.ls("plan_prefs");
  assert.equal(pp.accommodation.lat, 52.374); assert.equal(pp.accommodation.lng, 4.881); assert.equal(pp.base_area, "Jordaan");
  h.run('PSET.setAcc(1,2,"Haritada seçtiğin yer")'); h.run("PSET.submit()");
  pp = h.ls("plan_prefs");
  assert.equal(pp.accommodation.lat, 1); assert.equal(pp.accommodation.lng, 2);
});
test("D7.4 no saved accommodation: a browsing reference is not saved as accommodation", T, () => {
  const h = prefsDevice(null);
  h.run('setRef(9,9,"GPS konumun")');
  h.run("PSET.submit()");
  assert.equal(h.ls("plan_prefs").accommodation, null);
});
test("D7.5 (critic 14) engine base is the accommodation; adopt clears stale engine output", T, () => {
  const h = prefsDevice();
  h.run('setRef(9,9,"GPS konumun")');
  const b = h.val("PSET.getPrefs().base");
  assert.equal(b.lat, ACC_A.lat); assert.equal(b.lng, ACC_A.lng);
  const k = tripOn(row());
  k.run('window.planResult={"2099-01-10":[{id:"barpif"}]}; window.planEngineMeta={quota:[]};');
  k.open(rowB());
  assert.ok(!k.run("window.planResult"), "planResult cleared"); assert.ok(!k.run("window.planEngineMeta"), "planEngineMeta cleared");
});

// ================================================================================================ critic 8 / 12 / 16
test("C8 untouched auto-generated plans are never kept or offered (sample days, dated guest, legacy device)", T, async () => {
  // (a) sample days g1..g5 written by ensurePlan, then a trip is opened
  const a = boot({ gen: true }); a.run("ensurePlan()");
  a.server.tables.trips.push(row()); a.useDb(); a.open(row());
  assert.equal(items(a).length, 0, "(a) sample plan"); assert.equal(a.notice().hidden, true);
  // (b) guest with dates opens the Plan tab (dated auto stops), then logs in and adopts the overlapping DB trip
  const b = boot({ gen: true });
  b.run(`ASA_ST.set("trip",${JSON.stringify(GUEST_TRIP)})`); b.run("ensurePlan()");
  assert.ok(Object.keys(b.ls("dayven") || {}).includes("2099-03-03"), "precondition: dated auto plan");
  b.server.tables.trips.push(row9()); spyStore(b);
  await b.asa.ev("importGuestTrip()"); await settle();
  assert.equal(b.val("TRIP && TRIP.id"), 9);
  assert.equal(items(b).length, 0, "(b) dated auto plan"); assert.equal(b.notice().hidden, true);
  // (c) pre-WP6 device (no plan_sync) holding only auto output
  // round 1: "untouched" = exactly autoGeneratePlan's output ("Dilim: Ad (Bölge)" per venue, in order); see R3.* for edited variants
  const c = boot({ storage: fakeStorage({ "asa:ams:dayven": JSON.stringify({ g1: ["barpif"], g2: ["chun"] }), "asa:ams:plan": JSON.stringify({ g1: "Sabah: Mekan barpif (Merkez)", g2: "Öğle: Mekan chun (Merkez)" }) }) });
  c.server.tables.trips.push(row()); c.useDb(); c.open(row());
  assert.equal(items(c).length, 0, "(c) legacy auto output");
});
test("C12 logout resets trip state; the next account opens its own trip; guest copies are not offered to it", T, async () => {
  const h = boot({ search: "?trip=7&city=Amsterdam" });
  h.edit("dayven", G);                                         // guest plan on the shared device
  h.server.tables.trips.push(row(), row({ id: 8, user_id: "u2", start_date: "2099-04-01", end_date: "2099-04-02", plan: { dayven: { "2099-04-01": ["oeuf"] }, cal: {}, plan: {} } }));
  h.useDb(); h.useRealAsa(); h.asa.set("db", h.db);
  await h.asa.ev('afterAuth({id:"u1",email:"qa"})'); await settle();
  assert.equal(h.val("TRIP.id"), 7);
  assert.equal(h.notice().reason, "guest", "u1 is offered the guest copy");
  h.edit("dayven", P1);                                       // autosave pending
  await h.asa.ev("logout()"); await settle();
  assert.ok(!h.run("window.TRIP"), "TRIP cleared on logout");
  assert.equal(h.run("TripSync.blocked"), null);
  assert.equal(timers1200(h), 0, "pending autosave cancelled");
  h.sb.location.search = "?trip=8&city=Amsterdam"; h.server.uid = "u2";
  await h.asa.ev('afterAuth({id:"u2",email:"qb"})'); await settle();
  assert.equal(h.val("TRIP && TRIP.id"), 8, "the next login on the same page opens its own trip");
  assert.deepEqual(h.val("TripSync.pending()"), [], "u1's guest copy is not offered to u2");
  assert.equal(h.notice().hidden, true);
});
test("C16 (critic 16) the plan signature carries more than 32 bits of hash", T, () => {
  const h = tripOn(row());
  const sg = ((h.sync() || {}).synced || {}).sig;
  assert.equal(typeof sg, "string", "plan_sync.synced.sig written by adopt");
  const hashPart = sg.replace(/\.\d+$/, "");                    // drop the length suffix
  assert.ok((hashPart.match(/[0-9A-Za-z]/g) || []).length > 8, "a single 32-bit hash (≤ 8 hex digits) can collide and silently discard unsynced edits: " + sg);
});
test("UI static: #tripSyncNotice placed after #asaNpDone (WP5 notice→name-prompt gap kept)", T, () => {
  const tag = '<div id="tripSyncNotice" class="asa-sn hide" role="alert" aria-atomic="true"></div>';
  const doneTag = '<p id="asaNpDone" class="asa-np-done" role="status" aria-live="polite" tabindex="-1"></p>';
  const done = CITY_HTML.indexOf(doneTag), i = CITY_HTML.indexOf(tag);
  assert.ok(done > 0 && i > done, "notice after #asaNpDone");
  assert.equal(CITY_HTML.slice(done + doneTag.length, i).replace(/<!--[\s\S]*?-->/g, "").trim(), "", "nothing but comments between #asaNpDone and #tripSyncNotice");
  const n = CITY_HTML.indexOf('<div id="asaStoreNotice" class="asa-sn hide" role="status" aria-live="polite"></div>');
  const b = CITY_HTML.indexOf('<section id="asaNamePrompt" class="asa-np hide" aria-labelledby="asaNpTitle">');
  assert.ok(n > 0 && b > n && b - n < 400, "WP5 gap");
});
