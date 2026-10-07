/* WP6 DRY-RUN stub for @supabase/supabase-js@2 (served by dryrun/playwright_shim.cjs via Playwright route(); never deployed).
   Copied from WP4_package/tests/stubs/supabase_stub.js (same client surface: auth, from() builder, rpc, storage, channel)
   and extended for the WP6 end-to-end run:
   - Every call is a real HTTP request to https://tosqsabuaomgqjtogdrn.supabase.co (/auth/v1/token, /auth/v1/logout,
     /rest/v1/<table>, /rest/v1/rpc/<fn>). The shim answers them from ONE in-memory backend shared by all browser
     contexts, so cross-context isolation (QA member vs second member) and persistence across reload/new context are real,
     and wp6_live.mjs's network monitor sees the same hosts/paths/status codes as in production.
     Methods/headers as supabase-js: select GET (query also in ?wp6q=), insert/upsert POST, update PATCH, delete DELETE,
     rpc POST /rest/v1/rpc/<fn>; apikey + Authorization: Bearer <session token>. (Playwright answers CORS preflights of
     routed requests itself.)
   - signInWithPassword succeeds for any e-mail with a non-empty password; user = { id: deterministic uuid per e-mail, email }.
   - The session is persisted like supabase-js v2: localStorage "sb-<ref>-auth-token" (survives reload/navigation, shared by
     every client on the origin; signOut removes it).
   - Backend semantics (shim): RLS by user_id on members/trips/favorites/trip_plan_versions/comments; favorites.user_id filled
     from auth.uid() (live trigger); upsert onConflict/ignoreDuplicates; eq/neq/is/in/lt/lte/gt/gte filters; order;
     rpc consent_get_my_state / service_pref_set / member_upsert_profile / trip_save / trip_snapshot_plan / log_city_view / ... */
(function () {
  var REF = "tosqsabuaomgqjtogdrn";
  var API = "https://" + REF + ".supabase.co";
  var KEY = "sb-" + REF + "-auth-token";
  var log = (window.__WP6_SUPA_LOG = []);
  function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
  function sess() { try { var s = JSON.parse(localStorage.getItem(KEY) || "null"); return s && s.user && s.access_token ? s : null; } catch (e) { return null; } }
  function keep(s) { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch (e) {} }
  function http(method, path, body, query) {
    var s = sess();
    var h = { apikey: "dryrun-anon-key", "Content-Type": "application/json" };
    if (s) h.Authorization = "Bearer " + s.access_token;
    var url = API + path + (query ? (path.indexOf("?") >= 0 ? "&" : "?") + query : "");
    return fetch(url, { method: method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}), credentials: "omit" })
      .then(function (r) { return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, json: j }; }); });
  }
  function errOf(r) { return (r.json && r.json.error) || { message: "http " + r.status }; }

  function builder(table) {
    var q = { table: table, op: "select", cols: "*", filters: [], order: [], single: false, maybe: false, value: null, opts: null, ret: false };
    var b = {};
    ["limit", "range", "match", "filter", "not", "or", "contains", "ilike", "like", "textSearch", "abortSignal", "returns", "csv"].forEach(function (m) { b[m] = function () { return b; }; });
    b.select = function (cols) { if (q.op === "select") q.cols = cols || "*"; else q.ret = true; return b; };
    ["eq", "neq", "is", "in", "lt", "lte", "gt", "gte"].forEach(function (k) { b[k] = function (c, v) { q.filters.push([k, c, clone(v)]); return b; }; });
    b.order = function (c, o) { q.order.push([c, !(o && o.ascending === false)]); return b; };
    ["insert", "upsert", "update", "delete"].forEach(function (op) { b[op] = function (v, o) { q.op = op; q.value = clone(v); q.opts = o ? clone(o) : null; return b; }; });
    b.single = function () { q.single = true; return b; };
    b.maybeSingle = function () { q.single = true; q.maybe = true; return b; };
    b.then = function (res, rej) {
      log.push({ table: table, op: q.op });
      var M = { select: "GET", insert: "POST", upsert: "POST", update: "PATCH", "delete": "DELETE" }[q.op] || "POST";
      var qs = M === "GET" ? "select=" + encodeURIComponent(q.cols) + "&wp6q=" + encodeURIComponent(JSON.stringify(q)) : "";
      var p = http(M, "/rest/v1/" + encodeURIComponent(table), M === "GET" ? null : q, qs).then(function (r) {
        if (r.status >= 400) return { data: null, error: errOf(r), status: r.status };
        var rows = (r.json && r.json.data) || [];
        if (q.single) {
          if (!q.maybe && rows.length !== 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" }, status: 406 };
          return { data: rows[0] || null, error: null, status: r.status };
        }
        return { data: (q.op === "select" || q.ret) ? rows : null, error: null, status: r.status };
      }, function () { return { data: null, error: { message: "Failed to fetch" } }; });
      return p.then(res, rej);
    };
    return b;
  }
  function rpc(name, args) {
    log.push({ op: "rpc", name: name });
    return http("POST", "/rest/v1/rpc/" + encodeURIComponent(name), args || {}).then(function (r) {
      if (r.status >= 400) return { data: null, error: errOf(r) };
      return { data: r.json ? clone(r.json.data) : null, error: null };
    }, function () { return { data: null, error: { message: "Failed to fetch" } }; });
  }
  function client() {
    return {
      auth: {
        getSession: function () { var s = sess(); return Promise.resolve({ data: { session: s ? { user: clone(s.user), access_token: s.access_token, token_type: "bearer" } : null }, error: null }); },
        getUser: function () { var s = sess(); return Promise.resolve({ data: { user: s ? clone(s.user) : null }, error: null }); },
        signInWithPassword: function (c) {
          log.push({ op: "signInWithPassword" });
          c = c || {};
          return http("POST", "/auth/v1/token?grant_type=password", { email: c.email, password: c.password }).then(function (r) {
            if (r.status !== 200 || !r.json || !r.json.user) return { data: { user: null, session: null }, error: { message: (r.json && r.json.error_description) || "Invalid login credentials" } };
            keep({ access_token: r.json.access_token, token_type: "bearer", user: r.json.user });
            return { data: { user: clone(r.json.user), session: { user: clone(r.json.user), access_token: r.json.access_token } }, error: null };
          }, function () { return { data: {}, error: { message: "Failed to fetch" } }; });
        },
        signUp: function () { log.push({ op: "signUp" }); return Promise.resolve({ data: {}, error: { message: "dry-run: sign-up disabled" } }); },
        signOut: function () {
          log.push({ op: "signOut" });
          return http("POST", "/auth/v1/logout", {}).then(function () { keep(null); return { error: null }; }, function () { keep(null); return { error: null }; });
        },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
      },
      from: builder,
      rpc: function (name, args) { return rpc(name, args); },
      storage: { from: function () { return { upload: function () { return Promise.resolve({ data: null, error: { message: "dry-run" } }); }, getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
      channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
      removeChannel: function () {}
    };
  }
  window.supabase = { createClient: function () { return client(); } };
})();
