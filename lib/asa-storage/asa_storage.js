/* =====================================================================
 * ASALOCAL · asa_storage.js — browser-storage city isolation (INERT)
 *
 * NOT WIRED. Live pages must not load this file. Merging the module does
 * not change homepage, Amsterdam, Kopenhag, or admin storage behavior.
 * Production wiring and legacy-key retirement need a separate EVET.
 *
 * Key form: asa:<cityCode>:<domain>
 * City codes: ams | cph
 * Trip policy A: one city-scoped trip key. Legacy asa_trip is placed by
 * its JSON city field (Amsterdam→ams, Kopenhag/Copenhagen/København→cph).
 * Missing or unknown city defaults to ams and is reported. The other
 * city's trip key is not written.
 *
 * Legacy ams_fav, ams_cal, ams_plan, ams_dayven, ams_calphoto map ONLY
 * to asa:ams:<domain>. They are never readable as cph data.
 *
 * Migration version 1 (explicit migrate() only):
 * - get: new key first; if absent, legacy fallback when that blob belongs
 *   to the requested city. get never writes.
 * - set: writes the new key only (no dual-write).
 * - Idempotent: a present new key is not overwritten, even if corrupt.
 * - Corrupt or unknown values are not copied, deleted, or overwritten.
 * - Legacy keys are never removed. isLegacyCopyVerified is a predicate
 *   for a future EVET; this module has no legacy-delete API.
 * - clearCity removes registered asa:<city>:<domain> keys only.
 *   It does not call storage.clear and does not remove legacy or shared keys.
 *
 * Left untouched (not city-scoped):
 * - asa_session
 * - sb-<ref>-auth-token and sb-<ref>-auth-token-code-verifier
 * - asa-admin-auth
 * - asa_cookie_decision_v2 (consent non-goal)
 * ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AsaStorage = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var MIGRATION_VERSION = 1;
  var TRIP_POLICY = "A";
  var CITY_CODES = ["ams", "cph"];
  var DOMAIN_NAMES = ["trip", "plan_prefs", "fav", "cal", "plan", "dayven", "calphoto"];

  var REGISTRY = {
    trip: { shape: "object", legacyKey: "asa_trip", legacyMap: "trip-city" },
    plan_prefs: { shape: "object", legacyKey: "asa_plan_prefs", legacyMap: "follow-trip" },
    fav: { shape: "array", legacyKey: "ams_fav", legacyMap: "ams-only" },
    cal: { shape: "object", legacyKey: "ams_cal", legacyMap: "ams-only" },
    plan: { shape: "object", legacyKey: "ams_plan", legacyMap: "ams-only" },
    dayven: { shape: "object", legacyKey: "ams_dayven", legacyMap: "ams-only" },
    calphoto: { shape: "object", legacyKey: "ams_calphoto", legacyMap: "ams-only" }
  };

  var PROTECTED_EXACT = {
    "asa_session": "shared-auth-cache",
    "asa-admin-auth": "admin-session",
    "asa_cookie_decision_v2": "consent-inert-non-goal"
  };

  function isCityCode(cityCode) {
    return cityCode === "ams" || cityCode === "cph";
  }

  function isDomain(domain) {
    return Object.prototype.hasOwnProperty.call(REGISTRY, domain);
  }

  function assertCity(cityCode) {
    if (!isCityCode(cityCode)) throw new TypeError("invalid_city");
  }

  function assertDomain(domain) {
    if (!isDomain(domain)) throw new TypeError("invalid_domain");
  }

  function assertStorage(storage) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") {
      throw new TypeError("invalid_storage");
    }
  }

  function key(cityCode, domain) {
    assertCity(cityCode);
    assertDomain(domain);
    return "asa:" + cityCode + ":" + domain;
  }

  function keysFor(cityCode) {
    assertCity(cityCode);
    var out = [];
    for (var i = 0; i < DOMAIN_NAMES.length; i++) {
      var domain = DOMAIN_NAMES[i];
      out.push({ domain: domain, key: key(cityCode, domain), legacyKey: REGISTRY[domain].legacyKey, legacyMap: REGISTRY[domain].legacyMap, shape: REGISTRY[domain].shape });
    }
    return out;
  }

  function cityCodeFromLabel(label) {
    if (label == null) return null;
    var s = String(label).replace(/^\s+|\s+$/g, "").toLowerCase();
    if (!s) return null;
    if (s === "amsterdam" || s === "ams") return "ams";
    if (s === "kopenhag" || s === "copenhagen" || s === "københavn" || s === "kobenhavn" || s === "cph") return "cph";
    return null;
  }

  function isAuthTokenKey(storageKey) {
    return typeof storageKey === "string" && /^sb-[a-z0-9]+-auth-token(?:-code-verifier)?$/i.test(storageKey);
  }

  function isProtectedKey(storageKey) {
    if (typeof storageKey !== "string") return false;
    if (Object.prototype.hasOwnProperty.call(PROTECTED_EXACT, storageKey)) return true;
    return isAuthTokenKey(storageKey);
  }

  function assertCityDomainKey(storageKey) {
    if (typeof storageKey !== "string") throw new TypeError("refusing_key");
    if (isProtectedKey(storageKey)) throw new TypeError("refusing_protected_key");
    var parts = storageKey.split(":");
    if (parts.length !== 3 || parts[0] !== "asa" || !isCityCode(parts[1]) || !isDomain(parts[2])) {
      throw new TypeError("refusing_key");
    }
    if (storageKey !== key(parts[1], parts[2])) throw new TypeError("refusing_key");
  }

  function writeCityKey(storage, storageKey, value) {
    assertCityDomainKey(storageKey);
    storage.setItem(storageKey, value);
  }

  function removeCityKey(storage, storageKey) {
    assertCityDomainKey(storageKey);
    storage.removeItem(storageKey);
  }

  function classify(raw, shape) {
    if (typeof raw !== "string") return { state: "corrupt", reason: "type" };
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { state: "corrupt", reason: "json" };
    }
    if (shape === "array") {
      if (!Array.isArray(parsed)) return { state: "corrupt", reason: "shape" };
      for (var i = 0; i < parsed.length; i++) {
        if (typeof parsed[i] !== "string") return { state: "corrupt", reason: "shape" };
      }
      return { state: "ok", value: parsed };
    }
    if (shape === "object") {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "corrupt", reason: "shape" };
      return { state: "ok", value: parsed };
    }
    return { state: "corrupt", reason: "shape" };
  }

  function safeLabel(label) {
    if (typeof label !== "string") return null;
    var t = label.replace(/^\s+|\s+$/g, "");
    if (!t || t.length > 64) return null;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c < 32 || c === 127) return null;
    }
    return t;
  }

  function blankLabel(label) {
    if (label == null) return true;
    return String(label).replace(/^\s+|\s+$/g, "") === "";
  }

  function inspectLegacyTrip(storage) {
    var raw = storage.getItem("asa_trip");
    if (raw === null || raw === undefined) {
      return { present: false, valid: false, cityCode: "ams", warning: "trip_missing_default_ams", raw: null, value: null, cityLabel: null };
    }
    var classified = classify(raw, "object");
    if (classified.state !== "ok") {
      return { present: true, valid: false, cityCode: "ams", warning: "trip_corrupt_default_ams", raw: raw, value: null, cityLabel: null };
    }
    var code = cityCodeFromLabel(classified.value.city);
    if (!code) {
      return {
        present: true,
        valid: true,
        cityCode: "ams",
        warning: blankLabel(classified.value.city) ? "trip_city_missing_default_ams" : "unknown_city_default_ams",
        raw: raw,
        value: classified.value,
        cityLabel: safeLabel(classified.value.city)
      };
    }
    return { present: true, valid: true, cityCode: code, warning: null, raw: raw, value: classified.value, cityLabel: safeLabel(classified.value.city) };
  }

  function placementFor(storage, domain) {
    var meta = REGISTRY[domain];
    if (meta.legacyMap === "ams-only") {
      return { cityCode: "ams", warning: null, cityLabel: null };
    }
    var trip = inspectLegacyTrip(storage);
    return { cityCode: trip.cityCode, warning: trip.warning, cityLabel: trip.cityLabel };
  }

  function belongsToCity(storage, domain, cityCode) {
    var place = placementFor(storage, domain);
    return place.cityCode === cityCode;
  }

  function resultBase(cityCode, domain) {
    return {
      ok: false,
      cityCode: cityCode,
      domain: domain,
      key: key(cityCode, domain),
      legacyKey: REGISTRY[domain].legacyKey,
      value: null,
      source: "missing",
      corrupt: false,
      warning: null
    };
  }

  function readPresent(storage, storageKey, shape) {
    var raw = storage.getItem(storageKey);
    if (raw === null || raw === undefined) return { present: false };
    var classified = classify(raw, shape);
    if (classified.state !== "ok") return { present: true, corrupt: true };
    return { present: true, corrupt: false, value: classified.value };
  }

  function get(storage, cityCode, domain) {
    assertStorage(storage);
    assertCity(cityCode);
    assertDomain(domain);
    var out = resultBase(cityCode, domain);
    var shape = REGISTRY[domain].shape;
    var cityRead = readPresent(storage, out.key, shape);
    if (cityRead.present) {
      if (cityRead.corrupt) {
        out.source = "corrupt";
        out.corrupt = true;
        return out;
      }
      out.ok = true;
      out.source = "city";
      out.value = cityRead.value;
      return out;
    }
    var legacyRaw = storage.getItem(out.legacyKey);
    if (legacyRaw === null || legacyRaw === undefined) {
      out.ok = true;
      out.source = "missing";
      return out;
    }
    if (!belongsToCity(storage, domain, cityCode)) {
      out.ok = true;
      out.source = "missing";
      return out;
    }
    var legacy = classify(legacyRaw, shape);
    if (legacy.state !== "ok") {
      out.source = "corrupt";
      out.corrupt = true;
      out.warning = REGISTRY[domain].legacyMap === "ams-only" ? null : placementFor(storage, domain).warning;
      return out;
    }
    var place = placementFor(storage, domain);
    out.ok = true;
    out.source = "legacy";
    out.value = legacy.value;
    out.warning = place.warning;
    return out;
  }

  function set(storage, cityCode, domain, value) {
    assertStorage(storage);
    assertCity(cityCode);
    assertDomain(domain);
    var shape = REGISTRY[domain].shape;
    var encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (e) {
      return { ok: false, reason: "invalid_shape", key: key(cityCode, domain), wroteLegacy: false };
    }
    if (classify(encoded, shape).state !== "ok") {
      return { ok: false, reason: "invalid_shape", key: key(cityCode, domain), wroteLegacy: false };
    }
    try {
      writeCityKey(storage, key(cityCode, domain), encoded);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      return { ok: false, reason: "write_failed", key: key(cityCode, domain), wroteLegacy: false };
    }
    return { ok: true, key: key(cityCode, domain), cityCode: cityCode, domain: domain, wroteLegacy: false };
  }

  function action(fields) {
    return {
      legacyKey: fields.legacyKey,
      domain: fields.domain,
      cityCode: fields.cityCode || null,
      key: fields.key || null,
      status: fields.status,
      warning: fields.warning || null,
      cityLabel: fields.cityLabel || null
    };
  }

  function migrateSlot(storage, domain) {
    var meta = REGISTRY[domain];
    var raw = storage.getItem(meta.legacyKey);
    var place = placementFor(storage, domain);
    var target = key(place.cityCode, domain);
    if (raw === null || raw === undefined) {
      return action({ legacyKey: meta.legacyKey, domain: domain, cityCode: place.cityCode, key: target, status: "absent", warning: null, cityLabel: null });
    }
    var classified = classify(raw, meta.shape);
    if (classified.state !== "ok") {
      return action({ legacyKey: meta.legacyKey, domain: domain, cityCode: null, key: null, status: "skipped_corrupt", warning: meta.legacyMap === "ams-only" ? null : place.warning });
    }
    if (domain === "trip" && !inspectLegacyTrip(storage).valid) {
      return action({ legacyKey: meta.legacyKey, domain: domain, cityCode: null, key: null, status: "skipped_corrupt", warning: place.warning });
    }
    var existing = storage.getItem(target);
    if (existing !== null && existing !== undefined) {
      return action({ legacyKey: meta.legacyKey, domain: domain, cityCode: place.cityCode, key: target, status: "kept_existing", warning: place.warning, cityLabel: place.cityLabel });
    }
    try {
      writeCityKey(storage, target, raw);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      return action({ legacyKey: meta.legacyKey, domain: domain, cityCode: place.cityCode, key: target, status: "write_failed", warning: place.warning, cityLabel: place.cityLabel });
    }
    return action({ legacyKey: meta.legacyKey, domain: domain, cityCode: place.cityCode, key: target, status: "copied", warning: meta.legacyMap === "ams-only" ? null : place.warning, cityLabel: meta.legacyMap === "ams-only" ? null : place.cityLabel });
  }

  function snapshotExact(storage) {
    var names = Object.keys(PROTECTED_EXACT);
    var out = {};
    for (var i = 0; i < names.length; i++) out[names[i]] = storage.getItem(names[i]);
    return out;
  }

  function sameSnapshot(a, b) {
    var names = Object.keys(a);
    for (var i = 0; i < names.length; i++) {
      if (a[names[i]] !== b[names[i]]) return false;
    }
    return true;
  }

  function migrate(storage) {
    assertStorage(storage);
    var before = snapshotExact(storage);
    var actions = [];
    for (var i = 0; i < DOMAIN_NAMES.length; i++) actions.push(migrateSlot(storage, DOMAIN_NAMES[i]));
    var after = snapshotExact(storage);
    if (!sameSnapshot(before, after)) throw new Error("protected_key_changed");
    return {
      migrationVersion: MIGRATION_VERSION,
      tripPolicy: TRIP_POLICY,
      legacyKeysDeleted: [],
      actions: actions
    };
  }

  function clearCity(storage, cityCode) {
    assertStorage(storage);
    assertCity(cityCode);
    var before = snapshotExact(storage);
    var removed = [];
    var absent = [];
    for (var i = 0; i < DOMAIN_NAMES.length; i++) {
      var storageKey = key(cityCode, DOMAIN_NAMES[i]);
      var raw = storage.getItem(storageKey);
      if (raw === null || raw === undefined) absent.push(storageKey);
      else {
        removeCityKey(storage, storageKey);
        removed.push(storageKey);
      }
    }
    var after = snapshotExact(storage);
    if (!sameSnapshot(before, after)) throw new Error("protected_key_changed");
    return { ok: true, cityCode: cityCode, removed: removed, absent: absent, legacyKeysDeleted: [] };
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    var ak = Object.keys(a);
    var bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var j = 0; j < ak.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(b, ak[j])) return false;
      if (!deepEqual(a[ak[j]], b[ak[j]])) return false;
    }
    return true;
  }

  function verification(fields) {
    return {
      legacyKey: fields.legacyKey,
      targetKey: fields.targetKey || null,
      verified: fields.verified === true,
      reason: fields.reason
    };
  }

  function isLegacyCopyVerified(storage, legacyKey) {
    assertStorage(storage);
    if (isProtectedKey(legacyKey)) return verification({ legacyKey: legacyKey, verified: false, reason: "shared_untouched" });
    var domain = null;
    for (var i = 0; i < DOMAIN_NAMES.length; i++) {
      if (REGISTRY[DOMAIN_NAMES[i]].legacyKey === legacyKey) domain = DOMAIN_NAMES[i];
    }
    if (!domain) return verification({ legacyKey: legacyKey, verified: false, reason: "not_legacy" });
    var meta = REGISTRY[domain];
    var raw = storage.getItem(legacyKey);
    if (raw === null || raw === undefined) return verification({ legacyKey: legacyKey, verified: false, reason: "absent" });
    var legacy = classify(raw, meta.shape);
    if (legacy.state !== "ok") return verification({ legacyKey: legacyKey, verified: false, reason: "corrupt_legacy" });
    if (domain === "trip" && !inspectLegacyTrip(storage).valid) {
      return verification({ legacyKey: legacyKey, verified: false, reason: "corrupt_legacy" });
    }
    var place = placementFor(storage, domain);
    var targetKey = key(place.cityCode, domain);
    var targetRaw = storage.getItem(targetKey);
    if (targetRaw === null || targetRaw === undefined) return verification({ legacyKey: legacyKey, targetKey: targetKey, verified: false, reason: "missing_target" });
    var target = classify(targetRaw, meta.shape);
    if (target.state !== "ok") return verification({ legacyKey: legacyKey, targetKey: targetKey, verified: false, reason: "corrupt_target" });
    if (!deepEqual(legacy.value, target.value)) return verification({ legacyKey: legacyKey, targetKey: targetKey, verified: false, reason: "mismatch" });
    return verification({ legacyKey: legacyKey, targetKey: targetKey, verified: true, reason: "match" });
  }

  function describeDomain(domain) {
    assertDomain(domain);
    var meta = REGISTRY[domain];
    return { domain: domain, shape: meta.shape, legacyKey: meta.legacyKey, legacyMap: meta.legacyMap };
  }

  return {
    INERT: true,
    WIRED: false,
    MIGRATION_VERSION: MIGRATION_VERSION,
    TRIP_POLICY: TRIP_POLICY,
    CITY_CODES: CITY_CODES.slice(),
    DOMAIN_NAMES: DOMAIN_NAMES.slice(),
    key: key,
    keysFor: keysFor,
    describeDomain: describeDomain,
    cityCodeFromLabel: cityCodeFromLabel,
    isProtectedKey: isProtectedKey,
    isAuthTokenKey: isAuthTokenKey,
    get: get,
    set: set,
    migrate: migrate,
    clearCity: clearCity,
    isLegacyCopyVerified: isLegacyCopyVerified
  };
});
