/* WP4 test stub for @supabase/supabase-js (served via Playwright route; never deployed). No network.
   Pattern: WP3_package/tests/stubs/supabase_stub.js, extended for the member area.
   Reads window.__WP4_SUPA = {
     user:      { id, email } | null            — auth session (signOut clears it for this page)
     rls:       true (default)                  — members/trips/favorites rows are filtered by user_id = auth user
                                                  (anon sees none), like the live policies auth.uid() = user_id.
                                                  false = the stub returns every row (proves the page's own filter).
     tables:    { name: [rows] }                — eq()/is() filters are applied to select results
     prefs:     { pref_key: true|false|'not_configured' }   — consent_get_my_state().service_prefs (mutated by service_pref_set)
     rpc:       { name: data }                  — static data for other RPCs
     rpcError:  { name: message }               — every call of that RPC returns { error }
     signOutDelayMs: n                          — signOut resolves after n ms (double-click test)
   }
   window.__WP4_SUPA_FAIL_NEXT = { name: "error" | "notok" }   — the next call of that RPC fails once
   Every call is logged to window.__WP4_SUPA_LOG ({op:"select"|"insert"|...|"rpc"|"signOut", ...}) and, when the test
   exposed it (page.exposeFunction), also to window.__wp4Sink(entry) so the log survives a navigation.
   insert: rows are stored (owned tables: only with user_id = auth user, like the live insert policy); an id is assigned
   when missing; .select().single() returns the stored row. */
(function () {
  var cfg = window.__WP4_SUPA || {};
  var log = (window.__WP4_SUPA_LOG = []);
  function L(e) { log.push(e); try { if (typeof window.__wp4Sink === "function") window.__wp4Sink(e); } catch (_) {} }
  window.__WP4_SUPA_FAIL_NEXT = window.__WP4_SUPA_FAIL_NEXT || {};
  var user = cfg.user || null;
  var OWNED = { members: 1, trips: 1, favorites: 1 };
  var PREF_KEYS = ["trip_created_confirmation", "trip_updated_confirmation", "trip_start_minus_7_days", "trip_start_minus_1_day", "plan_saved_confirmation", "plan_reminder", "welcome_service_email"];
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var prefs = JSON.parse(JSON.stringify(cfg.prefs || {}));
  var idemSeen = {};
  var clone = function (v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
  function table(name) { cfg.tables = cfg.tables || {}; return (cfg.tables[name] = cfg.tables[name] || []); }
  function visible(name) {
    var rows = table(name);
    if (cfg.rls === false || !OWNED[name]) return rows.slice();
    if (!user) return [];
    return rows.filter(function (r) { return r && r.user_id === user.id; });
  }
  function builder(name) {
    var st = { op: "select", single: false, filters: [] };
    var b = {};
    ["order", "limit", "range", "match", "filter", "not", "or", "contains", "ilike", "like", "neq", "in", "lte", "gte", "lt", "gt"].forEach(function (m) {
      b[m] = function () { return b; };
    });
    b.select = function (cols) { if (st.op === "select") st.cols = cols || "*"; return b; };
    b.eq = function (c, v) { st.filters.push(function (r) { return r[c] === v; }); return b; };
    b.is = function (c, v) { st.filters.push(function (r) { return (r[c] === undefined ? null : r[c]) === v; }); return b; };
    ["insert", "upsert", "update", "delete"].forEach(function (op) {
      b[op] = function (value) { st.op = op; st.value = value; L({ table: name, op: op, value: clone(value) }); return b; };
    });
    b.single = function () { st.single = true; return b; };
    b.maybeSingle = b.single;
    b.then = function (res, rej) {
      var out;
      if (st.op === "select") {
        L({ table: name, op: "select", cols: st.cols || "*", anon: !user });
        var rows = visible(name).filter(function (r) { return st.filters.every(function (f) { return f(r); }); }).map(clone);
        out = st.single ? { data: rows[0] || null, error: null } : { data: rows, error: null };
      } else if (st.op === "insert") {
        var vals = [].concat(st.value || []).map(clone), t = table(name);
        if (OWNED[name] && (!user || !vals.every(function (r) { return r && r.user_id === user.id; }))) out = { data: null, error: { message: "new row violates row-level security policy" } };
        else {
          vals.forEach(function (r) { if (r.id == null) r.id = t.reduce(function (m, x) { return Math.max(m, Number(x.id) || 0); }, 100) + 1; if (name === "trips") { if (r.revision == null) r.revision = 1; if (r.archived_at === undefined) r.archived_at = null; } t.push(r); });
          out = st.single ? { data: clone(vals[0]) || null, error: null } : { data: vals.map(clone), error: null };
        }
      } else out = { data: st.single ? null : [], error: null };
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  }
  function fail(name) {
    var f = window.__WP4_SUPA_FAIL_NEXT[name];
    if (f) { delete window.__WP4_SUPA_FAIL_NEXT[name]; return f; }
    if (cfg.rpcError && cfg.rpcError[name]) return "error";
    return null;
  }
  function rpc(name, args) {
    L({ op: "rpc", name: name, args: clone(args) });
    var f = fail(name);
    if (f === "error") return { data: null, error: { message: (cfg.rpcError && cfg.rpcError[name]) || "stub failure" } };
    if (f === "notok") return { data: { ok: false, reason: "stub" }, error: null };
    if (name === "consent_get_my_state") {
      if (!user) return { data: null, error: { message: "no_auth" } };
      return { data: { consent: {}, service_prefs: clone(prefs) }, error: null };
    }
    if (name === "service_pref_set") {
      if (!user) return { data: null, error: { message: "no_auth" } };
      var a = args || {};
      if (PREF_KEYS.indexOf(a.p_key) < 0) return { data: null, error: { message: "invalid input value for enum service_pref_key" } };
      if (typeof a.p_enabled !== "boolean") return { data: null, error: { message: "p_enabled must be boolean" } };
      if (typeof a.p_request_id !== "string" || !a.p_request_id.trim() || a.p_request_id.trim().length > 80) return { data: null, error: { message: "request_id_required" } };
      if (typeof a.p_idem !== "string" || !UUID.test(a.p_idem)) return { data: null, error: { message: "invalid input syntax for type uuid" } };
      if (idemSeen[a.p_idem]) return { data: clone(idemSeen[a.p_idem]), error: null };
      prefs[a.p_key] = a.p_enabled;
      var r = { ok: true, key: a.p_key, enabled: a.p_enabled };
      idemSeen[a.p_idem] = r;
      return { data: clone(r), error: null };
    }
    if (name === "trip_save") {
      var row = table("trips").filter(function (t) { return t.id === (args && args.p_id); })[0];
      if (!row || !user || (cfg.rls !== false && row.user_id !== user.id)) return { data: { ok: false, reason: "not_found" }, error: null };
      Object.assign(row, (args && args.p_patch) || {});
      row.revision = (row.revision || 0) + 1;
      return { data: { ok: true, revision: row.revision }, error: null };
    }
    var data = cfg.rpc && Object.prototype.hasOwnProperty.call(cfg.rpc, name) ? clone(cfg.rpc[name]) : null;
    return { data: data, error: null };
  }
  function client() {
    return {
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: user ? { user: clone(user) } : null }, error: null }); },
        getUser: function () { return Promise.resolve({ data: { user: clone(user) }, error: null }); },
        signOut: function () { L({ op: "signOut" }); user = null; return new Promise(function (r) { setTimeout(function () { r({ error: null }); }, cfg.signOutDelayMs || 0); }); },
        signInWithPassword: function () { L({ op: "signInWithPassword" }); return Promise.resolve({ data: {}, error: { message: "stub" } }); },
        signUp: function () { L({ op: "signUp" }); return Promise.resolve({ data: {}, error: { message: "stub" } }); },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
      },
      from: builder,
      rpc: function (name, args) { return Promise.resolve(rpc(name, args)); },
      storage: { from: function () { return { upload: function () { return Promise.resolve({ data: null, error: { message: "stub" } }); }, getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
      channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
      removeChannel: function () {}
    };
  }
  window.supabase = { createClient: function () { return client(); } };
})();
