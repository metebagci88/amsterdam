// WP3 · node unit tests for the wired storage helpers (lib/asa-storage/asa_storage.js).
// Lifecycle scenarios as the live pages run them: page load = reconcile(storage, "ams"),
// page edits = set(), homepage trip = reconcile(code) + set(code, "trip").
//   node --test WP3_package/tests/wp3_unit.test.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

const require = createRequire(import.meta.url);
const asa = require("../../lib/asa-storage/asa_storage.js");

function mem(seed) {
  const data = Object.assign({}, seed);
  const calls = { set: [], remove: [], clear: 0 };
  return {
    calls,
    dump: () => Object.assign({}, data),
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { calls.set.push(k); data[k] = String(v); },
    removeItem: (k) => { calls.remove.push(k); delete data[k]; },
    clear: () => { calls.clear += 1; }
  };
}
const trip = (city, s = "2026-11-02") => JSON.stringify({ city, start_date: s, end_date: s, duration_days: 1 });
const pageLoad = (s, n) => asa.reconcile(s, "ams", { now: `2026-10-0${n}T09:00:00.000Z` });
const LEGACY = {
  ams_fav: '["barpif","chun"]',
  ams_cal: '{"2026-11-02":"not"}',
  ams_plan: '{"2026-11-02":"Sabah: kahve"}',
  ams_dayven: '{"2026-11-02":["barpif"]}',
  ams_calphoto: '{"2026-11-02":["data:image/gif;base64,AAAA"]}',
  asa_trip: trip("Amsterdam"),
  asa_plan_prefs: '{"tempo":"Sakin"}'
};

test("lifecycle: legacy user → migrate → edits → reloads: one copy, no conflict, legacy intact", () => {
  const s = mem(Object.assign({ asa_session: '{"uid":"x"}' }, LEGACY));
  const r1 = pageLoad(s, 1);
  assert.equal(r1.verified, true);
  assert.equal(r1.conflicts.length, 0);
  for (const [k, v] of Object.entries(LEGACY)) assert.equal(s.getItem(k), v, k + " kept");
  assert.equal(asa.set(s, "ams", "fav", ["chun", "winkel43"]).ok, true);
  assert.equal(asa.set(s, "ams", "cal", { "2026-11-02": "değişti" }).ok, true);
  const writes = s.calls.set.length;
  const r2 = pageLoad(s, 2);
  const r3 = pageLoad(s, 3);
  assert.equal(r2.conflicts.length + r3.conflicts.length, 0);
  assert.equal(s.calls.set.length, writes, "reloads write nothing");
  assert.equal(r3.verified, true, "legacy unchanged since a verified copy → retirement precondition holds");
  assert.deepEqual(asa.get(s, "ams", "fav").value, ["chun", "winkel43"]);
  for (const [k, v] of Object.entries(LEGACY)) assert.equal(s.getItem(k), v, k + " still kept");
  assert.equal(s.getItem("asa_session"), '{"uid":"x"}');
  assert.deepEqual(s.calls.remove, []);
  assert.equal(s.calls.clear, 0);
});

test("lifecycle: homepage replaces the Amsterdam trip without a false conflict", () => {
  const s = mem({ asa_trip: trip("Amsterdam", "2026-09-01") });
  // homepage: reconcile the target city first, then write the new trip (Trip Policy A)
  asa.reconcile(s, "ams", { now: "2026-10-01T09:00:00.000Z" });
  assert.equal(asa.set(s, "ams", "trip", JSON.parse(trip("Amsterdam", "2026-11-20"))).ok, true);
  const r = pageLoad(s, 2);
  assert.deepEqual(r.conflicts, []);
  assert.equal(asa.get(s, "ams", "trip").value.start_date, "2026-11-20");
  assert.equal(s.getItem("asa_trip"), trip("Amsterdam", "2026-09-01"));
});

test("lifecycle: without the homepage reconcile the same write WOULD be a conflict (guards the wiring order)", () => {
  const s = mem({ asa_trip: trip("Amsterdam", "2026-09-01") });
  asa.set(s, "ams", "trip", JSON.parse(trip("Amsterdam", "2026-11-20")));
  const r = pageLoad(s, 2);
  assert.deepEqual(r.conflicts.map((c) => c.domain), ["trip"]);
  assert.equal(asa.get(s, "ams", "trip").value.start_date, "2026-11-20", "new stays authoritative");
});

// homepage saveTrip(): ams → reconcile + set; cph → set only (no live cph migration before Kopenhag launches)
const homepage = (s, code, t) => { if (code === "ams") asa.reconcile(s, code, { now: "2026-10-02T09:00:00.000Z" }); return asa.set(s, code, "trip", JSON.parse(t)); };

test("lifecycle: homepage Kopenhag trip lands in cph only and never shows on ams", () => {
  const s = mem({ asa_trip: trip("Amsterdam"), ams_fav: '["chun"]' });
  pageLoad(s, 1);
  homepage(s, "cph", trip("Kopenhag", "2026-12-01"));
  const r = pageLoad(s, 3);
  assert.equal(r.mismatch, null);
  assert.equal(asa.get(s, "ams", "trip").value.city, "Amsterdam");
  assert.equal(asa.get(s, "cph", "trip").value.city, "Kopenhag");
  assert.equal(asa.get(s, "cph", "fav").source, "missing");
  assert.equal(s.getItem("asa:cph:_migrated"), null, "no cph migration/marker before launch");
  assert.deepEqual(Object.keys(s.dump()).filter((k) => k.startsWith("asa:cph:")), ["asa:cph:trip"]);
});

test("lifecycle (review #1): Kopenhag legacy trip + Amsterdam prefs → homepage Kopenhag → homepage Amsterdam → prefs offered, adopted on request, cph never gets them", () => {
  const prefs = '{"tempo":"Sakin","mustSee":["barpif"],"accommodation":{"lat":52.37,"lng":4.89,"label":"Jordaan"},"saved":true}';
  const s = mem({ asa_trip: trip("Kopenhag", "2026-12-01"), asa_plan_prefs: prefs });
  const r1 = pageLoad(s, 1);
  assert.equal(r1.mismatch.otherCityCode, "cph");
  assert.equal(r1.stranded.length, 1, "Amsterdam page load: prefs reported, not silently hidden");
  homepage(s, "cph", trip("Kopenhag", "2026-12-05"));
  assert.equal(s.getItem("asa:cph:plan_prefs"), null, "homepage Kopenhag click copies no Amsterdam prefs into cph");
  homepage(s, "ams", trip("Amsterdam", "2026-11-20"));
  const r2 = pageLoad(s, 3);
  assert.equal(r2.mismatch, null);
  assert.equal(r2.stranded.length, 1, "still offered after an own Amsterdam trip exists");
  assert.equal(asa.get(s, "ams", "plan_prefs").source, "missing", "nothing copied without the user");
  assert.equal(asa.adoptLegacy(s, "ams", "plan_prefs").ok, true);
  assert.deepEqual(asa.get(s, "ams", "plan_prefs").value.accommodation, { lat: 52.37, lng: 4.89, label: "Jordaan" });
  const r3 = pageLoad(s, 4);
  assert.deepEqual(r3.stranded, []);
  assert.deepEqual(r3.conflicts, []);
  assert.equal(s.getItem("asa:cph:plan_prefs"), null);
  assert.equal(s.getItem("asa_plan_prefs"), prefs);
  assert.equal(s.getItem("asa_trip"), trip("Kopenhag", "2026-12-01"));
  assert.deepEqual(s.calls.remove, []);
});

test("lifecycle (review #2/#3): large photo legacy is not duplicated at load; edits write the new key once", () => {
  const photos = JSON.stringify({ "2026-11-02": ["data:image/jpeg;base64," + "B".repeat(asa.LARGE_COPY_CHARS)] });
  const s = mem({ ams_calphoto: photos, asa_trip: trip("Amsterdam") });
  const r1 = pageLoad(s, 1);
  assert.equal(r1.marker.keys.ams_calphoto.state, "deferred");
  assert.equal(s.getItem("asa:ams:calphoto"), null);
  assert.equal(asa.get(s, "ams", "calphoto").source, "legacy");
  assert.equal(asa.set(s, "ams", "calphoto", { "2026-11-02": [] }).ok, true);
  assert.equal(pageLoad(s, 2).marker.keys.ams_calphoto.state, "superseded");
  assert.deepEqual(asa.get(s, "ams", "calphoto").value, { "2026-11-02": [] });
  assert.equal(s.getItem("ams_calphoto"), photos);
});

test("lifecycle: old tab writes legacy after migration → conflict → acknowledge → quiet until next change", () => {
  const s = mem({ ams_dayven: '{"g1":["a"]}' });
  pageLoad(s, 1);
  s.setItem("ams_dayven", '{"g1":["a","b"]}');
  const r = pageLoad(s, 2);
  assert.deepEqual(r.conflicts.map((c) => c.legacyKey), ["ams_dayven"]);
  assert.deepEqual(asa.get(s, "ams", "dayven").value, { g1: ["a"] });
  asa.acknowledge(s, "ams", { conflicts: true });
  assert.deepEqual(pageLoad(s, 3).conflicts, []);
  s.setItem("ams_dayven", '{"g1":["c"]}');
  assert.equal(pageLoad(s, 4).conflicts.length, 1);
  assert.equal(s.getItem("ams_dayven"), '{"g1":["c"]}');
  assert.equal(s.getItem("asa:ams:dayven"), '{"g1":["a"]}');
});

test("favorite seed precondition: present means new OR legacy key exists (any form)", () => {
  const present = (seed) => asa.get(mem(seed), "ams", "fav").source !== "missing";
  assert.equal(present({}), false);
  assert.equal(present({ ams_fav: "[]" }), true);
  assert.equal(present({ ams_fav: "{bad" }), true, "corrupt legacy still blocks the seed");
  assert.equal(present({ "asa:ams:fav": "[]" }), true);
  assert.equal(present({ "asa:cph:fav": '["x"]' }), false, "cph favorites never count for ams");
});

test("rollback safety: after migration every legacy key still holds its original bytes", () => {
  const s = mem(LEGACY);
  pageLoad(s, 1);
  asa.set(s, "ams", "fav", []);
  asa.set(s, "ams", "trip", { city: "Amsterdam", start_date: "2027-01-01", end_date: "2027-01-02" });
  pageLoad(s, 2);
  for (const [k, v] of Object.entries(LEGACY)) assert.equal(s.getItem(k), v, k);
  for (const k of Object.keys(LEGACY)) assert.equal(asa.isLegacyCopyVerified(s, k).reason === "absent", false, k);
});

test("library refuses non-city keys and never exposes a delete-legacy API", () => {
  const s = mem({});
  for (const bad of ["asa_session", "sb-x-auth-token", "_migrated", "custom"]) assert.throws(() => asa.set(s, "ams", bad, {}), /invalid_domain/);
  for (const name of ["retireLegacy", "deleteLegacy", "removeLegacy"]) assert.equal(asa[name], undefined);
});
