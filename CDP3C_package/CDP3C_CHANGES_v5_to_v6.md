# CDP-3C · Paket v5 → v6 değişiklik tablosu (5 kapanış + 4 ek)

Her madde: **eski (v5) → yeni (v6) → etkilenen dosya(lar)**. Production'a uygulanmadı, CI koşulmadı, kill-switch değişmedi. Değişiklikler gömülü Postgres 16.2'de çalıştırılıp doğrulandı; ham kanıt `gates/LOCAL_GATE_EVIDENCE.log`.

| # | Konu | Eski (v5) | Yeni (v6) | Dosya |
|---|---|---|---|---|
| 1 | marketing_config singleton DELETE açığı | doğrudan `delete … where id=1` trigger'a takılmıyordu | `_marketing_config_no_delete` BEFORE DELETE trigger → `marketing_config_singleton_immutable`; deferred `_authoritative_consistency` singleton-count=1 doğrular; trigger kapsamı marketing_config INSERT/UPDATE/DELETE; T37 negatif + INV | `CDP3C_up.sql`, `gates/cdp3c_tests.sql` (T37), `gates/cdp3c_invariants.sql` |
| 2 | legal_notice idem + anon lifecycle race | subject varlık kontrolü idem'den ÖNCE; lock `legal_notice|subject|doc` (anon lock'undan farklı) | **idem-first**: fingerprint sonrası idem replay ÖNCE değerlendirilir (subject sonradan merge/expire olsa bile aynı sonuç); anon için **`anon_subject|subject` lock** (consent/merge ile aynı); lock sonrası varlık/expiry/merged re-read; T38 (replay-after-merge + farklı-payload conflict) + concurrency S3'te legal_notice↔merge yarışı deterministik | `CDP3C_up.sql`, `gates/cdp3c_tests.sql` (T38), `gates/cdp3c_concurrency.sh` |
| 3 | Preflight NULL-semantiği fail-open | scalar `<>`/`not in` eksik kolonda NULL→sessiz geçiş; admin_write_log kolon tipleri kısmi; obje-kontrolü yalnız 2 nesne; enum/return-type/security zayıf | **fail-closed** `count(*)=1` / `IS DISTINCT FROM`; admin_write_log tüm kullanılan kolonlar ad+tip+nullability; admin_role schema-qualified; `_admin_active`/`_admin_has_role` schema+imza+return+SECURITY DEFINER; **tam CDP-3C obje listesi** (tablo/type/func) mevcutsa fail-closed (extensions'tan ÖNCE); + **negatif fixture selftest** (6 senaryo non-zero) | `gates/cdp3c_preflight.sql`, `gates/cdp3c_preflight_selftest.sh` (yeni) |
| 4 | anon race concurrency test gevşek | exit kodları yok; yalnız timestamp kıyası | Deterministik: yalnız iki sonuç kabul (A merge kazanır→consent yalnız `anon_subject_merged`, event=0; B consent kazanır→tam 1 event + merge tamamlanır + merge-sonrası consent reddedilir); başka/boş/permission/generic hata → KIRMIZI; timestamp ana kanıt değil | `gates/cdp3c_concurrency.sh` |
| 5 | Evidence "tüm gate'ler geçti" ile çelişki | preflight exit=3 iken "hepsi geçti" deniyordu | Evidence yeniden yapılandırıldı: **A** yerelde geçen; **B** yerel preflight EXPECTED-FAIL (shim'de gerçek Vault/pgcrypto yok); **C** preflight negatif selftest; **D** çalıştırılmayan (prod preflight / GitHub ephemeral / CLI indirme). "PASS'e makyaj" yok | `gates/LOCAL_GATE_EVIDENCE.log`, `CDP3C_PACKAGE_REPORT.md`, `CDP3C_DELIVERY_MANIFEST.md` |
| E1 | approve stale-hash riski | content_hash advisory/row lock ÖNCESİ okunuyordu | advisory lock → satır `FOR UPDATE` → current hash orada; fingerprint+approval kilitli hash üzerinden | `CDP3C_up.sql` |
| E2 | invariants kısmi privilege | yalnız seçili RPC | **authoritative matris**: authenticated yalnız 3 RPC; anon hiçbiri; service_role tüm akış/admin/config; helper'lar authenticated+anon kapalı — döngüyle tüm imzalar | `gates/cdp3c_invariants.sql` |
| E3 | artifact if-no-files-found | `warn` | `error` | `.github/workflows/cdp3c-gates.yml` |
| E4 | workflow timeout | yok | `timeout-minutes: 30` | `.github/workflows/cdp3c-gates.yml` |

## Yerel kanıt (BÖLÜM A/B/C — CI DEĞİL, production DEĞİL)
`gates/LOCAL_GATE_EVIDENCE.log`: **A)** baseline/up/up-idempotent/invariants(`CDP3C_INVARIANTS_PASS`)/tests(`CDP3C_TESTS_PASS`, T01–T39)/concurrency(`CDP3C_CONCURRENCY_PASS`, 4 senaryo)/down_soft/downsoft_assert/secret-scan self-test+paket + negatif-fixture exit=1 → hepsi exit=0. **B)** yerel preflight exit=3 EXPECTED (shim'de supabase_vault yok; sections 1-5 geçer). **C)** `PREFLIGHT_SELFTEST_PASS` (6 negatif doğru hatayla + pozitif kontrol). **D)** prod preflight / GitHub ephemeral CI / CLI indirme: ÇALIŞTIRILMADI.

## Kill-switch
admin-delete-user kill-switch v3'e dokunulmadı.
