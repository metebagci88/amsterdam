// WP6 · unit-test harness: runs the city page's REAL code blocks (amsterdam/index.html) in a node:vm sandbox with a
// fake Storage, a mini DOM, fake timers and a fake Supabase client. No dependencies (node:vm, node:fs only).
//
// Blocks are cut out of the page by stable comment / function markers (see BLOCKS below). Renaming a marker in the
// page breaks these tests on purpose ("marker missing: ...").
// The page root can be overridden with WP6_PAGE_ROOT=<dir containing amsterdam/index.html, index.html, lib/> (used for
// mutation runs against a patched copy); by default it is the repository root.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = process.env.WP6_PAGE_ROOT ? pathToFileURL(resolve(process.env.WP6_PAGE_ROOT) + "/") : new URL("../../", import.meta.url);
export const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
export const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
export const tick = () => new Promise((r) => setImmediate(r));
export async function settle(n = 40) { for (let i = 0; i < n; i++) await tick(); }

// ------------------------------------------------------------------------------------------------ source slicing
// block(html, start, end): from start (inclusive) to end (exclusive); { inclusive: true } keeps the end marker.
export function block(html, start, end, { inclusive = false, from = 0 } = {}) {
  const i = html.indexOf(start, from);
  if (i < 0) throw new Error("marker missing: " + start);
  const j = html.indexOf(end, i + start.length);
  if (j < 0) throw new Error("marker missing: " + end + " (after " + start + ")");
  return html.slice(i, inclusive ? j + end.length : j);
}
// index of the brace that closes the one opening at `open` (skips strings, template literals, comments, regex literals)
export function matchBrace(src, open) {
  let depth = 0, i = open, prev = "(";
  const tpl = [];   // template-literal nesting: brace depth at which a ${ } returns into a template
  const regexOk = () => /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev) || /\b(return|typeof|case|in|of|void|delete|new)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd());
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
    if (c === "'" || c === '"') { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; prev = c; continue; }
    if (c === "`" || (c === "}" && tpl.length && tpl[tpl.length - 1] === depth)) {
      if (c === "}") tpl.pop();
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") { tpl.push(depth); i++; break; }
      }
      prev = "`"; continue;
    }
    if (c === "/" && regexOk()) {
      let cls = false;
      for (i++; i < src.length; i++) { const d = src[i]; if (d === "\\") { i++; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; }
      while (/[a-z]/i.test(src[i + 1] || "")) i++;
      prev = "/r"; continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error("unbalanced braces from " + src.slice(open, open + 60));
}
// fnSrc(text, "  async function logout(){") → the whole function declaration (brace matched)
export function fnSrc(text, start) {
  const i = text.indexOf(start);
  if (i < 0) throw new Error("marker missing: " + start);
  const p = text.indexOf(")", i), o = text.indexOf("{", p);
  return text.slice(i, matchBrace(text, o) + 1);
}

export const BLOCKS = {
  ASA_ST: ["window.ASA_ST=(function(){", "\n/* ===== FAVORITES"],
  FAV: ["/* ===== FAVORITES =====", "/* ===== NAV ====="],
  TRIPSTORE: ["/* ASALOCAL TripStore", "})(window);", { inclusive: true }],
  TRIPSYNC: ["/* A5/A9 TripSync", "</script>"],
  KONUM: ["/* ===== KONUM / REFERANS =====", "function getLoc("],
  CAL: ["/* ===== CALENDAR =====", "function dayInfo("],
  GEN: ["/* ===== KİŞİSEL PLAN ÜRETİCİ =====", "/* ===== PLAN KURULUM"],
  PSET: ["var PSET=(function(){", "function renderPlanSetup("],
  LOADTRIP: ["  async function loadTripContext(){", "  // A10:"],
  IMPORTGUEST: ["  async function importGuestTrip(){", "  function mapAuthErr("],
};
export const pageBlock = (html, name) => block(html, ...BLOCKS[name]);
// the membership closure `const ASA = (function(){ ... })();` → its body
export function asaClosureBody(html) {
  const s = html.indexOf("const ASA = (function(){");
  if (s < 0) throw new Error("marker missing: const ASA = (function(){");
  const o = html.indexOf("{", html.indexOf("function(){", s));
  return html.slice(o + 1, matchBrace(html, o));
}

// ------------------------------------------------------------------------------------------------ fake Storage
export function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, String(v)]));
  const fail = new Set();
  const s = {
    log: [],
    getItem(k) { k = String(k); s.log.push(["get", k]); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) {
      k = String(k); s.log.push(["set", k]);
      if (fail.has(k) || fail.has("*")) { const e = new Error("quota exceeded (test)"); e.name = "QuotaExceededError"; e.code = 22; throw e; }
      m.set(k, String(v));
    },
    removeItem(k) { k = String(k); s.log.push(["remove", k]); m.delete(k); },
    key(i) { return [...m.keys()][i] ?? null; },
    get length() { return m.size; },
    clear() { s.log.push(["clear", "*"]); m.clear(); },
    failOn(k) { fail.add(k); }, allow(k) { fail.delete(k); },
    raw(k) { return m.has(k) ? m.get(k) : null; },
    json(k) { const v = s.raw(k); return v === null ? null : JSON.parse(v); },
    dump() { return Object.fromEntries(m); },
    keys() { return [...m.keys()]; },
  };
  return s;
}

// ------------------------------------------------------------------------------------------------ mini DOM
export function miniDom() {
  const doc = { activeElement: null };
  function el(tag) {
    const cls = new Set();
    const e = {
      tagName: String(tag || "div").toUpperCase(), id: "", children: [], attrs: {}, style: {}, _text: "", _html: "",
      onclick: null, type: "", value: "", disabled: false, parentNode: null, dataset: {},
      get className() { return [...cls].join(" "); }, set className(v) { cls.clear(); String(v || "").split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c),
        toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; },
      },
      get textContent() { return e._text + e.children.map((k) => k.textContent).join(" "); },
      set textContent(v) { e._text = String(v == null ? "" : v); e.children = []; e._html = ""; },
      get innerHTML() { return e._html; }, set innerHTML(v) { e._html = String(v); e._text = ""; e.children = []; },
      setAttribute(k, v) { e.attrs[k] = String(v); if (k === "id") e.id = String(v); if (k === "class") e.className = v; },
      getAttribute(k) { if (k === "id") return e.id || null; if (k === "class") return e.className || null; return Object.prototype.hasOwnProperty.call(e.attrs, k) ? e.attrs[k] : null; },
      removeAttribute(k) { delete e.attrs[k]; }, hasAttribute(k) { return Object.prototype.hasOwnProperty.call(e.attrs, k); },
      appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
      insertBefore(c) { return e.appendChild(c); },
      removeChild(c) { e.children = e.children.filter((x) => x !== c); return c; },
      remove() { if (e.parentNode) e.parentNode.removeChild(e); },
      click() { if (e.disabled) return; if (typeof e.onclick === "function") e.onclick({ target: e, currentTarget: e, preventDefault() {}, stopPropagation() {} }); },
      focus() { doc.activeElement = e; }, blur() { if (doc.activeElement === e) doc.activeElement = doc.body; },
      scrollIntoView() {}, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    };
    return e;
  }
  const body = el("body");
  const find = (root, id) => { if (root.id === id) return root; for (const k of root.children) { const f = find(k, id); if (f) return f; } return null; };
  Object.assign(doc, {
    body, documentElement: el("html"), readyState: "complete",
    createElement: (t) => el(t), createTextNode: (t) => { const n = el("#text"); n.textContent = t; return n; },
    getElementById: (id) => find(body, String(id)),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  });
  doc.activeElement = body;
  const add = (id, tag, cls, attrs = {}) => { const e = el(tag); e.id = id; e.className = cls; Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); body.appendChild(e); return e; };
  add("asaStoreNotice", "div", "asa-sn hide", { role: "status", "aria-live": "polite" });
  add("tripSyncNotice", "div", "asa-sn hide", { role: "alert", "aria-atomic": "true" });
  add("asaNpDone", "p", "asa-np-done", { role: "status" });
  // planSetup / cal / planCtl / dayModal are absent on purpose: the page's render functions no-op without them
  return { document: doc, el, add };
}

// ------------------------------------------------------------------------------------------------ fake Supabase client
// Semantics of trip_save / trip_snapshot_plan copy LIVE_CHECKS/qa/dryrun/playwright_shim.cjs (revision conflict).
export function fakeDb(init = {}) {
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const S = {
    tables: { trips: [], favorites: [], members: [], comments: [] }, calls: [], uid: "u1", seq: 100,
    session: undefined,          // undefined → {data:{session:{user:{id:uid}}}}; or a full getSession() result
    hooks: {},                   // rest(call) / rpc(name,args) → override {data,error} | undefined; afterSave(row)
    hold: false, held: [], inflight: 0, maxInflight: 0,
    release() { const h = S.held.splice(0); h.forEach((f) => f()); return h.length; },
    rpcs(name) { return S.calls.filter((c) => c.kind === "rpc" && (!name || c.name === name)); },
    rest(table, op) { return S.calls.filter((c) => c.kind === "rest" && (!table || c.table === table) && (!op || c.op === op)); },
    // the auth client's onAuthStateChange subscribers of every page on this server (auth-js broadcasts to all tabs of the browser)
    authCbs: [], emitAuth(event, uid) { S.authCbs.slice().forEach((f) => f(event, uid ? { user: { id: uid } } : null)); },
    trip(id) { return S.tables.trips.find((t) => String(t.id) === String(id)) || null; },
    favIds(uid = S.uid) { return S.tables.favorites.filter((f) => f.user_id === uid).map((f) => f.venue_id).sort(); },
  };
  Object.assign(S, init);
  for (const k of ["trips", "favorites", "members", "comments"]) S.tables[k] = S.tables[k] || [];
  const match = ([k, c, v], r) => { const x = r[c] === undefined ? null : r[c];
    switch (k) { case "eq": return x === v || (x != null && v != null && String(x) === String(v)); case "neq": return x !== v; case "is": return x === v;
      case "in": return Array.isArray(v) && v.some((y) => String(y) === String(x)); case "lt": return x != null && x < v; case "lte": return x != null && x <= v;
      case "gt": return x != null && x > v; case "gte": return x != null && x >= v; default: return true; } };
  function exec(q) {
    const call = { kind: "rest", table: q.table, op: q.op, filters: clone(q.filters), value: clone(q.value), opts: clone(q.opts) };
    S.calls.push(call);
    const o = S.hooks.rest && S.hooks.rest(call, S);
    if (o !== undefined) return o;
    const t = S.tables[q.table] = S.tables[q.table] || [];
    const owned = q.table === "trips" || q.table === "favorites";
    const rows = t.filter((r) => (!owned || r.user_id === S.uid) && q.filters.every((f) => match(f, r)));
    if (q.op === "select") {
      let out = rows.map(clone);
      for (const [c, asc] of q.order) out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      if (q.single) return out.length ? { data: out[0], error: null } : (q.single === "maybe" ? { data: null, error: null } : { data: null, error: { message: "no rows" } });
      return { data: out, error: null };
    }
    if (q.op === "insert" || q.op === "upsert") {
      const vals = [].concat(q.value || []).map(clone), out = [];
      const keys = q.op === "upsert" && q.opts && q.opts.onConflict ? String(q.opts.onConflict).split(",").map((x) => x.trim()) : null;
      for (const r of vals) {
        if (r.user_id == null) r.user_id = S.uid;
        const dup = keys ? t.find((x) => keys.every((c) => x[c] === r[c])) : null;
        if (dup) { if (!(q.opts && q.opts.ignoreDuplicates)) Object.assign(dup, r); out.push(clone(dup)); continue; }
        if (r.id == null) r.id = ++S.seq;
        if (q.table === "trips") Object.assign(r, { revision: r.revision || 1, archived_at: r.archived_at ?? null, setup_completed: !!r.setup_completed, plan: r.plan ?? null, plan_version: r.plan_version || 0 });
        t.push(r); out.push(clone(r));
      }
      return q.single ? { data: out[0] || null, error: null } : { data: out, error: null };
    }
    if (q.op === "update") { rows.forEach((r) => Object.assign(r, clone(q.value || {}))); return { data: rows.map(clone), error: null }; }
    if (q.op === "delete") { rows.forEach((r) => t.splice(t.indexOf(r), 1)); return { data: rows.map(clone), error: null }; }
    return { data: null, error: { message: "unsupported" } };
  }
  function from(table) {
    const q = { table, op: "select", filters: [], order: [], value: null, opts: null, single: null };
    const b = {
      select() { return b; }, insert(v) { q.op = "insert"; q.value = v; return b; }, upsert(v, o) { q.op = "upsert"; q.value = v; q.opts = o || null; return b; },
      update(v) { q.op = "update"; q.value = v; return b; }, delete() { q.op = "delete"; return b; },
      order(c, o) { q.order.push([c, !(o && o.ascending === false)]); return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { q.single = "maybe"; return b; }, single() { q.single = "one"; return b; },
      then(res, rej) { return (async () => { await tick(); return exec(q); })().then(res, rej); },
    };
    for (const k of ["eq", "neq", "is", "in", "lt", "lte", "gt", "gte"]) b[k] = (c, v) => { q.filters.push([k, c, v]); return b; };
    return b;
  }
  function rpcCore(name, a) {
    a = a || {};
    if (name === "trip_save" || name === "trip_snapshot_plan") {
      const row = S.trip(a.p_id);
      if (!row || row.user_id !== S.uid) return { data: { ok: false, reason: "not_found" }, error: null };
      if (a.p_expected_rev != null && a.p_expected_rev !== row.revision) return { data: { ok: false, reason: "conflict", server: { revision: row.revision } }, error: null };
      if (name === "trip_save") { Object.assign(row, clone(a.p_patch || {})); const rv = ++row.revision; if (S.hooks.afterSave) S.hooks.afterSave(row, S); return { data: { ok: true, revision: rv }, error: null }; }
      row.plan_version = (row.plan_version || 0) + 1; row.revision++;
      return { data: { ok: true, revision: row.revision, version: row.plan_version }, error: null };
    }
    if (name === "member_upsert_profile" || name === "log_city_view") return { data: { ok: true }, error: null };
    return { data: null, error: { message: "unknown rpc " + name } };
  }
  async function rpc(name, args) {
    await tick();
    const call = { kind: "rpc", name, args: clone(args) };
    S.calls.push(call);
    if (name === "trip_save" && S.rpcs("trip_save").length > 60) return { data: null, error: { message: "loop guard (test)" } };
    S.inflight++; S.maxInflight = Math.max(S.maxInflight, S.inflight);
    try {
      if (S.hold && name === "trip_save") await new Promise((r) => S.held.push(r));
      await tick();
      const o = S.hooks.rpc && S.hooks.rpc(name, args, S);
      return o !== undefined ? o : rpcCore(name, args);
    } finally { S.inflight--; }
  }
  const auth = {
    async getSession() { await tick(); S.calls.push({ kind: "auth", op: "getSession" }); if (S.session !== undefined) { if (S.session instanceof Error) throw S.session; return S.session; } return { data: { session: { user: { id: S.uid } } }, error: null }; },
    async signOut() { await tick(); S.calls.push({ kind: "auth", op: "signOut" }); if (S.emitOnSignOut) S.emitAuth("SIGNED_OUT", null); return { error: null }; },
    onAuthStateChange(cb) { S.authCbs.push(cb); return { data: { subscription: { unsubscribe() { S.authCbs = S.authCbs.filter((f) => f !== cb); } } } }; },
  };
  return { db: { from, rpc, auth }, server: S };
}

// ------------------------------------------------------------------------------------------------ fixtures
export const SEEDS = ["barpif", "shiraz", "chun", "pllek", "oeuf", "escobar", "coba"];
export const VENUES = [
  ["barpif", "bar"], ["shiraz", "restoran"], ["chun", "kahve"], ["pllek", "şarap"], ["oeuf", "kahvaltı"], ["escobar", "kokteyl"], ["coba", "müze"],
  ["x1", "park"], ["x2", "kahve"], ["x3", "restoran"], ["p1", "galeri"], ["p2", "brunch"], ["c9", "bar"], ["a", "restoran"], ["b", "kahve"],
].map(([id, type], i) => ({ id, name: "Mekan " + id, city: "Amsterdam", type, area: "Merkez", lat: 52.36 + i / 1000, lng: 4.89, fav: SEEDS.includes(id) }));

// ------------------------------------------------------------------------------------------------ boot
// boot({ storage, city, search, venues, server, gen, html, lib }) → handle h
//   h.run(code)  evaluate in the page context   h.val(code)  same, JSON-normalised (host realm)
//   h.db/h.server  fake Supabase (shared when `server` is passed)   h.useDb()  window.TripStore=createTripStore(h.db)
//   h.timers()/h.runTimers()  fake setTimeout   h.asa  the real membership closure: h.asa.ev("code in closure scope")
export function boot(opts = {}) {
  const html = opts.html || read("amsterdam/index.html");
  const storage = opts.storage || fakeStorage();
  const dom = miniDom();
  const fdb = opts.server ? { db: opts.db, server: opts.server } : fakeDb(opts.dbInit || {});
  const timers = new Map(); let tid = 0;
  const sb = {
    console, URLSearchParams, URL,
    location: { search: opts.search || "", pathname: "/amsterdam/", origin: "http://wp6.test", hash: "", href: "http://wp6.test/amsterdam/" + (opts.search || "") },
    document: dom.document, navigator: { userAgent: "wp6-unit" },
    setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { id, fn, ms: Number(ms) || 0 }); return id; },
    clearTimeout: (id) => { timers.delete(id); }, setInterval: () => 0, clearInterval() {},
    __alerts: [], __db: fdb.db, __renderCal: [], __calls: { renderCards: 0, banner: 0, engine: 0, autogen: [], views: [], onFav: [] },
    __listeners: {},
  };
  // window event bus (the page registers a "storage" listener; h.fireStorage(key) delivers what another tab's write would)
  sb.addEventListener = (type, fn) => { (sb.__listeners[type] = sb.__listeners[type] || []).push(fn); };
  sb.removeEventListener = (type, fn) => { sb.__listeners[type] = (sb.__listeners[type] || []).filter((f) => f !== fn); };
  sb.alert = (m) => sb.__alerts.push(String(m));
  if (opts.storageThrows) Object.defineProperty(sb, "localStorage", { get() { throw new Error("SecurityError (test)"); } });
  else sb.localStorage = storage;
  sb.window = sb; sb.self = sb;
  vm.createContext(sb);
  const run = (code) => vm.runInContext(code, sb);
  if (opts.lib !== false) run(read("lib/asa-storage/asa_storage.js"));
  run(`const CITY=${JSON.stringify(opts.city || "Amsterdam")};
var V=${JSON.stringify(opts.venues || VENUES)};
function AC(){ return {"Jordaan":[52.374,4.881],"De Pijp":[52.353,4.894]}; }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
var userLoc=null, HOME={name:"Merkez",lat:52.37,lng:4.895};
var MAP={city:CITY,map:null,layer:null,userMarker:null,ready:false,pickMode:false,pickFor:null};
function placeUser(){} function renderCards(){ __calls.renderCards++; } function drawMarkers(){} function setActiveView(v){ __calls.views.push(v); }
function renderPlanCtl(){} function renderCal(){ try{ __renderCal.push(CAL.days.map(function(d){return d.key;})); }catch(e){ __renderCal.push(null); } }
function renderDay(){} function runEngine(){ __calls.engine++; return true; } function autoGeneratePlan(f){ __calls.autogen.push(!!f); }
function renderTripBanner(){ __calls.banner++; } function asaCityTz(){ return "Europe/Amsterdam"; } function refreshGated(){} async function asaLogCityView(){}
function renderPlanSetup(){ try{ PSET.render(); }catch(e){} } function refreshDayUI(){} function buildChips(){} function renderScenarios(){} function renderTrips(){}
var ASA={session:null,onFav:function(id,on){ __calls.onFav.push([id,!!on]); }};
window.asaDB=function(){ return __db; };`);
  const order = ["ASA_ST", "FAV", "TRIPSTORE", "TRIPSYNC", "KONUM", "CAL"].concat(opts.gen ? ["GEN"] : [], ["PSET"]);
  for (const name of order) {
    let code = pageBlock(html, name);
    if (name === "FAV") {
      // tolerate a seed snapshot declared just before the FAVORITES block (it must exist before mergeDbVenues runs)
      const m = html.match(/^(?:const|let|var)\s+SEED_FAV_IDS\s*=.*$/m);
      if (m && !code.includes(m[0])) code = m[0] + "\n" + code;
    }
    try { run(code); } catch (e) { e.message = `[block ${name}] ` + e.message; throw e; }
  }
  // the membership closure, with an eval hook into its scope and its UI renderers neutralised
  let body = asaClosureBody(html);
  const r = body.lastIndexOf("\n  return {");
  body = body.slice(0, r) + "\n  globalThis.__ASAX={ev:function(__c){ return eval(__c); }, set:function(__n,__v){ eval(__n+'=__v'); }};" +
    "\n  render=function(){ globalThis.__asaRenders=(globalThis.__asaRenders||0)+1; }; refreshName=function(){}; nameReset=function(){};" + body.slice(r);
  run("globalThis.__ASA_REAL=(function(){" + body + "})();");
  const h = {
    sb, run, storage, dom, html, db: fdb.db, server: fdb.server, asa: sb.__ASAX, asaApi: sb.__ASA_REAL,
    val: (code) => J(run(code)),
    useDb() { sb.TripStore = run("createTripStore(__db)"); return sb.TripStore; },
    useRealAsa() { sb.ASA = sb.__ASA_REAL; return sb.ASA; },
    timers: () => [...timers.values()],
    runTimers(filter = () => true) { let n = 0; for (let round = 0; round < 25; round++) { const due = [...timers.values()].filter(filter); if (!due.length) break; for (const t of due) { timers.delete(t.id); n++; try { t.fn(); } catch (e) { sb.__timerErrors = (sb.__timerErrors || []).concat(String(e)); } } } return n; },
    el: (id) => dom.document.getElementById(id),
    notice: () => { const e = dom.document.getElementById("tripSyncNotice"); return { el: e, hidden: !e || e.classList.contains("hide"), text: e ? e.textContent : "", reason: e && e.getAttribute("data-reason"), role: e && e.getAttribute("role") }; },
    storeNotice: () => { const e = dom.document.getElementById("asaStoreNotice"); return { hidden: !e || e.classList.contains("hide"), text: e ? e.textContent : "" }; },
    sync: () => storage.json("asa:ams:plan_sync"),
    favSync: () => storage.json("asa:ams:fav_sync"),
    ls: (k) => storage.json("asa:ams:" + k),
    saves: () => fdb.server.rpcs("trip_save"),
    // a user edit through the page's own path (memory + saveLS → autosave scheduling)
    edit(domain, v) { const varName = { dayven: "dayVenues", plan: "calPlans", cal: "calNotes" }[domain]; return run(`${varName}=${JSON.stringify(v)}; saveLS(${JSON.stringify(domain)},${varName})`); },
    // another tab of the same browser wrote `key` (full storage key, e.g. "asa:ams:cal"; null = storage cleared): the browser's
    // "storage" event in THIS tab. Returns the listener results.
    fireStorage(key) { return (sb.__listeners.storage || []).map((f) => f({ key, storageArea: storage })); },
    // open a DB trip the way loadTripContext does: TRIP=row, then TripSync.adopt(row)
    open(row, o) { return run(`window.TRIP=${JSON.stringify(row)}; TripSync.adopt(window.TRIP${o ? "," + JSON.stringify(o) : ""})`); },
  };
  return h;
}
// a second "tab" or a reload: same storage + same fake server
export function bootLike(h, opts = {}) { return boot({ storage: h.storage, server: h.server, db: h.db, ...opts }); }
