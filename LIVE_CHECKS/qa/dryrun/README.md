# WP6 live acceptance — local dry run

`LIVE_CHECKS/qa/wp6_live.mjs` is the İş Paketi 6 end-to-end acceptance script that the QA runner executes against
production with the two dedicated QA accounts. This directory lets you run the **same, unmodified script** against a
local static server of `origin/main`, with every external dependency stubbed. It catches selector and flow bugs before
a live run. It does not replace the live run, and it never reaches production, Supabase or any CDN.

## Command

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
TAILWIND_NODE_PATH=<dir>/node_modules \
bash LIVE_CHECKS/qa/dryrun/run_dryrun.sh
```

- `TAILWIND_NODE_PATH` is a `node_modules` directory containing `tailwindcss@3.4.17`, `@tailwindcss/forms`,
  `@tailwindcss/container-queries` and `postcss`, the same dependencies `WP4_package/tests/tailwind_css.mjs` uses.
  To create one: `npm i --prefix <dir> tailwindcss@3.4.17 @tailwindcss/forms @tailwindcss/container-queries postcss`.
  Without it the pages run unstyled and the overflow and click checks are not meaningful.
- The script uses the real Playwright at `/opt/node-tools/node_modules/playwright` (1.56.1, the version CI pins). Set
  `PW_REAL` to point at a different one.
- Optional settings: `DRY_ROOT=<existing checkout>` (by default the script runs `git worktree add origin/main` into a
  temp dir and removes it on exit), `DRY_WORK=<scratch dir>`, and
  `DRY_FAULTS="DELETE:favorites,rpc:trip_save"`, which makes the stub return HTTP 500 for those calls so you can
  exercise the cleanup path.
- The script prints the normal `WP6_LIVE_SUMMARY` and per-check output, then `DRYRUN_EXIT=<rc> result=<path>`. It
  writes `wp6_live_result.json` and `dry_state.json` (the final stub DB, with e-mails redacted) to `$DRY_WORK/out`.
  A full run takes about 6 minutes.

## How it works

| File | Role |
|---|---|
| `run_dryrun.sh` | Serves `origin/main` with `python3 -m http.server`. Creates a fake `$QA_DEPS/node_modules/playwright/index.js` that loads the shim, throw-away random passwords in `$RUNNER_TEMP/qa_secrets.env`, and two fake `.invalid` e-mails built at runtime. Then runs `node LIVE_CHECKS/qa/wp6_live.mjs`. |
| `playwright_shim.cjs` | Wraps the real `chromium.launch`. Every `newContext()` gets a `route("**/*")` that serves the local origin and answers everything else locally (see the stub table below). |
| `supabase_stub.js` | Stand-in for `@supabase/supabase-js@2`, extended from `WP4_package/tests/stubs/supabase_stub.js`. It makes real HTTP calls to `https://tosqsabuaomgqjtogdrn.supabase.co`: select is `GET`, insert/upsert is `POST`, update is `PATCH`, delete is `DELETE`, and rpc is `POST /rest/v1/rpc/<fn>`, each sent with `apikey` and `Authorization: Bearer`. The shim answers these calls from one in-memory store **shared by all browser contexts**, which makes the cross-account isolation and the "new device" persistence checks real. The stub persists the session in `localStorage["sb-<ref>-auth-token"]` the same way supabase-js does. |

What the shim stubs:

| Request | Answer |
|---|---|
| `cdn.jsdelivr.net` supabase-js | `supabase_stub.js` |
| `*.supabase.co /auth/v1/*` | `token?grant_type=password` succeeds for any e-mail with a non-empty password. The user is `{ id: deterministic uuid(e-mail), email }`. |
| `*.supabase.co /rest/v1/<table>` | Filters `eq neq is in lt lte gt gte`, plus `order`. RLS by `user_id` on `members`, `trips`, `favorites`, `trip_plan_versions` and `comments`. `favorites.user_id` is filled from the session (this emulates the live trigger). Upsert supports `onConflict` and `ignoreDuplicates`. |
| `*.supabase.co /rest/v1/rpc/*` | `member_upsert_profile`, `consent_get_my_state` (`welcome_service_email: true`, the other keys `not_configured`, as WP4 observed live), `service_pref_set` (with WP4 validation and idempotency), `trip_save` and `trip_snapshot_plan` (owner check plus a revision conflict), `log_city_view`, `log_behavior_event`, `similar_brains`. Unknown functions return 404. |
| `cdn.tailwindcss.com` | The page's own `tailwind.config`, compiled once per page (home and Amsterdam) with `WP4_package/tests/tailwind_css.mjs`. |
| `unpkg.com` leaflet | `WP3_package/tests/stubs/leaflet_stub.js`, plus layer tracking (`LayerGroup.getLayers()`) so the map-equals-list checks can count markers. |
| `fonts.googleapis.com` Material Symbols | A CSS rule that emulates the icon font's 1em glyph boxes. Without it, ligature words such as `arrow_back` render as wide text and cause a false horizontal overflow at 360/390/768. |
| images, fonts, other CSS and JS | Empty responses. |

## Expected result

### With the WP6 sync-integrity fix (branch `wp6-plan-hydrate-fix`)

`verdict PASS`, `fail=0`, every write undone (`cleanup/all-writes-undone-via-ui` PASS). `cleanup` holds only the
informational `archived_by_ui` trips (the QA trip, the second member's trip and the WP6 new-trip check trip
2099-03-10..12), the `trip_plan_versions` snapshot row and the WP5 `names_set_by_wp6` note.

The WP6 checks (all PASS after the fix; see the matrix in `wp6_live.mjs`):

| Check | What it proves |
|---|---|
| `sync/browse-ref-keeps-accommodation` | A List "Neredesin?" neighbourhood does not rewrite the trip's accommodation (no `trip_save`). |
| `sync/conflict-server-plan-kept`, `sync/conflict-local-copy-offered`, `sync/conflict-restore-explicit` | Device B saves; the stale device's later edit gets a revision conflict. The newer server plan stays, `#tripSyncNotice` (role=alert, `data-reason=conflict`) offers the stale device's version (kept in `asa:ams:plan_sync`), and only "Bu cihazdaki sürümü geri yükle" uploads it. |
| `sync/two-tabs-stale-tab-does-not-overwrite`, `sync/two-tabs-discard-keeps-server-plan` | The same between two tabs of one browser (shared storage); "Sunucudaki planla devam et" writes nothing. |
| `sync/trip-save-never-overlaps` | The member's main page never has two `trip_save` requests in flight (weak in the dry run: no latency). |
| `sync/new-trip-starts-empty`, `sync/new-trip-archived-via-ui` | A new trip opened on the device of the QA trip starts empty locally and on the server (forced flush), then is archived. |
| `sync/guest-import-adopts-db-trip`, `sync/guest-import-no-duplicate-on-trip-param` | A guest search overlapping the QA trip with other dates + city login opens the DB trip with its own dates (user told, nothing pushed, no new trip); a `?trip=` page never runs the guest import. |
| `sync/storage-full-blocks-upload` | `asa:ams:dayven` writes throw QuotaExceededError: the DB plan is shown from memory, uploads are blocked, the user is told. |
| `sync/plan-tab-open-before-trip-load` | Plan tab opened while the `?trip=` fetch is delayed 2.5 s (`page.route` + `route.fallback()`, so the shim still answers): trip days, saved plan, dates; no kept copy, no upload. |
| `fav/seed-defaults-not-uploaded`, `fav/logout-clears-account-favourites`, `fav/not-carried-to-other-account` | Flow F on a device WITHOUT preseeded favourites: the 7 seeds never reach an account, logout clears the account's favourites on the device, the next account gets nothing. |
| `fav/deleted-elsewhere-stays-deleted` | Favourite X removed on one device does not come back when an older device that held X reloads. |

On the code before the fix (`e1bfd04` + `d5ebcfd`) the dry run reproduces every defect: all of the above FAIL except
`sync/trip-save-never-overlaps`, and the cascade also fails `persist/plan-restored-from-trip-to-device`,
`persist/plan-tab-shows-saved-plan-on-new-device` and `persist/saved-plan-not-overwritten-by-plan-tab` (the guest
import rewrote the QA trip's dates). Regressions that write are undone in-run through the UI (`fav/*/unexpected-
favourites-removed-via-ui`, the 2099 trip sweep), so `cleanup/all-writes-undone-via-ui` still PASSes; a QA trip whose
dates a regression rewrote is listed as `dates_changed_by_guest_import`.

### Before WP6 (origin/main cfdf79e, historical)

`pass=158 fail=2 skip=2`. The 2 FAILs (`persist/plan-tab-shows-saved-plan-on-new-device`,
`persist/saved-plan-not-overwritten-by-plan-tab`) were the plan-hydration defect fixed by `d5ebcfd`; the 2 SKIPs were
`member-ro/*/wp5-name-completion` before WP5 shipped.

## Stub limitations (things only the live run can tell)

- **Policies:** RLS, triggers and RPC bodies are emulations, not the production policies. In particular, the stub
  does not model admin-role read policies, so the `iso/*` checks only prove the page logic here.
- **Map rendering:** no real Leaflet DOM (`domPins=0`). Markers are counted from `MAP.layer.getLayers()`, which also
  works with real Leaflet.
- **Network realism:** no latency, rate limits, e-mail sending, real CDN or font metrics (the icon font is
  emulated), and no venue DB rows. The embedded venue list (109 Amsterdam venues) is used instead of the venues
  table.
- **Session revocation:** `signOut` only drops the stub token. Real supabase-js signs out globally and revokes the
  user's other refresh tokens.
