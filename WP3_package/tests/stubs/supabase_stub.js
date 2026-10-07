/* WP3 test stub for @supabase/supabase-js (served via Playwright route; never deployed).
   Reads window.__WP3_SUPA = { user, tables: { name: [rows] }, rpc: { name: data } }.
   Logs every write-shaped call to window.__WP3_SUPA_LOG. No network. */
(function () {
  var cfg = window.__WP3_SUPA || {};
  var log = (window.__WP3_SUPA_LOG = []);
  function rows(table) { return (cfg.tables && cfg.tables[table]) || []; }
  function builder(table) {
    var st = { op: "select", single: false };
    var b = {};
    ["select", "eq", "neq", "is", "in", "lte", "gte", "lt", "gt", "order", "limit", "range", "match", "filter", "not", "or", "contains", "ilike", "like"].forEach(function (m) {
      b[m] = function () { return b; };
    });
    ["insert", "upsert", "update", "delete"].forEach(function (op) {
      b[op] = function (value) { st.op = op; log.push({ table: table, op: op, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }); return b; };
    });
    b.single = function () { st.single = true; return b; };
    b.maybeSingle = b.single;
    b.then = function (res, rej) {
      var out;
      if (st.op === "select") out = st.single ? { data: rows(table)[0] || null, error: null } : { data: rows(table).slice(), error: null };
      else out = { data: st.single ? null : [], error: null };
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  }
  function client() {
    var user = cfg.user || null;
    return {
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: user ? { user: user } : null }, error: null }); },
        getUser: function () { return Promise.resolve({ data: { user: user }, error: null }); },
        signOut: function () { log.push({ op: "signOut" }); return Promise.resolve({ error: null }); },
        signInWithPassword: function () { return Promise.resolve({ data: {}, error: { message: "stub" } }); },
        signUp: function () { return Promise.resolve({ data: {}, error: { message: "stub" } }); },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
      },
      from: builder,
      rpc: function (name, args) {
        log.push({ op: "rpc", name: name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
        var data = cfg.rpc && Object.prototype.hasOwnProperty.call(cfg.rpc, name) ? cfg.rpc[name] : null;
        return Promise.resolve({ data: data, error: null });
      },
      storage: { from: function () { return { upload: function () { return Promise.resolve({ data: null, error: { message: "stub" } }); }, getPublicUrl: function () { return { data: { publicUrl: "" } }; } }; } },
      channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
      removeChannel: function () {}
    };
  }
  window.supabase = { createClient: function () { return client(); } };
})();
