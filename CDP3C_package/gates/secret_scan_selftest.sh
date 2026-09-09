#!/usr/bin/env bash
# secret_scan.sh self-test: negatif (sahte gerçek-görünümlü secret → KIRMIZI) +
# pozitif (grant ... to service_role + normal SQL → GEÇER). Fail-closed.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Pozitif fixture: rol adı + normal SQL secret DEĞİLDİR → geçmeli
cat > "$TMP/ok.sql" <<'SQL'
grant execute on function public.marketing_readiness_check() to service_role;
revoke all on public.marketing_config from public, anon, authenticated;
-- service_role bypass notu: kritik invariant'lar trigger ile korunur.
SQL
if ! bash "$DIR/secret_scan.sh" "$TMP/ok.sql" >/dev/null; then echo "SELFTEST_FAIL: pozitif yanlış kırmızı"; exit 1; fi

# Negatif fixture 1: sahte JWT (gerçek anahtar DEĞİL) → kırmızı olmalı
cat > "$TMP/bad1.txt" <<'TXT'
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJFYWtlZmFrZQ.eyJyb2xlIjoiZmFrZXNlcnZpY2Uifq.ZmFrZXNpZ25hdHVyZUZBS0U
TXT
if bash "$DIR/secret_scan.sh" "$TMP/bad1.txt" >/dev/null; then echo "SELFTEST_FAIL: negatif(JWT) yakalanmadı"; exit 1; fi

# Negatif fixture 2: sahte Supabase secret key → kırmızı olmalı
printf 'token = sb_secret_FAKE0000abcd1234efgh5678\n' > "$TMP/bad2.txt"
if bash "$DIR/secret_scan.sh" "$TMP/bad2.txt" >/dev/null; then echo "SELFTEST_FAIL: negatif(sb_secret) yakalanmadı"; exit 1; fi

# Negatif fixture 3: PEM özel anahtar → kırmızı olmalı
printf -- '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n' > "$TMP/bad3.txt"
if bash "$DIR/secret_scan.sh" "$TMP/bad3.txt" >/dev/null; then echo "SELFTEST_FAIL: negatif(PEM) yakalanmadı"; exit 1; fi

echo "SECRET_SCAN_SELFTEST_PASS"
