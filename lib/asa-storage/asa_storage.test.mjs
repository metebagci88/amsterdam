import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const require = createRequire(import.meta.url);
const asa = require("./asa_storage.js");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(repo, rel), "utf8");

const DOMAINS = ["trip", "plan_prefs", "fav", "cal", "plan", "dayven", "calphoto"];
const LEGACY = {
  trip: "asa_trip",
  plan_prefs: "asa_plan_prefs",
  fav: "ams_fav",
  cal: "ams_cal",
  plan: "ams_plan",
  dayven: "ams_dayven",
  calphoto: "ams_calphoto"
};

function mem(seed) {
  const data = Object.assign({}, seed);
  const calls = { clear: 0, remove: [], set: [] };
  return {
    calls,
    dump() { return Object.assign({}, data); },
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { calls.set.push(k); data[k] = String(v); },
    removeItem(k) { calls.remove.push(k); delete data[k]; },
    clear() { calls.clear += 1; }
  };
}

function trip(city) {
  return JSON.stringify({ country: "x", city: city, duration_days: 3, start_date: "2026-10-10", end_date: "2026-10-12" });
}

test("module is an inert v1 policy-A registry", () => {
  assert.equal(asa.INERT, true);
  assert.equal(asa.WIRED, false);
  assert.equal(asa.MIGRATION_VERSION, 1);
  assert.equal(asa.TRIP_POLICY, "A");
  assert.deepEqual(asa.CITY_CODES, ["ams", "cph"]);
  assert.deepEqual(asa.DOMAIN_NAMES, DOMAINS);
});

test("key builders cover every domain for ams and cph", () => {
  for (const city of ["ams", "cph"]) {
    const rows = asa.keysFor(city);
    assert.equal(rows.length, DOMAINS.length);
    for (const domain of DOMAINS) {
      assert.equal(asa.key(city, domain), `asa:${city}:${domain}`);
    }
    assert.deepEqual(rows.map((r) => r.key), DOMAINS.map((d) => `asa:${city}:${d}`));
  }
  assert.equal(asa.describeDomain("fav").legacyKey, "ams_fav");
  assert.equal(asa.describeDomain("fav").legacyMap, "ams-only");
  assert.equal(asa.describeDomain("trip").legacyMap, "trip-city");
  assert.equal(asa.describeDomain("plan_prefs").legacyMap, "follow-trip");
});

test("city codes reject dk-cph, shared, and display names", () => {
  for (const bad of ["dk-cph", "shared", "Amsterdam", "Kopenhag", "copenhagen", "", "ams:trip"]) {
    assert.throws(() => asa.key(bad, "trip"), /invalid_city/);
    assert.throws(() => asa.keysFor(bad), /invalid_city/);
  }
  assert.throws(() => asa.key("ams", "session"), /invalid_domain/);
  assert.throws(() => asa.key("ams", "asa_session"), /invalid_domain/);
});

test("city labels map known names and leave dk-cph unknown", () => {
  assert.equal(asa.cityCodeFromLabel("Amsterdam"), "ams");
  assert.equal(asa.cityCodeFromLabel("  amsterdam "), "ams");
  assert.equal(asa.cityCodeFromLabel("ams"), "ams");
  assert.equal(asa.cityCodeFromLabel("Kopenhag"), "cph");
  assert.equal(asa.cityCodeFromLabel("Copenhagen"), "cph");
  assert.equal(asa.cityCodeFromLabel("København"), "cph");
  assert.equal(asa.cityCodeFromLabel("kobenhavn"), "cph");
  assert.equal(asa.cityCodeFromLabel("cph"), "cph");
  assert.equal(asa.cityCodeFromLabel("dk-cph"), null);
  assert.equal(asa.cityCodeFromLabel("Paris"), null);
  assert.equal(asa.cityCodeFromLabel(""), null);
  assert.equal(asa.cityCodeFromLabel(null), null);
});

test("protected keys are the shared auth, admin, consent, and supabase token keys", () => {
  assert.equal(asa.isProtectedKey("asa_session"), true);
  assert.equal(asa.isProtectedKey("asa-admin-auth"), true);
  assert.equal(asa.isProtectedKey("asa_cookie_decision_v2"), true);
  assert.equal(asa.isAuthTokenKey("sb-abcdefghijklmnopqrst-auth-token"), true);
  assert.equal(asa.isProtectedKey("sb-abc123-auth-token-code-verifier"), true);
  assert.equal(asa.isProtectedKey("sb-auth-token"), false);
  assert.equal(asa.isProtectedKey("ams_fav"), false);
  assert.equal(asa.isProtectedKey("asa:ams:fav"), false);
});

test("get prefers the new key and does not write", () => {
  const s = mem({
    "asa:ams:fav": JSON.stringify(["new"]),
    ams_fav: JSON.stringify(["old"])
  });
  const got = asa.get(s, "ams", "fav");
  assert.equal(got.ok, true);
  assert.equal(got.source, "city");
  assert.deepEqual(got.value, ["new"]);
  assert.deepEqual(s.calls.set, []);
  assert.deepEqual(s.calls.remove, []);
});

test("get falls back to legacy only for the owning city", () => {
  const s = mem({
    ams_fav: JSON.stringify(["barpif"]),
    ams_cal: JSON.stringify({ "2026-10-10": "note" }),
    asa_trip: trip("Amsterdam"),
    asa_plan_prefs: JSON.stringify({ tempo: "slow" })
  });
  assert.equal(asa.get(s, "ams", "fav").source, "legacy");
  assert.deepEqual(asa.get(s, "ams", "fav").value, ["barpif"]);
  assert.equal(asa.get(s, "cph", "fav").source, "missing");
  assert.equal(asa.get(s, "cph", "fav").value, null);
  assert.equal(asa.get(s, "ams", "cal").source, "legacy");
  assert.equal(asa.get(s, "cph", "cal").source, "missing");
  assert.equal(asa.get(s, "ams", "trip").source, "legacy");
  assert.equal(asa.get(s, "cph", "trip").source, "missing");
  assert.equal(asa.get(s, "ams", "plan_prefs").source, "legacy");
  assert.equal(asa.get(s, "cph", "plan_prefs").source, "missing");
  assert.deepEqual(s.calls.set, []);
});

test("cph legacy fallback follows a Kopenhag or Copenhagen trip only", () => {
  const prefs = JSON.stringify({ tempo: "walk" });
  for (const label of ["Kopenhag", "Copenhagen", "København"]) {
    const s = mem({ asa_trip: trip(label), asa_plan_prefs: prefs, ams_fav: JSON.stringify(["barpif"]) });
    assert.equal(asa.get(s, "cph", "trip").source, "legacy");
    assert.equal(asa.get(s, "cph", "trip").value.city, label);
    assert.equal(asa.get(s, "ams", "trip").source, "missing");
    assert.equal(asa.get(s, "cph", "plan_prefs").source, "legacy");
    assert.equal(asa.get(s, "ams", "plan_prefs").source, "missing");
    assert.equal(asa.get(s, "cph", "fav").source, "missing");
    assert.equal(asa.get(s, "ams", "fav").source, "legacy");
  }
});

test("corrupt new key blocks legacy fallback and is not overwritten by get", () => {
  const s = mem({ "asa:ams:fav": "{", ams_fav: JSON.stringify(["barpif"]) });
  const got = asa.get(s, "ams", "fav");
  assert.equal(got.ok, false);
  assert.equal(got.source, "corrupt");
  assert.equal(got.corrupt, true);
  assert.equal(s.getItem("asa:ams:fav"), "{");
  assert.equal(s.getItem("ams_fav"), JSON.stringify(["barpif"]));
  assert.deepEqual(s.calls.remove, []);
});

test("corrupt legacy is surfaced for the owning city and never deleted", () => {
  const s = mem({ ams_fav: "{not-json", asa_trip: "[]", asa_plan_prefs: JSON.stringify({ tempo: "slow" }) });
  const fav = asa.get(s, "ams", "fav");
  assert.equal(fav.source, "corrupt");
  assert.equal(asa.get(s, "cph", "fav").source, "missing");
  assert.equal(asa.get(s, "ams", "trip").source, "corrupt");
  assert.equal(asa.get(s, "cph", "trip").source, "missing");
  assert.equal(s.getItem("ams_fav"), "{not-json");
  assert.equal(s.getItem("asa_trip"), "[]");
  assert.deepEqual(s.calls.remove, []);
  assert.equal(s.calls.clear, 0);
});

test("unknown trip city is readable only as ams and reports the default", () => {
  const s = mem({ asa_trip: trip("Paris") });
  const ams = asa.get(s, "ams", "trip");
  assert.equal(ams.source, "legacy");
  assert.equal(ams.warning, "unknown_city_default_ams");
  assert.equal(asa.get(s, "cph", "trip").source, "missing");
  const missingCity = mem({ asa_trip: JSON.stringify({ duration_days: 2 }) });
  assert.equal(asa.get(missingCity, "ams", "trip").warning, "trip_city_missing_default_ams");
});

test("set writes only the new key", () => {
  const s = mem({ ams_fav: JSON.stringify(["old"]), asa_session: "{\"uid\":\"user-1\"}" });
  const wrote = asa.set(s, "cph", "fav", ["nyhavn"]);
  assert.equal(wrote.ok, true);
  assert.equal(wrote.key, "asa:cph:fav");
  assert.equal(wrote.wroteLegacy, false);
  assert.equal(s.getItem("asa:cph:fav"), JSON.stringify(["nyhavn"]));
  assert.equal(s.getItem("ams_fav"), JSON.stringify(["old"]));
  assert.equal(s.getItem("asa:ams:fav"), null);
  assert.equal(s.getItem("asa_session"), "{\"uid\":\"user-1\"}");
  assert.deepEqual(s.calls.set, ["asa:cph:fav"]);
});

test("set rejects the wrong shape and writes nothing", () => {
  const s = mem({ ams_fav: JSON.stringify(["old"]) });
  for (const bad of ["barpif", { id: "x" }, [1], ["ok", 2], null]) {
    const res = asa.set(s, "ams", "fav", bad);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "invalid_shape");
  }
  assert.equal(asa.set(s, "ams", "cal", ["nope"]).ok, false);
  assert.equal(asa.set(s, "ams", "plan_prefs", []).ok, false);
  assert.equal(s.getItem("asa:ams:fav"), null);
  assert.equal(s.getItem("ams_fav"), JSON.stringify(["old"]));
  assert.deepEqual(s.calls.set, []);
});

test("set round-trips per city without touching the other city", () => {
  const s = mem({});
  assert.equal(asa.set(s, "ams", "trip", { city: "Amsterdam", duration_days: 2 }).ok, true);
  assert.equal(asa.set(s, "cph", "trip", { city: "Kopenhag", duration_days: 4 }).ok, true);
  assert.equal(asa.set(s, "ams", "fav", []).ok, true);
  assert.equal(asa.set(s, "cph", "dayven", { "2026-10-11": ["a"] }).ok, true);
  assert.equal(asa.get(s, "ams", "trip").value.city, "Amsterdam");
  assert.equal(asa.get(s, "cph", "trip").value.city, "Kopenhag");
  assert.deepEqual(asa.get(s, "ams", "fav").value, []);
  assert.equal(asa.get(s, "cph", "fav").source, "missing");
  assert.deepEqual(asa.get(s, "cph", "dayven").value, { "2026-10-11": ["a"] });
  assert.equal(s.getItem("asa_trip"), null);
  assert.equal(s.getItem("ams_dayven"), null);
});

test("empty favorite array is valid data", () => {
  const s = mem({ ams_fav: "[]" });
  assert.deepEqual(asa.get(s, "ams", "fav").value, []);
  const report = asa.migrate(s);
  assert.equal(report.actions.find((a) => a.domain === "fav").status, "copied");
  assert.equal(s.getItem("asa:ams:fav"), "[]");
  assert.equal(s.getItem("ams_fav"), "[]");
});

test("migrate copies ams_* only onto asa:ams and keeps legacy bytes", () => {
  const fav = '["barpif","chun"]';
  const cal = '{"2026-10-10":"note"}';
  const plan = '{"d1":"walk"}';
  const dayven = '{"d1":["barpif"]}';
  const photo = '{"d1":["data:image/gif;base64,AAAA"]}';
  const s = mem({
    ams_fav: fav,
    ams_cal: cal,
    ams_plan: plan,
    ams_dayven: dayven,
    ams_calphoto: photo,
    asa_trip: trip("Kopenhag"),
    asa_plan_prefs: JSON.stringify({ tempo: "slow" })
  });
  const report = asa.migrate(s);
  assert.equal(report.migrationVersion, 1);
  assert.equal(report.tripPolicy, "A");
  assert.deepEqual(report.legacyKeysDeleted, []);
  assert.equal(s.getItem("asa:ams:fav"), fav);
  assert.equal(s.getItem("asa:ams:cal"), cal);
  assert.equal(s.getItem("asa:ams:plan"), plan);
  assert.equal(s.getItem("asa:ams:dayven"), dayven);
  assert.equal(s.getItem("asa:ams:calphoto"), photo);
  assert.equal(s.getItem("asa:cph:fav"), null);
  assert.equal(s.getItem("asa:cph:cal"), null);
  assert.equal(s.getItem("asa:cph:plan"), null);
  assert.equal(s.getItem("asa:cph:dayven"), null);
  assert.equal(s.getItem("asa:cph:calphoto"), null);
  assert.equal(s.getItem("ams_fav"), fav);
  assert.equal(s.getItem("asa:cph:trip"), trip("Kopenhag"));
  assert.equal(s.getItem("asa:ams:trip"), null);
  assert.equal(s.getItem("asa:cph:plan_prefs"), JSON.stringify({ tempo: "slow" }));
  assert.equal(s.getItem("asa:ams:plan_prefs"), null);
  assert.equal(s.calls.clear, 0);
  assert.deepEqual(s.calls.remove, []);
  for (const domain of ["fav", "cal", "plan", "dayven", "calphoto"]) {
    assert.equal(report.actions.find((a) => a.domain === domain).status, "copied");
    assert.equal(report.actions.find((a) => a.domain === domain).cityCode, "ams");
  }
});

test("migrate places Amsterdam and default trips on ams only", () => {
  const amsterdam = mem({ asa_trip: trip("Amsterdam"), asa_plan_prefs: "{\"saved\":true}" });
  const a = asa.migrate(amsterdam);
  assert.equal(a.actions.find((x) => x.domain === "trip").key, "asa:ams:trip");
  assert.equal(a.actions.find((x) => x.domain === "plan_prefs").key, "asa:ams:plan_prefs");
  assert.equal(amsterdam.getItem("asa:cph:trip"), null);

  const unknown = mem({ asa_trip: trip("Rotterdam"), asa_plan_prefs: "{\"saved\":true}" });
  const u = asa.migrate(unknown);
  assert.equal(u.actions.find((x) => x.domain === "trip").status, "copied");
  assert.equal(u.actions.find((x) => x.domain === "trip").warning, "unknown_city_default_ams");
  assert.equal(u.actions.find((x) => x.domain === "trip").cityLabel, "Rotterdam");
  assert.equal(unknown.getItem("asa:ams:trip"), trip("Rotterdam"));
  assert.equal(unknown.getItem("asa:cph:trip"), null);
  assert.equal(u.actions.find((x) => x.domain === "plan_prefs").key, "asa:ams:plan_prefs");

  const bare = mem({ asa_trip: "{}", asa_plan_prefs: "{\"saved\":false}" });
  const b = asa.migrate(bare);
  assert.equal(b.actions.find((x) => x.domain === "trip").warning, "trip_city_missing_default_ams");
  assert.equal(bare.getItem("asa:ams:trip"), "{}");
  assert.equal(bare.getItem("asa:cph:plan_prefs"), null);
});

test("plan_prefs without a trip default to ams and do not invent a trip", () => {
  const s = mem({ asa_plan_prefs: "{\"tempo\":\"slow\"}" });
  const report = asa.migrate(s);
  assert.equal(report.actions.find((a) => a.domain === "trip").status, "absent");
  assert.equal(report.actions.find((a) => a.domain === "plan_prefs").status, "copied");
  assert.equal(report.actions.find((a) => a.domain === "plan_prefs").warning, "trip_missing_default_ams");
  assert.equal(s.getItem("asa:ams:plan_prefs"), "{\"tempo\":\"slow\"}");
  assert.equal(s.getItem("asa:cph:plan_prefs"), null);
  assert.equal(s.getItem("asa:ams:trip"), null);
});

test("migrate is idempotent and does not overwrite a present new key", () => {
  const legacy = JSON.stringify(["legacy"]);
  const newer = JSON.stringify(["newer"]);
  const s = mem({ ams_fav: legacy, "asa:ams:fav": newer, asa_trip: trip("Amsterdam") });
  const first = asa.migrate(s);
  const writes = s.calls.set.length;
  assert.equal(first.actions.find((a) => a.domain === "fav").status, "kept_existing");
  assert.equal(first.actions.find((a) => a.domain === "trip").status, "copied");
  const second = asa.migrate(s);
  assert.equal(second.actions.find((a) => a.domain === "fav").status, "kept_existing");
  assert.equal(second.actions.find((a) => a.domain === "trip").status, "kept_existing");
  assert.equal(s.getItem("asa:ams:fav"), newer);
  assert.equal(s.getItem("ams_fav"), legacy);
  assert.equal(s.getItem("asa:ams:trip"), trip("Amsterdam"));
  assert.equal(s.calls.set.length, writes);
  assert.deepEqual(s.calls.remove, []);
});

test("corrupt or non-string legacy is skipped and a corrupt target is kept", () => {
  const s = mem({
    ams_fav: "{\"not\":\"array\"}",
    ams_cal: "",
    ams_plan: "null",
    ams_dayven: "[\"x\"]",
    ams_calphoto: "42",
    "asa:ams:plan": "{",
    asa_trip: "\"Amsterdam\"",
    asa_plan_prefs: "[]"
  });
  const report = asa.migrate(s);
  for (const domain of DOMAINS) {
    assert.equal(report.actions.find((a) => a.domain === domain).status, "skipped_corrupt");
  }
  assert.equal(s.getItem("asa:ams:fav"), null);
  assert.equal(s.getItem("asa:ams:plan"), "{");
  assert.equal(s.getItem("ams_fav"), "{\"not\":\"array\"}");
  assert.equal(s.getItem("asa_trip"), "\"Amsterdam\"");
  assert.equal(s.getItem("asa_plan_prefs"), "[]");
  assert.deepEqual(s.calls.remove, []);
  assert.equal(s.calls.clear, 0);
});

test("a present corrupt city key is not overwritten by valid legacy", () => {
  const legacy = JSON.stringify(["barpif"]);
  const s = mem({ ams_fav: legacy, "asa:ams:fav": "{" });
  const report = asa.migrate(s);
  assert.equal(report.actions.find((a) => a.domain === "fav").status, "kept_existing");
  assert.equal(s.getItem("asa:ams:fav"), "{");
  assert.equal(s.getItem("ams_fav"), legacy);
  assert.deepEqual(s.calls.remove, []);
  assert.equal(asa.isLegacyCopyVerified(s, "ams_fav").reason, "corrupt_target");
});

test("non-string favorite entries are unknown and are not copied", () => {
  const s = mem({ ams_fav: JSON.stringify(["ok", 2]) });
  assert.equal(asa.migrate(s).actions.find((a) => a.domain === "fav").status, "skipped_corrupt");
  assert.equal(s.getItem("asa:ams:fav"), null);
  assert.equal(s.getItem("ams_fav"), JSON.stringify(["ok", 2]));
});

test("migrate leaves shared, admin, consent, auth, and unknown keys alone", () => {
  const seed = {
    asa_session: "{\"uid\":\"user-1\"}",
    "asa-admin-auth": "admin-session-placeholder",
    asa_cookie_decision_v2: "{\"choice\":\"essential\"}",
    "sb-projectref-auth-token": "token-placeholder",
    "sb-projectref-auth-token-code-verifier": "verifier-placeholder",
    "some_other_key": "leave-me",
    "asa:ams:custom": "unknown-domain",
    ams_fav: JSON.stringify(["barpif"])
  };
  const s = mem(seed);
  asa.migrate(s);
  for (const [k, v] of Object.entries(seed)) {
    if (k === "ams_fav") continue;
    assert.equal(s.getItem(k), v);
  }
  assert.deepEqual(s.calls.remove, []);
  assert.equal(s.calls.clear, 0);
  assert.ok(!s.calls.set.includes("asa_session"));
  assert.ok(!s.calls.set.includes("sb-projectref-auth-token"));
});

test("a write failure does not delete legacy or roll back earlier copies", () => {
  const s = mem({ ams_fav: JSON.stringify(["a"]), ams_cal: JSON.stringify({ d: "n" }) });
  const orig = s.setItem;
  s.setItem = (k, v) => {
    if (k === "asa:ams:cal") throw new Error("quota");
    return orig(k, v);
  };
  const report = asa.migrate(s);
  assert.equal(report.actions.find((a) => a.domain === "fav").status, "copied");
  assert.equal(report.actions.find((a) => a.domain === "cal").status, "write_failed");
  assert.equal(s.getItem("ams_fav"), JSON.stringify(["a"]));
  assert.equal(s.getItem("ams_cal"), JSON.stringify({ d: "n" }));
  assert.equal(s.getItem("asa:ams:fav"), JSON.stringify(["a"]));
  assert.equal(s.getItem("asa:ams:cal"), null);
  assert.deepEqual(s.calls.remove, []);
});

test("verified copy predicate matches data and never removes keys", () => {
  const s = mem({ ams_fav: JSON.stringify(["a", "b"]) });
  assert.equal(asa.isLegacyCopyVerified(s, "ams_fav").reason, "missing_target");
  asa.migrate(s);
  const match = asa.isLegacyCopyVerified(s, "ams_fav");
  assert.equal(match.verified, true);
  assert.equal(match.reason, "match");
  assert.equal(match.targetKey, "asa:ams:fav");
  s.setItem("asa:ams:fav", JSON.stringify(["b", "a"]));
  assert.equal(asa.isLegacyCopyVerified(s, "ams_fav").reason, "mismatch");
  s.setItem("asa:ams:fav", "{");
  assert.equal(asa.isLegacyCopyVerified(s, "ams_fav").reason, "corrupt_target");
  const broken = mem({ ams_fav: "{" });
  assert.equal(asa.isLegacyCopyVerified(broken, "ams_fav").reason, "corrupt_legacy");
  assert.equal(asa.isLegacyCopyVerified(mem({}), "ams_fav").reason, "absent");
  assert.equal(asa.isLegacyCopyVerified(s, "asa_session").reason, "shared_untouched");
  assert.equal(asa.isLegacyCopyVerified(s, "sb-abc-auth-token").reason, "shared_untouched");
  assert.equal(asa.isLegacyCopyVerified(s, "not_a_key").reason, "not_legacy");
  assert.equal(typeof asa.retireLegacy, "undefined");
  assert.equal(typeof asa.deleteLegacy, "undefined");
  assert.deepEqual(s.calls.remove, []);
});

test("reordered JSON still counts as a verified copy", () => {
  const s = mem({
    asa_plan_prefs: "{\"tempo\":\"slow\",\"saved\":true}",
    "asa:ams:plan_prefs": "{\"saved\":true,\"tempo\":\"slow\"}"
  });
  const check = asa.isLegacyCopyVerified(s, "asa_plan_prefs");
  assert.equal(check.verified, true);
  assert.equal(check.targetKey, "asa:ams:plan_prefs");
});

test("cph trip verification targets asa:cph:trip and does not treat ams as the copy", () => {
  const raw = trip("Kopenhag");
  const s = mem({ asa_trip: raw, "asa:ams:trip": raw });
  const check = asa.isLegacyCopyVerified(s, "asa_trip");
  assert.equal(check.verified, false);
  assert.equal(check.targetKey, "asa:cph:trip");
  assert.equal(check.reason, "missing_target");
  s.setItem("asa:cph:trip", raw);
  assert.equal(asa.isLegacyCopyVerified(s, "asa_trip").verified, true);
});

test("clearCity removes only that city's registered new keys", () => {
  const s = mem({
    "asa:ams:fav": JSON.stringify(["a"]),
    "asa:ams:trip": trip("Amsterdam"),
    "asa:ams:cal": "{",
    "asa:cph:fav": JSON.stringify(["b"]),
    "asa:cph:trip": trip("Kopenhag"),
    ams_fav: JSON.stringify(["legacy"]),
    asa_trip: trip("Amsterdam"),
    asa_session: "{\"uid\":\"user-1\"}",
    "sb-abc123-auth-token": "token-placeholder",
    "asa-admin-auth": "admin-session-placeholder",
    "asa:ams:custom": "stay"
  });
  const cleared = asa.clearCity(s, "ams");
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.legacyKeysDeleted, []);
  assert.equal(s.getItem("asa:ams:fav"), null);
  assert.equal(s.getItem("asa:ams:trip"), null);
  assert.equal(s.getItem("asa:ams:cal"), null);
  assert.equal(s.getItem("asa:cph:fav"), JSON.stringify(["b"]));
  assert.equal(s.getItem("asa:cph:trip"), trip("Kopenhag"));
  assert.equal(s.getItem("ams_fav"), JSON.stringify(["legacy"]));
  assert.equal(s.getItem("asa_trip"), trip("Amsterdam"));
  assert.equal(s.getItem("asa_session"), "{\"uid\":\"user-1\"}");
  assert.equal(s.getItem("sb-abc123-auth-token"), "token-placeholder");
  assert.equal(s.getItem("asa-admin-auth"), "admin-session-placeholder");
  assert.equal(s.getItem("asa:ams:custom"), "stay");
  assert.equal(s.calls.clear, 0);
  assert.ok(s.calls.remove.every((k) => k.startsWith("asa:ams:")));
  assert.equal(asa.clearCity(s, "cph").removed.includes("asa:cph:fav"), true);
  assert.equal(s.getItem("ams_fav"), JSON.stringify(["legacy"]));
});

test("storage without clear still migrates", () => {
  const data = { ams_fav: JSON.stringify(["a"]) };
  const s = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; }
  };
  assert.equal(asa.migrate(s).actions.find((a) => a.domain === "fav").status, "copied");
  assert.equal(data.ams_fav, JSON.stringify(["a"]));
  assert.equal(data["asa:ams:fav"], JSON.stringify(["a"]));
});

test("invalid storage is rejected before any read", () => {
  assert.throws(() => asa.migrate(null), /invalid_storage/);
  assert.throws(() => asa.get({}, "ams", "fav"), /invalid_storage/);
});

test("live pages do not load the module or the new key form", () => {
  const pages = [
    "index.html",
    "amsterdam/index.html",
    "amsterdam_index_UID.html",
    "kopenhag/index.html",
    "amsterdam.html",
    "admin.html",
    "CDP3B/admin.html"
  ];
  for (const page of pages) {
    const html = read(page);
    assert.equal(html.includes("asa_storage"), false, page);
    assert.equal(html.includes("lib/asa-storage"), false, page);
    assert.equal(html.includes("AsaStorage"), false, page);
    assert.equal(html.includes("asa:ams:"), false, page);
    assert.equal(html.includes("asa:cph:"), false, page);
  }
  const cph = read("kopenhag/index.html");
  assert.match(cph, /data-asa-city-state\s*=\s*"stub"/);
  assert.equal(/<script\b/i.test(cph), false);
  const city = read("amsterdam/index.html");
  assert.match(city, /getItem\("ams_fav"\)[\s\S]{0,220}if\(raw!==null\)/);
  const home = read("index.html");
  assert.match(home, /localStorage\.setItem\("asa_trip"/);
  assert.doesNotMatch(home, /asa_storage|lib\/asa-storage/);
});

test("module source does not touch global storage or delete helpers", () => {
  const src = read("lib/asa-storage/asa_storage.js");
  assert.equal(src.includes("localStorage"), false);
  assert.equal(src.includes("sessionStorage"), false);
  assert.equal(src.includes(".clear("), false);
  assert.equal(src.includes("retireLegacy"), false);
  assert.equal(src.includes("WIRED: false"), true);
});
