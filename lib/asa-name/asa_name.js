/* =====================================================================
 * ASALOCAL · asa_name.js — WP5 (İŞ PAKETİ 5) özel ad / soyad yardımcıları
 *
 * Loaded as /lib/asa-name/asa_name.js?v=<sha256(16)> by index.html and
 * amsterdam/index.html (attaches window.ASA_NAME; node: module.exports).
 * Backend contract (applied to production separately; may be absent):
 *   - public.members.first_name / last_name (text, NULL = not given), readable
 *     only by the owner (RLS self-select):
 *       db.from("members").select("first_name,last_name").eq("user_id",uid).maybeSingle()
 *   - rpc member_set_name(p_first, p_last) -> {ok:true} |
 *       {ok:false, reason:'no_auth'|'bad_first'|'bad_last'|'no_member_row'}
 *     The server normalizes and enforces name policy v1 and is AUTHORITATIVE.
 * Missing backend (42703 on the select, PGRST202 / 404 on the rpc) => load()
 * reports supported:false and the pages show no name UI at all.
 *
 * Client policy = a copy of the server CHECK (members_*_wp5_policy, name
 * policy v1). The character classes below are the CHECK's own bracket
 * expressions, written in PostgreSQL \xHHH notation and converted to JS
 * \u{HHH} at load time, so they can be diffed against WP5_DB_up.sql. The
 * client additionally refuses U+0000 and lone surrogates (the server cannot
 * store either). Never stricter than the server for storable text.
 *
 * Safety: no innerHTML anywhere; names are written with .value / textContent.
 * Browser storage: only the dismissal flag asa:name_prompt_dismissed:<uid>
 * (localStorage, every access in try/catch; falls back to memory for the
 * page's lifetime when storage is unavailable or throws).
 * ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ASA_NAME = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var VERSION = 1;
  var MAX = 50;          // P1: 1..50 code points (after normalization)
  var RAW_MAX = 200;     // member_set_name refuses longer raw input before normalizing
  var DISMISS_PREFIX = "asa:name_prompt_dismissed:";

  // --- name policy v1, bracket expressions verbatim from the CHECK (PostgreSQL ARE, \xHHH = one code point) ---
  var SQL = {
    // member_set_name: every whitespace run -> one U+0020
    ws: "[\\x09-\\x0d\\x20\\x85\\xa0\\x1680\\x2000-\\x200a\\x2028\\x2029\\x202f\\x205f\\x3000]+",
    // P4/P5: forbidden code points (digits, HTML/template/punctuation, controls, invisible/format, symbols, emoji, PUA ...)
    forbidden: "[\\x01-\\x1f\\x21-\\x26\\x28-\\x2c\\x2f-\\x40\\x5b-\\x60\\x7b-\\xbf\\xd7\\xf7\\x2c2-\\x2c5\\x34f\\x600-\\x605\\x61c\\x660-\\x669\\x6dd\\x6f0-\\x6f9\\x70f\\x890\\x891\\x8e2\\x115f-\\x1160\\x1680\\x17b4-\\x17b5\\x180b-\\x180f\\x1ab0-\\x1aff\\x1dc0-\\x1dff\\x2000-\\x200f\\x2011-\\x2018\\x201a-\\x2bff\\x3000-\\x303f\\x3164\\xe000-\\xf8ff\\xfdd0-\\xfdef\\xfe00-\\xfe6f\\xfeff\\xff00-\\xffff\\x110bd\\x110cd\\x13430-\\x1343f\\x1bca0-\\x1bca3\\x1d000-\\x1d7ff\\x1f000-\\x1fbff\\xe0000-\\x10ffff]",
    // P7: at least one letter-like code point (any script)
    letter: "[\\x41-\\x5a\\x61-\\x7a\\xc0-\\x24f\\x370-\\x373\\x376-\\x377\\x37b-\\x37d\\x37f\\x386\\x388-\\x3ff\\x400-\\x482\\x48a-\\x52f\\x531-\\x556\\x560-\\x588\\x5d0-\\x5ea\\x5ef-\\x5f2\\x620-\\x63f\\x641-\\x64a\\x66e-\\x66f\\x671-\\x6d3\\x6d5\\x6ee-\\x6ef\\x6fa-\\x6fc\\x6ff\\x710-\\x72f\\x74d-\\x7a5\\x7ca-\\x7ea\\x8a0-\\x8c9\\x904-\\x939\\x93d\\x950\\x958-\\x961\\x971-\\x97f\\x980-\\xdff\\xe01-\\xe30\\xe32-\\xe33\\xe40-\\xe46\\xe81-\\xeb0\\xeb2-\\xeb3\\xebd-\\xec6\\xf40-\\xf6c\\x1000-\\x102a\\x10a0-\\x10ff\\x1200-\\x137f\\x13a0-\\x13fd\\x1401-\\x166c\\x1780-\\x17b3\\x1820-\\x1878\\x1c90-\\x1cbf\\x1e00-\\x1fff\\x2d30-\\x2d67\\x3041-\\x3096\\x309d-\\x309f\\x30a1-\\x30fa\\x30fc-\\x30ff\\x3400-\\x4dbf\\x4e00-\\x9fff\\xa000-\\xa48c\\xa720-\\xa7ff\\xac00-\\xd7a3\\x1e900-\\x1e943\\x20000-\\x3134f]",
    // P6: first char may not be space / apostrophe / period / hyphen / combining mark
    start: "^[ '.\\x2010\\x2019\\x300-\\x36f\\x483-\\x489\\x591-\\x5bd\\x5bf\\x5c1-\\x5c2\\x5c4-\\x5c5\\x5c7\\x610-\\x61a\\x64b-\\x65f\\x670\\x6d6-\\x6dc\\x6df-\\x6e4\\x6e7-\\x6e8\\x6ea-\\x6ed\\x900-\\x903\\x93a-\\x93c\\x93e-\\x94f\\x951-\\x957\\x962-\\x963-]",
    end: "[ \\x2010-]$",
    double: "  ",
    pair: "['.\\x2010\\x2019-]{2}",
    marks3: "[\\x300-\\x36f\\x483-\\x489\\x591-\\x5bd\\x5bf\\x5c1-\\x5c2\\x5c4-\\x5c5\\x5c7\\x610-\\x61a\\x64b-\\x65f\\x670\\x6d6-\\x6dc\\x6df-\\x6e4\\x6e7-\\x6e8\\x6ea-\\x6ed\\x900-\\x903\\x93a-\\x93c\\x93e-\\x94f\\x951-\\x957\\x962-\\x963]{3}",
    // client only: text the server cannot store at all
    unstorable: "[\\x00\\xd800-\\xdfff]"
  };
  function rx(sql, flags) { return new RegExp(sql.replace(/\\x([0-9a-fA-F]+)/g, function (_, h) { return "\\u{" + h + "}"; }), "u" + (flags || "")); }
  var RX = {};
  for (var k in SQL) if (Object.prototype.hasOwnProperty.call(SQL, k)) RX[k] = rx(SQL[k], k === "ws" ? "g" : "");

  var FIELD = { first: "Ad", last: "Soyad" };
  var OK_MSG = "Adın ve soyadın kaydedildi.";
  var SERVER_MSG = {
    bad_first: "Ad kaydedilemedi: yalnız harf, boşluk, kesme işareti, tire ve nokta kullan (en fazla 50 karakter).",
    bad_last: "Soyad kaydedilemedi: yalnız harf, boşluk, kesme işareti, tire ve nokta kullan (en fazla 50 karakter).",
    no_auth: "Oturumun sona ermiş. Tekrar giriş yapıp yeniden dene.",
    no_member_row: "Üyelik kaydın henüz hazır değil. Sayfayı yenileyip tekrar dene.",
    unsupported: "Ad ve soyad şu an kaydedilemiyor. Daha sonra tekrar dene.",
    error: "Kaydedilemedi. Bağlantını kontrol edip tekrar dene.",
    unknown: "Kaydedilemedi. Biraz sonra tekrar dene."
  };
  function has(o, key) { return !!o && Object.prototype.hasOwnProperty.call(o, key); }
  function cpLen(s) { var n = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { var d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d <= 0xdfff) i++; } n++; } return n; }

  // member_set_name order: whitespace runs -> one space, trim spaces, NFC
  function normalize(s) {
    if (s === null || s === undefined) return "";
    var v = String(s).replace(RX.ws, " ").replace(/^ +| +$/g, "");
    try { v = v.normalize("NFC"); } catch (e) {}
    return v;
  }

  function message(code, field) {
    var L = FIELD[field] || FIELD.first;
    if (code === "empty") return L + " boş bırakılamaz.";
    if (code === "too_long") return L + " en fazla " + MAX + " karakter olabilir.";
    if (code === "shape") return L + " boşluk, kesme işareti, nokta ya da tireyle başlayamaz; boşluk ya da tireyle bitemez; iki işaret yan yana gelemez.";
    if (code === "no_letter") return L + " en az bir harf içermeli.";
    return L + " yalnız harf, boşluk, kesme işareti (’), tire (-) ve nokta içerebilir; rakam, simge, emoji ve HTML kullanılamaz.";
  }

  // -> {ok:true, value} | {ok:false, reason:'empty'|'too_long'|'chars'|'shape'|'no_letter', message}
  function validate(raw, field) {
    var f = (field === "last") ? "last" : "first";
    var bad = function (code) { return { ok: false, reason: code, field: f, message: message(code, f) }; };
    if (raw !== null && raw !== undefined && typeof raw !== "string") raw = String(raw);
    if (RX.unstorable.test(raw || "")) return bad("chars");
    var v = normalize(raw);
    if (!v) return bad("empty");
    if (cpLen(raw) > RAW_MAX || cpLen(v) > MAX) return bad("too_long");
    if (RX.forbidden.test(v) || RX.marks3.test(v) || RX.unstorable.test(v)) return bad("chars");
    if (RX.start.test(v) || RX.end.test(v) || v.indexOf(SQL.double) > -1 || RX.pair.test(v)) return bad("shape");
    if (!RX.letter.test(v)) return bad("no_letter");
    return { ok: true, value: v, field: f };
  }

  function filled(s) { return typeof s === "string" && normalize(s) !== ""; }
  function isComplete(n) { return !!n && filled(n.first) && filled(n.last); }
  function isUid(uid) { return typeof uid === "string" && uid.length > 0 && uid.length <= 128; }
  function errCode(e) { return (e && (e.code || e.status)) ? String(e.code || e.status) : ""; }
  function missingColumn(e) { var c = errCode(e); return c === "42703" || c === "PGRST204" || /column .*does not exist/i.test((e && e.message) || ""); }
  function missingRpc(e, status) { var c = errCode(e); return status === 404 || c === "PGRST202" || c === "42883" || c === "404" || /could not find the function/i.test((e && e.message) || ""); }

  // Own row only. Never throws. supported=false: columns absent / unreadable (=> no name UI);
  // ready=false: no members row yet (member_set_name would answer no_member_row).
  async function load(db, uid) {
    var out = { supported: false, ready: false, first: null, last: null, reason: "no_client" };
    if (!db || typeof db.from !== "function" || !isUid(uid)) return out;
    try {
      var r = await db.from("members").select("first_name,last_name").eq("user_id", uid).maybeSingle();
      if (!r || r.error) { out.reason = (r && missingColumn(r.error)) ? "missing" : "error"; return out; }
      var row = r.data;
      if (row === null || row === undefined) { out.supported = true; out.reason = "no_row"; return out; }
      if (typeof row !== "object" || !has(row, "first_name") || !has(row, "last_name")) { out.reason = "missing"; return out; }
      out.supported = true; out.ready = true; out.reason = "ok";
      out.first = (typeof row.first_name === "string" && row.first_name !== "") ? row.first_name : null;
      out.last = (typeof row.last_name === "string" && row.last_name !== "") ? row.last_name : null;
      return out;
    } catch (e) { out.reason = "error"; return out; }
  }

  // Validates, calls member_set_name, maps the answer. Never throws.
  // -> {ok:true, first, last, message} | {ok:false, reason, field:'first'|'last'|null, message}
  async function save(db, first, last) {
    var a = validate(first, "first"), b = validate(last, "last");
    if (!a.ok) return { ok: false, reason: "bad_first", field: "first", code: a.reason, message: a.message + (b.ok ? "" : " " + b.message) };
    if (!b.ok) return { ok: false, reason: "bad_last", field: "last", code: b.reason, message: b.message };
    var fail = function (reason) { var r = has(SERVER_MSG, reason) ? reason : "unknown"; return { ok: false, reason: r, field: r === "bad_first" ? "first" : (r === "bad_last" ? "last" : null), message: SERVER_MSG[r] }; };
    if (!db || typeof db.rpc !== "function") return fail("unsupported");
    var res;
    try { res = await db.rpc("member_set_name", { p_first: a.value, p_last: b.value }); }
    catch (e) { return fail("error"); }
    if (!res) return fail("error");
    if (res.error) return fail(missingRpc(res.error, res.status) ? "unsupported" : "error");
    var d = res.data;
    if (d && d.ok === true) return { ok: true, first: a.value, last: b.value, message: OK_MSG };
    return fail((d && typeof d.reason === "string") ? d.reason : "unknown");
  }

  // --- "Şimdi değil": one flag per member, never blocks when storage throws ---
  var mem = Object.create(null);
  function dismissKey(uid) { return DISMISS_PREFIX + uid; }
  function storageOf(s) { if (s) return s; try { return (typeof window !== "undefined" && window.localStorage) || null; } catch (e) { return null; } }
  function isDismissed(uid, storage) {
    if (!isUid(uid)) return false;
    if (mem[uid]) return true;
    try { var s = storageOf(storage); return !!s && s.getItem(dismissKey(uid)) !== null; } catch (e) { return false; }
  }
  // -> true when persisted; false when only remembered for this page (storage unavailable)
  function dismiss(uid, storage) {
    if (!isUid(uid)) return false;
    mem[uid] = true;
    try { var s = storageOf(storage); if (!s) return false; s.setItem(dismissKey(uid), "1"); return true; } catch (e) { return false; }
  }
  function shouldPrompt(info, uid, storage) { return !!info && info.supported === true && info.ready === true && !isComplete(info) && !isDismissed(uid, storage); }

  // --- Ad / Soyad form (DOM API only). Ids: <prefix>Form|First|Last|Save|Later|Err|Ok.
  // opts: { prefix, values:{first,last}, db:(client | () => client), onSaved(res), onLater(), cls:{...} }
  function form(doc, opts) {
    var o = opts || {}, c = o.cls || {};
    var p = String(o.prefix || "asaName").replace(/[^A-Za-z0-9_-]/g, "") || "asaName";
    var busy = false;
    function mk(tag, cls, attrs) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (attrs) for (var a in attrs) if (has(attrs, a)) e.setAttribute(a, attrs[a]);
      return e;
    }
    function field(id, label, ac, val) {
      var w = mk("div", c.field), l = mk("label", c.label, { "for": id }), i = mk("input", c.input, { id: id, type: "text", name: ac, autocomplete: ac, maxlength: String(MAX), autocapitalize: "words", spellcheck: "false" });
      l.textContent = label;
      i.value = (typeof val === "string") ? val : "";
      w.appendChild(l); w.appendChild(i);
      return { wrap: w, input: i };
    }
    var f = mk("form", c.form, { id: p + "Form", novalidate: "" });
    f.noValidate = true;
    var grid = mk("div", c.grid);
    var vals = o.values || {};
    var fi = field(p + "First", FIELD.first, "given-name", vals.first);
    var la = field(p + "Last", FIELD.last, "family-name", vals.last);
    grid.appendChild(fi.wrap); grid.appendChild(la.wrap);
    var acts = mk("div", c.actions);
    var btn = mk("button", c.submit, { type: "submit", id: p + "Save" });
    btn.textContent = o.submitLabel || "Kaydet";
    acts.appendChild(btn);
    var later = null;
    if (typeof o.onLater === "function") {
      later = mk("button", c.later, { type: "button", id: p + "Later" });
      later.textContent = o.laterLabel || "Şimdi değil";
      later.addEventListener("click", function () { if (busy) return; try { o.onLater(); } catch (e) {} });
      acts.appendChild(later);
    }
    var err = mk("p", c.err, { id: p + "Err", role: "alert" });
    var ok = mk("p", c.ok, { id: p + "Ok", role: "status", "aria-live": "polite" });
    f.appendChild(grid); f.appendChild(acts); f.appendChild(err); f.appendChild(ok);

    function mark(input, bad) {
      if (bad) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", err.id); }
      else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
    }
    function setBusy(on) {
      busy = on;
      fi.input.readOnly = on; la.input.readOnly = on;
      [btn, later].forEach(function (b) { if (!b) return; if (on) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled"); });
      if (on) { btn.setAttribute("aria-busy", "true"); btn.textContent = "Kaydediliyor…"; }
      else { btn.removeAttribute("aria-busy"); btn.textContent = o.submitLabel || "Kaydet"; }
    }
    function focus(el) { try { el.focus(); } catch (e) {} }
    [fi.input, la.input].forEach(function (i) { i.addEventListener("input", function () { mark(i, false); ok.textContent = ""; }); });

    async function submit() {
      if (busy) return;                                   // double submit: one RPC per save
      err.textContent = ""; ok.textContent = "";          // never success and error together
      var a = validate(fi.input.value, "first"), b = validate(la.input.value, "last");
      mark(fi.input, !a.ok); mark(la.input, !b.ok);
      if (!a.ok || !b.ok) {
        err.textContent = [a, b].filter(function (x) { return !x.ok; }).map(function (x) { return x.message; }).join(" ");
        focus(!a.ok ? fi.input : la.input);
        return;
      }
      setBusy(true);
      var db = (typeof o.db === "function") ? o.db() : o.db;
      var res;
      try { res = await save(db, a.value, b.value); } catch (e) { res = { ok: false, reason: "error", field: null, message: SERVER_MSG.error }; }
      setBusy(false);
      if (res.ok) {
        fi.input.value = res.first; la.input.value = res.last;
        ok.textContent = res.message;
        if (typeof o.onSaved === "function") { try { o.onSaved(res); } catch (e) {} }
      } else {
        err.textContent = res.message;
        if (res.field === "first" || res.field === "last") { var t = res.field === "first" ? fi.input : la.input; mark(t, true); focus(t); }
      }
    }
    f.addEventListener("submit", function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); submit(); });
    // aria-disabled (not disabled) keeps keyboard focus on the button while saving; the click is ignored
    btn.addEventListener("click", function (ev) { if (busy && ev && ev.preventDefault) ev.preventDefault(); });

    return {
      el: f, first: fi.input, last: la.input, submit: btn, later: later, err: err, ok: ok,
      busy: function () { return busy; },
      setValues: function (first, last) { fi.input.value = (typeof first === "string") ? first : ""; la.input.value = (typeof last === "string") ? last : ""; mark(fi.input, false); mark(la.input, false); }
    };
  }

  return {
    VERSION: VERSION,
    MAX: MAX,
    RAW_MAX: RAW_MAX,
    SQL: SQL,
    OK_MSG: OK_MSG,
    SERVER_MSG: SERVER_MSG,
    normalize: normalize,
    validate: validate,
    message: message,
    isComplete: isComplete,
    load: load,
    save: save,
    dismissKey: dismissKey,
    isDismissed: isDismissed,
    dismiss: dismiss,
    shouldPrompt: shouldPrompt,
    form: form
  };
});
