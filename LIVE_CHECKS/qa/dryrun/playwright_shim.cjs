// WP6 DRY-RUN · playwright shim. NOT used in CI/live: run_dryrun.sh places a fake node_modules/playwright/index.js in a
// scratch QA_DEPS dir that requires this file, so `node LIVE_CHECKS/qa/wp6_live.mjs` runs unchanged against a LOCAL static
// server of origin/main with every external dependency stubbed:
//   cdn.jsdelivr.net supabase-js   -> dryrun/supabase_stub.js (HTTP to *.supabase.co, answered below)
//   *.supabase.co /auth /rest      -> in-memory backend (one store for ALL contexts: RLS by user_id, deterministic uid per e-mail)
//   cdn.tailwindcss.com            -> the page's own tailwind.config compiled locally (WP4_package/tests/tailwind_css.mjs)
//   unpkg leaflet                  -> WP3_package/tests/stubs/leaflet_stub.js + layer tracking (getLayers) for map==list checks
//   fonts.googleapis Material Symbols -> CSS emulating the icon font's 1em glyph boxes (no fake overflow)
//   images / fonts / css / other   -> empty
// Env: DRY_ROOT (served checkout, origin/main), DRY_STUB_DIR (this dir), ASALOCAL_BASE_URL (http://127.0.0.1:<port>),
//      PW_REAL (real playwright, default /opt/node-tools/node_modules/playwright), DRY_STATE_OUT (optional: dump final store),
//      DRY_FAULTS (optional: "DELETE:favorites,rpc:trip_save,..." -> HTTP 500, to exercise the cleanup reporting).
// Never reaches the network: anything not listed above is fulfilled locally (204/empty).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const real = require(process.env.PW_REAL || "/opt/node-tools/node_modules/playwright");
const ROOT = process.env.DRY_ROOT;
const HERE = process.env.DRY_STUB_DIR || __dirname;
const ORIGIN = new URL(process.env.ASALOCAL_BASE_URL).origin;
const SUPA_HOST = "tosqsabuaomgqjtogdrn.supabase.co";
if (!ROOT) throw new Error("DRY_ROOT not set");

const STUB = fs.readFileSync(path.join(HERE, "supabase_stub.js"), "utf8");
const LEAF = fs.readFileSync(path.join(ROOT, "WP3_package/tests/stubs/leaflet_stub.js"), "utf8") + `
;(function(){ /* WP6 dry-run: layer groups remember their layers (real Leaflet LayerGroup API subset) */
  var L0 = window.L, base = L0.layerGroup;
  function group(){ var g = base(), layers = [];
    g.addLayer = function(l){ if (layers.indexOf(l) < 0) layers.push(l); return g; };
    g.removeLayer = function(l){ var i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); return g; };
    g.clearLayers = function(){ layers.length = 0; return g; };
    g.getLayers = function(){ return layers.slice(); };
    g.eachLayer = function(f){ layers.slice().forEach(f); return g; };
    g.hasLayer = function(l){ return layers.indexOf(l) >= 0; };
    return g; }
  L0.layerGroup = group; L0.featureGroup = group;
  ["circleMarker", "marker", "circle", "polyline"].forEach(function(k){ var f = L0[k]; L0[k] = function(){ var o = f.apply(null, arguments);
    o.addTo = function(t){ if (t && typeof t.addLayer === "function") t.addLayer(o); return o; }; return o; }; });
})();`;
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// ---------------------------------------------------------------- in-memory Supabase backend (shared by all contexts)
const OWNED = new Set(["members", "trips", "favorites", "trip_plan_versions", "comments", "comment_reactions"]);
const PREF_KEYS = ["welcome_service_email", "trip_created_confirmation", "trip_updated_confirmation", "trip_start_minus_7_days", "trip_start_minus_1_day", "plan_saved_confirmation", "plan_reminder"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DB = { tables: {}, prefs: {}, idem: {}, users: {}, seq: 100, calls: [] };
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const tbl = (n) => (DB.tables[n] = DB.tables[n] || []);
function uidFor(email) {
  const h = crypto.createHash("sha256").update("wp6-dryrun:" + String(email).toLowerCase()).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function prefsOf(uid) {
  // mirrors the live state seen by WP4: welcome_service_email configured (true), the trip/plan keys not_configured
  if (!DB.prefs[uid]) DB.prefs[uid] = Object.assign(Object.fromEntries(PREF_KEYS.map((k) => [k, "not_configured"])), { welcome_service_email: true });
  return DB.prefs[uid];
}
function match(r, f) {
  const [k, c, v] = f; const x = r[c] === undefined ? null : r[c];
  switch (k) {
    case "eq": return x === v || (x != null && v != null && String(x) === String(v) && typeof x !== typeof v && (typeof x === "number" || typeof v === "number"));
    case "neq": return x !== v;
    case "is": return x === v;
    case "in": return Array.isArray(v) && v.some((y) => y === x || String(y) === String(x));
    case "lt": return x != null && x < v;
    case "lte": return x != null && x <= v;
    case "gt": return x != null && x > v;
    case "gte": return x != null && x >= v;
    default: return true;
  }
}
const visible = (name, uid) => tbl(name).filter((r) => !OWNED.has(name) || (uid && r.user_id === uid));
function rest(table, q, uid) {
  if (table === "comments_public" || table === "comment_reaction_counts") return { status: 200, data: [] };
  const rows = visible(table, uid).filter((r) => (q.filters || []).every((f) => match(r, f)));
  if (q.op === "select") {
    let out = rows.map(clone);
    for (const [c, asc] of [...(q.order || [])].reverse()) out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
    return { status: 200, data: out };
  }
  if (q.op === "insert" || q.op === "upsert") {
    const vals = [].concat(q.value || []).map(clone);
    for (const r of vals) if (table === "favorites" && r.user_id == null && uid) r.user_id = uid; // live trigger fills user_id
    if (OWNED.has(table) && (!uid || !vals.every((r) => r && r.user_id === uid))) return { status: uid ? 403 : 401, error: { message: "new row violates row-level security policy", code: "42501" } };
    const t = tbl(table); const out = [];
    const conflict = q.op === "upsert" && q.opts && q.opts.onConflict ? String(q.opts.onConflict).split(",").map((s) => s.trim()) : null;
    for (const r of vals) {
      const dup = conflict ? t.find((x) => conflict.every((c) => x[c] === r[c])) : null;
      if (dup) { if (!(q.opts && q.opts.ignoreDuplicates)) Object.assign(dup, r); out.push(clone(dup)); continue; }
      if (r.id == null) r.id = ++DB.seq;
      if (table === "trips") Object.assign(r, { revision: r.revision || 1, archived_at: r.archived_at ?? null, setup_completed: !!r.setup_completed, plan: r.plan ?? null, plan_version: r.plan_version || 0, created_at: new Date().toISOString() });
      t.push(r); out.push(clone(r));
    }
    return { status: 201, data: out };
  }
  if (q.op === "update") { for (const r of rows) Object.assign(r, clone(q.value || {})); return { status: 200, data: rows.map(clone) }; }
  if (q.op === "delete") { const t = tbl(table); for (const r of rows) t.splice(t.indexOf(r), 1); return { status: 200, data: rows.map(clone) }; }
  return { status: 400, error: { message: "unsupported op" } };
}
function rpc(name, a, uid, email) {
  a = a || {};
  const needAuth = () => ({ status: 401, error: { message: "no_auth" } });
  switch (name) {
    case "member_upsert_profile": {
      if (!uid) return needAuth();
      let m = tbl("members").find((r) => r.user_id === uid);
      if (!m) { m = { user_id: uid, email, display_name: a.p_display_name || null, tier: "Kaşif", points: 0, blocked: false, created_at: new Date().toISOString() }; tbl("members").push(m); }
      else { for (const [k, c] of [["display_name", "p_display_name"], ["bio", "p_bio"], ["home_city", "p_home_city"], ["gender", "p_gender"]]) if (m[k] == null && a[c] != null) m[k] = a[c]; }
      return { status: 200, data: { ok: true } };
    }
    case "consent_get_my_state": return uid ? { status: 200, data: { consent: {}, service_prefs: clone(prefsOf(uid)) } } : needAuth();
    case "service_pref_set": {
      if (!uid) return needAuth();
      if (!PREF_KEYS.includes(a.p_key)) return { status: 400, error: { message: "invalid input value for enum service_pref_key" } };
      if (typeof a.p_enabled !== "boolean") return { status: 400, error: { message: "p_enabled must be boolean" } };
      if (typeof a.p_request_id !== "string" || !a.p_request_id.trim()) return { status: 400, error: { message: "request_id_required" } };
      if (typeof a.p_idem !== "string" || !UUID.test(a.p_idem)) return { status: 400, error: { message: "invalid input syntax for type uuid" } };
      if (DB.idem[a.p_idem]) return { status: 200, data: clone(DB.idem[a.p_idem]) };
      prefsOf(uid)[a.p_key] = a.p_enabled;
      return { status: 200, data: (DB.idem[a.p_idem] = { ok: true, key: a.p_key, enabled: a.p_enabled }) };
    }
    case "trip_save":
    case "trip_snapshot_plan": {
      const row = tbl("trips").find((t) => String(t.id) === String(a.p_id));
      if (!uid || !row || row.user_id !== uid) return { status: 200, data: { ok: false, reason: "not_found" } };
      if (a.p_expected_rev != null && a.p_expected_rev !== row.revision) return { status: 200, data: { ok: false, reason: "conflict", server: { revision: row.revision } } };
      if (name === "trip_save") { Object.assign(row, clone(a.p_patch || {})); row.revision++; return { status: 200, data: { ok: true, revision: row.revision } }; }
      row.plan_version = (row.plan_version || 0) + 1; row.revision++;
      tbl("trip_plan_versions").push({ id: ++DB.seq, trip_id: row.id, user_id: uid, version: row.plan_version, reason: a.p_reason, plan: clone(row.plan) });
      return { status: 200, data: { ok: true, revision: row.revision, version: row.plan_version } };
    }
    case "log_city_view": return uid ? { status: 200, data: { ok: true, recorded: true } } : needAuth();
    case "log_behavior_event": return uid ? { status: 200, data: { ok: true, duplicate: false } } : needAuth();
    case "complete_profile": return { status: 200, data: { ok: false, reason: "dry-run" } };
    case "similar_brains": return { status: 200, data: [] };
    default: return { status: 404, error: { message: `Could not find the function public.${name}`, code: "PGRST202" } };
  }
}
// fault injection for exercising wp6_live.mjs's undo/cleanup reporting: DRY_FAULTS="DELETE:favorites,rpc:trip_save,..."
const FAULTS = new Set(String(process.env.DRY_FAULTS || "").split(",").map((x) => x.trim()).filter(Boolean));
function backend(u, method, headers, bodyText) {
  { const p0 = u.pathname; const key = p0.startsWith("/rest/v1/rpc/") ? `rpc:${p0.slice(13)}` : p0.startsWith("/rest/v1/") ? `${method}:${p0.slice(9)}` : null;
    if (key && FAULTS.has(key)) { DB.calls.push(`500 ${p0} (injected)`); return { status: 500, json: { error: { message: "dry-run injected fault" } } }; } }
  let body = {}; try { body = JSON.parse(bodyText || "{}") || {}; } catch {}
  if (method === "GET") { try { body = JSON.parse(u.searchParams.get("wp6q") || "{}"); } catch { body = {}; } }
  const auth = String(headers.authorization || "");
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const user = tok && DB.users[tok] ? DB.users[tok] : null;
  const uid = user ? user.id : null;
  const req = { body };
  const p = u.pathname;
  let res;
  if (p === "/auth/v1/token") {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || !/@/.test(email) || typeof password !== "string" || !password) res = { status: 400, json: { error: "invalid_grant", error_description: "Invalid login credentials" } };
    else {
      const usr = { id: uidFor(email), email: email.toLowerCase() };
      const t = "dryrun-session-" + crypto.randomBytes(9).toString("hex");
      DB.users[t] = usr;
      res = { status: 200, json: { access_token: t, token_type: "bearer", user: usr } };
    }
  } else if (p === "/auth/v1/logout") { if (tok) delete DB.users[tok]; res = { status: 204, json: null }; }
  else if (p.startsWith("/rest/v1/rpc/")) { const r = rpc(decodeURIComponent(p.slice(13)), req.body, uid, user && user.email); res = { status: r.status, json: r.error ? { error: r.error } : { data: r.data } }; }
  else if (p.startsWith("/rest/v1/")) { const r = rest(decodeURIComponent(p.slice(9)), req.body || {}, uid); res = { status: r.status, json: r.error ? { error: r.error } : { data: r.data } }; }
  else res = { status: 404, json: { error: { message: "not found" } } };
  DB.calls.push(`${res.status} ${p}`);
  return res;
}

// ---------------------------------------------------------------- Tailwind (Play CDN replacement), one build per page
const CSS = {};
async function buildCss() {
  const tw = await import(pathToFileURL(path.join(ROOT, "WP4_package/tests/tailwind_css.mjs")).href);
  if (!tw.tailwindAvailable()) { process.stderr.write("[dryrun] tailwind deps missing on NODE_PATH: pages run unstyled\n"); return; }
  for (const [k, f] of [["home", "index.html"], ["ams", "amsterdam/index.html"]]) CSS[k] = tw.cdnShim(await tw.buildTailwindCss(fs.readFileSync(path.join(ROOT, f), "utf8")));
}

async function route(r) {
  const req = r.request(); const u = new URL(req.url());
  if (u.origin === ORIGIN) return u.pathname === "/favicon.ico" ? r.fulfill({ status: 204, body: "" }) : r.continue();
  if (u.host === SUPA_HOST) {
    const res = backend(u, req.method(), req.headers(), req.postData());
    return r.fulfill({ status: res.status, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: res.json == null ? "" : JSON.stringify(res.json) });
  }
  if (u.host === "cdn.tailwindcss.com") {
    let page = ""; try { page = new URL(req.frame().url()).pathname; } catch {}
    const css = /^\/amsterdam\//.test(page) ? CSS.ams : CSS.home;
    return r.fulfill({ status: 200, contentType: "application/javascript", body: css || "window.tailwind={config:{}};" });
  }
  if (u.host === "unpkg.com" && u.pathname.includes("leaflet")) return u.pathname.endsWith(".css") ? r.fulfill({ status: 200, contentType: "text/css", body: "" }) : r.fulfill({ status: 200, contentType: "application/javascript", body: LEAF });
  if (u.host === "cdn.jsdelivr.net" && u.pathname.includes("supabase-js")) return r.fulfill({ status: 200, contentType: "application/javascript", body: STUB });
  const rt = req.resourceType();
  // Material Symbols: the real icon font renders every ligature ("arrow_back", "favorite") as ONE 1em glyph. Without the
  // font the words would render as wide text and fake a horizontal overflow, so emulate the glyph box (text unchanged).
  if (u.host === "fonts.googleapis.com" && /Material\+Symbols|Material%20Symbols/.test(u.search)) return r.fulfill({ status: 200, contentType: "text/css", body: ".msym,.material-symbols-outlined{width:1em!important;max-width:1em!important;overflow:hidden!important;vertical-align:middle}" });
  if (rt === "stylesheet") return r.fulfill({ status: 200, contentType: "text/css", body: "" });
  if (rt === "script") return r.fulfill({ status: 200, contentType: "application/javascript", body: "" });
  if (rt === "image") return r.fulfill({ status: 200, contentType: "image/gif", body: GIF });
  return r.fulfill({ status: 204, body: "" });
}

const chromium = Object.create(real.chromium);
chromium.launch = async (opts) => {
  if (!Object.keys(CSS).length) await buildCss();
  const browser = await real.chromium.launch(opts);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const ctx = await newContext(Object.assign({ serviceWorkers: "block" }, o));
    await ctx.route("**/*", route);
    return ctx;
  };
  const close = browser.close.bind(browser);
  browser.close = async () => {
    if (process.env.DRY_STATE_OUT) {
      const redact = JSON.parse(JSON.stringify(DB.tables, (k, v) => (k === "email" ? "[redacted]" : v)));
      fs.writeFileSync(process.env.DRY_STATE_OUT, JSON.stringify({ tables: redact, calls: DB.calls.length }, null, 1));
    }
    return close();
  };
  return browser;
};
module.exports = Object.assign({}, real, { chromium });
