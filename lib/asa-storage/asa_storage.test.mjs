import { existsSync, readFileSync } from "node:fs";
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

test("module is a wired v1 policy-A registry", () => {
  assert.equal(asa.INERT, false);
  assert.equal(asa.WIRED, true);
  assert.equal(asa.MIGRATION_VERSION, 1);
  assert.equal(asa.MARKER_VERSION, 1);
  assert.equal(asa.LARGE_COPY_CHARS, 524288);
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

test("WP3 wiring: only the homepage and Amsterdam page load the module, cache-busted by content hash", () => {
  const { createHash } = require("node:crypto");
  const ver = createHash("sha256").update(readFileSync(join(repo, "lib/asa-storage/asa_storage.js"))).digest("hex").slice(0, 16);
  const tag = `<script src="/lib/asa-storage/asa_storage.js?v=${ver}"></script>`;
  for (const page of ["index.html", "amsterdam/index.html"]) {
    const html = read(page);
    assert.equal(html.split(tag).length - 1, 1, page + " loads the current module exactly once");
    assert.equal((html.match(/asa_storage\.js/g) || []).length, 1, page);
    const firstInline = html.search(/<script>\s*\/\* ASALOCAL TripStore/);
    assert.ok(firstInline > html.indexOf(tag), page + " loads the module before its first inline script");
  }
  assert.equal(read("amsterdam/index.html").includes("asa:cph:"), false, "Amsterdam page never names a cph key");
  const notWired = ["amsterdam_index_UID.html", "kopenhag/index.html", "amsterdam.html", "admin.html", "CDP3B/admin.html"];
  for (const page of notWired) {
    if (page === "amsterdam_index_UID.html" && !existsSync(join(repo, page))) continue; // retired in WP7 (301 to /amsterdam/)
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
});

test("WP3 wiring: Amsterdam page has no direct city-data storage access left", () => {
  const city = read("amsterdam/index.html");
  const calls = city.match(/localStorage\.(getItem|setItem|removeItem)\(\s*["'][^"']*["']/g) || [];
  for (const c of calls) assert.match(c, /"asa_session"$/, "only asa_session stays on raw localStorage: " + c);
  assert.equal(/localStorage\.(getItem|setItem)\(\s*k\b/.test(city), false, "no generic key passthrough");
  assert.equal(/localStorage\.clear\(/.test(city), false);
  for (const legacy of ["ams_fav", "ams_cal", "ams_plan", "ams_dayven", "ams_calphoto"]) {
    assert.equal(new RegExp('["\']' + legacy + '["\']').test(city), false, legacy + " literal");
  }
  assert.equal(/["']asa_trip["']|["']asa_plan_prefs["']/.test(city), false);
  assert.match(city, /LIB\.reconcile\(LS,CODE\)/);
  assert.match(city, /var CODE="ams"/);
  assert.match(city, /const favRaw=ASA_ST\.read\("fav"\);\s*if\(favRaw\.present\)\{[\s\S]{0,200}return;\s*\}\s*if\(!ASA_ST\.writable\(\)\) return;/);
  assert.match(city, /favSet=new Set\(union\);\s*if\(!ASA_ST\.set\("fav",\[\.\.\.favSet\]\)&&ASA_ST\.writable\(\)\) ASA_ST\.say\(/);
  assert.match(city, /function toggleFav\(id\)\{const had=favSet\.has\(id\);[\s\S]{0,80}if\(!ASA_ST\.set\("fav",\[\.\.\.favSet\]\)&&ASA_ST\.writable\(\)\)\{ if\(had\)favSet\.add\(id\);else favSet\.delete\(id\);/, "a refused favorite write is undone");
  assert.match(city, /LIB\.adoptLegacy\(LS,CODE,"plan_prefs"\)/, "stranded plan prefs move only through the explicit adopt action");
  assert.match(city, /id="asaStoreNotice"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("WP3 wiring: homepage writes trips by Trip Policy A only", () => {
  const home = read("index.html");
  assert.equal(/localStorage\.setItem\(\s*["']asa_trip["']/.test(home), false);
  assert.match(home, /code=S\?S\.cityCodeFromLabel\(sel\.city\):null; if\(code\)\{ if\(code==="ams"\) S\.reconcile\(localStorage,code\); S\.set\(localStorage,code,"trip",trip\); \}/);
  assert.equal((home.match(/\.reconcile\(/g) || []).length, 1, "no live cph migration before Kopenhag launches");
  const calls = home.match(/localStorage\.(getItem|setItem|removeItem)\(\s*["'][^"']*["']/g) || [];
  for (const c of calls) assert.match(c, /"asa_session"$/, c);
});

test("module source does not touch global storage or delete helpers", () => {
  const src = read("lib/asa-storage/asa_storage.js");
  assert.equal(src.includes("localStorage"), false);
  assert.equal(src.includes("sessionStorage"), false);
  assert.equal(src.includes(".clear("), false);
  assert.equal(src.includes("retireLegacy"), false);
  assert.equal(src.includes("WIRED: true"), true);
  assert.equal(src.includes("NOT WIRED"), false);
});

/* ---- WP3: city-filtered migrate, trip city check, marker, conflicts ---- */

const NOW = "2026-10-07T10:00:00.000Z";
const LATER = "2026-10-08T10:00:00.000Z";

test("migrate(storage, city) copies only that city's slots", () => {
  const s = mem({ ams_fav: '["a"]', asa_trip: trip("Kopenhag"), asa_plan_prefs: '{"tempo":"slow"}' });
  const r = asa.migrate(s, "ams");
  assert.equal(r.cityCode, "ams");
  assert.equal(s.getItem("asa:ams:fav"), '["a"]');
  assert.equal(s.getItem("asa:cph:trip"), null);
  assert.equal(s.getItem("asa:cph:plan_prefs"), null);
  assert.equal(s.getItem("asa:ams:trip"), null);
  assert.equal(r.actions.find((a) => a.domain === "trip").status, "other_city");
  assert.equal(r.actions.find((a) => a.domain === "plan_prefs").status, "other_city");
  const c = asa.migrate(s, "cph");
  assert.equal(s.getItem("asa:cph:trip"), trip("Kopenhag"));
  assert.equal(c.actions.find((a) => a.domain === "fav").status, "other_city");
  assert.equal(s.getItem("asa:cph:fav"), null);
  assert.throws(() => asa.migrate(s, "dk-cph"), /invalid_city/);
  assert.deepEqual(s.calls.remove, []);
});

test("fingerprint is stable, length-aware, and null for absent", () => {
  assert.equal(asa.fingerprint(null), null);
  assert.equal(asa.fingerprint(undefined), null);
  assert.equal(asa.fingerprint('["a"]'), asa.fingerprint('["a"]'));
  assert.notEqual(asa.fingerprint('["a"]'), asa.fingerprint('["b"]'));
  assert.match(asa.fingerprint(""), /^fnv1a32:811c9dc5:0$/);
  assert.match(asa.fingerprint('["a"]'), /^fnv1a32:[0-9a-f]{8}:5$/);
});

test("checkTripCity follows policy A and flags other or unknown cities", () => {
  assert.equal(asa.checkTripCity({ city: "Amsterdam" }, "ams").match, true);
  assert.equal(asa.checkTripCity({ start_date: "2026-10-10" }, "ams").match, true);
  assert.equal(asa.checkTripCity({ city: " " }, "ams").reason, "city_missing_policy_a");
  const k = asa.checkTripCity({ city: "Kopenhag" }, "ams");
  assert.equal(k.match, false);
  assert.equal(k.reason, "other_city");
  assert.equal(k.cityCode, "cph");
  assert.equal(k.cityLabel, "Kopenhag");
  const p = asa.checkTripCity({ city: "Paris" }, "ams");
  assert.equal(p.match, false);
  assert.equal(p.reason, "unknown_city");
  assert.equal(asa.checkTripCity({ city: "Copenhagen" }, "cph").match, true);
  assert.equal(asa.checkTripCity({ city: "Amsterdam" }, "cph").match, false);
  assert.equal(asa.checkTripCity(null, "ams").match, false);
  assert.equal(asa.checkTripCity([], "ams").reason, "not_a_trip");
});

test("reconcile on empty storage writes a verified marker and no data keys", () => {
  const s = mem({});
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(r.firstRun, true);
  assert.equal(r.markerWritten, true);
  assert.equal(r.markerKey, "asa:ams:_migrated");
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.mismatch, null);
  assert.equal(r.verified, true);
  const m = JSON.parse(s.getItem("asa:ams:_migrated"));
  assert.equal(m.v, 1);
  assert.equal(m.city, "ams");
  assert.equal(m.policy, "A");
  assert.equal(m.legacy_kept, true);
  assert.equal(m.verified, true);
  assert.equal(m.first_at, NOW);
  assert.deepEqual(Object.keys(m.keys).sort(), ["ams_cal", "ams_calphoto", "ams_dayven", "ams_fav", "ams_plan", "asa_plan_prefs", "asa_trip"]);
  for (const e of Object.values(m.keys)) assert.deepEqual(e, { fp: null, state: "absent" });
  assert.deepEqual(s.calls.set, ["asa:ams:_migrated"]);
});

test("reconcile copies legacy once, marks verified, and does not rewrite on reload", () => {
  const seed = { ams_fav: '["barpif","chun"]', ams_cal: '{"g1":"not"}', asa_trip: trip("Amsterdam"), asa_plan_prefs: '{"saved":true}' };
  const s = mem(seed);
  const first = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(first.verified, true);
  assert.deepEqual(first.conflicts, []);
  const m1 = JSON.parse(s.getItem("asa:ams:_migrated"));
  assert.equal(m1.keys.ams_fav.state, "verified");
  assert.equal(m1.keys.ams_fav.fp, asa.fingerprint(seed.ams_fav));
  assert.equal(m1.keys.asa_trip.state, "verified");
  assert.equal(m1.keys.ams_plan.state, "absent");
  const writes = s.calls.set.length;
  const second = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(second.firstRun, false);
  assert.equal(second.markerWritten, false);
  assert.equal(s.calls.set.length, writes, "reload performs no writes");
  for (const [k, v] of Object.entries(seed)) assert.equal(s.getItem(k), v);
  assert.equal(s.getItem("asa:ams:fav"), seed.ams_fav);
  assert.deepEqual(s.calls.remove, []);
});

test("user edits on the new key after migration are not a conflict", () => {
  const s = mem({ ams_fav: '["a","b"]' });
  asa.reconcile(s, "ams", { now: NOW });
  assert.equal(asa.set(s, "ams", "fav", ["a"]).ok, true);
  const r = asa.reconcile(s, "ams", { now: LATER });
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.marker.keys.ams_fav.state, "verified");
  assert.equal(s.getItem("ams_fav"), '["a","b"]');
  assert.equal(s.getItem("asa:ams:fav"), '["a"]');
});

test("pre-existing different new value is a conflict: new kept, legacy kept", () => {
  const s = mem({ ams_fav: '["old"]', "asa:ams:fav": '["new"]' });
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.deepEqual(r.conflicts.map((c) => [c.domain, c.legacyKey, c.key, c.reason]), [["fav", "ams_fav", "asa:ams:fav", "differs"]]);
  assert.equal(r.verified, false);
  assert.equal(s.getItem("asa:ams:fav"), '["new"]');
  assert.equal(s.getItem("ams_fav"), '["old"]');
  assert.deepEqual(asa.get(s, "ams", "fav").value, ["new"]);
  const again = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(again.conflicts.length, 1, "conflict persists until acknowledged");
  assert.deepEqual(s.calls.remove, []);
});

test("legacy written after migration (old tab) is a conflict; acknowledge writes only the marker", () => {
  const s = mem({ ams_fav: '["a"]' });
  asa.reconcile(s, "ams", { now: NOW });
  s.setItem("ams_fav", '["a","old-tab"]');
  const r = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].domain, "fav");
  assert.equal(s.getItem("asa:ams:fav"), '["a"]');
  const before = s.calls.set.length;
  const ack = asa.acknowledge(s, "ams", { conflicts: true, now: LATER });
  assert.deepEqual(ack.acknowledged, ["ams_fav"]);
  assert.deepEqual(s.calls.set.slice(before), ["asa:ams:_migrated"]);
  const m = JSON.parse(s.getItem("asa:ams:_migrated"));
  assert.equal(m.keys.ams_fav.state, "acknowledged");
  assert.equal(m.verified, false);
  const after = asa.reconcile(s, "ams", { now: LATER });
  assert.deepEqual(after.conflicts, []);
  assert.equal(after.verified, false, "acknowledged legacy is not retirement-ready");
  assert.equal(s.getItem("ams_fav"), '["a","old-tab"]');
  assert.equal(s.getItem("asa:ams:fav"), '["a"]');
  s.setItem("ams_fav", '["again"]');
  assert.equal(asa.reconcile(s, "ams", { now: LATER }).conflicts.length, 1, "a further legacy change re-opens the conflict");
  assert.deepEqual(s.calls.remove, []);
});

test("corrupt new key with valid legacy is reported as new_unreadable and nothing is overwritten", () => {
  const s = mem({ ams_fav: '["a"]', "asa:ams:fav": "{" });
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(r.conflicts[0].reason, "new_unreadable");
  assert.equal(s.getItem("asa:ams:fav"), "{");
  assert.equal(s.getItem("ams_fav"), '["a"]');
});

test("corrupt legacy and failed copies are tracked but never block or delete", () => {
  const s = mem({ ams_fav: "{oops", ams_cal: '{"g1":"x"}' });
  const orig = s.setItem;
  s.setItem = (k, v) => { if (k === "asa:ams:cal") throw new Error("quota"); return orig(k, v); };
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(r.marker.keys.ams_fav.state, "corrupt");
  assert.equal(r.marker.keys.ams_cal.state, "copy_failed");
  assert.equal(r.verified, false);
  assert.deepEqual(r.conflicts, []);
  s.setItem = orig;
  assert.equal(asa.get(s, "ams", "cal").source, "legacy", "page still reads the legacy value");
  assert.equal(asa.set(s, "ams", "cal", { g1: "edited" }).ok, true);
  const r2 = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(r2.marker.keys.ams_cal.state, "superseded");
  assert.deepEqual(r2.conflicts, []);
  assert.equal(s.getItem("ams_cal"), '{"g1":"x"}');
  assert.equal(s.getItem("ams_fav"), "{oops");
});

test("a Kopenhag legacy trip is a mismatch on ams, not migrated there, and acknowledgeable", () => {
  const raw = trip("Kopenhag");
  const s = mem({ asa_trip: raw, asa_plan_prefs: '{"tempo":"slow"}', ams_fav: '["a"]' });
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(s.getItem("asa:ams:trip"), null);
  assert.equal(s.getItem("asa:cph:trip"), null, "the ams page does not write cph keys");
  assert.equal(s.getItem("asa:ams:plan_prefs"), null);
  assert.equal(r.marker.keys.asa_trip, undefined);
  assert.equal(r.mismatch.source, "legacy");
  assert.equal(r.mismatch.reason, "other_city");
  assert.equal(r.mismatch.otherCityCode, "cph");
  assert.equal(r.mismatch.cityLabel, "Kopenhag");
  assert.equal(r.mismatch.acknowledged, false);
  const ack = asa.acknowledge(s, "ams", { mismatchFp: r.mismatch.fp, now: NOW });
  assert.equal(ack.mismatchAcknowledged, true);
  assert.equal(asa.reconcile(s, "ams", { now: LATER }).mismatch.acknowledged, true);
  assert.equal(asa.acknowledge(s, "ams", { mismatchFp: "fnv1a32:00000000:1" }).mismatchAcknowledged, false);
  assert.equal(s.getItem("asa_trip"), raw);
  asa.set(s, "ams", "trip", { city: "Amsterdam", start_date: "2026-11-01", end_date: "2026-11-03" });
  assert.equal(asa.reconcile(s, "ams", { now: LATER }).mismatch, null, "an own Amsterdam trip hides the stale legacy notice");
});

test("an unknown-city trip in the ams key is a mismatch from the city key", () => {
  const s = mem({ asa_trip: trip("Paris") });
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(s.getItem("asa:ams:trip"), trip("Paris"), "policy A legacy placement is unchanged");
  assert.equal(r.mismatch.source, "city");
  assert.equal(r.mismatch.reason, "unknown_city");
  assert.equal(r.mismatch.cityLabel, "Paris");
  assert.equal(r.mismatch.key, "asa:ams:trip");
});

test("reconcile and acknowledge never touch protected keys or the other city", () => {
  const seed = {
    asa_session: '{"uid":"user-1"}',
    "asa-admin-auth": "admin-session-placeholder",
    asa_cookie_decision_v2: '{"choice":"essential"}',
    "sb-projectref-auth-token": "token-placeholder",
    "asa:cph:fav": '["nyhavn"]',
    "asa:cph:trip": trip("Kopenhag"),
    ams_fav: '["old"]',
    "asa:ams:fav": '["new"]'
  };
  const s = mem(seed);
  const r = asa.reconcile(s, "ams", { now: NOW });
  asa.acknowledge(s, "ams", { conflicts: true, now: NOW });
  for (const k of ["asa_session", "asa-admin-auth", "asa_cookie_decision_v2", "sb-projectref-auth-token", "asa:cph:fav", "asa:cph:trip"]) {
    assert.equal(s.getItem(k), seed[k], k);
  }
  assert.ok(s.calls.set.every((k) => k.startsWith("asa:ams:")), s.calls.set.join(","));
  assert.equal(r.conflicts.length, 1);
  assert.equal(s.getItem("asa:cph:_migrated"), null);
  assert.deepEqual(s.calls.remove, []);
});

test("an invalid marker is replaced and treated as a first run", () => {
  const s = mem({ "asa:ams:_migrated": "{bad", ams_fav: '["a"]' });
  assert.equal(asa.readMarker(s, "ams").valid, false);
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(r.firstRun, true);
  assert.equal(asa.readMarker(s, "ams").valid, true);
  assert.equal(asa.acknowledge(mem({}), "ams", { conflicts: true }).reason, "no_marker");
  assert.equal(asa.markerKey("cph"), "asa:cph:_migrated");
  assert.throws(() => asa.markerKey("dk"), /invalid_city/);
  assert.throws(() => asa.set(s, "ams", "_migrated", {}), /invalid_domain/);
});

/* ---- WP3 review fixes: large-copy deferral, stranded plan_prefs, explicit adoption ---- */

const bigPhotos = (chars) => JSON.stringify({ g1: ["data:image/jpeg;base64," + "A".repeat(chars)] });

test("reconcile defers copying a large legacy value; reads fall back; first save supersedes", () => {
  const raw = bigPhotos(asa.LARGE_COPY_CHARS);
  const s = mem({ ams_calphoto: raw, ams_fav: '["a"]' });
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(r.actions.find((a) => a.domain === "calphoto").status, "deferred");
  assert.equal(s.getItem("asa:ams:calphoto"), null, "no duplicate of the large value");
  assert.equal(s.getItem("asa:ams:fav"), '["a"]', "small values still copied");
  assert.equal(r.marker.keys.ams_calphoto.state, "deferred");
  assert.equal(r.marker.keys.ams_calphoto.fp, asa.fingerprint(raw));
  assert.equal(r.verified, false, "a deferred copy is not retirement-ready");
  assert.deepEqual(r.conflicts, []);
  assert.equal(asa.get(s, "ams", "calphoto").source, "legacy");
  const writes = s.calls.set.length;
  const again = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(again.marker.keys.ams_calphoto.state, "deferred");
  assert.equal(s.calls.set.length, writes, "reload writes nothing while deferred");
  assert.equal(asa.set(s, "ams", "calphoto", { g1: [] }).ok, true);
  const after = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(after.marker.keys.ams_calphoto.state, "superseded");
  assert.deepEqual(after.conflicts, []);
  assert.equal(s.getItem("ams_calphoto"), raw, "legacy kept");
  s.setItem("ams_calphoto", bigPhotos(asa.LARGE_COPY_CHARS + 1));
  assert.deepEqual(asa.reconcile(s, "ams", { now: LATER }).conflicts.map((c) => c.legacyKey), ["ams_calphoto"], "an old-tab write after the save is still a conflict");
  assert.deepEqual(s.calls.remove, []);
});

test("deferral threshold: options.deferAbove overrides; migrate() without options stays eager", () => {
  const raw = bigPhotos(32);
  const a = mem({ ams_calphoto: raw });
  assert.equal(asa.reconcile(a, "ams", { now: NOW, deferAbove: 16 }).marker.keys.ams_calphoto.state, "deferred");
  const b = mem({ ams_calphoto: raw });
  assert.equal(asa.reconcile(b, "ams", { now: NOW }).marker.keys.ams_calphoto.state, "verified");
  assert.equal(b.getItem("asa:ams:calphoto"), raw);
  const c = mem({ ams_calphoto: bigPhotos(asa.LARGE_COPY_CHARS) });
  asa.migrate(c);
  assert.equal(c.getItem("asa:ams:calphoto"), c.getItem("ams_calphoto"), "v1 migrate() copies everything");
  const d = mem({ ams_calphoto: raw });
  assert.equal(asa.migrate(d, "ams", { deferAbove: 16 }).actions.find((x) => x.domain === "calphoto").status, "deferred");
  assert.equal(d.getItem("asa:ams:calphoto"), null);
});

test("stranded plan_prefs: Kopenhag legacy trip + Amsterdam-written prefs are reported on ams, never copied", () => {
  const prefs = '{"tempo":"Sakin","mustSee":["barpif"],"saved":true}';
  const s = mem({ asa_trip: trip("Kopenhag"), asa_plan_prefs: prefs });
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(r.actions.find((a) => a.domain === "plan_prefs").status, "other_city", "policy A placement unchanged");
  assert.equal(r.stranded.length, 1);
  assert.deepEqual([r.stranded[0].domain, r.stranded[0].legacyKey, r.stranded[0].key, r.stranded[0].placedCityCode, r.stranded[0].cityLabel, r.stranded[0].acknowledged], ["plan_prefs", "asa_plan_prefs", "asa:ams:plan_prefs", "cph", "Kopenhag", false]);
  assert.equal(s.getItem("asa:ams:plan_prefs"), null);
  assert.equal(s.getItem("asa:cph:plan_prefs"), null);
  asa.set(s, "ams", "trip", { city: "Amsterdam", start_date: "2026-11-01", end_date: "2026-11-03" });
  const own = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(own.mismatch, null, "own Amsterdam trip clears the trip mismatch");
  assert.equal(own.stranded.length, 1, "…but the stranded prefs are still reported");
  const cph = asa.reconcile(mem({ asa_trip: trip("Amsterdam"), asa_plan_prefs: prefs }), "cph", { now: NOW });
  assert.deepEqual(cph.stranded, [], "only the writer city (ams) reports stranded prefs");
  assert.deepEqual(asa.reconcile(mem({ asa_trip: trip("Amsterdam"), asa_plan_prefs: prefs }), "ams", { now: NOW }).stranded, [], "placed on ams: normal migration");
  assert.deepEqual(asa.reconcile(mem({ asa_trip: trip("Kopenhag"), asa_plan_prefs: "[]" }), "ams", { now: NOW }).stranded, [], "corrupt prefs are not offered");
  assert.equal(s.getItem("asa_plan_prefs"), prefs);
  assert.deepEqual(s.calls.remove, []);
});

test("stranded plan_prefs: acknowledge records the decline by fingerprint; a changed legacy value re-opens it", () => {
  const s = mem({ asa_trip: trip("Kopenhag"), asa_plan_prefs: '{"tempo":"Sakin"}' });
  asa.reconcile(s, "ams", { now: NOW });
  const before = s.calls.set.length;
  const ack = asa.acknowledge(s, "ams", { stranded: true, now: NOW });
  assert.deepEqual(ack.strandedAcknowledged, ["asa_plan_prefs"]);
  assert.deepEqual(s.calls.set.slice(before), ["asa:ams:_migrated"], "acknowledge writes the marker only");
  const r = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(r.stranded[0].acknowledged, true);
  assert.equal(r.marker.stranded_ack.asa_plan_prefs, asa.fingerprint('{"tempo":"Sakin"}'));
  s.setItem("asa_plan_prefs", '{"tempo":"Hızlı"}');
  assert.equal(asa.reconcile(s, "ams", { now: LATER }).stranded[0].acknowledged, false);
  assert.equal(s.getItem("asa:ams:plan_prefs"), null);
});

test("adoptLegacy copies stranded prefs byte-identical on request only; never overwrites, never touches legacy/cph/protected", () => {
  const prefs = '{"tempo":"Sakin","saved":true}';
  const seed = { asa_trip: trip("Kopenhag"), asa_plan_prefs: prefs, asa_session: '{"uid":"u"}', "sb-projectref-auth-token": "token-placeholder", "asa:cph:trip": trip("Kopenhag") };
  const s = mem(seed);
  const a = asa.adoptLegacy(s, "ams", "plan_prefs");
  assert.deepEqual([a.ok, a.reason, a.key, a.legacyKey, a.wroteLegacy], [true, "adopted", "asa:ams:plan_prefs", "asa_plan_prefs", false]);
  assert.equal(s.getItem("asa:ams:plan_prefs"), prefs);
  assert.deepEqual(s.calls.set, ["asa:ams:plan_prefs"]);
  for (const k of Object.keys(seed)) assert.equal(s.getItem(k), seed[k], k);
  assert.equal(s.getItem("asa:cph:plan_prefs"), null);
  assert.deepEqual(asa.reconcile(s, "ams", { now: NOW }).stranded, [], "adopted prefs are no longer stranded");
  assert.equal(asa.adoptLegacy(s, "ams", "plan_prefs").reason, "kept_existing");
  asa.set(s, "ams", "plan_prefs", { tempo: "Dengeli" });
  assert.equal(asa.adoptLegacy(s, "ams", "plan_prefs").reason, "kept_existing");
  assert.equal(s.getItem("asa:ams:plan_prefs"), '{"tempo":"Dengeli"}', "never overwrites");
  assert.equal(asa.adoptLegacy(mem({ asa_trip: trip("Kopenhag"), asa_plan_prefs: prefs }), "cph", "plan_prefs").reason, "not_adoptable");
  assert.equal(asa.adoptLegacy(mem({ ams_fav: '["a"]' }), "ams", "fav").reason, "not_adoptable");
  assert.equal(asa.adoptLegacy(mem({ asa_trip: trip("Amsterdam"), asa_plan_prefs: prefs }), "ams", "plan_prefs").reason, "not_stranded");
  assert.equal(asa.adoptLegacy(mem({ asa_trip: trip("Kopenhag") }), "ams", "plan_prefs").reason, "absent");
  assert.equal(asa.adoptLegacy(mem({ asa_trip: trip("Kopenhag"), asa_plan_prefs: "{bad" }), "ams", "plan_prefs").reason, "corrupt");
  const full = mem({ asa_trip: trip("Kopenhag"), asa_plan_prefs: prefs });
  full.setItem = () => { throw new Error("quota"); };
  assert.equal(asa.adoptLegacy(full, "ams", "plan_prefs").reason, "write_failed");
  assert.equal(full.getItem("asa_plan_prefs"), prefs);
  assert.throws(() => asa.adoptLegacy(s, "dk", "plan_prefs"), /invalid_city/);
  assert.throws(() => asa.adoptLegacy(s, "ams", "asa_session"), /invalid_domain/);
  assert.deepEqual(s.calls.remove, []);
});

/* ---- WP3 owner decision: controlled, verified retirement of ams_calphoto at write time (setSafeMove) ---- */

// Storage with a per-origin character quota like Chromium (key + value chars). setItem throws a
// DOMException "QuotaExceededError" when the write does not fit; a failed write leaves the old value.
function qmem(seed, limit, hooks = {}) {
  const data = Object.assign({}, seed);
  const calls = { clear: 0, remove: [], set: [] };
  const used = () => Object.entries(data).reduce((n, [k, v]) => n + k.length + v.length, 0);
  const s = {
    calls,
    limit,
    used,
    dump() { return Object.assign({}, data); },
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) {
      calls.set.push(k);
      if (hooks.beforeSet) hooks.beforeSet(String(k), calls);
      const val = String(v);
      const prev = Object.prototype.hasOwnProperty.call(data, k) ? k.length + data[k].length : 0;
      if (used() - prev + k.length + val.length > s.limit) throw new DOMException("quota (test)", "QuotaExceededError");
      data[k] = val;
    },
    removeItem(k) { calls.remove.push(k); delete data[k]; if (hooks.afterRemove) hooks.afterRemove(String(k), calls); },
    clear() { calls.clear += 1; }
  };
  return s;
}
const photoList = (raw) => JSON.parse(raw).g1;
const PROTECTED_SEED = { asa_session: '{"uid":"u"}', "sb-projectref-auth-token": "token-placeholder" };
// What amsterdam/index.html passes as expectLegacyFp: the ams_calphoto fingerprint its OWN load-time
// reconcile recorded (the legacy bytes that tab read), never the shared marker's current value.
const readFpOf = (rep) => { const e = rep.marker.keys.ams_calphoto; return e && typeof e.fp === "string" && e.state !== "retired" ? e.fp : null; };
// ~55% case: legacy photos + the next value do not fit together, the next value alone does.
function deferredUser(extra = {}) {
  const raw = bigPhotos(asa.LARGE_COPY_CHARS);
  const s = qmem(Object.assign({ ams_calphoto: raw, ams_fav: '["a"]' }, PROTECTED_SEED, extra), Math.floor(raw.length * 1.8));
  const r = asa.reconcile(s, "ams", { now: NOW });
  assert.equal(r.marker.keys.ams_calphoto.state, "deferred");
  return { s, raw, fp: readFpOf(r) };
}
const withPhoto = (raw, tag) => ({ g1: photoList(raw).concat(["data:image/jpeg;base64," + tag]) });

test("setSafeMove: a photo write that fits is a plain set and never touches legacy", () => {
  const raw = bigPhotos(asa.LARGE_COPY_CHARS);
  const s = qmem({ ams_calphoto: raw }, raw.length * 4);
  asa.reconcile(s, "ams", { now: NOW });
  const r = asa.setSafeMove(s, "ams", "calphoto", { g1: [] });
  assert.deepEqual([r.ok, r.move, r.retired, r.restored, r.wroteLegacy], [true, "not_needed", false, null, false]);
  assert.deepEqual(r.legacyKeysDeleted, []);
  assert.equal(s.getItem("ams_calphoto"), raw);
  assert.deepEqual(s.calls.remove, []);
  assert.equal(asa.setSafeMove(s, "ams", "calphoto", ["not", "an", "object"]).reason, "invalid_shape");
  assert.throws(() => asa.setSafeMove(s, "dk", "calphoto", {}), /invalid_city/);
  assert.throws(() => asa.setSafeMove(s, "ams", "asa_session", {}), /invalid_domain/);
});

test("setSafeMove: deferred legacy + quota → legacy retired, new written, marker records fp + time; reads before/after; reload writes nothing", () => {
  const { s, raw, fp } = deferredUser();
  assert.equal(fp, asa.fingerprint(raw), "the tab's load-time read");
  assert.deepEqual(asa.get(s, "ams", "calphoto").value, JSON.parse(raw), "before: read through the legacy fallback");
  const next = withPhoto(raw, "NEW");
  assert.equal(asa.set(s, "ams", "calphoto", next).reason, "write_failed", "the WP3 blocker: new + kept legacy do not fit");
  const r = asa.setSafeMove(s, "ams", "calphoto", next, { now: LATER, expectLegacyFp: fp });
  assert.deepEqual([r.ok, r.reason, r.move, r.retired, r.markerWritten, r.restored, r.markerRestored], [true, null, "retired", true, true, null, null]);
  assert.deepEqual(r.legacyKeysDeleted, ["ams_calphoto"]);
  assert.equal(s.getItem("ams_calphoto"), null);
  assert.equal(s.getItem("asa:ams:calphoto"), JSON.stringify(next));
  assert.deepEqual(s.calls.remove, ["ams_calphoto"], "exactly one legacy removal");
  const m = asa.readMarker(s, "ams");
  assert.equal(m.valid, true);
  assert.deepEqual(m.value.keys.ams_calphoto, { fp: asa.fingerprint(raw), state: "retired", at: LATER, from: "deferred" });
  assert.equal(m.value.legacy_kept, false);
  assert.equal(m.value.verified, true, "remaining legacy keys verified, retired one gone");
  assert.equal(m.value.keys.ams_fav.state, "verified");
  assert.equal(s.getItem("ams_fav"), '["a"]', "other legacy keys untouched");
  for (const [k, v] of Object.entries(PROTECTED_SEED)) assert.equal(s.getItem(k), v, k);
  const after = asa.get(s, "ams", "calphoto");
  assert.deepEqual([after.source, after.value], ["city", next], "after: the new key is authoritative");
  const writes = s.calls.set.length;
  const markerBytes = s.getItem("asa:ams:_migrated");
  const re = asa.reconcile(s, "ams", { now: "2026-10-09T10:00:00.000Z" });
  assert.equal(s.calls.set.length, writes, "reload: zero writes");
  assert.equal(s.getItem("asa:ams:_migrated"), markerBytes, "reload keeps the retirement record");
  assert.deepEqual([re.marker.keys.ams_calphoto.state, re.marker.legacy_kept, re.verified, re.conflicts.length], ["retired", false, true, 0]);
  const more = asa.setSafeMove(s, "ams", "calphoto", withPhoto(JSON.stringify(next), "MORE"));
  assert.deepEqual([more.ok, more.move], [true, "not_needed"]);
  assert.deepEqual(s.calls.remove, ["ams_calphoto"]);
});

test("setSafeMove: superseded and verified markers are accounted for too (from is recorded)", () => {
  const { s, raw } = deferredUser();
  s.limit = 100 * raw.length;
  assert.equal(asa.set(s, "ams", "calphoto", withPhoto(raw, "FIRST")).ok, true, "storage roomy: first save lands next to legacy");
  const reload = asa.reconcile(s, "ams", { now: LATER });
  assert.equal(reload.marker.keys.ams_calphoto.state, "superseded");
  s.limit = Math.floor(raw.length * 1.8);
  const r = asa.setSafeMove(s, "ams", "calphoto", withPhoto(raw, "SECOND"), { now: LATER, expectLegacyFp: readFpOf(reload) });
  assert.deepEqual([r.ok, r.move], [true, "retired"]);
  assert.equal(asa.readMarker(s, "ams").value.keys.ams_calphoto.from, "superseded");
  const copied = bigPhotos(5000); // below LARGE_COPY_CHARS: copied at load → verified
  const v = qmem({ ams_calphoto: copied }, 100000);
  const vLoad = asa.reconcile(v, "ams", { now: NOW });
  assert.equal(vLoad.marker.keys.ams_calphoto.state, "verified");
  v.limit = v.used() + 200;
  const rv = asa.setSafeMove(v, "ams", "calphoto", withPhoto(copied, "V".repeat(1000)), { now: LATER, expectLegacyFp: readFpOf(vLoad) });
  assert.deepEqual([rv.ok, rv.move, asa.readMarker(v, "ams").value.keys.ams_calphoto.from], [true, "retired", "verified"]);
  assert.equal(v.getItem("ams_calphoto"), null);
});

test("setSafeMove: a retry that still does not fit writes legacy back byte-identical; marker and new key unchanged", () => {
  const { s, raw, fp } = deferredUser();
  s.limit = s.used() + 64; // other data filled the rest
  const markerBytes = s.getItem("asa:ams:_migrated");
  const r = asa.setSafeMove(s, "ams", "calphoto", withPhoto(raw, "X".repeat(4096)), { now: LATER, expectLegacyFp: fp });
  assert.deepEqual([r.ok, r.reason, r.move, r.restored, r.retired], [false, "write_failed", "retry_failed_restored", true, false]);
  assert.deepEqual(r.legacyKeysDeleted, []);
  assert.equal(s.getItem("ams_calphoto"), raw, "legacy byte-identical");
  assert.equal(s.getItem("asa:ams:calphoto"), null, "no partial new key");
  assert.equal(s.getItem("asa:ams:_migrated"), markerBytes, "nothing recorded");
  assert.deepEqual(s.calls.remove, ["ams_calphoto"]);
  assert.equal(s.calls.set[s.calls.set.length - 1], "ams_calphoto", "restore is the last write");
  assert.equal(asa.get(s, "ams", "calphoto").source, "legacy", "reads still fall back to legacy");
  const sup = deferredUser();
  sup.s.limit = 100 * sup.raw.length;
  const firstSave = withPhoto(sup.raw, "FIRST");
  asa.set(sup.s, "ams", "calphoto", firstSave);
  asa.reconcile(sup.s, "ams", { now: LATER });
  sup.s.limit = sup.s.used() + 64;
  const supMarker = sup.s.getItem("asa:ams:_migrated");
  assert.equal(asa.setSafeMove(sup.s, "ams", "calphoto", withPhoto(sup.raw, "Y".repeat(sup.raw.length + 1000)), { expectLegacyFp: sup.fp }).move, "retry_failed_restored");
  assert.equal(sup.s.getItem("asa:ams:_migrated"), supMarker);
  assert.equal(sup.s.getItem("ams_calphoto"), sup.raw);
  assert.equal(sup.s.getItem("asa:ams:calphoto"), JSON.stringify(firstSave), "a present new key keeps its last saved bytes");
});

test("setSafeMove: any exception between the remove and the write restores legacy byte-identical (try/finally)", () => {
  const armed = (failKeys, err) => {
    let on = false;
    return {
      afterRemove(k) { if (k === "ams_calphoto") on = true; },
      beforeSet(k) { if (on && failKeys.includes(k)) { failKeys.splice(failKeys.indexOf(k), 1); throw err(); } }
    };
  };
  const raw = bigPhotos(asa.LARGE_COPY_CHARS);
  const mk = (hooks) => { const s = qmem(Object.assign({ ams_calphoto: raw }, PROTECTED_SEED), Math.floor(raw.length * 1.8), hooks); s.readFp = readFpOf(asa.reconcile(s, "ams", { now: NOW })); return s; };
  const save = (st, tag) => asa.setSafeMove(st, "ams", "calphoto", withPhoto(raw, tag), { expectLegacyFp: st.readFp });
  const a = mk(armed(["asa:ams:calphoto"], () => new Error("forced (test)")));
  const ra = save(a, "A");
  assert.deepEqual([ra.ok, ra.move, ra.restored], [false, "retry_failed_restored", true]);
  assert.equal(a.getItem("ams_calphoto"), raw);
  assert.equal(a.getItem("asa:ams:calphoto"), null);
  const rb = save(a, "A");
  assert.deepEqual([rb.ok, rb.move], [true, "retired"], "the next save moves cleanly once nothing interferes");
  let removedThenThrew = false;
  const b = mk({ afterRemove(k) { if (k === "ams_calphoto" && !removedThenThrew) { removedThenThrew = true; throw new Error("remove threw after removing (test)"); } } });
  const rc = save(b, "B");
  assert.deepEqual([rc.ok, rc.move, rc.restored], [false, "retry_failed_restored", true]);
  assert.equal(b.getItem("ams_calphoto"), raw);
  const c = mk(armed(["asa:ams:calphoto"], () => new TypeError("programming error (test)")));
  assert.throws(() => save(c, "C"), /programming error/);
  assert.equal(c.getItem("ams_calphoto"), raw, "restored before the TypeError propagates");
  const e = mk(armed(["asa:ams:_migrated"], () => new DOMException("quota (test)", "QuotaExceededError")));
  const eMarker = e.getItem("asa:ams:_migrated");
  const re = save(e, "E");
  assert.deepEqual([re.ok, re.move, re.restored, re.markerRestored], [false, "marker_failed_restored", true, true], "no retirement without its record");
  assert.equal(e.getItem("ams_calphoto"), raw);
  assert.equal(e.getItem("asa:ams:_migrated"), eMarker);
  assert.equal(e.getItem("asa:ams:calphoto"), null);
  const d = mk(armed(["asa:ams:calphoto", "ams_calphoto"], () => new DOMException("quota (test)", "QuotaExceededError")));
  const dMarker = d.getItem("asa:ams:_migrated");
  const rd = save(d, "D");
  assert.deepEqual([rd.ok, rd.reason, rd.move, rd.restored, rd.markerRestored], [false, "restore_failed", "restore_failed", false, true], "a failed restore is reported, never silent");
  assert.equal(d.getItem("asa:ams:_migrated"), dMarker, "the marker never claims a retirement that did not commit");
  for (const st of [a, b, c, d, e]) for (const [k, v] of Object.entries(PROTECTED_SEED)) assert.equal(st.getItem(k), v, k);
  for (const st of [b, c, e]) assert.equal(asa.readMarker(st, "ams").value.keys.ams_calphoto.state, "deferred", "marker rolled back");
});

test("setSafeMove (review LOW): a TypeError on the retry together with a failed restore is reported as restore_failed, not thrown", () => {
  // Rethrowing here made the page wrapper (catch → false, unsaved stays false) say "your saved photos are
  // unchanged" while ams_calphoto was gone. The failed restore must win so the page shows the honest message.
  const raw = bigPhotos(asa.LARGE_COPY_CHARS);
  let on = false;
  const fail = ["asa:ams:calphoto", "ams_calphoto"];
  const s = qmem(Object.assign({ ams_calphoto: raw }, PROTECTED_SEED), Math.floor(raw.length * 1.8), {
    afterRemove(k) { if (k === "ams_calphoto") on = true; },
    beforeSet(k) { if (on && fail.includes(k)) { fail.splice(fail.indexOf(k), 1); throw new TypeError("programming error on the retry (test)"); } }
  });
  const fp = readFpOf(asa.reconcile(s, "ams", { now: NOW }));
  const markerBytes = s.getItem("asa:ams:_migrated");
  let r = null;
  assert.doesNotThrow(() => { r = asa.setSafeMove(s, "ams", "calphoto", withPhoto(raw, "T"), { expectLegacyFp: fp }); });
  assert.deepEqual([r.ok, r.reason, r.move, r.restored, r.markerRestored, r.retired], [false, "restore_failed", "restore_failed", false, true, false]);
  assert.deepEqual(r.legacyKeysDeleted, []);
  assert.equal(s.getItem("ams_calphoto"), null, "the restore really failed (the case the page must report)");
  assert.equal(s.getItem("asa:ams:calphoto"), null);
  assert.equal(s.getItem("asa:ams:_migrated"), markerBytes, "no retirement record for a move that did not commit");
  assert.deepEqual(fail, [], "both forced failures hit: the retry and the restore");
  for (const [k, v] of Object.entries(PROTECTED_SEED)) assert.equal(s.getItem(k), v, k);
  // Page contract: ASA_ST.set reads r.reason; "restore_failed" switches full() to the honest message.
  const page = read("amsterdam/index.html");
  assert.match(page, /unsaved=\(d==="calphoto"&&r\.reason==="restore_failed"\); return r\.ok===true; \}catch\(e\)\{ return false; \}/);
});

test("setSafeMove: nothing is removed unless the marker accounts for the current legacy bytes", () => {
  const raw = bigPhotos(asa.LARGE_COPY_CHARS);
  const tight = (seed) => qmem(seed, Math.floor(raw.length * 1.8));
  const next = withPhoto(raw, "N");
  // Each guard is proven on its own: the caller claims to have read exactly the bytes stored now.
  const expectKept = (s, move, domain = "calphoto", city = "ams", value = next) => {
    const before = s.dump();
    const cur = s.getItem("ams_calphoto");
    const r = asa.setSafeMove(s, city, domain, value, { expectLegacyFp: cur === null ? undefined : asa.fingerprint(cur) });
    assert.deepEqual([r.ok, r.move, r.retired], [false, move, false], move);
    assert.deepEqual(s.calls.remove, [], move + ": no removal");
    for (const k of Object.keys(before)) if (!k.startsWith("asa:")) assert.equal(s.getItem(k), before[k], move + ": " + k);
  };
  expectKept(tight({ ams_calphoto: raw }), "not_accounted"); // no marker at all
  expectKept(tight({ ams_calphoto: raw, "asa:ams:_migrated": "{}" }), "not_accounted"); // invalid marker
  const changed = tight({ ams_calphoto: raw });
  asa.reconcile(changed, "ams", { now: NOW });
  changed.setItem("ams_calphoto", bigPhotos(asa.LARGE_COPY_CHARS + 4)); // an old tab wrote legacy after load
  expectKept(changed, "changed_since_marker");
  const conflict = tight({ ams_calphoto: raw, "asa:ams:calphoto": bigPhotos(32) });
  assert.equal(asa.reconcile(conflict, "ams", { now: NOW }).conflicts.length, 1);
  expectKept(conflict, "not_accounted");
  asa.acknowledge(conflict, "ams", { conflicts: true });
  assert.equal(asa.readMarker(conflict, "ams").value.keys.ams_calphoto.state, "acknowledged");
  expectKept(conflict, "not_accounted");
  const small = '{"g1":["data:image/gif;base64,AAAA"]}';
  const failedCopy = qmem({ ams_calphoto: small }, 1000, { beforeSet(k) { if (k === "asa:ams:calphoto") throw new DOMException("quota (test)", "QuotaExceededError"); } });
  assert.equal(asa.reconcile(failedCopy, "ams", { now: NOW }).marker.keys.ams_calphoto.state, "copy_failed");
  expectKept(failedCopy, "not_accounted", "calphoto", "ams", { g1: [] });
  const corrupt = qmem({ ams_calphoto: "{bozuk" }, 400);
  asa.reconcile(corrupt, "ams", { now: NOW });
  corrupt.limit = corrupt.used();
  expectKept(corrupt, "not_accounted", "calphoto", "ams", { g1: ["data:image/gif;base64,AAAA"] });
  const io = qmem({ ams_calphoto: raw }, raw.length * 4, { beforeSet(k) { if (k === "asa:ams:calphoto") throw new Error("io (test)"); } });
  asa.reconcile(io, "ams", { now: NOW });
  expectKept(io, "not_quota");
  const none = qmem({}, 300);
  asa.reconcile(none, "ams", { now: NOW });
  expectKept(none, "no_legacy", "calphoto", "ams", { g1: ["x".repeat(400)] });
  const fav = qmem({ ams_fav: '["a","b"]' }, 400);
  asa.reconcile(fav, "ams", { now: NOW });
  fav.limit = fav.used();
  expectKept(fav, "not_movable", "fav", "ams", ["a", "b", "c".repeat(64)]);
  const cph = tight({ ams_calphoto: raw, asa_trip: trip("Kopenhag") });
  asa.reconcile(cph, "ams", { now: NOW });
  expectKept(cph, "not_movable", "calphoto", "cph");
});

test("setSafeMove (review MEDIUM): a stale reader never retires legacy bytes it did not read, even after another reconcile re-recorded the marker", () => {
  // Tab A loads (reads L, marker fp(L)) → an old pre-WP3 tab writes L2 → another WP3 reconcile (second Amsterdam
  // tab, or the homepage choosing Amsterdam) re-records the marker as deferred fp(L2) → Tab A saves at quota.
  const { s, raw, fp: tabA } = deferredUser();
  const oldTab = JSON.stringify({ g1: photoList(raw).concat(["data:image/jpeg;base64,OLDTAB"]) });
  s.setItem("ams_calphoto", oldTab);
  const tabB = asa.reconcile(s, "ams", { now: LATER });
  assert.deepEqual([tabB.marker.keys.ams_calphoto.state, tabB.marker.keys.ams_calphoto.fp], ["deferred", asa.fingerprint(oldTab)], "the shared marker now vouches for L2");
  assert.notEqual(tabA, asa.fingerprint(oldTab));
  const before = s.dump();
  const nextA = withPhoto(raw, "TAB_A");
  assert.equal(asa.set(s, "ams", "calphoto", nextA).reason, "write_failed", "quota: the move would be needed");
  const r = asa.setSafeMove(s, "ams", "calphoto", nextA, { now: LATER, expectLegacyFp: tabA });
  assert.deepEqual([r.ok, r.reason, r.move, r.retired, r.restored], [false, "write_failed", "changed_since_read", false, null]);
  assert.deepEqual(r.legacyKeysDeleted, []);
  assert.deepEqual(s.calls.remove, [], "no removal");
  assert.equal(s.getItem("ams_calphoto"), oldTab, "the old tab's photos stay byte-identical");
  assert.deepEqual(s.dump(), before, "nothing changed at all");
  assert.equal(asa.setSafeMove(s, "ams", "calphoto", nextA).move, "changed_since_read", "no expectLegacyFp → never removes");
  assert.equal(asa.setSafeMove(s, "ams", "calphoto", nextA, { expectLegacyFp: 42 }).move, "changed_since_read", "a non-string fp counts as absent");
  assert.deepEqual(s.calls.remove, []);
  // The tab that did read L2 (Tab B) may move it: its value derives from those bytes.
  const nextB = withPhoto(oldTab, "TAB_B");
  const rb = asa.setSafeMove(s, "ams", "calphoto", nextB, { now: LATER, expectLegacyFp: readFpOf(tabB) });
  assert.deepEqual([rb.ok, rb.move], [true, "retired"]);
  assert.deepEqual(asa.readMarker(s, "ams").value.keys.ams_calphoto, { fp: asa.fingerprint(oldTab), state: "retired", at: LATER, from: "deferred" });
  assert.deepEqual(asa.get(s, "ams", "calphoto").value, nextB);
});

test("setSafeMove is never part of page load: reconcile on a full storage never removes legacy", () => {
  const { s, raw } = deferredUser({ asa_plan_prefs: '{"tempo":"Sakin"}' });
  s.limit = s.used();
  for (const when of [NOW, LATER, "2026-10-09T10:00:00.000Z"]) asa.reconcile(s, "ams", { now: when });
  asa.migrate(s, "ams");
  asa.acknowledge(s, "ams", { conflicts: true, stranded: true });
  asa.clearCity(s, "ams");
  assert.deepEqual(s.calls.remove.filter((k) => !k.startsWith("asa:ams:")), [], "no legacy key removed outside setSafeMove");
  assert.equal(s.getItem("ams_calphoto"), raw);
});

test("after a retirement, legacy written again by the pre-WP3 page is a conflict: new kept, legacy kept", () => {
  const { s, raw, fp } = deferredUser();
  const next = withPhoto(raw, "NEW");
  assert.equal(asa.setSafeMove(s, "ams", "calphoto", next, { now: LATER, expectLegacyFp: fp }).move, "retired");
  s.limit = 100 * raw.length;
  const oldPage = '{"2026-11-02":["data:image/jpeg;base64,OLDPAGE"]}';
  s.setItem("ams_calphoto", oldPage);
  const r = asa.reconcile(s, "ams", { now: "2026-10-09T10:00:00.000Z" });
  assert.equal(readFpOf(r), asa.fingerprint(oldPage), "this reload read the old page's bytes");
  assert.deepEqual(r.conflicts.map((c) => c.legacyKey), ["ams_calphoto"]);
  assert.equal(r.marker.legacy_kept, true, "a legacy key is present again");
  assert.deepEqual(asa.get(s, "ams", "calphoto").value, next, "new stays authoritative");
  assert.equal(s.getItem("ams_calphoto"), oldPage);
  s.limit = s.used();
  assert.equal(asa.setSafeMove(s, "ams", "calphoto", withPhoto(raw, "MORE"), { expectLegacyFp: readFpOf(r) }).move, "not_accounted", "a conflicting legacy value is never retired, even by a tab that read it");
  assert.equal(s.getItem("ams_calphoto"), oldPage);
});

test("source: the only legacy removal is the guarded ams_calphoto safe move; no generic delete API", () => {
  const src = read("lib/asa-storage/asa_storage.js");
  assert.equal((src.match(/\.removeItem\(/g) || []).length, 2, "removeCityKey + the guarded safe-move remove");
  assert.match(src, /var SAFE_MOVE = \{ calphoto: "ams_calphoto" \};/);
  assert.match(src, /function removeSafeMoveLegacy\(storage, legacyKey\) \{\s*if \(legacyKey !== SAFE_MOVE\.calphoto\) throw new TypeError\("refusing_legacy_remove"\);\s*storage\.removeItem\(legacyKey\);/);
  assert.equal((src.match(/removeSafeMoveLegacy\(/g) || []).length, 2, "defined once, called once");
  const body = (name, next) => src.slice(src.indexOf("function " + name + "("), src.indexOf("function " + next + "("));
  for (const [fn, nx] of [["reconcile", "acknowledge"], ["acknowledge", "adoptLegacy"], ["migrate", "clearCity"]]) {
    const b = body(fn, nx);
    assert.ok(b.length > 100, fn);
    assert.equal(/removeSafeMoveLegacy|setSafeMove|removeItem/.test(b), false, fn + " never removes legacy");
  }
  for (const name of ["retireLegacy", "deleteLegacy", "removeLegacy"]) assert.equal(asa[name], undefined, name);
  assert.equal(typeof asa.setSafeMove, "function");
});

test("WP3 wiring: the Amsterdam page uses setSafeMove for photo saves only; the homepage never", () => {
  const city = read("amsterdam/index.html");
  assert.equal((city.match(/LIB\.setSafeMove\(/g) || []).length, 1, "one call site");
  assert.match(city, /function set\(d,v\)\{ unsaved=false; if\(mode!=="ok"\)return false; try\{ var r=\(d==="calphoto"&&typeof LIB\.setSafeMove==="function"\)\?LIB\.setSafeMove\(LS,CODE,d,v,\{expectLegacyFp:readFp\}\):LIB\.set\(LS,CODE,d,v\);/);
  // readFp is bound once, from this tab's own load-time reconcile, and never reassigned afterwards.
  assert.match(city, /rep=LIB\.reconcile\(LS,CODE\); \}catch\(e\)\{ rep=null; mode="unavailable"; \} try\{ var pe=rep&&rep\.marker&&rep\.marker\.keys&&rep\.marker\.keys\.ams_calphoto; readFp=\(pe&&typeof pe\.fp==="string"&&pe\.state!=="retired"\)\?pe\.fp:null; \}catch\(e\)\{ readFp=null; \} \}/);
  assert.equal((city.match(/readFp=/g) || []).length, 3, "declared null, set from the load reconcile, reset on error — nowhere else");
  assert.equal(/LIB\.reconcile\(LS,CODE\)[^\n]*setSafeMove/.test(city), false, "not on the load line");
  assert.equal(read("index.html").includes("setSafeMove"), false);
});
