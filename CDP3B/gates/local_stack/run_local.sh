#!/usr/bin/env bash
# ASALOCAL · CDP-3B · docker-free LOCAL save-draft stack (test double; never deployed; never contacts production).
#   DB  : PGlite 0.3.16 (PostgreSQL 17, WASM, in-memory) on 127.0.0.1 with the REAL baseline_fixture + CDP3B_up + patch
#   Edge: the REAL, unmodified edge/email-api/index.ts in Deno; only std serve + supabase-js are swapped by an import map
#         (shim_serve.ts = 127.0.0.1 + verify_jwt gateway double; shim_supabase.ts = GoTrue/PostgREST double)
#   then runs T1 gates/e2e_save_draft.ts (deno test, unmodified) and T2 gates/admin_save_draft_ui.mjs twice:
#   t2   = SAVE_DRAFT_UI_MODE=local (GoTrue double inside the test)
#   t2ci = CI (hybrid) code path: /auth/v1 via route.fetch + apikey/anon-Bearer rewrite to gotrue_double.mjs, which like
#          local Kong rejects the production anon key; email-api via route.fetch to the real handler (as in CI).
#   t2lag = t2 with every 'list' response delayed after the router logged it (SAVE_DRAFT_UI_LIST_LAG_MS, default 250):
#          proves the T2 waits follow the rendered page, not the router log (flake guard; also part of 'all').
# Prerequisites (free, pinned): node >= 20 that can resolve @electric-sql/pglite@0.3.16, @electric-sql/pglite-socket@0.0.22,
#   playwright@1.56.1 (+ Chromium) and @supabase/supabase-js@2.117.2 from CDP3B (e.g. a node_modules next to CDP3B, or a
#   NODE_OPTIONS resolve hook); deno 1.x as $DENO or on PATH.
# Optional: LOCAL_DENO_MIRROR=github remaps deno.land std/x modules to raw.githubusercontent.com (networks blocking deno.land).
# Usage: bash gates/local_stack/run_local.sh [t1|t2|t2ci|t2lag|all]      Output: LOCAL_SAVE_DRAFT_PASS or GATE_FAILED:<step>
# Tokens are random per run, live only in a 0700 temp dir that is deleted on exit, and are masked in any printed log.
set -euo pipefail
WHAT="${1:-all}"
HERE="$(cd "$(dirname "$0")" && pwd)"; CDP3B="$(cd "$HERE/../.." && pwd)"; cd "$CDP3B"
DENO="${DENO:-deno}"
command -v node >/dev/null 2>&1 || { echo "GATE_FAILED:local_node_missing"; exit 1; }
command -v "$DENO" >/dev/null 2>&1 || { echo "GATE_FAILED:local_deno_missing"; exit 1; }
WORK="$(mktemp -d)"; chmod 700 "$WORK"
DB_PID=""; EDGE_PID=""; GT_PID=""
mask(){ node -e 'const fs=require("fs");let t=fs.readFileSync(0,"utf8");for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){const v=l.split("=").slice(1).join("=");if(v.length>=8)t=t.split(v).join("<redacted>");}process.stdout.write(t)' "$WORK/local.env" 2>/dev/null || cat; }
cleanup(){
  for p in "$GT_PID" "$EDGE_PID" "$DB_PID"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for p in "$GT_PID" "$EDGE_PID" "$DB_PID"; do [ -n "$p" ] && { for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done; kill -9 "$p" 2>/dev/null || true; }; done
  rm -rf "$WORK"
}
trap cleanup EXIT
fail(){ echo "GATE_FAILED:$1"; [ -f "$WORK/$2" ] && { echo "--- $2 (tail, masked) ---" 1>&2; tail -n 60 "$WORK/$2" | mask 1>&2; }; exit 1; }
port(){ node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})'; }

# 1) DB double
DBPORT="$(port)"
node gates/local_stack/db_server.mjs "$CDP3B" "$DBPORT" "$WORK/local.env" >"$WORK/db.log" 2>&1 & DB_PID=$!
for i in $(seq 1 120); do grep -q '^LOCAL_DB_READY' "$WORK/db.log" 2>/dev/null && break; kill -0 "$DB_PID" 2>/dev/null || fail local_db_start db.log; sleep 0.5; done
grep -q '^LOCAL_DB_READY' "$WORK/db.log" || fail local_db_timeout db.log
set -a; . "$WORK/local.env"; set +a

# 2) import map: two shims always; optional GitHub mirror for deno.land modules
EDGEPORT="$(port)"
{
  echo '{ "imports": {'
  echo "  \"https://deno.land/std@0.224.0/http/server.ts\": \"file://$HERE/shim_serve.ts\","
  if [ "${LOCAL_DENO_MIRROR:-}" = "github" ]; then
    echo '  "https://deno.land/std@0.224.0/": "https://raw.githubusercontent.com/denoland/deno_std/0.224.0/",'
    echo '  "https://deno.land/std@0.214.0/": "https://raw.githubusercontent.com/denoland/deno_std/0.214.0/",'
    echo '  "https://deno.land/x/deno_dom@v0.1.45/": "https://raw.githubusercontent.com/b-fuze/deno-dom/v0.1.45/",'
    echo '  "https://deno.land/x/postgres@v0.19.3/": "https://raw.githubusercontent.com/denodrivers/postgres/v0.19.3/",'
  fi
  echo "  \"https://esm.sh/@supabase/supabase-js@2.45.4\": \"file://$HERE/shim_supabase.ts\""
  echo '} }'
} > "$WORK/import_map.json"

# 3) REAL email-api handler (EMAIL_API_E2E unset -> production-inert seams)
env -u EMAIL_API_E2E LOCAL_EDGE_PORT="$EDGEPORT" LOCAL_DB_URL="$SUPABASE_DB_URL" SUPABASE_URL="http://127.0.0.1:$EDGEPORT" \
  SUPABASE_ANON_KEY=x SUPABASE_SERVICE_ROLE_KEY=x \
  "$DENO" run --quiet --import-map="$WORK/import_map.json" --allow-net=127.0.0.1 --allow-env --allow-read="$CDP3B" \
  gates/local_stack/edge_server.ts >"$WORK/edge.log" 2>&1 & EDGE_PID=$!
for i in $(seq 1 240); do grep -q '^LOCAL_EDGE_READY' "$WORK/edge.log" 2>/dev/null && break; kill -0 "$EDGE_PID" 2>/dev/null || fail local_edge_start edge.log; sleep 0.5; done
grep -q '^LOCAL_EDGE_READY' "$WORK/edge.log" || fail local_edge_timeout edge.log
export EMAIL_API_URL="http://127.0.0.1:$EDGEPORT/functions/v1/email-api"

# 4) T1 — the CI backend e2e file, unmodified
if [ "$WHAT" = "t1" ] || [ "$WHAT" = "all" ]; then
  NO_COLOR=1 "$DENO" test --import-map="$WORK/import_map.json" --allow-net=127.0.0.1 --allow-env --allow-read=. gates/e2e_save_draft.ts >"$WORK/t1.log" 2>&1 || fail local_t1 t1.log
  grep -Eq '^ok \| [0-9]+ passed \| 0 failed' "$WORK/t1.log" || fail local_t1_summary t1.log
  grep -E '^SD[0-9]+: .* ok|^ok \|' "$WORK/t1.log" | mask || true
fi
# 5) T2 — Playwright UI against the same stack (local GoTrue/PostgREST doubles inside the test)
if [ "$WHAT" = "t2" ] || [ "$WHAT" = "all" ]; then
  SAVE_DRAFT_UI_MODE=local node gates/admin_save_draft_ui.mjs >"$WORK/t2.log" 2>&1 || fail local_t2 t2.log
  grep -q '^ADMIN_SAVE_DRAFT_UI_OK' "$WORK/t2.log" || fail local_t2_summary t2.log
  grep -E '^(PASS|ADMIN_SAVE_DRAFT_UI_OK)' "$WORK/t2.log" | mask || true
fi
# 5a) T2 with delayed 'list' responses (logged first, delivered later) — must still pass
if [ "$WHAT" = "t2lag" ] || [ "$WHAT" = "all" ]; then
  LAG="${SAVE_DRAFT_UI_LIST_LAG_MS:-250}"
  SAVE_DRAFT_UI_MODE=local SAVE_DRAFT_UI_LIST_LAG_MS="$LAG" node gates/admin_save_draft_ui.mjs >"$WORK/t2lag.log" 2>&1 || fail local_t2lag t2lag.log
  grep -q '^ADMIN_SAVE_DRAFT_UI_OK' "$WORK/t2lag.log" || fail local_t2lag_summary t2lag.log
  echo "T2 (list responses delayed ${LAG} ms): $(grep -c '^PASS' "$WORK/t2lag.log") checks PASS"
fi
# 5b) T2 in its CI (hybrid) mode against the Kong/GoTrue double
if [ "$WHAT" = "t2ci" ] || [ "$WHAT" = "all" ]; then
  export ANON_KEY="local-anon-$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
  GTPORT="$(port)"
  node gates/local_stack/gotrue_double.mjs "$GTPORT" >"$WORK/gotrue.log" 2>&1 & GT_PID=$!
  for i in $(seq 1 40); do grep -q '^GOTRUE_DOUBLE_READY' "$WORK/gotrue.log" 2>/dev/null && break; sleep 0.25; done
  grep -q '^GOTRUE_DOUBLE_READY' "$WORK/gotrue.log" || fail local_gotrue_start gotrue.log
  API_URL="http://127.0.0.1:$GTPORT" node gates/admin_save_draft_ui.mjs >"$WORK/t2ci.log" 2>&1 || fail local_t2ci t2ci.log
  grep -q '^ADMIN_SAVE_DRAFT_UI_OK' "$WORK/t2ci.log" || fail local_t2ci_summary t2ci.log
  kill "$GT_PID" 2>/dev/null || true; for i in $(seq 1 20); do kill -0 "$GT_PID" 2>/dev/null || break; sleep 0.25; done; GT_PID=""
  grep '^GOTRUE_DOUBLE_STATS' "$WORK/gotrue.log" || fail local_gotrue_stats gotrue.log
  grep -q '"token_ok":1,' "$WORK/gotrue.log" && grep -q '"rejected_apikey":0,' "$WORK/gotrue.log" && grep -q '"rejected_anon_bearer":0,' "$WORK/gotrue.log" \
    || fail local_t2ci_rewrite gotrue.log
  echo "T2 (CI/hybrid mode): $(grep -c '^PASS' "$WORK/t2ci.log") checks PASS"
fi
# 6) the stack must have logged no token
if grep -qF -e "$CRM_JWT" -e "$SUPER_JWT" -e "$ANALYST_JWT" -e "$MEMBER_JWT" "$WORK/edge.log" "$WORK/db.log" "$WORK"/t*.log 2>/dev/null; then fail local_token_in_log edge.log; fi
echo "LOCAL_SAVE_DRAFT_PASS"
