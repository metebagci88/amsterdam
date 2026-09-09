# CDP-3C · Teslim Manifesti (v9) — UYGULANMADI

> **v9:** 3 harness düzeltmesi (`CDP3C_package/CDP3C_CHANGES_v8_to_v9.md`). SQL çekirdeği v8'de temiz bulundu, DEĞİŞTİRİLMEDİ. (#1) `cdp3c_preflight_objects.sh` fail-open kapatıldı (sorgu rc ana-shell'de; geçersiz DB URL → `GATE_FAILED:preflight_objects_query`, PASS yok). (#2) `gen_object_manifest.sh` GERÇEK multiline (yorum-strip + whitespace-normalize; `--raw` dup-sayımı); `cdp3c_manifest_check.sh` çapraz-sayım `--raw`; `cdp3c_manifest_selftest.sh` gerçek fixture (ad ayrı satır/uppercase/yorum-sızıntı/overload). (#3) `cdp3c_guard_selftest.sh` ilk mutasyondan ÖNCE tam 3-katman `require_ephemeral`, ON_ERROR_STOP+rc, sonda sentinel geri-yükleme doğrulaması; workflow'da **baseline → guard_selftest** sırası. Otoritatif SHA listesi repo-kökü `SHA256SUMS`.
>
> _(v8: 8 kapanış — `CDP3C_package/CDP3C_CHANGES_v7_to_v8.md`.)_

**Production etkisi = none.** commit/push yok, GitHub Run yok, migration/Edge/admin deploy yok, kill-switch v3 değişmedi, mevcut iki kullanıcıya backfill/consent/re-consent yok.

## 1. Repo hedef ağacı (kanonik)
```
.github/workflows/cdp3c-gates.yml     ← workflow (repo kökü)
SHA256SUMS                            ← manifest (repo kökü; .github/workflows + CDP3C_package'i kapsar)
CDP3C_package/…                       ← tüm SQL + gate + dokümanlar
```
Tam dosya listesi + her dosyanın SHA-256'sı: repo-kökü **`SHA256SUMS`** (`sha256sum -c SHA256SUMS` repo kökünden). Yerelde `-c` ile doğrulandı.

## 2. Workflow bütünlük kanıtı (ayrıca)
- Kanonik yol: `.github/workflows/cdp3c-gates.yml`
- **SHA-256:** `a71de2f089c47216c066be21366b9190fcd1a5f83adbd398a9b56edfe4c5c300`
- Bu değer `SHA256SUMS` içinde de yer alır; ilk gate `sha256sum -c SHA256SUMS` workflow'u DA doğrular. Paket içinde ikinci/eskimiş workflow kopyası yoktur.
- Yerel doğrulama: `sha256sum -c SHA256SUMS` → **35/35 OK**. ZIP: `CDP3C_delivery.zip`, SHA-256 yanındaki `CDP3C_delivery.zip.sha256` dosyasında.
- Supabase CLI **pinned**: `1.226.4` (`latest` YASAK).

## 3. Beklenen gate listesi (CI — GERÇEK SIRA; her biri isimli `GATE_FAILED:<ad>`)
1. `manifest_check` (drift + 20/12/48 + create-satır sayımı)
2. `manifest_selftest` (parser: uppercase/multiline/overload)
3. `sha256sums` (workflow dahil, fail-closed)
4. `scan_selftest`
5. `stack_start` (+ `stack_init`/`stack_status`/`db_url` isimli hatalar)
6. `extensions` (supabase_vault + pgcrypto@extensions)
7. `baseline` (test double + sentinel MARKER + `trip_save` fixture)
8. `guard_selftest` (ephemeral guard negatif+pozitif; baseline'dan SONRA — sentinel MARKER hazır)
9. `preflight` (contract; CI'da gerçek Vault ile **PASS**)
10. `preflight_objects` (PRE-APPLY; CDP-3C nesneleri YOK)
11. `up_apply` → 12. `up_reapply`
13. `invariants` → 14. `privilege_matrix` (manifest-scoped) → 15. `tests` (T01–T39)
16. `concurrency` (5 senaryo) → 17. `downsoft` (+assert)
18. `preflight_selftest` (AYRI ephemeral DB; ayrı `db_drop`/`db_create`/`db_baseline`/`db_cleanup` isimli hatalar)
19. **`teardown`** (`if:always`, residue=0 değilse kırmızı)
20. **`final secret_scan`** (`if:always`, teardown.log + paket)
21. **sentinel** `LOCAL_CDP3C_GATES_PASS` (`if:success` — yalnız gates+teardown+scan geçince)
22. tek **artifact** (`if:always`, `if-no-files-found: error`)

## 4. Yerel doğrulama (CI DEĞİL, production DEĞİL)
Gömülü Postgres 16.2 + vault/auth/pgcrypto shim: manifest_check/manifest_selftest/guard_selftest/secret_scan-selftest · baseline · preflight_objects · up + reapply · invariants · tests(**T01–T39**) · privilege_matrix(manifest-scoped) · concurrency(5 senaryo) · down_soft + downsoft_assert · preflight_selftest · secret_scan → **hepsi PASS** (ham exit code'lar `gates/LOCAL_GATE_EVIDENCE.log`). **Yerel preflight contract EXPECTED-FAIL** (shim'de gerçek Vault yok; CI'da PASS).

## 5. Runtime-DOĞRULANMAYAN maddeler
- GitHub ephemeral Supabase CI: ÇALIŞTIRILMADI (setup-cli indirme, `supabase start/stop`, docker residue, artifact upload, gerçek Vault ile preflight PASS burada doğrulanır).
- PRODUCTION preflight (contract + preflight_objects, salt-okunur gerçek şema): ÇALIŞTIRILMADI.
- CLI pinned sürümü ilk kabul koşusunda log'la teyit edilecek.

## 6. Durma
Bağımsız incelemeye tekrar duruldu. Onay olmadan CI/commit/apply başlatılmaz. Yeni hata: ilk hata satırı + kök neden + sınıflandırma + etkilenen dosya + minimal çözüm bildirilip beklenir.
