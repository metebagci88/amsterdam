// WP6 · sync integrity, fixer round 5 (independent verification of round 4). Same harness as the other WP6 tests: the city page's
// REAL code in a vm sandbox (./_page.mjs), the real membership closure (init / afterAuth / logout), the home page's real doLogout /
// saveTrip, fake Storage shared between "tabs" / reloads / accounts (with a size quota where it matters), fake Supabase with per-user
// RLS on trips and favourites.
//   Q  pre-WP6 device + storage nearly full: an unknown-owner copy is shown / uploaded / re-tagged only after the server confirmed it
//   R  the owner check's server read fails: nothing hidden for good, nothing released, nothing taken over
//   F  favourites of a pre-WP6 device are set aside (not deleted) and come back to the confirmed owner; stale tab / login window
//   U  plan without exact dates: reachable after a dated trip, after a home logout, after a changed search; restore is all-or-nothing
//   H  home page guards (saveTrip / doLogout)
//   D  day modal: refused typing (session read, stale tab, other trip, lock) is reverted and explained in the modal
//   K  coverage: single guards that no test pinned (each kills a named mutant)
//   node --test WP6_package/tests/
// Test data only: user ids "u1"/"u2", trip ids 7/9/11/12, year 2099, marker strings; no e-mail addresses, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { boot, bootLike, fakeStorage, fnSrc, read, settle, J } from "./_page.mjs";

const T = { timeout: 60000 };
const P0 = { "2099-01-10": ["barpif", "chun"], "2099-01-11": ["coba"] };
const U1_NOTE = "U1-GIZLI-NOT kapi kodu 4711", U1_PLAN = "U1-GIZLI-PLAN", U1_ACC = { lat: 52.3741, lng: 4.8812, label: "U1-otel" };
const U1_PHOTO = "data:image/gif;base64,U1PHOTO", U2_PHOTO = "data:image/gif;base64,U2PHOTO";
const SEEDS = ["barpif", "shiraz", "chun", "pllek", "oeuf", "escobar", "coba"];
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
function tripOn(r, opts = {}) { const h = boot(opts); if (!h.server.trip(r.id)) h.server.tables.trips.push(J(r)); h.useDb(); h.open(r); return h; }
const items = (h) => ((h.sync() || {}).items || []);
const OFF = (n) => (n === "trip_save" ? { data: { ok: false, reason: "net" }, error: null } : undefined);
const DOWN = () => ({ data: null, error: { message: "TypeError: Failed to fetch" } });
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
// what the page shows (memory / screen), not what the device stores
function onScreen(h) {
  return h.val(`({cal:calNotes, plan:calPlans, dv:dayVenues, ph:Object.keys(calPhotos).filter(function(k){return k.charAt(0)!=="~";}).map(function(k){return calPhotos[k];}),
    trip:(window.__asaTripMem||ASA_ST.trip()||null), base:(function(){ try{ return PSET.getPrefs().base; }catch(e){ return "n/a"; } })(),
    form:(function(){ try{ var g=PSET.getPrefs(); return [g.startDate,g.endDate,g.must_see_ids,g.reservations]; }catch(e){ return null; } })(),
    pending:(window.TRIP?TripSync.pending():[]), notice:document.getElementById("tripSyncNotice").textContent, fav:[...favSet]})`);
}
// screen + the visible storage domains (what the next page would load)
function shown(h) {
  return Object.assign(onScreen(h), h.val(`({lsPrefs:ASA_ST.get("plan_prefs",{}), lsCal:ASA_ST.get("cal",{}), lsPlan:ASA_ST.get("plan",{}), lsDv:ASA_ST.get("dayven",{}), lsTrip:ASA_ST.get("trip",{}),
    lsPh:(function(){ var v=ASA_ST.get("calphoto",{}), o={}; Object.keys(v).forEach(function(k){ if(k.charAt(0)!=="~")o[k]=v[k]; }); return o; })()})`));
}
const leaksU1 = (x) => /U1-|U1PHOTO|52\.3741|2099-01-1|"x1"|"x2"|"p1"/.test(JSON.stringify(x));
const u1Data = (x) => /U1-|U1PHOTO|52\.3741|"x1"|"x2"|"p1"/.test(JSON.stringify(x));   // u1's content (u2's own trip 11 has the same dates)
const onDevice = (h, s) => JSON.stringify(h.storage.dump()).includes(s);
function quota(storage) {
  const real = storage.setItem.bind(storage); let cap = Infinity;
  const total = () => storage.keys().reduce((n, k) => n + k.length + storage.raw(k).length, 0);
  storage.setItem = (k, v) => { k = String(k); v = String(v); const cur = storage.raw(k); const next = total() - (cur == null ? 0 : k.length + cur.length) + k.length + v.length;
    if (next > cap) { storage.log.push(["set", k]); const e = new Error("quota (test)"); e.name = "QuotaExceededError"; e.code = 22; throw e; } return real(k, v); };
  return { free(n) { cap = total() + n; }, off() { cap = Infinity; } };
}
// the home page's real saveTrip / doLogout (index.html) on the same storage
function homeSaveTrip(h, sel) {
  const html = read("index.html");
  const i = html.indexOf("async function saveTrip(navigate){"), j = html.indexOf("\n}\n", i);
  h.run(`(function(){ var COUNTRIES=[{code:"nl",name:"Hollanda",cities:[{name:"Amsterdam",active:true}]}]; var sel=${JSON.stringify(sel)}; sel.types=new Set(sel.types||[]); var session=null;
    ${html.slice(i, j + 2)}
    saveTrip(false); })()`);
}
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
const SEL_UNDATED = { country: "nl", city: "Amsterdam", duration: "4–6 gün", durationDays: null, startDate: null, endDate: null, approx: "Belli değil", types: ["Kültür"] };

// What the production page (origin/main) leaves on a device after u1 opened trip 7: the trip copy, plan fields, plan prefs
// (accommodation), a device-only photo, the favourites list (u1's cloud x1/x2 + p1, hearted on this device only) — and NO
// plan_sync / fav_sync marker. "unsynced": a note that never reached the server.
function legacyDevice({ session = null, unsynced = true } = {}) {
  const seed = {
    "asa:ams:plan_prefs": JSON.stringify({ saved: true, tempo: "Dengeli", accommodation: U1_ACC, otherNote: "U1-other" }),
    "asa:ams:dayven": JSON.stringify(P0), "asa:ams:plan": JSON.stringify({ "2099-01-10": U1_PLAN }),
    "asa:ams:cal": JSON.stringify(Object.assign({ "2099-01-10": U1_NOTE }, unsynced ? { "2099-01-11": "U1-UNSYNCED-NOTE" } : {})),
    "asa:ams:calphoto": JSON.stringify({ "2099-01-10": [U1_PHOTO] }),
    "asa:ams:fav": JSON.stringify(SEEDS.concat(["x1", "x2", "p1"])),
    "asa:ams:trip": JSON.stringify({ id: 7, revision: 5, city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12" }),
  };
  if (session) seed.asa_session = JSON.stringify({ uid: session, email: "", display_name: null });
  const d = boot({ storage: fakeStorage(seed) });
  d.server.tables.trips.push(row7(), row9(), row9({ id: 11, start_date: "2099-01-10", end_date: "2099-01-12" }));
  d.server.tables.favorites.push({ user_id: "u1", venue_id: "x1", city: "Amsterdam" }, { user_id: "u1", venue_id: "x2", city: "Amsterdam" }, { user_id: "u2", venue_id: "c9", city: "Amsterdam" });
  assert.equal(d.sync(), null, "precondition: no plan_sync (pre-WP6 device)");
  return d;
}
// u1 comes back on trip 7 (space freed): its unsaved note is offered and restores, its photo and its device-only favourite are back
async function u1Back(prev) {
  const a = await page(prev, "u1", "?trip=7&city=Amsterdam");
  const offered = a.val("TripSync.pending()").some((x) => JSON.stringify(x.cal).includes("U1-UNSYNCED-NOTE"));
  if (offered) { a.el("tripSyncRestore").click(); await settle(); a.runTimers(); await settle(60); }
  return { a, offered, saved: JSON.stringify(a.server.trip(7).plan.cal).includes("U1-UNSYNCED-NOTE"), photo: a.val('calPhotos["2099-01-10"]||null'), p1: a.server.favIds("u1").includes("p1") };
}

// ================================================================================================ Q  pre-WP6 device, storage nearly full
// Releasing u1's copy needs room for its unsaved version; when that does not fit the copy stays (hidden, TS.foreign). The next account
// must not lift that lock for a copy nobody confirmed as its own (the round-4 TS.login lifted it and wrote owner=u2).
test("R5.Q1 (P1) pre-WP6 device, 0..1600 chars free, u2's session at load / u2 logs in with the form: nothing of u1 shown, uploaded or re-tagged; u1 gets it all back", T, async () => {
  const bad = [];
  for (const path of ["load", "form"]) {
    for (let free = 0; free <= 1600; free += 100) {
      const tag = `${path} free=${free}`;
      const d = legacyDevice();
      const q = quota(d.storage); q.free(free);
      let b;
      if (path === "load") b = await page(d, "u2");
      else {
        b = await page(d, null);
        if (leaksU1(onScreen(b))) bad.push(tag + ": anonymous visitor sees u1: " + JSON.stringify(onScreen(b)));
        await login(b, "u2");
      }
      if (leaksU1(onScreen(b))) bad.push(tag + ": u2 sees u1: " + JSON.stringify(onScreen(b)));
      const st = b.sync() || {};
      if (onDevice(b, "U1-UNSYNCED-NOTE") && b.ls("trip").id === 7 && (st.owner === "u2" || ((st.edit || {}).uid === "u2"))) bad.push(tag + ": u1's copy re-tagged as u2's: " + JSON.stringify(st));
      if (items(b).some((x) => JSON.stringify(x.cal || {}).includes("U1-UNSYNCED-NOTE") && x.uid === "u2")) bad.push(tag + ": u1's note filed as u2's version");
      if (JSON.stringify(b.server.favIds("u2")) !== '["c9"]') bad.push(tag + ": u1's favourites uploaded into u2: " + JSON.stringify(b.server.favIds("u2")));
      // u2 types on the plain page: either refused, or u2's own (never mixed into u1's copy, never deleting it)
      b.run('calNotes["2099-01-12"]="U2-NOTE"; saveLS("cal",calNotes)'); await settle();
      if (!onDevice(b, "U1-UNSYNCED-NOTE")) bad.push(tag + ": u1's unsaved note gone from the device after u2's edit");
      await logout(b);
      q.off();
      const anon = await page(b, null);
      if (leaksU1(onScreen(anon))) bad.push(tag + ": anonymous after u2's logout sees u1: " + JSON.stringify(onScreen(anon)));
      const r = await u1Back(anon);
      if (!(r.offered && r.saved)) bad.push(tag + ": u1's unsaved note not given back: " + JSON.stringify(items(r.a)));
      if (JSON.stringify(r.photo) !== JSON.stringify([U1_PHOTO])) bad.push(tag + ": u1's photo not back: " + JSON.stringify(r.a.ls("calphoto")));
      if (!r.p1) bad.push(tag + ": u1's device-only favourite lost: " + JSON.stringify(r.a.server.favIds("u1")) + " fav_sync=" + JSON.stringify(r.a.favSync()));
      if (JSON.stringify(r.a.server.favIds("u2")) !== '["c9"]') bad.push(tag + ": u2's account changed: " + JSON.stringify(r.a.server.favIds("u2")));
    }
  }
  assert.deepEqual(bad, []);
});
test("R5.Q2 (P1) pre-WP6 device of another account v (trip 9) with a big photo, the next account's session at open, storage nearly full: v's plan stays hidden and locked", T, async () => {
  for (const free of [0, 300, 600, 1200, 5000]) {
    const v = row9({ id: 9, user_id: "v", start_date: "2099-02-01", end_date: "2099-02-03" });
    const big = "data:image/jpeg;base64," + "V".repeat(200000);
    const st = fakeStorage({ "asa:ams:trip": JSON.stringify({ id: 9, revision: 2, city: "Amsterdam", country: "Hollanda", start_date: "2099-02-01", end_date: "2099-02-03" }),
      "asa:ams:cal": JSON.stringify({ "2099-02-01": "V-PRIVATE-NOTE" }), "asa:ams:plan": JSON.stringify({ "2099-02-02": "V-PRIVATE-PLAN" }), "asa:ams:calphoto": JSON.stringify({ "2099-02-01": [big] }) });
    const d = boot({ storage: st }); d.server.tables.trips.push(v);
    quota(d.storage).free(free);
    const b = await page(d, "u2");
    const s = onScreen(b);
    assert.ok(!/V-PRIVATE|VVVV/.test(JSON.stringify(s)), free + ": u2 sees v's plan / photo: " + JSON.stringify(s).slice(0, 300));
    if (b.ls("trip").id === 9) {                                       // the copy could not be released: it stays, hidden and locked
      assert.ok(b.val("TripSync.foreign"), free + ": v's copy still on the device but not locked");
      assert.equal(b.run('calNotes["2099-02-02"]="U2"; saveLS("cal",calNotes)'), false, free + ": u2's write over v's copy accepted");
      assert.equal((b.sync() || {}).owner || null, null, free + ": v's copy tagged as u2's");
    }
  }
});

// ================================================================================================ R  the owner check's server read fails
test("R5.R1 pre-WP6 device of the account itself, trips read fails at its first logged-in open: plan hidden (not taken over, not released), favourites kept; network back → all back", T, async () => {
  for (const search of ["?city=Amsterdam", "?trip=7&city=Amsterdam"]) {
    const d = legacyDevice({ session: "u1" });
    d.server.hooks.rest = (c) => (c.table === "trips" || c.table === "favorites" ? DOWN(c) : undefined);
    const a = await page(d, "u1", search);
    assert.ok(!u1Data(onScreen(a)), search + ": an unconfirmed copy shown: " + JSON.stringify(onScreen(a)));
    assert.ok(a.storeNotice().text.includes("doğrulanamadı"), search + ": user not told: " + a.storeNotice().text);
    assert.ok(!/sunucu|favori/i.test(a.storeNotice().text.split("doğrulanamadı")[0]), "new copy uses technical / legacy words");
    assert.equal(a.run('calNotes["2099-01-12"]="X"; saveLS("cal",calNotes)'), false, search + ": a write over the unconfirmed copy accepted");
    for (const k of ["U1-UNSYNCED-NOTE", "U1-GIZLI-PLAN", "U1PHOTO", "U1-otel"]) assert.ok(onDevice(a, k), search + ": " + k + " removed from the device");
    assert.equal(a.ls("trip").id, 7, search + ": the trip copy was released");
    assert.ok(onDevice(a, 'p1'), search + ": the device-only favourite deleted: " + JSON.stringify(a.storage.dump()["asa:ams:fav"]) + " " + JSON.stringify(a.favSync()));
    assert.equal(a.sync(), null, search + ": the copy was re-marked while unconfirmed: " + JSON.stringify(a.sync()));
    d.server.hooks.rest = undefined;
    const r = await page(a, "u1");                                     // network back, plain page
    assert.equal(r.val('calNotes["2099-01-11"]'), "U1-UNSYNCED-NOTE", search + ": the plan does not come back: " + JSON.stringify(onScreen(r)));
    assert.equal(r.val('calPlans["2099-01-10"]'), U1_PLAN);
    assert.deepEqual(r.val('calPhotos["2099-01-10"]||null'), [U1_PHOTO], search + ": photo: " + JSON.stringify(r.ls("calphoto")));
    assert.equal(r.sync().owner, "u1");
    assert.ok(r.server.favIds("u1").includes("p1") && r.run("favSet.has('p1')"), search + ": the device-only favourite not back: " + JSON.stringify(r.server.favIds("u1")));
  }
});

// ================================================================================================ F  favourites
test("R5.F1 (#4/#14/#23) pre-WP6 device's favourites are set aside, not deleted: never shown to the next visitors (two anonymous pages), back for the trip's confirmed owner", T, async () => {
  for (const variant of ["anon-then-u1", "anon-then-u2-then-u1", "u1-read-fails-once", "trip-deleted"]) {
    const d = legacyDevice({ session: variant.startsWith("anon") ? null : "u1" });
    let a;
    if (variant.startsWith("anon")) {
      const n1 = await page(d, null), n2 = await page(n1, null);
      for (const n of [n1, n2]) assert.equal(n.run("favSet.has('x1')||favSet.has('x2')||favSet.has('p1')"), false, variant + ": an anonymous page shows u1's favourites");
      assert.ok(!/"x1"|"p1"/.test(n2.storage.raw("asa:ams:fav")), variant + ": u1's list still the device list: " + n2.storage.raw("asa:ams:fav"));
      assert.ok(onDevice(n2, 'p1'), variant + ": the list deleted instead of set aside");
      if (variant === "anon-then-u2-then-u1") {                         // another account in between: nothing reaches it, the list stays set aside
        const u2 = await page(n2, "u2");
        assert.deepEqual(u2.server.favIds("u2"), ["c9"], variant + ": u1's list uploaded into u2");
        assert.equal(u2.run("favSet.has('x1')||favSet.has('p1')"), false, variant);
        await logout(u2); assert.ok(onDevice(u2, 'p1'), variant + ": set-aside list lost at u2's logout");
      }
      a = await page(n2, "u1");                                         // u1 logs in (plain page): the server confirms trip 7 is u1's → back
    } else if (variant === "u1-read-fails-once") {
      d.server.hooks.rest = (c) => (c.table === "trips" && c.op === "select" ? DOWN(c) : undefined);   // offline for the trips reads of this page
      const f = await page(d, "u1");
      assert.ok(!f.server.favIds("u1").includes("p1") && !f.run("favSet.has('p1')"), "precondition: not shown / merged while unconfirmed");
      d.server.hooks.rest = undefined;
      a = await page(f, "u1");
    } else {
      d.server.tables.trips = d.server.tables.trips.filter((t) => t.id !== 7);
      a = await page(d, "u1");
      assert.ok(onDevice(a, 'p1'), variant + ": the list deleted (owner cannot be confirmed: kept, hidden)");
      assert.equal(a.run("favSet.has('p1')"), false);
      continue;
    }
    assert.ok(a.server.favIds("u1").includes("p1"), variant + ": u1's device-only favourite lost: " + JSON.stringify(a.server.favIds("u1")) + " " + JSON.stringify(a.favSync()));
    assert.ok(a.run("favSet.has('p1')&&favSet.has('x1')"), variant);
    assert.ok(!SEEDS.some((s) => a.server.favIds("u1").includes(s)), variant + ": seed favourites uploaded: " + JSON.stringify(a.server.favIds("u1")));
    assert.equal((a.favSync() || {}).held, undefined, variant + ": the set-aside list left behind");
  }
});
test("R5.F2 (#7) logout in tab 1 (browser event order: asa_session first, then fav): the stale tab 2 shows no list and its heart reaches no device list and no account", T, async () => {
  const d = legacyDevice({ session: "u1" }); d.storage.setItem("asa:ams:fav", JSON.stringify(["x1", "x2"]));
  const t1 = await page(d, "u1"), t2 = await page(t1, "u1");
  assert.ok(t2.run("favSet.has('x1')"), "precondition");
  d.storage.removeItem("asa_session"); t2.fireStorage("asa_session");    // the browser delivers asa_session before t1's other writes
  await logout(t1); ev(t2, ["fav", "fav_sync", "plan_sync"]);
  assert.equal(t2.run("favSet.size"), 0, "the stale tab still shows a list: " + JSON.stringify(t2.val("[...favSet]")));
  t2.run('toggleFav("x3")'); await settle();
  assert.ok(!/x1|x2|x3/.test(t2.storage.raw("asa:ams:fav") || ""), "the stale tab wrote to the device list: " + t2.storage.raw("asa:ams:fav"));
  assert.ok(!JSON.stringify(t2.favSync() || {}).includes("x3"), "the stale tab's heart queued for the next login: " + JSON.stringify(t2.favSync()));
  assert.ok(t2.storeNotice().text.includes("başka bir sekmede oturum kapatıldı"), "user not told: " + t2.storeNotice().text);
  const anon = await page(t1, null);
  assert.equal(anon.run("favSet.has('x1')||favSet.has('x3')"), false);
  const u2 = await page(anon, "u2");
  assert.deepEqual(u2.server.favIds("u2"), ["c9"], "u1's / the stale tab's favourites in u2's account");
  await login(t2, "u1");                                                 // a re-login in the stale tab works again
  t2.run('toggleFav("x3")'); await settle();
  assert.ok(t2.server.favIds("u1").includes("x3"), "re-login in the tab does not lift the refusal");
});
test("R5.F3 (#10) the next account's login with its session present: the previous account's list is not shown during the login, nor for the session when its favourites read fails", T, async () => {
  for (const failRead of [false, true]) {
    const d = boot(); d.server.tables.trips.push(row7()); d.server.tables.favorites.push({ user_id: "u1", venue_id: "x1", city: "Amsterdam" }, { user_id: "u1", venue_id: "x2", city: "Amsterdam" }, { user_id: "u2", venue_id: "c9", city: "Amsterdam" });
    const a = await page(d, "u1");
    assert.ok(a.run("favSet.has('x1')"), "precondition");
    await homeLogout(a.storage, "u1");                                   // the home page leaves the list for the city page
    const b = bootLike(a, { search: "?city=Amsterdam" }); b.useDb(); b.useRealAsa(); b.asa.set("db", b.db); b.server.uid = "u2"; b.server.session = undefined;
    const dev0 = b.storage.raw("asa:ams:fav");                           // u1's copy, left by the home logout under u1's marker
    let rel; const gate = new Promise((r) => { rel = r; });
    b.server.hooks.rest = (c) => (c.table === "members" ? gate.then(() => ({ data: null, error: null })) : (failRead && c.table === "favorites" && c.op === "select" ? { data: null, error: { message: "503" } } : undefined));
    const m0 = b.server.rest("members").length, run = b.asa.ev("init()");
    for (let i = 0; i < 80 && b.server.rest("members").length === m0; i++) await settle(2);
    assert.ok(b.server.rest("members").length > m0 && b.val("ASA.session") === null, "precondition: inside the login window");
    assert.equal(b.run("favSet.has('x1')||favSet.has('x2')"), false, failRead + ": u1's list shown during u2's login");
    rel(); await run; await settle(80);
    assert.equal(b.run("favSet.has('x1')||favSet.has('x2')"), false, failRead + ": u1's list shown as u2's: " + JSON.stringify(b.val("[...favSet]")));
    b.run('toggleFav("p1")'); await settle();
    // read OK: the device list is u2's copy now (u1's list not written back). Read failed (round 6): u2's heart goes to u2's account only —
    // u1's copy is left as it was, still under u1's marker (cleared at u2's logout / the next anonymous open), never relabelled with u2's heart
    if (failRead) assert.ok(b.storage.raw("asa:ams:fav") === dev0 && b.favSync().uid === "u1", failRead + ": u2's heart written onto u1's device copy: " + b.storage.raw("asa:ams:fav") + " " + JSON.stringify(b.favSync()));
    else assert.ok(!/x1|x2/.test(b.storage.raw("asa:ams:fav") || ""), failRead + ": u1's list written back: " + b.storage.raw("asa:ams:fav"));
    if (failRead) assert.ok(b.server.favIds("u2").includes("p1"), failRead + ": u2's heart did not reach u2's account");
    assert.ok(!b.server.favIds("u2").some((x) => x === "x1" || x === "x2"), failRead + ": u1's favourites in u2's account");
  }
});
test("R5.F4 (#8) the auth client ends this tab's session (expiry / revocation / another account signed in elsewhere): the tab goes stale; its own logout does not", T, async () => {
  for (const [event, who] of [["SIGNED_OUT", null], ["SIGNED_IN", "u2"], ["TOKEN_REFRESHED", "u2"]]) {
    const d = boot(); d.server.tables.trips.push(row7(), row9());
    const a = await page(d, "u1", "?trip=7&city=Amsterdam");
    assert.equal(a.val("ASA.session.uid"), "u1", "precondition");
    a.server.uid = who || "nobody"; a.server.emitAuth(event, who);        // asa_session still says u1 (the home page never rewrites it)
    assert.equal(a.val("ASA.session"), null, event + ": the tab still acts as u1");
    assert.ok(!leaksU1(onScreen(a)) || !onScreen(a).cal["2099-01-10"], event + ": u1's plan still on screen");
    a.run('toggleFav("p2")'); await settle();
    assert.ok(!a.server.tables.favorites.some((f) => f.venue_id === "p2"), event + ": the tab's heart reached an account");
    assert.equal(a.run('calNotes["2099-01-11"]="A"; saveLS("cal",calNotes)'), false, event + ": plan write accepted");
  }
  // same-tab logout with the client's own SIGNED_OUT: the plan is still released normally (not a stale-tab no-op)
  const d = boot(); d.server.tables.trips.push(row7());
  const a = await page(d, "u1", "?trip=7&city=Amsterdam"); a.server.emitOnSignOut = true;
  await logout(a);
  assert.deepEqual(a.ls("cal"), {}, "own logout did not release the plan: " + JSON.stringify(a.ls("cal")));
  assert.equal(a.val("TripSync.gone"), false);
});

// ================================================================================================ U  plan without exact dates
const gKeys = (t) => /"g\d+"/.test(JSON.stringify((t && t.plan) || {}));
async function undatedPlan(prev, who = "u1") {
  const d = prev || boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(UNDATED) }) });
  if (!prev) d.server.tables.trips.push(row7());
  const a = await page(d, who);
  assert.deepEqual(a.val("CAL.days.map(d=>d.key)"), ["g1", "g2", "g3", "g4", "g5"], "precondition: undated calendar");
  a.run('calNotes.g1="UNDATED-NOTE-1"; saveLS("cal",calNotes); calPlans.g2="UNDATED-PLAN-2"; saveLS("plan",calPlans)');
  return a;
}
test("R5.U1 (#1) an undated plan, then a dated trip is opened while logged in: offered there (restore puts '1. gün' on the first day) and back on the undated search", T, async () => {
  for (const variant of ["open-trip7-restore", "open-trip7-back-on-undated", "dates-picked-trip12"]) {
    const a = await undatedPlan();
    let t;
    if (variant === "dates-picked-trip12") {
      homeSaveTrip(a, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-06-01", endDate: "2099-06-03", approx: null, types: ["Kültür"] });
      a.server.tables.trips.push(row({ id: 12, revision: 1, start_date: "2099-06-01", end_date: "2099-06-03", plan: { dayven: {}, cal: { "2099-06-03": "TRIP12-NOTE" }, plan: {} } }));
      t = await page(a, "u1", "?trip=12&city=Amsterdam");
    } else t = await page(a, "u1", "?trip=7&city=Amsterdam");
    const v = t.val("TripSync.pending()").find((x) => x.cal && x.cal.g1 === "UNDATED-NOTE-1");
    assert.ok(v, variant + ": the undated plan is not offered on the dated trip: " + JSON.stringify(items(t)));
    assert.equal(v.start_date, null, variant + ": the kept copy took the new search's dates: " + JSON.stringify(v));
    if (variant === "open-trip7-back-on-undated") {
      homeSaveTrip(t, SEL_UNDATED);
      const p = await page(t, "u1");
      assert.equal(p.val("calNotes.g1"), "UNDATED-NOTE-1", variant + ": not back on the undated search: " + JSON.stringify(onScreen(p)) + " items=" + JSON.stringify(items(p)));
      assert.equal(p.val("calPlans.g2"), "UNDATED-PLAN-2");
      continue;
    }
    t.el("tripSyncRestore").click(); await settle(); t.runTimers(); await settle(60);
    const id = variant === "dates-picked-trip12" ? 12 : 7, d0 = variant === "dates-picked-trip12" ? "2099-06-01" : "2099-01-10", d1 = variant === "dates-picked-trip12" ? "2099-06-02" : "2099-01-11";
    const pl = t.server.trip(id).plan;
    assert.equal(pl.cal[d0], "UNDATED-NOTE-1", variant + ": '1. gün' not on the trip's first day: " + JSON.stringify(pl));
    assert.equal(pl.plan[d1], "UNDATED-PLAN-2", variant);
    assert.ok(!gKeys(t.server.trip(id)), variant + ": invisible 'g' keys written into the trip");
    assert.equal(t.val(`calNotes[${JSON.stringify(d0)}]`), "UNDATED-NOTE-1", variant + ": not on screen");
  }
});
test("R5.U5 (#1) an undated plan with a note on its 5th day is not offered on a 3-day trip (it would not fit) — trip 7 untouched, the plan comes back on the undated search", T, async () => {
  const a = await undatedPlan();
  a.run('calNotes.g5="DAY-FIVE"; saveLS("cal",calNotes)');
  const t = await page(a, "u1", "?trip=7&city=Amsterdam");
  assert.ok(!t.val("TripSync.pending()").some((x) => x.trip_id == null), "offered on a trip it does not fit: " + JSON.stringify(t.val("TripSync.pending()")));
  assert.equal(t.server.trip(7).plan.cal["2099-01-10"], U1_NOTE);
  homeSaveTrip(t, SEL_UNDATED);
  const p = await page(t, "u1");
  assert.equal(p.val("calNotes.g5"), "DAY-FIVE", "not back on the undated search: " + JSON.stringify(items(p)));
});
test("R5.U2 (#2) an undated plan after a HOME logout / a changed search: back for the same account on the plain page; never on days its calendar does not show", T, async () => {
  for (const variant of ["home-logout-no-search", "home-logout-same-search", "duration-2-3", "interest-added", "dates-picked"]) {
    const a = await undatedPlan();
    await homeLogout(a.storage, "u1");
    const anon = await page(a, null);
    assert.ok(!/UNDATED-/.test(JSON.stringify(shown(anon))), variant + ": the anonymous visitor sees it");
    if (variant === "home-logout-no-search") {                          // a direct /amsterdam/ link: the plan comes back with ITS search
      const b = await page(anon, "u1");
      assert.equal(b.val("calNotes.g1"), "UNDATED-NOTE-1", variant + ": not back: " + JSON.stringify(items(b)));
      assert.equal(b.ls("trip").approx_period, "Belli değil", variant + ": its search lost (the home page had emptied the trip): " + b.storage.raw("asa:ams:trip"));
      assert.deepEqual(b.val("CAL.days.map(d=>d.key)"), ["g1", "g2", "g3", "g4", "g5"], variant);
      continue;
    }
    const sel = Object.assign({}, SEL_UNDATED);
    if (variant === "duration-2-3") sel.duration = "2–3 gün";
    if (variant === "interest-added") sel.types = ["Kültür", "Gastronomi"];
    if (variant === "dates-picked") Object.assign(sel, { duration: null, durationDays: 3, startDate: "2099-08-01", endDate: "2099-08-03", approx: null });
    homeSaveTrip(anon, sel);
    const b = await page(anon, "u1"); b.runTimers(); await settle(60);
    if (variant === "dates-picked") {
      assert.ok(!/UNDATED-/.test(JSON.stringify([b.val("calNotes"), b.val("calPlans")])), variant + ": restored onto days the calendar does not show");
      assert.ok(!b.server.tables.trips.some(gKeys), variant + ": 'g' keys uploaded");
      const v = b.val("TripSync.pending()").find((x) => x.cal && x.cal.g1 === "UNDATED-NOTE-1");
      assert.ok(v, variant + ": not offered on the new dated trip: " + JSON.stringify(items(b)));
      continue;
    }
    assert.equal(b.val("calNotes.g1"), "UNDATED-NOTE-1", variant + ": not back: " + JSON.stringify(onScreen(b)) + " items=" + JSON.stringify(items(b)));
    assert.equal(b.val("calPlans.g2"), "UNDATED-PLAN-2", variant);
    assert.equal(b.ls("trip").approx_period, "Belli değil", variant + ": the search the user entered was replaced");
  }
});
test("R5.U3 (#16) a restore that does not fit (storage nearly full): all or nothing — the user is told, nothing half-restored, the version kept; space freed → the whole plan is back", T, async () => {
  for (const how of ["plan-write-fails", "marker-does-not-fit"]) {
    const a = await undatedPlan();
    await logout(a);
    const anon = await page(a, null);
    assert.ok(items(anon).some((x) => x.cal && x.cal.g1 === "UNDATED-NOTE-1"), "precondition: kept");
    let q = null;
    if (how === "plan-write-fails") anon.storage.failOn("asa:ams:plan"); else { q = quota(anon.storage); q.free(60); }
    const b = await page(anon, "u1");
    assert.ok(b.storeNotice().text.includes("geri yüklenemedi"), how + ": user not told: " + b.storeNotice().text);
    assert.ok(!/UNDATED-/.test(JSON.stringify([b.ls("cal"), b.ls("plan"), b.val("calNotes"), b.val("calPlans")])), how + ": half-restored: " + JSON.stringify([b.ls("cal"), b.ls("plan")]));
    assert.ok(items(b).some((x) => x.cal && x.cal.g1 === "UNDATED-NOTE-1" && x.plan.g2 === "UNDATED-PLAN-2"), how + ": the version lost");
    assert.notEqual(b.val("TripSync.localState()"), "unsynced", how + ": a partial copy left as the device's unsaved plan");
    b.storage.allow("asa:ams:plan"); if (q) q.off();
    const r = await page(b, "u1");
    assert.equal(r.val("calNotes.g1"), "UNDATED-NOTE-1", how); assert.equal(r.val("calPlans.g2"), "UNDATED-PLAN-2", how + ": the plan text did not come back");
    assert.equal(items(r).filter((x) => x.trip_id == null).length, 0, how + ": copies left behind: " + JSON.stringify(items(r)));
  }
});
test("R5.U4 (#20) restore guards: a newer guest edit is never overwritten; a dated search gets nothing restored / uploaded; a ?trip= login first does not use it up", T, async () => {
  // (a) the same person, logged out, writes on the same undated search before logging in again
  const a = await undatedPlan(); await logout(a);
  homeSaveTrip(a, SEL_UNDATED);
  const g = await page(a, null);
  g.run('calNotes.g1="NEWER-GUEST-NOTE"; saveLS("cal",calNotes)');
  await login(g, "u1");
  assert.equal(g.val("calNotes.g1"), "NEWER-GUEST-NOTE", "(a) the newer guest note replaced by the older version");
  assert.ok(items(g).some((x) => x.cal && x.cal.g1 === "UNDATED-NOTE-1"), "(a) the older version used up / deleted");
  // (b) a dated home search before the login: nothing restored, nothing with "g" keys uploaded, still kept
  const b0 = await undatedPlan(); await logout(b0);
  homeSaveTrip(b0, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-09-01", endDate: "2099-09-03", approx: null, types: [] });
  const b = await page(b0, "u1"); b.runTimers(); await settle(60);
  assert.ok(!/UNDATED-/.test(JSON.stringify(b.val("calNotes"))), "(b) restored onto a dated calendar");
  assert.ok(!b.server.tables.trips.some(gKeys), "(b) 'g' keys uploaded: " + JSON.stringify(b.server.tables.trips.map((t) => t.plan)));
  assert.ok(items(b).some((x) => x.cal && x.cal.g1 === "UNDATED-NOTE-1"), "(b) the version deleted");
  // (c) a login on ?trip=7 first: offered there, not used up; the plain page after the next logout gets it back
  const c0 = await undatedPlan(); await logout(c0);
  const c7 = await page(c0, "u1", "?trip=7&city=Amsterdam");
  assert.equal(c7.server.trip(7).plan.cal["2099-01-10"], U1_NOTE, "(c) trip 7 changed without the user's choice");
  await logout(c7);
  const c = await page(c7, "u1");
  assert.equal(c.val("calNotes.g1"), "UNDATED-NOTE-1", "(c) the undated note not back on the plain page: " + JSON.stringify(items(c)));
});

// ================================================================================================ H  home page guards (index.html)
const SEL_MAY = { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-05-01", endDate: "2099-05-03", approx: null, types: ["Kültür"] };
test("R5.H1 (#3) pre-WP6 device, home search with storage nearly full: when the 'trip 7' marker does not fit the trip copy is not overwritten (user told); nothing of u1 reaches anyone", T, async () => {
  for (const free of [60, 100, 140, 400]) {
    const d = legacyDevice();
    const q = quota(d.storage); q.free(free);
    homeSaveTrip(d, SEL_MAY);
    const marked = d.sync() !== null;
    assert.ok(marked || d.ls("trip").id === 7, free + ": the trip copy was overwritten without its marker: " + d.storage.raw("asa:ams:trip"));
    if (!marked) assert.ok(d.sb.__alerts.some((m) => /depolaması dolu/.test(m)), free + ": user not told: " + JSON.stringify(d.sb.__alerts));
    q.off();
    const anon = await page(d, null);
    assert.ok(!u1Data(shown(anon)), free + ": the anonymous visitor gets u1's plan as a guest plan: " + JSON.stringify(shown(anon)));
    await login(anon, "u2"); anon.runTimers(); await settle(60);
    for (const t of anon.server.tables.trips.filter((x) => x.user_id === "u2")) assert.ok(!u1Data(t), free + ": u1's plan uploaded into u2's trip");
    await logout(anon);
    const r = await u1Back(anon);
    assert.ok(r.offered && r.saved, free + ": u1's unsaved note lost");
  }
});
test("R5.H2 (#18) home saveTrip / doLogout guards: a WP6 device's kept version survives a home search; a failed logout marker keeps the copy; another account's copy is never re-claimed; pending favourite ops survive", T, async () => {
  // (1) WP6 device with a kept conflict version for trip 7, then a home search: owner and versions untouched, still offered on trip 7
  const d = boot(); d.server.tables.trips.push(row7());
  const a = await page(d, "u1", "?trip=7&city=Amsterdam");
  const r7 = a.server.trip(7); Object.assign(r7, { plan: { dayven: { "2099-01-12": ["x3"] }, cal: {}, plan: {} } }); r7.revision++;
  a.run('calNotes["2099-01-11"]="KEPT-VERSION"; saveLS("cal",calNotes)'); await a.run("TripSync.flush()"); await settle(60);
  const before = J(a.sync());
  assert.ok(items(a).some((x) => JSON.stringify(x.cal).includes("KEPT-VERSION")), "precondition: conflict version kept");
  homeSaveTrip(a, SEL_MAY);
  assert.deepEqual(a.sync().items, before.items, "(1) the home search dropped the kept version"); assert.equal(a.sync().owner, "u1");
  const k = await page(a, "u1", "?trip=7&city=Amsterdam");
  assert.ok(k.val("TripSync.pending()").some((x) => JSON.stringify(x.cal).includes("KEPT-VERSION")), "(1) not offered on trip 7 any more");
  // (2) pre-WP6 device, the home logout's marker write fails: the trip copy is kept, nothing of u1 reaches the next person
  const e = legacyDevice();
  e.storage.failOn("asa:ams:plan_sync"); await homeLogout(e.storage, "u1"); e.storage.allow("asa:ams:plan_sync");
  assert.equal(e.ls("trip").id, 7, "(2) the trip copy emptied although its marker was not written");
  const anon = await page(e, null);
  assert.ok(!leaksU1(onScreen(anon)), "(2) anonymous: " + JSON.stringify(onScreen(anon)));
  const u2 = await page(anon, "u2");
  assert.ok(!leaksU1(onScreen(u2)) && u2.val("TripSync.importable()") === false, "(2) u2");
  // (3) u2's device (with a photo; on trip 9 / on a trip-less undated search), u2 logs out on the home page, u1 searches and logs out
  // there: the copy stays u2's
  for (const u2On of ["trip9", "undated"]) {
    const f = u2On === "undated" ? boot({ storage: fakeStorage({ "asa:ams:trip": JSON.stringify(UNDATED) }) }) : boot(); f.server.tables.trips.push(row9());
    const b = await page(f, "u2", u2On === "undated" ? "?city=Amsterdam" : "?trip=9&city=Amsterdam"), day = u2On === "undated" ? "g2" : "2099-03-02";
    b.run(`calPhotos[${JSON.stringify(day)}]=[${JSON.stringify(U2_PHOTO)}]; saveLS("calphoto",calPhotos,true)`);
    await homeLogout(b.storage, "u2");
    homeSaveTrip(b, SEL_MAY); await homeLogout(b.storage, "u1");
    assert.equal(b.sync().owner, "u2", "(3) " + u2On + ": another account's copy re-claimed by u1: " + JSON.stringify(b.sync()));
    const n = await page(b, null);
    const p1 = await page(n, "u1");
    assert.ok(!JSON.stringify(p1.val("calPhotos")).includes("U2PHOTO") && !JSON.stringify(p1.ls("calphoto")).includes("~u:u1|"), "(3) " + u2On + ": u1 sees / owns u2's photo: " + JSON.stringify(p1.ls("calphoto")));
    await logout(p1);
    const p2 = await page(p1, "u2", u2On === "undated" ? "?city=Amsterdam" : "?trip=9&city=Amsterdam");
    assert.ok(JSON.stringify(p2.ls("calphoto")).includes("U2PHOTO") && Object.keys(p2.ls("calphoto")).some((k) => k.charAt(0) !== "~"), "(3) " + u2On + ": u2's photo not back: " + JSON.stringify(p2.ls("calphoto")));
  }
  // (4) a pending favourite op (offline heart) survives a home logout and reaches the account at the next login
  const g = boot();
  const c = await page(g, "u1");
  c.server.hooks.rest = (q) => (q.table === "favorites" && q.op === "upsert" ? DOWN(q) : undefined);
  c.run('toggleFav("p1")'); await settle(); c.server.hooks.rest = undefined;
  assert.ok(c.favSync().ops.some((o) => o.id === "p1" && o.uid === "u1"), "precondition: pending op");
  await homeLogout(c.storage, "u1");
  const c2 = await page(c, "u1");
  assert.ok(c2.server.favIds("u1").includes("p1"), "(4) the offline favourite change lost at the home logout");
});
test("R5.H3 (#9) pre-WP6 device, ANOTHER account logs in and out on the home page: u1's copy is not recorded as u2's — u2 never sees it, u1 gets its note and photo back", T, async () => {
  for (const next of ["anon-page", "u2-back-logged-in"]) {
    const d = legacyDevice();
    await homeLogout(d.storage, "u2");
    const s = d.sync() || {};
    assert.notEqual(s.owner, "u2", next + ": u1's copy recorded as u2's: " + JSON.stringify(s));
    assert.notEqual((s.edit || {}).uid, "u2", next);
    const b = next === "anon-page" ? await page(await page(d, null), "u2", "?trip=11&city=Amsterdam") : await page(d, "u2");
    assert.ok(!u1Data(onScreen(b)), next + ": u2 sees u1's copy: " + JSON.stringify(onScreen(b)));
    assert.ok(!items(b).some((x) => JSON.stringify(x.cal || {}).includes("U1-UNSYNCED") && x.uid === "u2"), next + ": u1's note filed as u2's");
    await logout(b);
    const r = await u1Back(b);
    assert.ok(r.offered && r.saved, next + ": u1's unsaved note lost: " + JSON.stringify(items(r.a)));
    assert.deepEqual(r.photo, [U1_PHOTO], next + ": u1's photo");
  }
});

// ================================================================================================ D  day modal: refused typing
// the page's real renderDay / dayFieldSaved / openDay with the day modal's text fields as event targets (as in wp6_sync_r4 X2)
function dayModal(h) {
  const html = h.html, i = html.indexOf("/* WP6 · gün penceresindeki not alanları"), j = html.indexOf("function renderDay(d){");
  h.run(html.slice(i, j) + fnSrc(html, "function renderDay(d){") + "\n" + fnSrc(html, "function openDay(d){") + "\n" + fnSrc(html, "function closeDay(){") + "\n" + fnSrc(html, "function dayInfo(k){") +
    "\nwindow.scrollTo=function(){}; function renderDayFilter(){} function wireDayDrag(){} function byId(id){ return V.find(function(v){ return v.id===id; }); } function isFav(){ return false; } function escT(s){ return String(s||''); }");
  for (const [id, tag] of [["dayModal", "div"], ["dayBody", "div"], ["dayPlan", "textarea"], ["dayNote", "textarea"], ["daySaveNote", "p"], ["dayPhotoInput", "input"]]) {
    if (h.el(id)) continue;
    const e = h.dom.add(id, tag, id === "dayModal" ? "daymodal hide" : (id === "daySaveNote" ? "hide" : ""));
    e.listeners = {}; e.addEventListener = (t, f) => { e.listeners[t] = f; };
  }
  // renderDay writes the fields' HTML into #dayBody; the mini DOM does not parse it — these stand in for the parsed fields, and get the
  // value renderDay would render (the page's memory) on every render
  const sync = () => { h.el("dayNote").value = h.val("calNotes[dayCur]||''"); h.el("dayPlan").value = h.val("calPlans[dayCur]||''"); };
  return { open(d) { h.run(`openDay(${JSON.stringify(d)})`); sync(); }, close() { h.run("closeDay()"); },
    type(id, ch) { const e = h.el(id); e.value += ch; e.listeners.input && e.listeners.input({ target: e }); }, el: (id) => h.el(id), note: () => { const n = h.el("daySaveNote"); return n.classList.contains("hide") ? "" : n.textContent; } };
}
test("R5.D1 (#5/#27) typing refused while the session is read / in a stale tab / on another trip's storage / under the storage-full lock: reverted in the field, explained in the modal, never shown as saved", T, async () => {
  const cases = {
    async waiting() {                                                    // getSession still pending (a token refresh), device holds an account's copy
      const a = await page(twoAccountsDev(), "u1", "?trip=7&city=Amsterdam");
      const b = bootLike(a, { search: "?city=Amsterdam" }); b.useDb(); b.useRealAsa(); b.asa.set("db", b.db);
      let rel; b.server.session = new Promise((r) => { rel = r; }); const run = b.asa.ev("init()"); await settle(4);
      return { h: b, why: "Oturum bilgilerin okunuyor", after: async () => { rel({ data: { session: { user: { id: "u1" } } }, error: null }); await run; await settle(60); } };
    },
    async gone() {
      const a = await page(twoAccountsDev(), "u1", "?trip=7&city=Amsterdam"), b = await page(a, "u1");
      await logout(b); await login(b, "u2"); a.fireStorage("asa_session");
      return { h: a, why: "oturumun kapandı" };
    },
    async detached() {
      const a = tripOn(row()); a.server.tables.trips.push(row({ id: 8, revision: 1, start_date: "2099-02-10", end_date: "2099-02-12" }));
      const b = bootLike(a); b.useDb(); b.open(a.server.trip(8));
      return { h: a, why: "başka bir seyahat açıldı" };
    },
    async locked() {
      const t1 = tripOn(row());
      t1.server.hooks.rpc = OFF; t1.edit("cal", { "2099-01-10": "T7-OFFLINE-NOTE" }); await t1.run("TripSync.flush()"); await settle(); t1.server.hooks.rpc = undefined;
      t1.server.tables.trips.push(row({ id: 8, revision: 1, start_date: "2099-01-10", end_date: "2099-01-12" }));
      quota(t1.storage).free(40);
      const t2 = bootLike(t1, { search: "?trip=8&city=Amsterdam" }); t2.useDb(); t2.open(t1.server.trip(8));
      assert.equal(t2.val("TripSync.locked()"), true, "precondition: storage-full lock");
      return { h: t2, why: "Cihaz depolaması dolu" };
    },
  };
  for (const [name, mk] of Object.entries(cases)) {
    const { h, why, after } = await mk();
    const m = dayModal(h), day = "2099-01-11";
    m.open(day);
    const was = m.el("dayNote").value;
    for (const ch of "Muze") m.type("dayNote", ch);
    assert.equal(m.el("dayNote").value, was, name + ": the field shows text that was not saved: " + m.el("dayNote").value);
    assert.equal(h.val(`calNotes[${JSON.stringify(day)}]||""`), was, name + ": memory holds unsaved text");
    assert.ok(m.note().includes(why) && m.note().includes("kaydedilmedi"), name + ": not explained in the modal: " + JSON.stringify(m.note()));
    assert.ok(!/sunucu|favori/i.test(m.note()), name + ": technical / legacy wording: " + m.note());
    m.close(); m.open(day);
    assert.ok(!m.el("dayNote").value.includes("Muze"), name + ": reopening the day shows the refused text as saved");
    assert.ok(!onDevice(h, "Muze"), name);
    assert.equal(h.sb.__alerts.length, 0, name + ": blocking alerts");
    if (after) { await after(); m.open(day); m.type("dayNote", "X"); assert.equal(h.val(`calNotes[${JSON.stringify(day)}]`), "X", name + ": typing does not work once the session is read"); }
  }
});
function twoAccountsDev() { const h = boot(); h.server.tables.trips.push(row7(), row9()); return h; }
test("R5.D2 (#24) storage fills up after the first keystroke (marker already written, the note write fails): the field and memory stay at what is stored", T, async () => {
  for (const field of ["dayNote", "dayPlan"]) {
    const h = tripOn(row()); const m = dayModal(h);
    m.open("2099-01-10");
    m.type(field, "a");
    const k = field === "dayNote" ? "cal" : "plan", mem = field === "dayNote" ? "calNotes" : "calPlans";
    assert.equal(h.ls(k)["2099-01-10"], "a", "precondition: first keystroke saved");
    const q = quota(h.storage); q.free(0);
    for (const ch of "bcdefghij") m.type(field, ch);
    assert.equal(h.ls(k)["2099-01-10"], "a");
    assert.equal(m.el(field).value, "a", field + ": the field shows unsaved text");
    assert.equal(h.val(`${mem}["2099-01-10"]`), "a", field + ": memory holds unsaved text");
    assert.ok(m.note().includes("cihaz depolaması dolu"), field + ": no inline note");
    q.off();
  }
});

// ================================================================================================ K  coverage (each kills a named mutant)
test("R5.K1 (#17) pre-WP6 device: hidden while the owner check is in flight (L02); the device's own account keeps its unsaved note (L05); no write before the session is read (G06)", T, async () => {
  // L02: u2 at load, the trips read (owner check) held
  const d = legacyDevice();
  d.useDb(); d.useRealAsa(); d.asa.set("db", d.db); d.server.uid = "u2"; d.server.session = undefined;
  let rel; const gate = new Promise((r) => { rel = r; });
  d.server.hooks.rest = (c) => (c.table === "trips" && c.op === "select" ? gate.then(() => { d.server.hooks.rest = undefined; return undefined; }).then(() => ({ data: null, error: null })) : undefined);
  const run = d.asa.ev("init()");
  for (let i = 0; i < 80 && !d.server.rest("trips", "select").length; i++) await settle(2);
  assert.ok(d.server.rest("trips", "select").length, "precondition: owner check in flight");
  assert.ok(!leaksU1(onScreen(d)), "u1's plan shown while the owner check runs: " + JSON.stringify(onScreen(d)));
  assert.equal(d.run('calNotes["2099-01-12"]="U2-DURING-CHECK"; saveLS("cal",calNotes)'), false, "a write over the unconfirmed copy accepted during the check");
  rel(); await run; await settle(60);
  assert.ok(!leaksU1(onScreen(d)));
  // L05: the device's own account on the plain page: its plan is on screen and an edit keeps the never-uploaded note
  const o = await page(legacyDevice({ session: "u1" }), "u1");
  assert.equal(o.val('calNotes["2099-01-11"]'), "U1-UNSYNCED-NOTE", "the account's own copy hidden: " + JSON.stringify(onScreen(o)));
  assert.equal(o.run('calNotes["2099-01-12"]="U1-NEW"; saveLS("cal",calNotes)'), true);
  assert.deepEqual(o.ls("cal"), { "2099-01-10": U1_NOTE, "2099-01-11": "U1-UNSYNCED-NOTE", "2099-01-12": "U1-NEW" }, "the account's unsaved note erased by its own edit");
  // G06: pre-WP6 device, getSession pending: a note is refused, and is never filed into u1's trip-7 version
  const g = legacyDevice(); g.useDb(); g.useRealAsa(); g.asa.set("db", g.db);
  let rel2; g.server.session = new Promise((r) => { rel2 = r; }); const run2 = g.asa.ev("init()"); await settle(4);
  assert.equal(g.run('calNotes["2099-01-12"]="U2-TYPED-DURING-SESSION-READ"; saveLS("cal",calNotes)'), false, "a write before the session was read on a pre-WP6 device");
  g.server.uid = "u2"; rel2({ data: { session: { user: { id: "u2" } } }, error: null }); await run2; await settle(60);
  assert.ok(!onDevice(g, "U2-TYPED"), "u2's note filed somewhere: " + JSON.stringify(items(g)));
  // the login-form path (no session wait): the session read had failed at load (the copy stayed), u2 logs in, owner check held
  const e = legacyDevice(); e.useDb(); e.useRealAsa(); e.asa.set("db", e.db);
  e.server.session = { data: { session: null }, error: { message: "network (test)" } };
  await e.asa.ev("init()"); await settle(40);
  let rel3; const gate3 = new Promise((r) => { rel3 = r; });
  e.server.uid = "u2"; e.server.session = undefined;
  e.server.hooks.rest = (c) => (c.table === "trips" && c.op === "select" ? gate3.then(() => { e.server.hooks.rest = undefined; return { data: null, error: null }; }) : undefined);
  const s0 = e.server.rest("trips", "select").length, run3 = e.asa.ev('afterAuth({id:"u2",email:""})');
  for (let i = 0; i < 80 && e.server.rest("trips", "select").length === s0; i++) await settle(2);
  assert.ok(e.server.rest("trips", "select").length > s0, "precondition: owner check in flight");
  assert.equal(e.run('calNotes["2099-01-12"]="U2-IN-CHECK"; saveLS("cal",calNotes)'), false, "a write during the login form's owner check accepted");
  rel3(); await run3; await settle(60);
  assert.ok(!onDevice(e, "U2-IN-CHECK") && onDevice(e, "U1-UNSYNCED-NOTE"), "u2's note mixed into / over u1's copy");
});
test("R5.K2 (#19) offline new home search over trip 7's unsaved copy, storage nearly full: the split is refused (user told) and trip 7's note stays, offered on trip 7 (O03)", T, async () => {
  const a = tripOn(row());
  a.server.hooks.rpc = OFF; a.edit("cal", { "2099-01-11": "JAN-UNSYNCED" }); await a.run("TripSync.flush()"); await settle(); a.server.hooks.rpc = undefined;
  homeSaveTrip(a, { country: "nl", city: "Amsterdam", duration: null, durationDays: 3, startDate: "2099-03-20", endDate: "2099-03-22", approx: null, types: [] });
  const p = bootLike(a, { search: "?city=Amsterdam" }); p.useDb();
  const q = quota(p.storage); q.free(40);
  assert.equal(p.run('calNotes["2099-03-20"]="MART-NOTU"; saveLS("cal",calNotes)'), false, "the split was accepted without room for trip 7's copy");
  assert.ok(p.sb.__alerts.some((m) => /depolaması dolu/.test(m)), "user not told");
  q.off();
  assert.ok(onDevice(p, "JAN-UNSYNCED"), "trip 7's unsaved note dropped");
  const k = bootLike(p, { search: "?trip=7&city=Amsterdam" }); k.useDb(); await k.asa.ev("loadTripContext()"); await settle(60);
  assert.ok(k.val("TripSync.pending()").some((x) => JSON.stringify(x.cal).includes("JAN-UNSYNCED")), "not offered on trip 7: " + JSON.stringify(items(k)));
});
test("R5.K3 (#21) the stale tab's own 'Çıkış yap' (with / without the storage event) leaves u2's marker and note alone (WC1); its heart never writes u1's list onto u2's device (W24)", T, async () => {
  for (const withEvent of [true, false]) {
    const d = twoAccountsDev();
    const a = await page(d, "u1", "?trip=7&city=Amsterdam"), b = await page(a, "u1");
    await logout(b); await login(b, "u2", "?trip=9&city=Amsterdam");
    b.server.hooks.rpc = OFF; b.run('calNotes["2099-03-01"]="U2-UNSYNCED"; saveLS("cal",calNotes)'); await b.run("TripSync.flush()"); await settle(); b.server.hooks.rpc = undefined;
    const before = J(b.sync());
    assert.deepEqual(before.dirty, { trip_id: "9" }, "precondition");
    if (withEvent) allEv(a);
    await logout(a);
    const s = b.sync();
    assert.equal(s.owner, "u2", withEvent + ": owner"); assert.deepEqual(s.dirty, before.dirty, withEvent + ": u2's unsaved marker cleared by the stale tab"); assert.deepEqual(s.edit, before.edit, withEvent);
    const r = await page(b, "u2", "?trip=9&city=Amsterdam");
    assert.equal(r.val('calNotes["2099-03-01"]'), "U2-UNSYNCED", withEvent + ": u2's note left u2's screen: " + JSON.stringify(items(r)));
  }
  // the stale tab's logout leaves u2's device list / favourite marker alone
  { const d = twoAccountsDev(); d.server.tables.favorites.push({ user_id: "u2", venue_id: "c9", city: "Amsterdam" });
    const a = await page(d, "u1"), b = await page(a, "u1"); await logout(b); await login(b, "u2");
    const fav0 = b.storage.raw("asa:ams:fav"), fs0 = b.storage.raw("asa:ams:fav_sync");
    assert.ok(/c9/.test(fav0), "precondition: u2's list on the device");
    allEv(a); await logout(a);
    assert.equal(b.storage.raw("asa:ams:fav"), fav0, "the stale tab's logout emptied u2's device list"); assert.equal(b.storage.raw("asa:ams:fav_sync"), fs0); }
  // W24: no storage event yet; u2 logged in elsewhere (device list now u2's): the stale tab's heart
  const d = twoAccountsDev(); d.server.tables.favorites.push({ user_id: "u1", venue_id: "x1", city: "Amsterdam" }, { user_id: "u1", venue_id: "x2", city: "Amsterdam" });
  const t4 = await page(d, "u1");
  assert.ok(t4.run("favSet.has('x1')"), "precondition");
  t4.storage.setItem("asa_session", JSON.stringify({ uid: "u2", email: "", display_name: null }));
  t4.storage.setItem("asa:ams:fav", JSON.stringify(["c9"])); t4.storage.setItem("asa:ams:fav_sync", JSON.stringify({ v: 1, uid: "u2", base: "synced", ops: [] }));
  t4.server.uid = "u2";
  t4.run('toggleFav("p2")'); await settle();
  assert.equal(t4.storage.raw("asa:ams:fav"), '["c9"]', "u1's favourites written onto u2's device: " + t4.storage.raw("asa:ams:fav"));
  assert.deepEqual(t4.favSync().ops, [], "a stale-tab op queued");
  assert.ok(!t4.server.favIds("u2").includes("p2"), "the heart reached u2's account");
});
test("R5.K4 (#22) same tab: logout, then the next person's note (guest), then u2 logs in in that tab: the note is the guest's / u2's, never filed as u1's (G03)", T, async () => {
  const d = twoAccountsDev();
  const a = await page(d, "u1");
  await logout(a);
  a.run('calNotes["g1"]="GUEST-NOTE"; saveLS("cal",calNotes)');
  assert.equal((a.sync().edit || {}).uid || null, null, "the guest note filed as u1's: " + JSON.stringify(a.sync()));
  assert.equal(a.sync().owner || null, null);
  await login(a, "u2");
  assert.equal(a.val("calNotes.g1"), "GUEST-NOTE", "the note left the screen at u2's login");
  assert.ok(!items(a).some((x) => x.uid === "u1"), "the note kept as u1's version: " + JSON.stringify(items(a)));
});
test("R5.K5 (#28) 'Maps’te aç →' / '🗺️ Haritada rota': a stop name with an apostrophe gives a handler that compiles and opens the right place", T, async () => {
  const html = read("amsterdam/index.html");
  const c = vm.createContext({}); vm.runInContext(fnSrc(html, "function gmapsQ(s){") + "\n" + fnSrc(html, "function gmaps(v){") + "\n" + fnSrc(html, "function gmapsRoute(list){"), c);
  for (const name of ["Flo's Appetizing", "Bouillon d'Amsterdam", "Lotti's", "Brouwerij 't IJ"]) {
    const v = { name, area: "Centrum", city: "Amsterdam" };
    for (const url of [c.gmaps(v), c.gmapsRoute([v, { name: "Rijksmuseum", city: "Amsterdam" }])]) {
      assert.doesNotThrow(() => new Function("winopen", "winopen('" + url + "')"), name + ": the inline handler does not compile: " + url);
      let got = null; new Function("winopen", "winopen('" + url + "')")((u) => { got = u; });
      assert.ok(decodeURIComponent(got).includes(name), name + ": wrong place: " + got);
    }
  }
});
test("R5.F5 (#11/#4) pre-WP6 favourites that cannot be set aside (storage full / the list write fails): hidden, never overwritten by a visitor's heart, the visitor told", T, async () => {
  // (a) the set-aside record does not fit: the list stays in place, hidden; a heart is refused (no overwrite)
  const d = legacyDevice();
  quota(d.storage).free(0);
  const a = await page(d, null);
  assert.equal(a.run("favSet.size"), 0, "(a) the unconfirmed list shown");
  a.run('toggleFav("p2")'); await settle();
  assert.deepEqual(JSON.parse(a.storage.raw("asa:ams:fav")), SEEDS.concat(["x1", "x2", "p1"]), "(a) the hidden list overwritten by the visitor's heart: " + a.storage.raw("asa:ams:fav"));
  assert.ok(a.sb.__alerts.some((m) => /Listen güncellenemedi/.test(m) && !/favori/i.test(m)), "(a) visitor not told: " + JSON.stringify(a.sb.__alerts));
  // (b) the set-aside record was written but emptying the device list failed: the next page still hides it
  const e = legacyDevice();
  e.storage.failOn("asa:ams:fav");
  const b = await page(e, null);
  e.storage.allow("asa:ams:fav");
  assert.ok(e.favSync() && e.favSync().held, "precondition: set aside");
  const c = await page(b, null);
  assert.equal(c.run("favSet.has('x1')||favSet.has('p1')"), false, "(b) the next visitor sees u1's list: " + JSON.stringify(c.val("[...favSet]")));
  const r = await u1Back(c);
  assert.ok(r.p1, "(b) u1's device-only favourite lost: " + JSON.stringify(r.a.server.favIds("u1")));
});
