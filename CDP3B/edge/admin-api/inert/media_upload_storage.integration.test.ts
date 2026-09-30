// Ephemeral Storage integration for media_upload. Skip unless a NON-production
// stack is pointed at by the environment. Never calls hosted production.
//
//   MEDIA_UPLOAD_IT_FN            functions/v1/admin-api URL
//   MEDIA_UPLOAD_IT_ORIGIN        optional Origin (default https://www.asalocal.club)
//   MEDIA_UPLOAD_IT_JWT           admin access token (not logged)
//   MEDIA_UPLOAD_IT_SERVICE_KEY   service key used only for harness remove (not logged)
//   MEDIA_UPLOAD_IT_STORAGE_URL   origin that serves /storage/v1 (ephemeral API)
//
// Object delta must be 0. The remove call is harness-only and is not an action.

import { test } from "node:test";
import assert from "node:assert/strict";

const FN = process.env.MEDIA_UPLOAD_IT_FN ?? "";
const JWT = process.env.MEDIA_UPLOAD_IT_JWT ?? "";
const SERVICE = process.env.MEDIA_UPLOAD_IT_SERVICE_KEY ?? "";
const STORAGE = process.env.MEDIA_UPLOAD_IT_STORAGE_URL ?? "";
const ORIGIN = process.env.MEDIA_UPLOAD_IT_ORIGIN ?? "https://www.asalocal.club";
const PROD_REF = "tosqsabuaomgqjtogdrn";
const ready = FN !== "" && JWT !== "" && SERVICE !== "" && STORAGE !== "";
const blocked = [FN, STORAGE].some((value) => value.includes(PROD_REF));

function formBody(): { contentType: string; body: Uint8Array } {
  const boundary = "----asaMediaIt";
  const enc = new TextEncoder();
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);
  const chunks: Uint8Array[] = [];
  const push = (name: string, value: Uint8Array, extra = "") => {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`));
    chunks.push(value);
    chunks.push(enc.encode("\r\n"));
  };
  push("action", enc.encode("media_upload"));
  push("prefix", enc.encode("venues"));
  push("file", jpeg, '; filename="ignored.jpg"');
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.length;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

async function countObjects(): Promise<number> {
  const res = await fetch(`${STORAGE.replace(/\/$/, "")}/storage/v1/object/list/media`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE}`,
      apikey: SERVICE,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prefix: "", limit: 1000, offset: 0 }),
  });
  if (!res.ok) throw new Error(`list_failed_${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("list_not_array");
  return rows.length;
}

test("ephemeral media_upload teardown leaves object delta 0", { skip: !ready || blocked }, async () => {
  assert.equal(blocked, false);
  const before = await countObjects();
  const built = formBody();
  const res = await fetch(FN, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${JWT}`,
      "content-type": built.contentType,
    },
    body: built.body,
  });
  const payload = await res.json();
  assert.equal(res.status, 200);
  const path = payload?.data?.path;
  assert.match(path, /^venues\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(String(payload?.data?.public_url ?? "").includes("token="), false);
  assert.equal(JSON.stringify(payload).includes("service_role"), false);
  const removed = await fetch(`${STORAGE.replace(/\/$/, "")}/storage/v1/object/media/${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${SERVICE}`, apikey: SERVICE },
  });
  assert.ok(removed.status === 200 || removed.status === 204);
  const after = await countObjects();
  assert.equal(after, before);
});

test("live production storage is not a target for this harness", () => {
  assert.equal(PROD_REF.length > 0, true);
  if (ready && blocked) assert.fail("refusing production storage credentials");
});
