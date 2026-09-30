# STORAGE_MEDIA_UPLOAD_DESIGN

**Status: EDGE_IMPLEMENT in-repo. NOT deployed.** The multipart splice is in `CDP3B/edge/admin-api/index.ts` and imports `inert/media_upload.ts`. Production admin-api remains hosted v16 (`verify_jwt=true`) on the pre-splice source. This change does not deploy the function, does not edit `admin.html` or `CDP3B/admin.html`, and does not drop or create storage policies.

**Revision: ChatGPT EVET B (2026-09-30), spliced in-repo 2026-09-30.** Default transport for `media_upload` is `multipart/form-data`. The global JSON body cap stays 8KB. Role gates stay aligned to the live `_can_edit_venues` / `_can_edit_ads` helpers. Two items below are still **DEPLOY BLOCKERS** before any future deploy EVET.

```
NO_EDGE_DEPLOY=true
NO_POLICY_DROP=true
NO_ADMIN_HTML_EDIT=true
NO_BROWSER_STORAGE_WIRING=true
MERGE_IS_NOT_DEPLOY=true
APPLY=NO
DEPLOY_BLOCKERS=open
```

Merge of this PR leaves production admin-api v16, the `media` bucket, and the admin UI on their current paths. Deploy stays blocked until the two deploy blockers in §8 pass. Admin UI wiring is a further **STORAGE_MEDIA_ADMIN_WIRE** approval. Policy lock is **STORAGE_MEDIA_LOCK_ACTIVATE** and stays blocked until Edge upload has passed smoke.

## 0. Evidence (read-only SELECT, 2026-09-30)

Pre-splice repo file `CDP3B/edge/admin-api/index.ts` SHA-256 `880dd2c4b75814949aff35d9e6a478dbfc9563da74137c2cfc7093e3482fae7b`. Hosted slug `admin-api` is ACTIVE version 16, `verify_jwt=true`, that same source text. This PR changes the repo file and does not deploy it, so production stays on that hash until a later EVET. `MAX_BODY = 8 * 1024` is still the JSON ceiling. `req.text()` runs only on the `application/json` branch, after `contentTypeBranch`, and still before the JSON action is trusted. Multipart uses `readCapped` at `5_000_000 + 65_536` and never calls `req.text()`.

Live enum `public.admin_role` labels, `enumsortorder` 1 through 8:

```text
super_admin, content_editor, venue_editor, moderator, support, crm, ads, analyst
```

Query:

```sql
select e.enumlabel
from pg_enum e
join pg_type t on t.oid = e.enumtypid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' and t.typname = 'admin_role'
order by e.enumsortorder;
```

Live grants, same day:

```sql
select role::text, count(*)::int
from public.admin_roles
group by role
order by 1;
```

Result: one group, `super_admin` with count 1. No row for `venue_editor`, `ads`, or any other label. No user id is recorded in this doc.

Live helpers (unchanged from the prior read):

- `_can_edit_venues()` → active admin and role `super_admin` or `venue_editor`
- `_can_edit_ads()` → active admin and role `super_admin` or `ads`

`current_user_has_admin_role(role_name admin_role)` calls `_has_admin_role`, which requires `admin_users.active` and that enum label. admin-api `ROLE_SETS` already passes those enum labels (`content_editor`, `support`, `moderator`, `crm`, `analyst`, `super_admin`) into `{role_name}`. `venue_editor` and `ads` are the same enum. This package does not add a label and does not migrate grants.

`admin_rate_check` allowlist still ends at `member_360_by_ref`. It does not contain `media_upload`.

`email-api` `sniffMime` is the byte predicate. Email stays on GIF-inclusive 2MB draft assets. This design does not edit `email-api`.

## 1. What v1 adds

One write action on the existing `admin-api` function:

| Item | Locked value |
|---|---|
| Action | `media_upload` |
| Transport | **`multipart/form-data` only.** Text fields `action` and `prefix`, one file field `file`. |
| Other actions | Stay `application/json` with the existing 8KB `MAX_BODY`. They do not move to multipart. |
| JSON `media_upload` | Rejected with 415 `unsupported_media_type`. Does not raise `MAX_BODY`. |
| Base64 | **Non-preferred.** Not the v1 contract. Caps in §3.1 only, if a later EVET revisits it. |
| JWT | Platform `verify_jwt=true` stays. Do not pass `--no-verify-jwt`. |
| Caller | Authenticated admin JWT. `service_role` stays in Edge env and is never a response field, log line, or client argument. |
| Bucket | Hard-coded `media`. A client `bucket` field is rejected. |
| Prefix | `venues` or `ads` only. Basename is a server UUID. Client filename is ignored. |
| MIME | `image/jpeg`, `image/png`, `image/webp` by magic bytes. GIF, SVG, and every other type are rejected. Part `Content-Type` is not the allowlist. |
| Size | 5_000_000 file bytes maximum. Multipart envelope slack is 65_536 bytes on top of that, for the early cap only. |
| Overwrite | `upsert: false`. Duplicate path → 409 `object_exists`. |
| Delete | No `media_delete` action and no `storage.remove` in v1. |
| Public read | `media.public` stays true. Public URL only. No signed URL. |
| Policies | The four `media anon *` policies stay until a later lock EVET. |

`inert/media_upload.ts` is the reference implementation. `index.ts` imports it. That import is repo-only until a future deploy, and that deploy stays blocked on §8.

## 2. Discovered constraints (locked, not open)

### 2.1 Do not raise the JSON 8KB cap

`index.ts` today, after the bearer check:

```text
if(!(req.headers.get("Content-Type")??"").includes("application/json"))return json(415,...)
const raw=await req.text(); if(raw.length>MAX_BODY)return json(413,...)
```

`MAX_BODY` is `8 * 1024`. That line stays the ceiling for every JSON action, including a JSON body whose `action` is `media_upload` (that body is 413 once it passes 8192 bytes, and 415 if it is small enough to parse and the action is `media_upload`).

Future splice, **before** `req.text()`, branching on `Content-Type`:

```ts
const ctype = req.headers.get("Content-Type") ?? "";
const branch = contentTypeBranch(ctype); // inert helper
if (branch === "multipart_media") {
  const rawLen = req.headers.get("Content-Length");
  const n = rawLen === null || rawLen === "" ? null : Number(rawLen);
  const headerClass = classifyMultipartContentLength(
    n === null || !Number.isFinite(n) ? null : Math.trunc(n),
  );
  if (headerClass === "too_large") return json(413, { error: "payload_too_large" }, request_id, ch);
  // readCapped: stop at MEDIA_MULTIPART_MAX bytes. Do not use req.text()
  // (it corrupts binary) and do not use an uncapped arrayBuffer().
  const buf = await readCapped(req, MEDIA_MULTIPART_MAX);
  if (assertMultipartBufferedLength(buf.length) === "too_large") {
    return json(413, { error: "payload_too_large" }, request_id, ch);
  }
  const parsed = parseMediaMultipart(ctype, buf);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error }, request_id, ch);
  // parsed.action === "media_upload", parsed.prefix, parsed.bytes
  // Fall through to the existing getUser / ROLE_SETS / writes / rate gates.
} else if (branch === "json_admin") {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: "payload_too_large" }, request_id, ch);
  // existing JSON parse. If action === "media_upload", return
  // jsonMediaUploadRejected() (415) before getUser. MAX_BODY is unchanged.
} else {
  return json(415, { error: "unsupported_media_type" }, request_id, ch);
}
```

`MEDIA_MULTIPART_MAX` is `5_000_000 + 65_536`. A `Content-Length` above that is 413 before the body is read. A missing `Content-Length` still uses `readCapped`. A lying small `Content-Length` still stops at the same cap. The file part itself must be 1..5_000_000 bytes (`bad_size` otherwise). Text parts `action` and `prefix` are at most 128 bytes.

Multipart whose `action` field is not exactly `media_upload` (for example `counts`) returns 415 `unsupported_media_type` and does not enter that action's JSON handler.

`readCapped` is part of the Edge splice. This inert package only enforces the length once the bytes are already a `Uint8Array`.

### 2.2 `admin_rate_check` will 500 a new action name

The handler always calls `admin_rate_check`. The live function raises `bad action` unless `p_action` is in a fixed list. The handler maps that RPC error to 500 `internal`.

Deploying the TypeScript splice without extending that list makes every `media_upload` return 500 and write nothing. The extension is a `CREATE OR REPLACE` of `public.admin_rate_check` only. It is not a storage policy change. The repo artifact is `inert/admin_rate_check_media_upload.APPLY_NO.sql`. **APPLY=NO.** It is not applied by this PR.

The replace must keep every action string that is in the function today and add only `media_upload`. It must not DROP the function. It must not add `q_member_consent` or `marketing_readiness_check` in the same change: those names are already in the Edge `LIMITS` map and already absent from the SQL list, so they 500 today. That gap is pre-existing and out of scope.

Limits for `media_upload`: `min: 10`, `day: 100`. The action is in `WRITE_ACTIONS`, so `admin_writes_status` still applies.

### 2.3 Roles stay on the live helpers

`ROLE_SETS` has no venue or ads action today. `content_editor` is `_can_edit_content`, not venue or ad images. `ANY_ADMIN` would let every admin upload. Do not use it.

No new enum value and no grant migration. The labels `venue_editor` and `ads` already exist (§0). Practical access **today** is `super_admin` only, because that is the only assigned role. When a `venue_editor` or `ads` grant exists later, the same gate admits them. Assigning those roles is out of scope here.

Coarse gate:

```text
ROLE_SETS.media_upload = ["super_admin", "venue_editor", "ads"]
WRITE_ACTIONS adds "media_upload"
```

After the multipart parse, and before the service-role client uploads, re-check with the same `rpcBool(userClient, "current_user_has_admin_role", { role_name })` loop:

| `prefix` field | Any of these roles | Live equivalent |
|---|---|---|
| `venues` | `super_admin`, `venue_editor` | `_can_edit_venues` |
| `ads` | `super_admin`, `ads` | `_can_edit_ads` |

A `venue_editor` who sends `ads` gets 403 `forbidden` and storage is not called. A `content_editor` fails the coarse union with 403 `forbidden`. A `super_admin` may use either prefix. That matches the one grant that exists today.

## 3. Multipart request (default)

```text
POST  Content-Type: multipart/form-data; boundary=----asaMedia
      Authorization: Bearer <admin JWT>
      apikey: <anon key class, same as other admin-api calls>

------asaMedia
Content-Disposition: form-data; name="action"

media_upload
------asaMedia
Content-Disposition: form-data; name="prefix"

venues
------asaMedia
Content-Disposition: form-data; name="file"; filename="ignored.jpg"
Content-Type: application/octet-stream

<raw file bytes>
------asaMedia--
```

`prefix` is exactly `venues` or `ads` (no trim, no `venues/`).

Parts are exactly one `action`, one `prefix`, and one `file`.

| Extra part name | Error |
|---|---|
| `bucket`, `path`, `object_path`, `objectPath`, `filename`, `file_name`, `fileName`, `name`, `key`, `content_type`, `contentType`, `mime`, `upsert`, `cacheControl`, `cache_control` | 400 `client_path_rejected` |
| any other name | 400 `unknown_field` |
| missing boundary, missing part, or two `file` parts | 400 `bad_input` |
| bad prefix | 400 `bad_prefix` |
| `action` other than `media_upload` | 415 `unsupported_media_type` |
| file length 0 or greater than 5_000_000 | 400 `bad_size` |
| whole body above `MEDIA_MULTIPART_MAX` | 413 `payload_too_large` |

The `filename` parameter on the file part is ignored. It is not copied into the object path. The part's `Content-Type` is ignored for the allowlist. Magic bytes decide.

No client idempotency key in v1. There is no media register RPC, and this package does not add one. A retried call stores a second object.

### 3.1 Base64 is non-preferred

Do not implement `media_upload` as JSON `data_base64` in the Edge splice. The helper keeps `classifyBase64` / `planMediaUploadFromBase64` so the caps stay tested and cannot be loosened by accident.

If a later EVET revisits base64, it still must not change global `MAX_BODY`. It needs its own branch, with both caps applied **before** `atob`:

- Encoded length max `MAX_BASE64 = 6666668` (`4 * ceil(5000000 / 3)`), which is the ~33% expansion.
- Decoded length max `5_000_000`. A string of length 6666668 with no padding decodes to 5000001 bytes and is `bad_size`.
- `data:` URLs are `bad_base64`. Do not strip a prefix and continue.

A JSON body that large already dies on the unchanged 8KB cap. That is intentional.

## 4. Server path and upload

After the gates in §5, `planMediaUpload` takes the multipart file bytes:

1. Length 1..5_000_000 or 400 `bad_size`.
2. `sniffMime` (same predicates as `email-api`). Then `mediaMimeAllowed`. GIF returns `image/gif` and is rejected. SVG returns null and is rejected. Both are 400 `bad_mime_content`.
3. Extension from the sniffed type only: `image/jpeg` → `jpg`, `image/png` → `png`, `image/webp` → `webp`.
4. Path = `{prefix}/{crypto.randomUUID().toLowerCase()}.{ext}`. A bad id is 500 `internal` and does not upload.
5. Existing service-role storage client:

```ts
await svc.storage.from("media").upload(path, bytes, {
  contentType: sniffedMime,
  upsert: false,
  cacheControl: "3600",
});
```

`cacheControl: "3600"` matches today's `uploadToMedia`. `contentType` is the sniffed MIME. Do not pass the browser `File` or its filename.

6. Duplicate (`error === "Duplicate"` or message matching `already exists` / `duplicate`) → 409 `object_exists`. Do not retry with `upsert: true`. Do not return the existing object's URL.
7. Any other storage error → 500 `upload_failed`. Log `media_upload upload_failed` and the server `request_id` only.
8. If the storage client returns a path and it differs from the path we sent → 500 `upload_failed`.

Public URL, host taken only from server `SUPABASE_URL`:

```text
{SUPABASE_URL origin}/storage/v1/object/public/media/{path}
```

Do not call `createSignedUrl`. This PR does not change `media.public`, `file_size_limit`, or `allowed_mime_types`.

Dimension parsing is not a v1 reject. A file whose header is JPEG and whose tail is something else is accepted. That residual matches the email-api sniff.

## 5. Gate order

Multipart `media_upload` follows `GATE_SEQUENCE` in `inert/media_upload.ts`. `content_type_branch` is before either body read. The JSON branch never enters `parse_multipart`.

| Step | Behavior | Failure |
|---|---|---|
| cors | Unchanged `cors()` / `ALLOWED_ORIGINS`. Allow-list is `https://www.asalocal.club` plus optional env `ADMIN_ALLOWED_ORIGIN`. Unknown **present** Origin → 403 and no `Access-Control-Allow-Origin`. Missing Origin is still allowed through and still gets no ACAO. Do not add `https://asalocal.club`. Do not add `Access-Control-Allow-Credentials`. | 403 `origin_not_allowed` |
| method | POST only. OPTIONS keeps today's branch. | 405 `method_not_allowed` |
| env_kill | `ADMIN_API_KILL=1` | 503 `admin_temporarily_disabled` |
| bearer | `Authorization: Bearer` | 401 `missing_bearer` |
| content_type_branch | §2.1, before `req.text()` | 415 `unsupported_media_type` |
| multipart_length_cap | `Content-Length` and `readCapped` at `MEDIA_MULTIPART_MAX`. JSON skips this and uses 8KB. | 413 `payload_too_large` |
| get_user | Existing `getUser` | 401 `invalid_token` |
| is_admin | `is_current_user_admin` | 403 `not_admin`; tech failure 503 |
| role_union | `ROLE_UNION` | 403 `forbidden` |
| parse_multipart | §3. On the JSON branch, `media_upload` is 415 instead of this step. | 400 / 415 |
| prefix_role | §2.3 | 403 `forbidden`; tech failure 503 |
| admin_api_status | Existing service-role RPC | 503 `admin_temporarily_disabled` |
| admin_writes_status | Action is in `WRITE_ACTIONS` | 503 `writes_temporarily_disabled` |
| admin_rate_check | Requires §2.2 | 429 `rate_limited`; RPC error 500 `internal` |
| sniff | Magic bytes | 400 `bad_mime_content` |
| storage_upload | §4 | 409 / 500 |

Success uses the existing `json()` helper: 200, `Content-Type: application/json`, `X-Request-Id`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, plus CORS from `cors()`.

```json
{
  "request_id": "<server uuid>",
  "data": {
    "bucket": "media",
    "path": "venues/<uuid>.jpg",
    "public_url": "https://<SUPABASE_URL host>/storage/v1/object/public/media/venues/<uuid>.jpg",
    "mime": "image/jpeg",
    "bytes": 12345
  }
}
```

Error bodies stay `{ "error": "<code>" }`. Do not attach storage messages or a signed URL.

## 6. Repo splice (applied in this change; not deployed)

File: `CDP3B/edge/admin-api/index.ts`. The ephemeral copy step in `.github/workflows/cdp3c-edge-integration.yml` now copies `inert/media_upload.ts` next to `index.ts` so a future bundle can resolve `./inert/media_upload.ts`. Tests and `admin_rate_check_media_upload.APPLY_NO.sql` stay out of that bundle. This workflow still only `functions serve`s on an ephemeral stack. It does not deploy production.

| Site | Change |
|---|---|
| Imports | `import { ... } from "./inert/media_upload.ts"` — present in the repo. Production behavior changes only when this file is deployed, which this PR does not do. |
| `ROLE_SETS` | add `media_upload:["super_admin","venue_editor","ads"]` |
| `WRITE_ACTIONS` | add `"media_upload"` |
| `LIMITS` | add `media_upload:{min:10,day:100}` |
| Content-Type check (replaced the old `application/json` line) | §2.1 branch. `const MAX_BODY = 8 * 1024` is unchanged. |
| JSON parse | if `action === "media_upload"`, return 415 before `getUser` |
| After role union, before `createClient(URL, SRK, ...)` | prefix role re-check |
| Dispatch | call `planMediaUpload` with the multipart bytes and `svc.storage.from("media").upload`, then `return json(...)` |

Leave `jsr:@supabase/supabase-js@2` as it is. Do not add a second Deno server. Do not add `media_delete`.

Edge EVET order:

1. Replace `admin_rate_check` with the one-token allowlist addition. No storage DDL.
2. Pass both **DEPLOY BLOCKERS** in §8. If either fails, stop. Do not deploy a fallback transport in that same change.
3. Deploy admin-api with the splice, `verify_jwt=true`.
4. Smoke (§7) including teardown of the test object by a harness `remove` that is **not** a new action.
5. Stop if smoke fails. Roll back the function version. Do not drop policies.

## 7. Acceptance matrix

HTTP rows are for the post-splice function. This PR checks the pure rows in `inert/media_upload.test.ts`, the splice contract against `index.ts`, and (when the ephemeral Edge workflow runs) a storage upload that deletes its objects before exit. The pre-splice production hash remains `880dd2c4…`. The repo file no longer hashes to it.

| Case | Result |
|---|---|
| Origin `https://evil.example` POST or OPTIONS | 403 `origin_not_allowed`. No `Access-Control-Allow-Origin`. |
| Origin `https://www.asalocal.club` OPTIONS | 200, ACAO echoes that origin, no Allow-Credentials. |
| No `Authorization` (request reached the function) | 401 `missing_bearer` |
| Authenticated user who is not an admin | 403 `not_admin` |
| Admin `support`, `moderator`, `content_editor`, `crm`, or `analyst` | 403 `forbidden` |
| `venue_editor` + prefix `ads` | 403 `forbidden`, uploader not called |
| `ads` role + prefix `venues` | 403 `forbidden`, uploader not called |
| Granted `super_admin` + either prefix + JPEG/PNG/WebP multipart | 200 and a public URL under that prefix. This is the only grant that exists today. |
| `venue_editor` + `venues` once that role is assigned | 200. The gate already allows it. No migration in this package. |
| Two successes | Two different UUID paths. Client filename is not in the path. |
| GIF bytes, even if the part says `image/png` | 400 `bad_mime_content`, uploader not called |
| SVG or other non-image | 400 `bad_mime_content` |
| File length 5_000_001 | 400 `bad_size` |
| File length 5_000_000 and a JPEG/PNG/WebP header | Allowed by the size gate |
| Multipart `Content-Length` above `5_000_000 + 65_536` | 413 before the body is read |
| JSON body above 8192, any action | 413. `MAX_BODY` unchanged. |
| JSON `action=media_upload` under 8192 | 415 `unsupported_media_type` |
| Multipart field `path`, `bucket`, or `upsert` | 400 `client_path_rejected` |
| Prefix `venues/../x` | 400 `bad_prefix` |
| Multipart `action=counts` | 415 `unsupported_media_type` |
| Storage Duplicate / already exists | 409 `object_exists`. `upsert` was false. |
| `admin_writes_status` false | 503 `writes_temporarily_disabled`, no upload |
| Rate limit exceeded | 429 `rate_limited` |
| Success or error JSON | No service key and no signed URL |
| Non-POST | 405 |
| Content-Type other than JSON or multipart | 415 |

Harness teardown (Edge EVET smoke only): service-role `remove` of the returned path, then object-count delta 0. That call is not added to `ROLE_SETS`.

Secret scan: no JWT-shaped strings and no key assignment. The role name `service_role` is not a secret. Run `CDP3C_package/gates/secret_scan.sh` on this file and `CDP3B/edge/admin-api/inert`.

## 8. DEPLOY BLOCKERS

These two checks must pass before any future deploy EVET. This PR does not run them and does not deploy. A failure is a stop, not a prompt to invent another upload protocol. **DEPLOY_BLOCKERS=open.**

1. **DEPLOY BLOCKER — gateway body size.** Smoke one real JPEG of about 5MB as `multipart/form-data` (file field plus `action` and `prefix`) against the hosted Edge gateway. The Edge limits page does not publish a request-size cap. Memory is 256MB and standard Storage upload is the path under 6MB, but the gateway in front of the function may still reject the body. If it rejects, stop. Do not switch to TUS, signed upload URLs, or a second function in that same change.
2. **DEPLOY BLOCKER — platform `verify_jwt` 401 and CORS.** Send a real request with a missing or invalid JWT so the platform answers 401 before the isolate runs. Record whether that response includes `Access-Control-Allow-Origin`. The function's own 401/403 paths are specified in §5. The platform response is not. Do not deploy until that probe is written down.

No role, bucket, MIME, or policy choice is left open besides these two blockers.

## 9. Explicit non-goals

- Drop or create `media anon insert`, `media anon update`, `media anon delete`, or `media anon read`.
- Change `media.public`, `file_size_limit`, or `allowed_mime_types`.
- Raise global JSON `MAX_BODY`.
- Edit `admin.html`, `CDP3B/admin.html`, `lib/asa-storage`, `email-api`, Resend, Auth SMTP, WSE, or CDP email flows.
- Add a delete or list action, an audit RPC, an idempotency table, or an `admin_role` migration.
- Put the service-role key in any browser response.
