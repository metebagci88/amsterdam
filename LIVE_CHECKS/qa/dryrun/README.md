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

## Expected result on origin/main (cfdf79e)

`pass=158 fail=2 skip=2`, with every write undone (`cleanup/all-writes-undone-via-ui` PASS). The only items left in
`cleanup` are the informational `archived_by_ui` trips and the `trip_plan_versions` snapshot row.

- **2 FAIL: a real product defect, not a stub artifact.** `persist/plan-tab-shows-saved-plan-on-new-device` and
  `persist/saved-plan-not-overwritten-by-plan-tab`. When a trip with a saved plan is opened on another device,
  `TripSync.hydrate` copies the plan into `asa:ams:dayven`. The page's in-memory `dayVenues` was already loaded at
  script start, so the Plan tab auto-generates a new plan and TripSync autosaves it over the user's saved plan. Live
  should reproduce this. If the operator accepts it for now, pass
  `WP6_XFAIL=persist/plan-tab-shows-saved-plan-on-new-device,persist/saved-plan-not-overwritten-by-plan-tab`.
- **2 SKIP:** `member-ro/*/wp5-name-completion`, because `window.ASA_NAME` is absent until WP5 ships.

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
