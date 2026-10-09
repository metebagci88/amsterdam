#!/usr/bin/env bash
# WP8 throwaway PostgreSQL cluster (CI and local). Never touches production.
# usage: wp8_pg.sh start|stop|status
#   WP8_PG_DIR   cluster directory (default: ${RUNNER_TEMP:-/tmp}/wp8pg)
#   WP8_PG_PORT  TCP port on 127.0.0.1 (default 55432)
# The cluster listens on 127.0.0.1 only, trust auth, no unix socket.
# As root (local sandboxes) the server binaries run in a user namespace,
# because initdb refuses to run as root.
set -euo pipefail
if [[ "${DATABASE_URL:-}${SUPABASE_DB_URL:-}${PGHOST:-}" == *supabase.co* ]]; then
  echo "REFUSED_PRODUCTION"; exit 1
fi
DIR="${WP8_PG_DIR:-${RUNNER_TEMP:-/tmp}/wp8pg}"
PORT="${WP8_PG_PORT:-55432}"
BIN="${WP8_PG_BIN:-}"
if [[ -z "$BIN" ]]; then
  for v in 16 17 15 14; do
    if [[ -x "/usr/lib/postgresql/$v/bin/initdb" ]]; then BIN="/usr/lib/postgresql/$v/bin"; break; fi
  done
fi
if [[ -z "$BIN" ]]; then echo "WP8_PG_FAIL:no_server_binaries"; exit 1; fi
wrap=()
if [[ "$(id -u)" == "0" ]]; then wrap=(unshare --user --map-user=1000 --map-group=1000); fi
case "${1:-}" in
  start)
    if [[ ! -f "$DIR/data/PG_VERSION" ]]; then
      mkdir -p "$DIR"
      "${wrap[@]}" "$BIN/initdb" -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >"$DIR/initdb.log" 2>&1 \
        || "${wrap[@]}" "$BIN/initdb" -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C >"$DIR/initdb.log" 2>&1
    fi
    if ! "${wrap[@]}" "$BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
      "${wrap[@]}" "$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/server.log" \
        -o "-c listen_addresses=127.0.0.1 -c port=$PORT -c unix_socket_directories='' -c max_connections=60 -c fsync=off" -w start >/dev/null
    fi
    for _ in $(seq 1 30); do
      if psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then echo "WP8_PG_READY port=$PORT"; exit 0; fi
      sleep 1
    done
    echo "WP8_PG_FAIL:not_ready"; exit 1 ;;
  stop)
    "${wrap[@]}" "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
    echo "WP8_PG_STOPPED" ;;
  status)
    "${wrap[@]}" "$BIN/pg_ctl" -D "$DIR/data" status ;;
  *) echo "usage: wp8_pg.sh start|stop|status"; exit 2 ;;
esac
