/* =====================================================================
 * ASALOCAL · asa_storage.js — browser-storage city isolation
 *
 * WIRED (WP3). Loaded as /lib/asa-storage/asa_storage.js?v=<sha256(16)> by
 * amsterdam/index.html (city "ams": reconcile on load, all reads/writes) and
 * index.html (reconcile + trip write for the chosen city, Trip Policy A).
 * Not loaded by kopenhag/index.html (stub), amsterdam_index_UID.html,
 * amsterdam.html, admin.html or CDP3B/admin.html. The module never touches
 * global browser storage itself: every call receives the storage object.
 *
 * Key form: asa:<cityCode>:<domain>
 * City codes: ams | cph
 * Trip policy A: one city-scoped trip key. Legacy asa_trip is placed by
 * its JSON city field (Amsterdam→ams, Kopenhag/Copenhagen/København→cph).
 * Missing or unknown city defaults to ams and is reported. The other
 * city's trip key is not written. checkTripCity() lets a page refuse a
 * trip whose own city label belongs to another city (fail-safe mismatch).
 *
 * Legacy ams_fav, ams_cal, ams_plan, ams_dayven, ams_calphoto map ONLY
 * to asa:ams:<domain>. They are never readable as cph data.
 *
 * Migration version 1:
 * - get: new key first; if absent, legacy fallback when that blob belongs
 *   to the requested city. get never writes.
 * - set: writes the new key only (no dual-write).
 * - migrate(storage[, cityCode]): copies legacy → new; with cityCode only
 *   the slots that belong to that city are copied (others: "other_city").
 * - Idempotent: a present new key is not overwritten, even if corrupt.
 * - Corrupt or unknown values are not copied, deleted, or overwritten.
 * - Legacy keys are never removed. This module has no legacy-delete API.
 * - reconcile(storage, cityCode): migrate for one city, then keep the
 *   safe-retirement marker asa:<city>:_migrated (version, per-legacy-key
 *   fingerprint + state, verified flag). States: absent | verified |
 *   conflict | acknowledged | corrupt | copy_failed | deferred | superseded
 *   (the page saved over a legacy fallback after a failed or deferred
 *   copy). A legacy value that differs from the new value at first
 *   migration, or that changed after it (old page/tab wrote it), is a
 *   "conflict": the new key stays
 *   authoritative, nothing is overwritten, and the page must tell the user.
 *   acknowledge() records that the user saw it; it writes the marker only.
 *   marker.verified=true means every present legacy key of that city was
 *   copied, matched, and has not changed since — the precondition for a
 *   future, separately approved legacy-key retirement. Nothing is retired.
 * - Large legacy values (over LARGE_COPY_CHARS, in practice ams_calphoto
 *   photo data URLs) are not duplicated by reconcile: state "deferred",
 *   reads use the get() legacy fallback, the page's first save writes the
 *   new key (then "superseded"). Copying would halve free browser storage
 *   while the legacy key must stay. migrate() alone stays eager unless
 *   options.deferAbove is given.
 * - Stranded legacy (plan_prefs): asa_plan_prefs follows the legacy trip
 *   city (policy A placement, unchanged), but only the Amsterdam page ever
 *   wrote it (legacyWriter "ams"). When the legacy trip names another city
 *   and asa:ams:plan_prefs is absent, reconcile(…,"ams") reports it in
 *   `stranded`; nothing is copied automatically. adoptLegacy() copies it
 *   byte-identical into the writer city's key on an explicit user action
 *   (never over a present key, legacy kept); acknowledge({stranded:true})
 *   records that the user declined.
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
    plan_prefs: { shape: "object", legacyKey: "asa_plan_prefs", legacyMap: "follow-trip", legacyWriter: "ams" },
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

  function isLarge(raw, deferAbove) {
    return typeof deferAbove === "number" && deferAbove >= 0 && typeof raw === "string" && raw.length > deferAbove;
  }

  function migrateSlot(storage, domain, deferAbove) {
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
    if (isLarge(raw, deferAbove)) {
      return action({ legacyKey: meta.legacyKey, domain: domain, cityCode: place.cityCode, key: target, status: "deferred", warning: meta.legacyMap === "ams-only" ? null : place.warning, cityLabel: meta.legacyMap === "ams-only" ? null : place.cityLabel });
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

  // options.deferAbove: legacy values longer than this many chars are not
  // copied (status "deferred"); omitted = copy everything (v1 behavior).
  function migrate(storage, cityCode, options) {
    assertStorage(storage);
    if (cityCode !== undefined) assertCity(cityCode);
    var deferAbove = options && typeof options.deferAbove === "number" ? options.deferAbove : undefined;
    var before = snapshotExact(storage);
    var actions = [];
    for (var i = 0; i < DOMAIN_NAMES.length; i++) {
      var domain = DOMAIN_NAMES[i];
      if (cityCode !== undefined) {
        var place = placementFor(storage, domain);
        if (place.cityCode !== cityCode) {
          var raw = storage.getItem(REGISTRY[domain].legacyKey);
          actions.push(action({ legacyKey: REGISTRY[domain].legacyKey, domain: domain, cityCode: place.cityCode, key: key(place.cityCode, domain), status: raw === null || raw === undefined ? "absent" : "other_city", warning: place.warning, cityLabel: place.cityLabel }));
          continue;
        }
      }
      actions.push(migrateSlot(storage, domain, deferAbove));
    }
    var after = snapshotExact(storage);
    if (!sameSnapshot(before, after)) throw new Error("protected_key_changed");
    return {
      migrationVersion: MIGRATION_VERSION,
      tripPolicy: TRIP_POLICY,
      cityCode: cityCode === undefined ? null : cityCode,
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

  /* ---- WP3: trip city check, safe-retirement marker, conflict detection ---- */

  var MARKER_VERSION = 1;
  var MARKER_DOMAIN = "_migrated";
  var KEY_STATES = ["absent", "verified", "conflict", "acknowledged", "corrupt", "copy_failed", "deferred", "superseded"];
  // reconcile() does not duplicate legacy values longer than this (≈10% of a
  // 5,242,880-char per-origin browser storage quota); see "deferred" in the header.
  var LARGE_COPY_CHARS = 524288;

  function markerKey(cityCode) {
    assertCity(cityCode);
    return "asa:" + cityCode + ":" + MARKER_DOMAIN;
  }

  function writeMarkerKey(storage, cityCode, value) {
    storage.setItem(markerKey(cityCode), value);
  }

  // Change detector for a stored string (FNV-1a 32 + length). Not a security hash.
  function fingerprint(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    var hex = h.toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return "fnv1a32:" + hex + ":" + s.length;
  }

  function validMarker(value, cityCode) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (value.v !== MARKER_VERSION || value.city !== cityCode) return false;
    if (!value.keys || typeof value.keys !== "object" || Array.isArray(value.keys)) return false;
    var names = Object.keys(value.keys);
    for (var i = 0; i < names.length; i++) {
      var e = value.keys[names[i]];
      if (!e || typeof e !== "object" || KEY_STATES.indexOf(e.state) < 0) return false;
      if (e.fp !== null && typeof e.fp !== "string") return false;
    }
    return true;
  }

  function readMarker(storage, cityCode) {
    assertStorage(storage);
    var k = markerKey(cityCode);
    var raw = storage.getItem(k);
    if (raw === null || raw === undefined) return { key: k, present: false, valid: false, value: null };
    var parsed = classify(raw, "object");
    if (parsed.state !== "ok" || !validMarker(parsed.value, cityCode)) return { key: k, present: true, valid: false, value: null };
    return { key: k, present: true, valid: true, value: parsed.value };
  }

  function checkTripCity(value, cityCode) {
    assertCity(cityCode);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { match: false, reason: "not_a_trip", cityCode: null, cityLabel: null };
    if (blankLabel(value.city)) return { match: true, reason: "city_missing_policy_a", cityCode: cityCode, cityLabel: null };
    var code = cityCodeFromLabel(value.city);
    if (code === cityCode) return { match: true, reason: "same_city", cityCode: code, cityLabel: safeLabel(value.city) };
    return { match: false, reason: code ? "other_city" : "unknown_city", cityCode: code, cityLabel: safeLabel(value.city) };
  }

  // A trip this city page must not show as its own: the city trip key carries
  // another city's label, or (no city trip) the legacy asa_trip does.
  function findTripMismatch(storage, cityCode) {
    assertStorage(storage);
    assertCity(cityCode);
    var cityKey = key(cityCode, "trip");
    var cityRaw = storage.getItem(cityKey);
    if (cityRaw !== null && cityRaw !== undefined) {
      var c = classify(cityRaw, "object");
      if (c.state !== "ok") return null;
      var chk = checkTripCity(c.value, cityCode);
      if (chk.match) return null;
      return { domain: "trip", source: "city", key: cityKey, reason: chk.reason, otherCityCode: chk.cityCode, cityLabel: chk.cityLabel, fp: fingerprint(cityRaw) };
    }
    var legacy = inspectLegacyTrip(storage);
    if (!legacy.present || !legacy.valid) return null;
    var lchk = checkTripCity(legacy.value, cityCode);
    if (lchk.match) return null;
    return { domain: "trip", source: "legacy", key: "asa_trip", reason: lchk.reason, otherCityCode: lchk.cityCode, cityLabel: lchk.cityLabel, fp: fingerprint(legacy.raw) };
  }

  function keyState(storage, cityCode, domain, prevEntry, deferAbove) {
    var meta = REGISTRY[domain];
    var raw = storage.getItem(meta.legacyKey);
    if (raw === null || raw === undefined) return { fp: null, state: "absent" };
    var fp = fingerprint(raw);
    var legacy = classify(raw, meta.shape);
    if (legacy.state !== "ok" || (domain === "trip" && !inspectLegacyTrip(storage).valid)) return { fp: fp, state: "corrupt" };
    var targetRaw = storage.getItem(key(cityCode, domain));
    if (targetRaw === null || targetRaw === undefined) return { fp: fp, state: isLarge(raw, deferAbove) ? "deferred" : "copy_failed" };
    var same = prevEntry && prevEntry.fp === fp;
    if (same && (prevEntry.state === "verified" || prevEntry.state === "acknowledged" || prevEntry.state === "superseded")) {
      return { fp: fp, state: prevEntry.state };
    }
    // The page read legacy via get() fallback while the copy was missing
    // (failed or deferred) and then saved: the new value derives from it.
    if (same && (prevEntry.state === "copy_failed" || prevEntry.state === "deferred")) return { fp: fp, state: "superseded" };
    var target = classify(targetRaw, meta.shape);
    if (target.state !== "ok") return { fp: fp, state: "conflict", reason: "new_unreadable" };
    if (deepEqual(legacy.value, target.value)) return { fp: fp, state: "verified" };
    return { fp: fp, state: "conflict", reason: "differs" };
  }

  function cleanAckMap(value) {
    var out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    var names = Object.keys(value);
    for (var i = 0; i < names.length; i++) if (typeof value[names[i]] === "string") out[names[i]] = value[names[i]];
    return out;
  }

  // Legacy values written only by this city's page but placed in another
  // city by the legacy trip label, while this city's key is absent. Reads the
  // legacy key, asa_trip and this city's key only (never the other city's).
  function strandedFor(storage, cityCode, ackMap) {
    var out = [];
    for (var i = 0; i < DOMAIN_NAMES.length; i++) {
      var domain = DOMAIN_NAMES[i];
      var meta = REGISTRY[domain];
      if (meta.legacyMap !== "follow-trip" || meta.legacyWriter !== cityCode) continue;
      var raw = storage.getItem(meta.legacyKey);
      if (raw === null || raw === undefined || classify(raw, meta.shape).state !== "ok") continue;
      var place = placementFor(storage, domain);
      if (place.cityCode === cityCode) continue;
      var own = storage.getItem(key(cityCode, domain));
      if (own !== null && own !== undefined) continue;
      var fp = fingerprint(raw);
      out.push({ domain: domain, legacyKey: meta.legacyKey, key: key(cityCode, domain), placedCityCode: place.cityCode, cityLabel: place.cityLabel, fp: fp, acknowledged: !!ackMap && ackMap[meta.legacyKey] === fp });
    }
    return out;
  }

  function markerBody(m) {
    var out = {};
    var names = Object.keys(m);
    for (var i = 0; i < names.length; i++) if (names[i] !== "updated_at") out[names[i]] = m[names[i]];
    return out;
  }

  function reconcile(storage, cityCode, options) {
    assertStorage(storage);
    assertCity(cityCode);
    var now = options && typeof options.now === "string" ? options.now : new Date().toISOString();
    var deferAbove = options && typeof options.deferAbove === "number" ? options.deferAbove : LARGE_COPY_CHARS;
    var before = snapshotExact(storage);
    var prevRead = readMarker(storage, cityCode);
    var prev = prevRead.valid ? prevRead.value : null;
    var migration = migrate(storage, cityCode, { deferAbove: deferAbove });
    var keys = {};
    var conflicts = [];
    var verified = true;
    for (var i = 0; i < DOMAIN_NAMES.length; i++) {
      var domain = DOMAIN_NAMES[i];
      var meta = REGISTRY[domain];
      if (placementFor(storage, domain).cityCode !== cityCode) continue;
      var entry = keyState(storage, cityCode, domain, prev && Object.prototype.hasOwnProperty.call(prev.keys, meta.legacyKey) ? prev.keys[meta.legacyKey] : null, deferAbove);
      keys[meta.legacyKey] = entry;
      if (entry.state === "conflict") conflicts.push({ domain: domain, legacyKey: meta.legacyKey, key: key(cityCode, domain), reason: entry.reason });
      if (entry.state !== "verified" && entry.state !== "absent") verified = false;
    }
    var mismatch = findTripMismatch(storage, cityCode);
    var next = {
      v: MARKER_VERSION,
      policy: TRIP_POLICY,
      city: cityCode,
      legacy_kept: true,
      verified: verified,
      keys: keys,
      mismatch_ack: prev && typeof prev.mismatch_ack === "string" ? prev.mismatch_ack : null,
      stranded_ack: cleanAckMap(prev && prev.stranded_ack),
      first_at: prev && typeof prev.first_at === "string" ? prev.first_at : now,
      updated_at: now
    };
    var changed = !prev || !deepEqual(markerBody(prev), markerBody(next));
    var markerWritten = false;
    var markerError = null;
    if (changed) {
      try {
        writeMarkerKey(storage, cityCode, JSON.stringify(next));
        markerWritten = true;
      } catch (e) {
        if (e instanceof TypeError) throw e;
        markerError = "write_failed";
      }
    } else {
      next.updated_at = prev.updated_at;
    }
    if (mismatch) mismatch.acknowledged = mismatch.fp === next.mismatch_ack;
    var stranded = strandedFor(storage, cityCode, next.stranded_ack);
    var after = snapshotExact(storage);
    if (!sameSnapshot(before, after)) throw new Error("protected_key_changed");
    return {
      migrationVersion: MIGRATION_VERSION,
      tripPolicy: TRIP_POLICY,
      cityCode: cityCode,
      markerKey: markerKey(cityCode),
      firstRun: !prev,
      markerWritten: markerWritten,
      markerError: markerError,
      marker: next,
      verified: verified,
      actions: migration.actions,
      conflicts: conflicts,
      mismatch: mismatch,
      stranded: stranded,
      legacyKeysDeleted: []
    };
  }

  // Records that the user saw the conflict / mismatch notice. Writes the
  // marker key only; data keys (new and legacy) are never changed.
  function acknowledge(storage, cityCode, options) {
    assertStorage(storage);
    assertCity(cityCode);
    var o = options || {};
    var read = readMarker(storage, cityCode);
    if (!read.valid) return { ok: false, reason: "no_marker", acknowledged: [], mismatchAcknowledged: false, wrote: false };
    var m = read.value;
    var acked = [];
    if (o.conflicts === true) {
      var names = Object.keys(m.keys);
      for (var i = 0; i < names.length; i++) {
        if (m.keys[names[i]].state === "conflict") {
          m.keys[names[i]] = { fp: m.keys[names[i]].fp, state: "acknowledged" };
          acked.push(names[i]);
        }
      }
    }
    var sAcked = [];
    if (o.stranded === true) {
      var ackMap = cleanAckMap(m.stranded_ack);
      var open = strandedFor(storage, cityCode, ackMap);
      for (var j = 0; j < open.length; j++) {
        if (!open[j].acknowledged) {
          ackMap[open[j].legacyKey] = open[j].fp;
          sAcked.push(open[j].legacyKey);
        }
      }
      m.stranded_ack = ackMap;
    }
    var mm = false;
    if (typeof o.mismatchFp === "string" && o.mismatchFp) {
      var cur = findTripMismatch(storage, cityCode);
      if (cur && cur.fp === o.mismatchFp) {
        m.mismatch_ack = cur.fp;
        mm = true;
      }
    }
    if (!acked.length && !mm && !sAcked.length) return { ok: true, acknowledged: [], mismatchAcknowledged: false, strandedAcknowledged: [], wrote: false };
    m.updated_at = typeof o.now === "string" ? o.now : new Date().toISOString();
    try {
      writeMarkerKey(storage, cityCode, JSON.stringify(m));
    } catch (e) {
      if (e instanceof TypeError) throw e;
      return { ok: false, reason: "write_failed", acknowledged: [], mismatchAcknowledged: false, strandedAcknowledged: [], wrote: false };
    }
    return { ok: true, acknowledged: acked, mismatchAcknowledged: mm, strandedAcknowledged: sAcked, wrote: true };
  }

  // Explicit user action only: copy a stranded legacy value (see header)
  // byte-identical into this city's key. Never overwrites a present key and
  // never touches the legacy key, the other city or protected keys.
  function adoptLegacy(storage, cityCode, domain) {
    assertStorage(storage);
    assertCity(cityCode);
    assertDomain(domain);
    var meta = REGISTRY[domain];
    var target = key(cityCode, domain);
    var out = { ok: false, reason: null, key: target, legacyKey: meta.legacyKey, fp: null, wroteLegacy: false };
    if (meta.legacyMap !== "follow-trip" || meta.legacyWriter !== cityCode) { out.reason = "not_adoptable"; return out; }
    var existing = storage.getItem(target);
    if (existing !== null && existing !== undefined) { out.reason = "kept_existing"; return out; }
    var raw = storage.getItem(meta.legacyKey);
    if (raw === null || raw === undefined) { out.reason = "absent"; return out; }
    if (classify(raw, meta.shape).state !== "ok") { out.reason = "corrupt"; return out; }
    if (placementFor(storage, domain).cityCode === cityCode) { out.reason = "not_stranded"; return out; }
    var before = snapshotExact(storage);
    try {
      writeCityKey(storage, target, raw);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      out.reason = "write_failed";
      return out;
    }
    var after = snapshotExact(storage);
    if (!sameSnapshot(before, after)) throw new Error("protected_key_changed");
    out.ok = true;
    out.reason = "adopted";
    out.fp = fingerprint(raw);
    return out;
  }

  return {
    INERT: false,
    WIRED: true,
    MIGRATION_VERSION: MIGRATION_VERSION,
    MARKER_VERSION: MARKER_VERSION,
    LARGE_COPY_CHARS: LARGE_COPY_CHARS,
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
    isLegacyCopyVerified: isLegacyCopyVerified,
    markerKey: markerKey,
    fingerprint: fingerprint,
    readMarker: readMarker,
    checkTripCity: checkTripCity,
    findTripMismatch: findTripMismatch,
    reconcile: reconcile,
    acknowledge: acknowledge,
    adoptLegacy: adoptLegacy
  };
});
