#!/usr/bin/env node
// SEC-MEDIA · Stage 1 · OFFLINE prova (rehearsal). Canlı sisteme HİÇBİR istek atmaz.
// Runs the two live harnesses end-to-end against:
//   * the REAL admin UI code (repo CDP3B/admin.html, served via Playwright routes),
//   * the REAL admin-api handler (CDP3B/edge/admin-api/index.ts + inert/media_upload.ts, loaded in Node
//     with Deno.serve/Deno.env shims and a mocked supabase client),
//   * a simulated verify_jwt=true gateway and minimal mocked Auth/REST/Storage endpoints.
// Plus fault injections that MUST make the harness FAIL/STOP (proves the checks have teeth).
// All external network is blocked in the browser (catch-all abort); negative tests hit 127.0.0.1 only.
// Needs: playwright + @supabase/supabase-js (UMD for the page) resolvable (stage1/node_modules or S1_NODE_MODULES).
// Exit: 0 all scenarios as expected · 1 mismatch · 4 SKIPPED (deps missing)
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, isMain, sha256hex } from "./s1_lib.mjs";
import { runAcceptance } from "./s1_admin_upload_acceptance.mjs";
import { runNegative } from "./s1_negative.mjs";

const PROD = "https://www.asalocal.club";
const SUPA = "https://tosqsabuaomgqjtogdrn.supabase.co";
const IDX = join(REPO_ROOT, "CDP3B/edge/admin-api/index.ts");
const MU = join(REPO_ROOT, "CDP3B/edge/admin-api/inert/media_upload.ts");
const ADMIN_HTML = join(REPO_ROOT, "CDP3B/admin.html");
const b64u = (s) => Buffer.from(s).toString("base64url");
const fakeJwt = (payload) => `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}.${b64u("s1-rehearsal-signature")}`;
const rnd = () => Math.random().toString(36).slice(2, 12);

// ------------------------------------------------------------------ mock world
function newWorld({ supabaseUrl, memberIsAdmin = false, faults = {} }) {
  const anon = fakeJwt({ iss: "supabase", ref: "rehearsal", role: "anon" });
  const svcKey = `rehearsal-service-${rnd()}`;
  const users = {
    admin: { id: crypto.randomUUID(), email: "s1-admin@example.test", pw: `pw-${rnd()}`, isAdmin: true, roles: ["super_admin"] },
    member: { id: crypto.randomUUID(), email: "s1-member@example.test", pw: `pw-${rnd()}`, isAdmin: memberIsAdmin, roles: memberIsAdmin ? ["support"] : [] },
  };
  return { supabaseUrl, anon, svcKey, users, faults, tokens: new Map(), objects: new Map(), rate: [], restWrites: [], directStorageWrites: [], logouts: [], handlerSha: null, handler: null };
}

function mockCreateClient(world) {
  return (_url, key, opts = {}) => {
    const authz = opts.global && opts.global.headers ? opts.global.headers.Authorization || "" : "";
    const tok = authz.replace(/^Bearer\s+/, "");
    const user = world.tokens.get(tok) || null;
    const isSvc = key === world.svcKey && !authz;
    return {
      auth: { getUser: async () => (user ? { data: { user: { id: user.id } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } }) },
      rpc: async (fn, args = {}) => {
        if (!isSvc) {
          if (fn === "is_current_user_admin") return { data: !!(user && user.isAdmin), error: null };
          if (fn === "current_user_has_admin_role") return { data: !!(user && user.roles.includes(args.role_name)), error: null };
          return { data: null, error: { message: "not mocked" } };
        }
        if (fn === "admin_api_status" || fn === "admin_writes_status") return { data: true, error: null };
        if (fn === "admin_rate_check") { world.rate.push({ actor: args.p_actor, action: args.p_action }); return { data: true, error: null }; }
        if (fn === "admin_q_counts") return { data: { users: 1, members: 1 }, error: null };
        return { data: null, error: { message: "not mocked" } };
      },
      storage: {
        from: (bucket) => ({
          upload: async (path, bytes, o = {}) => {
            if (!isSvc) return { data: null, error: { message: "rehearsal: only service client may upload" } };
            const k = `${bucket}/${path}`;
            if (world.objects.has(k)) return { data: null, error: { message: "The resource already exists", error: "Duplicate" } };
            world.objects.set(k, { bytes: Buffer.from(bytes), contentType: o.contentType, upsert: o.upsert });
            return { data: { path }, error: null };
          },
        }),
      },
    };
  };
}

/** Loads the REAL admin-api handler with only two mechanical substitutions (asserted). */
async function loadRealHandler(world, tmp, transform = (s) => s) {
  const orig = readFileSync(IDX, "utf8");
  world.handlerSha = sha256hex(Buffer.from(orig));
  const A = 'import { createClient } from "jsr:@supabase/supabase-js@2";';
  const B = 'from "./inert/media_upload.ts";';
  if (orig.split(A).length !== 2 || orig.split(B).length !== 2) throw new Error("index.ts import lines changed; update rehearsal");
  let src = orig.replace(A, "const { createClient } = (globalThis as any).__S1_MOCK__;").replace(B, `from ${JSON.stringify(pathToFileURL(MU).href)};`);
  src = transform(src);
  const f = join(tmp, `admin-api.rehearsal.${rnd()}.ts`);
  writeFileSync(f, src);
  const env = { SUPABASE_URL: world.supabaseUrl, SUPABASE_ANON_KEY: world.anon, ADMIN_API_KILL: "" };
  env["SUPABASE_SERVICE_ROLE_KEY"] = world.svcKey;
  let captured = null;
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { captured = h; } };
  globalThis.__S1_MOCK__ = { createClient: mockCreateClient(world) };
  await import(pathToFileURL(f).href);
  if (typeof captured !== "function") throw new Error("handler not captured");
  world.handler = captured;
}

const corsHeaders = (req) => ({
  "access-control-allow-origin": req.headers.get("origin") || "*",
  "access-control-allow-headers": req.headers.get("access-control-request-headers") || "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-expose-headers": "x-request-id, content-range",
});
const jsonRes = (req, status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...corsHeaders(req), ...extra } });

/** Mock Supabase project: gateway(verify_jwt=true) → real admin-api; Auth/REST/Storage minimal mocks. */
async function handleSupabase(world, req) {
  const u = new URL(req.url);
  const p = u.pathname;
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const userOf = (t) => world.tokens.get(t) || null;
  if (p === "/functions/v1/admin-api") {
    if (req.method !== "OPTIONS") {
      const validJwt = bearer && (bearer === world.anon || world.tokens.has(bearer));
      if (!validJwt) return new Response(JSON.stringify({ code: 401, message: "Invalid JWT" }), { status: 401, headers: { "content-type": "application/json", ...corsHeaders(req) } });
    }
    // v17-style broken deploy: every request that reaches the function code dies (500, no CORS headers).
    if (world.faults.fnBroken) return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } });
    let res = await world.handler(req);
    if (world.faults.rewriteUploadPath && req.method === "POST" && /multipart/i.test(req.headers.get("content-type") || "") && res.status === 200) {
      const j = await res.json();
      const bad = "venues/s1-acceptance-client-chosen.png";
      j.data.path = bad; j.data.public_url = `${world.supabaseUrl}/storage/v1/object/public/media/${bad}`;
      res = new Response(JSON.stringify(j), { status: 200, headers: res.headers });
    }
    return res;
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (p === "/auth/v1/token") {
    const j = await req.json().catch(() => ({}));
    const usr = Object.values(world.users).find((x) => x.email === j.email && x.pw === j.password);
    if (!usr) return jsonRes(req, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
    const now = Math.floor(Date.now() / 1000);
    const at = fakeJwt({ sub: usr.id, role: "authenticated", aud: "authenticated", exp: now + 3600, iat: now, session_id: crypto.randomUUID() });
    world.tokens.set(at, usr);
    return jsonRes(req, 200, { access_token: at, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: `rt-${rnd()}`, user: { id: usr.id, aud: "authenticated", role: "authenticated", email: usr.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
  }
  if (p === "/auth/v1/logout") { world.logouts.push({ scope: u.searchParams.get("scope"), known: world.tokens.has(bearer) }); world.tokens.delete(bearer); return new Response(null, { status: 204, headers: corsHeaders(req) }); }
  if (p === "/auth/v1/user") { const usr = userOf(bearer); return usr ? jsonRes(req, 200, { id: usr.id, aud: "authenticated", role: "authenticated", email: usr.email }) : jsonRes(req, 401, { msg: "invalid" }); }
  if (p.startsWith("/rest/v1/rpc/")) {
    const fn = p.slice("/rest/v1/rpc/".length);
    const usr = userOf(bearer);
    const args = await req.json().catch(() => ({}));
    if (fn === "is_current_user_admin") return jsonRes(req, 200, !!(usr && usr.isAdmin));
    if (fn === "current_user_has_admin_role") return jsonRes(req, 200, !!(usr && usr.roles.includes(args.role_name)));
    if (fn === "_can_edit_venues") return jsonRes(req, 200, !!(usr && usr.roles.includes("super_admin")));
    return jsonRes(req, 200, false);
  }
  if (p.startsWith("/rest/v1/")) {
    if (req.method === "GET" || req.method === "HEAD") return jsonRes(req, 200, []);
    world.restWrites.push({ method: req.method, table: p.slice(9) });
    return jsonRes(req, 201, []);
  }
  if (p.startsWith("/storage/v1/object/public/")) {
    const k = decodeURIComponent(p.slice("/storage/v1/object/public/".length));
    const o = world.objects.get(k);
    if (!o) return jsonRes(req, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
    return new Response(o.bytes, { status: 200, headers: { "content-type": world.faults.publicWrongType ? "text/html" : o.contentType, "cache-control": "max-age=3600", ...corsHeaders(req) } });
  }
  if (p.startsWith("/storage/v1/")) { world.directStorageWrites.push({ method: req.method, path: p.replace(/[0-9a-f-]{36}/g, "<uuid>") }); return jsonRes(req, 200, { Key: "media/x" }); }
  return jsonRes(req, 404, { error: "not_mocked" });
}

// ------------------------------------------------------------------ acceptance scenarios (browser)
function resolveUmd() {
  const tries = [join(dirname(new URL(import.meta.url).pathname), "..", "package.json")];
  if (process.env.S1_NODE_MODULES) tries.push(join(process.env.S1_NODE_MODULES.replace(/node_modules\/?$/, ""), "package.json"));
  for (const t of tries) {
    try {
      let d = dirname(createRequire(t).resolve("@supabase/supabase-js"));
      for (let i = 0; i < 4; i++) { const f = join(d, "umd", "supabase.js"); if (existsSync(f)) return f; const g = join(d, "dist", "umd", "supabase.js"); if (existsSync(g)) return g; d = dirname(d); }
    } catch (_) { /* next */ }
  }
  return null;
}

function installRoutesFor(world, { html, umd, initScript = null }) {
  return async (context) => {
    await context.route("**/*", (route) => route.abort("blockedbyclient")); // nothing real leaves the browser
    await context.route("https://cdnjs.cloudflare.com/**", (route) => route.fulfill({ status: 404, body: "" }));
    await context.route("https://cdn.asalocal.club/**", (route) => route.fulfill({ status: 404, body: "" }));
    await context.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(umd) }));
    await context.route(`${PROD}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      // Playwright does not intercept the follow-up of a fulfilled 3xx, so the /admin → /CDP3B/admin.html
      // 302 hop (_redirects) is NOT simulated here; /admin is served directly. (Negative rehearsal does follow a 302.)
      if (p === "/admin" || p === "/CDP3B/admin.html") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      if (p === "/decision_contract.js") return route.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(join(REPO_ROOT, "decision_contract.js")) });
      return route.fulfill({ status: 404, body: "" });
    });
    await context.route(`${SUPA}/**`, async (route) => {
      const r = route.request();
      const headers = await r.allHeaders();
      const req = new Request(r.url(), { method: r.method(), headers, body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postDataBuffer() || undefined });
      const res = await handleSupabase(world, req);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
    });
    if (initScript) await context.addInitScript({ content: initScript });
  };
}

const FAULT_SET_CT = `(() => { const of = window.fetch; window.fetch = function (i, init) { try { if (String(i).includes("/functions/v1/admin-api") && init && init.body instanceof FormData) { init = { ...init, headers: { ...(init.headers || {}), "Content-Type": "multipart/form-data" } }; } } catch (_) {} return of.call(this, i, init); }; })();`;
const FAULT_DIRECT_STORAGE = `(() => { const of = window.fetch; window.fetch = function (i, init) { const r = of.apply(this, arguments); try { if (String(i).includes("/functions/v1/admin-api") && init && init.body instanceof FormData) { r.then(() => of.call(window, "${SUPA}/storage/v1/object/media/venues/fallback.png", { method: "POST", headers: { "x-upsert": "false" }, body: init.body.get("file") }).catch(() => {})); } } catch (_) {} return r; }; })();`;
// Bypasses the page's client-side prefix guard: uploadToMedia(…, "evil") resolves instead of throwing (A06 must FAIL and stop the run).
const FAULT_GUARD_BYPASS = `(() => { document.addEventListener("DOMContentLoaded", () => { const orig = window.uploadToMedia; if (typeof orig !== "function") return; window.uploadToMedia = async function (file, prefix) { if (prefix === "evil") return "${SUPA}/storage/v1/object/public/media/evil/bypass.png"; return orig.apply(this, arguments); }; }); })();`;
const FAULT_VENUE_SAVE = `(() => { const of = window.fetch; window.fetch = function (i, init) { const r = of.apply(this, arguments); try { if (String(i).includes("/functions/v1/admin-api") && init && init.body instanceof FormData) { r.then(() => of.call(window, "${SUPA}/rest/v1/venues?on_conflict=id", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {})); } } catch (_) {} return r; }; })();`;

async function acceptanceScenario(name, { tmp, umd, htmlTransform = (h) => h, initScript = null, faults = {}, mode = "full", expect, reuseOutDir = null, envOverride = {} }) {
  const world = newWorld({ supabaseUrl: SUPA, faults });
  await loadRealHandler(world, tmp);
  const html = htmlTransform(readFileSync(ADMIN_HTML, "utf8"));
  const outDir = reuseOutDir || mkdtempSync(join(tmp, `acc-${name}-`));
  const env = { ASALOCAL_BASE_URL: PROD, ASALOCAL_ADMIN_EMAIL: world.users.admin.email, ASALOCAL_ADMIN_PASSWORD: world.users.admin.pw, S1_CONFIRM_UPLOAD: "YES", ...envOverride };
  if (process.env.S1_CHROMIUM_PATH) env.S1_CHROMIUM_PATH = process.env.S1_CHROMIUM_PATH;
  const { code, result } = await runAcceptance({ env, mode, outDir, installRoutes: installRoutesFor(world, { html, umd, initScript }), quiet: process.env.S1_REHEARSAL_VERBOSE !== "1" });
  const fails = result.checks.filter((c) => c.status === "FAIL").map((c) => c.id);
  const ok = expect(code, result, world, fails, outDir);
  return { scenario: `acceptance:${name}`, ok, exit: code, verdict: result.verdict, failed_checks: fails, world: { objects: world.objects.size, rate_tokens: world.rate.filter((r) => r.action === "media_upload").length, rest_writes: world.restWrites.length, direct_storage_writes: world.directStorageWrites.length, logouts: world.logouts.map((l) => l.scope) }, outDir };
}

const outFiles = (dir) => { try { return readdirSync(dir).sort(); } catch (_) { return []; } };
const blockedFiles = (dir) => outFiles(dir).filter((f) => /^s1_upload_blocked\.s1-[0-9]{14}-[0-9a-f]{1,6}\.json$/.test(f));
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

// ------------------------------------------------------------------ negative scenarios (node fetch → 127.0.0.1)
async function negativeScenario(name, { tmp, memberIsAdmin = false, withMember = true, handlerTransform = (s) => s, useSupabaseJs = true, expect }) {
  const world = newWorld({ supabaseUrl: "http://127.0.0.1:0", memberIsAdmin });
  const server = createServer(async (nreq, nres) => {
    const chunks = []; for await (const ch of nreq) chunks.push(ch);
    const url = `${world.supabaseUrl}${nreq.url}`;
    const headers = Object.fromEntries(Object.entries(nreq.headers).filter(([, v]) => typeof v === "string"));
    let res;
    const p = new URL(url).pathname;
    if (p === "/admin") res = new Response(null, { status: 302, headers: { location: "/CDP3B/admin.html" } });
    else if (p === "/CDP3B/admin.html") {
      const html = readFileSync(ADMIN_HTML, "utf8").replace(/const CFG=\{url:"[^"]+",key:"[^"]+"\}/, `const CFG={url:"${world.supabaseUrl}",key:"${world.anon}"}`);
      res = new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    } else {
      const req = new Request(url, { method: nreq.method, headers, body: ["GET", "HEAD"].includes(nreq.method) ? undefined : Buffer.concat(chunks) });
      res = await handleSupabase(world, req);
    }
    nres.writeHead(res.status, Object.fromEntries(res.headers.entries()));
    nres.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  world.supabaseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await loadRealHandler(world, tmp, handlerTransform);
    const outDir = mkdtempSync(join(tmp, `neg-${name}-`));
    const env = { ASALOCAL_BASE_URL: world.supabaseUrl, ASALOCAL_ADMIN_EMAIL: world.users.admin.email, ASALOCAL_ADMIN_PASSWORD: world.users.admin.pw };
    if (withMember) { env.ASALOCAL_MEMBER_EMAIL = world.users.member.email; env.ASALOCAL_MEMBER_PASSWORD = world.users.member.pw; }
    const saved = process.env.S1_NODE_MODULES;
    if (!useSupabaseJs) delete process.env.S1_NODE_MODULES;
    const { code, result } = await runNegative({ env, outDir, quiet: process.env.S1_REHEARSAL_VERBOSE !== "1" }).finally(() => { if (saved !== undefined) process.env.S1_NODE_MODULES = saved; });
    const ok = expect(code, result, world);
    return { scenario: `negative:${name}`, ok, exit: code, verdict: result.verdict, session_client: result.session_client, tests: result.tests.map((t) => `${t.id}:${t.status}:${t.actual ? t.actual.status + (t.actual.error ? "/" + t.actual.error : "") + "/" + t.actual.source : "-"}`), world: { objects: world.objects.size, rate_tokens: world.rate.length, logouts: world.logouts.map((l) => l.scope) }, outDir };
  } finally { server.close(); }
}

// ------------------------------------------------------------------ main
export async function rehearse() {
  const pw = await import("./s1_lib.mjs").then((m) => m.loadModule("playwright"));
  const umd = resolveUmd();
  if (!pw || !umd) { console.log(`S1_REHEARSAL_SKIPPED: playwright=${!!pw} supabase-js-umd=${!!umd} (npm install in stage1/ or set S1_NODE_MODULES)`); return 4; }
  const tmp = mkdtempSync(join(tmpdir(), "s1-rehearsal-"));
  const out = [];
  const noFail = (code, r) => code === 0 && r.verdict === "PASS";
  try {
    // ---- acceptance: baseline must PASS with exactly one object, one rate token, zero direct/REST writes, local logout
    const base = await acceptanceScenario("baseline", { tmp, umd, expect: (code, r, w) => noFail(code, r) && w.objects.size === 1 && w.rate.filter((x) => x.action === "media_upload").length === 1 && w.restWrites.length === 0 && w.directStorageWrites.length === 0 && w.logouts.some((l) => l.scope === "local") && !w.logouts.some((l) => l.scope === "global") });
    out.push(base);
    // ---- the result file must be leak-free and masked
    let masked = false;
    try {
      const resText = readFileSync(join(base.outDir, "s1_upload_result.json"), "utf8");
      const resJson = JSON.parse(resText);
      masked = /^venues\/[0-9a-f]{8}-\*\*\*\*\.png$/.test(resJson.object.path_masked) && !/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png/.test(resText) && !/example\.test|Bearer\s+\w|pw-/.test(resText);
    } catch (_) { masked = false; }
    out.push({ scenario: "acceptance:result_file_masked_and_leak_free", ok: masked });
    let refOk = false;
    try {
      const ref = JSON.parse(readFileSync(join(base.outDir, "s1_object_ref.local.json"), "utf8"));
      const res = JSON.parse(readFileSync(join(base.outDir, "s1_upload_result.json"), "utf8"));
      refOk = sha256hex(Buffer.from(ref.path, "utf8")) === res.object.path_sha256 && ref.path_sha256 === res.object.path_sha256;
    } catch (_) { refOk = false; }
    out.push({ scenario: "acceptance:local_object_ref_matches_masked_result", ok: refOk });
    // ---- rerun with the marker present must STOP (no second upload, PRD 2.2)
    out.push(await acceptanceScenario("rerun_blocked_by_marker", { tmp, umd, reuseOutDir: base.outDir, expect: (code, r, w) => code === 3 && r.verdict === "STOP" && w.objects.size === 0 && w.tokens.size === 0 }));
    // ---- the other early exits, run in the SAME (used) out dir, must not touch the evidence either
    out.push(await acceptanceScenario("no_confirm_in_used_out_dir", { tmp, umd, reuseOutDir: base.outDir, envOverride: { S1_CONFIRM_UPLOAD: "" }, expect: (code, r, w) => code === 3 && r.verdict === "STOP" && w.tokens.size === 0 && w.objects.size === 0 }));
    out.push(await acceptanceScenario("missing_credentials_in_used_out_dir", { tmp, umd, reuseOutDir: base.outDir, envOverride: { ASALOCAL_ADMIN_PASSWORD: "" }, expect: (code, r, w) => code === 2 && r.verdict === "FAIL" && w.tokens.size === 0 && w.objects.size === 0 }));
    // ---- the single upload's evidence survives every blocked rerun (snapshot diff MID/POST still has its input)
    let kept = false; let keptDetail = null;
    try {
      const res = readJson(join(base.outDir, "s1_upload_result.json"));
      const ref = readJson(join(base.outDir, "s1_object_ref.local.json"));
      const blocked = blockedFiles(base.outDir).map((f) => readJson(join(base.outDir, f)));
      keptDetail = { verdict: res.verdict, blocked: blocked.length };
      kept = res.verdict === "PASS" && res.upload_attempted === true && typeof res.object?.path_sha256 === "string" && res.object.path_sha256 === ref.path_sha256
        && blocked.length === 3 && blocked.every((b) => b.upload_attempted === false && (b.verdict === "STOP" || b.verdict === "FAIL"));
    } catch (_) { kept = false; }
    out.push({ scenario: "acceptance:evidence_preserved_after_blocked_reruns", ok: kept, detail: keptDetail });
    // ---- marker removed but the previous result still present → STOP before login; the old file is not overwritten
    const seeded = mkdtempSync(join(tmp, "acc-seeded-"));
    const sentinel = JSON.stringify({ schema: "s1_upload_result.v1", verdict: "PASS", sentinel: "rehearsal" }) + "\n";
    writeFileSync(join(seeded, "s1_upload_result.json"), sentinel);
    out.push(await acceptanceScenario("result_file_without_marker_stops", { tmp, umd, reuseOutDir: seeded, expect: (code, r, w, _f, dir) => code === 3 && r.verdict === "STOP" && w.tokens.size === 0 && w.objects.size === 0 && readFileSync(join(dir, "s1_upload_result.json"), "utf8") === sentinel && !existsSync(join(dir, "s1_upload.attempt")) }));
    // ---- missing confirmation must STOP before any login (fresh dir: no result file, one blocked file)
    out.push(await acceptanceScenario("no_confirm", { tmp, umd, envOverride: { S1_CONFIRM_UPLOAD: "" }, expect: (code, r, w, _f, dir) => code === 3 && r.verdict === "STOP" && w.tokens.size === 0 && w.objects.size === 0 && !existsSync(join(dir, "s1_upload_result.json")) && blockedFiles(dir).length === 1 }));
    // ---- preflight: static checks only, no login
    out.push(await acceptanceScenario("preflight", { tmp, umd, mode: "preflight", expect: (code, r, w) => code === 0 && r.verdict === "PREFLIGHT_PASS" && w.tokens.size === 0 && w.objects.size === 0 }));
    // ---- S1-00b runtime acceptance: counts 200 + OPTIONS 200 via the real UI session; no upload, local logout
    const noUpload = (w) => w.objects.size === 0 && w.rate.filter((x) => x.action === "media_upload").length === 0 && w.restWrites.length === 0 && w.directStorageWrites.length === 0;
    out.push(await acceptanceScenario("runtime_acceptance", { tmp, umd, mode: "runtime", expect: (code, r, w, _f, dir) => code === 0 && r.verdict === "RUNTIME_PASS" && ["R01", "R02", "R03"].every((id) => r.checks.some((c) => c.id === id && c.status === "PASS")) && noUpload(w) && w.rate.some((x) => x.action === "counts") && w.logouts.some((l) => l.scope === "local") && !w.logouts.some((l) => l.scope === "global") && existsSync(join(dir, "s1_runtime_result.json")) && !existsSync(join(dir, "s1_upload.attempt")) }));
    out.push(await acceptanceScenario("fault_runtime_function_broken", { tmp, umd, mode: "runtime", faults: { fnBroken: true }, expect: (code, r, w) => code === 1 && r.verdict === "FAIL" && ["R01", "R02"].every((id) => r.checks.some((c) => c.id === id && c.status === "FAIL")) && noUpload(w) }));
    // ---- fault injections (must FAIL)
    const mustFail = (ids) => (code, r) => code === 1 && r.verdict === "FAIL" && ids.every((id) => r.checks.some((c) => c.id === id && c.status === "FAIL"));
    out.push(await acceptanceScenario("fault_content_type_hand_set", { tmp, umd, initScript: FAULT_SET_CT, expect: mustFail(["A10", "A14"]) }));
    out.push(await acceptanceScenario("fault_direct_storage_fallback", { tmp, umd, initScript: FAULT_DIRECT_STORAGE, expect: mustFail(["A13"]) }));
    // client prefix guard bypassed → A06 FAIL must stop BEFORE the marker and the upload (PRD 2.2)
    out.push(await acceptanceScenario("fault_client_guard_bypassed", { tmp, umd, initScript: FAULT_GUARD_BYPASS, expect: (code, r, w, _f, dir) => mustFail(["A06"])(code, r) && r.stop_reason === "pre_upload_gate_failed" && w.objects.size === 0 && w.rate.filter((x) => x.action === "media_upload").length === 0 && !existsSync(join(dir, "s1_upload.attempt")) && !existsSync(join(dir, "s1_upload_result.json")) && blockedFiles(dir).length === 1 }));
    out.push(await acceptanceScenario("fault_venue_row_saved", { tmp, umd, initScript: FAULT_VENUE_SAVE, expect: mustFail(["A13"]) }));
    out.push(await acceptanceScenario("fault_client_chosen_path", { tmp, umd, faults: { rewriteUploadPath: true }, expect: mustFail(["A15"]) }));
    out.push(await acceptanceScenario("fault_public_wrong_mime", { tmp, umd, faults: { publicWrongType: true }, expect: mustFail(["A17"]) }));
    out.push(await acceptanceScenario("fault_static_storage_from", { tmp, umd, htmlTransform: (h) => h.replace("return d.public_url;", 'try{await authClient.storage.from("media").upload("venues/x.png",file);}catch(_){}\n  return d.public_url;'), expect: (code, r, w) => mustFail(["A03"])(code, r) && w.tokens.size === 0 }));

    // ---- negative: full set must PASS, create 0 objects, consume 0 rate tokens, logout local
    const negOk = (code, r, w) => code === 0 && r.verdict === "PASS" && w.objects.size === 0 && w.rate.length === 0 && w.logouts.length === 2 && w.logouts.every((l) => l.scope === "local");
    out.push(await negativeScenario("full_supabase_js", { tmp, useSupabaseJs: true, expect: negOk }));
    out.push(await negativeScenario("full_gotrue_rest_fallback", { tmp, useSupabaseJs: false, expect: negOk }));
    out.push(await negativeScenario("no_member_is_incomplete", { tmp, withMember: false, expect: (code, r, w) => code === 4 && r.verdict === "INCOMPLETE" && r.tests.find((t) => t.id === "N2").status === "SKIPPED" && w.objects.size === 0 }));
    out.push(await negativeScenario("member_is_admin_stops", { tmp, memberIsAdmin: true, expect: (code, r, w) => code === 3 && r.verdict === "STOP" && w.objects.size === 0 && w.logouts.length === 2 }));
    // broken server: is_admin gate removed → N2 must FAIL; canary still prevents any object
    out.push(await negativeScenario("fault_server_missing_admin_gate", { tmp, handlerTransform: (s) => s.replace('if(adm.value!==true)return json(403,{error:"not_admin"},request_id,ch);', ""), expect: (code, r, w) => code === 1 && r.tests.find((t) => t.id === "N2").status === "FAIL" && w.objects.size === 0 }));
    // broken server: ALL role gates removed → N2 FAIL (400 bad_mime_content from sniff) and STILL zero objects (canary design)
    out.push(await negativeScenario("fault_server_no_role_gates_canary_holds", { tmp, handlerTransform: (s) => s.replace('if(adm.value!==true)return json(403,{error:"not_admin"},request_id,ch);', "").replace(/ const need=ROLE_SETS\[action\];[^\n]*\n/, "\n").replace(/  if\(pTrue\)\{\} else if\(pTech\)[^\n]*\n/, "\n"), expect: (code, r, w) => code === 1 && r.tests.find((t) => t.id === "N2").actual.error === "bad_mime_content" && w.objects.size === 0 }));
  } finally {
    if (process.env.S1_KEEP !== "1") rmSync(tmp, { recursive: true, force: true });
  }
  let bad = 0;
  for (const s of out) {
    if (!s.ok) bad++;
    console.log(`[${s.ok ? "OK " : "BAD"}] ${s.scenario}${s.detail ? ` detail=${JSON.stringify(s.detail)}` : ""}${s.verdict ? ` exit=${s.exit} verdict=${s.verdict}` : ""}${s.failed_checks && s.failed_checks.length ? ` failed=${s.failed_checks.join(",")}` : ""}${s.world ? ` world=${JSON.stringify(s.world)}` : ""}${s.session_client ? ` client=${s.session_client.split(" ")[0]}` : ""}`);
    if (s.tests) console.log(`      ${s.tests.join(" ")}`);
  }
  console.log(`S1_REHEARSAL ${bad === 0 ? "PASS" : "FAIL"} scenarios=${out.length} bad=${bad} admin-api index.ts sha256=${out.length ? sha256hex(readFileSync(IDX)).slice(0, 16) : "-"}`);
  return bad === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(await rehearse());
