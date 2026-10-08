// WP5 · ad-soyad ve profil tamamlama — node unit tests (no browser, no network).
//   node --test WP5_package/web/tests/wp5_unit.test.mjs
//
// 1. lib/asa-name/asa_name.js logic: normalize / validate (= server name policy v1) / load / save / dismissal / form()
//    — form() runs against a minimal fake DOM whose innerHTML / outerHTML / insertAdjacentHTML THROW.
// 2. client policy ≡ server policy: differential run against the e2e stub's copy (CHECK literals verbatim from SQL)
//    over every BMP code point in three positions + astral samples (only U+0000 / lone surrogates differ: unstorable).
// 3. static page contract: pinned script tag (v = sha256(16)), login display_name rule, signup unchanged, no direct
//    first_name access in the pages, banner markup (not a dialog), WP4 slot, Kopenhag stub, SHA256SUMS line.
//   env: WP5_PARENT_REF (WP5 parent = main after WP4, default cfdf79e) · WP5_BASE_REF (default 7a548e9)
//        WP5_DB_SQL=<path to WP5_DB_up.sql> — optional drift check of the lib's policy literals against the DB package
//        (default: WP5_package/db/WP5_DB_up.sql when present in the checkout; skipped otherwise)
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const LIB_PATH = join(REPO, "lib", "asa-name", "asa_name.js");
const N = require(LIB_PATH);
const home = read("index.html");
const city = read("amsterdam/index.html");
const lib = read("lib/asa-name/asa_name.js");
const BASE = process.env.WP5_BASE_REF || "7a548e9";      // main before WP3 (Kopenhag stub reference, as in WP3/WP4)
const PARENT = process.env.WP5_PARENT_REF || "cfdf79e";  // WP5's parent = main after WP4
const show = (ref, p) => { try { return execFileSync("git", ["-C", REPO, "show", `${ref}:${p}`], { maxBuffer: 64 << 20 }).toString("utf8"); } catch { return null; } };

// the e2e stub's server model (window.__WP5_POLICY), loaded in a vm sandbox
function stubPolicy() {
  const sb = { window: { sessionStorage: { getItem: () => null, setItem: () => {} } } };
  vm.runInNewContext(read("WP5_package/web/tests/stubs/supabase_stub.js"), sb);
  return sb.window.__WP5_POLICY;
}

/* ---------------- 1. normalize / validate ---------------- */
const ACCEPT = ["Ayşe", "Çağrı", "Gül", "O'Neil", "O’Neil", "Jean-Luc", "İlkay Nur", "J. R.", "محمد", "דוד", "王小明", "김민준", "प्रिया", "Ğ", "a".repeat(50), "Mary-Jane O'Neil", "Øyvind", "Łukasz", "Ἀλέξανδρος", "Владимир", "Ünal‐Öz"];
const REJECT = [
  ["<img src=x onerror=alert(1)>", "chars"], ['"><script>', "chars"], ["<script>", "chars"], ["{{7*7}}", "chars"], ["${x}", "chars"],
  ["", "empty"], ["   ", "empty"], ["\t\n 　", "empty"], [null, "empty"], [undefined, "empty"],
  ["a".repeat(51), "too_long"], ["Ali" + " ".repeat(198) + "Veli", "too_long"],
  ["Ali3", "chars"], ["😀", "chars"], ["Ay😀şe", "chars"], ["a​b", "chars"], ["a‮b", "chars"], ["a﻿b", "chars"], ["ㅤ", "chars"], ["a\u0001b", "chars"],
  ["a\u0000b", "chars"], ["a\ud800b", "chars"], ["a" + "ְ".repeat(3), "chars"], ["a,b", "chars"], ["a_b", "chars"], ["a@b", "chars"], ["a/b", "chars"], ["a­b", "chars"], ["a×b", "chars"],
  ["-a", "shape"], ["a-", "shape"], [".a", "shape"], ["'a", "shape"], ["a--b", "shape"], ["a.-b", "shape"], ["a''b", "shape"], ["́a", "shape"], ["a ‐", "shape"],
  ["ـ", "no_letter"], ["ـــ", "no_letter"]
];

test("normalize(): whitespace runs → one space, trim, NFC (server order)", () => {
  assert.equal(N.normalize("\t Ayşe    Nur \n"), "Ayşe Nur");
  assert.equal(N.normalize("é"), "é");
  assert.equal(N.normalize(null), "");
  assert.equal(N.normalize(undefined), "");
  assert.equal(N.normalize("﻿a"), "﻿a", "U+FEFF is not whitespace for the server (it is rejected by the policy instead)");
});

test("validate(): accepts the policy's accept list (any script, apostrophes, hyphens, periods)", () => {
  for (const s of ACCEPT) { const r = N.validate(s, "first"); assert.equal(r.ok, true, JSON.stringify(s) + " " + JSON.stringify(r)); assert.equal(r.value, N.normalize(s)); }
  assert.equal(N.validate("  Ayşe   Nur ", "first").value, "Ayşe Nur");
});

test("validate(): rejects XSS / template / empty / 51 chars / digits / emoji / invisible / shape with a Turkish message", () => {
  for (const [s, why] of REJECT) {
    const r = N.validate(s, "last");
    assert.equal(r.ok, false, JSON.stringify(s));
    assert.equal(r.reason, why, JSON.stringify(s) + " → " + r.reason);
    assert.match(r.message, /^Soyad /, "message names the field");
  }
  assert.equal(N.validate("", "first").message, "Ad boş bırakılamaz.");
  assert.equal(N.validate("a".repeat(51), "first").message, "Ad en fazla 50 karakter olabilir.");
  assert.equal(N.validate("<b>", "first").message.includes("HTML"), true);
});

/* ---------------- 2. client ≡ server policy ---------------- */
test("client policy ≡ server policy (stub = CHECK literals verbatim): every BMP code point × 3 positions + astral samples", () => {
  const P = stubPolicy();
  const server = (s) => { if (Array.from(s).length > 200) return false; const v = P.normalize(s); return v !== "" && P.ok(v); };
  const client = (s) => N.validate(s, "first").ok;
  const unstorable = (s) => /[\u0000]|[\ud800-\udfff]/u.test(s) && !/[\ud800-\udbff][\udc00-\udfff]/.test(s.replace(/[^\ud800-\udfff]/g, ""));
  let n = 0, diff = [];
  const check = (s) => { n++; const c = client(s), v = server(s); if (c !== v && !(c === false && /[\u0000\ud800-\udfff]/.test(s))) diff.push([JSON.stringify(s), c, v]); };
  for (let cp = 0; cp <= 0xffff; cp++) { const ch = String.fromCharCode(cp); check("a" + ch + "b"); check(ch + "ab"); check("ab" + ch); }
  for (let cp = 0x10000; cp <= 0x10ffff; cp += 97) { const ch = String.fromCodePoint(cp); check("a" + ch + "b"); check(ch); }
  for (const s of ACCEPT.concat(REJECT.map((x) => x[0]).filter((x) => typeof x === "string"))) check(s);
  assert.equal(unstorable("a\u0000"), true);
  assert.deepEqual(diff.slice(0, 10), [], `client and server disagree on ${diff.length}/${n} inputs`);
  assert.ok(n > 200000, "ran " + n);
});

test("policy literals are the DB package's CHECK literals (drift tripwire; skipped when the DB package is not in this checkout)", (t) => {
  const p = process.env.WP5_DB_SQL || join(REPO, "WP5_package", "db", "WP5_DB_up.sql");
  if (!existsSync(p)) { t.skip("no WP5_DB_up.sql here (set WP5_DB_SQL)"); return; }
  const sql = readFileSync(p, "utf8");
  const body = sql.slice(sql.indexOf("constraint members_first_name_wp5_policy check"), sql.indexOf("constraint members_last_name_wp5_policy check"));
  const lits = [...body.matchAll(/first_name (!?~) '((?:[^']|'')*)'/g)].map((m) => [m[1], m[2].replace(/''/g, "'")]);
  assert.deepEqual(lits, [["!~", N.SQL.forbidden], ["~", N.SQL.letter], ["!~", N.SQL.start], ["!~", N.SQL.end], ["!~", N.SQL.double], ["!~", N.SQL.pair], ["!~", N.SQL.marks3]]);
  const fn = sql.slice(sql.indexOf("create or replace function public.member_set_name"));
  assert.equal(fn.match(/regexp_replace\(p_first, '([^']*)'/)[1], N.SQL.ws);
  assert.match(sql, /char_length\(first_name\) between 1 and 50/);
  assert.match(fn, /char_length\(p_first\) > 200/);
});

/* ---------------- load / save ---------------- */
function fakeDb(opts = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const q = { table, ops: [] }; calls.push(q);
      const b = {
        select(c) { q.ops.push(["select", c]); return b; },
        eq(c, v) { q.ops.push(["eq", c, v]); return b; },
        maybeSingle() { q.ops.push(["maybeSingle"]); if (opts.throwSelect) throw new Error("boom"); return Promise.resolve(opts.select || { data: null, error: null }); }
      };
      return b;
    },
    rpc(name, args) { calls.push({ rpc: name, args }); if (opts.throwRpc) return Promise.reject(new TypeError("Failed to fetch")); return opts.rpc ? opts.rpc(name, args) : Promise.resolve({ data: { ok: true }, error: null }); }
  };
  return db;
}
const UID = "00000000-0000-4000-8000-0000000000d1";

test("load(): own row only (members.first_name,last_name eq user_id maybeSingle); maps every backend state; never throws", async () => {
  let db = fakeDb({ select: { data: { first_name: "Ayşe", last_name: "Yılmaz" }, error: null } });
  assert.deepEqual(await N.load(db, UID), { supported: true, ready: true, first: "Ayşe", last: "Yılmaz", reason: "ok" });
  assert.deepEqual(db.calls[0], { table: "members", ops: [["select", "first_name,last_name"], ["eq", "user_id", UID], ["maybeSingle"]] });
  const cases = [
    [{ data: { first_name: null, last_name: null }, error: null }, { supported: true, ready: true, first: null, last: null }],
    [{ data: { first_name: "", last_name: "X" }, error: null }, { supported: true, ready: true, first: null, last: "X" }],
    [{ data: null, error: null }, { supported: true, ready: false }],
    [{ data: null, error: { code: "42703", message: "column members.first_name does not exist" } }, { supported: false, reason: "missing" }],
    [{ data: null, error: { code: "500", message: "upstream" } }, { supported: false, reason: "error" }],
    [{ data: { display_name: "x" }, error: null }, { supported: false, reason: "missing" }],    // response without the columns
    [{ data: { first_name: 7, last_name: {} }, error: null }, { supported: true, ready: true, first: null, last: null }]
  ];
  for (const [sel, want] of cases) { const r = await N.load(fakeDb({ select: sel }), UID); for (const [k, v] of Object.entries(want)) assert.deepEqual(r[k], v, JSON.stringify(sel) + " " + k); }
  assert.equal((await N.load(fakeDb({ throwSelect: true }), UID)).supported, false);
  db = fakeDb();
  for (const bad of [null, "", 5, undefined]) assert.equal((await N.load(db, bad)).supported, false);
  assert.equal(db.calls.length, 0, "no query without a uid");
  assert.equal((await N.load(null, UID)).supported, false);
});

test("save(): validates first (no RPC for bad input), sends normalized p_first/p_last only, maps every answer to Turkish", async () => {
  let db = fakeDb();
  let r = await N.save(db, "<img src=x onerror=alert(1)>", "Yılmaz");
  assert.equal(r.ok, false); assert.equal(r.reason, "bad_first"); assert.equal(r.field, "first");
  r = await N.save(db, "Ayşe", "   ");
  assert.equal(r.reason, "bad_last"); assert.equal(r.field, "last"); assert.equal(r.message, "Soyad boş bırakılamaz.");
  r = await N.save(db, "", "a".repeat(51));
  assert.equal(r.reason, "bad_first"); assert.match(r.message, /Ad boş bırakılamaz\. Soyad en fazla 50 karakter olabilir\./);
  assert.equal(db.calls.length, 0, "invalid input never reaches the RPC");
  r = await N.save(db, "  Ayşe \t Nur ", " Yılmaz ");
  assert.deepEqual(r, { ok: true, first: "Ayşe Nur", last: "Yılmaz", message: "Adın ve soyadın kaydedildi." });
  assert.deepEqual(db.calls, [{ rpc: "member_set_name", args: { p_first: "Ayşe Nur", p_last: "Yılmaz" } }]);
  const answer = async (res) => N.save(fakeDb({ rpc: () => Promise.resolve(res) }), "Ayşe", "Yılmaz");
  const M = N.SERVER_MSG;
  assert.deepEqual(await answer({ data: { ok: false, reason: "bad_first" }, error: null }), { ok: false, reason: "bad_first", field: "first", message: M.bad_first });
  assert.deepEqual(await answer({ data: { ok: false, reason: "bad_last" }, error: null }), { ok: false, reason: "bad_last", field: "last", message: M.bad_last });
  assert.equal((await answer({ data: { ok: false, reason: "no_auth" }, error: null })).message, "Oturumun sona ermiş. Tekrar giriş yapıp yeniden dene.");
  assert.equal((await answer({ data: { ok: false, reason: "no_member_row" }, error: null })).reason, "no_member_row");
  for (const weird of ["__proto__", "constructor", "toString", "x", 3, null]) assert.equal((await answer({ data: { ok: false, reason: weird }, error: null })).reason, "unknown", String(weird));
  assert.equal((await answer({ data: null, error: null })).reason, "unknown");
  assert.equal((await answer({ data: { ok: "true" }, error: null })).ok, false, "only ok === true is success");
  assert.equal((await answer({ data: null, error: { code: "PGRST202", message: "Could not find the function public.member_set_name" }, status: 404 })).reason, "unsupported");
  assert.equal((await answer({ data: null, error: { message: "Not Found" }, status: 404 })).reason, "unsupported");
  assert.equal((await answer({ data: null, error: { message: "upstream" }, status: 500 })).reason, "error");
  assert.equal((await N.save(fakeDb({ throwRpc: true }), "Ayşe", "Yılmaz")).reason, "error");
  assert.equal((await N.save(null, "Ayşe", "Yılmaz")).reason, "unsupported");
});

test("isComplete / shouldPrompt: only supported + ready + missing + not dismissed", () => {
  const mem = new Map(); const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  assert.equal(N.isComplete({ first: "A", last: "B" }), true);
  for (const n of [null, {}, { first: "A" }, { first: "  ", last: "B" }, { first: "A", last: "" }]) assert.equal(N.isComplete(n), false, JSON.stringify(n));
  const info = { supported: true, ready: true, first: null, last: null };
  assert.equal(N.shouldPrompt(info, "u1", st), true);
  assert.equal(N.shouldPrompt(Object.assign({}, info, { supported: false }), "u1", st), false, "backend missing → no prompt");
  assert.equal(N.shouldPrompt(Object.assign({}, info, { ready: false }), "u1", st), false, "no members row → no prompt");
  assert.equal(N.shouldPrompt(Object.assign({}, info, { first: "A", last: "B" }), "u1", st), false, "existing name → no prompt");
  assert.equal(N.shouldPrompt(null, "u1", st), false);
  assert.equal(N.dismiss("u1", st), true);
  assert.equal(mem.get("asa:name_prompt_dismissed:u1"), "1");
  assert.equal(N.shouldPrompt(info, "u1", st), false);
  assert.equal(N.shouldPrompt(info, "u2", st), true, "per member");
});

test("dismissal: storage that throws (or a throwing window.localStorage getter) never throws; remembered for the page", () => {
  const boom = { getItem() { throw new DOMException("denied", "SecurityError"); }, setItem() { throw new DOMException("quota", "QuotaExceededError"); } };
  assert.equal(N.isDismissed("t1", boom), false);
  assert.equal(N.dismiss("t1", boom), false, "not persisted");
  assert.equal(N.isDismissed("t1", boom), true, "but remembered in memory");
  assert.equal(N.dismissKey("abc"), "asa:name_prompt_dismissed:abc");
  assert.equal(N.dismiss("", boom), false); assert.equal(N.isDismissed(null), false);
  // browser global path: window.localStorage getter throws (blocked site data / sandboxed frame)
  const win = {}; Object.defineProperty(win, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  const sb = { window: win, module: undefined }; sb.globalThis = sb;
  vm.runInNewContext(lib, sb);
  const W = win.ASA_NAME;
  assert.equal(W.isDismissed("u9"), false);
  assert.equal(W.dismiss("u9"), false);
  assert.equal(W.isDismissed("u9"), true);
  assert.equal(W.shouldPrompt({ supported: true, ready: true }, "u9"), false);
});

/* ---------------- form() under a minimal DOM (innerHTML throws) ---------------- */
function fakeDoc() {
  const doc = { activeElement: null, created: [] };
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.on = {}; this._t = ""; this.value = ""; this.className = ""; this.readOnly = false; this.id = ""; doc.created.push(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    addEventListener(t, fn) { (this.on[t] = this.on[t] || []).push(fn); }
    fire(t) { const ev = { type: t, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (this.on[t] || []).forEach((fn) => fn(ev)); return ev; }
    set textContent(v) { this._t = String(v); this.children = []; }
    get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
    focus() { doc.activeElement = this; }
    find(id) { if (this.id === id) return this; for (const c of this.children) { const r = c.find(id); if (r) return r; } return null; }
    set innerHTML(_) { throw new Error("innerHTML used"); }
    get innerHTML() { throw new Error("innerHTML used"); }
    set outerHTML(_) { throw new Error("outerHTML used"); }
    insertAdjacentHTML() { throw new Error("insertAdjacentHTML used"); }
  }
  doc.createElement = (t) => new El(t);
  return doc;
}
const tick = () => new Promise((r) => setImmediate(r));
function deferredDb() {
  const calls = []; let pending = [];
  return { calls, release(res) { const p = pending; pending = []; p.forEach((r) => r(res)); }, rpc(name, args) { calls.push({ name, args }); return new Promise((r) => pending.push(r)); } };
}

test("form(): labelled inputs (for/id, autocomplete, maxlength 50), values via .value only — XSS value stays text", () => {
  const doc = fakeDoc();
  const XSS = '"><img src=x onerror=alert(1)>';
  const f = N.form(doc, { prefix: "np", values: { first: XSS, last: "Yılmaz" }, db: null, onLater() {} });
  const first = f.el.find("npFirst"), last = f.el.find("npLast");
  assert.equal(first.value, XSS); assert.equal(last.value, "Yılmaz");
  assert.equal(doc.created.filter((e) => e.tagName === "IMG" || e.tagName === "SCRIPT").length, 0);
  const labels = doc.created.filter((e) => e.tagName === "LABEL");
  assert.deepEqual(labels.map((l) => [l.getAttribute("for"), l.textContent]), [["npFirst", "Ad"], ["npLast", "Soyad"]]);
  assert.equal(first.getAttribute("autocomplete"), "given-name"); assert.equal(last.getAttribute("autocomplete"), "family-name");
  assert.equal(first.getAttribute("maxlength"), "50"); assert.equal(last.getAttribute("maxlength"), "50");
  assert.equal(f.err.getAttribute("role"), "alert"); assert.equal(f.ok.getAttribute("role"), "status");
  assert.equal(f.submit.getAttribute("type"), "submit"); assert.equal(f.submit.textContent, "Kaydet");
  assert.equal(f.later.getAttribute("type"), "button"); assert.equal(f.later.textContent, "Şimdi değil");
  assert.equal(f.el.tagName, "FORM"); assert.equal(f.el.noValidate, true);
  assert.equal(N.form(doc, { prefix: "x" }).later, null, "no 'Şimdi değil' without onLater");
});

test("form(): invalid → role=alert text, aria-invalid + focus on the field, no RPC; valid → one RPC even on double submit; success XOR error", async () => {
  const doc = fakeDoc(), db = deferredDb(); const saved = [];
  const f = N.form(doc, { prefix: "pf", values: {}, db: () => db, onSaved: (r) => saved.push(r) });
  f.first.value = "<script>"; f.last.value = "";
  assert.equal(f.el.fire("submit").defaultPrevented, true);
  await tick();
  assert.match(f.err.textContent, /^Ad yalnız harf.*Soyad boş bırakılamaz\.$/);
  assert.equal(f.ok.textContent, "");
  assert.equal(f.first.getAttribute("aria-invalid"), "true"); assert.equal(f.first.getAttribute("aria-describedby"), "pfErr");
  assert.equal(f.last.getAttribute("aria-invalid"), "true");
  assert.equal(doc.activeElement, f.first);
  assert.equal(db.calls.length, 0);
  f.first.value = "a".repeat(51); f.last.value = "Yılmaz";
  f.el.fire("submit"); await tick();
  assert.equal(f.err.textContent, "Ad en fazla 50 karakter olabilir."); assert.equal(f.last.getAttribute("aria-invalid"), null);
  f.first.value = " Ayşe "; f.last.value = "Yılmaz";
  f.submit.focus();
  f.el.fire("submit"); f.el.fire("submit"); f.submit.fire("click"); f.el.fire("submit");
  await tick();
  assert.equal(db.calls.length, 1, "double submit → one RPC");
  assert.deepEqual(db.calls[0], { name: "member_set_name", args: { p_first: "Ayşe", p_last: "Yılmaz" } });
  assert.equal(f.busy(), true); assert.equal(f.submit.getAttribute("aria-disabled"), "true"); assert.equal(f.submit.textContent, "Kaydediliyor…");
  assert.equal(f.err.textContent, "", "error cleared on a new attempt");
  assert.equal(doc.activeElement, f.submit, "aria-disabled keeps focus on the button");
  db.release({ data: { ok: true }, error: null }); await tick(); await tick();
  assert.equal(f.ok.textContent, "Adın ve soyadın kaydedildi."); assert.equal(f.err.textContent, "");
  assert.equal(f.first.value, "Ayşe"); assert.equal(f.submit.getAttribute("aria-disabled"), null); assert.equal(f.submit.textContent, "Kaydet");
  assert.equal(saved.length, 1); assert.equal(saved[0].first, "Ayşe");
  // server rejects last name → alert, success cleared, focus on Soyad
  f.first.fire("input");
  assert.equal(f.ok.textContent, "", "editing clears a stale success");
  f.el.fire("submit"); await tick();
  db.release({ data: { ok: false, reason: "bad_last" }, error: null }); await tick(); await tick();
  assert.equal(f.err.textContent, N.SERVER_MSG.bad_last); assert.equal(f.ok.textContent, "");
  assert.equal(doc.activeElement, f.last); assert.equal(f.last.getAttribute("aria-invalid"), "true");
  assert.equal(saved.length, 1, "onSaved only on success");
  // network error → generic alert, no field marked
  f.el.fire("submit"); await tick();
  db.release({ data: null, error: { message: "upstream" }, status: 503 }); await tick(); await tick();
  assert.equal(f.err.textContent, N.SERVER_MSG.error); assert.equal(f.ok.textContent, "");
});

test("form(): 'Şimdi değil' calls onLater, ignored while saving", async () => {
  const doc = fakeDoc(), db = deferredDb(); let later = 0;
  const f = N.form(doc, { prefix: "np", db, onLater: () => later++ });
  f.later.fire("click"); assert.equal(later, 1);
  f.first.value = "Ayşe"; f.last.value = "Yılmaz"; f.el.fire("submit"); await tick();
  f.later.fire("click"); assert.equal(later, 1, "no dismiss while the save is in flight");
  assert.equal(f.later.getAttribute("aria-disabled"), "true");
  db.release({ data: { ok: true }, error: null }); await tick(); await tick();
  assert.equal(f.later.getAttribute("aria-disabled"), null);
});

/* ---------------- 3. static page contract ---------------- */
const PIN = createHash("sha256").update(readFileSync(LIB_PATH)).digest("hex").slice(0, 16);

test("both pages load lib/asa-name exactly once, pinned to sha256(16) of the file, after asa_storage and before the inline scripts", () => {
  const tag = `<script src="/lib/asa-name/asa_name.js?v=${PIN}"></script>`;
  for (const [name, html] of [["index.html", home], ["amsterdam/index.html", city]]) {
    assert.equal(html.split(tag).length - 1, 1, name + " loads the current ASA_NAME exactly once (pin " + PIN + ")");
    assert.equal((html.match(/asa_name\.js/g) || []).length, 1, name);
    const st = html.indexOf('<script src="/lib/asa-storage/asa_storage.js?v=');
    assert.ok(st > 0 && html.indexOf(tag) > st, name + ": after asa_storage");
    assert.ok(html.search(/<script>\s*\/\* ASALOCAL TripStore/) > html.indexOf(tag), name + ": before the first inline script");
  }
  for (const p of ["kopenhag/index.html", "amsterdam.html", "amsterdam_index_UID.html", "admin.html", "CDP3B/admin.html"]) {
    if (p === "amsterdam_index_UID.html" && !existsSync(join(REPO, p))) continue; // retired in WP7 (301 to /amsterdam/)
    const h = read(p);
    assert.equal(/asa_name|asa-name|ASA_NAME|member_set_name/.test(h), false, p + " does not load WP5");
    // WP7 (6/n): CDP3B/admin.html's venue editor gets WP7 labels (and the e-mail module may change in its own PR), so it is
    // no longer pinned to the WP5 parent; it still must not load WP5 (checked above).
    if (p === "CDP3B/admin.html") continue;
    const prev = show(PARENT, p);
    if (prev !== null) assert.equal(h, prev, p + " byte-identical to " + PARENT);
  }
});

test("lib: no HTML sinks, no eval; localStorage only inside try; pages never read first_name/last_name or call member_set_name directly", () => {
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setTimeout(\""]) assert.equal(code.includes(sink), false, sink);
  const lsLines = code.split("\n").filter((l) => /localStorage|getItem\(|setItem\(/.test(l));
  assert.ok(lsLines.length >= 1);
  for (const l of lsLines) assert.match(l, /try \{.*(localStorage|getItem\(|setItem\()/, "storage access inside try: " + l.trim().slice(0, 80));
  for (const [name, html] of [["index.html", home], ["amsterdam/index.html", city]]) {
    assert.equal(/select\([^)]*(first_name|last_name)|\.(first_name|last_name)\b/.test(html), false, name + ": name columns only via ASA_NAME.load");
    assert.equal(/\.rpc\(\s*["']member_set_name/.test(html), false, name + ": writes only via ASA_NAME.save");
    const from = html.lastIndexOf("/*", html.indexOf("WP5 · Ad ve soyad (özel)")), to = html.indexOf("\n", html.search(/function (wp5Reset|nameReset)\(\)\{/));
    const wp5 = html.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(wp5.length > 1000, name + " WP5 block found");
    assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(wp5), false, name + ": WP5 block uses DOM APIs only");
  }
});

test("display_name: login paths send null when the member already has one; signup unchanged; user-chosen names unchanged", () => {
  const LOCAL = 'p_display_name:email.split("@")[0]';
  // homepage: signup call byte-identical; the shared post-auth call uses the keepName rule (login only)
  assert.ok(home.includes('db.rpc("member_upsert_profile",{p_display_name:email.split("@")[0],p_bio:null,p_home_city:city.trim(),p_gender:gender})'), "home signup unchanged");
  assert.ok(home.includes('if(!su){ try{ const ex=await db.from("members").select("display_name").eq("user_id",uid).maybeSingle(); keepName=!!(ex&&(ex.error||(ex.data&&ex.data.display_name))); }catch(e){ keepName=true; } }'));
  assert.ok(home.includes('db.rpc("member_upsert_profile",{p_display_name:keepName?null:email.split("@")[0],p_bio:null,p_home_city:null,p_gender:null})'));
  assert.equal((home.match(/db\.rpc\("member_upsert_profile"/g) || []).length, 2);
  // city page: afterAuth (login + every page load with a session) uses the rule; signup's own call unchanged; Görünen Ad / Kart unchanged
  const aa = city.slice(city.indexOf("async function afterAuth(user){"), city.indexOf("async function login(email,password){"));
  assert.ok(aa.includes('const ex=await db.from("members").select("display_name").eq("user_id",uid).maybeSingle(); keepName=!!(ex&&(ex.error||(ex.data&&ex.data.display_name)));'));
  assert.ok(aa.includes('db.rpc("member_upsert_profile",{p_display_name:keepName?null:email.split("@")[0],p_bio:null,p_home_city:null,p_gender:null})'));
  assert.equal(aa.includes(LOCAL + ",p_bio"), false, "afterAuth never sends the local part unconditionally");
  assert.ok(city.includes('db.rpc("member_upsert_profile",{p_display_name:email.split("@")[0],p_bio:null,p_home_city:city.trim(),p_gender:gender})'), "city signup unchanged");
  assert.ok(city.includes('db.rpc("member_upsert_profile",{p_display_name:name,p_bio:null,p_home_city:null,p_gender:null})'), "saveName unchanged");
  assert.ok(city.includes('db.rpc("member_upsert_profile",{p_display_name:name,p_bio:null,p_home_city:city,p_gender:gender})'), "saveProfile unchanged");
  assert.equal((city.match(/db\.rpc\("member_upsert_profile"/g) || []).length, 4);
  // the keepName rule itself
  const rule = (ex) => { let keepName = false; keepName = !!(ex && (ex.error || (ex.data && ex.data.display_name))); return keepName ? null : "local"; };
  assert.equal(rule({ data: { display_name: "Deniz" }, error: null }), null);
  assert.equal(rule({ data: { display_name: "" }, error: null }), "local");
  assert.equal(rule({ data: { display_name: null }, error: null }), "local");
  assert.equal(rule({ data: null, error: null }), "local", "no row yet → local part (first login after e-mail confirmation)");
  assert.equal(rule({ data: null, error: { message: "x" } }), null, "unreadable → do not overwrite");
});

test("homepage banner: plain region (not a dialog), hidden by default, exact copy; Profilim inputs live only in #amWp5Slot", () => {
  const i = home.indexOf('<section id="namePrompt"');
  assert.ok(i > home.indexOf("<main") && i < home.indexOf('<div id="adMasthead"'), "first thing in <main>, outside the header");
  const sec = home.slice(i, home.indexOf("</section>", i));
  assert.match(sec, /^<section id="namePrompt" aria-labelledby="namePromptTitle" hidden>/);
  assert.equal(/role="dialog"|aria-modal|role="alertdialog"|fixed|z-\[/.test(sec), false, "not modal, not an overlay");
  assert.match(sec, /<h2 id="namePromptTitle"[^>]*>Profilini tamamla: adını ve soyadını ekle\.<\/h2>/);
  assert.equal(/<input|<select|<textarea/.test(sec), false, "no static inputs: built only when the prompt is shown");
  assert.match(home, /<p id="namePromptDone" role="status" aria-live="polite" tabindex="-1"/);
  assert.match(home, /\+'<div id="amWp5Slot" data-wp5-slot="profile-name" class="mb-4" hidden><\/div>'/);
  assert.ok(home.includes('const slot=$("amWp5Slot");') && home.includes("slot.appendChild(f.el)"), "Profilim form mounted into the WP4 slot");
  assert.ok(home.includes('$("amName").textContent=acctName();'), "WP4 XSS-safe name rendering kept");
});

test("city page: banner after the WP3 notice (not a dialog), Kart slot, WP3 / WSE / paywall lines untouched", () => {
  const n = city.indexOf('<div id="asaStoreNotice" class="asa-sn hide" role="status" aria-live="polite"></div>');
  const b = city.indexOf('<section id="asaNamePrompt" class="asa-np hide" aria-labelledby="asaNpTitle">');
  assert.ok(n > 0 && b > n && b - n < 400, "banner right after the WP3 storage notice");
  const sec = city.slice(b, city.indexOf("</section>", b));
  assert.equal(/role="dialog"|aria-modal|<input/.test(sec), false);
  assert.match(sec, /Profilini tamamla: adını ve soyadını ekle\./);
  assert.ok(city.includes(`+'<section id="asaNameSlot" data-wp5-slot="profile-name" class="bg-surface-container p-lg rounded-xl mt-6 hide"></section>';`));
  assert.ok(city.includes('const pending=(v==="not_configured"||v==="config_pending"); const on=(v===true);'), "WSE predicate");
  for (const s of ["const TEASER_MAX=10", "Devamı üyeler için", "İlk 10 mekân gösteriliyor."]) assert.ok(city.includes(s), s);
  const calls = city.match(/localStorage\.(getItem|setItem|removeItem)\(\s*["'][^"']*["']/g) || [];
  for (const c of calls) assert.match(c, /"asa_session"$/, "WP3: only asa_session on raw localStorage: " + c);
});

test("Kopenhag stub byte-identical to main; SHA256SUMS pins the current city page", (t) => {
  const cph = show(BASE, "kopenhag/index.html");
  if (cph === null) { t.skip("git history missing (fetch-depth: 0)"); return; }
  assert.equal(read("kopenhag/index.html"), cph);
  const sums = read("SHA256SUMS");
  const h = createHash("sha256").update(readFileSync(join(REPO, "amsterdam/index.html"))).digest("hex");
  assert.match(sums, new RegExp("^" + h + "  amsterdam/index\\.html$", "m"));
});
