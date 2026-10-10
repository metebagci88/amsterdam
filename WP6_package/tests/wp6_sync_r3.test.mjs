// WP6 · sync integrity, fixer round 3 (independent verification of round 2). Same harness as the other WP6 tests: the city page's
// REAL code in a vm sandbox (./_page.mjs), the real membership closure (afterAuth / logout / init), fake Storage shared between
// "tabs" / reloads / accounts, fake Supabase with per-user RLS on trips and favourites.
//   A  same device, two accounts (PRD: "iki farklı kullanıcı birbirinin verisini görmez — aynı cihaz: çıkış, sonra başka hesap")
//   M  storage nearly full: the "unsynced" marker is written BEFORE the change (never an unprotected change)
//   K  a kept version carries its own trip's dates (home page rewrote asa:ams:trip)
//   F  favourites under storage-full / unwritable storage never cross accounts, never vanish silently
//   S  same-device tabs after a plan snapshot; coverage for round-2 guards that no test exercised
//   U  notice UX: the destructive choice is named, "Sonra karar ver" keeps the copy, undo, notice reachable from the day modal
//   node --test WP6_package/tests/
// Test data only: user ids "u1"/"u2", trip ids 7/8/9, year 2099, marker strings; no e-mail addresses, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { boot, bootLike, fakeStorage, read, settle, J } from "./_page.mjs";

const T = { timeout: 15000 };
const P0 = { "2099-01-10": ["barpif", "chun"], "2099-01-11": ["coba"] };
const P1 = { "2099-01-10": ["barpif", "chun", "x1"], "2099-01-11": ["coba"] };
const P2 = { "2099-01-10": ["chun"], "2099-01-11": ["coba", "x2"], "2099-01-12": ["x3"] };
const U1_NOTE = "U1-GIZLI-NOT kapi kodu 4711", U1_PLAN = "U1-GIZLI-PLAN", U1_ACC = { lat: 52.3741, lng: 4.8812, label: "U1-otel" };
const U1_PHOTO = "data:image/gif;base64,U1PHOTO";
function row(o = {}) {
  return Object.assign({
    id: 7, revision: 5, user_id: "u1", city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12",
    timezone: "Europe/Amsterdam", setup_completed: true, archived_at: null, plan_version: 0,
    preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli" } },
    plan: { dayven: J(P0), cal: {}, plan: {} },
  }, J(o));
}
// u1's trip 7 with private content; u2's own trip 9 (empty)
const row7 = () => row({ preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli", accommodation: U1_ACC, otherNote: "U1-other" }, accommodation: U1_ACC }, plan: { dayven: J(P0), cal: { "2099-01-10": U1_NOTE }, plan: { "2099-01-10": U1_PLAN } } });
const row9 = () => row({ id: 9, revision: 2, user_id: "u2", start_date: "2099-03-01", end_date: "2099-03-03", preferences: {}, plan: null, setup_completed: false });
const ROW8 = () => row({ id: 8, revision: 1, start_date: "2099-02-10", end_date: "2099-02-12", plan: { dayven: { "2099-02-10": ["pllek"] }, cal: {}, plan: {} } });
function tripOn(r, opts = {}) { const h = boot(opts); if (!h.server.trip(r.id)) h.server.tables.trips.push(J(r)); h.useDb(); h.open(r); return h; }
function serverEdit(h, id, patch) { const r = h.server.trip(id); Object.assign(r, J(patch)); r.revision++; return J(r); }
async function reopen(h, id = 7) { const k = bootLike(h, { search: `?trip=${id}&city=Amsterdam` }); k.useDb(); await k.asa.ev("loadTripContext()"); await settle(); k.runTimers(); await settle(60); return k; }
const items = (h) => ((h.sync() || {}).items || []);
const OFF = (n) => (n === "trip_save" ? { data: { ok: false, reason: "net" }, error: null } : undefined);
const ev = (t, ks) => ks.forEach((k) => t.fireStorage("asa:ams:" + k));

// ------------------------------------------------------------------------------------------------ shared device, real accounts
// a page of the shared device with the real membership closure. who: "u1" | "u2" (session present → init() logs in) | null (no session)
async function page(prev, who, search = "?city=Amsterdam", opts = {}) {
  const h = prev ? bootLike(prev, { search, ...opts }) : boot({ search, ...opts });
  h.useDb(); h.useRealAsa(); h.asa.set("db", h.db);
  h.server.uid = who || h.server.uid;
  h.server.session = who ? undefined : { data: { session: null }, error: null };
  await h.asa.ev("init()"); await settle(60);
  return h;
}
async function login(h, who, search) { if (search !== undefined) h.sb.location.search = search; h.server.uid = who; await h.asa.ev(`afterAuth({id:${JSON.stringify(who)},email:""})`); await settle(60); }
async function logout(h) { await h.asa.ev("logout()"); await settle(60); }
function twoAccounts() {
  const h = boot();
  h.server.tables.trips.push(row7(), row9());
  return h;
}
// everything the page shows or holds as "the plan": memory, visible storage domains (plan_sync items and hidden photo keys are
// account-tagged and never shown to another account), the notice, the browsing reference
function onScreen(h) {
  return h.val(`({cal:calNotes, plan:calPlans, dv:dayVenues, ph:Object.keys(calPhotos).filter(function(k){return k.indexOf("~u:")!==0;}).map(function(k){return calPhotos[k];}),
    trip:(window.__asaTripMem||ASA_ST.trip()||null), days:CAL.days.map(function(d){return d.key;}), base:(function(){ try{ PSET._reload&&0; return PSET.getPrefs().base; }catch(e){ return "n/a"; } })(),
    form:(function(){ try{ var g=PSET.getPrefs(); return [g.startDate,g.endDate,g.must_see_ids,g.reservations]; }catch(e){ return null; } })(),
    ref:(typeof userLoc!=="undefined"?userLoc:null), pending:(window.TRIP?TripSync.pending():[]), notice:document.getElementById("tripSyncNotice").textContent})`);
}
function shown(h) {
  return Object.assign(onScreen(h), h.val(`({lsPrefs:ASA_ST.get("plan_prefs",{}), lsCal:ASA_ST.get("cal",{}), lsPlan:ASA_ST.get("plan",{}), lsDv:ASA_ST.get("dayven",{}), lsTrip:ASA_ST.get("trip",{})})`));
}
const leaksU1 = (x) => /U1-|U1PHOTO|52\.3741|2099-01-1/.test(JSON.stringify(x));

// ================================================================================================ A  same device, two accounts
test("A1 logout on the city page: the account's trip, notes, plan text and accommodation leave the device (memory + storage)", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  assert.equal(a.val("TRIP.id"), 7);
  a.run(`calPhotos["2099-01-10"]=[${JSON.stringify(U1_PHOTO)}]; saveLS("calphoto",calPhotos,true)`);
  assert.ok(leaksU1(shown(a)), "precondition: u1's plan is on the device");
  await logout(a);
  const s = shown(a);
  assert.ok(!leaksU1(s), "u1's data still shown after logout: " + JSON.stringify(s));
  for (const k of ["dayven", "cal", "plan", "plan_prefs", "trip"]) assert.ok(!leaksU1(a.ls(k)), k + " still holds u1 data: " + a.storage.raw("asa:ams:" + k));
  assert.equal(a.sync().owner, undefined, "device no longer marked as u1's");
  assert.equal(a.sync().synced, null);
  // photos are device-only: hidden for u1, not deleted
  assert.deepEqual(a.ls("calphoto"), { "~u:u1|2099-01-10": [U1_PHOTO] });
  assert.ok(!a.storage.log.some(([op, k]) => (op === "remove" || op === "clear") && /^asa:/.test(k)), "WP3: no removeItem / clear of asa:* keys");
  // the server copy is untouched
  assert.equal(a.server.trip(7).plan.cal["2099-01-10"], U1_NOTE);
});
test("A2 anonymous visitor after logout, then u2 logs in on the plain page, edits, opens its own trip: nothing of u1 is shown, offered or uploaded", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  await logout(a);
  const anon = await page(a, null);
  assert.ok(!leaksU1(shown(anon)), "anonymous visitor sees u1 data: " + JSON.stringify(shown(anon)));
  const b = await page(anon, "u2");
  assert.ok(!leaksU1(shown(b)), "u2 sees u1 data on the plain page: " + JSON.stringify(shown(b)));
  b.run('calNotes["2099-03-02"]="u2 notu"; saveLS("cal",calNotes)');
  const b9 = await page(b, "u2", "?trip=9&city=Amsterdam");
  assert.equal(b9.val("TRIP.id"), 9);
  const s = shown(b9);
  assert.ok(!leaksU1(s), JSON.stringify(s));
  assert.equal(b9.notice().hidden || !leaksU1(b9.notice().text), true);
  for (const it of b9.val("TripSync.pending()")) assert.ok(!leaksU1(it), "u1 data offered to u2: " + JSON.stringify(it));
  if (b9.el("tripSyncRestore")) { b9.el("tripSyncRestore").click(); await settle(); b9.runTimers(); await settle(60); }
  assert.ok(!leaksU1(b9.server.trip(9)), "u1 data uploaded into u2's trip 9: " + JSON.stringify(b9.server.trip(9)));
});
test("A3 u1's unsynced edit at logout is kept for u1 only: u2 never sees it; u1 gets it back on trip 7", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.server.hooks.rpc = OFF;                                         // offline: the save fails
  a.run('calNotes["2099-01-11"]="U1-offline-not"; saveLS("cal",calNotes)');
  await logout(a);
  a.server.hooks.rpc = undefined;
  assert.ok(!leaksU1(shown(a)));
  const it = items(a).find((x) => JSON.stringify(x.cal).includes("U1-offline-not"));
  assert.ok(it, "the unsynced edit is kept on the device");
  assert.equal(it.trip_id, "7"); assert.equal(it.uid, "u1");
  assert.equal(it.start_date, "2099-01-10"); assert.equal(it.end_date, "2099-01-12");
  // u2 on the plain page edits, then opens its own trip: nothing offered (variant A/B of the probe)
  const b = await page(a, "u2");
  b.run('calNotes["2099-03-02"]="u2 notu"; saveLS("cal",calNotes)');
  const b9 = await page(b, "u2", "?trip=9&city=Amsterdam");
  for (const x of b9.val("TripSync.pending()")) { assert.ok(!leaksU1(x), "u1's version offered to u2: " + JSON.stringify(x)); assert.equal(x.uid, "u2", "only u2's own plain-page note"); }
  assert.ok(!leaksU1(b9.notice().text));
  if (b9.el("tripSyncRestore")) { b9.el("tripSyncRestore").click(); await settle(); b9.runTimers(); await settle(60); }
  assert.ok(!leaksU1(b9.server.trip(9)), JSON.stringify(b9.server.trip(9)));
  await logout(b9);
  // u1 back on trip 7: offered, restore brings it back
  const a2 = await page(b9, "u1", "?trip=7&city=Amsterdam");
  assert.equal(a2.notice().hidden, false, "u1's own version is offered to u1");
  a2.el("tripSyncRestore").click(); await settle(); a2.runTimers(); await settle(60);
  assert.equal(a2.server.trip(7).plan.cal["2099-01-11"], "U1-offline-not");
  assert.equal(a2.server.trip(7).start_date, "2099-01-10", "trip 7's dates unchanged");
});
test("A4 (regression probe p2/p2b) an edit on the plain page while the device holds trip 7 stays trip 7's: never a 'guest' plan for the next account", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  const a2 = await page(a, "u1");                                   // u1 still logged in, plain page (no TRIP)
  assert.ok(!a2.val("window.TRIP"), "precondition: no TRIP on the plain page");
  a2.run('calNotes["2099-01-12"]="U1-plain"; saveLS("cal",calNotes)');
  assert.deepEqual(a2.sync().dirty, { trip_id: "7" }, "owner kept (never downgraded to a guest plan)");
  await logout(a2);
  const b9 = await page(a2, "u2", "?trip=9&city=Amsterdam");
  assert.deepEqual(b9.val("TripSync.pending()"), []);
  assert.equal(b9.notice().hidden, true);
  assert.ok(!leaksU1(shown(b9)));
  assert.ok(!leaksU1(b9.server.trip(9)));
  const it = items(b9).find((x) => JSON.stringify(x.cal).includes("U1-plain"));
  assert.ok(it && it.trip_id === "7" && it.uid === "u1", "u1's plain-page edit kept for trip 7 / u1: " + JSON.stringify(it));
});
test("A5 logout on the HOME page / session expiry: the next city page (no session) removes the account's plan; u2 logging in later gets none of it", T, async () => {
  for (const variant of ["home-logout", "expiry"]) {
    const d = twoAccounts();
    const a = await page(d, "u1", "?trip=7&city=Amsterdam");
    a.run(`calPhotos["2099-01-11"]=[${JSON.stringify(U1_PHOTO)}]; saveLS("calphoto",calPhotos,true)`);
    if (variant === "home-logout") a.run('AsaStorage.set(localStorage,"ams","trip",{})');   // what index.html doLogout now writes
    const anon = await page(a, null);
    const s = shown(anon);
    assert.ok(!leaksU1(s), variant + ": " + JSON.stringify(s));
    assert.equal(anon.sync().owner, undefined, variant);
    const b = await page(anon, "u2");
    assert.ok(!leaksU1(shown(b)), variant);
  }
});
test("A6 u1 logs out on the home page and u2 logs in on the home page: the city page (session u2) removes u1's plan before anything else", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.server.hooks.rpc = OFF;
  a.run('calNotes["2099-01-11"]="U1-offline-not"; saveLS("cal",calNotes)');
  a.server.hooks.rpc = undefined;
  a.run('AsaStorage.set(localStorage,"ams","trip",{})');              // home doLogout
  const b = await page(a, "u2");                                       // u2 already logged in (home page) → city page init → afterAuth(u2)
  assert.ok(!leaksU1(shown(b)), JSON.stringify(shown(b)));
  assert.equal(b.sync().owner, "u2");
  const it = items(b).find((x) => JSON.stringify(x.cal).includes("U1-offline-not"));
  assert.ok(it && it.uid === "u1" && it.trip_id === "7", "u1's unsynced edit kept for u1: " + JSON.stringify(it));
  assert.equal(it.start_date, "2099-01-10", "with trip 7's own dates (the home page had emptied asa:ams:trip)");
});
test("A7 a home-page search made AFTER the logout is the next person's: kept (dates), while the account's plan is removed", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.run('AsaStorage.set(localStorage,"ams","trip",{})');              // home doLogout
  const SEARCH = { country: "Hollanda", city: "Amsterdam", duration: null, duration_days: null, start_date: "2099-05-01", end_date: "2099-05-03", approx_period: null, vacation_types: ["Kültür"] };
  a.run(`AsaStorage.set(localStorage,"ams","trip",${JSON.stringify(SEARCH)})`);   // anonymous visitor's search on the home page
  const anon = await page(a, null);
  assert.ok(!leaksU1(shown(anon)));
  assert.equal(anon.ls("trip").start_date, "2099-05-01", "the new search is not wiped");
  assert.deepEqual(anon.val("CAL.days.map(d=>d.key)"), ["2099-05-01", "2099-05-02", "2099-05-03"]);
});
test("A8 (probe p3/p3b) another account's plan is never auto-imported into the next account's new trip", T, async () => {
  // p3: u1 plans on a trip without a DB id (approximate period, then dates), logs out; u2 logs in
  const d = boot();
  const a = await page(d, "u1");
  a.run('ASA_ST.set("trip",{country:"Hollanda",city:"Amsterdam",approx_period:"Nisan"}); PSET._reload()');
  a.run('PSET.setDate("startDate","2099-04-01"); PSET.setDate("endDate","2099-04-02")');
  a.run('calNotes["2099-04-01"]="U1-GIZLI-NOT"; saveLS("cal",calNotes); dayVenues["2099-04-01"]=["barpif"]; saveLS("dayven",dayVenues)');
  a.server.hooks.rest = (c) => (c.table === "trips" && c.op === "insert" ? { data: null, error: { message: "offline (test)" } } : undefined);   // u1's own import does not happen
  await logout(a);
  a.server.hooks.rest = undefined;
  await login(a, "u2");
  for (const t of a.server.tables.trips) assert.ok(!leaksU1(t) && !JSON.stringify(t).includes("U1-GIZLI"), "u1 data in a trip of " + t.user_id + ": " + JSON.stringify(t));
  assert.ok(!JSON.stringify(shown(a)).includes("U1-GIZLI"));
  // p3b: u1's trip 7 fully synced, u1 logs out; u2 searches with an approximate period, picks dates, reloads
  const d2 = twoAccounts();
  const c = await page(d2, "u1", "?trip=7&city=Amsterdam");
  await logout(c);
  c.run('AsaStorage.set(localStorage,"ams","trip",{country:"Hollanda",city:"Amsterdam",approx_period:"Haziran"})');
  const e = await page(c, "u2");
  e.run('PSET._reload(); PSET.setDate("startDate","2099-06-01"); PSET.setDate("endDate","2099-06-02")');
  const f = await page(e, "u2");
  for (const t of f.server.tables.trips.filter((x) => x.user_id === "u2")) assert.ok(!leaksU1(t), "u1's plan uploaded into u2's trip: " + JSON.stringify(t));
});
test("A9 u1's hidden photos come back when u1 logs in again (device-only data is never deleted by a logout)", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.run(`calPhotos["2099-01-10"]=[${JSON.stringify(U1_PHOTO)}]; saveLS("calphoto",calPhotos,true)`);
  await logout(a);
  const b = await page(a, "u2");
  b.run(`calPhotos["2099-03-02"]=["data:image/gif;base64,U2"]; saveLS("calphoto",calPhotos,true)`);
  assert.deepEqual(b.val('calPhotos["2099-01-10"]||null'), null, "u1's photo not shown to u2");
  await logout(b);
  const a2 = await page(b, "u1");
  assert.deepEqual(a2.val('calPhotos["2099-01-10"]'), [U1_PHOTO], "u1's photo back for u1");
  assert.equal(a2.val('calPhotos["2099-03-02"]||null'), null, "u2's photo not shown to u1");
  assert.deepEqual(a2.ls("calphoto")["~u:u2|2099-03-02"], ["data:image/gif;base64,U2"], "u2's photo kept (hidden) for u2");
});
test("A10 storage full at logout with an unsynced edit: nothing is deleted, the plan is not shown and not written over; released once space allows", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.server.hooks.rpc = OFF;
  a.run('calNotes["2099-01-11"]="U1-offline-not"; saveLS("cal",calNotes)');
  a.storage.failOn("asa:ams:plan_sync");                            // the version cannot be filed
  await logout(a);
  a.server.hooks.rpc = undefined;
  assert.ok(!leaksU1(onScreen(a)), "logged-out tab shows u1 data: " + JSON.stringify(onScreen(a)));
  assert.equal(a.ls("cal")["2099-01-11"], "U1-offline-not", "the only copy is not deleted");
  assert.equal(a.run("TripSync.foreign"), "u1");
  assert.ok(a.storeNotice().text.includes("Cihaz depolaması dolu"), a.storeNotice().text);
  assert.equal(a.run('calNotes["2099-01-12"]="anon"; saveLS("cal",calNotes)'), false, "writes over u1's plan are refused");
  assert.equal(a.run(`saveLS("calphoto",{"2099-01-12":["x"]},true)`), false);
  // u2 opens its own trip while still full: shown from memory, u1's plan kept on the device
  const b = await page(a, "u2", "?trip=9&city=Amsterdam");
  assert.ok(!leaksU1(onScreen(b)), JSON.stringify(onScreen(b)));
  assert.equal(b.ls("cal")["2099-01-11"], "U1-offline-not");
  // space freed: the next page releases it (kept for u1), u2's trip opens normally
  a.storage.allow("asa:ams:plan_sync");
  const c = await page(b, "u2", "?trip=9&city=Amsterdam");
  assert.equal(c.run("TripSync.foreign"), null);
  assert.equal(c.val("TRIP.id"), 9);
  assert.ok(!leaksU1(shown(c)));
  const it = items(c).find((x) => JSON.stringify(x.cal).includes("U1-offline-not"));
  assert.ok(it && it.uid === "u1" && it.trip_id === "7", JSON.stringify(items(c)));
  assert.deepEqual(c.val("TripSync.pending()"), []);
});
test("A11 (C12 extended) logout flushes a pending autosave before the session closes", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.run('calNotes["2099-01-12"]="son not"; saveLS("cal",calNotes)');   // inside the 1.2 s debounce
  await logout(a);
  assert.equal(a.server.trip(7).plan.cal["2099-01-12"], "son not", "the edit reached u1's trip before logout");
  assert.equal(items(a).length, 0, "nothing left to keep");
});
test("A12 storage nearly full at logout (the version does not fit, smaller writes do): nothing of the unsynced edit is wiped", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.server.hooks.rpc = OFF;
  a.run('calNotes["2099-01-11"]="U1-offline-not"; saveLS("cal",calNotes)');
  const q = quota(a.storage); q.free(0);                            // filing the version grows plan_sync: refused; shrinking writes still fit
  await logout(a);
  a.server.hooks.rpc = undefined;
  assert.equal(a.ls("cal")["2099-01-11"], "U1-offline-not", "the only copy of the edit was wiped");
  assert.equal(a.run("TripSync.foreign"), "u1");
  assert.ok(!leaksU1(onScreen(a)));
  q.off();
  const c = await page(a, null);
  assert.ok(items(c).some((x) => x.uid === "u1" && JSON.stringify(x.cal).includes("U1-offline-not")), "released and kept once space allows");
  assert.ok(!leaksU1(shown(c)));
});
test("A13 (second layer) importGuestTrip never carries a plan made by another account into this account's new trip", T, async () => {
  const GT = { city: "Amsterdam", country: "Hollanda", start_date: "2099-04-01", end_date: "2099-04-02" };
  const PS = { v: 1, synced: null, dirty: { trip_id: null }, edit: { trip_id: null, uid: "u1", start_date: GT.start_date, end_date: GT.end_date }, items: [] };
  const h = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(GT), "asa:ams:cal": JSON.stringify({ "2099-04-01": "U1-GIZLI-NOT" }), "asa:ams:plan_sync": JSON.stringify(PS) }) });
  h.useDb(); h.useRealAsa(); h.asa.set("db", h.db); h.server.uid = "u2"; h.asa.ev('session={uid:"u2",email:"",display_name:null}');
  assert.equal(h.val("TripSync.importable()"), false);
  await h.asa.ev("importGuestTrip()"); await settle(); h.runTimers(); await settle();
  for (const t of h.server.tables.trips) assert.ok(!JSON.stringify(t).includes("U1-GIZLI"), "u1's note uploaded into u2's new trip: " + JSON.stringify(t));
  const it = items(h).find((x) => JSON.stringify(x.cal).includes("U1-GIZLI"));
  assert.ok(it && it.uid === "u1", "kept for its author: " + JSON.stringify(items(h)));
  assert.deepEqual(h.val("TripSync.pending()"), []);
});
test("A14 (second layer) a kept version tagged with another account is never offered, even on a trip id it names", T, async () => {
  const PS = { v: 1, synced: null, dirty: null, items: [{ trip_id: "9", uid: "u1", reason: "replaced", at: "2099-01-01T00:00:00.000Z", sig: "x.1", start_date: null, end_date: null, dayven: {}, cal: { "2099-03-01": "U1-GIZLI-NOT" }, plan: {}, plan_prefs: {} }] };
  const d = boot({ storage: fakeStorage({ "asa:ams:plan_sync": JSON.stringify(PS) }) });
  d.server.tables.trips.push(row9());
  const b = await page(d, "u2", "?trip=9&city=Amsterdam");
  assert.equal(b.val("TRIP.id"), 9);
  assert.deepEqual(b.val("TripSync.pending()"), []);
  assert.equal(b.notice().hidden, true);
});

// ================================================================================================ M  storage nearly full: marker first
// a browser-like quota: the sum of key + value characters of the whole store may not exceed a cap; free(n) leaves n characters
function quota(storage) {
  const real = storage.setItem.bind(storage); let cap = Infinity;
  const total = () => storage.keys().reduce((n, k) => n + k.length + storage.raw(k).length, 0);
  storage.setItem = (k, v) => { k = String(k); v = String(v); const cur = storage.raw(k); const next = total() - (cur == null ? 0 : k.length + cur.length) + k.length + v.length;
    if (next > cap) { storage.log.push(["set", k]); const e = new Error("quota (test)"); e.name = "QuotaExceededError"; e.code = 22; throw e; } return real(k, v); };
  return { free(n) { cap = total() + n; }, off() { cap = Infinity; } };
}
const fullMsg = (h) => h.sb.__alerts.some((m) => /depolaması dolu/.test(m));
test("M1 an edit whose own write fits but whose 'unsynced' marker does not is refused, reverted on screen and the user told (never silently unprotected)", T, async () => {
  for (const [name, code] of [["add venue", 'dayVenues["2099-01-10"]=["barpif","chun","x1"]; saveLS("dayven",dayVenues)'], ["reorder", 'dayVenues["2099-01-10"]=["chun","barpif"]; saveLS("dayven",dayVenues)'], ["note", 'calNotes["2099-01-11"]="10:00"; saveLS("cal",calNotes)']]) {
    const h = tripOn(row());
    const q = quota(h.storage); q.free(8);
    const ok = h.run(code);
    assert.equal(ok, false, name + ": the change was written without its marker");
    assert.ok(fullMsg(h), name + ": user told: " + JSON.stringify(h.sb.__alerts));
    assert.deepEqual(h.val("dayVenues"), P0, name + ": screen reverted");
    assert.deepEqual(h.val("calNotes"), {}, name);
    assert.deepEqual(h.ls("dayven"), P0, name + ": device unchanged");
    assert.equal(h.sync().dirty, null, name);
    q.off();
    const k = await reopen(h, 7);                                     // nothing was lost silently: the device and the server agree
    assert.deepEqual(k.ls("dayven"), P0, name); assert.equal(items(k).length, 0, name);
  }
});
test("M2 PSET.setDate and savePrefs are refused (not silently unprotected) when the marker cannot be written", T, async () => {
  const h = tripOn(row());
  h.run("PSET._reload()");
  const q = quota(h.storage); q.free(0);
  h.run('PSET.setDate("endDate","2099-01-13")');
  assert.equal(h.ls("trip").end_date, "2099-01-12", "date written without its marker");
  assert.equal(h.val("PSET.getPrefs().endDate"), "2099-01-12", "form reverted");
  assert.ok(fullMsg(h), JSON.stringify(h.sb.__alerts));
  h.sb.__alerts.length = 0;
  h.run('PSET.submit()');
  assert.ok(fullMsg(h), "savePrefs: user told");
  assert.equal(h.sync().dirty, null);
  q.off();
  const k = await reopen(h, 7);
  assert.equal(k.ls("trip").end_date, "2099-01-12"); assert.equal(items(k).length, 0);
});
test("M3 guest device (marker present, no edit yet): a note that fits but whose marker does not is refused — the guest plan is never wiped at first login", T, async () => {
  const GT = { city: "Amsterdam", country: "Hollanda", start_date: "2099-03-03", end_date: "2099-03-05" };
  const h = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(GT), "asa:ams:plan_sync": JSON.stringify({ v: 1, synced: null, dirty: null, items: [] }) }) });
  h.useDb();
  const q = quota(h.storage); q.free(30);
  assert.equal(h.run('calNotes["2099-03-03"]="Rijks 10:00"; saveLS("cal",calNotes)'), false);
  assert.ok(fullMsg(h));
  q.off();
  h.run('calNotes["2099-03-03"]="Rijks 10:00"; saveLS("cal",calNotes)');   // space freed: the same note is now kept and marked
  assert.equal(h.val("TripSync.localState()"), "unsynced");
  await h.asa.ev("importGuestTrip()"); await settle(); h.runTimers(); await settle();
  const t = h.server.tables.trips[0];
  assert.ok(t && t.plan && t.plan.cal["2099-03-03"] === "Rijks 10:00", "guest note imported: " + JSON.stringify(t));
});
test("M4 (guard) the marker written before a change is taken back when the change itself cannot be written", T, async () => {
  const h = tripOn(row());
  h.storage.failOn("asa:ams:dayven");
  assert.equal(h.run('dayVenues["2099-01-10"]=["x1"]; saveLS("dayven",dayVenues)'), false);
  assert.equal(h.sync().dirty, null, "no false 'unsynced' marker on an unchanged plan");
});

// ================================================================================================ K  a kept version keeps its own trip's dates
// the home page's real saveTrip (index.html) on the same storage: rewrites asa:ams:trip with the new search (no id)
function homeSaveTrip(h, sel) {
  const html = read("index.html");
  const i = html.indexOf("async function saveTrip(navigate){"), j = html.indexOf("\n}\n", i);
  const src = html.slice(i, j + 2);
  h.run(`(function(){ var COUNTRIES=[{code:"nl",name:"Hollanda",cities:[{name:"Amsterdam",active:true}]}]; var sel=${JSON.stringify(sel)}; sel.types=new Set(sel.types||[]); var session=null;
    ${src}
    saveTrip(false); })()`);
}
test("K1 offline edit on trip 7, home page picks new dates, trip 8 opens: the copy for 7 carries 7's dates; restoring on 7 keeps Jan 10-12", T, async () => {
  for (const mode of ["offline", "debounce"]) {
    const h = tripOn(row());
    if (mode === "offline") { h.server.hooks.rpc = OFF; h.edit("cal", { "2099-01-10": "Ocak notu" }); await h.run("TripSync.flush()"); await settle(); h.server.hooks.rpc = undefined; }
    else h.edit("cal", { "2099-01-10": "Ocak notu" });                // page left inside the debounce
    homeSaveTrip(h, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-03-10", endDate: "2099-03-12", approx: null, types: [] });
    assert.equal(h.ls("trip").start_date, "2099-03-10", "precondition: the home page rewrote the local trip");
    h.server.tables.trips.push(ROW8());
    const k = bootLike(h, { search: "?trip=8&city=Amsterdam" }); k.useDb(); await k.asa.ev("loadTripContext()"); await settle();
    const it = items(k).find((x) => x.trip_id === "7");
    assert.ok(it, mode + ": copy kept for trip 7");
    assert.equal(it.start_date, "2099-01-10", mode + ": the copy took the new search's dates"); assert.equal(it.end_date, "2099-01-12");
    const k7 = await reopen(k, 7);
    assert.equal(k7.notice().hidden, false);
    assert.ok(!/Mar/.test(k7.notice().text), mode + ": notice announces other dates: " + k7.notice().text);
    k7.el("tripSyncRestore").click(); await settle(); k7.runTimers(); await settle(60);
    const s = k7.server.trip(7);
    assert.equal(s.start_date, "2099-01-10", mode + ": restore rewrote trip 7's dates"); assert.equal(s.end_date, "2099-01-12");
    assert.equal(s.plan.cal["2099-01-10"], "Ocak notu");
    assert.ok(k7.val("CAL.days.map(d=>d.key)").includes("2099-01-10"), mode + ": the restored day is visible");
  }
});

// ================================================================================================ F  favourites never cross accounts / vanish
async function favLogin(h, uid, cloud = []) {
  for (const id of cloud) h.server.tables.favorites.push({ user_id: uid, venue_id: id, city: "Amsterdam" });
  h.server.uid = uid; h.useRealAsa(); h.asa.set("db", h.db);
  await h.asa.ev(`syncOnLogin(${JSON.stringify(uid)},"qa",false)`); await settle();
}
const FAIL_FAV = (c) => (c.table === "favorites" && (c.op === "upsert" || c.op === "delete") ? { data: null, error: { message: "TypeError: Failed to fetch" } } : undefined);
test("F1 logged-in heart tap while offline and fav_sync cannot grow: the change is reverted and the user told (no silent loss / resurrection)", T, async () => {
  // add
  const h = boot(); await favLogin(h, "u1", ["c9", "x2"]);
  const q = quota(h.storage); q.free(20);
  h.server.hooks.rest = FAIL_FAV;
  h.run('toggleFav("x1")'); await settle();
  assert.equal(h.run('isFav("x1")'), false, "the unsaved favourite stays on screen");
  assert.ok(!JSON.parse(h.storage.raw("asa:ams:fav")).includes("x1"), "device list reverted");
  assert.ok(h.sb.__alerts.some((m) => m.includes("Favorin kaydedilemedi")), JSON.stringify(h.sb.__alerts));
  // remove
  const k = boot(); await favLogin(k, "u1", ["c9", "x2"]);
  const q2 = quota(k.storage); q2.free(0);
  k.server.hooks.rest = FAIL_FAV;
  k.run('toggleFav("x2")'); await settle();
  assert.equal(k.run('isFav("x2")'), true, "a removal that reached neither the account nor the device is shown as done");
  assert.ok(k.sb.__alerts.some((m) => m.includes("Favorin kaydedilemedi")));
  q.off(); q2.off();
});
test("F2 first login on a nearly full device (fav_sync cannot be written): the account's favourites are not left on the device without an owner", T, async () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:fav": '["p1"]' }) });
  h.storage.failOn("asa:ams:fav_sync");
  await favLogin(h, "u1", ["c9"]);
  assert.ok(h.run('isFav("c9")'), "shown in this session");
  assert.deepEqual(JSON.parse(h.storage.raw("asa:ams:fav")), ["p1"], "device list not overwritten with an ownerless account copy");
  h.run('toggleFav("x2")'); await settle();                          // a heart tap while the owner still cannot be written
  assert.deepEqual(JSON.parse(h.storage.raw("asa:ams:fav")), ["p1"], "a heart tap left the account list on the device without an owner");
  assert.ok(h.run('isFav("x2")'), "shown in this session");
  // session expiry instead of logout: the next account on this device gets none of u1's favourites
  const x = bootLike(h); x.storage.allow("asa:ams:fav_sync"); await favLogin(x, "u2", []);
  assert.ok(!x.server.favIds("u2").includes("c9") && !x.server.favIds("u2").includes("x2"), "u1's favourites uploaded into u2: " + JSON.stringify(x.server.favIds("u2")));
  x.server.tables.favorites = x.server.tables.favorites.filter((f) => f.user_id !== "u2"); x.storage.failOn("asa:ams:fav_sync");
  await h.asa.ev("logout()"); await settle();
  assert.equal(h.run("favSet.size"), 0, "account favourites cleared at logout");
  h.storage.allow("asa:ams:fav_sync");
  await favLogin(h, "u2", []);
  assert.deepEqual(h.server.favIds("u2"), [], "u1's favourites uploaded into u2");
  const k = bootLike(h); await favLogin(k, "u2", []);                // reload variant
  assert.deepEqual(k.server.favIds("u2"), []);
});
test("F3 storage not writable (library missing / locked city / every write fails): u1's favourites leave the tab at logout, never reach u2", T, async () => {
  for (const o of [{ lib: false }, { city: "Kopenhag" }, { fail: true }]) {
    const h = boot(o.fail ? {} : o);
    if (o.fail) h.storage.failOn("*");
    await favLogin(h, "u1", ["x1", "x2"]);
    assert.ok(h.run('isFav("x1")'), JSON.stringify(o) + ": precondition");
    await h.asa.ev("logout()"); await settle();
    assert.equal(h.run("favSet.size"), 0, JSON.stringify(o) + ": u1's favourites still in the tab");
    await favLogin(h, "u2", ["x3"]);
    assert.deepEqual(h.server.favIds("u2"), ["x3"], JSON.stringify(o) + ": uploaded into u2");
  }
});
test("F4 (D6.7 through onFav) a logged-in heart tap whose server write fails is kept for that account only and retried at its next login", T, async () => {
  for (const add of [true, false]) {
    const h = boot(); await favLogin(h, "u1", add ? ["c9"] : ["c9", "x1"]);
    h.server.hooks.rest = FAIL_FAV;
    h.run('toggleFav("x1")'); await settle();
    h.server.hooks.rest = undefined;
    const op = (h.favSync().ops || []).find((o) => o.id === "x1");
    assert.ok(op && op.uid === "u1" && op.op === (add ? "add" : "del"), "failed write not kept: " + JSON.stringify(h.favSync().ops));
    await h.asa.ev("logout()"); await settle();
    assert.deepEqual(h.val('favLoginPlan([],"u2")').adds, [], "never applied to another account");
    await favLogin(h, "u1", []);
    assert.equal(h.server.favIds("u1").includes("x1"), add, (add ? "add" : "del") + " not retried at u1's next login: " + JSON.stringify(h.server.favIds("u1")));
  }
});

// ================================================================================================ S  same-device tabs after a snapshot + guards
test("S1 (PSNAP) two tabs: the other tab generated a plan (save + plan snapshot) — this tab's next edit is not a false conflict", T, async () => {
  const t1 = tripOn(row());
  const t2 = bootLike(t1); t2.useDb(); t2.open(row());
  t2.run('dayVenues["2099-01-12"]=["pllek"]; saveLS("dayven",dayVenues)'); ev(t1, ["dayven", "plan_sync"]);
  await t2.run("__snapshotPlan()"); await settle(60); ev(t1, ["plan_sync"]);
  assert.equal(t1.server.trip(7).plan_version, 1, "precondition: snapshot recorded");
  assert.equal(String(t1.sync().synced.rev), String(t1.server.trip(7).revision), "the snapshot's revision is recorded as this device's own");
  t1.run('calNotes["2099-01-11"]="tab1 notu"; saveLS("cal",calNotes)');
  await t1.run("TripSync.flush()"); await settle(60);
  assert.equal(items(t1).length, 0, "false conflict copy: " + JSON.stringify(items(t1).map((x) => x.reason)));
  assert.equal(t1.server.trip(7).plan.cal["2099-01-11"], "tab1 notu");
  assert.deepEqual(t1.server.trip(7).plan.dayven["2099-01-12"], ["pllek"], "the other tab's day kept");
  assert.equal(t1.notice().hidden, true);
});
test("S2 (PSNAP2) the real 'Planımı oluştur' path in tab 2 (submit → autosave → snapshot), then tab 1 edits: rebased, no copy, both on the server", T, async () => {
  const t1 = tripOn(row());
  const t2 = bootLike(t1); t2.useDb(); t2.open(row());
  t2.run("PSET._reload(); PSET.edit(); PSET.submit()");
  for (let i = 0; i < 4; i++) { t2.runTimers(); await settle(60); }
  ev(t1, ["plan_prefs", "trip", "dayven", "plan", "cal", "plan_sync"]);
  assert.equal(t2.server.rpcs("trip_snapshot_plan").length, 1, "precondition");
  t1.run('calNotes["2099-01-11"]="tab1 notu"; saveLS("cal",calNotes)');
  await t1.run("TripSync.flush()"); await settle(80);
  assert.equal(items(t1).length, 0, JSON.stringify(items(t1).map((x) => x.reason)));
  assert.equal(t1.val("TripSync.status"), "saved");
  assert.equal(t1.server.trip(7).plan.cal["2099-01-11"], "tab1 notu");
});
test("S3 (PB15) the other tab saves twice with the same content (revision moves): this tab still rebases, no copy", T, async () => {
  const t1 = tripOn(row());
  const t2 = bootLike(t1); t2.useDb(); t2.open(row());
  t2.run('calNotes["2099-01-10"]="tab2 notu"; saveLS("cal",calNotes)'); ev(t1, ["cal", "plan_sync"]);
  await t2.run("TripSync.flush()"); await settle(); ev(t1, ["plan_sync"]);
  await t2.run("TripSync.flush()"); await settle(); ev(t1, ["plan_sync"]);
  assert.equal(t1.server.trip(7).revision, 7, "precondition");
  t1.run('calNotes["2099-01-11"]="tab1 notu"; saveLS("cal",calNotes)');
  await t1.run("TripSync.flush()"); await settle(60);
  assert.deepEqual(t1.server.trip(7).plan.cal, { "2099-01-10": "tab2 notu", "2099-01-11": "tab1 notu" });
  assert.equal(items(t1).length, 0);
});
test("S4 (PA04) same tab: logout + login again while storage is full — the held unsynced plan is still not overwritten", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  h.storage.failOn("asa:ams:plan_sync");
  await h.run("TripSync.flush()"); await settle();
  assert.deepEqual(h.ls("dayven"), P1, "precondition (D5.4)");
  h.run("TripSync.reset()");
  h.open(J(h.server.trip(7)));
  assert.deepEqual(h.ls("dayven"), P1, "the only durable copy of the unsynced edit is not overwritten on the re-open");
  h.storage.allow("asa:ams:plan_sync");
  const k = await reopen(h, 7);
  assert.ok(items(k).some((x) => x.trip_id === "7" && JSON.stringify(x.dayven) === JSON.stringify(P1)), "after freeing space the edit is kept");
});
test("S5 (PC02) failed restore of a memory-only copy while the marker is clear: after reload the partly restored version is still offered", T, async () => {
  const t1 = tripOn(row());
  const t2 = bootLike(t1); t2.useDb(); t2.open(row());
  t2.run('dayVenues["2099-01-11"]=["coba","p1"]; saveLS("dayven",dayVenues)');
  t1.storage.failOn("asa:ams:plan_sync");
  t1.run('dayVenues["2099-01-11"]=["coba","x3"]; saveLS("dayven",dayVenues)');
  t1.storage.allow("asa:ams:plan_sync");
  // the clash copy could not be filed (marker write failed → the change was refused); make the copy memory-only the r2 way
  if (!t1.val("TripSync.pending().length")) {
    t1.storage.failOn("asa:ams:plan_sync");
    t1.run('TripSync.keepTab({start_date:"2099-01-10",end_date:"2099-01-12",dayven:' + JSON.stringify(Object.assign({}, P0, { "2099-01-11": ["coba", "p1"] })) + ',cal:{},plan:{},plan_prefs:' + JSON.stringify(row().preferences.plan_prefs) + '})');
    t1.storage.allow("asa:ams:plan_sync");
    t1.run('dayVenues["2099-01-11"]=["coba","x3"]; saveLS("dayven",dayVenues)');
  }
  assert.equal(t1.val("TripSync.pending()[0].mem"), true, "precondition: memory-only copy");
  await t1.run("TripSync.flush()"); await settle(60);
  assert.equal(t1.sync().dirty, null, "precondition: marker clear");
  t1.storage.failOn("asa:ams:cal");
  t1.el("tripSyncRestore").click(); await settle();
  t1.storage.allow("asa:ams:cal");
  const k = await reopen(t1, 7);
  assert.ok(items(k).some((x) => x.trip_id === "7" && JSON.stringify((x.dayven || {})["2099-01-11"]) === '["coba","p1"]') || JSON.stringify((k.server.trip(7).plan.dayven || {})["2099-01-11"]) === '["coba","p1"]',
    "tab 2's version is gone after the reload: items=" + JSON.stringify(items(k).map((x) => x.reason)) + " local=" + JSON.stringify(k.ls("dayven")));
});
test("S6 (D1.12 case C) at most ONE rebase even when the server revision keeps moving (each re-read sees a newer revision)", T, async () => {
  const drive = async (h) => { await h.run("TripSync.flush()"); for (let i = 0; i < 60; i++) { await settle(10); h.runTimers(); } await settle(40); };
  const a = tripOn(row());
  a.server.hooks.rpc = (n, x, S) => { if (n === "trip_save") S.trip(7).revision++; return undefined; };   // another writer, same content
  a.edit("dayven", P1); await drive(a);
  assert.deepEqual(a.saves().map((c) => c.args.p_expected_rev), [5, 6], "rebase/resend loop");
  assert.equal(a.val("TripSync.status"), "error");
  assert.deepEqual(a.server.trip(7).plan.dayven, P0, "server content untouched");
  const b = tripOn(row());
  b.server.hooks.rpc = (n) => (n === "trip_save" ? { data: { ok: false, reason: "conflict" }, error: null } : undefined);
  b.server.hooks.rest = (c, S) => { if (c.table === "trips" && c.op === "select" && c.filters.some((f) => f[1] === "id")) S.trip(7).revision++; return undefined; };
  b.edit("dayven", P1); await drive(b);
  assert.equal(b.saves().length, 2, "forced conflicts with a moving revision: " + b.saves().length);
  const c = tripOn(row());                                          // no progress: no rebase at all
  c.server.hooks.rpc = (n) => (n === "trip_save" ? { data: { ok: false, reason: "conflict", server: { revision: 5 } }, error: null } : undefined);
  c.edit("dayven", P1); await drive(c);
  assert.equal(c.saves().length, 1);
  const d = tripOn(row({ revision: 6 }));                           // stale re-read (older than rejected): no rebase, revision not lowered
  d.server.hooks.rpc = (n) => (n === "trip_save" ? { data: { ok: false, reason: "conflict" }, error: null } : undefined);
  d.server.hooks.rest = (q, S) => { if (q.table === "trips" && q.op === "select") S.trip(7).revision = 4; return undefined; };
  d.edit("dayven", P1); await drive(d);
  assert.equal(d.saves().length, 1); assert.equal(d.val("TRIP.revision"), 6);
});
// gate TripStore.get inside the page (resolveConflict's re-read) until __rel() is called
function gateGet(h) { h.run("var __rel; var __gp=new Promise(function(r){__rel=r;}); var __og=TripStore.get; window.__gets=0; TripStore.get=async function(id){ window.__gets++; await __gp; return __og(id); };"); }
test("S7 (PD1o) logout while a conflict is being resolved: the trip is not re-opened in the logged-out tab", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  gateGet(h);
  const p = h.run("TripSync.flush()");
  for (let i = 0; i < 40 && !h.run("window.__gets"); i++) await settle(2);
  assert.equal(h.run("window.__gets"), 1, "precondition: re-read in flight");
  h.run("TripSync.reset()");
  h.run("__rel()"); await p; await settle(60);
  assert.ok(!h.run("window.TRIP"), "logged-out tab has a TRIP again");
  assert.deepEqual(h.ls("dayven"), P1, "storage rewritten after logout");
  assert.equal(items(h).length, 0, "a copy was filed after logout");
});
test("S8 (PD1n) a save that returns after the tab switched trips never touches the new trip's revision", T, async () => {
  const h = tripOn(row());
  h.server.tables.trips.push(ROW8());
  h.edit("dayven", P1);
  h.server.hold = true;
  const p = h.run("TripSync.flush()"); await settle(8);
  assert.equal(h.saves().length, 1, "precondition: save in flight");
  h.run("TripSync.reset()"); h.open(ROW8());
  h.server.hold = false; h.server.release(); await p; await settle(40);
  assert.equal(h.val("TRIP.id"), 8);
  assert.equal(h.val("TRIP.revision"), 1, "trip 8 took trip 7's revision");
  h.edit("dayven", { "2099-02-10": ["pllek", "oeuf"] });
  await h.run("TripSync.flush()"); await settle(60);
  assert.deepEqual(h.server.trip(8).plan.dayven, { "2099-02-10": ["pllek", "oeuf"] }, "trip 8's edit not saved");
});
test("S9 (PR1k) a conflict that returns after another tab opened another trip writes nothing into that trip's storage", T, async () => {
  const t1 = tripOn(row());
  serverEdit(t1, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  t1.edit("dayven", P1);
  t1.server.tables.trips.push(ROW8());
  t1.server.hold = true;
  const p = t1.run("TripSync.flush()"); await settle(8);
  const t2 = bootLike(t1); t2.useDb(); t2.open(ROW8());
  t1.server.hold = false; t1.server.release(); await p; await settle(60);
  assert.equal(t1.ls("trip").id, 8, "trip 8's storage replaced by trip 7");
  assert.deepEqual(t1.ls("dayven"), ROW8().plan.dayven, "trip 8's plan overwritten");
  assert.ok(!items(t1).some((x) => x.trip_id === "7" && JSON.stringify(x.dayven) === JSON.stringify(ROW8().plan.dayven)), "trip 8's plan filed as a trip-7 version");
});
test("S10 (PR1j) restore in a tab whose storage now holds another tab's trip writes nothing there", T, async () => {
  const t1 = tripOn(row());
  serverEdit(t1, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  t1.edit("dayven", P1); await t1.run("TripSync.flush()"); await settle();
  assert.equal(t1.notice().reason, "conflict", "precondition");
  t1.server.tables.trips.push(ROW8());
  const t2 = bootLike(t1); t2.useDb(); t2.open(ROW8());
  const before = { dv: t1.ls("dayven"), tr: t1.ls("trip") };
  t1.el("tripSyncRestore").click(); await settle(40);
  assert.deepEqual(t1.ls("dayven"), before.dv, "trip 7's version written into trip 8's storage");
  assert.deepEqual(t1.ls("trip"), before.tr, "trip 8's dates rewritten");
  ev(t2, ["dayven", "cal", "plan", "trip"]);
  t2.run('calNotes["2099-02-11"]="t2"; saveLS("cal",calNotes)'); await t2.run("TripSync.flush()"); await settle(40);
  assert.deepEqual(t2.server.trip(8).plan.dayven, ROW8().plan.dayven, "trip 7's plan uploaded into trip 8");
  assert.equal(t2.server.trip(8).start_date, "2099-02-10");
});
test("S11 (PD4t) unsynced edit on trip A + home page picks new dates (no id) → reopening A never rewrites A's dates", T, async () => {
  const h = tripOn(row());
  h.edit("dayven", P1);
  h.storage.setItem("asa:ams:trip", JSON.stringify({ country: "Hollanda", city: "Amsterdam", start_date: "2099-02-01", end_date: "2099-02-02", vacation_types: [] }));
  const k = await reopen(h, 7);
  const s = k.server.trip(7);
  assert.equal(s.start_date, "2099-01-10", "trip A's start date rewritten to the new search: " + s.start_date);
  assert.equal(s.end_date, "2099-01-12");
  const it = items(k).find((x) => x.trip_id === "7" && JSON.stringify(x.dayven) === JSON.stringify(P1));
  assert.ok(it, "A's unsynced plan kept as a version");
  assert.equal(it.start_date, "2099-01-10", "with A's own dates");
});
test("S12 (PD4w) pre-WP6 device holding trip 7 + an edited plan opens trip 8: filed under trip 7, never offered on trip 8", T, async () => {
  const st = fakeStorage({ "asa:ams:trip": JSON.stringify({ id: 7, revision: 5, city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12" }), "asa:ams:dayven": JSON.stringify(P1), "asa:ams:cal": JSON.stringify({ "2099-01-10": "Anne Frank 10:00" }) });
  const h = boot({ storage: st });
  assert.equal(h.sync(), null, "precondition: legacy (no marker)");
  h.server.tables.trips.push(row(), ROW8()); h.useDb(); h.open(ROW8());
  const it = items(h)[0];
  assert.ok(it, "kept"); assert.equal(it.trip_id, "7", "filed as " + JSON.stringify(it && it.trip_id));
  assert.deepEqual(h.val("TripSync.pending()"), [], "trip 7's plan offered on trip 8");
  assert.equal(h.notice().hidden, true);
});
test("S13 (PD4u / EFX-D4u) empty plan + date-only change while another device saved: the date change is kept as a version and offered", T, async () => {
  const E = row({ preferences: {}, plan: { dayven: {}, cal: {}, plan: {} } });
  const h = tripOn(E);
  h.run('PSET._reload(); PSET.setDate("endDate","2099-01-14")');
  assert.equal(h.val("TripSync.localState()"), "unsynced", "precondition");
  serverEdit(h, 7, { plan: { dayven: { "2099-01-10": ["chun"] }, cal: {}, plan: {} } });
  const k = await reopen(h, 7);
  assert.ok(items(k).some((x) => x.trip_id === "7" && x.end_date === "2099-01-14"), "date change dropped silently: " + JSON.stringify(items(k)));
  assert.equal(k.notice().hidden, false);
});
test("S14 (PD3k / EFX-D3k) legacy guest plan with a hand-added day (venues, no text) is a user edit: login creates the trip WITH it", T, async () => {
  const GT = { city: "Amsterdam", country: "Hollanda", start_date: "2099-03-03", end_date: "2099-03-05" };
  const DV = { "2099-03-03": ["oeuf"], "2099-03-04": ["chun", "x1"] };
  const PL = { "2099-03-03": "Sabah: Mekan oeuf (Merkez)" };
  const h = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(GT), "asa:ams:dayven": JSON.stringify(DV), "asa:ams:plan": JSON.stringify(PL) }) });
  h.useDb();
  assert.equal(h.val("TripSync.localState()"), "unsynced");
  await h.asa.ev("importGuestTrip()"); await settle(); h.runTimers(); await settle();
  const t = h.server.tables.trips[0];
  assert.ok(t, "trip created");
  assert.deepEqual((t.plan || {}).dayven, DV, "guest plan pushed with the hand-added day");
});

// ================================================================================================ U  notice UX
async function conflictOn() {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  return h;
}
test("U1 the destructive choice is named before the buttons; 'Sonra karar ver' hides the notice for this tab and keeps the version", T, async () => {
  const h = await conflictOn();
  assert.ok(h.notice().text.includes("Sunucudaki planla devam edersen bu cihazdaki sürüm silinir."), h.notice().text);
  assert.equal(h.el("tripSyncLater").textContent, "Sonra karar ver");
  h.el("tripSyncLater").click();
  assert.equal(h.notice().hidden, true, "notice hidden");
  assert.equal(items(h).length, 1, "the version is kept");
  assert.notEqual(h.val("TripSync.status"), "conflict", "the 'newer plan loaded' pill is dismissed too");
  const k = await reopen(h, 7);
  assert.equal(k.notice().hidden, false, "offered again after a reload");
});
test("U2 discarding offers 'Geri al' until Kapat: the deleted version comes back", T, async () => {
  const h = await conflictOn();
  h.el("tripSyncDiscard").click(); await settle();
  assert.equal(items(h).length, 0);
  assert.equal(h.dom.document.activeElement && h.dom.document.activeElement.id, "tripSyncClose", "focus stays on Kapat");
  assert.ok(h.el("tripSyncUndo"), "undo offered");
  h.el("tripSyncUndo").click(); await settle();
  assert.equal(items(h).length, 1, "version back");
  assert.deepEqual(items(h)[0].dayven, P1);
  assert.equal(h.notice().hidden, false); assert.equal(h.notice().reason, "conflict");
});
test("U3 a conflict while the day modal is open: the modal says so and 'Seçenekleri gör' closes it and focuses the notice; the pill leads there too", T, async () => {
  const h = tripOn(row());
  h.dom.add("dayModal", "div", "daymodal"); h.dom.add("daySyncNote", "div", "asa-sn hide", { role: "status" });
  h.run('window.closeDay=function(){ document.getElementById("dayModal").classList.add("hide"); window.__closed=(window.__closed||0)+1; }');
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  const n = h.el("daySyncNote");
  assert.ok(!n.classList.contains("hide"), "note shown inside the open modal");
  assert.ok(n.textContent.includes("başka bir cihazda ya da sekmede değiştirildi"), n.textContent);
  h.el("daySyncShow").click();
  assert.equal(h.run("window.__closed"), 1, "modal closed");
  assert.equal(h.dom.document.activeElement && h.dom.document.activeElement.id, "tripSyncRestore", "focus on the first choice");
  const p = h.el("tripSyncPill");
  assert.equal(p.getAttribute("role"), "button"); assert.equal(p.style.pointerEvents, "auto");
  h.el("dayModal").classList.remove("hide"); h.dom.document.activeElement = h.dom.document.body;
  p.click();
  assert.equal(h.run("window.__closed"), 2); assert.equal(h.dom.document.activeElement.id, "tripSyncRestore");
  h.el("tripSyncDiscard").click();
  assert.ok(h.el("daySyncNote").classList.contains("hide"), "modal note gone once decided");
});
test("U4 the open day modal is re-rendered with the server plan without dropping the focused field (later keystrokes are not lost)", T, async () => {
  const h = tripOn(row());
  h.dom.add("dayModal", "div", "daymodal");
  h.run('renderDay=function(d){ var o=document.getElementById("dayNote"); if(o)o.remove(); var n=document.createElement("textarea"); n.id="dayNote"; n.value=calNotes[d]||""; document.body.appendChild(n); }; dayCur="2099-01-11"; renderDay(dayCur); document.getElementById("dayNote").focus();');
  h.run('__asaReloadPlanState()');
  assert.equal(h.run('document.activeElement===document.getElementById("dayNote")'), true, "focus left on the replaced (detached) field");
});
test("A15 home page logout (index.html doLogout) empties the account's Amsterdam trip, keeps the WP4 logout semantics, never touches legacy keys", T, async () => {
  const src = read("index.html");
  const i = src.indexOf("async function doLogout(){"), body = src.slice(i, src.indexOf("\n}\n", i) + 2);
  const run = async (init) => {
    const st = fakeStorage(init);
    const c = vm.createContext({ localStorage: st, console });
    c.window = c;
    vm.runInContext(read("lib/asa-storage/asa_storage.js"), c);     // the home page loads the same library (no city page here)
    vm.runInContext(`var loggingOut=false, session={uid:"u1"}, db={auth:{signOut:async function(){}}};
      function $(){ return null; } var ASA_DLG={close:function(){}}; function renderAcct(){} function renderAuthBody(){} function renderTripHub(){} function wp5Reset(){}
      ${body}`, c);
    st.log.length = 0;
    await vm.runInContext("doLogout()", c); await settle();
    return st;
  };
  const a = await run({ "asa:ams:trip": JSON.stringify({ id: 7, city: "Amsterdam", start_date: "2099-01-10", end_date: "2099-01-12" }), asa_session: '{"uid":"u1"}' });
  assert.equal(a.raw("asa:ams:trip"), "{}", "the account's trip stays on the device after a home logout");
  assert.equal(a.raw("asa_session"), null, "asa_session removed (WP4 semantics)");
  assert.ok(!a.log.some(([op, k]) => op === "remove" && k !== "asa_session"), "only asa_session is removed");
  const b = await run({ asa_trip: JSON.stringify({ city: "Amsterdam", start_date: "2099-01-10", end_date: "2099-01-12" }) });
  assert.equal(b.raw("asa:ams:trip"), null, "a legacy-only trip is not converted or hidden by the logout");
  assert.ok(b.raw("asa_trip"), "legacy key untouched");
  const e = await run({});
  assert.equal(e.raw("asa:ams:trip"), null, "no trip: nothing written");
});
