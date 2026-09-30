// INERT harness for media_upload.ts. No network, no Edge deploy, no Storage write.
// ChatGPT EVET B: multipart is the default transport. JSON stays at 8KB.
// Run: node --experimental-strip-types --test CDP3B/edge/admin-api/inert/media_upload.test.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_JSON_MAX_BODY,
  ADMIN_ROLE_LABELS,
  ALLOWED_MIME,
  BASE64_PATH,
  GATE_SEQUENCE,
  JSON_PATH_ACCEPTS_MEDIA_UPLOAD,
  MAX_ASSET_BYTES,
  MAX_BASE64,
  MEDIA_BUCKET,
  MEDIA_MULTIPART_MAX,
  OBSERVED_GRANTED_ROLES,
  PREFIX_ROLES,
  ROLE_UNION,
  TRANSPORT_DEFAULT,
  UPLOAD_UPSERT,
  assertMultipartBufferedLength,
  base64DecodedLength,
  buildObjectPath,
  classifyBase64,
  classifyJsonBody,
  classifyMultipartContentLength,
  contentTypeBranch,
  decodeBase64Strict,
  isDuplicateStorageError,
  jsonMediaUploadRejected,
  mediaMimeAllowed,
  parseMediaMultipart,
  planMediaUpload,
  planMediaUploadFromBase64,
  prefixAllowedByRoles,
  publicMediaUrl,
  readCapped,
  sniffMime,
} from "./media_upload.ts";

const PRE_SPLICE_INDEX_SHA = "880dd2c4b75814949aff35d9e6a478dbfc9563da74137c2cfc7093e3482fae7b";
const ADMIN_HTML_SHA = "c4e8dafc6df801df67f838e9beeb3442289bf6ebff311a8a0c4a7ed013823073";
const SUPABASE_URL = "https://tosqsabuaomgqjtogdrn.supabase.co";
const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const BOUNDARY = "----asaMedia";

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

function form(parts: Array<{ name: string; value?: string; file?: Uint8Array; filename?: string; type?: string }>): {
  contentType: string;
  body: Uint8Array;
} {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += "\r\n";
    if (part.type) head += `Content-Type: ${part.type}\r\n`;
    head += "\r\n";
    chunks.push(enc.encode(head));
    chunks.push(part.file ?? enc.encode(part.value ?? ""));
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${BOUNDARY}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.length;
  }
  return { contentType: `multipart/form-data; boundary=${BOUNDARY}`, body };
}

test("admin-api splice keeps the 8KB JSON cap and adds multipart media_upload", () => {
  const buf = readFileSync(new URL("../index.ts", import.meta.url));
  const sha = createHash("sha256").update(buf).digest("hex");
  assert.notEqual(sha, PRE_SPLICE_INDEX_SHA);
  const text = buf.toString("utf8");
  assert.match(text, /const MAX_BODY = 8 \* 1024;/);
  assert.match(text, /from "\.\/inert\/media_upload\.ts"/);
  assert.match(text, /media_upload:\["super_admin","venue_editor","ads"\]/);
  assert.match(text, /new Set\(\[[^\]]*"media_upload"\]\)/);
  assert.match(text, /media_upload:\{min:10,day:100\}/);
  assert.match(text, /contentTypeBranch\(/);
  assert.match(text, /jsonMediaUploadRejected\(/);
  assert.match(text, /readCapped\(req,MEDIA_MULTIPART_MAX\)/);
  assert.match(text, /parseMediaMultipart\(/);
  assert.match(text, /planMediaUpload\(/);
  assert.match(text, /PREFIX_ROLES\[/);
  assert.match(text, /\.from\(MEDIA_BUCKET\)/);
  assert.match(text, /upsert:false/);
  assert.equal(text.includes("upsert:true"), false);
  assert.equal(text.includes("upsert: true"), false);
  assert.equal(text.includes("media_delete"), false);
  assert.equal(text.includes("createSignedUrl"), false);
  assert.equal(text.includes(".remove("), false);
  assert.equal(text.includes("arrayBuffer("), false);
  const branchAt = text.indexOf("contentTypeBranch(");
  const textAt = text.indexOf("req.text()");
  const readAt = text.indexOf("readCapped(");
  const userAt = text.indexOf("getUser(");
  const parseAt = text.indexOf("parseMediaMultipart(");
  const roleAt = text.indexOf("current_user_has_admin_role");
  const svcAt = text.indexOf("createClient(URL,SRK");
  const planAt = text.indexOf("planMediaUpload(");
  assert.ok(branchAt > 0 && branchAt < textAt);
  assert.ok(readAt > 0 && readAt < textAt);
  assert.ok(textAt < userAt);
  assert.ok(userAt < roleAt && roleAt < parseAt && parseAt < svcAt && svcAt < planAt);
  assert.equal((text.match(/req\.text\(\)/g) ?? []).length, 1);
  const html = readFileSync(new URL("../../../admin.html", import.meta.url));
  assert.equal(createHash("sha256").update(html).digest("hex"), ADMIN_HTML_SHA);
});

test("allowlist, multipart default, and role labels stay on the live contract", () => {
  assert.equal(TRANSPORT_DEFAULT, "multipart/form-data");
  assert.equal(JSON_PATH_ACCEPTS_MEDIA_UPLOAD, false);
  assert.equal(BASE64_PATH, "non_preferred");
  assert.deepEqual([...ALLOWED_MIME], ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(mediaMimeAllowed("image/gif"), false);
  assert.equal(MAX_ASSET_BYTES, 5_000_000);
  assert.equal(ADMIN_JSON_MAX_BODY, 8192);
  assert.ok(MEDIA_MULTIPART_MAX < MAX_BASE64);
  assert.equal(MEDIA_BUCKET, "media");
  assert.equal(UPLOAD_UPSERT, false);
  assert.deepEqual([...ADMIN_ROLE_LABELS], [
    "super_admin",
    "content_editor",
    "venue_editor",
    "moderator",
    "support",
    "crm",
    "ads",
    "analyst",
  ]);
  assert.deepEqual([...OBSERVED_GRANTED_ROLES], ["super_admin"]);
  assert.deepEqual([...ROLE_UNION], ["super_admin", "venue_editor", "ads"]);
  assert.deepEqual([...PREFIX_ROLES.venues], ["super_admin", "venue_editor"]);
  assert.deepEqual([...PREFIX_ROLES.ads], ["super_admin", "ads"]);
  assert.equal(PREFIX_ROLES.venues.includes("content_editor"), false);
  assert.equal(OBSERVED_GRANTED_ROLES.includes("venue_editor" as never), false);
  assert.equal(GATE_SEQUENCE[4], "content_type_branch");
  assert.equal(GATE_SEQUENCE[5], "multipart_length_cap");
  assert.equal(GATE_SEQUENCE.at(-1), "storage_upload");
  assert.ok(GATE_SEQUENCE.indexOf("content_type_branch") < GATE_SEQUENCE.indexOf("get_user"));
  assert.equal(GATE_SEQUENCE.includes("media_delete" as never), false);
});

test("magic-byte sniff rejects gif and svg and ignores a part content type", () => {
  assert.equal(sniffMime(JPEG), "image/jpeg");
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(sniffMime(WEBP), "image/webp");
  assert.equal(sniffMime(GIF), "image/gif");
  assert.equal(mediaMimeAllowed(sniffMime(GIF)), false);
  assert.equal(sniffMime(SVG), null);
  const built = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "venues" },
    { name: "file", file: JPEG, filename: "x.png", type: "image/png" },
  ]);
  const parsed = parseMediaMultipart(built.contentType, built.body);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(sniffMime(parsed.bytes), "image/jpeg");
});

test("non-preferred base64 cap rejects before decode and accounts for 33 percent growth", () => {
  assert.equal(BASE64_PATH, "non_preferred");
  assert.equal(MAX_BASE64, 6_666_668);
  assert.ok(MAX_BASE64 > MAX_ASSET_BYTES);
  assert.ok(MAX_BASE64 / MAX_ASSET_BYTES > 1.33);
  assert.ok(MAX_BASE64 / MAX_ASSET_BYTES < 1.34);
  assert.equal(classifyBase64(""), "bad_base64");
  assert.equal(classifyBase64("YQ=="), null);
  assert.equal(base64DecodedLength("YQ=="), 1);
  assert.equal(classifyBase64("data:image/png;base64,YQ=="), "bad_base64");
  const exact = "A".repeat(MAX_BASE64 - 1) + "=";
  assert.equal(base64DecodedLength(exact), MAX_ASSET_BYTES);
  assert.equal(classifyBase64(exact), null);
  const oneOver = "A".repeat(MAX_BASE64);
  assert.equal(base64DecodedLength(oneOver), MAX_ASSET_BYTES + 1);
  assert.equal(classifyBase64(oneOver), "bad_size");
  assert.equal(classifyJsonBody(exact.length), "too_large");
});

test("multipart parser takes prefix and file bytes and rejects client path fields", () => {
  const ok = parseMediaMultipart(
    ...Object.values(form([
      { name: "action", value: "media_upload" },
      { name: "prefix", value: "venues" },
      { name: "file", file: JPEG, filename: "../venues/evil.jpg" },
    ])) as [string, Uint8Array],
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.prefix, "venues");
    assert.deepEqual(ok.bytes, JPEG);
    assert.equal(JSON.stringify(ok).includes("evil"), false);
    assert.equal(JSON.stringify(ok).includes("filename"), false);
  }
  const pathField = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "ads" },
    { name: "file", file: PNG },
    { name: "path", value: "ads/evil.png" },
  ]);
  assert.equal(parseMediaMultipart(pathField.contentType, pathField.body).ok, false);
  assert.equal(
    (parseMediaMultipart(pathField.contentType, pathField.body) as { error: string }).error,
    "client_path_rejected",
  );
  const bucket = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "ads" },
    { name: "bucket", value: "other" },
    { name: "file", file: JPEG },
  ]);
  assert.equal((parseMediaMultipart(bucket.contentType, bucket.body) as { error: string }).error, "client_path_rejected");
  const upsert = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "venues" },
    { name: "upsert", value: "true" },
    { name: "file", file: JPEG },
  ]);
  assert.equal((parseMediaMultipart(upsert.contentType, upsert.body) as { error: string }).error, "client_path_rejected");
  const badPrefix = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "venues/../x" },
    { name: "file", file: JPEG },
  ]);
  assert.deepEqual(parseMediaMultipart(badPrefix.contentType, badPrefix.body), { ok: false, status: 400, error: "bad_prefix" });
  const otherAction = form([
    { name: "action", value: "counts" },
    { name: "prefix", value: "venues" },
    { name: "file", file: JPEG },
  ]);
  assert.deepEqual(parseMediaMultipart(otherAction.contentType, otherAction.body), {
    ok: false,
    status: 415,
    error: "unsupported_media_type",
  });
  const note = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "venues" },
    { name: "note", value: "x" },
    { name: "file", file: JPEG },
  ]);
  assert.equal((parseMediaMultipart(note.contentType, note.body) as { error: string }).error, "unknown_field");
});

test("prefix role matrix matches venue and ads editors even though only super_admin is granted today", () => {
  const venue = new Set(["venue_editor"]);
  const ads = new Set(["ads"]);
  const content = new Set(["content_editor"]);
  const support = new Set(["support"]);
  const superAdmin = new Set(OBSERVED_GRANTED_ROLES);
  assert.equal(prefixAllowedByRoles("venues", venue), true);
  assert.equal(prefixAllowedByRoles("ads", venue), false);
  assert.equal(prefixAllowedByRoles("ads", ads), true);
  assert.equal(prefixAllowedByRoles("venues", ads), false);
  assert.equal(prefixAllowedByRoles("venues", content), false);
  assert.equal(prefixAllowedByRoles("ads", support), false);
  assert.equal(prefixAllowedByRoles("venues", superAdmin), true);
  assert.equal(prefixAllowedByRoles("ads", superAdmin), true);
  assert.equal(prefixAllowedByRoles("venues", new Set(["analyst"])), false);
});

test("content-type branch keeps JSON at 8KB and caps multipart before the read", () => {
  assert.equal(contentTypeBranch("application/json"), "json_admin");
  assert.equal(contentTypeBranch("application/json; charset=utf-8"), "json_admin");
  assert.equal(contentTypeBranch(`multipart/form-data; boundary=${BOUNDARY}`), "multipart_media");
  assert.equal(contentTypeBranch("text/plain"), "unsupported");
  assert.equal(classifyJsonBody(ADMIN_JSON_MAX_BODY), "ok");
  assert.equal(classifyJsonBody(ADMIN_JSON_MAX_BODY + 1), "too_large");
  assert.equal(classifyJsonBody(MAX_ASSET_BYTES), "too_large");
  assert.deepEqual(jsonMediaUploadRejected(), { status: 415, error: "unsupported_media_type" });
  assert.equal(classifyMultipartContentLength(null), "missing");
  assert.equal(classifyMultipartContentLength(MEDIA_MULTIPART_MAX), "ok");
  assert.equal(classifyMultipartContentLength(MEDIA_MULTIPART_MAX + 1), "too_large");
  assert.equal(assertMultipartBufferedLength(MEDIA_MULTIPART_MAX + 1), "too_large");
  const tiny = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "ads" },
    { name: "file", file: Uint8Array.from([]) },
  ]);
  assert.equal((parseMediaMultipart(tiny.contentType, tiny.body) as { error: string }).error, "bad_size");
});

test("object names are server uuids under venues or ads and do not collide", () => {
  const a = buildObjectPath("venues", "image/jpeg", UUID_A);
  const b = buildObjectPath("venues", "image/jpeg", UUID_B);
  assert.equal(a, `venues/${UUID_A}.jpg`);
  assert.notEqual(a, b);
  assert.equal(buildObjectPath("ads", "image/png", UUID_A), `ads/${UUID_A}.png`);
  assert.equal(buildObjectPath("ads", "image/webp", UUID_B), `ads/${UUID_B}.webp`);
  assert.throws(() => buildObjectPath("venues", "image/jpeg", "../etc/passwd"));
  assert.equal(publicMediaUrl(SUPABASE_URL, a), `${SUPABASE_URL}/storage/v1/object/public/media/${a}`);
  assert.throws(() => publicMediaUrl("https://evil.example/storage", a));
});

test("duplicate storage error does not become a successful overwrite", () => {
  assert.equal(isDuplicateStorageError({ error: "Duplicate", message: "Asset Already Exists", statusCode: 400 }), true);
  assert.equal(isDuplicateStorageError({ message: "The resource already exists" }), true);
  assert.equal(isDuplicateStorageError({ message: "timeout", statusCode: 500 }), false);
  assert.equal(isDuplicateStorageError({ statusCode: 400, message: "Invalid MIME" }), false);
});

test("planMediaUpload uses multipart bytes and does not upload rejected types", async () => {
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
  const built = form([
    { name: "action", value: "media_upload" },
    { name: "prefix", value: "venues" },
    { name: "file", file: JPEG, filename: "client.jpg", type: "image/gif" },
  ]);
  const parsed = parseMediaMultipart(built.contentType, built.body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ok = await planMediaUpload({
    prefix: parsed.prefix,
    bytes: parsed.bytes,
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_A,
    upload,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.data.public_url, `${SUPABASE_URL}/storage/v1/object/public/media/venues/${UUID_A}.jpg`);
    assert.equal(ok.data.mime, "image/jpeg");
    assert.equal(JSON.stringify(ok).includes("service_role"), false);
    assert.equal(JSON.stringify(ok).includes("client.jpg"), false);
  }
  assert.equal(calls[0].upsert, false);
  assert.equal(calls[0].contentType, "image/jpeg");

  calls.length = 0;
  const gif = await planMediaUpload({
    prefix: "ads",
    bytes: GIF,
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_B,
    upload,
  });
  assert.deepEqual(gif, { ok: false, status: 400, error: "bad_mime_content" });
  const svg = await planMediaUpload({
    prefix: "ads",
    bytes: SVG,
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_B,
    upload,
  });
  assert.deepEqual(svg, { ok: false, status: 400, error: "bad_mime_content" });
  assert.equal(calls.length, 0);

  const dup = await planMediaUpload({
    prefix: "venues",
    bytes: PNG,
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_A,
    upload: async () => ({ error: { error: "Duplicate", message: "Asset Already Exists", statusCode: 400 } }),
  });
  assert.deepEqual(dup, { ok: false, status: 409, error: "object_exists" });
  assert.equal(JSON.stringify(dup).includes("Asset Already Exists"), false);

  const over = new Uint8Array(MAX_ASSET_BYTES + 1);
  over[0] = 0xff;
  over[1] = 0xd8;
  over[2] = 0xff;
  const tooBig = await planMediaUpload({
    prefix: "venues",
    bytes: over,
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_A,
    upload,
  });
  assert.deepEqual(tooBig, { ok: false, status: 400, error: "bad_size" });
  assert.equal(calls.length, 0);
});

test("design doc records EDGE_IMPLEMENT, APPLY=NO, and open deploy blockers", () => {
  const doc = readFileSync(new URL("../MEDIA_UPLOAD_DESIGN.md", import.meta.url), "utf8");
  assert.match(doc, /EDGE_IMPLEMENT/);
  assert.match(doc, /NOT deployed/);
  assert.match(doc, /ChatGPT EVET B/);
  assert.match(doc, /NO_POLICY_DROP=true/);
  assert.match(doc, /NO_EDGE_DEPLOY=true/);
  assert.match(doc, /NO_ADMIN_HTML/);
  assert.match(doc, /APPLY=NO/);
  assert.match(doc, /DEPLOY_BLOCKERS=open/);
  assert.match(doc, /multipart\/form-data/);
  assert.match(doc, /DEPLOY BLOCKER/);
  assert.match(doc, /super_admin/);
  assert.match(doc, /venue_editor/);
  assert.match(doc, /5_000_000/);
  assert.match(doc, /8 \* 1024|8192|8KB/);
  assert.match(doc, new RegExp(PRE_SPLICE_INDEX_SHA));
  assert.equal(doc.includes("sb_secret_"), false);
  assert.equal(/eyJ[A-Za-z0-9_-]{6,}\./.test(doc), false);
});

test("readCapped stops one byte past the caller max", async () => {
  const exact = new Request("https://example.test/up", { method: "POST", body: Uint8Array.from([1, 2, 3, 4]) });
  const got = await readCapped(exact, 4);
  assert.deepEqual([...got], [1, 2, 3, 4]);
  const over = new Request("https://example.test/up", { method: "POST", body: Uint8Array.from([1, 2, 3, 4, 5]) });
  const capped = await readCapped(over, 3);
  assert.deepEqual([...capped], [1, 2, 3, 4]);
  assert.equal((await readCapped({ body: null }, 8)).length, 0);
  assert.equal((await readCapped({ body: null }, -1)).length, MEDIA_MULTIPART_MAX + 1);
  assert.equal(assertMultipartBufferedLength(MEDIA_MULTIPART_MAX + 1), "too_large");
  assert.equal(assertMultipartBufferedLength(MEDIA_MULTIPART_MAX), "ok");
});

test("rate-check SQL artifact adds only media_upload and is marked APPLY=NO", () => {
  const sql = readFileSync(new URL("./admin_rate_check_media_upload.APPLY_NO.sql", import.meta.url), "utf8");
  assert.match(sql, /APPLY=NO/);
  assert.equal(/drop\s+(function|policy|table)/i.test(sql), false);
  assert.equal(/create\s+policy/i.test(sql), false);
  assert.equal(/storage\.objects/i.test(sql), false);
  const list = sql.match(/p_action not in \(([\s\S]*?)\)/);
  assert.ok(list);
  const allow = list[1];
  assert.match(allow, /'media_upload'/);
  assert.equal(allow.includes("q_member_consent"), false);
  assert.equal(allow.includes("marketing_readiness_check"), false);
  const live = [
    "counts", "member_search", "member_360", "comment_search", "comment_set_hidden", "member_set_blocked",
    "adjust_points", "content_rollback", "audit_search", "audit_detail", "content_versions",
    "cities_overview", "city_health", "member_set_note", "member_set_segment",
    "segment_preview", "segment_list", "segment_upsert", "segment_run", "segment_duplicate", "segment_set_active", "events_list",
    "segment_taxonomy", "segment_member_search", "member_360_by_ref",
  ];
  for (const name of live) assert.match(sql, new RegExp(`'${name}'`));
  const yml = readFileSync(new URL("../../../../.github/workflows/cdp3c-edge-integration.yml", import.meta.url), "utf8");
  assert.match(yml, /cp CDP3B\/edge\/admin-api\/inert\/media_upload\.ts supabase\/functions\/admin-api\/inert\/media_upload\.ts/);
  assert.equal(yml.includes("functions deploy"), false);
});

test("module exports no delete action", async () => {
  const mod = await import("./media_upload.ts");
  assert.equal("deleteMedia" in mod, false);
  assert.equal("media_delete" in mod, false);
  const decoded = decodeBase64Strict(b64(WEBP));
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.equal(sniffMime(decoded.bytes), "image/webp");
  const viaB64 = await planMediaUploadFromBase64({
    prefix: "ads",
    dataBase64: b64(WEBP),
    supabaseUrl: SUPABASE_URL,
    newUuid: () => UUID_B,
    upload: async (args) => ({ error: null, path: args.path }),
  });
  assert.equal(viaB64.ok, true);
  if (viaB64.ok) assert.equal(viaB64.data.mime, "image/webp");
});
