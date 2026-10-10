// WP6 · sync integrity, fixer round 6: the favourites read at login fails (network blip / 5xx) while the login succeeds.
// Same harness as the other WP6 tests: the city page's REAL code in a vm sandbox (./_page.mjs), the real membership closure
// (init / afterAuth / logout), fake Storage shared between pages / accounts, fake Supabase with per-user RLS on favourites.
//   A  the account's hearts of that session never land in the device list without an owner: not shown to the next anonymous
//      visitor, not uploaded into the next account; the guest's list and its pending hearts are neither deleted nor re-tagged
//   B  a pre-WP6 list set aside for a trip comes back to its confirmed owner during such a login: not left on the device ownerless
//   C  the account's own device copy (owner marker = this account) and the owner-claim path (marker not yet written) keep working
//   D  a home-page logout on a pre-WP6 device never turns the device's un-uploaded guest hearts into an account copy that is then emptied
//   node --test WP6_package/tests/
// Test data only: user ids "u1"/"u2", trip id 7/9, year 2099, marker strings; no e-mail addresses, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { boot, bootLike, fakeStorage, read, settle, J } from "./_page.mjs";

const T = { timeout: 60000 };
const SEEDS = ["barpif", "shiraz", "chun", "pllek", "oeuf", "escobar", "coba"];
const FAIL = () => ({ data: null, error: { message: "upstream 503" } });
// only the FIRST favourites read of the session fails (the login's read); later requests work
function failFirstRead(s) { let n = 0; s.hooks.rest = (c) => (c.table === "favorites" && c.op === "select" && n++ === 0 ? FAIL() : undefined); }
// every favourites request fails (read and writes)
function failAllFavs(s) { s.hooks.rest = (c) => (c.table === "favorites" ? FAIL() : undefined); }
function accounts(d) { d.server.tables.favorites.push({ user_id: "u1", venue_id: "x2", city: "Amsterdam" }, { user_id: "u2", venue_id: "c9", city: "Amsterdam" }); }

// a page of the shared device with the real membership closure. who: "u1" | "u2" (session present → init() logs in) | null (no session)
async function page(prev, who, search = "?city=Amsterdam") {
  const h = prev ? bootLike(prev, { search }) : boot({ search });
  h.useDb(); h.useRealAsa(); h.asa.set("db", h.db);
  h.server.uid = who || h.server.uid;
  h.server.session = who ? undefined : { data: { session: null }, error: null };
  await h.asa.ev("init()"); await settle(60);
  return h;
}
async function login(h, who) { h.server.uid = who; h.server.session = undefined; await h.asa.ev(`afterAuth({id:${JSON.stringify(who)},email:""})`); await settle(60); }
async function logout(h) { await h.asa.ev("logout()"); await settle(60); }
const has = (h, ...ids) => h.run(`[${ids.map((i) => JSON.stringify(i)).join(",")}].some(function(i){ return favSet.has(i); })`);
const devList = (h) => J(h.storage.json("asa:ams:fav"));
const told = (h) => h.storeNotice().text;

// ================================================================================================ A  failed read, the session's hearts
test("R6.A1 (P1) fresh device, the login's favourites read fails: u1's hearts reach u1's account only — never the device list, the next anonymous visitor or u2", T, async () => {
  for (const variant of ["city-logout", "expiry", "city-form-login"]) {
    const d = boot(); accounts(d);
    const guest = d.storage.raw("asa:ams:fav");                        // the device's list before any login (seeds)
    failFirstRead(d.server);
    let a;
    if (variant === "city-form-login") { a = await page(d, null); await login(a, "u1"); } else a = await page(d, "u1");
    assert.equal(a.val("ASA.session&&ASA.session.uid"), "u1", variant + ": precondition: logged in");
    assert.equal(a.server.rest("favorites", "select").length, 1, variant + ": precondition: one (failed) favourites read");
    assert.ok(/Listen şu an yüklenemedi/.test(told(a)), variant + ": user not told: " + told(a));
    assert.ok(!/sunucu|favori/i.test(told(a)), variant + ": new copy uses technical / legacy words: " + told(a));
    a.run('toggleFav("x1"); toggleFav("p1")'); await settle(60);
    assert.deepEqual(a.server.favIds("u1"), ["p1", "x1", "x2"], variant + ": the session's hearts did not reach u1's account");
    assert.ok(a.run("favSet.has('x1')&&favSet.has('p1')"), variant + ": the session's hearts not shown in the session");
    assert.equal(a.storage.raw("asa:ams:fav"), guest, variant + ": u1's hearts written into the device list with no owner: " + a.storage.raw("asa:ams:fav") + " " + JSON.stringify(a.favSync()));
    assert.ok(!/"x1"|"p1"/.test(JSON.stringify(a.favSync() || {})), variant + ": a sent heart left queued on the device: " + JSON.stringify(a.favSync()));
    if (variant !== "expiry") {
      await logout(a);
      assert.equal(has(a, "x1", "p1", "x2"), false, variant + ": the same tab still shows u1's list after logout: " + JSON.stringify(a.val("[...favSet]")));
      assert.equal(a.storage.raw("asa:ams:fav"), guest, variant + ": the device's (guest) list deleted / changed at logout: " + a.storage.raw("asa:ams:fav"));
    }
    const n = await page(a, null);                                     // the next person on this device, anonymous (or u1's session expired)
    assert.equal(has(n, "x1", "p1", "x2"), false, variant + ": the anonymous visitor sees u1's hearts: " + JSON.stringify(n.val("[...favSet]")));
    const u2 = await page(n, "u2");
    assert.deepEqual(u2.server.favIds("u2"), ["c9"], variant + ": u1's hearts uploaded into u2's account");
    assert.equal(has(u2, "x1", "p1", "x2"), false, variant + ": u2 sees u1's hearts: " + JSON.stringify(u2.val("[...favSet]")));
    assert.deepEqual(u2.server.favIds("u1"), ["p1", "x1", "x2"], variant + ": u1's account changed");
  }
});
test("R6.A2 (P-1/P-2) the guest's list and pending hearts survive a failed-read session untouched: not deleted, not re-tagged to u1, not merged into u1", T, async () => {
  const d = boot(); accounts(d);
  d.run('toggleFav("x3")');                                            // a heart made while logged out (pending for the next login)
  const before = d.storage.raw("asa:ams:fav"), syncBefore = d.favSync();
  assert.ok(syncBefore.ops.some((o) => o.id === "x3" && o.uid === null), "precondition: guest heart pending");
  failFirstRead(d.server);
  const a = await page(d, "u1");
  a.run('toggleFav("x1")'); await settle(60);
  assert.ok(!a.server.favIds("u1").includes("x3"), "the guest's heart merged into u1 without a confirmed read");
  await logout(a);
  assert.equal(a.storage.raw("asa:ams:fav"), before, "the guest's list changed: " + a.storage.raw("asa:ams:fav"));
  const st = a.favSync();
  assert.equal(st.uid, null, "the device list re-tagged: " + JSON.stringify(st));
  assert.ok(st.ops.some((o) => o.id === "x3" && o.op === "add" && o.uid === null), "the guest's pending heart dropped / re-tagged: " + JSON.stringify(st));
  const n = await page(a, null);
  assert.ok(n.run("favSet.has('x3')"), "the guest's own heart gone for the guest");
  assert.equal(has(n, "x1"), false, "u1's heart shown to the guest");
});
test("R6.A3 (P1) device already used by an account (owner cleared at its logout): a failed-read session's heart is not shown to the next anonymous visitor", T, async () => {
  const d = boot({ storage: fakeStorage({ "asa:ams:fav": "[]", "asa:ams:fav_sync": JSON.stringify({ v: 1, uid: null, base: "synced", ops: [] }) }) }); accounts(d);
  failFirstRead(d.server);
  const a = await page(d, "u1");
  a.run('toggleFav("x1")'); await settle(60);
  assert.ok(a.server.favIds("u1").includes("x1"), "precondition: reached u1's account");
  assert.deepEqual(devList(a), [], "u1's heart on the device list with no owner");
  await logout(a);
  const n = await page(a, null);
  assert.equal(has(n, "x1", "x2"), false, "the anonymous visitor sees u1's heart");
  const u2 = await page(n, "u2");
  assert.deepEqual(u2.server.favIds("u2"), ["c9"]);
});
test("R6.A4 (P1/P-2) the account's writes fail too: the heart waits for u1 only (not the device list) — hidden from the next visitor and u2, sent at u1's next login", T, async () => {
  for (const variant of ["city-logout", "expiry"]) {
    const d = boot(); accounts(d);
    const guest = d.storage.raw("asa:ams:fav");
    failAllFavs(d.server);
    const a = await page(d, "u1");
    a.run('toggleFav("x1")'); await settle(60);
    assert.ok(!a.server.favIds("u1").includes("x1"), variant + ": precondition: the write failed");
    assert.ok(a.favSync().ops.some((o) => o.id === "x1" && o.op === "add" && o.uid === "u1"), variant + ": the heart not kept for u1: " + JSON.stringify(a.favSync()));
    assert.ok(!a.favSync().ops.some((o) => o.id === "x1" && o.uid === null), variant + ": the heart queued for whoever logs in next");
    assert.equal(a.storage.raw("asa:ams:fav"), guest, variant + ": u1's heart on the device list with no owner: " + a.storage.raw("asa:ams:fav"));
    d.server.hooks.rest = undefined;                                   // network back
    if (variant === "city-logout") await logout(a);
    const n = await page(a, null);
    assert.equal(has(n, "x1"), false, variant + ": the anonymous visitor sees u1's heart");
    const u2 = await page(n, "u2");
    assert.deepEqual(u2.server.favIds("u2"), ["c9"], variant + ": u1's heart uploaded into u2");
    assert.equal(has(u2, "x1"), false, variant);
    await logout(u2);
    const b = await page(u2, "u1");
    assert.ok(b.server.favIds("u1").includes("x1") && b.run("favSet.has('x1')"), variant + ": u1's heart lost: " + JSON.stringify(b.server.favIds("u1")) + " " + JSON.stringify(b.favSync()));
  }
});
test("R6.A5 the heart can be neither sent nor queued (storage full): reverted with a message, and the revert never writes the session's other hearts into the device list", T, async () => {
  const d = boot(); accounts(d);
  const guest = d.storage.raw("asa:ams:fav");
  failFirstRead(d.server);
  const a = await page(d, "u1");
  a.run('toggleFav("p1")'); await settle(60);                          // reaches u1's account
  assert.ok(a.server.favIds("u1").includes("p1"), "precondition");
  failAllFavs(d.server); a.storage.failOn("asa:ams:fav_sync");
  a.run('toggleFav("x1")'); await settle(60);
  assert.equal(has(a, "x1"), false, "a heart saved nowhere still shown");
  assert.ok(a.sb.__alerts.some((m) => /geri alındı/.test(m)), "user not told: " + JSON.stringify(a.sb.__alerts));
  assert.equal(a.storage.raw("asa:ams:fav"), guest, "the revert wrote the session's list into the device list: " + a.storage.raw("asa:ams:fav"));
  a.storage.allow("asa:ams:fav_sync"); d.server.hooks.rest = undefined;
  await logout(a);
  const n = await page(a, null);
  assert.equal(has(n, "p1", "x1"), false, "the anonymous visitor sees u1's hearts");
});

// ================================================================================================ B  a set-aside pre-WP6 list
// What the production page (origin/main) leaves on a device after u1 opened trip 7: the trip copy and the favourites list (u1's cloud
// x1/x2 + p1, hearted on this device only) — and NO fav_sync / plan_sync marker.
function legacyDevice() {
  const d = boot({ storage: fakeStorage({
    "asa:ams:fav": JSON.stringify(SEEDS.concat(["x1", "x2", "p1"])),
    "asa:ams:trip": JSON.stringify({ id: 7, revision: 5, city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12" }),
    "asa:ams:cal": JSON.stringify({ "2099-01-10": "U1-NOTE" }),
  }) });
  const row = (o) => Object.assign({ id: 7, revision: 5, user_id: "u1", city: "Amsterdam", country: "Hollanda", start_date: "2099-01-10", end_date: "2099-01-12",
    timezone: "Europe/Amsterdam", setup_completed: true, archived_at: null, plan_version: 0, preferences: { vacation_types: ["Gastronomi"] }, plan: { dayven: {}, cal: { "2099-01-10": "U1-NOTE" }, plan: {} } }, o);
  d.server.tables.trips.push(row({}), row({ id: 9, user_id: "u2", start_date: "2099-03-01", end_date: "2099-03-03", plan: null }));
  d.server.tables.favorites.push({ user_id: "u1", venue_id: "x1", city: "Amsterdam" }, { user_id: "u1", venue_id: "x2", city: "Amsterdam" }, { user_id: "u2", venue_id: "c9", city: "Amsterdam" });
  return d;
}
test("R6.B1 (P1) pre-WP6 list set aside for trip 7, u1 (its confirmed owner) logs in and the favourites read fails: the list is u1's for the session, never ownerless on the device; u1 keeps p1", T, async () => {
  for (const variant of ["city-logout", "expiry"]) {
    const d = legacyDevice();
    const n0 = await page(d, null);                                    // anonymous open: the list is set aside for trip 7
    assert.ok(n0.favSync() && n0.favSync().held, variant + ": precondition: set aside: " + JSON.stringify(n0.favSync()));
    failFirstRead(d.server);
    const a = await page(n0, "u1");
    assert.ok(a.run("favSet.has('p1')&&favSet.has('x1')"), variant + ": precondition: back for the confirmed owner: " + JSON.stringify(a.val("[...favSet]")));
    assert.ok(!/"x1"|"x2"|"p1"/.test(a.storage.raw("asa:ams:fav") || ""), variant + ": u1's list on the device list with no owner: " + a.storage.raw("asa:ams:fav") + " " + JSON.stringify(a.favSync()));
    if (variant === "city-logout") await logout(a);
    const n = await page(a, null);
    assert.equal(has(n, "x1", "x2", "p1"), false, variant + ": the anonymous visitor sees u1's list: " + JSON.stringify(n.val("[...favSet]")));
    const u2 = await page(n, "u2");
    assert.deepEqual(u2.server.favIds("u2"), ["c9"], variant + ": u1's list uploaded into u2");
    assert.equal(has(u2, "x1", "x2", "p1"), false, variant);
    await logout(u2);
    const b = await page(u2, "u1");                                     // network back
    assert.ok(b.server.favIds("u1").includes("p1"), variant + ": u1's device-only favourite lost: " + JSON.stringify(b.server.favIds("u1")) + " " + JSON.stringify(b.favSync()));
    assert.ok(b.run("favSet.has('p1')&&favSet.has('x1')"), variant);
    assert.ok(!SEEDS.some((s) => b.server.favIds("u1").includes(s)), variant + ": seed favourites uploaded");
  }
});

// ================================================================================================ C  the account's own device copy
test("R6.C1 the account's own device copy (owner marker = u1), its favourites read fails: hearts kept on that copy and in the account; cleared for the next visitor", T, async () => {
  const d = boot(); accounts(d);
  const a0 = await page(d, "u1");                                      // a normal login: the device list is u1's copy
  assert.equal(a0.favSync().uid, "u1", "precondition");
  failFirstRead(d.server);
  const a = await page(a0, "u1");                                      // reload, the read fails
  assert.ok(a.run("favSet.has('x2')"), "u1's own copy hidden from u1");
  a.run('toggleFav("x1")'); await settle(60);
  assert.ok(devList(a).includes("x1") && a.favSync().uid === "u1", "u1's own copy not kept up to date: " + a.storage.raw("asa:ams:fav") + " " + JSON.stringify(a.favSync()));
  assert.ok(a.server.favIds("u1").includes("x1"));
  const n = await page(a, null);                                       // expiry
  assert.equal(has(n, "x1", "x2"), false, "the anonymous visitor sees u1's copy");
});
test("R6.C2 first login while the owner marker cannot be written (storage full): once space is back, a heart writes the account's copy WITH its owner (claim path kept)", T, async () => {
  const d = boot({ storage: fakeStorage({ "asa:ams:fav": '["p1"]' }) }); accounts(d);
  d.storage.failOn("asa:ams:fav_sync");
  const a = await page(d, "u1");
  assert.ok(a.run("favSet.has('x2')"), "precondition: the account's list shown in the session");
  assert.deepEqual(devList(a), ["p1"], "precondition: not written ownerless");
  d.storage.allow("asa:ams:fav_sync");                                 // space is back
  a.run('toggleFav("x1")'); await settle(60);
  assert.equal((a.favSync() || {}).uid, "u1", "the owner not claimed: " + JSON.stringify(a.favSync()));
  assert.ok(devList(a).includes("x1") && devList(a).includes("x2"), "the account's copy not written: " + a.storage.raw("asa:ams:fav"));
  assert.ok(a.server.favIds("u1").includes("x1"));
  await logout(a);
  const n = await page(a, null);
  assert.equal(has(n, "x1", "x2", "p1"), false, "the anonymous visitor sees u1's list");
});

// ================================================================================================ D  home-page logout, pre-WP6 device
// the home page's real doLogout (index.html) on the same storage
async function homeLogout(storage, uid) {
  const src = read("index.html"), i = src.indexOf("async function doLogout(){"), body = src.slice(i, src.indexOf("\n}\n", i) + 2);
  const c = vm.createContext({ localStorage: storage, console }); c.window = c;
  vm.runInContext(read("lib/asa-storage/asa_storage.js"), c);
  vm.runInContext(`var loggingOut=false, session={uid:${JSON.stringify(uid)},email:"",display_name:null}, db={auth:{signOut:async function(){}}};
    function $(){ return null; } var ASA_DLG={close:function(){}}; function renderAcct(){} function renderAuthBody(){} function renderTripHub(){} function wp5Reset(){}
    ${body}`, c);
  await vm.runInContext("doLogout()", c); await settle();
}
test("R6.D1 (P1) pre-WP6 device: guest hearts never uploaded anywhere survive a home-page login/logout (by u1 or u2), the anonymous page and the next city login", T, async () => {
  const SEARCH = { country: "Hollanda", city: "Amsterdam", start_date: "2099-05-01", end_date: "2099-05-03", vacation_types: [] };
  for (const v of [{ name: "no-trip", homeUid: "u1", loginAs: "u1" }, { name: "id-less search", homeUid: "u1", loginAs: "u1", trip: SEARCH },
                   { name: "household", homeUid: "u2", loginAs: "u1" }, { name: "same account, no anonymous visit", homeUid: "u1", loginAs: "u1", direct: true }]) {
    const init = { "asa:ams:fav": JSON.stringify(SEEDS.concat(["p1", "p2"])) };   // production guest hearts: device only, no fav_sync / plan_sync
    if (v.trip) init["asa:ams:trip"] = JSON.stringify(v.trip);
    const storage = fakeStorage(init);
    await homeLogout(storage, v.homeUid);
    const d = boot({ storage }); accounts(d);
    let h = d;
    if (!v.direct) {
      h = await page(d, null);
      assert.ok(J(h.storage.raw("asa:ams:fav")).includes("p1"), v.name + ": the guest hearts deleted from the device by the anonymous page: " + h.storage.raw("asa:ams:fav"));
    }
    h = await page(h, v.loginAs);
    const where = h.server.favIds(v.loginAs).concat(J(h.storage.raw("asa:ams:fav")) || []);
    assert.ok(where.includes("p1") && where.includes("p2"), v.name + ": the guest hearts exist nowhere any more: server " + JSON.stringify(h.server.favIds(v.loginAs)) + " device " + h.storage.raw("asa:ams:fav"));
  }
});
