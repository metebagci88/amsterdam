// WP4 · static contract tests for the member navigation (no browser, no network).
//   node --test WP4_package/tests/wp4_unit.test.mjs
//
// Two kinds of checks:
//   durable contract (always on; every later PR that touches the pages keeps them green): XSS-safe text, dialog
//     roles/names, the 5 menu items, prefs RPC contract + prefState, auth form a11y, logout semantics, Kopenhag stub.
//   one-shot WP4 scope (only with WP4_SCOPE_CHECKS=1, i.e. the WP4 PR itself): "this PR changed only X" diffs
//     against fixed refs and "WP5 is not implemented yet". WP5 (name fields, member_upsert_profile path) is
//     expected to change exactly those, so they must not run on later PRs.
//   env: WP4_SCOPE_CHECKS=1  enable the one-shot scope checks
//        WP4_HEAD_REF        commit whose files the scope checks read (CI: the PR head sha, so a newer main in the
//                            PR merge ref is not counted as a WP4 change); default: the working tree
//        WP4_BASE_REF        main before WP3, default 7a548e9 (login/signup byte-identical; Kopenhag stub)
//        WP4_PARENT_REF      WP4's parent = WP3 head, default 7801394 ("only these lines changed")
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = process.env.WP4_BASE_REF || "7a548e9";
const PARENT = process.env.WP4_PARENT_REF || "7801394";
const SCOPE = process.env.WP4_SCOPE_CHECKS === "1";
const HEAD = process.env.WP4_HEAD_REF || "";
const SCOPE_OPT = { skip: SCOPE ? false : "one-shot WP4 scope check (set WP4_SCOPE_CHECKS=1 on the WP4 PR)" };
const read = (p) => readFileSync(join(REPO, p), "utf8");
const show = (ref, p) => { try { return execFileSync("git", ["-C", REPO, "show", `${ref}:${p}`], { maxBuffer: 64 << 20 }).toString("utf8"); } catch { return null; } };
const home = read("index.html");
const city = read("amsterdam/index.html");
const baseHome = show(BASE, "index.html");
const parentHome = show(PARENT, "index.html");
const parentCity = show(PARENT, "amsterdam/index.html");
const needGit = (t, v) => { if (v === null) t.skip("git history missing (fetch-depth: 0)"); return v !== null; };
// scope checks read the PR head commit when WP4_HEAD_REF is set, else the working tree
const cur = (p) => { if (!HEAD) return read(p); const v = show(HEAD, p); assert.ok(v !== null, `WP4_HEAD_REF ${HEAD} has no ${p} (fetch-depth: 0?)`); return v; };

// source of one top-level function (up to the first line that is exactly "}")
function fnSource(html, header) {
  const i = html.indexOf(header);
  if (i < 0) return null;
  if (html.slice(i).split("\n")[0].trimEnd().endsWith("}")) return html.slice(i).split("\n")[0];
  const j = html.indexOf("\n}\n", i);
  return j < 0 ? null : html.slice(i, j + 2);
}
const line = (html, header) => { const i = html.indexOf(header); return i < 0 ? null : html.slice(i, html.indexOf("\n", i)); };

test("[scope] login/signup/OTP code is byte-identical to main (doAuth, amAuthErr, bootAuth, saveTrip)", SCOPE_OPT, (t) => {
  if (!needGit(t, baseHome)) return;
  const home = cur("index.html");
  for (const h of ["async function doAuth(){", "async function saveTrip(navigate){"]) {
    const a = fnSource(baseHome, h), b = fnSource(home, h);
    assert.ok(a && a.length > 200, h + " found in base");
    if (h.startsWith("async function saveTrip")) assert.equal(b, fnSource(parentHome, h), h + " (WP3 version) unchanged");
    else assert.equal(b, a, h + " unchanged");
  }
  for (const h of ["function amAuthErr(e){", "(async function bootAuth(){", "const CFG={url:"]) assert.equal(line(home, h), line(baseHome, h), h + " unchanged");
  assert.equal((home.match(/signInWithPassword\(/g) || []).length, 1);
  assert.equal((home.match(/auth\.signUp\(/g) || []).length, 1);
});

test("[scope] no new DB writes on the homepage; only the two prefs RPCs are added", SCOPE_OPT, (t) => {
  if (!needGit(t, parentHome)) return;
  const home = cur("index.html");
  for (const w of [".insert(", ".upsert(", ".update(", ".delete("]) assert.equal(home.split(w).length, parentHome.split(w).length, w);
  const rpcs = (s) => [...s.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  const added = rpcs(home).slice();
  for (const r of rpcs(parentHome)) { const k = added.indexOf(r); assert.ok(k >= 0, "kept " + r); added.splice(k, 1); }
  assert.deepEqual(added.sort(), ["consent_get_my_state", "service_pref_set"]);
  assert.equal((home.match(/member_upsert_profile/g) || []).length, (parentHome.match(/member_upsert_profile/g) || []).length, "no extra profile write (WP5 scope)");
});

test("prefs RPC contract is the CDP-3C one (same as the city page)", () => {
  assert.match(home, /await db\.rpc\("consent_get_my_state"\); if\(error\) throw error;/);
  assert.match(home, /db\.rpc\("service_pref_set",\{ p_key:key, p_enabled:\(enabled===true\), p_request_id:"pc-home-"\+Date\.now\(\), p_idem:idem \}\)/);
  assert.match(city, /db\.rpc\("service_pref_set",\{ p_key:key, p_enabled:\(enabled===true\), p_request_id:"pc-"\+Date\.now\(\), p_idem:idem \}\)/, "city page contract unchanged");
  assert.match(home, /ok=!error&&!!data&&data\.ok===true;/, "success only on {ok:true}");
  assert.match(home, /<div id="prefsErr" role="alert"/);
});

test("prefState(): not_configured and config_pending are 'unset' ('Varsayılan belirlenmedi'), never 'off'", () => {
  const src = line(home, "function prefState(v){");
  const prefState = new Function(src + "; return prefState;")();
  assert.equal(prefState(true), "on");
  assert.equal(prefState(false), "off");
  assert.equal(prefState("not_configured"), "unset");
  assert.equal(prefState("config_pending"), "unset");
  for (const v of [null, undefined, "", "yes", 1, 0]) assert.equal(prefState(v), "unknown", String(v));
  assert.match(home, /const PREF_STATE_TXT=\{on:"Açık",off:"Kapalı",unset:"Varsayılan belirlenmedi",unknown:"Durum bilinmiyor"\};/);
});

test("asaUuid(): RFC 4122 v4 with and without crypto.randomUUID", () => {
  const src = fnSource(home, "function asaUuid(){");
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const withNative = new Function("window", "crypto", src + "; return asaUuid;")(globalThis, globalThis.crypto);
  assert.match(withNative(), V4);
  const fallbackCrypto = { getRandomValues: (a) => globalThis.crypto.getRandomValues(a) };
  const fallback = new Function("window", "crypto", src + "; return asaUuid;")({ crypto: fallbackCrypto }, fallbackCrypto);
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const u = fallback(); assert.match(u, V4); seen.add(u); }
  assert.equal(seen.size, 200);
  assert.equal(new Function("window", "crypto", src + "; return asaUuid;")({}, undefined)(), null, "no crypto → null (caller shows an error, never calls the RPC)");
});

test("XSS: session name/e-mail never reach innerHTML (textContent only)", () => {
  assert.equal(/innerHTML\s*=[^;]*session\.(display_name|email)/.test(home), false);
  assert.equal(/innerHTML\s*=[^;]*acctName\(\)/.test(home), false);
  assert.match(home, /\$\("amName"\)\.textContent=acctName\(\);/);
  assert.match(home, /\$\("amEmailRo"\)\.textContent=session\.email\|\|"";/);
  assert.match(home, /\$\("acctMenuWho"\)\.textContent=acctName\(\);/);
  assert.equal(/onclick="openTrip\('\+/.test(home) || /onclick="archiveTrip\('\+/.test(home), false, "no trip data inside inline onclick");
});

test("dialogs: role=dialog + aria-modal + aria-labelledby (target exists); ✕ buttons named 'Kapat'", () => {
  for (const [ov, lb] of [["authModal", "authTitle"], ["tripsModal", "tripsTitle"], ["acctMenu", "acctMenuTitle"], ["prefsModal", "prefsTitle"]]) {
    const i = home.indexOf('<div id="' + ov + '"');
    assert.ok(i > 0, ov);
    assert.match(home.slice(i, i + 400), new RegExp('role="dialog" aria-modal="true" aria-labelledby="' + lb + '"'), ov);
    assert.ok(home.includes('id="' + lb + '"'), lb + " exists");
    assert.ok(home.includes("ASA_DLG.register($(\"" + ov + "\")"), ov + " registered (ESC + outside click)");
  }
  const xs = home.match(/<button[^>]*>✕<\/button>/g) || [];
  assert.ok(xs.length >= 4, "the four WP4 dialogs have a ✕");
  for (const x of xs) assert.match(x, /aria-label="Kapat"/, x);
});

test("account button and menu: anon/member labels, exactly 5 items", () => {
  assert.match(home, /<button id="acctBtn" type="button" aria-label="Giriş yap \/ üye ol"/);
  assert.match(home, /b\.setAttribute\("aria-label","Hesabım: "\+nm\); b\.setAttribute\("aria-haspopup","dialog"\);/);
  const nav = home.slice(home.indexOf('<nav aria-label="Hesap menüsü">'), home.indexOf("</nav>"));
  const items = [...nav.matchAll(/data-acct="([a-z]+)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(items, [["profile", "Profilim"], ["prefs", "E-posta tercihlerim"], ["trips", "Kayıtlı seyahatlerim"], ["newtrip", "Yeni seyahat oluştur"], ["logout", "Çıkış yap"]]);
  assert.match(home, /function onAcctBtn\(\)\{ if\(session\) openAcctMenu\(\); else openAuth\(\); \}/);
});

test("auth form a11y: every field has a <label for>, #amErr role=alert", () => {
  assert.match(home, /function amInp\(id,type,ph,lbl,ac\)\{ return '<label for="'\+id\+'"/);
  for (const [id, lbl] of [["amEmail", "E-posta"], ["amPw", "Şifre"], ["amCity", "Yaşadığın şehir"]]) assert.ok(new RegExp('amInp\\("' + id + '",[\\s\\S]{0,120}?"' + lbl + '"').test(home), id);
  assert.match(home, /<label for="amGender"[^>]*>Cinsiyet<\/label><select id="amGender"/);
  assert.match(home, /<div id="amErr" role="alert"/);
});

test("logout keeps the existing semantics (signOut + asa_session removal)", () => {
  const src = fnSource(home, "async function doLogout(){");
  assert.match(src, /try\{ if\(db\)await db\.auth\.signOut\(\); \}catch\(e\)\{\}\n  session=null; try\{localStorage\.removeItem\("asa_session"\);\}catch\(e\)\{\}/);
  assert.match(src, /const b=\$\("acctBtn"\); if\(b\) b\.focus\(\);/);
  assert.equal((home.match(/localStorage\.removeItem\("asa_session"\)/g) || []).length, 1, "one logout path");
});

test("[scope] WP5 is NOT implemented here: placeholder only, no name fields or writes", SCOPE_OPT, () => {
  const home = cur("index.html");
  assert.match(home, /<div id="amWp5Slot" data-wp5-slot="profile-name" hidden><\/div>/);
  assert.equal(/first_name|last_name|ad_soyad|p_first|p_last/i.test(home), false);
  assert.equal(/id="(amFirst|amLast|amFullName|amDisplayName)"/.test(home), false);
});

test("city page: not_configured is 'Varsayılan belirlenmedi' (never Kapalı); header member button has a name", () => {
  assert.ok(city.includes('const pending=(v==="not_configured"||v==="config_pending"); const on=(v===true);'));
  assert.ok(city.includes(`const stateTxt=pending?'<span class="text-on-surface-variant">Varsayılan belirlenmedi</span>':(on?'<span class="text-primary">Açık</span>':'<span class="text-on-surface-variant">Kapalı</span>');`));
  assert.ok(/onclick="go\('member'\)"[^>]*aria-label="Üyelik ve hesabım"><span class="msym text-\[22px\]" aria-hidden="true">account_circle<\/span><\/button>/.test(city));
});

test("[scope] city page: only the prefs label predicate, its comment and the header member button changed", SCOPE_OPT, (t) => {
  if (!needGit(t, parentCity)) return;
  const city = cur("amsterdam/index.html");
  const a = parentCity.split("\n"), b = city.split("\n");
  assert.equal(a.length, b.length, "same line count");
  const changed = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.equal(changed.length, 3, JSON.stringify(changed));
  assert.ok(changed.every((i) => /go\('member'\)|const pending=|not_configured \(canlı RPC/.test(b[i])), "unexpected city-page change");
});

test("Kopenhag stub stays byte-identical to main", (t) => {
  const cphBase = show(BASE, "kopenhag/index.html");
  if (!needGit(t, cphBase)) return;
  assert.equal(read("kopenhag/index.html"), cphBase, "kopenhag/index.html");
});

test("[scope] untouched by WP4: admin pages, legacy pages, storage library and its pin", SCOPE_OPT, (t) => {
  if (!needGit(t, parentHome)) return;
  const home = cur("index.html");
  for (const p of ["admin.html", "CDP3B/admin.html", "amsterdam.html", "amsterdam_index_UID.html", "lib/asa-storage/asa_storage.js"]) {
    const prev = show(PARENT, p);
    if (prev === null) { t.diagnostic("no " + p + " at " + PARENT); continue; }
    assert.equal(cur(p), prev, p);
  }
  // WP3 storage wiring on the homepage untouched (pin + one reconcile + Trip Policy A line)
  assert.equal(line(home, '<script src="/lib/asa-storage/asa_storage.js?v='), line(parentHome, '<script src="/lib/asa-storage/asa_storage.js?v='));
  assert.equal((home.match(/\.reconcile\(/g) || []).length, 1);
});
