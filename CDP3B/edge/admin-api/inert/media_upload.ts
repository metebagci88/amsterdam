// ASALOCAL · STORAGE_MEDIA_UPLOAD — reference helper.
// ChatGPT EVET B revision. Imported by ../index.ts (repo splice only).
// NOT production-deployed. Hosted admin-api stays on the pre-splice v16 text
// until a later deploy EVET, and that deploy is still blocked (§8).
//
// Default transport is multipart/form-data for media_upload only.
// Other admin actions stay application/json with MAX_BODY = 8KB.
// Base64 JSON is non-preferred and must not widen that global cap.
// service_role never appears in this module.

export const MEDIA_BUCKET = "media" as const;
export const UPLOAD_UPSERT = false as const;
export const MEDIA_CACHE_CONTROL = "3600" as const;
export const MAX_ASSET_BYTES = 5_000_000;
export const ADMIN_JSON_MAX_BODY = 8 * 1024;
export const TRANSPORT_DEFAULT = "multipart/form-data" as const;
export const JSON_PATH_ACCEPTS_MEDIA_UPLOAD = false as const;
/** Non-preferred. Not the v1 request contract. */
export const BASE64_PATH = "non_preferred" as const;

/** ~33% growth: 4 * ceil(n / 3). Early-reject cap if a base64 path is ever used. */
export const MAX_BASE64 = 4 * Math.ceil(MAX_ASSET_BYTES / 3);
export const MULTIPART_ENVELOPE_SLACK = 65_536;
export const MEDIA_MULTIPART_MAX = MAX_ASSET_BYTES + MULTIPART_ENVELOPE_SLACK;

export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaMime = (typeof ALLOWED_MIME)[number];

export const PREFIXES = ["venues", "ads"] as const;
export type MediaPrefix = (typeof PREFIXES)[number];

/**
 * Live public.admin_role labels (SELECT 2026-09-30, enumsortorder).
 * Contract labels only. Not a grant list and not a migration.
 */
export const ADMIN_ROLE_LABELS = [
  "super_admin",
  "content_editor",
  "venue_editor",
  "moderator",
  "support",
  "crm",
  "ads",
  "analyst",
] as const;

/**
 * Live public.admin_roles on 2026-09-30: GROUP BY role returned only
 * super_admin (n=1). Other labels had zero rows. Evidence, not a gate.
 * Assigning venue_editor or ads is out of scope for this package.
 */
export const OBSERVED_GRANTED_ROLES = ["super_admin"] as const;

/** Coarse ROLE_SETS entry. Prefix split is PREFIX_ROLES, not ANY_ADMIN. */
export const ROLE_UNION = ["super_admin", "venue_editor", "ads"] as const;

/**
 * Same pairs as live _can_edit_venues / _can_edit_ads.
 * content_editor, moderator, support, crm, and analyst are not included.
 */
export const PREFIX_ROLES: Record<MediaPrefix, readonly string[]> = {
  venues: ["super_admin", "venue_editor"],
  ads: ["super_admin", "ads"],
};

export const MEDIA_UPLOAD_LIMITS = { min: 10, day: 100 } as const;

/**
 * Multipart media_upload order. The JSON path is a different branch:
 * it keeps ADMIN_JSON_MAX_BODY and does not dispatch media_upload.
 * content_type_branch runs before either body read.
 */
export const GATE_SEQUENCE = [
  "cors",
  "method",
  "env_kill",
  "bearer",
  "content_type_branch",
  "multipart_length_cap",
  "get_user",
  "is_admin",
  "role_union",
  "parse_multipart",
  "prefix_role",
  "admin_api_status",
  "admin_writes_status",
  "admin_rate_check",
  "sniff",
  "storage_upload",
] as const;

const CLIENT_PATH_KEYS = [
  "bucket",
  "path",
  "object_path",
  "objectPath",
  "filename",
  "file_name",
  "fileName",
  "name",
  "key",
  "content_type",
  "contentType",
  "mime",
  "upsert",
  "cacheControl",
  "cache_control",
] as const;

const ALLOWED_PARTS = new Set(["action", "prefix", "file"]);
const TEXT_PART_MAX = 128;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type MediaErrorCode =
  | "bad_input"
  | "bad_prefix"
  | "client_path_rejected"
  | "unknown_field"
  | "bad_base64"
  | "bad_size"
  | "bad_mime_content"
  | "object_exists"
  | "upload_failed"
  | "internal"
  | "unsupported_media_type"
  | "unknown_action"
  | "payload_too_large";

export type TransportBranch = "multipart_media" | "json_admin" | "unsupported";

// Byte predicates copied from CDP3B/edge/email-api/index.ts sniffMime.
// GIF is detected so the media allowlist can reject it. b[3] of RIFF is not
// checked there; this copy keeps that predicate.
export function sniffMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function mediaMimeAllowed(mime: string | null): mime is MediaMime {
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp";
}

export function extForMime(mime: MediaMime): "jpg" | "png" | "webp" {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  return "webp";
}

/** Branch on Content-Type before any body read. Does not raise the JSON cap. */
export function contentTypeBranch(contentType: string | null): TransportBranch {
  const c = (contentType ?? "").toLowerCase();
  if (c.includes("multipart/form-data")) return "multipart_media";
  if (c.includes("application/json")) return "json_admin";
  return "unsupported";
}

export function classifyJsonBody(rawLength: number): "ok" | "too_large" {
  if (!Number.isSafeInteger(rawLength) || rawLength < 0) return "too_large";
  if (rawLength > ADMIN_JSON_MAX_BODY) return "too_large";
  return "ok";
}

/** JSON path: media_upload is not served here, even under 8KB. */
export function jsonMediaUploadRejected(): { status: 415; error: "unsupported_media_type" } {
  return { status: 415, error: "unsupported_media_type" };
}

/**
 * Early reject from the Content-Length header, before the body is read.
 * null means the header is absent: the read must still stop at MEDIA_MULTIPART_MAX.
 */
export function classifyMultipartContentLength(contentLength: number | null): "ok" | "missing" | "too_large" {
  if (contentLength === null) return "missing";
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) return "too_large";
  if (contentLength > MEDIA_MULTIPART_MAX) return "too_large";
  return "ok";
}

export function assertMultipartBufferedLength(len: number): "ok" | "too_large" {
  if (!Number.isSafeInteger(len) || len < 0 || len > MEDIA_MULTIPART_MAX) return "too_large";
  return "ok";
}

/**
 * Edge splice body read. Stops at max+1 bytes so the caller can tell an
 * exact-cap body from a larger one via assertMultipartBufferedLength.
 * Does not call req.text() (binary-unsafe) or an uncapped arrayBuffer().
 */
export async function readCapped(
  req: { body: ReadableStream<Uint8Array> | null },
  max: number,
): Promise<Uint8Array> {
  const overflow = MEDIA_MULTIPART_MAX + 1;
  if (!Number.isSafeInteger(max) || max < 0 || max > MEDIA_MULTIPART_MAX) {
    return new Uint8Array(overflow);
  }
  const limit = max + 1;
  const body = req.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const room = limit - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function base64DecodedLength(b64: string): number | null {
  if (b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/**
 * NON-PREFERRED base64 gate. Rejects on encoded length before atob.
 * Encoded cap is the ~33% expansion of MAX_ASSET_BYTES. Do not use this
 * to widen ADMIN_JSON_MAX_BODY.
 */
export function classifyBase64(b64: string): "bad_base64" | "bad_size" | null {
  if (b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return "bad_base64";
  if (b64.length > MAX_BASE64) return "bad_size";
  const n = base64DecodedLength(b64);
  if (n === null || n <= 0 || n > MAX_ASSET_BYTES) return "bad_size";
  return null;
}

export function prefixAllowedByRoles(prefix: MediaPrefix, held: ReadonlySet<string>): boolean {
  return PREFIX_ROLES[prefix].some((role) => held.has(role));
}

export function decodeBase64Strict(
  b64: string,
): { ok: true; bytes: Uint8Array } | { ok: false; error: "bad_base64" | "bad_size" } {
  const sized = classifyBase64(b64);
  if (sized) return { ok: false, error: sized };
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return { ok: false, error: "bad_base64" };
  }
  if (bin.length <= 0 || bin.length > MAX_ASSET_BYTES) return { ok: false, error: "bad_size" };
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { ok: true, bytes: out };
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0 || from < 0) return -1;
  const last = hay.length - needle.length;
  for (let i = from; i <= last; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function boundaryOf(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  const b = (m[1] ?? m[2] ?? "").trim();
  if (b.length < 1 || b.length > 200 || /[\r\n]/.test(b)) return null;
  return b;
}

function partName(headers: string): { name: string | null } {
  const line = headers.split("\r\n").find((row) => /^content-disposition:/i.test(row)) ?? "";
  const named = /(?:^|;)\s*name="([^"]*)"|name=([^;\s]+)/i.exec(line);
  const name = named ? (named[1] ?? named[2] ?? "") : "";
  return { name: name === "" ? null : name };
}

type RawPart = { name: string; content: Uint8Array };

function splitMultipart(body: Uint8Array, boundary: string): RawPart[] | null {
  const enc = new TextEncoder();
  const delim = enc.encode(`\r\n--${boundary}`);
  const first = enc.encode(`--${boundary}`);
  let pos = 0;
  if (indexOfBytes(body, first, 0) === 0) {
    pos = 0;
  } else {
    const at = indexOfBytes(body, delim, 0);
    if (at < 0) return null;
    pos = at + 2;
  }
  const parts: RawPart[] = [];
  const headerSep = enc.encode("\r\n\r\n");
  while (pos <= body.length) {
    if (indexOfBytes(body, first, pos) !== pos) return null;
    pos += first.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) return null;
    pos += 2;
    const headerEnd = indexOfBytes(body, headerSep, pos);
    if (headerEnd < 0) return null;
    const headers = new TextDecoder("utf-8").decode(body.subarray(pos, headerEnd));
    const contentStart = headerEnd + 4;
    const next = indexOfBytes(body, delim, contentStart);
    if (next < 0) return null;
    const name = partName(headers).name;
    if (!name) return null;
    parts.push({ name, content: body.slice(contentStart, next) });
    pos = next + 2;
  }
  return null;
}

export function parseMediaMultipart(
  contentType: string,
  body: Uint8Array,
):
  | { ok: true; action: "media_upload"; prefix: MediaPrefix; bytes: Uint8Array }
  | { ok: false; status: 400 | 413 | 415; error: MediaErrorCode } {
  if (contentTypeBranch(contentType) !== "multipart_media") {
    return { ok: false, status: 415, error: "unsupported_media_type" };
  }
  if (assertMultipartBufferedLength(body.length) === "too_large") {
    return { ok: false, status: 413, error: "payload_too_large" };
  }
  const boundary = boundaryOf(contentType);
  if (!boundary) return { ok: false, status: 400, error: "bad_input" };
  const parts = splitMultipart(body, boundary);
  if (!parts || parts.length === 0) return { ok: false, status: 400, error: "bad_input" };
  for (const part of parts) {
    if ((CLIENT_PATH_KEYS as readonly string[]).includes(part.name)) {
      return { ok: false, status: 400, error: "client_path_rejected" };
    }
    if (!ALLOWED_PARTS.has(part.name)) return { ok: false, status: 400, error: "unknown_field" };
  }
  const actions = parts.filter((p) => p.name === "action");
  const prefixes = parts.filter((p) => p.name === "prefix");
  const files = parts.filter((p) => p.name === "file");
  if (actions.length !== 1 || prefixes.length !== 1 || files.length !== 1) {
    return { ok: false, status: 400, error: "bad_input" };
  }
  if (actions[0].content.length > TEXT_PART_MAX || prefixes[0].content.length > TEXT_PART_MAX) {
    return { ok: false, status: 400, error: "bad_input" };
  }
  const action = new TextDecoder("utf-8").decode(actions[0].content);
  if (action !== "media_upload") return { ok: false, status: 415, error: "unsupported_media_type" };
  const prefix = new TextDecoder("utf-8").decode(prefixes[0].content);
  if (prefix !== "venues" && prefix !== "ads") return { ok: false, status: 400, error: "bad_prefix" };
  const bytes = files[0].content;
  if (bytes.length <= 0 || bytes.length > MAX_ASSET_BYTES) return { ok: false, status: 400, error: "bad_size" };
  return { ok: true, action: "media_upload", prefix, bytes };
}

export function buildObjectPath(prefix: MediaPrefix, mime: MediaMime, uuid: string): string {
  if (!UUID_RE.test(uuid)) throw new Error("bad_uuid");
  if (prefix !== "venues" && prefix !== "ads") throw new Error("bad_prefix");
  return `${prefix}/${uuid.toLowerCase()}.${extForMime(mime)}`;
}

export function publicMediaUrl(supabaseUrl: string, objectPath: string): string {
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error("bad_supabase_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad_supabase_url");
  if (url.username || url.password || url.search || url.hash) throw new Error("bad_supabase_url");
  if (url.pathname !== "" && url.pathname !== "/") throw new Error("bad_supabase_url");
  if (!/^(venues|ads)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/i.test(objectPath)) {
    throw new Error("bad_object_path");
  }
  return `${url.origin}/storage/v1/object/public/media/${objectPath}`;
}

export function isDuplicateStorageError(
  error: { message?: string; status?: number; statusCode?: number | string; error?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const name = typeof error.error === "string" ? error.error : "";
  const msg = typeof error.message === "string" ? error.message : "";
  if (name === "Duplicate") return true;
  return /already exists/i.test(msg) || /\bduplicate\b/i.test(msg);
}

export type StorageUploader = (args: {
  bucket: typeof MEDIA_BUCKET;
  path: string;
  bytes: Uint8Array;
  contentType: MediaMime;
  upsert: false;
  cacheControl: typeof MEDIA_CACHE_CONTROL;
}) => Promise<{
  error: { message?: string; status?: number; statusCode?: number | string; error?: string } | null;
  path?: string;
}>;

export async function planMediaUpload(input: {
  prefix: MediaPrefix;
  bytes: Uint8Array;
  supabaseUrl: string;
  newUuid: () => string;
  upload: StorageUploader;
}): Promise<
  | {
      ok: true;
      status: 200;
      data: { bucket: "media"; path: string; public_url: string; mime: MediaMime; bytes: number };
    }
  | { ok: false; status: 400 | 409 | 500; error: MediaErrorCode }
> {
  if (input.bytes.length <= 0 || input.bytes.length > MAX_ASSET_BYTES) {
    return { ok: false, status: 400, error: "bad_size" };
  }
  const mime = sniffMime(input.bytes);
  if (!mediaMimeAllowed(mime)) return { ok: false, status: 400, error: "bad_mime_content" };
  let objectPath: string;
  try {
    objectPath = buildObjectPath(input.prefix, mime, input.newUuid());
  } catch {
    return { ok: false, status: 500, error: "internal" };
  }
  let publicUrl: string;
  try {
    publicUrl = publicMediaUrl(input.supabaseUrl, objectPath);
  } catch {
    return { ok: false, status: 500, error: "internal" };
  }
  if (UPLOAD_UPSERT !== false) return { ok: false, status: 500, error: "internal" };
  const up = await input.upload({
    bucket: MEDIA_BUCKET,
    path: objectPath,
    bytes: input.bytes,
    contentType: mime,
    upsert: false,
    cacheControl: MEDIA_CACHE_CONTROL,
  });
  if (up.error) {
    if (isDuplicateStorageError(up.error)) return { ok: false, status: 409, error: "object_exists" };
    return { ok: false, status: 500, error: "upload_failed" };
  }
  if (up.path !== undefined && up.path !== objectPath) return { ok: false, status: 500, error: "upload_failed" };
  return {
    ok: true,
    status: 200,
    data: {
      bucket: MEDIA_BUCKET,
      path: objectPath,
      public_url: publicUrl,
      mime,
      bytes: input.bytes.length,
    },
  };
}

/** NON-PREFERRED. Encoded cap rejects before atob. Not wired to the JSON 8KB path. */
export async function planMediaUploadFromBase64(input: {
  prefix: MediaPrefix;
  dataBase64: string;
  supabaseUrl: string;
  newUuid: () => string;
  upload: StorageUploader;
}): Promise<Awaited<ReturnType<typeof planMediaUpload>>> {
  const decoded = decodeBase64Strict(input.dataBase64);
  if (!decoded.ok) return { ok: false, status: 400, error: decoded.error };
  return planMediaUpload({
    prefix: input.prefix,
    bytes: decoded.bytes,
    supabaseUrl: input.supabaseUrl,
    newUuid: input.newUuid,
    upload: input.upload,
  });
}
