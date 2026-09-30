# STORAGE_MEDIA_UPLOAD_DESIGN

**Status: INERT.** This package is a spec plus an unwired helper. It does not deploy Edge, does not change `CDP3B/edge/admin-api/index.ts`, does not edit `admin.html` or `CDP3B/admin.html`, and does not drop or create storage policies.

```
NO_EDGE_DEPLOY=true
NO_POLICY_DROP=true
NO_ADMIN_HTML_EDIT=true
NO_BROWSER_STORAGE_WIRING=true
MERGE_IS_NOT_DEPLOY=true
```

Merge of this PR leaves production admin-api v16, the `media` bucket, and the admin UI on their current paths. A later **STORAGE_MEDIA_UPLOAD_EDGE** approval is required before any splice or deploy. Admin UI wiring is a further **STORAGE_MEDIA_ADMIN_WIRE** approval. Policy lock is **STORAGE_MEDIA_LOCK_ACTIVATE** and stays blocked until Edge upload has passed smoke.

Evidence used for this spec (read-only, 2026-09-30):

- Repo and live function body: `CDP3B/edge/admin-api/index.ts` SHA-256 `880dd2c4b75814949aff35d9e6a478dbfc9563da74137c2cfc7093e3482fae7b`. Hosted slug `admin-api` is ACTIVE version 16, `verify_jwt=true`, same source text (bundle hash differs from the raw file hash).
- Live `admin_rate_check` allowlist ends at `member_360_by_ref`. It does not contain `media_upload`.
- Live `_can_edit_venues` = active admin with `super_admin` or `venue_editor`. Live `_can_edit_ads` = active admin with `super_admin` or `ads`.
- `current_user_has_admin_role(role_name admin_role)` calls `_has_admin_role`, which requires `admin_users.active` and that role. Same active-user join as the `_can_edit_*` helpers.
- `email-api` `sniffMime` and `asset_upload` are the byte and upload pattern. Email stays on GIF-inclusive 2MB draft assets. This design does not edit `email-api`.

## 1. What v1 adds

One write action on the existing `admin-api` function:

| Item | Locked value |
|---|---|
| Action | `media_upload` |
| Transport | Existing `POST` JSON `{ action, params }` |
| JWT | Platform `verify_jwt=true` stays. Do not pass `--no-verify-jwt`. |
| Caller | Authenticated admin JWT. `service_role` stays in Edge env `SUPABASE_SERVICE_ROLE_KEY` and is never a response field, log line, or client argument. |
| Bucket | Hard-coded `media`. Client bucket is rejected. |
| Prefix | `venues` or `ads` only. Basename is a server UUID. |
| MIME | `image/jpeg`, `image/png`, `image/webp` by magic bytes. GIF, SVG, and every other type are rejected. |
| Size | 5_000_000 decoded bytes maximum. |
| Overwrite | `upsert: false`. Duplicate path → 409 `object_exists`. |
| Delete | No `media_delete` action and no `storage.remove` in v1. |
| Public read | `media.public` stays true. Public URL only. No signed URL. |
| Policies | The four `media anon *` policies stay until a later lock EVET. |

`inert/media_upload.ts` is the reference implementation of the pure checks and of `planMediaUpload`. `index.ts` must not import it until the Edge EVET.

## 2. Discovered constraints (locked, not open)

### 2.1 Body cap is 8KB today

`index.ts` sets `MAX_BODY = 8 * 1024` and rejects `raw.length > MAX_BODY` before it knows `action`. A 5MB object is `MAX_BASE64 = 6666668` characters (`4 * ceil(5000000 / 3)`). Compact JSON around that string needs a few dozen extra bytes. Pretty-printed bodies are not supported.

Future splice, only when `action` is the first key:

1. If `Content-Length` is present and greater than `MEDIA_MAX_RAW` (6666668 + 1024), return 413 `payload_too_large` before `req.text()`.
2. Read the body.
3. `classifyRawBody` (`inert/media_upload.ts`):
   - length ≤ 8192 → existing parse path for every current action (unchanged).
   - length > `MEDIA_MAX_RAW` → 413, do not `JSON.parse`.
   - otherwise parse only when the first 128 bytes match `{"action":"media_upload"` with optional whitespace. Any other oversized body, including `media_upload` with `params` before `action`, is 413 and is not parsed.
4. After parse, if `action !== "media_upload"`, return 413.

Existing actions keep the 8KB ceiling. `media_upload` clients must send compact JSON with `action` first.

Hosted Edge limits (docs, 2026-09-30) list 256MB memory and 2s CPU, and standard Storage upload is the recommended path under 6MB. They do not list a gateway body cap. See §8.

### 2.2 `admin_rate_check` will 500 a new action name

The handler always calls `admin_rate_check(p_actor, p_action, ...)`. The live function raises `bad action` (`22023`) unless `p_action` is in a fixed list. `mapRpcError` does not know that string, and the handler maps any rate-limit RPC error to 500 `internal`.

Deploying the TypeScript splice without extending that list makes every `media_upload` return 500 and write nothing. Extending the list is a `CREATE OR REPLACE` of `public.admin_rate_check` only. It is not a storage policy change. It is still **not applied by this PR**.

The replace must keep every action string that is in the function today and add only `media_upload`. It must not DROP the function (grants stay on replace). It must not add `q_member_consent` or `marketing_readiness_check` in the same change: those two names are already in the Edge `LIMITS` map and are already absent from the SQL list, so they 500 today. That gap is pre-existing and out of scope.

`admin_rate_events.action` is unbounded `text`. No column change.

Proposed allowlist token, inside the existing `IN (...)` list:

```text
'media_upload'
```

Limits locked for that name: `min: 10` (60-second window, same RPC), `day: 100`. At 5MB that is 50MB/minute and 500MB/day per actor. `media_upload` is a `WRITE_ACTIONS` member, so `admin_writes_status` still applies.

### 2.3 Roles are the live venue and ads editors

`ROLE_SETS` has no venue or ads action today. `content_editor` edits site content (`_can_edit_content`), not venue or ad images. `ANY_ADMIN` would let support, moderator, crm, and analyst upload. Do not use it.

Coarse gate, so the existing role loop admits the editors before the prefix split:

```text
ROLE_SETS.media_upload = ["super_admin", "venue_editor", "ads"]
WRITE_ACTIONS adds "media_upload"
```

After `validate`, and before the service-role client is used for the upload, re-check with the same `rpcBool(userClient, "current_user_has_admin_role", { role_name })` loop:

| `params.prefix` | Any of these roles | Live equivalent |
|---|---|---|
| `venues` | `super_admin`, `venue_editor` | `_can_edit_venues` |
| `ads` | `super_admin`, `ads` | `_can_edit_ads` |

`role_name` is the existing `admin_role` enum. Both labels already exist. A `venue_editor` who asks for `ads` gets 403 `forbidden` and the storage client is not asked to upload. A `content_editor` fails the coarse union with 403 `forbidden` even if the prefix is valid.

There is no new RPC and no new enum value.

## 3. Request

`Content-Type` must include `application/json` (existing 415). Body:

```json
{
  "action": "media_upload",
  "params": {
    "prefix": "venues",
    "data_base64": "<standard base64, no data: URL, no whitespace>"
  }
}
```

`prefix` is exactly `venues` or `ads`.

`params` keys are exactly `prefix` and `data_base64`.

| Extra key | Error |
|---|---|
| `bucket`, `path`, `object_path`, `objectPath`, `filename`, `file_name`, `fileName`, `name`, `key`, `content_type`, `contentType`, `mime`, `upsert`, `cacheControl`, `cache_control` | 400 `client_path_rejected` |
| any other key | 400 `unknown_field` |
| `params` not a plain object | 400 `bad_input` |
| bad or missing prefix | 400 `bad_prefix` |

Base64 rules (`classifyBase64`, before `atob`):

- Alphabet `A–Z a–z 0–9 + /` and padding only at the end. Length multiple of 4. Otherwise 400 `bad_base64`.
- Decoded length `<= 0` or `> 5000000`, or encoded length `> 6666668`, → 400 `bad_size`.
- A string of length 6666668 can decode to 5000001 bytes when it has no padding. Size uses the padding formula, not the character count alone.
- `data:image/...;base64,` is `bad_base64`. Do not strip a prefix and continue.

No client idempotency key in v1. Other admin writes persist idempotency inside SQL RPCs. There is no media register RPC, and this package does not add one. A retried call stores a second object. That is accepted until a later audit EVET. Do not pretend a client UUID is idempotent if it is not stored.

## 4. Server path and upload

After the gates in §5, `planMediaUpload`:

1. `decodeBase64Strict`.
2. `sniffMime` (same predicates as `email-api`). Then `mediaMimeAllowed`. GIF returns `image/gif` and is rejected. SVG and HTML return null and are rejected. Both are 400 `bad_mime_content`. The HTTP `Content-Type` of the JSON request is not an image type, and a `contentType` field inside `params` is rejected in §3. Bytes win.
3. Extension from the sniffed type only: `image/jpeg` → `jpg`, `image/png` → `png`, `image/webp` → `webp`.
4. Path = `{prefix}/{crypto.randomUUID().toLowerCase()}.{ext}`. UUID must match the admin-api UUID pattern. A bad id is 500 `internal` and does not upload.
5. Call the existing service-role storage client:

```ts
await svc.storage.from("media").upload(path, bytes, {
  contentType: sniffedMime,
  upsert: false,
  cacheControl: "3600",
});
```

`cacheControl: "3600"` matches today's `uploadToMedia`. `contentType` is the sniffed MIME so it agrees with the extension. Do not pass the browser `File`.

6. Duplicate (`error === "Duplicate"` or message matching `already exists` / `duplicate`) → 409 `object_exists`. Do not retry with `upsert: true`. Do not download the existing object and do not return its URL.
7. Any other storage error → 500 `upload_failed`. Log `media_upload upload_failed` and the server `request_id` only. Do not log the storage error object, the bytes, the JWT, or the service key.
8. If the client returns a path and it differs from the path we sent → 500 `upload_failed`.

Public URL, host taken only from server `SUPABASE_URL` (origin only; no user, query, or path):

```text
{SUPABASE_URL origin}/storage/v1/object/public/media/{path}
```

Example shape:

```text
https://tosqsabuaomgqjtogdrn.supabase.co/storage/v1/object/public/media/venues/550e8400-e29b-41d4-a716-446655440000.jpg
```

Do not call `createSignedUrl`. Bucket flag `public=true` is what makes GET work. This PR does not change that flag and does not set `file_size_limit` or `allowed_mime_types` (those were a separate metadata option in the storage contract).

Dimension parsing is an email-api requirement because width and height are stored on `email_assets`. v1 has no register row, so unreadable dimensions are not a reject. A file whose header is JPEG and whose tail is something else is accepted. That residual matches the email-api sniff, which also stops at the header.

## 5. Gate order

The future handler follows `GATE_SEQUENCE` in `inert/media_upload.ts`. Existing steps stay in their current order; media-only steps are insertions.

| Step | Behavior | Failure |
|---|---|---|
| cors | Unchanged `cors()` / `ALLOWED_ORIGINS`. Allow-list is `https://www.asalocal.club` plus optional env `ADMIN_ALLOWED_ORIGIN` (one extra origin). Unknown **present** Origin → 403 and no `Access-Control-Allow-Origin`. Missing Origin is still allowed through and still gets no ACAO. Do not add `https://asalocal.club` (that name is on email-api, not admin-api). Do not add `Access-Control-Allow-Credentials`. | 403 `origin_not_allowed` |
| method | POST only. OPTIONS keeps today's branch (bad origin 403 with an empty body; allowed origin 200 `ok`). | 405 `method_not_allowed` |
| env_kill | `ADMIN_API_KILL=1` | 503 `admin_temporarily_disabled` |
| bearer | `Authorization: Bearer` | 401 `missing_bearer` |
| content_type | JSON | 415 `unsupported_media_type` |
| body_limit | §2.1 | 413 `payload_too_large` |
| json_action | `action` must be in `ROLE_SETS` | 400 `bad_json` / `unknown_action` |
| get_user | Existing `getUser` on the anon client + caller JWT | 401 `invalid_token` |
| is_admin | `is_current_user_admin` | 403 `not_admin`; tech failure 503 `admin_temporarily_disabled` |
| role_union | Existing loop over `ROLE_UNION` | 403 `forbidden` |
| validate_params | §3, cheap base64 checks, no `atob` of a 5MB buffer yet | 400 as listed |
| prefix_role | §2.3, still the user JWT client | 403 `forbidden`; tech failure 503 |
| admin_api_status | Existing service-role RPC | 503 `admin_temporarily_disabled` |
| admin_writes_status | Because the action is in `WRITE_ACTIONS` | 503 `writes_temporarily_disabled` |
| admin_rate_check | Requires §2.2 already applied | 429 `rate_limited`; RPC error 500 `internal` |
| decode_sniff | `planMediaUpload` through MIME check | 400 `bad_size` / `bad_mime_content` |
| storage_upload | §4 | 409 / 500 |

Platform `verify_jwt=true` may answer 401 before the isolate runs. The function-level 401 above is what the splice itself returns when the request reaches it. Header behavior of the platform 401 is not specified here (§8).

Success uses the existing `json()` helper: 200, `Content-Type: application/json`, `X-Request-Id`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, plus the CORS headers from `cors()`.

```json
{
  "request_id": "<server uuid, existing rid()>",
  "data": {
    "bucket": "media",
    "path": "venues/<uuid>.jpg",
    "public_url": "https://<SUPABASE_URL host>/storage/v1/object/public/media/venues/<uuid>.jpg",
    "mime": "image/jpeg",
    "bytes": 12345
  }
}
```

Error bodies stay `{ "error": "<code>" }` with no `request_id` field (the header still carries it). Do not attach `ok`, storage messages, or a signed URL.

## 6. Future splice map (do not apply in this PR)

File: `CDP3B/edge/admin-api/index.ts`. Deploy copy remains the single-file copy in `.github/workflows/cdp3c-edge-integration.yml` (`cp` of `index.ts` only). Do not deploy the `inert/` directory as the function bundle until the Edge EVET, and even then only import the helper. Do not `cp -a` the folder.

| Site | Change |
|---|---|
| Imports | `import { ... } from "./inert/media_upload.ts"` — this line is the moment production behavior can change. It is absent now. |
| `ROLE_SETS` | add `media_upload:["super_admin","venue_editor","ads"]` |
| `WRITE_ACTIONS` | add `"media_upload"` |
| `LIMITS` | add `media_upload:{min:10,day:100}` |
| Body read (~line 37) | replace the single `MAX_BODY` reject with §2.1 |
| After `validate` (~line 43), before `createClient(URL, SRK, ...)` | prefix role re-check |
| Dispatch `else if` chain, before `if (err)` | call `planMediaUpload` with `svc.storage.from("media").upload` wrapped as the injected uploader, then `return json(...)` |
| `validate()` before the final `unknown_action` | `validateMediaParams` |

Leave `jsr:@supabase/supabase-js@2` as it is. Do not add a second Deno server. Do not add `media_delete`.

Edge EVET order:

1. Replace `admin_rate_check` with the one-token allowlist addition. Assert the previous names are still present and `media_upload` is present. No storage DDL.
2. Deploy admin-api with the splice, `verify_jwt=true`.
3. Smoke (§7) including a real 5MB JPEG and teardown of the test object by a harness `remove` that is **not** a new action.
4. Stop if smoke fails. Roll back the function version. Do not drop policies; today's browser `uploadToMedia` still works while the anon insert policy exists.

## 7. Acceptance matrix

HTTP rows are for the post-splice function. This PR checks the pure rows in `inert/media_upload.test.ts` and checks that `index.ts` still hashes to `880dd2c4…`.

| Case | Result |
|---|---|
| Origin `https://evil.example` POST or OPTIONS | 403 `origin_not_allowed`. Response has no `Access-Control-Allow-Origin`. |
| Origin `https://www.asalocal.club` OPTIONS | 200, ACAO echoes that origin, no Allow-Credentials. |
| No `Authorization` (request reached the function) | 401 `missing_bearer` |
| Authenticated user who is not an admin | 403 `not_admin` |
| Admin `support`, `moderator`, `content_editor`, `crm`, or `analyst` | 403 `forbidden` |
| `venue_editor` + prefix `ads` | 403 `forbidden`, uploader not called |
| `ads` role + prefix `venues` | 403 `forbidden`, uploader not called |
| `venue_editor` + `venues` + JPEG bytes | 200, `public_url` path `/object/public/media/venues/<uuid>.jpg`, `mime` `image/jpeg` |
| `ads` role + `ads` + PNG | 200, `.../ads/<uuid>.png` |
| `super_admin` + either prefix + WebP | 200, extension `webp` |
| Two successes | Two different UUID paths |
| GIF magic, including a client claim of `image/png` | 400 `bad_mime_content`, uploader not called |
| SVG or other non-image | 400 `bad_mime_content` |
| Decoded length 5000001 | 400 `bad_size` |
| Decoded length 5000000 and JPEG/PNG/WebP header | Allowed by the size gate |
| `params.path`, `params.bucket`, or `params.upsert` | 400 `client_path_rejected` |
| Prefix `venues/../x` or `Venues` | 400 `bad_prefix` |
| Storage Duplicate / already exists | 409 `object_exists`. Body does not contain the storage message. `upsert` was false. |
| `admin_writes_status` false | 503 `writes_temporarily_disabled`, no upload |
| Rate limit exceeded | 429 `rate_limited` |
| Success or error JSON | No `service_role` value, no service key, no signed URL |
| Non-POST | 405 |
| Non-JSON content type | 415 |

Harness teardown (Edge EVET smoke only): service-role `remove` of the returned path, then object-count delta 0. That call is not added to `ROLE_SETS`.

Secret scan for this package: no JWT-shaped strings and no key assignment. The role name `service_role` is not a secret. Run `CDP3C_package/gates/secret_scan.sh` on `CDP3B/edge/admin-api/MEDIA_UPLOAD_DESIGN.md` and `CDP3B/edge/admin-api/inert`.

## 8. UNKNOWN

1. **Gateway body ceiling.** The Edge limits page does not publish a maximum request size. Memory (256MB) and the 6MB standard-upload guidance fit a 5MB object, but the JSON body is about 6.67MB of base64 plus a small envelope. The Edge EVET must smoke one real 5MB JPEG. If the gateway rejects it before the function, stop. Do not switch to TUS, signed upload URLs, or a second function in that same change.
2. **Platform `verify_jwt` 401 headers.** Whether that early 401 includes `Access-Control-Allow-Origin` is outside this function. The function's own 401/403 paths are specified in §5. This PR does not probe production to find out.

No other role, bucket, MIME, or policy choice is left open for the Edge EVET.

## 9. Explicit non-goals

- Drop or create `media anon insert`, `media anon update`, `media anon delete`, or `media anon read`.
- Change `media.public`, `file_size_limit`, or `allowed_mime_types`.
- Edit `admin.html`, `CDP3B/admin.html`, `lib/asa-storage`, `email-api`, Resend, Auth SMTP, WSE, or CDP email flows.
- Add a delete or list action, an audit RPC, or an idempotency table.
- Put the service-role key in any browser response.
