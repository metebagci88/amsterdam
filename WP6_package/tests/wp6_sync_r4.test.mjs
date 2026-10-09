// WP6 · sync integrity, fixer round 4 (independent verification of round 3). Same harness as the other WP6 tests: the city page's
// REAL code in a vm sandbox (./_page.mjs), the real membership closure (init / afterAuth / logout), the home page's real doLogout /
// saveTrip, fake Storage shared between "tabs" / reloads / accounts, fake Supabase with per-user RLS on trips and favourites.
//   N  plan without exact dates ("tarih belli değil"): logout / expiry never puts it out of its account's reach
//   W  two tabs, two accounts: a tab whose session ended in another tab writes nothing (owner, photos, favourites, plan)
//   P  calendar photos (device-only): two-tab merge, never lost / unhidden by a stale copy
//   L  devices last used before WP6 (production): no owner marker — nothing of the previous account reaches the next one
//   O  new home search while the device still holds the previous trip's copy (offline): new notes belong to the new search
//   G  the login window: the device plan's owner is decided before any request; the session read blocks plan writes
//   C  coverage for round-3 guards no test exercised (mutation-checked)
//   X  wording / UX: memory-only versions, storage-full typing in the day modal
//   node --test WP6_package/tests/
// Test data only: user ids "u1"/"u2", trip ids 7/8/9, year 2099, marker strings; no e-mail addresses, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { boot, bootLike, fakeStorage, fnSrc, read, settle, J } from "./_page.mjs";

const T = { timeout: 20000 };
const P0 = { "2099-01-10": ["barpif", "chun"], "2099-01-11": ["coba"] };
const P1 = { "2099-01-10": ["barpif", "chun", "x1"], "2099-01-11": ["coba"] };
const P2 = { "2099-01-10": ["chun"], "2099-01-11": ["coba", "x2"], "2099-01-12": ["x3"] };
const U1_NOTE = "U1-GIZLI-NOT kapi kodu 4711", U1_PLAN = "U1-GIZLI-PLAN", U1_ACC = { lat: 52.3741, lng: 4.8812, label: "U1-otel" };
const U1_PHOTO = "data:image/gif;base64,U1PHOTO", U2_PHOTO = "data:image/gif;base64,U2PHOTO";
function row(o = {}) {
  return Object.assign({
    id: 7, revision: 5, user_id: "u1", city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12",
    timezone: "Europe/Amsterdam", setup_completed: true, archived_at: null, plan_version: 0,
    preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli" } },
    plan: { dayven: J(P0), cal: {}, plan: {} },
  }, J(o));
}
const row7 = () => row({ preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli", accommodation: U1_ACC, otherNote: "U1-other" }, accommodation: U1_ACC }, plan: { dayven: J(P0), cal: { "2099-01-10": U1_NOTE }, plan: { "2099-01-10": U1_PLAN } } });
const row9 = (o = {}) => row(Object.assign({ id: 9, revision: 2, user_id: "u2", start_date: "2099-03-01", end_date: "2099-03-03", preferences: {}, plan: null, setup_completed: false }, o));
const ROW8 = () => row({ id: 8, revision: 1, start_date: "2099-02-10", end_date: "2099-02-12", plan: { dayven: { "2099-02-10": ["pllek"] }, cal: {}, plan: {} } });
function tripOn(r, opts = {}) { const h = boot(opts); if (!h.server.trip(r.id)) h.server.tables.trips.push(J(r)); h.useDb(); h.open(r); return h; }
function serverEdit(h, id, patch) { const r = h.server.trip(id); Object.assign(r, J(patch)); r.revision++; return J(r); }
async function reopen(h, id = 7) { const k = bootLike(h, { search: `?trip=${id}&city=Amsterdam` }); k.useDb(); await k.asa.ev("loadTripContext()"); await settle(); k.runTimers(); await settle(60); return k; }
const items = (h) => ((h.sync() || {}).items || []);
const OFF = (n) => (n === "trip_save" ? { data: { ok: false, reason: "net" }, error: null } : undefined);
const ev = (t, ks) => ks.forEach((k) => t.fireStorage("asa:ams:" + k));
const allEv = (t) => { ev(t, ["dayven", "cal", "plan", "plan_prefs", "trip", "plan_sync", "calphoto", "fav", "fav_sync"]); t.fireStorage("asa_session"); };

// a page of the shared device with the real membership closure. who: "u1" | "u2" (session present → init() logs in) | null (no session)
async function page(prev, who, search = "?city=Amsterdam", opts = {}) {
  const h = prev ? bootLike(prev, { search, ...opts }) : boot({ search, ...opts });
  h.useDb(); h.useRealAsa(); h.asa.set("db", h.db);
  h.server.uid = who || h.server.uid;
  h.server.session = who ? undefined : { data: { session: null }, error: null };
  await h.asa.ev("init()"); await settle(60);
  return h;
}
async function login(h, who, search) { if (search !== undefined) h.sb.location.search = search; h.server.uid = who; h.server.session = undefined; await h.asa.ev(`afterAuth({id:${JSON.stringify(who)},email:""})`); await settle(60); }
async function logout(h) { await h.asa.ev("logout()"); await settle(60); }
function twoAccounts() { const h = boot(); h.server.tables.trips.push(row7(), row9()); return h; }
function onScreen(h) {
  return h.val(`({cal:calNotes, plan:calPlans, dv:dayVenues, ph:Object.keys(calPhotos).filter(function(k){return k.charAt(0)!=="~";}).map(function(k){return calPhotos[k];}),
    trip:(window.__asaTripMem||ASA_ST.trip()||null), days:CAL.days.map(function(d){return d.key;}), base:(function(){ try{ return PSET.getPrefs().base; }catch(e){ return "n/a"; } })(),
    form:(function(){ try{ var g=PSET.getPrefs(); return [g.startDate,g.endDate,g.must_see_ids,g.reservations]; }catch(e){ return null; } })(),
    ref:(typeof userLoc!=="undefined"?userLoc:null), pending:(window.TRIP?TripSync.pending():[]), notice:document.getElementById("tripSyncNotice").textContent})`);
}
function shown(h) {
  return Object.assign(onScreen(h), h.val(`({lsPrefs:ASA_ST.get("plan_prefs",{}), lsCal:ASA_ST.get("cal",{}), lsPlan:ASA_ST.get("plan",{}), lsDv:ASA_ST.get("dayven",{}), lsTrip:ASA_ST.get("trip",{}),
    lsPh:(function(){ var v=ASA_ST.get("calphoto",{}), o={}; Object.keys(v).forEach(function(k){ if(k.charAt(0)!=="~")o[k]=v[k]; }); return o; })()})`));
}
const leaksU1 = (x) => /U1-|U1PHOTO|52\.3741|2099-01-1/.test(JSON.stringify(x));
const u1Data = (x) => /U1-|U1PHOTO|52\.3741/.test(JSON.stringify(x));   // u1's content (u2's own trip 11 has the same dates)
function quota(storage) {
  const real = storage.setItem.bind(storage); let cap = Infinity;
  const total = () => storage.keys().reduce((n, k) => n + k.length + storage.raw(k).length, 0);
  storage.setItem = (k, v) => { k = String(k); v = String(v); const cur = storage.raw(k); const next = total() - (cur == null ? 0 : k.length + cur.length) + k.length + v.length;
    if (next > cap) { storage.log.push(["set", k]); const e = new Error("quota (test)"); e.name = "QuotaExceededError"; e.code = 22; throw e; } return real(k, v); };
  return { free(n) { cap = total() + n; }, off() { cap = Infinity; } };
}
// the home page's real saveTrip (index.html) on the same storage: rewrites asa:ams:trip with the new search (no id)
function homeSaveTrip(h, sel) {
  const html = read("index.html");
  const i = html.indexOf("async function saveTrip(navigate){"), j = html.indexOf("\n}\n", i);
  h.run(`(function(){ var COUNTRIES=[{code:"nl",name:"Hollanda",cities:[{name:"Amsterdam",active:true}]}]; var sel=${JSON.stringify(sel)}; sel.types=new Set(sel.types||[]); var session=null;
    ${html.slice(i, j + 2)}
    saveTrip(false); })()`);
}
// the home page's real doLogout (index.html) on the same storage (the home page loads the same storage library; no city page code)
async function homeLogout(storage, uid = "u1") {
  const src = read("index.html"), i = src.indexOf("async function doLogout(){"), body = src.slice(i, src.indexOf("\n}\n", i) + 2);
  const c = vm.createContext({ localStorage: storage, console }); c.window = c;
  vm.runInContext(read("lib/asa-storage/asa_storage.js"), c);
  vm.runInContext(`var loggingOut=false, session={uid:${JSON.stringify(uid)},email:"",display_name:null}, db={auth:{signOut:async function(){}}};
    function $(){ return null; } var ASA_DLG={close:function(){}}; function renderAcct(){} function renderAuthBody(){} function renderTripHub(){} function wp5Reset(){}
    ${body}`, c);
  await vm.runInContext("doLogout()", c); await settle();
}
const UNDATED = { country: "Hollanda", city: "Amsterdam", duration: "4–6 gün", duration_days: null, start_date: null, end_date: null, approx_period: "Belli değil", vacation_types: ["Kültür"] };

// ================================================================================================ N  plan without exact dates
// The home page's "dates not known" search (index.html: approx_period "Belli değil" + a duration) gives calendar days g1..g5. There is
// no DB trip for it (importGuestTrip needs both dates), so the device holds its only copy.
test("N1 an undated plan survives logout / session expiry / guest-then-login: the same account gets it back on the plain page; nobody else sees it", T, async () => {
  for (const variant of ["logout", "expiry", "guest-login-logout", "other-account-between"]) {
    const d = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(UNDATED) }) });
    d.server.tables.trips.push(row7());
    let a;
    if (variant === "guest-login-logout") {
      a = await page(d, null);
      assert.deepEqual(a.val("CAL.days.map(d=>d.key)"), ["g1", "g2", "g3", "g4", "g5"], "precondition: undated calendar");
      a.run('calNotes.g1="UNDATED-NOTE-1"; saveLS("cal",calNotes); calPlans.g2="UNDATED-PLAN-2"; saveLS("plan",calPlans)');
      await login(a, "u1");                                           // nothing to import (no dates)
      assert.equal(a.server.tables.trips.filter((t) => t.user_id === "u1").length, 1, "no DB trip for an undated plan");
    } else {
      a = await page(d, "u1");
      a.run('calNotes.g1="UNDATED-NOTE-1"; saveLS("cal",calNotes); calPlans.g2="UNDATED-PLAN-2"; saveLS("plan",calPlans)');
    }
    assert.equal(a.sync().owner, "u1", variant + ": precondition: the device plan is u1's");
    let b;
    if (variant === "expiry") b = await page(a, null);                 // the next page load has no session
    else { await logout(a); b = await page(a, null); }
    const anon = shown(b);
    assert.ok(!/UNDATED-/.test(JSON.stringify(anon)), variant + ": the anonymous visitor sees u1's undated plan: " + JSON.stringify(anon));
    let c = b;
    if (variant === "other-account-between") {
      const u2 = await page(b, "u2");
      assert.ok(!/UNDATED-/.test(JSON.stringify(shown(u2))), "u2 sees u1's undated plan");
      await logout(u2); c = u2;
    }
    const back = await page(c, "u1");                                  // u1 logs in again (plain page)
    assert.equal(back.val("calNotes.g1"), "UNDATED-NOTE-1", variant + ": u1's undated note not back on the plain page: " + JSON.stringify(shown(back)));
    assert.equal(back.val("calPlans.g2"), "UNDATED-PLAN-2", variant);
    assert.equal(back.ls("trip").approx_period, "Belli değil", variant + ": the search comes back with it");
    assert.deepEqual(back.val("CAL.days.map(d=>d.key)"), ["g1", "g2", "g3", "g4", "g5"], variant);
    assert.ok(!items(back).some((x) => /UNDATED-/.test(JSON.stringify(x))), variant + ": no second copy left behind");
    assert.equal(back.val("TripSync.localState()"), "unsynced", variant + ": still the account's unsaved plan (kept again at the next logout)");
    // and it never becomes invisible notes on a dated trip (g1 is not one of trip 7's days). Round 5: it is offered there (the "now I know
    // my dates" path; it used to be filed as a version no UI reached) and a restore places "1. gün" on the trip's first day, "2. gün" on
    // the second — never on "g" keys; until the user chooses, trip 7's own plan is untouched.
    await logout(back);
    const t7 = await page(back, "u1", "?trip=7&city=Amsterdam");
    const pend = t7.val("TripSync.pending()");
    assert.equal(pend.length, 1, variant + ": the undated version is not offered on trip 7: " + JSON.stringify(pend));
    assert.ok(t7.notice().text.includes("1. gün seyahatinin ilk gününe"), variant + ": the notice does not say where the days go: " + t7.notice().text);
    assert.equal(t7.server.trip(7).plan.cal["2099-01-10"], U1_NOTE, variant + ": trip 7's own note untouched");
    t7.el("tripSyncRestore").click(); await settle(); t7.runTimers(); await settle(60);
    const p7 = t7.server.trip(7).plan;
    assert.equal(p7.cal["2099-01-10"], "UNDATED-NOTE-1", variant + ": " + JSON.stringify(p7)); assert.equal(p7.plan["2099-01-11"], "UNDATED-PLAN-2", variant);
    assert.ok(!Object.keys(p7.cal).concat(Object.keys(p7.plan), Object.keys(p7.dayven || {})).some((k) => /^g\d/.test(k)), variant + ": invisible 'g' keys written into trip 7: " + JSON.stringify(p7));
  }
});

// ================================================================================================ W  a tab whose session ended elsewhere
// Two "tabs" share one storage and one server. Tab B logs u1 out and logs u2 in; tab A still has u1 in memory. The browser then
// delivers "storage" events for the keys tab B changed (asa_session included) — or, in the *-noevent variants, does not (yet).
async function staleSetup({ trip = true, conflict = false } = {}) {
  const d = twoAccounts();
  const a = await page(d, "u1", trip ? "?trip=7&city=Amsterdam" : "?city=Amsterdam");
  if (conflict) {                                                     // a real conflict version for trip 7, notice on screen
    serverEdit(a, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
    a.run(`dayVenues=${JSON.stringify(P1)}; saveLS("dayven",dayVenues)`);
    await a.run("TripSync.flush()"); await settle(60);
    assert.equal(a.notice().reason, "conflict", "precondition: conflict version offered");
  }
  const b = await page(a, "u1");
  await logout(b);
  await login(b, "u2");
  b.run(`calPhotos["2099-03-01"]=[${JSON.stringify(U2_PHOTO)}]; saveLS("calphoto",calPhotos,true)`);
  assert.equal(b.sync().owner, "u2", "precondition: device is u2's");
  return { a, b };
}
async function u2Reload(h) { const r = await page(h, "u2"); return { r, photos: r.val("Object.entries(calPhotos)"), owner: r.sync().owner }; }
test("W1 (stale tab claims the device) 'Sunucudaki planla devam et' / an in-flight save / typing in u1's stale tab: owner stays u2, u2's photos stay u2's", T, async () => {
  for (const variant of ["discard", "discard-noevent", "inflight", "type-plain", "type-plain-noevent"]) {
    let a, b;
    if (variant === "inflight") {
      const d = twoAccounts();
      a = await page(d, "u1", "?trip=7&city=Amsterdam");
      a.run('calNotes["2099-01-11"]="A-inflight"; saveLS("cal",calNotes)');
      a.server.hold = true;
      const p = a.run("TripSync.flush()"); await settle(8);
      assert.equal(a.saves().length, 1, "precondition: save in flight (sent with u1's token)");
      b = await page(a, "u1"); await logout(b); a.server.hold = false;   // tab B: logout, u2 logs in, adds a photo
      a.server.hold = true; await login(b, "u2"); a.server.hold = false;
      b.run(`calPhotos["2099-03-01"]=[${JSON.stringify(U2_PHOTO)}]; saveLS("calphoto",calPhotos,true)`);
      a.server.release(); await p; await settle(60);
    } else {
      ({ a, b } = await staleSetup({ trip: !variant.startsWith("type-plain"), conflict: variant.startsWith("discard") }));
      if (!variant.endsWith("noevent")) allEv(a);
      if (variant.startsWith("discard")) { if (a.el("tripSyncDiscard")) a.el("tripSyncDiscard").click(); await settle(); }
      else a.run('calNotes["g1"]="A-stale-note"; saveLS("cal",calNotes)');
    }
    assert.equal(a.sync().owner, "u2", variant + ": the stale tab re-marked the device as u1's");
    assert.notEqual(String((a.sync().synced || {}).trip_id), "7", variant + ": trip 7's sync mark written onto u2's device");
    assert.equal(a.val("ASA.session"), null, variant + ": the stale tab still acts as u1");
    assert.ok(a.storeNotice().text.includes("başka bir sekmede oturum kapatıldı"), variant + ": user told: " + a.storeNotice().text);
    const { r, photos, owner } = await u2Reload(b);
    assert.equal(owner, "u2", variant);
    assert.deepEqual(photos, [["2099-03-01", [U2_PHOTO]]], variant + ": u2's photo moved away from u2: " + JSON.stringify(r.ls("calphoto")));
    assert.ok(!Object.keys(r.ls("calphoto")).some((k) => k.startsWith("~u:u1|2099-03")), variant + ": u2's photo filed under u1");
    await logout(r);
    const u1 = await page(r, "u1");
    assert.ok(!JSON.stringify(u1.val("calPhotos")).includes("U2PHOTO"), variant + ": u1 sees u2's photo");
  }
});
test("W2 (stale tab files u2's plan under u1) u2's unsynced plain-page note stays u2's; the stale tab's typing is refused", T, async () => {
  const { a, b } = await staleSetup({ trip: false });
  b.run('calNotes["g2"]="U2-PRIVATE-NOTE"; saveLS("cal",calNotes)');
  assert.equal(b.sync().edit.uid, "u2", "precondition");
  allEv(a);
  assert.ok(!JSON.stringify(onScreen(a)).includes("U2-PRIVATE"), "u2's note shown in u1's stale tab: " + JSON.stringify(onScreen(a)));
  assert.equal(a.run('calNotes["g3"]="A-stale"; saveLS("cal",calNotes)'), false, "the stale tab's write is refused");
  assert.equal(b.sync().edit.uid, "u2", "edit marker re-tagged as u1's");
  const { r } = await u2Reload(b);
  assert.equal(r.val("calNotes.g2"), "U2-PRIVATE-NOTE", "u2's note vanished from u2's screen");
  assert.ok(!items(r).some((x) => x.uid === "u1"), "u2's plan filed as u1's version: " + JSON.stringify(items(r)));
});
test("W3 (logout in one tab ends the session in the other) the stale tab drops the account view, favourites and plan; a heart tap there reaches no account", T, async () => {
  const d = twoAccounts();
  d.server.tables.favorites.push({ user_id: "u1", venue_id: "x1", city: "Amsterdam" }, { user_id: "u1", venue_id: "x2", city: "Amsterdam" });
  const t1 = await page(d, "u1", "?trip=7&city=Amsterdam");
  const t2 = await page(t1, "u1", "?trip=7&city=Amsterdam");
  assert.ok(t2.run('isFav("x1")') && leaksU1(onScreen(t2)), "precondition");
  await logout(t1);
  t2.fireStorage("asa_session");                                       // the browser's event for t1's removal of asa_session
  assert.equal(t2.val("ASA.session"), null, "the other tab still shows u1's account");
  assert.equal(t2.run("favSet.has('x1')||favSet.has('x2')"), false, "u1's favourites still in the other tab");
  assert.ok(!leaksU1(onScreen(t2)), "u1's plan still shown in the other tab: " + JSON.stringify(onScreen(t2)));
  t2.run('toggleFav("p1")'); await settle();
  assert.ok(!JSON.parse(t2.storage.raw("asa:ams:fav")).some((x) => x === "x1" || x === "x2"), "u1's favourites written back to the device: " + t2.storage.raw("asa:ams:fav"));
  const t3 = await page(t1, null);
  assert.equal(t3.run("favSet.has('x1')||favSet.has('x2')"), false, "a new anonymous tab sees u1's favourites");
  // u2 logs in in tab 1; the stale tab (no event delivered this time) taps a heart: nothing reaches u2's account, nothing re-marks the device
  await login(t1, "u2");
  const t4 = await page(t1, "u1", "?trip=7&city=Amsterdam");           // a fresh u1 tab ...
  t1.server.uid = "u2"; t4.server.uid = "u2";
  t4.storage.setItem("asa_session", JSON.stringify({ uid: "u2", email: "", display_name: null }));   // ... after which u2 logged in again elsewhere
  const before = J(t4.server.tables.favorites.filter((f) => f.user_id === "u2"));
  t4.run('toggleFav("csnoord")'); await settle();
  assert.deepEqual(J(t4.server.tables.favorites.filter((f) => f.user_id === "u2")), before, "the stale tab's heart landed in u2's account");
  assert.equal(t4.val("ASA.session"), null);
});

// ================================================================================================ P  calendar photos, two tabs
// the page's real addPhoto / delPhoto with FileReader / Image / canvas stubbed: the "file" carries the data URL the canvas returns
function photoStubs(h) {
  h.run(`window.FileReader=function(){ var r=this; r.readAsDataURL=function(f){ r.result=f.data; r.onload&&r.onload(); }; };
    window.Image=function(){ var i=this; i.width=10; i.height=10; Object.defineProperty(i,"src",{set:function(v){ i._s=v; i.onload&&i.onload(); },get:function(){ return i._s; }}); };
    (function(){ var ce=document.createElement; document.createElement=function(t){ var e=ce(t); if(String(t).toLowerCase()==="canvas"){ var last=null; e.getContext=function(){ return {drawImage:function(img){ last=img._s; }}; }; e.toDataURL=function(){ return last; }; } return e; }; })();`);
}
const addPh = (h, day, data) => h.run(`addPhoto(${JSON.stringify(day)},{target:{files:[{data:${JSON.stringify(data)}}]}})`);
const delPh = (h, day, i) => h.run(`delPhoto(${JSON.stringify(day)},${i})`);
test("P1 two tabs of the same account: a photo added / deleted in one tab is never lost by the other tab's write from its older copy", T, async () => {
  for (const withEvent of [false, true]) {
    const a = tripOn(row()), b = bootLike(a); b.useDb(); b.open(row()); photoStubs(a); photoStubs(b);
    addPh(a, "2099-01-11", "data:PA");
    if (withEvent) { ev(b, ["calphoto"]); assert.deepEqual(b.val('calPhotos["2099-01-11"]'), ["data:PA"], "the other tab's photo reaches this tab's memory"); }
    addPh(b, "2099-01-11", "data:PB");
    assert.deepEqual(a.ls("calphoto")["2099-01-11"], ["data:PA", "data:PB"], withEvent + ": tab A's photo lost: " + a.storage.raw("asa:ams:calphoto"));
    assert.deepEqual(b.val('calPhotos["2099-01-11"]'), ["data:PA", "data:PB"], "this tab shows both after its write");
    // delete from an older copy: tab B saw PA+PB, tab A adds PC, tab B deletes PA → PB and PC stay
    addPh(a, "2099-01-11", "data:PC");
    delPh(b, "2099-01-11", 0);
    assert.deepEqual(a.ls("calphoto")["2099-01-11"], ["data:PB", "data:PC"], withEvent + ": delete from an older copy dropped the other tab's photo: " + a.storage.raw("asa:ams:calphoto"));
    assert.equal(a.sb.__alerts.length + b.sb.__alerts.length, 0);
  }
});
test("P2 a tab on another trip (detached) cannot write photos; hidden photos of a logged-out account are never unhidden or dropped by a photo write", T, async () => {
  const a = tripOn(row()); photoStubs(a);
  addPh(a, "2099-01-10", "data:U1A");
  a.server.tables.trips.push(ROW8());
  const b = bootLike(a); b.useDb(); b.open(ROW8());                   // the device now holds trip 8
  const before = a.storage.raw("asa:ams:calphoto");
  addPh(a, "2099-01-11", "data:U1B");
  assert.equal(a.storage.raw("asa:ams:calphoto"), before, "the detached tab wrote photos into the device");
  assert.ok(a.storeNotice().text.includes("başka bir sekmede başka bir seyahat açıldı"), a.storeNotice().text);
  // hidden keys: a stashed account's photos survive a write from a tab that loaded them as visible before the stash
  const st = fakeStorage({ "asa:ams:calphoto": JSON.stringify({ "~u:u9|2099-01-10": ["data:HID"], "2099-01-11": ["data:V"] }) });
  const c = boot({ storage: st }); photoStubs(c);
  assert.deepEqual(c.val("Object.keys(calPhotos)"), ["2099-01-11"], "hidden photos are not in the page's memory");
  addPh(c, "2099-01-12", "data:NEW");
  assert.deepEqual(c.ls("calphoto"), { "~u:u9|2099-01-10": ["data:HID"], "2099-01-11": ["data:V"], "2099-01-12": ["data:NEW"] });
});
test("P4 no stored photo record (a failed write AND restore lost it; WP3 'the advised next save stores them'): the tab's copy is written in full", T, async () => {
  const h = boot({ storage: fakeStorage({ "asa:ams:calphoto": JSON.stringify({ "2099-01-11": ["data:A", "data:B", "data:C"] }) }) }); photoStubs(h);
  h.storage.removeItem("asa:ams:calphoto");                           // what WP3's failed safe move + failed restore leaves behind
  delPh(h, "2099-01-11", 0);
  assert.deepEqual(h.ls("calphoto"), { "2099-01-11": ["data:B", "data:C"] }, "the tab's only copy of the photos was not saved: " + h.storage.raw("asa:ams:calphoto"));
});
test("P3 (stale tab after an account switch) u1's out-of-date tab cannot delete u2's photo or unhide u1's hidden photos", T, async () => {
  for (const tripTab of [true, false]) {
    const d = twoAccounts();
    const a = await page(d, "u1", tripTab ? "?trip=7&city=Amsterdam" : "?city=Amsterdam"); photoStubs(a);
    addPh(a, tripTab ? "2099-01-10" : "g1", "data:U1PHOTO_1");
    const b = await page(a, "u1"); await logout(b);
    assert.ok(Object.keys(b.ls("calphoto")).every((k) => k.startsWith("~u:u1|")), "precondition: u1's photo hidden at logout");
    await login(b, "u2", "?trip=9&city=Amsterdam"); photoStubs(b);
    addPh(b, "2099-03-01", "data:U2PHOTO");
    allEv(a);
    addPh(a, tripTab ? "2099-01-11" : "g2", "data:U1PHOTO_2");
    const ph = b.ls("calphoto");
    assert.deepEqual(ph["2099-03-01"], ["data:U2PHOTO"], tripTab + ": u2's photo lost: " + JSON.stringify(ph));
    assert.ok(Object.keys(ph).filter((k) => !k.startsWith("~")).every((k) => k === "2099-03-01"), tripTab + ": u1's photos visible again on u2's device: " + JSON.stringify(ph));
    const r = await page(b, "u2", "?trip=9&city=Amsterdam");
    assert.ok(!/U1PHOTO/.test(JSON.stringify(r.val("calPhotos"))), tripTab + ": u2 sees u1's photos after a reload");
  }
});

// ================================================================================================ L  devices last used before WP6
// What the production page (origin/main) leaves on a device after u1 opened trip 7: the trip copy (id, revision, dates), plan fields,
// plan prefs (accommodation), a device-only photo, the favourites list (union of u1's cloud + the device) — and NO plan_sync /
// fav_sync marker (production never writes them). "unsynced": a note that never reached the server. asa_session: production's city
// page keeps it after a session expiry, removes it at logout.
const SEEDS = ["barpif", "shiraz", "chun", "pllek", "oeuf", "escobar", "coba"];
function legacyDevice({ session = null, unsynced = true, trip = true } = {}) {
  const seed = {
    "asa:ams:plan_prefs": JSON.stringify({ saved: true, tempo: "Dengeli", accommodation: U1_ACC, otherNote: "U1-other" }),
    "asa:ams:dayven": JSON.stringify(P0), "asa:ams:plan": JSON.stringify({ "2099-01-10": U1_PLAN }),
    "asa:ams:cal": JSON.stringify(Object.assign({ "2099-01-10": U1_NOTE }, unsynced ? { "2099-01-11": "U1-UNSYNCED-NOTE" } : {})),
    "asa:ams:calphoto": JSON.stringify({ "2099-01-10": [U1_PHOTO] }),
    "asa:ams:fav": JSON.stringify(SEEDS.concat(["x1", "x2"])),
  };
  if (trip) seed["asa:ams:trip"] = JSON.stringify({ id: 7, revision: 5, city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12" });
  if (session) seed.asa_session = JSON.stringify({ uid: session, email: "", display_name: null });
  const d = boot({ storage: fakeStorage(seed) });
  d.server.tables.trips.push(row7(), row9(), row9({ id: 11, start_date: "2099-01-10", end_date: "2099-01-12" }));
  d.server.tables.favorites.push({ user_id: "u1", venue_id: "x1", city: "Amsterdam" }, { user_id: "u1", venue_id: "x2", city: "Amsterdam" }, { user_id: "u2", venue_id: "c9", city: "Amsterdam" });
  assert.equal(d.sync(), null, "precondition: no plan_sync (pre-WP6 device)");
  return d;
}
const u1Back = async (prev) => {                                       // u1 comes back on trip 7: its unsynced note is offered, restore works
  const a = await page(prev, "u1", "?trip=7&city=Amsterdam");
  const offered = a.val("TripSync.pending()").some((x) => JSON.stringify(x.cal).includes("U1-UNSYNCED-NOTE"));
  if (offered) { a.el("tripSyncRestore").click(); await settle(); a.runTimers(); await settle(60); }
  return { a, offered, saved: JSON.stringify(a.server.trip(7).plan.cal).includes("U1-UNSYNCED-NOTE"), photo: a.val('calPhotos["2099-01-10"]||null') };
};
test("L1 pre-WP6 device, the first new city page already has u2's session: u2 sees nothing of u1; u1's unsaved note stays u1's (offered on trip 7)", T, async () => {
  for (const search of ["?city=Amsterdam", "?trip=11&city=Amsterdam"]) {
    const d = legacyDevice();
    const b = await page(d, "u2", search), leak = search.includes("trip=11") ? u1Data : leaksU1;
    assert.ok(!leak(shown(b)), search + ": u2 sees u1's plan / photo / accommodation: " + JSON.stringify(shown(b)));
    assert.equal(b.sync().owner, "u2");
    assert.ok(!(b.sync().dirty && b.sync().dirty.trip_id === "7"), search + ": u1's copy taken over as u2's unsaved trip-7 plan: " + JSON.stringify(b.sync()));
    const it = items(b).find((x) => JSON.stringify(x.cal).includes("U1-UNSYNCED-NOTE"));
    assert.ok(it && it.trip_id === "7" && it.uid == null, search + ": u1's unsaved note not kept for trip 7 (untagged): " + JSON.stringify(items(b)));
    const b11 = search.includes("trip=11") ? b : await page(b, "u2", "?trip=11&city=Amsterdam");   // u2's own trip, same dates
    assert.equal(b11.val("TRIP.id"), 11);
    assert.ok(!u1Data(shown(b11)) && !u1Data(b11.server.trip(11)), search + ": u1's data on u2's trip 11: " + JSON.stringify(shown(b11)));
    await logout(b11);
    const r = await u1Back(b11);
    assert.ok(r.offered && r.saved, search + ": u1 cannot get its unsaved note back: " + JSON.stringify(items(r.a)));
    assert.deepEqual(r.photo, [U1_PHOTO], search + ": u1's device-only photo not back on trip 7");
  }
});
test("L2 pre-WP6 device, anonymous first load: u1's photo is hidden too (not shown, not handed to the next account), back when u1 opens trip 7", T, async () => {
  const d = legacyDevice({ unsynced: false });
  const anon = await page(d, null);
  assert.ok(!leaksU1(shown(anon)), "anonymous visitor sees u1 data: " + JSON.stringify(shown(anon)));
  assert.deepEqual(anon.ls("calphoto"), { "~t:7|2099-01-10": [U1_PHOTO] }, "photo kept, hidden under trip 7");
  const b = await page(anon, "u2", "?trip=11&city=Amsterdam");
  assert.equal(b.val('calPhotos["2099-01-10"]||null'), null, "u2 sees u1's photo on its own trip with the same dates");
  await logout(b);
  assert.ok(!Object.keys(b.ls("calphoto")).some((k) => k.startsWith("~u:u2|") && JSON.stringify(b.ls("calphoto")[k]).includes("U1PHOTO")), "u1's photo hidden as u2's: " + JSON.stringify(b.ls("calphoto")));
  const r = await u1Back(b);
  assert.deepEqual(r.photo, [U1_PHOTO], "u1's photo not back");
  await logout(r.a);
  const b2 = await page(r.a, "u2", "?trip=11&city=Amsterdam");
  assert.ok(!/U1PHOTO/.test(JSON.stringify(b2.val("calPhotos"))), "u2 gets u1's photo later");
});
test("L3 (P1) pre-WP6 device, logout on the HOME page (the trip copy is emptied there): nothing of u1 is shown, offered or uploaded to the next person", T, async () => {
  const d = legacyDevice();
  await homeLogout(d.storage, "u1");
  assert.equal(d.storage.raw("asa:ams:trip"), "{}", "precondition: the home page emptied the trip copy");
  const anon = await page(d, null);
  assert.ok(!leaksU1(shown(anon)), "anonymous: " + JSON.stringify(shown(anon)));
  const b = await page(anon, "u2");
  assert.ok(!leaksU1(shown(b)), "u2: " + JSON.stringify(shown(b)));
  assert.equal(b.val("TripSync.importable()"), false, "u1's plan importable into u2's account");
  // (a) u2 searches with dates on the home page and reloads: the guest import creates u2's trip — without u1's plan
  homeSaveTrip(b, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-05-01", endDate: "2099-05-03", approx: null, types: [] });
  const b2 = await page(b, "u2"); b2.runTimers(); await settle(60);
  const made = b2.server.tables.trips.filter((t) => t.user_id === "u2" && t.start_date === "2099-05-01");
  assert.equal(made.length, 1, "precondition: u2's trip created");
  assert.ok(!leaksU1(made[0]), "u1's plan uploaded into u2's new trip: " + JSON.stringify(made[0]));
  // (b) u2 opens its own trip 9: nothing offered
  const b9 = await page(b2, "u2", "?trip=9&city=Amsterdam");
  assert.deepEqual(b9.val("TripSync.pending()"), []);
  assert.ok(!leaksU1(b9.server.trip(9)));
  await logout(b9);
  const r = await u1Back(b9);
  assert.ok(r.offered && r.saved, "u1's unsaved note lost: " + JSON.stringify(items(r.a)));
});
// (A pre-WP6 device whose account never opened a DB trip and whose session merely expired keeps no trace of that account but asa_session —
// the WP3 contract (WP3 e2e "legacy-only user" / "login: cloud favorites union") requires such a list to stay visible and be merged at the
// next login, so that case is not covered here.)
test("L4 pre-WP6 device's favourites (production logout / expiry / home logout): not shown to the next visitor, not uploaded into the next account", T, async () => {
  for (const variant of ["city-logout", "expiry", "home-logout"]) {
    const d = legacyDevice({ session: variant === "expiry" ? "u1" : null });
    if (variant === "home-logout") await homeLogout(d.storage, "u1");
    const anon = await page(d, null);
    assert.equal(anon.run("favSet.has('x1')||favSet.has('x2')"), false, variant + ": the anonymous visitor sees u1's favourites: " + JSON.stringify(anon.val("[...favSet]")));
    const b = await page(anon, "u2");
    assert.deepEqual(b.server.favIds("u2"), ["c9"], variant + ": u1's favourites uploaded into u2: " + JSON.stringify(b.server.favIds("u2")));
    assert.equal(b.run("favSet.has('x1')||favSet.has('x2')"), false, variant);
    // the u2-session-at-load path (u2 logged in on the home page, then opened the city page)
    const d2 = legacyDevice({ session: variant === "expiry" ? "u1" : null });
    if (variant === "home-logout") await homeLogout(d2.storage, "u1");
    const b2 = await page(d2, "u2");
    assert.deepEqual(b2.server.favIds("u2"), ["c9"], variant + " (u2 at load): " + JSON.stringify(b2.server.favIds("u2")));
  }
  // control: the device's own account (session still valid) keeps the one-time merge of its own device list
  const own = legacyDevice({ session: "u1" });
  own.storage.setItem("asa:ams:fav", JSON.stringify(SEEDS.concat(["x1", "x2", "p1"])));
  const a = await page(own, "u1");
  assert.ok(a.server.favIds("u1").includes("p1"), "the account's own pre-WP6 favourite not merged: " + JSON.stringify(a.server.favIds("u1")));
});
test("L6 pre-WP6 device, the next person starts on the HOME page (its search overwrites the trip copy): nothing of u1 shown, offered or uploaded", T, async () => {
  const SEL = { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-05-01", endDate: "2099-05-03", approx: null, types: ["Kültür"] };
  // (a) u2 logged in on the home page: the search creates u2's trip 10 there; u2 lands on ?trip=10
  const d = legacyDevice();
  homeSaveTrip(d, SEL);
  d.server.tables.trips.push(row9({ id: 10, revision: 1, start_date: "2099-05-01", end_date: "2099-05-03" }));
  const b = await page(d, "u2", "?trip=10&city=Amsterdam");
  assert.equal(b.val("TRIP.id"), 10);
  assert.ok(!u1Data(shown(b)), "u2 sees u1 data: " + JSON.stringify(shown(b)));
  assert.deepEqual(b.val("TripSync.pending()"), [], "u1's plan offered to u2 as an unlinked plan");
  assert.ok(!u1Data(b.server.trip(10)));
  // (b) an anonymous visitor's home search, the anonymous city page, then u2 logs in there (guest import)
  const e = legacyDevice();
  homeSaveTrip(e, SEL);
  const anon = await page(e, null);
  assert.ok(!u1Data(shown(anon)), "anonymous visitor sees u1's plan as a guest plan: " + JSON.stringify(shown(anon)));
  assert.equal(anon.ls("trip").start_date, "2099-05-01", "the visitor's own search is kept");
  await login(anon, "u2"); anon.runTimers(); await settle(60);
  for (const t of anon.server.tables.trips.filter((x) => x.user_id === "u2")) assert.ok(!u1Data(t), "u1's plan uploaded into u2's trip: " + JSON.stringify(t));
  // u1 later: its unsaved note and photo are back on trip 7
  await logout(anon);
  const r = await u1Back(anon);
  assert.ok(r.offered && r.saved, "u1's unsaved note lost: " + JSON.stringify(items(r.a)));
  assert.deepEqual(r.photo, [U1_PHOTO]);
  // (c) u2 logged in on the home page searches, then logs out there (never opening the city page): u1's copy is not filed as u2's
  const f = legacyDevice();
  homeSaveTrip(f, SEL);
  await homeLogout(f.storage, "u2");
  const anon2 = await page(f, null);
  assert.ok(!u1Data(shown(anon2)), "(c) anonymous: " + JSON.stringify(shown(anon2)));
  const r2 = await u1Back(anon2);
  assert.ok(r2.offered && r2.saved, "(c) u1's unsaved note filed under u2: " + JSON.stringify(items(r2.a)));
});
test("L5 (coverage) pre-WP6 device through init → afterAuth: the account's own hand-made plan stays 'unsynced' — kept on its trip, imported as a guest plan", T, async () => {
  // (a) trip 7 copy with a hand-made plan; another device changed trip 7; u1's session present at load, ?trip=7
  const st = fakeStorage({ "asa:ams:trip": JSON.stringify({ id: 7, revision: 5, city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12" }),
    "asa:ams:dayven": JSON.stringify(P1), "asa:ams:cal": JSON.stringify({ "2099-01-10": "el yapimi not" }) });
  const h = boot({ storage: st }); h.server.tables.trips.push(row({ revision: 6, plan: { dayven: P2, cal: {}, plan: {} } }));
  const a = await page(h, "u1", "?trip=7&city=Amsterdam");
  assert.equal(a.val("TRIP.id"), 7);
  assert.ok(items(a).some((x) => x.trip_id === "7" && JSON.stringify(x.dayven) === JSON.stringify(P1) && x.cal["2099-01-10"] === "el yapimi not"), "the device's hand-made plan overwritten silently: " + JSON.stringify(items(a)));
  assert.equal(a.notice().hidden, false, "offered");
  // (b) / (c) legacy dated guest plan: session already present (plain page) / no session at load, then the login on this page
  for (const atLoad of [true, false]) {
    const GT = { city: "Amsterdam", country: "Hollanda", start_date: "2099-03-03", end_date: "2099-03-05" };
    const g = boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(GT), "asa:ams:dayven": JSON.stringify({ "2099-03-03": ["oeuf", "x1"] }), "asa:ams:cal": JSON.stringify({ "2099-03-04": "misafir notu" }) }) });
    const p = await page(g, atLoad ? "u1" : null);
    if (!atLoad) await login(p, "u1");
    p.runTimers(); await settle(60);
    const t = p.server.tables.trips.find((x) => x.user_id === "u1" && x.start_date === "2099-03-03");
    assert.ok(t && t.plan && t.plan.cal["2099-03-04"] === "misafir notu" && JSON.stringify(t.plan.dayven["2099-03-03"]) === '["oeuf","x1"]', (atLoad ? "(b)" : "(c)") + " guest plan not imported: " + JSON.stringify(t));
  }
});

// ================================================================================================ O  new home search over the previous trip's copy
const DOWN = (c) => ({ data: null, error: { message: "TypeError: Failed to fetch" } });
test("O1 offline new search on the home page, a note on the new trip's day: it goes to the new trip once online — never filed under the old trip", T, async () => {
  for (const variant of ["synced", "unsynced-before", "race"]) {
    const d = twoAccounts();
    const a = await page(d, "u1", "?trip=7&city=Amsterdam");
    if (variant === "unsynced-before") { a.server.hooks.rpc = OFF; a.run('calNotes["2099-01-11"]="JAN-UNSYNCED"; saveLS("cal",calNotes)'); await a.run("TripSync.flush()"); await settle(); a.server.hooks.rpc = undefined; }
    homeSaveTrip(a, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-03-10", endDate: "2099-03-12", approx: null, types: [] });
    let p;
    if (variant !== "race") {
      a.server.hooks.rest = DOWN; a.server.hooks.rpc = () => ({ data: null, error: { message: "TypeError: Failed to fetch" } });
      p = await page(a, "u1");                                        // Supabase down: importGuestTrip stops (no TRIP)
      assert.ok(!p.val("window.TRIP"), variant + ": precondition: plain page");
      assert.deepEqual(p.val("CAL.days.map(d=>d.key)"), ["2099-03-10", "2099-03-11", "2099-03-12"]);
      p.run('calNotes["2099-03-10"]="MARCH-NOTE"; saveLS("cal",calNotes)');
      assert.equal(p.sync().dirty.trip_id, null, variant + ": the March note was filed under trip 7: " + JSON.stringify(p.sync()));
      assert.equal(p.val('calNotes["2099-03-10"]'), "MARCH-NOTE", variant + ": the note left the screen");
      a.server.hooks.rest = undefined; a.server.hooks.rpc = undefined;
      p = await page(p, "u1");                                        // back online: the guest import creates trip 101
    }
    if (variant === "race") {
      // online, only the home page's create failed (saveTrip(false)); the note is typed while importGuestTrip's insert is in flight
      const q = bootLike(a, { search: "?city=Amsterdam" }); q.useDb(); q.useRealAsa(); q.asa.set("db", q.db); q.server.uid = "u1"; q.server.session = undefined;
      let rel; const gate = new Promise((r) => { rel = r; });
      q.server.hooks.rest = (c, S) => (c.table === "trips" && c.op === "insert" ? gate.then(() => { S.hooks.rest = undefined; const r = Object.assign(J(c.value), { id: ++S.seq, revision: 1, archived_at: null, setup_completed: false, plan: null, plan_version: 0 }); S.tables.trips.push(r); return { data: J(r), error: null }; }) : undefined);
      const i0 = q.server.rest("trips", "insert").length, run = q.asa.ev("init()");
      for (let i = 0; i < 80 && q.server.rest("trips", "insert").length === i0; i++) await settle(2);
      assert.ok(q.server.rest("trips", "insert").length > i0, "precondition: the import's insert is in flight");
      q.run('calNotes["2099-03-10"]="MARCH-NOTE"; saveLS("cal",calNotes)');
      rel(); await run; await settle(80); q.runTimers(); await settle(80);
      p = q;
    }
    p.runTimers(); await settle(60);
    const t = p.server.tables.trips.find((x) => x.user_id === "u1" && x.start_date === "2099-03-10");
    assert.ok(t, variant + ": the new trip was not created");
    assert.equal(((t.plan || {}).cal || {})["2099-03-10"], "MARCH-NOTE", variant + ": the March note did not reach the new trip: " + JSON.stringify(t.plan) + " items=" + JSON.stringify(items(p)));
    assert.ok(!leaksU1(t.plan) && !JSON.stringify(t.plan || {}).includes("JAN-"), variant + ": trip 7's plan carried into the new trip: " + JSON.stringify(t.plan));
    assert.ok(!items(p).some((x) => JSON.stringify(x).includes("MARCH-NOTE")), variant + ": the March note also filed as a version: " + JSON.stringify(items(p)));
    if (variant === "unsynced-before") {
      const k = items(p).find((x) => x.trip_id === "7");
      assert.ok(k && k.cal["2099-01-11"] === "JAN-UNSYNCED" && k.start_date === "2099-01-10" && k.end_date === "2099-01-12", "trip 7's unsynced note kept with trip 7's dates: " + JSON.stringify(items(p)));
      const r = await page(p, "u1", "?trip=7&city=Amsterdam");
      r.el("tripSyncRestore").click(); await settle(); r.runTimers(); await settle(60);
      assert.equal(r.server.trip(7).plan.cal["2099-01-11"], "JAN-UNSYNCED"); assert.equal(r.server.trip(7).start_date, "2099-01-10");
      assert.ok(!JSON.stringify(r.server.trip(7).plan).includes("MARCH"), "the March note ended up on trip 7");
    }
  }
});

// ================================================================================================ G  the login window
test("G1 the next account's login (members reads held): the previous account's plan is gone before the first request; a note typed meanwhile is the new account's", T, async () => {
  for (const variant of ["home-logout", "expiry"]) {
    const d = twoAccounts();
    const a = await page(d, "u1", "?trip=7&city=Amsterdam");
    a.server.hooks.rpc = OFF; a.run('calNotes["2099-01-11"]="U1-offline-not"; saveLS("cal",calNotes)'); await a.run("TripSync.flush()"); await settle(); a.server.hooks.rpc = undefined;
    if (variant === "home-logout") await homeLogout(a.storage, "u1");
    const b = bootLike(a, { search: "?city=Amsterdam" }); b.useDb(); b.useRealAsa(); b.asa.set("db", b.db); b.server.uid = "u2"; b.server.session = undefined;
    let rel; const gate = new Promise((r) => { rel = r; });
    b.server.hooks.rest = (c) => (c.table === "members" ? gate.then(() => ({ data: null, error: null })) : undefined);
    const m0 = b.server.rest("members").length, run = b.asa.ev("init()");
    for (let i = 0; i < 80 && b.server.rest("members").length === m0; i++) await settle(2);
    assert.ok(b.server.rest("members").length > m0, "precondition: the login's first request is held");
    assert.equal(b.val("ASA.session"), null, "precondition: inside the login window");
    assert.ok(!leaksU1(onScreen(b)), variant + ": u1's plan shown during u2's login: " + JSON.stringify(onScreen(b)));
    assert.equal(b.run('calNotes["g1"]="U2-NOTE written during login"; saveLS("cal",calNotes)'), true, variant + ": the note is accepted (ownership already decided)");
    rel(); b.server.hooks.rest = undefined; await run; await settle(80);
    assert.equal(b.val("ASA.session.uid"), "u2");
    assert.equal(b.val("calNotes.g1"), "U2-NOTE written during login", variant + ": u2's note lost for u2: " + JSON.stringify(b.val("calNotes")));
    assert.equal(b.sync().edit.uid, "u2", variant);
    assert.ok(!items(b).some((x) => JSON.stringify(x).includes("U2-NOTE")), variant + ": u2's note filed as a version: " + JSON.stringify(items(b)));
    const u1v = items(b).find((x) => JSON.stringify(x.cal).includes("U1-offline-not"));
    assert.ok(u1v && u1v.uid === "u1" && u1v.trip_id === "7", variant + ": u1's own unsaved note kept for u1: " + JSON.stringify(items(b)));
    await logout(b);
    const a2 = await page(b, "u1", "?trip=7&city=Amsterdam");
    for (const x of a2.val("TripSync.pending()")) assert.ok(!JSON.stringify(x).includes("U2-NOTE"), "u2's note offered to u1: " + JSON.stringify(x));
    if (a2.el("tripSyncRestore")) { a2.el("tripSyncRestore").click(); await settle(); a2.runTimers(); await settle(60); }
    assert.ok(!JSON.stringify(a2.server.trip(7)).includes("U2-NOTE"), variant + ": u2's note written into u1's trip 7");
  }
});
test("G2 while the session is still being read, plan / photo / prefs writes on a device holding an account's copy are refused (never filed under the wrong account)", T, async () => {
  const d = twoAccounts();
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  const b = bootLike(a, { search: "?city=Amsterdam" }); b.useDb(); b.useRealAsa(); b.asa.set("db", b.db);
  let rel; b.server.session = new Promise((r) => { rel = r; });          // getSession pending (e.g. a token refresh)
  const run = b.asa.ev("init()"); await settle(4);
  assert.equal(b.run('calNotes["2099-01-11"]="WHO-AM-I"; saveLS("cal",calNotes)'), false, "a note written before the session was read");
  assert.equal(b.run(`saveLS("calphoto",{"2099-01-11":["data:X"]},true)`), false, "a photo written before the session was read");
  b.run("PSET._reload(); PSET.setDate('endDate','2099-01-13')");
  assert.ok(b.storeNotice().text.includes("Oturum bilgilerin okunuyor"), b.storeNotice().text);
  assert.equal(b.ls("trip").end_date, "2099-01-12");
  assert.ok(!JSON.stringify(b.storage.dump()).includes("WHO-AM-I"));
  b.server.uid = "u2"; rel({ data: { session: { user: { id: "u2" } } }, error: null }); await run; await settle(80);
  assert.equal(b.run('calNotes["g1"]="u2 notu"; saveLS("cal",calNotes)'), true, "writes work again once the session is read");
  assert.equal(b.sync().edit.uid, "u2");
  // the anonymous variant: no session → the account's plan is removed, then writes work (guest)
  const c = bootLike(b, { search: "?city=Amsterdam" }); c.useDb(); c.useRealAsa(); c.asa.set("db", c.db);
  c.server.session = { data: { session: null }, error: null };
  await c.asa.ev("init()"); await settle(40);
  assert.equal(c.run('calNotes["g2"]="misafir"; saveLS("cal",calNotes)'), true);
});

// ================================================================================================ C  coverage (each kills a mutant of a round-3 guard)
const fullMsg = (h) => h.sb.__alerts.some((m) => /depolaması dolu/.test(m));
test("C1 (PV-A20) storage-full lock on trip 8's tab: the Plan form's date change / submit cannot move trip 7's unsynced note onto trip 8", T, async () => {
  const t1 = tripOn(row());
  t1.server.hooks.rpc = OFF; t1.edit("cal", { "2099-01-10": "T7-OFFLINE-NOTE" }); await t1.run("TripSync.flush()"); await settle(); t1.server.hooks.rpc = undefined;
  assert.deepEqual(t1.sync().dirty, { trip_id: "7" });
  t1.server.tables.trips.push(ROW8());
  const q = quota(t1.storage); q.free(40);                             // trip 7's kept copy does not fit; a same-size marker rewrite does
  const t2 = bootLike(t1, { search: "?trip=8&city=Amsterdam" }); t2.useDb(); t2.open(ROW8());
  assert.equal(t2.val("TripSync.locked()"), true, "precondition: memAdopt lock");
  t2.run('PSET._reload(); PSET.setDate("endDate","2099-02-13"); PSET.submit()');
  assert.equal(t2.ls("trip").id, 7, "trip 8's tab replaced the device trip (trip 7, holding its unsynced note): " + t2.storage.raw("asa:ams:trip"));
  assert.deepEqual(t2.sync().dirty, { trip_id: "7" }, "the unsynced note re-owned by trip 8");
  q.off();
  const k7 = await reopen(t2, 7);
  assert.equal(k7.server.trip(7).plan.cal["2099-01-10"], "T7-OFFLINE-NOTE", "trip 7's note not saved to trip 7");
  const k8 = await reopen(k7, 8);
  assert.ok(!JSON.stringify(k8.val("TripSync.pending()")).includes("T7-OFFLINE"), "trip 7's note offered on trip 8");
  assert.ok(!JSON.stringify(k8.server.trip(8)).includes("T7-OFFLINE"));
});
test("C2 (PV-D5s) savePrefs writes its 'unsynced' marker first: when only the marker cannot be written, the change is refused and the user told", T, async () => {
  for (const follow of ["offline", "debounce", "other-trip"]) {
    const h = tripOn(row());
    h.run("PSET._reload()");
    h.storage.failOn("asa:ams:plan_sync");                             // plan_prefs and trip would still fit
    if (follow === "offline") h.server.hooks.rpc = OFF;
    h.run('PSET.edit(); PSET.tempo("Sakin"); PSET.submit()');
    assert.ok(fullMsg(h), follow + ": user not told: " + JSON.stringify(h.sb.__alerts));
    assert.equal((h.ls("plan_prefs") || {}).tempo, "Dengeli", follow + ": the preference written without its marker");
    assert.equal(h.sync().dirty, null);
    h.storage.allow("asa:ams:plan_sync"); h.server.hooks.rpc = undefined;
    let k = h;
    if (follow === "other-trip") { h.server.tables.trips.push(ROW8()); k = await reopen(h, 8); }
    k = await reopen(k, 7);
    assert.equal((k.ls("plan_prefs") || {}).tempo, (k.server.trip(7).preferences.plan_prefs || {}).tempo, follow + ": device and server disagree");
  }
});
test("C3 (PV-D4ab / PV-D4aa) a kept copy carries its own trip's dates as the user last set them — after a date change, and for a plain-page edit after a new home search", T, async () => {
  // D4ab: one edit, then the end date moves (offline), then the home page writes a new search, trip 8 opens
  const h = tripOn(row());
  h.server.hooks.rpc = OFF;
  h.edit("cal", { "2099-01-10": "Ocak notu" });
  h.run('PSET._reload(); PSET.setDate("endDate","2099-01-13")');
  h.runTimers(); await settle(); h.server.hooks.rpc = undefined;
  homeSaveTrip(h, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-03-20", endDate: "2099-03-22", approx: null, types: [] });
  h.server.tables.trips.push(ROW8());
  const k8 = await reopen(h, 8);
  const it = items(k8).find((x) => x.trip_id === "7");
  assert.ok(it, "copy kept for trip 7");
  assert.equal(it.start_date, "2099-01-10"); assert.equal(it.end_date, "2099-01-13", "the kept copy lost the user's date change");
  const k7 = await reopen(k8, 7);
  k7.el("tripSyncRestore").click(); await settle(); k7.runTimers(); await settle(60);
  assert.equal(k7.server.trip(7).end_date, "2099-01-13");
  // D4aa: an unsynced edit on trip 7, the home page writes a new search, then a note on the plain page (the new search's)
  const a = tripOn(row());
  a.server.hooks.rpc = OFF; a.edit("cal", { "2099-01-11": "JAN-UNSYNCED" }); await a.run("TripSync.flush()"); await settle(); a.server.hooks.rpc = undefined;
  homeSaveTrip(a, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-03-20", endDate: "2099-03-22", approx: null, types: [] });
  const p = bootLike(a, { search: "?city=Amsterdam" }); p.useDb();
  p.run('calNotes["2099-03-20"]="MART-NOTU"; saveLS("cal",calNotes)');
  const c7 = items(p).find((x) => x.trip_id === "7");
  assert.ok(c7 && c7.cal["2099-01-11"] === "JAN-UNSYNCED", "trip 7's unsynced note kept: " + JSON.stringify(items(p)));
  assert.equal(c7.start_date, "2099-01-10", "the copy for trip 7 took the home search's dates"); assert.equal(c7.end_date, "2099-01-12");
  assert.ok(!JSON.stringify(c7).includes("MART-NOTU"), "the new search's note filed under trip 7");
});
test("C4 (PV-X12) session expiry after plan prefs on a trip without a DB id: the next page carries none of the account's accommodation, dates or note", T, async () => {
  const d = boot();
  const a = await page(d, "u1");
  a.run('ASA_ST.set("trip",{country:"Hollanda",city:"Amsterdam",approx_period:"Temmuz",vacation_types:["Kültür"]}); PSET._reload()');
  a.run('PSET.setDate("startDate","2099-07-01"); PSET.setDate("endDate","2099-07-03"); PSET.setAcc(52.3699,4.8711,"PRV-otel"); PSET.setNote("PRV-not kapi 1234"); PSET.submit()');
  assert.ok(/PRV-/.test(JSON.stringify(a.ls("trip"))), "precondition: the id-less trip holds the account's prefs");
  a.server.hooks.rest = (c) => (c.table === "trips" && c.op === "insert" ? { data: null, error: { message: "offline (test)" } } : undefined);
  const anon = await page(a, null);                                    // session expired: the next page has no session
  a.server.hooks.rest = undefined;
  const s = shown(anon);
  assert.ok(!/PRV-|52\.3699|2099-07/.test(JSON.stringify(s)), "the account's trip / prefs / accommodation left to the next visitor: " + JSON.stringify(s));
  const b = await page(anon, "u2");
  assert.ok(!b.server.tables.trips.some((t) => t.user_id === "u2" && /2099-07/.test(JSON.stringify(t))), "u1's dates imported into u2's account");
});
test("C5 (PV-X47) storage-full logout (the plan cannot be released): u1's device-only photos are not shown in the logged-out tab or to u2", T, async () => {
  const d = twoAccounts();
  d.server.tables.trips.find((t) => t.id === 9).start_date = "2099-01-10"; d.server.tables.trips.find((t) => t.id === 9).end_date = "2099-01-12";
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  a.run(`calPhotos["2099-01-10"]=[${JSON.stringify(U1_PHOTO)}]; saveLS("calphoto",calPhotos,true)`);
  a.server.hooks.rpc = OFF; a.run('calNotes["2099-01-11"]="U1-offline-not"; saveLS("cal",calNotes)');
  a.storage.failOn("asa:ams:plan_sync");
  await logout(a);
  assert.equal(a.run("TripSync.foreign"), "u1", "precondition");
  assert.equal(a.val('calPhotos["2099-01-10"]||null'), null, "u1's photo still shown in the logged-out tab");
  const b = await page(a, "u2", "?trip=9&city=Amsterdam");
  assert.equal(b.val('calPhotos["2099-01-10"]||null'), null, "u1's photo shown on u2's trip (same days)");
  assert.ok(JSON.stringify(b.ls("calphoto")).includes("U1PHOTO"), "the photo itself is kept on the device");
});
test("C6 (PV-D4ae) pre-WP6 device: a refused plan write never turns the hand-made plan into 'auto' (the next open would overwrite it)", T, async () => {
  for (const what of ["cal", "trip"]) {
    const st = fakeStorage({ "asa:ams:trip": JSON.stringify({ id: 7, revision: 5, city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12" }), "asa:ams:dayven": JSON.stringify(P1) });
    const h = boot({ storage: st }); h.useDb();
    h.server.tables.trips.push(row({ revision: 9, plan: { dayven: P2, cal: {}, plan: {} } }));
    h.storage.failOn("asa:ams:" + what);
    if (what === "cal") assert.equal(h.run('calNotes["2099-01-10"]="not"; saveLS("cal",calNotes)'), false);
    else h.run('PSET._reload(); PSET.setDate("endDate","2099-01-13")');
    h.storage.allow("asa:ams:" + what);
    assert.equal(h.val("TripSync.localState()"), "unsynced", what + ": the hand-made plan now counts as auto: " + h.storage.raw("asa:ams:plan_sync"));
    const k = await reopen(h, 7);
    assert.ok(items(k).some((x) => x.trip_id === "7" && JSON.stringify(x.dayven) === JSON.stringify(P1)), what + ": the hand-made plan overwritten without a copy");
    assert.equal(k.notice().hidden, false);
  }
});
test("C7 (PV-A24) a partly failed restore blocks the trip: a later edit never uploads the half-restored plan that is not on screen", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  assert.deepEqual(h.val("dayVenues"), P2, "precondition: the server plan on screen");
  h.storage.failOn("asa:ams:cal");
  h.el("tripSyncRestore").click(); await settle();
  assert.deepEqual(h.ls("dayven"), P1, "precondition: dayven restored, cal failed");
  const n0 = h.saves().length;
  h.storage.allow("asa:ams:cal");
  h.run('calNotes["2099-01-11"]="sonra"; saveLS("cal",calNotes)');
  h.runTimers(); await settle(); await h.run("TripSync.flush()"); await settle(60);
  assert.equal(h.saves().length, n0, "the half-restored plan was uploaded: " + JSON.stringify(h.server.trip(7).plan.dayven));
  assert.deepEqual(h.server.trip(7).plan.dayven, P2);
  assert.ok(h.storeNotice().text.includes("Cihaz depolaması dolu") || h.sb.__alerts.some((m) => m.includes("kaydedilmeyecek")), "user told");
});

// ================================================================================================ X  wording / UX
test("X1 a version held only in this tab's memory (storage full) is never described as saved / re-offered after a reload", T, async () => {
  // (a) two-tab clash copy that could not be filed; (b) "Geri al" after discarding while storage is full
  const PROMISE = /yeniden sorulur|saklandı|Hiçbiri kendiliğinden silinmez|saklanan sürüm/;
  const a = tripOn(row());
  a.dom.add("dayModal", "div", "daymodal"); a.dom.add("daySyncNote", "div", "asa-sn hide", { role: "status" });
  a.storage.failOn("asa:ams:plan_sync");
  a.run('TripSync.keepTab({start_date:"2099-01-10",end_date:"2099-01-12",dayven:' + JSON.stringify(Object.assign({}, P0, { "2099-01-11": ["coba", "p1"] })) + ',cal:{},plan:{},plan_prefs:' + JSON.stringify(row().preferences.plan_prefs) + '})');
  assert.equal(a.val("TripSync.pending()[0].mem"), true, "precondition: memory-only copy");
  const t = a.notice().text, m = a.el("daySyncNote").textContent;
  assert.ok(!PROMISE.test(t), "the notice promises it is kept: " + t);
  assert.ok(t.includes("Sayfayı yenilersen ya da sekmeyi kapatırsan bu sürüm kaybolur"), t);
  assert.equal(a.el("tripSyncLater"), null, "'Sonra karar ver' offered for a version that a reload loses");
  assert.ok(!/saklandı/.test(m) && /yalnız bu sekmede tutuluyor/.test(m), "day modal: " + m);
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1); await h.run("TripSync.flush()"); await settle();
  h.el("tripSyncDiscard").click(); await settle();
  h.storage.failOn("asa:ams:plan_sync");
  h.el("tripSyncUndo").click(); await settle();
  assert.equal(h.val("TripSync.pending()[0].mem"), true, "precondition: undo re-kept in memory only");
  assert.ok(!PROMISE.test(h.notice().text), h.notice().text);
  assert.equal(h.el("tripSyncLater"), null);
  // a version held on the device (memAdopt: the local plan IS the version) keeps "Sonra karar ver" and says what really happened
  const g = tripOn(row());
  g.dom.add("dayModal", "div", "daymodal"); g.dom.add("daySyncNote", "div", "asa-sn hide", { role: "status" });
  serverEdit(g, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  g.edit("dayven", P1); g.storage.failOn("asa:ams:plan_sync");
  await g.run("TripSync.flush()"); await settle();
  assert.equal(g.val("TripSync.locked()"), true, "precondition: memAdopt");
  assert.ok(g.el("tripSyncLater"), "held on the device: deciding later is safe");
  assert.ok(!/saklandı/.test(g.el("daySyncNote").textContent), "day modal says the copy was saved: " + g.el("daySyncNote").textContent);
});
// the page's real renderDay / dayFieldSaved / openDay with the day modal's text fields as event targets
function dayModal(h) {
  const html = h.html, i = html.indexOf("/* WP6 · gün penceresindeki not alanları"), j = html.indexOf("function renderDay(d){");
  h.run(html.slice(i, j) + fnSrc(html, "function renderDay(d){") + "\n" + fnSrc(html, "function openDay(d){") + "\n" + fnSrc(html, "function closeDay(){") + "\n" + fnSrc(html, "function dayInfo(k){") +
    "\nwindow.scrollTo=function(){}; function renderDayFilter(){} function wireDayDrag(){} function byId(id){ return V.find(function(v){ return v.id===id; }); } function isFav(){ return false; } function escT(s){ return String(s||''); }");
  for (const [id, tag] of [["dayModal", "div"], ["dayBody", "div"], ["dayPlan", "textarea"], ["dayNote", "textarea"], ["daySaveNote", "p"], ["dayPhotoInput", "input"]]) {
    const e = h.dom.add(id, tag, id === "dayModal" ? "daymodal hide" : (id === "daySaveNote" ? "hide" : ""));
    e.listeners = {}; e.addEventListener = (t, f) => { e.listeners[t] = f; };
  }
  // renderDay writes the fields' HTML into #dayBody; the mini DOM does not parse it — these elements stand in for the parsed fields
  // (renderDay looks them up by id and wires their "input" handlers, as in the browser)
  return { type(id, ch) { const e = h.el(id); e.value += ch; e.listeners.input && e.listeners.input({ target: e }); }, el: (id) => h.el(id) };
}
test("X2 storage nearly full while typing in the day modal: no alert per keystroke; the field shows what is really saved; one inline note", T, async () => {
  for (const field of ["dayNote", "dayPlan"]) {
    const h = tripOn(row());
    const m = dayModal(h);
    h.run('openDay("2099-01-10")');
    const q = quota(h.storage); q.free(30);                            // the note would fit; its "unsynced" marker does not
    for (const ch of "abc") m.type(field, ch);
    assert.equal(h.sb.__alerts.length, 0, field + ": blocking alerts: " + JSON.stringify(h.sb.__alerts));
    assert.equal(m.el(field).value, "", field + ": the field still shows text that was not saved");
    assert.equal(h.val(field === "dayNote" ? 'calNotes["2099-01-10"]||null' : 'calPlans["2099-01-10"]||null'), null);
    assert.ok(!m.el("daySaveNote").classList.contains("hide") && m.el("daySaveNote").textContent.includes("cihaz depolaması dolu"), field + ": no inline note: " + m.el("daySaveNote").textContent);
    q.off();
    m.type(field, "x");
    assert.equal(h.val(field === "dayNote" ? 'calNotes["2099-01-10"]' : 'calPlans["2099-01-10"]'), "x", field + ": typing works again once there is space");
  }
});
