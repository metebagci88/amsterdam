#!/usr/bin/env bash
# CDP-3D regression for WP8 (critic amendment 12):
#   (1) the CDP-3D gates UNCHANGED on their own pre-WP8 schema (PGlite gate, template check +
#       self-test, Svix test, esbuild parse of both Edges, SHA256SUMS);
#   (2) the CDP-3D PGlite gate and the CDP-3D node DB suite re-run on CDP-3D + WSE + WP8 with an
#       explicit expected-delta list (deliberate contract changes), everything else must pass.
# Node modules come from WP8_NODE_MODULES (a node_modules dir with pglite, pg, esbuild).
set -uo pipefail
source "$(dirname "$0")/wp8_lib.sh"
NM="${WP8_NODE_MODULES:?WP8_NODE_MODULES required}"
pass=0; fail=0
ck() { if [[ "$2" == "1" ]]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; printf '%s\n' "${3:-}" | tail -15; fail=$((fail+1)); fi; }
EXPECTED=8
DB="wp8_cdp3d_$$"
trap 'wp8_dropdb "$DB"; rm -rf "$WP8_TMP"' EXIT
cp -r "$WP8_ROOT/CDP3D_package" "$WP8_TMP/CDP3D_package"
out="$(cd "$WP8_TMP/CDP3D_package" && sha256sum -c SHA256SUMS 2>&1)"; ck "CDP3D SHA256SUMS (with the v4 dispatch line)" "$([[ $? -eq 0 ]] && echo 1)" "$out"
out="$(cd "$WP8_TMP/CDP3D_package" && bash gates/cdp3d_template_check_selftest.sh . 2>&1 && bash gates/cdp3d_template_check.sh . 2>&1)"
ck "CDP3D template check + self-test" "$([[ "$out" == *TEMPLATE_CHECK_SELFTEST_PASS* && "$out" == *TEMPLATE_CHECK_PASS* ]] && echo 1)" "$out"
ln -s "$NM" "$WP8_TMP/CDP3D_package/node_modules"
out="$(cd "$WP8_TMP/CDP3D_package" && node gates/cdp3d_pglite_gate.mjs 2>&1)"
ck "CDP3D PGlite gate unchanged on the pre-WP8 schema (47 checks)" "$([[ "$out" == *"RESULT pass=47 fail=0"* && "$out" == *CDP3D_LOCAL_GATES_PASS* ]] && echo 1)" "$out"
out="$(cd "$WP8_TMP/CDP3D_package" && node gates/cdp3d_svix_test.mjs 2>&1)"; ck "CDP3D Svix test" "$([[ "$out" == *SVIX_PASS* ]] && echo 1)" "$out"
out="$(cd "$WP8_TMP/CDP3D_package" && for f in service-email-dispatch resend-webhook; do "$NM/.bin/esbuild" edge/$f/index.ts --bundle --external:'https://*' --format=esm --platform=neutral --outfile=/dev/null --log-level=warning && echo "PARSE_OK $f"; done 2>&1)"
ck "esbuild parse of both Edges (as cdp3d-gates.yml)" "$([[ "$out" == *"PARSE_OK service-email-dispatch"* && "$out" == *"PARSE_OK resend-webhook"* ]] && echo 1)" "$out"
out="$(node "$WP8_GATES/wp8_cdp3d_on_wp8.mjs" "$WP8_TMP" 2>&1)"
ck "CDP3D PGlite gate on CDP3D+WSE+WP8: only the expected delta" "$([[ "$out" == *WP8_CDP3D_ON_WP8_PGLITE_PASS* ]] && echo 1)" "$out"
printf '%s\n' "$out" | grep -E '^(DELTA|UNEXPECTED|CDP3D-ON-WP8)'
# real PostgreSQL: CDP-3D node DB suite unchanged, schema = CDP-3D (raw, as cdp3d-edge-integration.yml) + WSE + WP8
set -e
wp8_newdb "$DB"; wp8_load_chain "$DB" raw; wp8_apply "$DB" >/dev/null
wp8_psql "$DB" -c "update public.email_service_policy set service_daily_cap = 50, service_monthly_cap = 1500 where id = 1" >/dev/null
set +e
mkdir -p "$WP8_TMP/dbsuite"; cp "$WP8_ROOT/CDP3D_package/gates/cdp3d_db_suite.mjs" "$WP8_TMP/dbsuite/"; ln -s "$NM" "$WP8_TMP/dbsuite/node_modules"
out="$(DBURL="postgresql://postgres@127.0.0.1:${WP8_PG_PORT}/${DB}" node "$WP8_TMP/dbsuite/cdp3d_db_suite.mjs" 2>&1)"
fails="$(printf '%s\n' "$out" | grep -E '^(FAIL|FATAL)' | sed 's/^FAIL //')"
echo "DELTA expected for cdp3d_db_suite: \"lease dolunca reclaim + yeniden claim\" -> WP8 lease backoff (behaviour S8, db_suite lease loop)"
ck "CDP3D node DB suite on CDP3D+WSE+WP8: exactly the lease-backoff delta (pass 17, fail 1)" "$([[ "$fails" == "lease dolunca reclaim + yeniden claim" && "$out" == *"RESULT pass=17 fail=1"* ]] && echo 1)" "$out"
wp8_newdb "${DB}b"; wp8_load_chain "${DB}b" raw
out="$(DBURL="postgresql://postgres@127.0.0.1:${WP8_PG_PORT}/${DB}b" node "$WP8_TMP/dbsuite/cdp3d_db_suite.mjs" 2>&1)"
wp8_dropdb "${DB}b"
ck "CDP3D node DB suite unchanged on the pre-WP8 schema (18/18)" "$([[ "$out" == *"RESULT pass=18 fail=0"* && "$out" == *CDP3D_DB_SUITE_PASS* ]] && echo 1)" "$out"
echo
echo "CDP3D REGRESSION RESULT pass=$pass fail=$fail expected=$EXPECTED"
if [[ $fail -eq 0 && $pass -eq $EXPECTED ]]; then echo "WP8_CDP3D_REGRESSION_PASS"; else echo "WP8_CDP3D_REGRESSION_FAIL"; exit 1; fi
