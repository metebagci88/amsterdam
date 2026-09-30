// ASALOCAL · STORAGE_MEDIA_UPLOAD_DESIGN — INERT reference helper.
//
// NOT imported by ../index.ts. NOT deployed. Merging this file does not
// change admin-api. The future STORAGE_MEDIA_UPLOAD_EDGE splice is specified
// in ../MEDIA_UPLOAD_DESIGN.md and is a separate EVET.
//
// Mirrors email-api sniffMime (magic bytes). Media allowlist is JPEG, PNG,
// and WebP only. GIF is recognized and then rejected. service_role never
// appears in this module.

export const MEDIA_BUCKET = "media" as const;
export const UPLOAD_UPSERT = false as const;
export const MEDIA_CACHE_CONTROL = "3600" as const;
export const MAX_ASSET_BYTES = 5_000_000;
export const ADMIN_JSON_MAX_BODY = 8 * 1024;
export const MEDIA_ENVELOPE_SLACK = 1024;
export const MAX_BASE64 = 4 * Math.ceil(MAX_ASSET_BYTES / 3);
export const MEDIA_MAX_RAW = MAX_BASE64 + MEDIA_ENVELOPE_SLACK;

export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaMime = (typeof ALLOWED_MIME)[number];

export const PREFIXES = ["venues", "ads"] as const;
export type MediaPrefix = (typeof PREFIXES)[number];

/** Coarse ROLE_SETS entry. Prefix split is PREFIX_ROLES, not ANY_ADMIN. */
export const ROLE_UNION = ["super_admin", "venue_editor", "ads"] as const;

/**
 * Same pairs as live _can_edit_venues / _can_edit_ads (active admin + role).
 * content_editor, moderator, support, crm, and analyst are not included.
 */
export const PREFIX_ROLES: Record<MediaPrefix, readonly string[]> = {
  venues: ["super_admin", "venue_editor"],
  ads: ["super_admin", "ads"],
};

export const MEDIA_UPLOAD_LIMITS = { min: 10, day: 100 } as const;

/** Locked handler order for the future splice. Not executed here. */
export const GATE_SEQUENCE = [
  "cors",
  "method",
  "env_kill",
  "bearer",
  "content_type",
  "body_limit",
  "json_action",
  "get_user",
  "is_admin",
  "role_union",
  "validate_params",
  "prefix_role",
  "admin_api_status",
  "admin_writes_status",
  "admin_rate_check",
  "decode_sniff",
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ACTION_HEAD_RE = /^\s*\{\s*"action"\s*:\s*"media_upload"\s*[,}]/;

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
  | "internal";

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

export function classifyRawBody(rawLength: number, head: string): "small" | "media" | "too_large" {
  if (!Number.isSafeInteger(rawLength) || rawLength < 0) return "too_large";
  if (rawLength <= ADMIN_JSON_MAX_BODY) return "small";
  if (rawLength > MEDIA_MAX_RAW) return "too_large";
  if (ACTION_HEAD_RE.test(head.slice(0, 128))) return "media";
  return "too_large";
}

export function base64DecodedLength(b64: string): number | null {
  if (b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** Cheap checks only. Does not allocate the decoded buffer. */
export function classifyBase64(b64: string): "bad_base64" | "bad_size" | null {
  if (b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return "bad_base64";
  if (b64.length > MAX_BASE64) return "bad_size";
  const n = base64DecodedLength(b64);
  if (n === null || n <= 0 || n > MAX_ASSET_BYTES) return "bad_size";
  return null;
}

export function validateMediaParams(
  params: unknown,
):
  | { ok: true; prefix: MediaPrefix; data_base64: string }
  | { ok: false; error: "bad_input" | "bad_prefix" | "client_path_rejected" | "unknown_field" | "bad_base64" | "bad_size" } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: "bad_input" };
  }
  const rec = params as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => (CLIENT_PATH_KEYS as readonly string[]).includes(k))) {
    return { ok: false, error: "client_path_rejected" };
  }
  if (keys.some((k) => k !== "prefix" && k !== "data_base64")) {
    return { ok: false, error: "unknown_field" };
  }
  if (rec.prefix !== "venues" && rec.prefix !== "ads") return { ok: false, error: "bad_prefix" };
  if (typeof rec.data_base64 !== "string") return { ok: false, error: "bad_base64" };
  const sized = classifyBase64(rec.data_base64);
  if (sized) return { ok: false, error: sized };
  return { ok: true, prefix: rec.prefix, data_base64: rec.data_base64 };
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
  dataBase64: string;
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
  const decoded = decodeBase64Strict(input.dataBase64);
  if (!decoded.ok) return { ok: false, status: 400, error: decoded.error };
  const mime = sniffMime(decoded.bytes);
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
    bytes: decoded.bytes,
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
      bytes: decoded.bytes.length,
    },
  };
}
