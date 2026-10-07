#!/usr/bin/env bash
# WP6 DRY RUN — runs LIVE_CHECKS/qa/wp6_live.mjs UNCHANGED against a LOCAL static server of origin/main.
# No network, no production: supabase-js/Tailwind/Leaflet/images are answered by dryrun/playwright_shim.cjs (route()).
# Secrets are random throw-away values; the two QA e-mails are fake .invalid addresses built at runtime.
#
#   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers TAILWIND_NODE_PATH=<dir with tailwindcss@3 + @tailwindcss/forms +
#   @tailwindcss/container-queries + postcss> bash LIVE_CHECKS/qa/dryrun/run_dryrun.sh
#
# Env (all optional): DRY_ROOT (existing checkout to serve; default: temporary `git worktree add origin/main`, removed on
# exit) · DRY_WORK (scratch dir; default mktemp) · PW_REAL (real playwright; default /opt/node-tools/node_modules/playwright)
# Output: the script's own stdout + $DRY_WORK/out/wp6_live_result.json (+ dry_state.json: final stub store, e-mails redacted).
# Exit code = wp6_live.mjs exit code.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="${DRY_WORK:-$(mktemp -d)}"
mkdir -p "$WORK/qadeps/node_modules/playwright" "$WORK/rt" "$WORK/out"
OWN_TREE=0
if [ -z "${DRY_ROOT:-}" ]; then
  DRY_ROOT="$WORK/main"
  git -C "$REPO" fetch -q origin main 2>/dev/null || true
  git -C "$REPO" worktree add -q --detach "$DRY_ROOT" origin/main || { echo "worktree add failed"; exit 2; }
  OWN_TREE=1
fi
SRV=""
cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  [ "$OWN_TREE" = 1 ] && git -C "$REPO" worktree remove --force "$DRY_ROOT" 2>/dev/null
  rm -f "$WORK/rt/qa_secrets.env"
}
trap cleanup EXIT

# fake $QA_DEPS: `require("playwright")` from wp6_live.mjs resolves to the shim
printf 'module.exports = require(%s);\n' "\"$HERE/playwright_shim.cjs\"" > "$WORK/qadeps/node_modules/playwright/index.js"
rnd() { head -c 24 /dev/urandom | base64 | tr -d '/+=\n'; }
umask 077
printf 'ASALOCAL_ADMIN_PASSWORD=%s\nASALOCAL_MEMBER_PASSWORD=%s\n' "$(rnd)" "$(rnd)" > "$WORK/rt/qa_secrets.env"
AT="@"
MEMBER="wp6-dry-member${AT}dryrun.invalid"
SECOND="wp6-dry-second${AT}dryrun.invalid"

port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$DRY_ROOT" >/dev/null 2>&1 &
SRV=$!
for _ in $(seq 1 100); do curl -fsS "http://127.0.0.1:$port/CNAME" >/dev/null 2>&1 && break; sleep 0.1; done

RUNNER_TEMP="$WORK/rt" S1_OUT_DIR="$WORK/out" QA_DEPS="$WORK/qadeps" \
ASALOCAL_BASE_URL="http://127.0.0.1:$port" ASALOCAL_MEMBER_EMAIL="$MEMBER" ASALOCAL_ADMIN_EMAIL="$SECOND" \
DRY_ROOT="$DRY_ROOT" DRY_STUB_DIR="$HERE" DRY_STATE_OUT="$WORK/out/dry_state.json" \
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" NODE_PATH="${TAILWIND_NODE_PATH:-}" \
node "$REPO/LIVE_CHECKS/qa/${DRY_SCRIPT:-wp6_live.mjs}"
rc=$?
echo "DRYRUN_EXIT=$rc result=$WORK/out/wp6_live_result.json"
exit $rc
