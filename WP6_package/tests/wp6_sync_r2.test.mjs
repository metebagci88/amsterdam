// WP6 · sync integrity, fixer round 2 (review findings on round 1). Same harness as wp6_sync_integrity.test.mjs:
// the city page's REAL code in a vm sandbox (./_page.mjs), fake Storage shared between "tabs" / reloads, fake Supabase.
//   Q1 storage nearly full: a kept copy that cannot be written to plan_sync never lets the local plan be overwritten
//   Q2 kept versions are never evicted silently; same-device tabs rebase instead of producing a conflict copy each edit
//   Q3 the "unsynced" marker survives a storage-full adopt / a failed restore until a durable copy exists
//   node --test WP6_package/tests/
// Test data only: user ids like "u1", trip ids 1..20, years 2099; no e-mail addresses, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, bootLike, settle, J } from "./_page.mjs";

const T = { timeout: 10000 };
const P0 = { "2099-01-10": ["barpif", "chun"], "2099-01-11": ["coba"] };
const P1 = { "2099-01-10": ["barpif", "chun", "x1"], "2099-01-11": ["coba"], "2099-01-12": ["pllek", "oeuf", "escobar"] };
const P2 = { "2099-01-10": ["chun"], "2099-01-11": ["coba", "x2"] };
const NOTE = "Anne Frank Evi bileti 14:30, rezervasyon kodu XY";
function row(o = {}) {
  return Object.assign({
    id: 7, revision: 5, user_id: "u1", city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12",
    timezone: "Europe/Amsterdam", setup_completed: true, archived_at: null, plan_version: 0,
    preferences: { vacation_types: ["Gastronomi"], plan_prefs: { saved: true, tempo: "Dengeli" } },
    plan: { dayven: J(P0), cal: {}, plan: {} },
  }, J(o));
}
const NEW8 = () => row({ id: 8, revision: 1, start_date: "2099-03-10", end_date: "2099-03-12", setup_completed: false, preferences: {}, plan: null });
function tripOn(r, opts = {}) { const h = boot(opts); if (!h.server.trip(r.id)) h.server.tables.trips.push(J(r)); h.useDb(); h.open(r); return h; }
function serverEdit(h, id, patch) { const r = h.server.trip(id); Object.assign(r, J(patch)); r.revision++; return J(r); }
async function reopen(h, id = 7) { const k = bootLike(h, { search: `?trip=${id}&city=Amsterdam` }); k.useDb(); await k.asa.ev("loadTripContext()"); await settle(); k.runTimers(); await settle(60); return k; }
const items = (h) => ((h.sync() || {}).items || []);
const OFF = (n) => (n === "trip_save" ? { data: { ok: false, reason: "net" }, error: null } : undefined);
const dump = (h) => JSON.stringify({ ls: h.storage.dump(), srv: h.server.tables.trips });
// storage nearly full (photos): only writes of values up to `max` characters succeed
function nearlyFull(storage, max = 120) {
  const real = storage.setItem.bind(storage);
  storage.setItem = (k, v) => { if (String(v).length > max) { const e = new Error("quota (test)"); e.name = "QuotaExceededError"; throw e; } return real(k, v); };
  return () => { storage.setItem = real; };
}
// trip 7 open, offline edit (calendar note) → save fails: the note is only on this device (dirty marker for trip 7)
async function offlineNote() {
  const h = tripOn(row());
  h.server.hooks.rpc = OFF;
  h.edit("cal", { "2099-01-11": NOTE });
  await h.run("TripSync.flush()"); await settle();
  h.server.hooks.rpc = undefined;
  assert.deepEqual(h.sync().dirty, { trip_id: "7" });
  return h;
}

// ================================================================================================ Q1 nearly full storage
test("Q1.1 offline edit for trip A + quota + open new trip B: A's edit stays on the device, B shown from memory, user told", T, async () => {
  const h = await offlineNote();
  const free = nearlyFull(h.storage);
  const k = bootLike(h); k.useDb();
  k.server.tables.trips.push(NEW8());
  assert.equal(k.open(NEW8()), false, "adopt reports that the DB plan was not written");
  assert.deepEqual(k.ls("cal"), { "2099-01-11": NOTE }, "the only durable copy (local plan) is not overwritten");
  assert.equal(k.ls("trip").id, 7, "the local trip stays trip 7 (its unsynced plan belongs to it)");
  assert.deepEqual(k.sync().dirty, { trip_id: "7" }, "the unsynced marker is kept");
  assert.equal(k.val("TripSync.blocked"), "8");
  assert.deepEqual(k.val("calNotes"), {}, "trip 8's (empty) DB plan is shown from memory");
  assert.deepEqual(k.val("CAL.days.map(d=>d.key)"), ["2099-03-10", "2099-03-11", "2099-03-12"], "calendar from trip 8's dates");
  const sn = k.storeNotice();
  assert.equal(sn.hidden, false);
  assert.ok(sn.text.includes("Cihaz depolaması dolu: bu cihazdaki kaydedilmemiş plan değişikliklerin ayrıca saklanamadı. Kaybolmasınlar diye bu cihazdaki plan değiştirilmedi"), sn.text);
  assert.equal(k.val("TripSync.status"), "error");
  // edits in this tab write nothing over trip 7's local plan and upload nothing
  k.run('calNotes["2099-03-10"]="B notu"; saveLS("cal",calNotes)');
  k.run('PSET._reload(); PSET.setDate("endDate","2099-03-13")');
  k.runTimers(); await settle();
  assert.deepEqual(k.ls("cal"), { "2099-01-11": NOTE });
  assert.equal(k.ls("trip").id, 7); assert.equal(k.ls("trip").end_date, "2099-01-12");
  assert.equal(k.saves().length, 1, "only the earlier failed offline save");
  assert.equal(k.server.trip(8).plan, null, "trip 8 untouched");
  // user frees space and reloads trip 7: the note reaches trip 7
  free();
  const m = await reopen(k, 7);
  assert.equal(m.server.trip(7).plan.cal["2099-01-11"], NOTE, "the offline note is saved to its own trip");
  assert.equal(m.server.trip(8).plan, null);
});
test("Q1.2 same setup, after freeing space trip B is reopened: A's edit is kept for trip A (plan_sync), not shown on B, not uploaded", T, async () => {
  const h = await offlineNote();
  const free = nearlyFull(h.storage);
  const k = bootLike(h); k.useDb(); k.server.tables.trips.push(NEW8()); k.open(NEW8());
  free();
  const m = await reopen(k, 8);
  assert.deepEqual(m.ls("cal"), {}, "trip 8 opened from the DB");
  const kept = items(m).find((x) => x.trip_id === "7");
  assert.ok(kept, "trip 7's unsynced plan is kept"); assert.equal(kept.cal["2099-01-11"], NOTE);
  assert.equal(m.notice().hidden, true, "not offered on trip 8");
  assert.ok(!JSON.stringify(m.server.trip(8)).includes("Anne Frank"), "never uploaded into trip 8");
  const a = await reopen(m, 7);
  assert.equal(a.notice().hidden, false, "offered on trip 7");
  a.el("tripSyncRestore").click(); await settle(60);
  assert.equal(a.server.trip(7).plan.cal["2099-01-11"], NOTE);
});
test("Q1.3 logout from a storage-full tab: memory is re-read from the device (the DB plan in memory is never written)", T, async () => {
  const h = await offlineNote();
  const free = nearlyFull(h.storage);
  const k = bootLike(h); k.useDb(); k.server.tables.trips.push(NEW8()); k.open(NEW8());
  k.run("TripSync.reset()");
  assert.equal(k.val("TripSync.blocked"), null);
  assert.deepEqual(k.val("calNotes"), { "2099-01-11": NOTE }, "memory = the device's plan again");
  free();
  k.run('calNotes["2099-01-12"]="misafir notu"; saveLS("cal",calNotes)');
  assert.deepEqual(k.ls("cal"), { "2099-01-11": NOTE, "2099-01-12": "misafir notu" }, "trip 7's note survives");
});

test("Q1.4 storage-full tab of trip B: restoring a version of B is refused while trip A's unsynced plan is held only on the device", T, async () => {
  const h = await offlineNote();
  const st = h.sync();
  st.items = [{ trip_id: "8", reason: "conflict", at: "2099-01-01T10:00:00.000Z", sig: "t8sig.1", start_date: "2099-03-10", end_date: "2099-03-12", dayven: { "2099-03-10": ["a"] }, cal: {}, plan: {}, plan_prefs: {} }];
  h.storage.setItem("asa:ams:plan_sync", JSON.stringify(st));
  const free = nearlyFull(h.storage);
  const k = bootLike(h); k.useDb(); k.server.tables.trips.push(NEW8()); k.open(NEW8());
  assert.equal(k.val("TripSync.blocked"), "8");
  assert.equal(k.notice().hidden, false, "trip 8's kept version is offered");
  k.sb.__alerts.length = 0;
  k.el("tripSyncRestore").click(); await settle();
  assert.ok(k.sb.__alerts.some((m) => m.includes("geri yüklenemedi: cihaz depolaması dolu")), JSON.stringify(k.sb.__alerts));
  assert.deepEqual(k.ls("cal"), { "2099-01-11": NOTE }, "trip 7's note is not overwritten by the restore");
  assert.deepEqual(k.ls("dayven"), P0);
  assert.equal(k.saves().length, 1, "nothing uploaded");
  free();
});

// ================================================================================================ Q2 no silent eviction / same-device tabs
test("Q2.1 kept versions are never evicted: one conflict copy + 6 two-tab clashes → all 7 kept, the user is told how many", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: { "2099-01-10": ["chun"] }, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  const conflict = J(items(h).find((x) => x.reason === "conflict"));
  assert.ok(conflict);
  for (let i = 0; i < 6; i++) {
    const cur = h.ls("cal") || {}; cur["2099-01-12"] = "diğer sekme notu " + i; h.storage.setItem("asa:ams:cal", JSON.stringify(cur));   // other tab wrote
    h.run(`calNotes["2099-01-12"]="bu sekme notu ${i}"; saveLS("cal",calNotes)`);
  }
  await settle();
  const left = items(h);
  assert.equal(left.length, 7, left.map((x) => x.reason).join(","));
  assert.ok(left.some((x) => x.reason === "conflict" && JSON.stringify(x.dayven) === JSON.stringify(conflict.dayven)), "the undecided conflict copy is still stored");
  for (let i = 0; i < 6; i++) assert.ok(left.some((x) => x.cal && x.cal["2099-01-12"] === "diğer sekme notu " + i), "clash " + i + " kept");
  const n = h.notice();
  assert.equal(n.el.getAttribute("data-count"), "7");
  assert.ok(n.text.includes("Bu seyahat için bu cihazda 7 plan sürümü bekliyor; en yenisi gösteriliyor. Hiçbiri kendiliğinden silinmez"), n.text);
});
test("Q2.2 two tabs on one trip, 6 alternating rounds: no conflict copies, every edit reaches the server", T, async () => {
  const t1 = tripOn(row());
  const t2 = bootLike(t1); t2.useDb(); t2.open(row());
  const ev = (t, ks) => ks.forEach((k) => t.fireStorage("asa:ams:" + k));
  const ALL = ["cal", "dayven", "plan", "plan_prefs", "trip", "plan_sync"];
  const E = [null, 'calNotes["2099-01-11"]="tab1 edit 1"; saveLS("cal",calNotes)', 'calNotes["2099-01-12"]="tab1 edit 2"; saveLS("cal",calNotes)',
    'calPlans["2099-01-11"]="tab1 edit 3"; saveLS("plan",calPlans)', 'calPlans["2099-01-12"]="tab1 edit 4"; saveLS("plan",calPlans)',
    'dayVenues["2099-01-12"]=["x3"]; saveLS("dayven",dayVenues)', 'dayVenues["2099-01-11"]=["coba","p1"]; saveLS("dayven",dayVenues)'];
  for (let i = 1; i <= 6; i++) {
    t2.run(`calNotes["2099-01-10"]="tab2 not ${i}"; saveLS("cal",calNotes)`); ev(t1, ["cal", "plan_sync"]);
    await t2.run("TripSync.flush()"); await settle(); ev(t1, ["plan_sync"]);
    t1.run(E[i]); ev(t2, ["cal", "plan", "dayven", "plan_sync"]);
    await t1.run("TripSync.flush()"); await settle(60); ev(t2, ALL);
  }
  assert.equal(items(t1).length, 0, JSON.stringify(items(t1).map((x) => x.reason)));
  assert.equal(t1.notice().hidden, true); assert.equal(t2.notice().hidden, true);
  const srv = t1.server.trip(7).plan;
  assert.deepEqual(srv.cal, { "2099-01-10": "tab2 not 6", "2099-01-11": "tab1 edit 1", "2099-01-12": "tab1 edit 2" });
  assert.deepEqual(srv.plan, { "2099-01-11": "tab1 edit 3", "2099-01-12": "tab1 edit 4" });
  assert.deepEqual(srv.dayven["2099-01-12"], ["x3"]); assert.deepEqual(srv.dayven["2099-01-11"], ["coba", "p1"]);
  assert.equal(t1.val("TripSync.status"), "saved");
});
test("Q2.3 another DEVICE saved after this device's other tab: still a real conflict (copy kept, server plan shown)", T, async () => {
  const t1 = tripOn(row());
  const t2 = bootLike(t1); t2.useDb(); t2.open(row());
  t2.run('calNotes["2099-01-10"]="tab2 notu"; saveLS("cal",calNotes)');
  await t2.run("TripSync.flush()"); await settle();                                            // rev 6 by this device
  serverEdit(t1, 7, { plan: { dayven: P2, cal: { "2099-01-10": "tab2 notu" }, plan: {} } });    // rev 7 by another device
  t1.run('calNotes["2099-01-11"]="tab1 notu"; saveLS("cal",calNotes)');
  await t1.run("TripSync.flush()"); await settle(60);
  assert.deepEqual(t1.server.trip(7).plan.dayven, P2, "the other device's plan is not overwritten");
  const it = items(t1).find((x) => x.reason === "conflict");
  assert.ok(it, "this device's version kept"); assert.equal(it.cal["2099-01-11"], "tab1 notu");
  assert.equal(t1.notice().reason, "conflict");
});
test("Q2.4 a kept version whose content is now on the server is pruned after a save", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  await h.run("TripSync.flush()"); await settle();
  assert.equal(items(h).length, 1);
  h.edit("dayven", P1);                                    // the user re-creates exactly that version by hand
  h.runTimers(); await settle(60);
  assert.deepEqual(h.server.trip(7).plan.dayven, P1);
  assert.equal(items(h).length, 0, "nothing undecided is left: the copy's content is on the server");
  assert.equal(h.notice().hidden, true);
});

// ================================================================================================ Q3 unsynced marker
test("Q3.1 storage-full adopt with an unsynced edit: marker kept; after freeing space the edit is kept and offered", T, async () => {
  const h = tripOn(row());
  h.server.hooks.rpc = OFF;
  h.edit("dayven", P1); await h.run("TripSync.flush()"); await settle();
  h.server.hooks.rpc = undefined;
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });                 // another device saves
  const k = bootLike(h);
  const real = k.storage.setItem.bind(k.storage);
  k.storage.setItem = (key, v) => { if (key === "asa:ams:dayven" || (key === "asa:ams:plan_sync" && String(v).length > 250)) { const e = new Error("quota (test)"); e.name = "QuotaExceededError"; throw e; } return real(key, v); };
  k.useDb(); k.open(J(k.server.trip(7)));
  assert.equal(k.val("TripSync.blocked"), "7");
  assert.deepEqual(k.sync().dirty, { trip_id: "7" }, "unsynced marker kept");
  assert.deepEqual(k.ls("dayven"), P1, "local plan not overwritten");
  assert.deepEqual(k.val("dayVenues"), P2, "server plan shown from memory");
  k.storage.setItem = real;
  const m = await reopen(k, 7);
  assert.deepEqual(m.ls("dayven"), P2, "after freeing space the DB plan is written");
  const kept = items(m).find((x) => x.trip_id === "7");
  assert.ok(kept, "the edit is kept"); assert.deepEqual(kept.dayven, P1);
  assert.equal(m.notice().hidden, false);
  assert.deepEqual(m.server.trip(7).plan.dayven, P2, "nothing uploaded without a choice");
  m.el("tripSyncRestore").click(); await settle(60);
  assert.deepEqual(m.server.trip(7).plan.dayven, P1);
});
test("Q3.2 a failed restore keeps the unsynced marker; reload keeps the version (nothing lost)", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  h.storage.failOn("asa:ams:plan_sync");
  await h.run("TripSync.flush()"); await settle();                                 // conflict, copy only in memory → local P1 kept
  h.storage.allow("asa:ams:plan_sync"); h.storage.failOn("asa:ams:dayven");          // now only the plan write fails
  h.sb.__alerts.length = 0;
  h.el("tripSyncRestore").click(); await settle();
  assert.ok(h.sb.__alerts.some((m) => m.includes("Bu cihazdaki sürüm geri yüklenemedi: cihaz depolaması dolu")), JSON.stringify(h.sb.__alerts));
  assert.deepEqual(h.sync().dirty, { trip_id: "7" }, "marker kept");
  assert.deepEqual(h.ls("dayven"), P1);
  assert.deepEqual(h.server.trip(7).plan.dayven, P2, "no upload");
  h.storage.allow("asa:ams:dayven");
  const m = await reopen(h, 7);
  const kept = items(m).find((x) => x.trip_id === "7");
  assert.ok(kept, "kept after reload"); assert.deepEqual(kept.dayven, P1);
  assert.equal(m.notice().hidden, false);
});
test("Q3.3 discarding the version held on a storage-full device writes the server plan once space allows", T, async () => {
  const h = tripOn(row());
  serverEdit(h, 7, { plan: { dayven: P2, cal: {}, plan: {} } });
  h.edit("dayven", P1);
  h.storage.failOn("asa:ams:plan_sync");
  await h.run("TripSync.flush()"); await settle();
  assert.deepEqual(h.ls("dayven"), P1);
  h.storage.allow("asa:ams:plan_sync");
  h.el("tripSyncDiscard").click(); await settle();
  assert.deepEqual(h.ls("dayven"), P2, "the user chose the server plan: it is written now");
  assert.equal(h.val("TripSync.blocked"), null);
  assert.equal(h.sync().dirty, null);
  assert.equal(items(h).length, 0);
  assert.ok(!dump(h).includes('"x1"'), "the discarded version is gone");
});
