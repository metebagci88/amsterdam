// ASALOCAL · LIVE SMOKE (anonymous, read-only, zero-footprint)
//
// Runs from GitHub Actions against production. No login, no credentials,
// no writes: every request is a GET/OPTIONS or a POST that the server must
// reject before any side effect (401/403/415). Storage writes are NOT tested
// here (anon write policies are still open; a write test would leave residue).
//
// The public anon key is read at runtime from the live page and masked in logs.
// Output: one JSON report on stdout; exit 1 if any check FAILs.
//
// Usage: node LIVE_CHECKS/live_smoke.mjs [--selftest]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = (process.env.ASALOCAL_BASE_URL || "https://www.asalocal.club").replace(/\/+$/, "");
const ORIGIN = "https://www.asalocal.club";
const FN = "https://tosqsabuaomgqjtogdrn.supabase.co/functions/v1/admin-api";
const results = [];
const rec = (id, pass, detail) => results.push({ id, result: pass === null ? "SKIP" : pass ? "PASS" : "FAIL", detail });
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const STACK_RE = /\bat\s+\S+\s+\(|file:\/\/|\/var\/tmp\/|Deno\.|stack|ReferenceError|TypeError|service_role|SUPABASE_SERVICE/i;

// Pages: live path -> repo file. Byte equality proves the deployed static asset.
const PAGES = [
  { path: "/", file: "index.html", title: "asalocal · Bir yerli gibi gez" },
  { path: "/amsterdam/", file: "amsterdam/index.html", title: "Amsterdam · Lokal Yaşam Rehberi" },
  { path: "/kopenhag/", file: "kopenhag/index.html", title: "Kopenhag · AsaLocal" },
  { path: "/CDP3B/admin.html", file: "CDP3B/admin.html", title: "asalocal · Yönetim Paneli" },
];
// _redirects contract (Cloudflare Pages).
const REDIRECTS = [
  { path: "/admin", to: "/CDP3B/admin.html" },
  { path: "/admin.html", to: "/CDP3B/admin.html" },
  { path: "/copenhagen", to: "/kopenhag/" },
  { path: "/kopenhag.html", to: "/kopenhag/" },
];

// Production serves origin/main; compare against that, not the (possibly ahead) branch tree.
function deployedRef(file) {
  try { return execFileSync("git", ["show", `origin/main:${file}`], { maxBuffer: 64 << 20 }); }
  catch { return readFileSync(file); }
}

export function maskKey(s) {
  return typeof s === "string" && s.length > 16 ? `${s.slice(0, 6)}…(${s.length})` : "(none)";
}
export function extractAnonKey(html) {
  const m = html.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  return m ? m[0] : null;
}
export function jwtRole(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).role ?? null;
  } catch { return null; }
}
export function sameLocation(loc, base, to) {
  if (!loc) return false;
  const u = new URL(loc, base);
  // Cloudflare Pages may drop ".html" (308 pretty URLs); accept both spellings.
  const strip = (p) => p.replace(/\.html$/, "");
  return strip(u.pathname) === strip(to);
}

async function checkPages() {
  for (const p of PAGES) {
    const r = await fetch(BASE + p.path + `?cb=${Date.now()}`, { redirect: "follow", headers: { "cache-control": "no-cache" } });
    const buf = Buffer.from(await r.arrayBuffer());
    const live = sha(buf);
    const repo = sha(deployedRef(p.file));
    rec(`page${p.path}:status`, r.status === 200, `http=${r.status} final=${new URL(r.url).pathname}`);
    rec(`page${p.path}:sha256`, live === repo, `live=${live.slice(0, 16)} repo=${repo.slice(0, 16)} bytes=${buf.length}`);
    const title = (buf.toString("utf8").match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    rec(`page${p.path}:title`, title === p.title, `title="${title}"`);
  }
}

async function checkRedirects() {
  for (const r0 of REDIRECTS) {
    const r = await fetch(BASE + r0.path, { redirect: "manual" });
    const loc = r.headers.get("location");
    rec(`redirect${r0.path}`, [301, 302, 307, 308].includes(r.status) && sameLocation(loc, BASE, r0.to), `http=${r.status} location=${loc ? new URL(loc, BASE).pathname : "-"}`);
  }
  const apex = await fetch("https://asalocal.club/", { redirect: "manual" });
  const aloc = apex.headers.get("location") || "";
  rec("canonical:apex->www", [301, 302, 307, 308].includes(apex.status) ? aloc.startsWith("https://www.asalocal.club") : null,
    `http=${apex.status} location=${aloc || "-"} (SKIP = apex serves directly, not a redirect)`);
}

async function checkAdminApi(anon) {
  // 1) CORS preflight from the allowed origin: reaches function code (OPTIONS bypasses JWT gate).
  let r = await fetch(FN, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,apikey,content-type" } });
  rec("admin-api:OPTIONS allowed origin -> 200 + ACAO", r.status === 200 && r.headers.get("access-control-allow-origin") === ORIGIN, `http=${r.status} acao=${r.headers.get("access-control-allow-origin")}`);
  // 2) Preflight from a foreign origin -> 403, no ACAO.
  r = await fetch(FN, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  rec("admin-api:OPTIONS foreign origin -> 403", r.status === 403 && !r.headers.get("access-control-allow-origin"), `http=${r.status}`);
  // 3) No JWT -> gateway 401 (verify_jwt=true).
  r = await fetch(FN, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ action: "counts" }) });
  rec("admin-api:POST no JWT -> 401", r.status === 401, `http=${r.status}`);
  if (!anon) { rec("admin-api:anon-key checks", null, "anon key not found on live page"); return; }
  const H = { Origin: ORIGIN, apikey: anon, Authorization: `Bearer ${anon}` };
  // 4) JSON action=media_upload -> function's own 415 (proves function code boots and runs).
  r = await fetch(FN, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ action: "media_upload" }) });
  let t = await r.text();
  rec("admin-api:JSON media_upload -> 415 unsupported_media_type", r.status === 415 && /unsupported_media_type/.test(t) && !STACK_RE.test(t), `http=${r.status} body=${t.slice(0, 80)}`);
  // 5) Unsupported content type -> 415.
  r = await fetch(FN, { method: "POST", headers: { ...H, "Content-Type": "text/plain" }, body: "x" });
  t = await r.text();
  rec("admin-api:text/plain -> 415", r.status === 415 && !STACK_RE.test(t), `http=${r.status} body=${t.slice(0, 80)}`);
  // 6) Anon role is not a user -> getUser fails -> 401 invalid_token (no RPC/storage reached).
  r = await fetch(FN, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ action: "counts" }) });
  t = await r.text();
  rec("admin-api:anon role counts -> 401 invalid_token", r.status === 401 && /invalid_token/.test(t) && !STACK_RE.test(t), `http=${r.status} body=${t.slice(0, 80)}`);
  // 7) Malformed multipart with anon role -> 401 before parse (no object created).
  r = await fetch(FN, { method: "POST", headers: { ...H, "Content-Type": "multipart/form-data; boundary=xx" }, body: "--xx\r\nbroken" });
  t = await r.text();
  rec("admin-api:malformed multipart (anon) -> 4xx, no stack", r.status >= 400 && r.status < 500 && !STACK_RE.test(t), `http=${r.status} body=${t.slice(0, 80)}`);
  // 8) Unknown action with anon role -> must not be 5xx.
  r = await fetch(FN, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ action: "nope" }) });
  t = await r.text();
  rec("admin-api:unknown action -> 400 unknown_action", r.status === 400 && /unknown_action/.test(t), `http=${r.status} body=${t.slice(0, 80)}`);
}

async function checkBrowser() {
  let pw;
  try { pw = await import("playwright"); } catch { rec("browser", null, "playwright not installed"); return; }
  const browser = await pw.chromium.launch();
  try {
    for (const vp of [{ name: "mobile390", width: 390, height: 844 }, { name: "desktop", width: 1366, height: 900 }]) {
      for (const p of PAGES) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        const consoleErrors = [];
        const badResponses = [];
        page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
        page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 160)}`));
        page.on("response", (res) => { if (res.status() >= 400) badResponses.push(`${res.status()} ${new URL(res.url()).host}${new URL(res.url()).pathname}`.slice(0, 160)); });
        await page.goto(BASE + p.path, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => consoleErrors.push(`goto: ${e.message.slice(0, 120)}`));
        await page.waitForTimeout(1500);
        const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1).catch(() => null);
        rec(`browser:${vp.name}${p.path}:console_errors=0`, consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | ") || "none");
        rec(`browser:${vp.name}${p.path}:no 4xx/5xx`, badResponses.length === 0, badResponses.slice(0, 5).join(" | ") || "none");
        rec(`browser:${vp.name}${p.path}:no horizontal scroll`, hScroll === false, `scrollWidth>innerWidth=${hScroll}`);
        await page.screenshot({ path: `live_${vp.name}_${p.path.replace(/[^a-z0-9]+/gi, "_")}.png`, fullPage: false }).catch(() => {});
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
}

function selftest() {
  // Fixture built at runtime so no JWT-shaped literal lives in the repo.
  const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const fake = [b64u({ alg: "HS256" }), b64u({ role: "anon" }), b64u("signature-value")].join(".");
  const ok = [
    extractAnonKey(`x"${fake}"y`) === fake,
    jwtRole(fake) === "anon",
    maskKey(fake).startsWith("eyJhbG…(") && !maskKey(fake).includes("c2ln"),
    sameLocation("/CDP3B/admin", "https://x", "/CDP3B/admin.html"),
    sameLocation("https://www.asalocal.club/kopenhag/", "https://x", "/kopenhag/"),
    !sameLocation("/", "https://x", "/kopenhag/"),
    STACK_RE.test("ReferenceError: X is not defined") && !STACK_RE.test('{"error":"unsupported_media_type"}'),
  ];
  console.log(JSON.stringify({ selftest: ok.every(Boolean) ? "PASS" : "FAIL", checks: ok }));
  process.exit(ok.every(Boolean) ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else {
  const home = await (await fetch(BASE + "/?cb=" + Date.now())).text();
  const anon = extractAnonKey(home);
  if (anon && process.env.GITHUB_ACTIONS) console.log(`::add-mask::${anon}`);
  rec("anon key found on live page (role=anon)", anon ? jwtRole(anon) === "anon" : false, `key=${maskKey(anon)} role=${anon ? jwtRole(anon) : "-"}`);
  for (const step of [checkPages, checkRedirects, () => checkAdminApi(anon), checkBrowser]) {
    try { await step(); } catch (e) { rec(`step-error:${step.name || "anon"}`, false, String(e && e.message).slice(0, 200)); }
  }
  const fail = results.filter((r) => r.result === "FAIL").length;
  const summary = { ran_at: new Date().toISOString(), base: BASE, total: results.length, pass: results.filter((r) => r.result === "PASS").length, fail, skip: results.filter((r) => r.result === "SKIP").length };
  console.log("LIVE_SMOKE_SUMMARY " + JSON.stringify(summary));
  for (const r of results) console.log(`${r.result.padEnd(4)} ${r.id} :: ${r.detail}`);
  process.exit(fail ? 1 : 0);
}
