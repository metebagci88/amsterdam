#!/usr/bin/env bash
# CDP-3C · Paylaşılan İKİ-KATMANLI fail-closed ephemeral guard.
# Mutating harness'lar (destructive/yazan) HERHANGİ bir DROP/ALTER/INSERT ÖNCESİ çağırır.
# Katman 1: açık opt-in env CDP3C_ALLOW_DESTRUCTIVE=1
# Katman 2: URI host YALNIZ loopback/localhost/unix-socket (uzak TCP → RED)
# Katman 3: CI baseline'ın yarattığı ephemeral SENTINEL tablo mevcut olmalı
# Başarısızsa: hiçbir mutasyon öncesi non-zero + isimli GUARD_FAILED.
# Kullanım: source _ephemeral_guard.sh; require_ephemeral "<PSQL_URI>"
# Katman 1+2 (DB'siz): opt-in + host. Schema DROP eden scriptler İLK drop'tan ÖNCE çağırır.
require_local_optin(){
  local uri="${1:?}"; local host
  [ "${CDP3C_ALLOW_DESTRUCTIVE:-}" = "1" ] || { echo "GUARD_FAILED:opt_in_required(CDP3C_ALLOW_DESTRUCTIVE=1 gerekli)"; exit 3; }
  if printf '%s' "$uri" | grep -qE '[?&]host=/'; then host="unixsocket"
  else host="$(printf '%s' "$uri" | sed -E 's#^[a-z]+://([^@]*@)?([^:/?]+).*#\2#')"; fi
  case "$host" in
    unixsocket|127.0.0.1|localhost|::1|'') : ;;
    *) echo "GUARD_FAILED:non_local_host($host)"; exit 3 ;;
  esac
}
# Katman 1+2+3: yukarıya EK olarak ephemeral SENTINEL MARKER DEĞERİ (baseline'ın yarattığı).
# Yalnız tablo-varlığı değil; sabit marker 'CDP3C_CI_EPHEMERAL' de doğrulanır (düzeltme #3).
CDP3C_SENTINEL_MARKER="CDP3C_CI_EPHEMERAL"
require_ephemeral(){
  require_local_optin "$1"
  local m; m="$(psql "$1" -tAqc "select marker from public._cdp3c_ephemeral_ok limit 1" 2>/dev/null | tr -d '[:space:]')"
  [ "$m" = "$CDP3C_SENTINEL_MARKER" ] || { echo "GUARD_FAILED:ephemeral_sentinel_missing_or_wrong_marker(beklenen '$CDP3C_SENTINEL_MARKER', bulunan '$m')"; exit 3; }
}
