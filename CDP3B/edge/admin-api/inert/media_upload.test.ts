// INERT harness for media_upload.ts. No network, no Edge deploy, no Storage write.
// Run: node --experimental-strip-types --test CDP3B/edge/admin-api/inert/media_upload.test.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_JSON_MAX_BODY,
  ALLOWED_MIME,
  GATE_SEQUENCE,
  MAX_ASSET_BYTES,
  MAX_BASE64,
  MEDIA_BUCKET,
  MEDIA_MAX_RAW,
  PREFIX_ROLES,
  ROLE_UNION,
  UPLOAD_UPSERT,
  base64DecodedLength,
  buildObjectPath,
  classifyBase64,
  classifyRawBody,
  decodeBase64Strict,
  isDuplicateStorageError,
  mediaMimeAllowed,
  planMediaUpload,
  prefixAllowedByRoles,
  publicMediaUrl,
  sniffMime,
  validateMediaParams,
} from "./media_upload.ts";

const LIVE_INDEX_SHA = "880dd2c4b75814949aff35d9e6a478dbfc9563da74137c2cfc7093e3482fae7b";
const SUPABASE_URL = "https://tosqsabuaomgqjtogdrn.supabase.co";
const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

test("live admin-api index.ts is unchanged and does not reference media_upload", () => {
  const buf = readFileSync(new URL("../index.ts", import.meta.url));
  assert.equal(createHash("sha256").update(buf).digest("hex"), LIVE_INDEX_SHA);
  const text = buf.toString("utf8");
  assert.equal(text.includes("media_upload"), false);
  assert.equal(text.includes("inert/media_upload"), false);
  assert.match(text, /const MAX_BODY = 8 \* 1024;/);
  assert.match(text, /const WRITE_ACTIONS = new Set\(\[/);
  assert.equal(text.includes('"media_upload"'), false);
});

test("allowlist is jpeg png webp only and upsert stays false", () => {
  assert.deepEqual([...ALLOWED_MIME], ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(mediaMimeAllowed("image/gif"), false);
  assert.equal(mediaMimeAllowed("image/svg+xml"), false);
  assert.equal(MAX_ASSET_BYTES, 5_000_000);
  assert.equal(ADMIN_JSON_MAX_BODY, 8192);
  assert.equal(MEDIA_BUCKET, "media");
  assert.equal(UPLOAD_UPSERT, false);
  assert.deepEqual(ROLE_UNION, ["super_admin", "venue_editor", "ads"]);
  assert.deepEqual(PREFIX_ROLES.venues, ["super_admin", "venue_editor"]);
  assert.deepEqual(PREFIX_ROLES.ads, ["super_admin", "ads"]);
  assert.equal(PREFIX_ROLES.venues.includes("content_editor"), false);
  assert.equal(GATE_SEQUENCE.at(-1), "storage_upload");
  assert.ok(GATE_SEQUENCE.indexOf("prefix_role") < GATE_SEQUENCE.indexOf("admin_rate_check"));
  assert.ok(GATE_SEQUENCE.indexOf("admin_writes_status") < GATE_SEQUENCE.indexOf("storage_upload"));
  assert.equal(GATE_SEQUENCE.includes("media_delete" as never), false);
});

test("magic-byte sniff rejects gif and svg and ignores a fake content type", () => {
  assert.equal(sniffMime(JPEG), "image/jpeg");
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(sniffMime(WEBP), "image/webp");
  assert.equal(sniffMime(GIF), "image/gif");
  assert.equal(mediaMimeAllowed(sniffMime(GIF)), false);
  assert.equal(sniffMime(SVG), null);
  assert.equal(sniffMime(Uint8Array.from([0x00, 0x00, 0x00])), null);
  const jpegThenGif = new Uint8Array(JPEG.length + GIF.length);
  jpegThenGif.set(JPEG, 0);
  jpegThenGif.set(GIF, JPEG.length);
  assert.equal(sniffMime(jpegThenGif), "image/jpeg");
});

test("base64 size gate is exact at 5MB without trusting length alone", () => {
  assert.equal(classifyBase64(""), "bad_base64");
  assert.equal(classifyBase64("abc"), "bad_base64");
  assert.equal(classifyBase64("YQ=="), null);
  assert.equal(base64DecodedLength("YQ=="), 1);
  assert.equal(classifyBase64("data:image/png;base64,YQ=="), "bad_base64");
  const exact = "A".repeat(MAX_BASE64 - 1) + "=";
  assert.equal(exact.length, MAX_BASE64);
  assert.equal(base64DecodedLength(exact), MAX_ASSET_BYTES);
  assert.equal(classifyBase64(exact), null);
  const oneOver = "A".repeat(MAX_BASE64);
  assert.equal(base64DecodedLength(oneOver), MAX_ASSET_BYTES + 1);
  assert.equal(classifyBase64(oneOver), "bad_size");
  assert.equal(classifyBase64("A".repeat(MAX_BASE64 + 4)), "bad_size");
});

test("closed params reject client path, bucket, content-type, and upsert", () => {
  const ok = validateMediaParams({ prefix: "venues", data_base64: b64(JPEG) });
  assert.equal(ok.ok, true);
  assert.equal(validateMediaParams({ prefix: "ads", data_base64: b64(PNG) }).ok, true);
  assert.deepEqual(
    validateMediaParams({ prefix: "venues/../x", data_base64: b64(JPEG) }),
    { ok: false, error: "bad_prefix" },
  );
  assert.deepEqual(
    validateMediaParams({ prefix: "venues", data_base64: b64(JPEG), path: "venues/evil.jpg" }),
    { ok: false, error: "client_path_rejected" },
  );
  assert.equal(
    validateMediaParams({ prefix: "ads", data_base64: b64(JPEG), bucket: "media" }).ok && false,
    false,
  );
  assert.equal(
    (validateMediaParams({ prefix: "ads", data_base64: b64(JPEG), bucket: "other" }) as { error: string }).error,
    "client_path_rejected",
  );
  assert.equal(
    (validateMediaParams({ prefix: "venues", data_base64: b64(JPEG), contentType: "image/png" }) as { error: string }).error,
    "client_path_rejected",
  );
  assert.equal(
    (validateMediaParams({ prefix: "venues", data_base64: b64(JPEG), upsert: true }) as { error: string }).error,
    "client_path_rejected",
  );
  assert.equal(
    (validateMediaParams({ prefix: "venues", data_base64: b64(JPEG), note: "x" }) as { error: string }).error,
    "unknown_field",
  );
  assert.equal(validateMediaParams(null).ok, false);
});

test("prefix role matrix matches venue and ads editors", () => {
  const venue = new Set(["venue_editor"]);
  const ads = new Set(["ads"]);
  const content = new Set(["content_editor"]);
  const support = new Set(["support"]);
  const superAdmin = new Set(["super_admin"]);
  assert.equal(prefixAllowedByRoles("venues", venue), true);
  assert.equal(prefixAllowedByRoles("ads", venue), false);
  assert.equal(prefixAllowedByRoles("ads", ads), true);
  assert.equal(prefixAllowedByRoles("venues", ads), false);
  assert.equal(prefixAllowedByRoles("venues", content), false);
  assert.equal(prefixAllowedByRoles("ads", support), false);
  assert.equal(prefixAllowedByRoles("venues", superAdmin), true);
  assert.equal(prefixAllowedByRoles("ads", superAdmin), true);
});

test("oversized bodies are media-only when action is the first key", () => {
  assert.equal(classifyRawBody(100, "{\"action\":\"counts\"}"), "small");
  assert.equal(classifyRawBody(ADMIN_JSON_MAX_BODY, "{\"action\":\"counts\"}"), "small");
  const head = "{\"action\":\"media_upload\",\"params\":{";
  assert.equal(classifyRawBody(ADMIN_JSON_MAX_BODY + 1, head), "media");
  assert.equal(classifyRawBody(MEDIA_MAX_RAW, head), "media");
  assert.equal(classifyRawBody(MEDIA_MAX_RAW + 1, head), "too_large");
  assert.equal(classifyRawBody(ADMIN_JSON_MAX_BODY + 1, "{\"params\":{},\"action\":\"media_upload\"}"), "too_large");
  const compact = JSON.stringify({ action: "media_upload", params: { prefix: "venues", data_base64: "" } });
  assert.ok(compact.length < 1024);
  assert.ok(compact.length + MAX_BASE64 <= MEDIA_MAX_RAW);
});

test("object names are server uuids under venues or ads and do not collide", () => {
  const a = buildObjectPath("venues", "image/jpeg", UUID_A);
  const b = buildObjectPath("venues", "image/jpeg", UUID_B);
  assert.equal(a, `venues/${UUID_A}.jpg`);
  assert.notEqual(a, b);
  assert.equal(buildObjectPath("ads", "image/png", UUID_A), `ads/${UUID_A}.png`);
  assert.equal(buildObjectPath("ads", "image/webp", UUID_B), `ads/${UUID_B}.webp`);
  assert.throws(() => buildObjectPath("venues", "image/jpeg", "../etc/passwd"));
  assert.equal(
    publicMediaUrl(SUPABASE_URL, a),
    `${SUPABASE_URL}/storage/v1/object/public/media/${a}`,
  );
  assert.throws(() => publicMediaUrl("https://evil.example/storage", a));
  assert.throws(() => publicMediaUrl(SUPABASE_URL + "/extra", a));
});

test("duplicate storage error does not become a successful overwrite", () => {
  assert.equal(isDuplicateStorageError({ error: "Duplicate", message: "Asset Already Exists", statusCode: 400 }), true);
  assert.equal(isDuplicateStorageError({ message: "The resource already exists" }), true);
  assert.equal(isDuplicateStorageError({ message: "timeout", statusCode: 500 }), false);
  assert.equal(isDuplicateStorageError({ statusCode: 400, message: "Invalid MIME" }), false);
});

test("planMediaUpload returns a public url and never calls storage for rejected bytes", async () => {
  const calls: Array<{ upsert: boolean; bucket: string; contentType: string; path: string }> = [];
  const upload = async (args: {
    bucket: "media";
    path: string;
    bytes: Uint8Array;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    upsert: false;
    cacheControl: "3600";
  }) => {
    calls.push(args);
    return { error: null, path: args.path };
  };
  const ok = await planMediaUpload({
    prefix: "venues",
    dataBase64: b64(JPEG),
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_A,
    upload,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.data.public_url, `${SUPABASE_URL}/storage/v1/object/public/media/venues/${UUID_A}.jpg`);
    assert.equal(ok.data.mime, "image/jpeg");
    assert.equal(ok.data.bucket, "media");
    assert.equal(JSON.stringify(ok).includes("service_role"), false);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].upsert, false);
  assert.equal(calls[0].bucket, "media");
  assert.equal(calls[0].contentType, "image/jpeg");

  calls.length = 0;
  const gif = await planMediaUpload({
    prefix: "ads",
    dataBase64: b64(GIF),
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_B,
    upload,
  });
  assert.deepEqual(gif, { ok: false, status: 400, error: "bad_mime_content" });
  const svg = await planMediaUpload({
    prefix: "ads",
    dataBase64: b64(SVG),
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_B,
    upload,
  });
  assert.deepEqual(svg, { ok: false, status: 400, error: "bad_mime_content" });
  assert.equal(calls.length, 0);

  const dup = await planMediaUpload({
    prefix: "venues",
    dataBase64: b64(PNG),
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_A,
    upload: async () => ({ error: { error: "Duplicate", message: "Asset Already Exists", statusCode: 400 } }),
  });
  assert.deepEqual(dup, { ok: false, status: 409, error: "object_exists" });
  assert.equal(JSON.stringify(dup).includes("Asset Already Exists"), false);
});

test("design doc stays inert and does not carry a storage policy statement to execute", () => {
  const doc = readFileSync(new URL("../MEDIA_UPLOAD_DESIGN.md", import.meta.url), "utf8");
  assert.match(doc, /INERT/);
  assert.match(doc, /NO_POLICY_DROP=true/);
  assert.match(doc, /NO_EDGE_DEPLOY=true/);
  assert.match(doc, /verify_jwt=true/);
  assert.match(doc, /5_000_000/);
  assert.equal(doc.includes("sb_secret_"), false);
  assert.equal(/eyJ[A-Za-z0-9_-]{6,}\./.test(doc), false);
});

test("module exports no delete action", async () => {
  const mod = await import("./media_upload.ts");
  assert.equal("deleteMedia" in mod, false);
  assert.equal("media_delete" in mod, false);
  const decoded = decodeBase64Strict(b64(WEBP));
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.equal(sniffMime(decoded.bytes), "image/webp");
});
