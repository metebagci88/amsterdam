/* WP5 test stub for @supabase/supabase-js (served via Playwright route; never deployed). No network.
   Copy of WP4_package/tests/stubs/supabase_stub.js, extended for İŞ PAKETİ 5 (private first/last name).
   Reads window.__WP5_SUPA = {
     user:      { id, email } | null            — auth session at first load (see persist)
     accounts:  [{ id, email, password }]       — signInWithPassword succeeds for a matching e-mail + password
                                                  (sets the auth user); anything else → "Invalid login credentials"
     rls:       true (default)                  — members/trips/favorites rows are filtered by user_id = auth user
                                                  (anon sees none), like the live policies auth.uid() = user_id
     tables:    { name: [rows] }                — eq()/is() filters are applied; select("a,b") projects columns
                                                  (a column absent from a row is returned as null, like PostgREST)
     backendMissing: true                       — WP5 DB package NOT applied: members.first_name/last_name do not exist
                                                  (select naming them → { error: { code: "42703" } }, status 400; "*" omits
                                                  them) and rpc member_set_name → { error: { code: "PGRST202" } }, status 404
     prefs, rpc, rpcError, signOutDelayMs       — as in the WP4 stub
     rpcDelayMs:    { name: n }                 — that RPC resolves after n ms (double-submit / race tests)
     selectDelayMs: { "members:first_name": n } — a members select naming that column resolves after n ms
                    { "members:first_name@<uid>": n } — … only while that user is signed in (stale-read races)
     persist:   true (default)                  — auth user + tables survive reloads and same-tab navigation
                                                  (sessionStorage "__wp5_stub_state"), like a real backend + session
   }
   window.__WP5_SUPA_FAIL_NEXT = { name: "error" | "notok" | "throw" | "reason:<r>" } — the next call of that RPC fails once
     ("error" → { error } status 500 · "notok" → {ok:false,reason:"stub"} · "throw" → the call rejects like a network
      failure · "reason:<r>" → {ok:false, reason:<r>}, e.g. "reason:no_member_row")
   Server-like RPCs:
     member_upsert_profile(p_display_name, p_bio, p_home_city, p_gender) — INSERT own row or UPDATE with
       COALESCE(new, existing) per column (null keeps the stored value), email := auth e-mail (as in production)
     member_set_name(p_first, p_last) — auth required; >200 raw chars → bad_*; whitespace runs → one space, trim, NFC;
       empty → bad_*; no own row → no_member_row; name policy v1 = the CHECK constraint literals copied verbatim from
       WP5_package/db/WP5_DB_up.sql (members_*_wp5_policy; PostgreSQL \xHHH → JS \u{HHH}); first_name is checked
       before last_name; only the caller's own row is updated (RLS self-update).
   Every call is logged to window.__WP5_SUPA_LOG ({op:"select"|"insert"|...|"rpc"|"signInWithPassword"|"signOut", ...})
   and, when the test exposed it (page.exposeBinding), also to window.__wp5Sink(entry) so the log survives navigation. */
(function () {
  var cfg = window.__WP5_SUPA || {};
  var log = (window.__WP5_SUPA_LOG = []);
  function L(e) { log.push(e); try { if (typeof window.__wp5Sink === "function") window.__wp5Sink(e); } catch (_) {} }
  window.__WP5_SUPA_FAIL_NEXT = window.__WP5_SUPA_FAIL_NEXT || {};
  var clone = function (v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
  var KEY = "__wp5_stub_state";
  var persist = cfg.persist !== false;
  var saved = null;
  if (persist) { try { saved = JSON.parse(window.sessionStorage.getItem(KEY) || "null"); } catch (_) { saved = null; } }
  var user = saved ? saved.user : (cfg.user || null);
  var tables = saved ? saved.tables : clone(cfg.tables || {});
  var prefs = saved ? saved.prefs : clone(cfg.prefs || {});
  function keep() { if (!persist) return; try { window.sessionStorage.setItem(KEY, JSON.stringify({ user: user, tables: tables, prefs: prefs })); } catch (_) {} }
  keep();
  var OWNED = { members: 1, trips: 1, favorites: 1 };
  var WP5_COLS = ["first_name", "last_name"];
  var PREF_KEYS = ["trip_created_confirmation", "trip_updated_confirmation", "trip_start_minus_7_days", "trip_start_minus_1_day", "plan_saved_confirmation", "plan_reminder", "welcome_service_email"];
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var idemSeen = {};
  function table(name) { return (tables[name] = tables[name] || []); }
  function visible(name) {
    var rows = table(name);
    if (cfg.rls === false || !OWNED[name]) return rows.slice();
    if (!user) return [];
    return rows.filter(function (r) { return r && r.user_id === user.id; });
  }
  function colsOf(cols) { return (!cols || cols === "*") ? null : String(cols).split(",").map(function (c) { return c.trim(); }).filter(Boolean); }
  function project(name, row, cols) {
    var r = clone(row), list = colsOf(cols);
    if (name === "members") WP5_COLS.forEach(function (c) { if (cfg.backendMissing) delete r[c]; else if (r[c] === undefined) r[c] = null; });
    if (!list) return r;
    var out = {};
    list.forEach(function (c) { out[c] = (r[c] === undefined) ? null : r[c]; });
    return out;
  }
  function wait(ms, v) { return ms ? new Promise(function (r) { setTimeout(function () { r(v); }, ms); }) : Promise.resolve(v); }
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
      var out, delay = 0;
      if (st.op === "select") {
        var list = colsOf(st.cols) || [];
        L({ table: name, op: "select", cols: st.cols || "*", anon: !user });
        if (name === "members" && cfg.backendMissing && list.some(function (c) { return WP5_COLS.indexOf(c) > -1; })) {
          var miss = list.filter(function (c) { return WP5_COLS.indexOf(c) > -1; })[0];
          out = { data: null, error: { code: "42703", message: "column members." + miss + " does not exist", details: null, hint: null }, status: 400 };
        } else {
          var rows = visible(name).filter(function (r) { return st.filters.every(function (f) { return f(r); }); }).map(function (r) { return project(name, r, st.cols); });
          out = st.single ? { data: rows[0] || null, error: null, status: 200 } : { data: rows, error: null, status: 200 };
        }
        var sd = cfg.selectDelayMs || {};
        list.forEach(function (c) { [name + ":" + c, name + ":" + c + "@" + (user ? user.id : "anon")].forEach(function (k) { if (sd[k]) delay = Math.max(delay, sd[k]); }); });
      } else if (st.op === "insert") {
        var vals = [].concat(st.value || []).map(clone), t = table(name);
        if (OWNED[name] && (!user || !vals.every(function (r) { return r && r.user_id === user.id; }))) out = { data: null, error: { message: "new row violates row-level security policy" } };
        else {
          vals.forEach(function (r) { if (r.id == null) r.id = t.reduce(function (m, x) { return Math.max(m, Number(x.id) || 0); }, 100) + 1; if (name === "trips") { if (r.revision == null) r.revision = 1; if (r.archived_at === undefined) r.archived_at = null; } t.push(r); });
          out = st.single ? { data: clone(vals[0]) || null, error: null } : { data: vals.map(clone), error: null };
          keep();
        }
      } else out = { data: st.single ? null : [], error: null };
      return wait(delay, out).then(res, rej);
    };
    return b;
  }
  function fail(name) {
    var f = window.__WP5_SUPA_FAIL_NEXT[name];
    if (f) { delete window.__WP5_SUPA_FAIL_NEXT[name]; return f; }
    if (cfg.rpcError && cfg.rpcError[name]) return "error";
    return null;
  }

  /* ---- name policy v1: CHECK literals verbatim from WP5_DB_up.sql (SQL string literals, '' = one quote) ---- */
  var SQL_WS = "'[\\x09-\\x0d\\x20\\x85\\xa0\\x1680\\x2000-\\x200a\\x2028\\x2029\\x202f\\x205f\\x3000]+'";
  var SQL_CHECK = [
    ["!~", "'[\\x01-\\x1f\\x21-\\x26\\x28-\\x2c\\x2f-\\x40\\x5b-\\x60\\x7b-\\xbf\\xd7\\xf7\\x2c2-\\x2c5\\x34f\\x600-\\x605\\x61c\\x660-\\x669\\x6dd\\x6f0-\\x6f9\\x70f\\x890\\x891\\x8e2\\x115f-\\x1160\\x1680\\x17b4-\\x17b5\\x180b-\\x180f\\x1ab0-\\x1aff\\x1dc0-\\x1dff\\x2000-\\x200f\\x2011-\\x2018\\x201a-\\x2bff\\x3000-\\x303f\\x3164\\xe000-\\xf8ff\\xfdd0-\\xfdef\\xfe00-\\xfe6f\\xfeff\\xff00-\\xffff\\x110bd\\x110cd\\x13430-\\x1343f\\x1bca0-\\x1bca3\\x1d000-\\x1d7ff\\x1f000-\\x1fbff\\xe0000-\\x10ffff]'"],
    ["~", "'[\\x41-\\x5a\\x61-\\x7a\\xc0-\\x24f\\x370-\\x373\\x376-\\x377\\x37b-\\x37d\\x37f\\x386\\x388-\\x3ff\\x400-\\x482\\x48a-\\x52f\\x531-\\x556\\x560-\\x588\\x5d0-\\x5ea\\x5ef-\\x5f2\\x620-\\x63f\\x641-\\x64a\\x66e-\\x66f\\x671-\\x6d3\\x6d5\\x6ee-\\x6ef\\x6fa-\\x6fc\\x6ff\\x710-\\x72f\\x74d-\\x7a5\\x7ca-\\x7ea\\x8a0-\\x8c9\\x904-\\x939\\x93d\\x950\\x958-\\x961\\x971-\\x97f\\x980-\\xdff\\xe01-\\xe30\\xe32-\\xe33\\xe40-\\xe46\\xe81-\\xeb0\\xeb2-\\xeb3\\xebd-\\xec6\\xf40-\\xf6c\\x1000-\\x102a\\x10a0-\\x10ff\\x1200-\\x137f\\x13a0-\\x13fd\\x1401-\\x166c\\x1780-\\x17b3\\x1820-\\x1878\\x1c90-\\x1cbf\\x1e00-\\x1fff\\x2d30-\\x2d67\\x3041-\\x3096\\x309d-\\x309f\\x30a1-\\x30fa\\x30fc-\\x30ff\\x3400-\\x4dbf\\x4e00-\\x9fff\\xa000-\\xa48c\\xa720-\\xa7ff\\xac00-\\xd7a3\\x1e900-\\x1e943\\x20000-\\x3134f]'"],
    ["!~", "'^[ ''.\\x2010\\x2019\\x300-\\x36f\\x483-\\x489\\x591-\\x5bd\\x5bf\\x5c1-\\x5c2\\x5c4-\\x5c5\\x5c7\\x610-\\x61a\\x64b-\\x65f\\x670\\x6d6-\\x6dc\\x6df-\\x6e4\\x6e7-\\x6e8\\x6ea-\\x6ed\\x900-\\x903\\x93a-\\x93c\\x93e-\\x94f\\x951-\\x957\\x962-\\x963-]'"],
    ["!~", "'[ \\x2010-]$'"],
    ["!~", "'  '"],
    ["!~", "'[''.\\x2010\\x2019-]{2}'"],
    ["!~", "'[\\x300-\\x36f\\x483-\\x489\\x591-\\x5bd\\x5bf\\x5c1-\\x5c2\\x5c4-\\x5c5\\x5c7\\x610-\\x61a\\x64b-\\x65f\\x670\\x6d6-\\x6dc\\x6df-\\x6e4\\x6e7-\\x6e8\\x6ea-\\x6ed\\x900-\\x903\\x93a-\\x93c\\x93e-\\x94f\\x951-\\x957\\x962-\\x963]{3}'"]
  ];
  function pgRe(lit, flags) { return new RegExp(lit.slice(1, -1).replace(/''/g, "'").replace(/\\x([0-9a-fA-F]+)/g, function (_, h) { return "\\u{" + h + "}"; }), "u" + (flags || "")); }
  var WS = pgRe(SQL_WS, "g");
  var CHECK = SQL_CHECK.map(function (c) { return { neg: c[0] === "!~", re: pgRe(c[1]) }; });
  function cpLen(s) { return Array.from(s).length; }
  function serverNorm(s) { return (s === null || s === undefined) ? null : String(s).replace(WS, " ").replace(/^ +| +$/g, "").normalize("NFC"); }
  function policyOk(v) {
    if (v === null) return true;
    var n = cpLen(v);
    if (n < 1 || n > 50) return false;
    if (v !== v.normalize("NFC") || v !== v.replace(/^ +| +$/g, "")) return false;
    return CHECK.every(function (c) { return c.neg ? !c.re.test(v) : c.re.test(v); });
  }
  window.__WP5_POLICY = { normalize: serverNorm, ok: policyOk };   // test-only introspection

  function rpc(name, args) {
    L({ op: "rpc", name: name, args: clone(args), anon: !user });
    var f = fail(name);
    if (f === "throw") throw new TypeError("Failed to fetch (stub)");
    if (f === "error") return { data: null, error: { message: (cfg.rpcError && cfg.rpcError[name]) || "stub failure" }, status: 500 };
    if (f === "notok") return { data: { ok: false, reason: "stub" }, error: null };
    if (typeof f === "string" && f.indexOf("reason:") === 0) return { data: { ok: false, reason: f.slice(7) }, error: null };
    var a = args || {};
    if (name === "member_upsert_profile") {
      if (!user) return { data: { ok: false, reason: "no_auth" }, error: null };
      var t = table("members"), row = t.filter(function (r) { return r && r.user_id === user.id; })[0];
      if (!row) {
        row = { user_id: user.id, email: user.email, display_name: a.p_display_name == null ? null : a.p_display_name, bio: a.p_bio == null ? null : a.p_bio, home_city: a.p_home_city == null ? null : a.p_home_city, gender: a.p_gender == null ? null : a.p_gender, tier: "Kaşif", points: 0, blocked: false };
        if (!cfg.backendMissing) { row.first_name = null; row.last_name = null; }
        t.push(row);
      } else {
        ["display_name", "bio", "home_city", "gender"].forEach(function (k) { var v = a["p_" + k]; if (v !== null && v !== undefined) row[k] = v; });
        row.email = user.email;
      }
      keep();
      return { data: { ok: true }, error: null };
    }
    if (name === "member_set_name") {
      if (cfg.backendMissing) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.member_set_name(p_first, p_last) in the schema cache", details: "Searched for the function public.member_set_name with parameters p_first, p_last", hint: null }, status: 404 };
      var bad = function (r) { return { data: { ok: false, reason: r }, error: null }; };
      if (!user) return bad("no_auth");
      if (a.p_first != null && cpLen(String(a.p_first)) > 200) return bad("bad_first");
      if (a.p_last != null && cpLen(String(a.p_last)) > 200) return bad("bad_last");
      var vf = serverNorm(a.p_first), vl = serverNorm(a.p_last);
      if (vf === null || vf === "") return bad("bad_first");
      if (vl === null || vl === "") return bad("bad_last");
      var own = table("members").filter(function (r) { return r && r.user_id === user.id; })[0];   // RLS self-update: own row only
      if (!own) return bad("no_member_row");
      if (!policyOk(vf)) return bad("bad_first");
      if (!policyOk(vl)) return bad("bad_last");
      own.first_name = vf; own.last_name = vl;
      keep();
      return { data: { ok: true }, error: null };
    }
    if (name === "consent_get_my_state") {
      if (!user) return { data: null, error: { message: "no_auth" } };
      return { data: { consent: {}, service_prefs: clone(prefs) }, error: null };
    }
    if (name === "service_pref_set") {
      if (!user) return { data: null, error: { message: "no_auth" } };
      if (PREF_KEYS.indexOf(a.p_key) < 0) return { data: null, error: { message: "invalid input value for enum service_pref_key" } };
      if (typeof a.p_enabled !== "boolean") return { data: null, error: { message: "p_enabled must be boolean" } };
      if (typeof a.p_request_id !== "string" || !a.p_request_id.trim() || a.p_request_id.trim().length > 80) return { data: null, error: { message: "request_id_required" } };
      if (typeof a.p_idem !== "string" || !UUID.test(a.p_idem)) return { data: null, error: { message: "invalid input syntax for type uuid" } };
      if (idemSeen[a.p_idem]) return { data: clone(idemSeen[a.p_idem]), error: null };
      prefs[a.p_key] = a.p_enabled;
      keep();
      var r = { ok: true, key: a.p_key, enabled: a.p_enabled };
      idemSeen[a.p_idem] = r;
      return { data: clone(r), error: null };
    }
    if (name === "trip_save") {
      var tr = table("trips").filter(function (x) { return x.id === a.p_id; })[0];
      if (!tr || !user || (cfg.rls !== false && tr.user_id !== user.id)) return { data: { ok: false, reason: "not_found" }, error: null };
      Object.assign(tr, a.p_patch || {});
      tr.revision = (tr.revision || 0) + 1;
      keep();
      return { data: { ok: true, revision: tr.revision }, error: null };
    }
    var data = cfg.rpc && Object.prototype.hasOwnProperty.call(cfg.rpc, name) ? clone(cfg.rpc[name]) : null;
    return { data: data, error: null };
  }
  function client() {
    return {
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: user ? { user: clone(user) } : null }, error: null }); },
        getUser: function () { return Promise.resolve({ data: { user: clone(user) }, error: null }); },
        signOut: function () { L({ op: "signOut" }); user = null; keep(); return new Promise(function (r) { setTimeout(function () { r({ error: null }); }, cfg.signOutDelayMs || 0); }); },
        signInWithPassword: function (c) {
          c = c || {};
          var acc = (cfg.accounts || []).filter(function (x) { return x && x.email === c.email && x.password === c.password; })[0];
          L({ op: "signInWithPassword", ok: !!acc });
          if (!acc) return Promise.resolve({ data: { user: null, session: null }, error: { message: "Invalid login credentials" } });
          user = { id: acc.id, email: acc.email }; keep();
          return Promise.resolve({ data: { user: clone(user), session: { user: clone(user) } }, error: null });
        },
        signUp: function () { L({ op: "signUp" }); return Promise.resolve({ data: {}, error: { message: "stub" } }); },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
      },
      from: builder,
      rpc: function (name, args) {
        var d = (cfg.rpcDelayMs && cfg.rpcDelayMs[name]) || 0;
        return wait(d).then(function () { return rpc(name, args); });
      },
      storage: { from: function () { return { upload: function () { return Promise.resolve({ data: null, error: { message: "stub" } }); }, getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
      channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
      removeChannel: function () {}
    };
  }
  window.supabase = { createClient: function () { return client(); } };
})();
