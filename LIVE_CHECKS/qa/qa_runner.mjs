// ASALOCAL · QA runner helpers (GitHub Actions side of the hash handshake)
//
// Purpose: run live admin/member acceptance tests with DEDICATED, LABELLED test
// accounts without any human password and without any secret leaving the runner.
//   gen          random passwords live only in $RUNNER_TEMP/qa_secrets.env (0600, masked);
//                only their bcrypt hashes are published (qa_signals/<run>/hashes.json).
//                The operator writes those hashes to the test accounts via SQL.
//   wait-login   poll password sign-in until the operator has installed the hashes.
//   signal NAME  publish a sanitized step file qa_signals/<run>/r_<NAME>.json (+ push).
//   wait NAME    block until the operator pushes qa_signals/<run>/go_<NAME>.
//   cleanup      delete the one Stage-1 test object via the temporary qa-media-cleanup
//                Edge function (service-role inside the function; restricted to the
//                qa-admin user, venues/<uuid> paths and objects < 3h old).
//   s2-http      Stage 2 production HTTP acceptance (after S2 apply).
//
// Never prints passwords, tokens or keys. Exit: 0 ok, 1 fail, 2 usage, 3 timeout.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const BASE = (process.env.ASALOCAL_BASE_URL || "https://www.asalocal.club").replace(/\/+$/, "");
const ORIGIN = "https://www.asalocal.club";
const SUPA = "https://tosqsabuaomgqjtogdrn.supabase.co";
const FN = `${SUPA}/functions/v1/admin-api`;
const CLEANUP_FN = `${SUPA}/functions/v1/qa-media-cleanup`;
const BRANCH = process.env.QA_BRANCH || "cdp3b-asset-preview-2y4qmd";
const RUN = process.env.GITHUB_RUN_ID || "local";
const SIG_DIR = join("qa_signals", RUN);
const SECRETS = join(process.env.RUNNER_TEMP || "/tmp", "qa_secrets.env");
const STACK_RE = /\bat\s+\S+\s+\(|file:\/\/|\/var\/tmp\/|ReferenceError|TypeError|service_role|SUPABASE_SERVICE|eyJ[A-Za-z0-9_-]{10,}\./i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o));

export function extractAnonKey(html) {
  const m = html.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  return m ? m[0] : null;
}
async function anonKey() {
  const k = extractAnonKey(await (await fetch(`${BASE}/?cb=${Date.now()}`)).text());
  if (!k) throw new Error("anon key not found on live page");
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${k}`);
  return k;
}
function readSecrets() {
  const out = {};
  for (const line of readFileSync(SECRETS, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
function git(...args) { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function publish(relFiles, msg) {
  git("config", "user.name", "asalocal-qa-runner");
  git("config", "user.email", "qa-runner@users.noreply.github.com");
  git("add", ...relFiles);
  git("commit", "-q", "-m", msg);
  for (let i = 0; i < 5; i++) {
    try { git("pull", "-q", "--rebase", "origin", BRANCH); git("push", "-q", "origin", `HEAD:${BRANCH}`); return; }
    catch (e) { if (i === 4) throw e; execFileSync("sleep", [String(2 ** (i + 1))]); }
  }
}
export function sanitize(obj) {
  const s = JSON.stringify(obj);
  if (STACK_RE.test(s)) throw new Error("refusing to publish: sanitized check found token/stack-like content");
  return s;
}

async function signIn(apikey, email, password) {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (r.status !== 200) return { ok: false, status: r.status };
  const j = await r.json();
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${j.access_token}`);
  return { ok: true, token: j.access_token, user_id: j.user?.id ?? null };
}
async function signOut(apikey, token) {
  await fetch(`${SUPA}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey, Authorization: `Bearer ${token}` } }).catch(() => {});
}

async function cmdGen() {
  const require = createRequire(join(process.env.QA_DEPS || process.cwd(), "noop.js"));
  const bcrypt = require("bcryptjs");
  const admin = randomBytes(32).toString("base64url");
  const member = randomBytes(32).toString("base64url");
  if (process.env.GITHUB_ACTIONS) { console.log(`::add-mask::${admin}`); console.log(`::add-mask::${member}`); }
  writeFileSync(SECRETS, `ASALOCAL_ADMIN_PASSWORD=${admin}\nASALOCAL_MEMBER_PASSWORD=${member}\n`, { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
  const hashes = { run_id: RUN, created_at: new Date().toISOString(), cost: 10,
    admin_hash: bcrypt.hashSync(admin, 10), member_hash: bcrypt.hashSync(member, 10) };
  mkdirSync(SIG_DIR, { recursive: true });
  writeFileSync(join(SIG_DIR, "hashes.json"), JSON.stringify(hashes, null, 2) + "\n");
  publish([join(SIG_DIR, "hashes.json")], `qa ${RUN}: bcrypt hashes for test accounts (no secrets)`);
  log({ step: "gen", run_id: RUN, published: join(SIG_DIR, "hashes.json") });
}

async function cmdWaitLogin() {
  const k = await anonKey(); const s = readSecrets();
  const deadline = Date.now() + 90 * 60 * 1000;
  for (const [who, email, pw] of [["admin", process.env.ASALOCAL_ADMIN_EMAIL, s.ASALOCAL_ADMIN_PASSWORD], ["member", process.env.ASALOCAL_MEMBER_EMAIL, s.ASALOCAL_MEMBER_PASSWORD]]) {
    for (;;) {
      const r = await signIn(k, email, pw);
      if (r.ok) { await signOut(k, r.token); log({ step: "wait-login", who, result: "login_ok" }); break; }
      if (Date.now() > deadline) { log({ step: "wait-login", who, result: "timeout", last_status: r.status }); process.exit(3); }
      await sleep(45000);
    }
  }
}

function cmdSignal(name, files) {
  mkdirSync(SIG_DIR, { recursive: true });
  const body = { run_id: RUN, step: name, at: new Date().toISOString(), results: {} };
  for (const f of files) if (existsSync(f)) body.results[f.split("/").pop()] = JSON.parse(readFileSync(f, "utf8"));
  const p = join(SIG_DIR, `r_${name}.json`);
  writeFileSync(p, sanitize(body) + "\n");
  publish([p], `qa ${RUN}: step ${name}`);
  log({ step: "signal", name, files: Object.keys(body.results) });
}

async function cmdWait(name) {
  const deadline = Date.now() + 60 * 60 * 1000;
  const p = `${SIG_DIR}/go_${name}`;
  const abort = `${SIG_DIR}/abort`;
  for (;;) {
    try { git("fetch", "-q", "origin", BRANCH); } catch { /* transient */ }
    try { git("cat-file", "-e", `FETCH_HEAD:${abort}`); log({ step: "wait", name, result: "abort_by_operator" }); process.exit(3); } catch { /* no abort */ }
    try { git("cat-file", "-e", `FETCH_HEAD:${p}`); log({ step: "wait", name, result: "go" }); return; } catch { /* not yet */ }
    if (Date.now() > deadline) { log({ step: "wait", name, result: "timeout" }); process.exit(3); }
    await sleep(20000);
  }
}

async function cmdCleanup(refFile) {
  const ref = JSON.parse(readFileSync(refFile, "utf8"));
  const path = ref.path || ref.object?.path;
  if (typeof path !== "string") { log({ step: "cleanup", result: "no_path_in_ref" }); process.exit(1); }
  const k = await anonKey(); const s = readSecrets();
  const a = await signIn(k, process.env.ASALOCAL_ADMIN_EMAIL, s.ASALOCAL_ADMIN_PASSWORD);
  if (!a.ok) { log({ step: "cleanup", result: "admin_login_failed", status: a.status }); process.exit(1); }
  const r = await fetch(CLEANUP_FN, { method: "POST", headers: { apikey: k, Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  const t = await r.text();
  await signOut(k, a.token);
  const pass = r.status === 200 && /"removed":1/.test(t);
  log({ step: "cleanup", http: r.status, body: t.slice(0, 80), path_sha256: createHash("sha256").update(path).digest("hex"), result: pass ? "PASS" : "FAIL" });
  writeFileSync(join(process.env.S1_OUT_DIR || ".", "qa_cleanup_result.json"), JSON.stringify({ http: r.status, removed_one: pass, path_sha256: createHash("sha256").update(path).digest("hex") }) + "\n");
  process.exit(pass ? 0 : 1);
}

// 1x1 PNG (synthetic, no personal data), made unique per call so uploads never collide.
function tinyPng(tag) {
  const base = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const iend = base.length - 12; // keep IEND last; insert a tEXt chunk before it
  const text = Buffer.from(`asalocal-qa\0${tag}`, "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(text.length);
  const typ = Buffer.from("tEXt");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typ, text])) >>> 0);
  return Buffer.concat([base.subarray(0, iend), len, typ, text, crc, base.subarray(iend)]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return crc ^ 0xffffffff;
}

async function cmdS2Http() {
  const out = []; const rec = (id, pass, detail) => out.push({ id, result: pass ? "PASS" : "FAIL", detail });
  const k = await anonKey(); const s = readSecrets();
  const adm = await signIn(k, process.env.ASALOCAL_ADMIN_EMAIL, s.ASALOCAL_ADMIN_PASSWORD);
  const mem = await signIn(k, process.env.ASALOCAL_MEMBER_EMAIL, s.ASALOCAL_MEMBER_PASSWORD);
  rec("login admin+member", adm.ok && mem.ok, `admin=${adm.ok} member=${mem.ok}`);
  if (!adm.ok || !mem.ok) return finishS2(out);
  const objUrl = (p) => `${SUPA}/storage/v1/object/media/${p}`;
  const pubUrl = (p) => `${SUPA}/storage/v1/object/public/media/${p}`;
  const probe = `venues/${randomUUID()}.png`;
  // 1-2) direct Storage INSERT as anon and as authenticated member must be denied.
  for (const [who, bearer] of [["anon", k], ["member", mem.token]]) {
    const r = await fetch(objUrl(probe), { method: "POST", headers: { apikey: k, Authorization: `Bearer ${bearer}`, "Content-Type": "image/png", "x-upsert": "false" }, body: tinyPng(`s2-${who}-insert`) });
    const t = await r.text();
    rec(`direct INSERT as ${who} denied`, r.status >= 400 && r.status < 500 && !STACK_RE.test(t), `http=${r.status}`);
  }
  let g = await fetch(pubUrl(probe) + `?cb=${Date.now()}`);
  rec("denied INSERT left no object", g.status >= 400, `public GET http=${g.status}`);
  // 3) admin Edge media_upload must still work.
  const fd = new FormData(); fd.append("action", "media_upload"); fd.append("prefix", "venues");
  const png = tinyPng(`s2-admin-${RUN}`); fd.append("file", new Blob([png], { type: "image/png" }), "qa.png");
  const up = await fetch(FN, { method: "POST", headers: { Origin: ORIGIN, apikey: k, Authorization: `Bearer ${adm.token}` }, body: fd });
  const uj = await up.json().catch(() => ({}));
  const path = uj?.data?.path; const pub = uj?.data?.public_url;
  rec("admin Edge media_upload 200", up.status === 200 && typeof path === "string" && /^venues\/[0-9a-f-]{36}\.png$/.test(path) && typeof pub === "string" && pub.startsWith(`${SUPA}/storage/v1/object/public/media/`), `http=${up.status} path=${path ? path.slice(0, 15) + "****" : "-"}`);
  if (typeof path === "string") {
    g = await fetch(pub + `?cb=${Date.now()}`); const gb = Buffer.from(await g.arrayBuffer());
    rec("public read of admin upload 200 + bytes equal", g.status === 200 && (g.headers.get("content-type") || "").startsWith("image/png") && gb.equals(png), `http=${g.status} ct=${g.headers.get("content-type")}`);
    // 4-6) overwrite / upsert / delete by anon and member must not change anything.
    for (const [who, bearer] of [["anon", k], ["member", mem.token]]) {
      let r = await fetch(objUrl(path), { method: "PUT", headers: { apikey: k, Authorization: `Bearer ${bearer}`, "Content-Type": "image/png" }, body: tinyPng(`s2-${who}-put`) });
      rec(`direct UPDATE(PUT) as ${who} denied`, r.status >= 400 && r.status < 500, `http=${r.status}`); await r.text();
      r = await fetch(objUrl(path), { method: "POST", headers: { apikey: k, Authorization: `Bearer ${bearer}`, "Content-Type": "image/png", "x-upsert": "true" }, body: tinyPng(`s2-${who}-upsert`) });
      rec(`direct upsert as ${who} denied`, r.status >= 400 && r.status < 500, `http=${r.status}`); await r.text();
      r = await fetch(`${SUPA}/storage/v1/object/media`, { method: "DELETE", headers: { apikey: k, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [path] }) });
      const dt = await r.text(); let deleted = 0; try { const dj = JSON.parse(dt); deleted = Array.isArray(dj) ? dj.length : 0; } catch {}
      rec(`direct DELETE as ${who} removed nothing`, deleted === 0, `http=${r.status} deleted=${deleted}`);
    }
    g = await fetch(pub + `?cb=${Date.now()}x`); const gb2 = Buffer.from(await g.arrayBuffer());
    rec("object unchanged after denied writes", g.status === 200 && gb2.equals(png), `http=${g.status}`);
  }
  // 7) member Edge media_upload must be 403.
  const fd2 = new FormData(); fd2.append("action", "media_upload"); fd2.append("prefix", "venues");
  fd2.append("file", new Blob([tinyPng("s2-member-edge")], { type: "image/png" }), "qa.png");
  const mu = await fetch(FN, { method: "POST", headers: { Origin: ORIGIN, apikey: k, Authorization: `Bearer ${mem.token}` }, body: fd2 });
  const mt = await mu.text();
  rec("member Edge media_upload 403", mu.status === 403 && !STACK_RE.test(mt), `http=${mu.status} body=${mt.slice(0, 40)}`);
  // 8) cleanup of the admin upload through the temporary service-side function.
  if (typeof path === "string") {
    const c = await fetch(CLEANUP_FN, { method: "POST", headers: { apikey: k, Authorization: `Bearer ${adm.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    const ct = await c.text();
    rec("cleanup of S2 admin upload (removed 1)", c.status === 200 && /"removed":1/.test(ct), `http=${c.status}`);
    out.push({ id: "s2_object_path_sha256", result: "INFO", detail: createHash("sha256").update(path).digest("hex") });
  }
  await signOut(k, adm.token); await signOut(k, mem.token);
  return finishS2(out);
}
function finishS2(out) {
  const fail = out.filter((r) => r.result === "FAIL").length;
  const res = { verdict: fail ? "FAIL" : "PASS", pass: out.filter((r) => r.result === "PASS").length, fail, checks: out };
  writeFileSync(join(process.env.S1_OUT_DIR || ".", "s2_http_result.json"), JSON.stringify(res, null, 2) + "\n");
  for (const r of out) log(`${r.result.padEnd(4)} ${r.id} :: ${r.detail}`);
  log({ step: "s2-http", verdict: res.verdict, pass: res.pass, fail });
  process.exit(fail ? 1 : 0);
}

function selftest() {
  const png = tinyPng("x");
  const ok = [
    png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    png.subarray(png.length - 12, png.length - 8).readUInt32BE() === 0 && png.subarray(png.length - 8, png.length - 4).toString() === "IEND",
    !tinyPng("a").equals(tinyPng("b")),
    crc32(Buffer.from("IEND")) >>> 0 === 0xae426082,
    (() => { try { sanitize({ a: "eyJabcdefghijkl.mnopqrstuvwxyz.x" }); return false; } catch { return true; } })(),
    sanitize({ ok: 1 }) === '{"ok":1}',
  ];
  log({ selftest: ok.every(Boolean) ? "PASS" : "FAIL", checks: ok });
  process.exit(ok.every(Boolean) ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { gen: cmdGen, "wait-login": cmdWaitLogin, signal: () => cmdSignal(rest[0], rest.slice(1)), wait: () => cmdWait(rest[0]), cleanup: () => cmdCleanup(rest[0]), "s2-http": cmdS2Http, selftest };
if (!cmds[cmd]) { console.error("usage: qa_runner.mjs gen|wait-login|signal NAME [files..]|wait NAME|cleanup REF.json|s2-http|selftest"); process.exit(2); }
await cmds[cmd]();
