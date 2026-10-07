#!/usr/bin/env node
// SEC-MEDIA · Stage 1 (İŞ PAKETİ 1) · negatif testler — HİÇBİR obje ve HİÇBİR rate token oluşturmaz.
// Negative tests against the live admin-api (verify_jwt=true). Creates NO objects:
//  * every multipart body carries a 1x1 GIF "canary": even if every auth/role/prefix gate failed,
//    the server sniff (media_upload.ts:453-454) would reject it (bad_mime_content) before storage;
//  * every expected rejection happens BEFORE admin_rate_check (index.ts:74) → no admin_rate_events row.
// Sessions: existing verified users only (PRD 2.4), via supabase-js signInWithPassword with the public
// anon key read at runtime from the live admin page; logout scope=local at the end.
// Modes: --selftest (offline). Exit: 0 PASS · 1 FAIL · 2 config · 3 STOP · 4 INCOMPLETE (SKIPPED tests)
import { join } from "node:path";
import {
  REPO_ROOT, buildMultipart, defaultOutDir, discoverConfig, findLeaks, isMain, loadModule, makeChecker, makeGifCanary,
  makeLogger, makeRedactor, maskUuid, newBoundary, newRunId, nowIso, resolveBaseUrl, sniffMimeLocal, stackLeakMarkers,
  writeJsonGuarded,
} from "./s1_lib.mjs";

const RESULT_FILE = "s1_negative_result.json";
const TIMEOUT_MS = 20_000;

// Expected outcomes are derived from CDP3B/edge/admin-api/index.ts (IDX) and inert/media_upload.ts (MU).
// auth: none | anon_key | garbage | member | admin | any_jwt (admin, else member)
export function negativeCases(gif = makeGifCanary()) {
  const file = { name: "file", data: gif, filename: "s1-negative-canary.gif", contentType: "image/gif" };
  const ok3 = (prefix = "venues") => [{ name: "action", value: "media_upload" }, { name: "prefix", value: prefix }, file];
  const mp = (parts, opts) => ({ kind: "multipart", parts, ...opts });
  return [
    { id: "N1a", group: "auth", name: "Auth yok (Authorization/apikey yok) → 401", auth: "none", apikey: false, body: mp(ok3()), expect: { status: 401, errors: ["missing_bearer", "invalid_token", "*gateway"] }, cite: "gateway verify_jwt=true; IDX:40" },
    { id: "N1b", group: "auth", name: "Auth yok (yalnız apikey=anon) → 401", auth: "none", apikey: true, body: mp(ok3()), expect: { status: 401, errors: ["missing_bearer", "invalid_token", "*gateway"] }, cite: "gateway verify_jwt=true; IDX:40" },
    { id: "N1c", group: "auth", name: "Authorization=public anon key (kullanıcı oturumu yok) → 401", auth: "anon_key", apikey: true, body: mp(ok3()), expect: { status: 401, errors: ["invalid_token", "*gateway"] }, cite: "IDX:57 (getUser fails); gateway if key is not a JWT" },
    { id: "N1d", group: "auth", name: "Authorization=bozuk (JWT olmayan) token → 401", auth: "garbage", apikey: true, body: mp(ok3()), expect: { status: 401, errors: ["invalid_token", "*gateway"] }, cite: "gateway verify_jwt=true; IDX:57" },
    { id: "N2", group: "role", name: "Normal üye oturumu ile upload → 403 not_admin", auth: "member", apikey: true, body: mp(ok3()), expect: { status: 403, errors: ["not_admin"] }, cite: "IDX:58" },
    { id: "N3a", group: "prefix", name: "İzinsiz prefix 'evil' → 400 bad_prefix", auth: "admin", apikey: true, body: mp(ok3("evil")), expect: { status: 400, errors: ["bad_prefix"] }, cite: "IDX:62-63 → MU:386" },
    { id: "N3b", group: "prefix", name: "İzinsiz prefix '../venues' → 400 bad_prefix", auth: "admin", apikey: true, body: mp(ok3("../venues")), expect: { status: 400, errors: ["bad_prefix"] }, cite: "IDX:62-63 → MU:386" },
    { id: "N3c", group: "prefix", name: "Başka bucket adı 'email-assets-public' prefix olarak → 400 bad_prefix", auth: "admin", apikey: true, body: mp(ok3("email-assets-public")), expect: { status: 400, errors: ["bad_prefix"] }, cite: "IDX:62-63 → MU:386" },
    { id: "N4a", group: "json", name: "JSON action=media_upload → 415", auth: "any_jwt", apikey: true, body: { kind: "json", value: { action: "media_upload", params: { prefix: "venues" } } }, expect: { status: 415, errors: ["unsupported_media_type"] }, cite: "IDX:54 → MU:176-178" },
    { id: "N4b", group: "json", name: "JSON action=media_upload + data_base64 → 415", auth: "any_jwt", apikey: true, body: { kind: "json", value: { action: "media_upload", params: { prefix: "venues", data_base64: gif.toString("base64") } } }, expect: { status: 415, errors: ["unsupported_media_type"] }, cite: "IDX:54 → MU:176-178" },
    { id: "N5a", group: "malformed", name: "multipart, boundary yok → 400 bad_input", auth: "admin", apikey: true, body: mp(ok3(), { noBoundary: true }), expect: { status: 400, errors: ["bad_input"] }, cite: "IDX:62-63 → MU:364-365" },
    { id: "N5b", group: "malformed", name: "multipart, kapanış sınırı yok (kesik gövde) → 400 bad_input", auth: "admin", apikey: true, body: mp(ok3(), { truncate: true }), expect: { status: 400, errors: ["bad_input"] }, cite: "IDX:62-63 → MU:366-367" },
    { id: "N5c", group: "malformed", name: "multipart + istemci 'path' alanı → 400 client_path_rejected", auth: "admin", apikey: true, body: mp([...ok3(), { name: "path", value: "venues/client-chosen.png" }]), expect: { status: 400, errors: ["client_path_rejected"] }, cite: "IDX:62-63 → MU:92-108,369-371" },
    { id: "N5d", group: "malformed", name: "multipart + bilinmeyen alan → 400 unknown_field", auth: "admin", apikey: true, body: mp([...ok3(), { name: "foo", value: "bar" }]), expect: { status: 400, errors: ["unknown_field"] }, cite: "IDX:62-63 → MU:110,372" },
    { id: "N5e", group: "malformed", name: "multipart, iki file parçası → 400 bad_input", auth: "admin", apikey: true, body: mp([...ok3(), file]), expect: { status: 400, errors: ["bad_input"] }, cite: "IDX:62-63 → MU:377-379" },
    { id: "N5f", group: "malformed", name: "multipart action=counts → 415", auth: "admin", apikey: true, body: mp([{ name: "action", value: "counts" }, { name: "prefix", value: "venues" }, file]), expect: { status: 415, errors: ["unsupported_media_type"] }, cite: "IDX:62-63 → MU:383-384" },
    { id: "N5g", group: "malformed", name: "multipart, gövde rastgele bayt → 400 bad_input", auth: "admin", apikey: true, body: mp([], { garbage: true }), expect: { status: 400, errors: ["bad_input"] }, cite: "IDX:62-63 → MU:366-367" },
  ];
}

export function encodeBody(body) {
  if (body.kind === "json") return { contentType: "application/json", bytes: Buffer.from(JSON.stringify(body.value), "utf8") };
  const b = newBoundary();
  if (body.garbage) return { contentType: `multipart/form-data; boundary=${b}`, bytes: Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff)) };
  let bytes = buildMultipart(body.parts, b, { close: !body.truncate });
  if (body.truncate) bytes = bytes.subarray(0, bytes.length - 40);
  return { contentType: body.noBoundary ? "multipart/form-data" : `multipart/form-data; boundary=${b}`, bytes };
}

async function signIn(supabaseUrl, anonKey, email, pw, sbjs) {
  if (sbjs && sbjs.createClient) {
    const client = sbjs.createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password: pw });
    if (error || !data || !data.session) return { ok: false, via: "supabase-js", error: error ? String(error.status || error.code || "auth_error") : "no_session" };
    return { ok: true, via: "supabase-js", token: data.session.access_token, userId: data.user ? data.user.id : null, logout: async () => { const r = await client.auth.signOut({ scope: "local" }); return r && r.error ? "error" : "ok"; } };
  }
  // Same GoTrue call supabase-js signInWithPassword performs.
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  if (!r.ok || !j || !j.access_token) return { ok: false, via: "gotrue-rest", error: String(r.status) };
  const token = j.access_token;
  return { ok: true, via: "gotrue-rest", token, userId: j.user ? j.user.id : null, logout: async () => { const o = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: anonKey, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }); return o.ok ? "ok" : "error"; } };
}

async function rpcBool(supabaseUrl, anonKey, token, fn) {
  const r = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(TIMEOUT_MS) });
  let j; try { j = await r.json(); } catch (_) { j = undefined; }
  return { status: r.status, value: j };
}

export async function runNegative({ env = process.env, outDir = defaultOutDir(), quiet = false } = {}) {
  const base = resolveBaseUrl(env.ASALOCAL_BASE_URL);
  const adminEmail = env.ASALOCAL_ADMIN_EMAIL || "", adminPw = env.ASALOCAL_ADMIN_PASSWORD || "";
  const memberEmail = env.ASALOCAL_MEMBER_EMAIL || "", memberPw = env.ASALOCAL_MEMBER_PASSWORD || "";
  const secrets = [adminEmail, adminPw, memberEmail, memberPw];
  let redact = makeRedactor(secrets);
  const log = makeLogger((s) => redact(s), quiet);
  const result = { schema: "s1_negative_result.v1", stage: "SEC_MEDIA_STAGE1", run_id: newRunId(), started_at: nowIso(), verdict: "FAIL", tests: [] };
  const finish = (verdict, code) => {
    result.verdict = verdict; result.finished_at = nowIso();
    const t = result.tests;
    result.summary = { pass: t.filter((x) => x.status === "PASS").length, fail: t.filter((x) => x.status === "FAIL").length, skipped: t.filter((x) => x.status === "SKIPPED").length };
    try { writeJsonGuarded(join(outDir, RESULT_FILE), result, secrets); }
    catch (e) { log(`OUTPUT_GUARD: ${e.message}`); result.verdict = "FAIL"; code = 1; }
    log(`S1_NEGATIVE verdict=${result.verdict} pass=${result.summary.pass} fail=${result.summary.fail} skipped=${result.summary.skipped}`);
    for (const x of t) log(`  [${x.status}] ${x.id} ${x.name} :: expected ${x.expected.status} got ${x.actual ? x.actual.status : "-"}${x.actual && x.actual.error ? " " + x.actual.error : ""}${x.actual && x.actual.source ? " (" + x.actual.source + ")" : ""}${x.reason ? " — " + x.reason : ""}`);
    if (result.stop_reason) log(`  STOP: ${result.stop_reason}`);
    return { code, result };
  };
  if (!base.ok) { result.config_error = base.error; return finish("FAIL", 2); }
  result.base_url = base.origin;

  // ---- discover public config from the LIVE admin page (never hard-coded, never printed)
  let html = "";
  try {
    const r = await fetch(`${base.origin}/admin`, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    result.admin_page = { status: r.status, final_path: new URL(r.url).pathname };
    html = await r.text();
  } catch (e) { result.config_error = `admin_page_fetch_failed: ${redact(String(e.message))}`; return finish("FAIL", 2); }
  const cfg = discoverConfig(html);
  if (!cfg.ok) { result.config_error = cfg.error; return finish("FAIL", 2); }
  if (!cfg.key.ok) { result.stop_reason = `public page key kind=${cfg.key.kind}`; return finish("STOP", 3); }
  const { supabaseUrl, anonKey, fnUrl } = cfg;
  secrets.push(anonKey); redact = makeRedactor(secrets);
  result.supabase_origin = supabaseUrl; result.anon_key = `present(${cfg.key.kind})`;

  const sbjs = await loadModule("@supabase/supabase-js");
  result.session_client = sbjs && sbjs.createClient ? "supabase-js signInWithPassword" : "gotrue-rest /auth/v1/token?grant_type=password (supabase-js not installed)";
  const sessions = {};
  const logouts = [];
  try {
    if (adminEmail && adminPw) {
      const s = await signIn(supabaseUrl, anonKey, adminEmail, adminPw, sbjs);
      if (!s.ok) { result.stop_reason = `admin sign-in failed (${s.via} ${s.error})`; return finish("STOP", 3); }
      secrets.push(s.token); redact = makeRedactor(secrets); sessions.admin = s; logouts.push(["admin", s]);
      result.admin_session = { via: s.via, user: maskUuid(s.userId) };
    }
    if (memberEmail && memberPw) {
      const s = await signIn(supabaseUrl, anonKey, memberEmail, memberPw, sbjs);
      if (!s.ok) { result.stop_reason = `member sign-in failed (${s.via} ${s.error})`; return finish("STOP", 3); }
      secrets.push(s.token); redact = makeRedactor(secrets); sessions.member = s; logouts.push(["member", s]);
      result.member_session = { via: s.via, user: maskUuid(s.userId) };
      // Pre-check: the "member" must NOT be an admin (read-only RPC, same call admin.html makes).
      const chk = await rpcBool(supabaseUrl, anonKey, s.token, "is_current_user_admin");
      result.member_session.is_current_user_admin = chk.value === true ? true : chk.value === false ? false : `unexpected(${chk.status})`;
      if (chk.value !== false) { result.stop_reason = "member account is admin or admin check failed — 403 test would be meaningless"; return finish("STOP", 3); }
    }
    if (sessions.admin && sessions.member && sessions.admin.userId && sessions.admin.userId === sessions.member.userId) { result.stop_reason = "admin and member are the same user"; return finish("STOP", 3); }

    for (const tc of negativeCases()) {
      const rec = { id: tc.id, group: tc.group, name: tc.name, cite: tc.cite, expected: tc.expect, status: "FAIL" };
      result.tests.push(rec);
      let token = null;
      if (tc.auth === "member") token = sessions.member ? sessions.member.token : null;
      else if (tc.auth === "admin") token = sessions.admin ? sessions.admin.token : null;
      else if (tc.auth === "any_jwt") token = (sessions.admin || sessions.member || {}).token || null;
      else if (tc.auth === "anon_key") token = anonKey;
      else if (tc.auth === "garbage") token = "s1-not-a-jwt";
      if (["member", "admin", "any_jwt"].includes(tc.auth) && !token) { rec.status = "SKIPPED"; rec.reason = `${tc.auth === "member" ? "ASALOCAL_MEMBER_*" : "ASALOCAL_ADMIN_*"} env yok`; continue; }
      if (tc.auth === "any_jwt") rec.session_used = sessions.admin ? "admin" : "member";
      const enc = encodeBody(tc.body);
      const headers = { "Content-Type": enc.contentType };
      if (tc.apikey) headers.apikey = anonKey;
      if (token) headers.Authorization = `Bearer ${token}`;
      let r, text = "";
      try {
        r = await fetch(fnUrl, { method: "POST", headers, body: enc.bytes, signal: AbortSignal.timeout(TIMEOUT_MS) });
        text = await r.text();
      } catch (e) { rec.reason = `network: ${redact(String(e.message)).slice(0, 120)}`; continue; }
      let j = null; try { j = JSON.parse(text); } catch (_) { j = null; }
      const fnLevel = !!r.headers.get("x-request-id") && j && typeof j.error === "string";
      const leaks = findLeaks(text, secrets);
      const stack = stackLeakMarkers(text);
      rec.actual = { status: r.status, source: fnLevel ? "function" : "gateway", error: fnLevel ? j.error : null, body_keys: j && typeof j === "object" ? Object.keys(j).sort() : null, body_bytes: text.length };
      rec.leak_check = leaks.length || stack.length ? { secrets: leaks, stack_markers: stack } : "clean";
      const errOk = fnLevel ? tc.expect.errors.includes(j.error) : tc.expect.errors.includes("*gateway");
      const shapeOk = fnLevel ? JSON.stringify(Object.keys(j)) === JSON.stringify(["error"]) : true;
      rec.status = r.status === tc.expect.status && errOk && shapeOk && rec.leak_check === "clean" && text.length < 2048 ? "PASS" : "FAIL";
      if (r.status >= 200 && r.status < 300) { rec.status = "FAIL"; result.stop_reason = `${tc.id} returned ${r.status}: possible object/rate side effect — STOP, take MID0 snapshot`; break; }
      await new Promise((res) => setTimeout(res, 250));
    }
  } finally {
    result.logout = {};
    for (const [k, s] of logouts) { try { result.logout[k] = await s.logout(); } catch (_) { result.logout[k] = "error"; } }
  }
  const t = result.tests;
  if (result.stop_reason) return finish("STOP", 3);
  if (t.some((x) => x.status === "FAIL")) return finish("FAIL", 1);
  if (t.some((x) => x.status === "SKIPPED")) return finish("INCOMPLETE", 4);
  return finish("PASS", 0);
}

// ------------------------------------------------------------------ selftest (offline)
async function selftest() {
  const c = makeChecker("s1_negative selftest");
  const gif = makeGifCanary();
  c.ok(sniffMimeLocal(gif) === "image/gif", "canary sniffs as image/gif");
  let mu = null;
  try { mu = await import(join(REPO_ROOT, "CDP3B/edge/admin-api/inert/media_upload.ts")); } catch (_) { mu = null; }
  c.ok(!!mu, "server module media_upload.ts importable");
  if (mu) {
    c.ok(mu.sniffMime(new Uint8Array(gif)) === "image/gif" && !mu.mediaMimeAllowed(mu.sniffMime(new Uint8Array(gif))), "server: canary NOT an allowed mime (can never be stored)");
    const planned = await mu.planMediaUpload({ prefix: "venues", bytes: new Uint8Array(gif), supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co", newUuid: () => crypto.randomUUID(), upload: async () => { throw new Error("upload must not be reached"); } });
    c.ok(!planned.ok && planned.status === 400 && planned.error === "bad_mime_content", "server: planMediaUpload(canary) → 400 bad_mime_content, uploader never called");
    // Every parse-level case must produce exactly the expected status/error with the REAL server parser.
    for (const tc of negativeCases(gif)) {
      if (tc.body.kind !== "multipart") { c.ok(mu.contentTypeBranch("application/json") === "json_admin" && mu.jsonMediaUploadRejected().status === 415, `${tc.id}: JSON branch → 415`); continue; }
      const enc = encodeBody(tc.body);
      const p = mu.parseMediaMultipart(enc.contentType, new Uint8Array(enc.bytes));
      if (["prefix", "malformed"].includes(tc.group)) {
        c.ok(!p.ok && p.status === tc.expect.status && tc.expect.errors.includes(p.error), `${tc.id}: real parser → ${p.ok ? "ok" : p.status + " " + p.error} (expected ${tc.expect.status} ${tc.expect.errors[0]})`);
      } else {
        // auth/role cases: body is well-formed, so the rejection must come from the auth/role gate, not the parser.
        c.ok(p.ok && p.prefix === "venues", `${tc.id}: body well-formed (rejection must come from gate ${tc.cite})`);
      }
    }
  }
  const cases = negativeCases(gif);
  c.ok(new Set(cases.map((x) => x.id)).size === cases.length, "unique test ids");
  c.ok(cases.every((x) => x.expect.status >= 400 && x.expect.status < 500), "all expectations are 4xx");
  c.ok(cases.filter((x) => x.body.kind === "multipart").every((x) => (x.body.parts || []).every((p) => p.name !== "file" || sniffMimeLocal(p.data) === "image/gif")), "every multipart file part is the GIF canary");
  // stack/secret marker detector
  c.ok(stackLeakMarkers('{"error":"bad_input"}').length === 0, "clean body has no markers");
  c.ok(stackLeakMarkers("TypeError: x\n    at handler (file:///src/index.ts:57:3)").length >= 2, "stack trace detected");
  c.ok(stackLeakMarkers('{"error":"SUPABASE_SERVICE_ROLE_KEY missing"}').includes("env_name"), "env name detected");
  const res = c.done();
  return res.fail === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--selftest")) process.exit(await selftest());
  const { code } = await runNegative();
  process.exit(code);
}
