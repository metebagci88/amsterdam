#!/usr/bin/env bash
# CDP-3C · ephemeral guard NEGATİF + pozitif selftest (v9-#3: 3-KATMAN, mutasyon-öncesi doğrulama).
# Bu script'in KENDİSİ sentinel tablosunu mutasyona uğratır → İLK DROP/CREATE'ten ÖNCE TAM 3-katman
# require_ephemeral (opt-in + yerel host + sentinel MARKER) çağrılır. baseline sentinel'i yaratmış
# olmalı; yoksa burada fail-closed olur ve HİÇBİR mutasyon yapılmaz. Tüm mutasyonlar ON_ERROR_STOP + rc.
# Sonda doğru marker geri yüklenip DOĞRULANIR (geri yükleme başarısızsa fail).
# Kullanım: cdp3c_guard_selftest.sh "<LOCAL_EPHEMERAL_PSQL_URI>"  (baseline ÖNCE koşmuş olmalı)
set -uo pipefail
URI="${1:?}"; DIR="$(cd "$(dirname "$0")" && pwd)"; G="$DIR/_ephemeral_guard.sh"
source "$G"

# ── 3-KATMAN GUARD: HERHANGİ bir mutasyondan ÖNCE (opt-in + yerel + sentinel MARKER) ──
# Yanlış/uzak/ephemeral-olmayan DB'ye tek bir DROP bile gitmez.
require_ephemeral "$URI"

# rc-denetimli mutasyon (ON_ERROR_STOP=1); herhangi biri düşerse fail-closed.
mut(){ psql "$URI" -v ON_ERROR_STOP=1 -qtA -c "$1" >/dev/null 2>&1; local rc=$?; [ $rc -eq 0 ] || { echo "GUARD_SELFTEST_FAIL:mutation_rc($rc :: $1)"; exit 1; }; }
call(){ bash -c "source '$G'; $1" _ 2>&1; }   # alt kabuk: guard'ın exit 3'ü selftest'i düşürmez
chk(){ local lbl="$1" pat="$2" out="$3" rc="$4"; { [ "$rc" -ne 0 ] && grep -q "$pat" <<<"$out"; } || { echo "GUARD_SELFTEST_FAIL:$lbl(rc=$rc)"; echo "$out"; exit 1; }; }

# ── NEG1/NEG2: DB'ye BAĞLANMADAN önce çıkar (mutasyon-öncesi exit kanıtı) ──
out="$(CDP3C_ALLOW_DESTRUCTIVE= call "require_local_optin '$URI'")"; chk opt_in 'opt_in_required' "$out" $?
out="$(CDP3C_ALLOW_DESTRUCTIVE=1 call "require_local_optin 'postgresql://u:p@db.prod.example.com:5432/postgres'")"; chk non_local 'non_local_host' "$out" $?

# ── NEG3: sentinel YOK (ephemeral doğrulandığı için geçici kaldırma güvenli) ──
mut "drop table if exists public._cdp3c_ephemeral_ok"
out="$(CDP3C_ALLOW_DESTRUCTIVE=1 call "require_ephemeral '$URI'")"; chk sentinel_missing 'ephemeral_sentinel_missing_or_wrong_marker' "$out" $?

# ── NEG4: sentinel VAR ama MARKER yanlış ──
mut "create table public._cdp3c_ephemeral_ok(marker text not null)"
mut "insert into public._cdp3c_ephemeral_ok values ('WRONG_MARKER')"
out="$(CDP3C_ALLOW_DESTRUCTIVE=1 call "require_ephemeral '$URI'")"; chk wrong_marker 'ephemeral_sentinel_missing_or_wrong_marker' "$out" $?

# ── POZİTİF: doğru marker geri konur → require_ephemeral GEÇER ──
mut "truncate public._cdp3c_ephemeral_ok"
mut "insert into public._cdp3c_ephemeral_ok values ('CDP3C_CI_EPHEMERAL')"
out="$(CDP3C_ALLOW_DESTRUCTIVE=1 call "require_ephemeral '$URI' && echo GUARD_OK")"; rc=$?
{ [ $rc -eq 0 ] && grep -q 'GUARD_OK' <<<"$out"; } || { echo "GUARD_SELFTEST_FAIL:positive(rc=$rc)"; echo "$out"; exit 1; }

# ── RESTORE DOĞRULAMA: sentinel doğru marker'a geri dönmüş olmalı (aksi fail-closed) ──
restored="$(psql "$URI" -tAqc "select marker from public._cdp3c_ephemeral_ok limit 1" 2>&1)"; rrc=$?
restored="$(printf '%s' "$restored" | tr -d '[:space:]')"
{ [ $rrc -eq 0 ] && [ "$restored" = "CDP3C_CI_EPHEMERAL" ]; } || { echo "GUARD_SELFTEST_FAIL:sentinel_restore(rc=$rrc val='$restored')"; exit 1; }

echo "GUARD_SELFTEST_PASS (3-katman mutasyon-öncesi; 4 negatif exit-before-mutation; sentinel geri yüklendi)"
