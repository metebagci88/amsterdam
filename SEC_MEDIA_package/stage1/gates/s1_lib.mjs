// SEC-MEDIA · Stage 1 (İŞ PAKETİ 1) · ortak yardımcılar.
// Bu modül ağ çağrısı YAPMAZ. Secret DEĞERİ içermez; değerler yalnız çalışma anında
// env'den / canlı sayfadan bellek içine okunur ve hiçbir çıktıya yazılmaz.
// Shared helpers: redaction, masking, synthetic test images, URL/request classification,
// multipart build/parse, live admin.html static checks. No network, no secrets.
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GATES_DIR = dirname(fileURLToPath(import.meta.url));
export const STAGE1_DIR = resolve(GATES_DIR, "..");
export const REPO_ROOT = resolve(STAGE1_DIR, "..", "..");
export const DEFAULT_BASE_URL = "https://www.asalocal.club";
export const PROD_ORIGIN = "https://www.asalocal.club";
export const ALLOWED_PREFIX = "venues";
export const RESPONSE_DATA_KEYS = ["bucket", "bytes", "mime", "path", "public_url"];
export const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
export const nowIso = () => new Date().toISOString();
export const newRunId = () => `s1-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;

export function isMain(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

// ---------------------------------------------------------------- module loading
// Order: local node_modules (stage1/) → S1_NODE_MODULES dir → global npm root.
export async function loadModule(name) {
  try { return await import(name); } catch (_) { /* fall through */ }
  const dirs = [];
  if (process.env.S1_NODE_MODULES) dirs.push(process.env.S1_NODE_MODULES);
  try { dirs.push(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()); } catch (_) { /* no npm */ }
  for (const d of dirs) {
    try {
      const base = d.endsWith("node_modules") ? dirname(d) : d;
      const req = createRequire(join(base, "node_modules", "_s1_resolver.js"));
      return req(name);
    } catch (_) { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------- redaction / leak guard
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g;
const SB_KEY_RE = /\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /Bearer\s+[^\s"',;]+/gi;

export function makeRedactor(secretValues = []) {
  const vals = secretValues.filter((v) => typeof v === "string" && v.length >= 4).sort((a, b) => b.length - a.length);
  return function redact(input) {
    let s = typeof input === "string" ? input : JSON.stringify(input);
    if (s === undefined) return "";
    for (const v of vals) s = s.split(v).join("[REDACTED]");
    return s.replace(BEARER_RE, "Bearer [REDACTED]").replace(JWT_RE, "[JWT_REDACTED]").replace(SB_KEY_RE, "[KEY_REDACTED]").replace(EMAIL_RE, "[EMAIL_REDACTED]");
  };
}

/** Returns leak kinds found in text (never the values). */
export function findLeaks(text, secretValues = []) {
  const kinds = [];
  for (const v of secretValues) if (typeof v === "string" && v.length >= 4 && text.includes(v)) kinds.push("known_secret_value");
  if (new RegExp(JWT_RE.source).test(text)) kinds.push("jwt");
  if (new RegExp(SB_KEY_RE.source).test(text)) kinds.push("sb_key");
  if (new RegExp(EMAIL_RE.source).test(text)) kinds.push("email");
  if (/Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._-]{8,}/i.test(text)) kinds.push("bearer_value");
  return [...new Set(kinds)];
}

/** Serialize, refuse to write if anything secret-looking is inside.
 *  exclusive=true → create-only (flag "wx"): an existing file (evidence) is never overwritten; throws EEXIST. */
export function writeJsonGuarded(path, obj, secretValues = [], { exclusive = false } = {}) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  const leaks = findLeaks(text, secretValues);
  if (leaks.length) throw new Error(`output_leak_guard: refusing to write (${leaks.join(",")})`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, exclusive ? { flag: "wx" } : undefined);
  return text;
}

export function makeLogger(redact, quiet = false) {
  return (...a) => { if (!quiet) console.log(redact(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))); };
}

/** Response-body markers that must never reach a client (stack traces, internals, secrets). */
export function stackLeakMarkers(text) {
  const t = String(text ?? "");
  const rules = [
    ["stack_frame", /\bat\s+[\w$.<>]+\s*\(?(file|https?|ext|node|deno):/i],
    ["source_location", /\.(ts|js|mjs):\d+(:\d+)?/],
    ["error_class", /\b(TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|Exception):/],
    ["stack_word", /"stack"\s*:/i],
    ["jwt", /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
    ["sb_key", /sb_(secret|publishable)_/],
    ["service_role", /service_role/i],
    ["env_name", /SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)/],
    ["conn_string", /postgres(ql)?:\/\//i],
    ["deno_internal", /\bDeno\.|ext:core|ext:runtime/],
    ["sql_detail", /\b(pg_|PGRST\d|SQLSTATE|relation\s+"|violates)/],
  ];
  return rules.filter(([, re]) => re.test(t)).map(([k]) => k);
}

// ---------------------------------------------------------------- masking
export function maskObjectPath(p) {
  const m = /^([a-z]+)\/([0-9a-f]{8})[0-9a-f-]*(\.[a-z0-9]+)?$/i.exec(String(p ?? ""));
  if (!m) return "[unrecognized-path]";
  return `${m[1]}/${m[2].toLowerCase()}-****${m[3] ?? ""}`;
}
export function maskPublicUrl(u) {
  try {
    const url = new URL(u);
    const marker = "/storage/v1/object/public/media/";
    const i = url.pathname.indexOf(marker);
    if (i < 0) return `${url.origin}/[masked]`;
    return `${url.origin}${marker}${maskObjectPath(url.pathname.slice(i + marker.length))}`;
  } catch { return "[invalid-url]"; }
}
export const maskUuid = (u) => (typeof u === "string" && u.length >= 8 ? `${u.slice(0, 8)}-****` : "[none]");

// ---------------------------------------------------------------- JWT / anon key classification
export function decodeJwtPayload(tok) {
  if (typeof tok !== "string") return null;
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return null; }
}
/** Never returns the key. kind: anon_jwt | publishable | service_role_jwt(!) | other_jwt | unknown */
export function classifyPublicKey(key) {
  if (typeof key !== "string" || key.length < 20) return { kind: "unknown", ok: false };
  if (key.startsWith("sb_publishable_")) return { kind: "publishable", ok: true };
  if (key.startsWith("sb_secret_")) return { kind: "secret_key", ok: false };
  const p = decodeJwtPayload(key);
  if (!p) return { kind: "unknown", ok: false };
  if (p.role === "anon") return { kind: "anon_jwt", ok: true, ref: typeof p.ref === "string" ? p.ref : null };
  if (p.role === "service_role") return { kind: "service_role_jwt", ok: false };
  return { kind: "other_jwt", ok: false };
}

// ---------------------------------------------------------------- live admin.html discovery + static checks
export function discoverConfig(html) {
  const m = /const\s+CFG\s*=\s*\{\s*url\s*:\s*"([^"]+)"\s*,\s*key\s*:\s*"([^"]+)"\s*\}/.exec(html);
  if (!m) return { ok: false, error: "cfg_not_found" };
  let origin;
  try { origin = new URL(m[1]).origin; } catch { return { ok: false, error: "cfg_url_invalid" }; }
  if (origin !== m[1].replace(/\/$/, "")) return { ok: false, error: "cfg_url_has_path" };
  const fnDecl = /const\s+FN_URL\s*=\s*CFG\.url\s*\+\s*"\/functions\/v1\/admin-api"\s*;/.test(html);
  return { ok: true, supabaseUrl: origin, anonKey: m[2], fnUrl: `${origin}/functions/v1/admin-api`, fnDecl, key: classifyPublicKey(m[2]) };
}

export function extractFunctionSource(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return null;
  const b = src.indexOf("{", i + sig.length - 1);
  let d = 0;
  for (let j = b; j < src.length; j++) {
    const c = src[j];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return src.slice(i, j + 1); }
  }
  return null;
}

/** Static checks over the LIVE admin page source. Returns [{id,name,ok,detail}]. */
export function staticCheckAdminHtml(html) {
  const out = [];
  const add = (id, name, ok, detail) => out.push({ id, name, ok: !!ok, detail: detail ?? null });
  const up = extractFunctionSource(html, "async function uploadToMedia(file, prefix){");
  add("S01", "uploadToMedia var", !!up);
  const body = up ?? "";
  add("S02", "sayfada storage.from( yok (doğrudan Storage fallback yok)", !/storage\s*\.\s*from\s*\(/.test(html));
  add("S03", "sayfada /storage/v1/object/media (doğrudan yazma URL'si) yok", !/\/storage\/v1\/object\/media\b/.test(html));
  add("S04", "uploadToMedia admin-api FN_URL'e POST eder", /fetch\(\s*FN_URL\s*,\s*\{\s*method\s*:\s*"POST"/.test(body));
  const fetchCall = /fetch\(\s*FN_URL\s*,\s*\{([\s\S]*?)body\s*:\s*fd\s*\}\s*\)/.exec(body);
  const hdr = fetchCall ? fetchCall[1] : "";
  add("S05", "upload fetch'inde Content-Type elle set edilmiyor", !!fetchCall && !/content-type/i.test(hdr));
  add("S06", "upload fetch'inde Authorization başlığı oturumun access_token'ı (Bearer şeması)", /"Authorization"\s*:\s*"Bearer "\s*\+\s*session\.access_token/.test(hdr));
  const appends = [...body.matchAll(/fd\.append\(\s*"([^"]+)"/g)].map((m) => m[1]);
  add("S07", "FormData alanları yalnız action/prefix/file", JSON.stringify(appends) === JSON.stringify(["action", "prefix", "file"]), appends.join(","));
  add("S08", "action=media_upload", /fd\.append\(\s*"action"\s*,\s*"media_upload"\s*\)/.test(body));
  const guardIdx = body.search(/if\(prefix!=="venues"&&prefix!=="ads"\)\{[^}]*throw/);
  const fetchIdx = body.indexOf("fetch(");
  add("S09", "istemci prefix guard fetch'ten önce", guardIdx >= 0 && fetchIdx > guardIdx);
  const dFields = [...new Set([...body.matchAll(/\bd\.([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  add("S10", "yanıttan yalnız d.public_url tüketiliyor", dFields.length === 1 && dFields[0] === "public_url" && /return\s+d\.public_url\s*;/.test(body), dFields.join(","));
  add("S11", "upload yolunda storage/upload( çağrısı yok", !/\.upload\s*\(/.test(body));
  add("S12", "venuePhotoUpload → uploadToMedia(file,\"venues\")", /async function venuePhotoUpload\(ev\)\{[^\n]*uploadToMedia\(file,"venues"\)/.test(html));
  add("S13", "venues formunda dosya input'u venuePhotoUpload'a bağlı", /<input type="file"[^>]*onchange="venuePhotoUpload\(event\)"/.test(html));
  return out;
}

// ---------------------------------------------------------------- request / URL classification
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function classifyRequest(rawUrl, method, supabaseOrigin) {
  let u;
  try { u = new URL(rawUrl); } catch { return { kind: "invalid" }; }
  const m = String(method || "GET").toUpperCase();
  if (u.origin !== supabaseOrigin) return { kind: "external", origin: u.origin };
  const p = u.pathname;
  if (p === "/functions/v1/admin-api") return { kind: m === "OPTIONS" ? "admin_api_preflight" : "admin_api" };
  if (p.startsWith("/functions/v1/")) return { kind: "other_function" };
  if (p.startsWith("/storage/v1/")) {
    const touchesMedia = /^\/storage\/v1\/(object|upload\/resumable)(\/(public|authenticated|sign|info|list|move|copy))?\/media(\/|$)/.test(p) || p.startsWith("/storage/v1/upload/resumable");
    if (READ_METHODS.has(m)) return { kind: p.startsWith("/storage/v1/object/public/") ? "storage_public_read" : "storage_read", touchesMedia };
    if (p.startsWith("/storage/v1/object/list/") || p.startsWith("/storage/v1/object/sign/")) return { kind: "storage_read", touchesMedia };
    return { kind: "storage_write", touchesMedia };
  }
  if (p.startsWith("/rest/v1/rpc/")) return { kind: "rest_rpc" };
  if (p.startsWith("/rest/v1/")) return { kind: READ_METHODS.has(m) ? "rest_read" : "rest_write", table: p.slice("/rest/v1/".length).split("/")[0] };
  if (p.startsWith("/auth/v1/")) return { kind: "auth" };
  return { kind: "other_supabase" };
}

/** Validates the server-returned public URL. Never needs network. */
export function validatePublicUrl(publicUrl, { supabaseOrigin, prefix = ALLOWED_PREFIX, ext = "png", clientFileStem = null, dataPath = null }) {
  const errors = [];
  let u;
  try { u = new URL(publicUrl); } catch { return { ok: false, errors: ["not_a_url"], objectPath: null }; }
  if (u.protocol !== "https:") errors.push("not_https");
  if (u.origin !== supabaseOrigin) errors.push("origin_mismatch");
  if (!/^[a-z0-9]{20}\.supabase\.co$/.test(u.hostname)) errors.push("host_not_supabase_project");
  if (u.username || u.password) errors.push("userinfo_present");
  if (u.search) errors.push("query_present");
  if (u.hash) errors.push("hash_present");
  const marker = "/storage/v1/object/public/media/";
  if (!u.pathname.startsWith(marker)) errors.push("not_public_media_bucket_path");
  const objectPath = u.pathname.startsWith(marker) ? decodeURIComponent(u.pathname.slice(marker.length)) : null;
  const re = new RegExp(`^${prefix}/${UUID_V4}\\.${ext}$`);
  if (!objectPath || !re.test(objectPath)) errors.push("path_not_server_uuid_under_prefix");
  if (objectPath && /\.\.|\/\/|%2f/i.test(objectPath)) errors.push("path_traversal_marker");
  if (clientFileStem && objectPath && objectPath.toLowerCase().includes(clientFileStem.toLowerCase())) errors.push("client_filename_in_path");
  if (dataPath !== null && objectPath !== dataPath) errors.push("data_path_mismatch");
  return { ok: errors.length === 0, errors, objectPath };
}

// ---------------------------------------------------------------- multipart
export function parseMultipart(contentType, buf) {
  const bm = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ""));
  if (!bm) return { ok: false, error: "no_boundary" };
  const boundary = bm[1] ?? bm[2];
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delim);
  if (pos !== 0) return { ok: false, error: "no_leading_delimiter", boundary };
  for (;;) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return { ok: true, boundary, parts };
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) return { ok: false, error: "bad_delimiter_line", boundary };
    pos += 2;
    const he = body.indexOf("\r\n\r\n", pos);
    if (he < 0) return { ok: false, error: "no_header_end", boundary };
    const headers = body.subarray(pos, he).toString("utf8");
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), he + 4);
    if (next < 0) return { ok: false, error: "no_next_delimiter", boundary };
    const cd = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers);
    const name = cd && /\bname="([^"]*)"/i.exec(cd[1]);
    const filename = cd && /\bfilename="([^"]*)"/i.exec(cd[1]);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({ name: name ? name[1] : null, filename: filename ? filename[1] : null, contentType: ct ? ct[1].trim() : null, data: body.subarray(he + 4, next) });
    pos = next + 2;
  }
}

/** parts: [{name, value?:string, data?:Buffer, filename?, contentType?}] */
export function buildMultipart(parts, boundary, { close = true } = {}) {
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += "\r\n";
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += "\r\n";
    chunks.push(Buffer.from(head, "utf8"), p.data ?? Buffer.from(String(p.value ?? ""), "utf8"), Buffer.from("\r\n"));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
export const newBoundary = () => `----s1NegBoundary${Math.random().toString(16).slice(2, 14)}`;

// ---------------------------------------------------------------- synthetic images
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Synthetic, copyright-free, no personal data. Diagonal stripes + gradient. Labeled in tEXt. */
export function makeTestPng({ width = 96, height = 96, label = "ASALOCAL SEC-MEDIA S1 acceptance test image; synthetic; no personal data" } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      const stripe = ((x + y) >> 3) & 1;
      raw[o] = stripe ? 0xe8 : 0x2b;
      raw[o + 1] = stripe ? 0x6a : Math.round((x / width) * 200) + 30;
      raw[o + 2] = stripe ? 0x2c : Math.round((y / height) * 200) + 40;
    }
  }
  const text = Buffer.from(`Comment\0${label}`, "latin1");
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("tEXt", text), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

export function inspectPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, error: "bad_signature" };
  let pos = 8; const chunks = []; let crcOk = true; let width = 0, height = 0, text = null; const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    const data = buf.subarray(pos + 8, pos + 8 + len); const crc = buf.readUInt32BE(pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== crc) crcOk = false;
    chunks.push(type);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === "tEXt") text = data.toString("latin1").replace("\0", ": ");
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
    if (type === "IEND") break;
  }
  let rawOk = false;
  try { rawOk = inflateSync(Buffer.concat(idat)).length === (width * 3 + 1) * height; } catch { rawOk = false; }
  return { ok: crcOk && rawOk && chunks[0] === "IHDR" && chunks.at(-1) === "IEND", width, height, chunks, crcOk, rawOk, text, bytes: buf.length };
}

/** 1x1 GIF89a. Server sniff (media_upload.ts sniffMime) classifies it image/gif → NOT allowed → can never be stored. */
export function makeGifCanary() {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
}

/** Local mirror of media_upload.ts sniffMime predicate (selftest cross-checks it against the real module). */
export function sniffMimeLocal(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// ---------------------------------------------------------------- env / base URL
export function resolveBaseUrl(raw) {
  const v = (raw && raw.trim()) || DEFAULT_BASE_URL;
  let u;
  try { u = new URL(v); } catch { return { ok: false, error: "base_url_invalid" }; }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(loopback && u.protocol === "http:")) return { ok: false, error: "base_url_not_https" };
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return { ok: false, error: "base_url_must_be_origin" };
  return { ok: true, origin: u.origin, isProd: u.origin === PROD_ORIGIN, loopback };
}

export function defaultOutDir() {
  const d = process.env.S1_OUT_DIR ? resolve(process.env.S1_OUT_DIR) : join(STAGE1_DIR, "out");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

// ---------------------------------------------------------------- tiny test harness for --selftest
export function makeChecker(label) {
  let pass = 0, fail = 0; const fails = [];
  return {
    ok(cond, msg) { if (cond) pass++; else { fail++; fails.push(msg); console.log(`  FAIL ${label}: ${msg}`); } },
    done() { console.log(`${label}: pass=${pass} fail=${fail}`); return { pass, fail, fails }; },
  };
}
