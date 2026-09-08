# CDP-3C · Paket Raporu (v9) — UYGULANMADI, bağımsız inceleme için

> **v9:** 3 harness düzeltmesi (`CDP3C_CHANGES_v8_to_v9.md`); SQL çekirdeği v8'de temiz, DEĞİŞMEDİ. (#1) preflight_objects fail-open kapatıldı — sorgu rc **ana-shell**'de (`run_q`/`bool_true`), geçersiz DB URL → `GATE_FAILED:preflight_objects_query`, PASS yok. (#2) gen_object_manifest **gerçek multiline** (yorum-strip + whitespace-normalize; `--raw` dup-sayımı), manifest_check çapraz-sayım `--raw`, manifest_selftest gerçek fixture (ad ayrı satır/uppercase/yorum-sızıntı/overload). (#3) guard_selftest ilk mutasyondan ÖNCE **tam 3-katman** `require_ephemeral` + ON_ERROR_STOP+rc + sonda sentinel geri-yükleme doğrulaması; workflow **baseline → guard_selftest**.
>
> _(v8: 8 kapanış — `CDP3C_CHANGES_v7_to_v8.md`.)_

## 0. Doğrulama durumu — AYRI başlıklar (dürüstlük)
- **YEREL (yapıldı, production değil):** gömülü Postgres 16.2 + vault/auth/pgcrypto **shim**. Geçenler: baseline, up, up-idempotent, invariants, tests (T01–T39), concurrency (5 senaryo), down_soft, downsoft_assert, secret-scan self-test + paket, negatif-fixture (exit=1). **Yerel preflight EXPECTED-FAIL** (shim'de gerçek supabase_vault/pgcrypto yok; sections 1-5 geçer, extensions adımında durur). preflight negatif **selftest** geçti (6 senaryo). Ham kanıt: `gates/LOCAL_GATE_EVIDENCE.log`.
- **GitHub ephemeral Supabase CI:** ÇALIŞTIRILMADI (gerçek pgcrypto/vault ile preflight PASS, setup-cli indirme, docker teardown/residue, artifact upload burada doğrulanır).
- **PRODUCTION preflight (salt-okunur):** ÇALIŞTIRILMADI (apply öncesi gerçek şemada koşulacak).

**Durum:** production'a **uygulanmadı**, CI **koşulmadı**, commit/push **yok**. Mevcut hesaplara veri yazılmadı, aktif hukuk metni oluşturulmadı, Resend/DNS/outbox/journey açılmadı, mevcut iki kullanıcıya backfill/consent/re-consent yapılmadı. admin-delete-user **kill-switch v3** canlı ve **dokunulmadı** (bu paket onu içermez/değiştirmez). **Production etkisi = none.**

**Bu turun farkı:** 16 bağımsız-inceleme bulgusu gerçek dosyalarda düzeltildi (eşleme: `CDP3C_CHANGES_v3_to_v4.md`) ve tüm SQL + gate'ler **gerçek gömülü Postgres 16.2 üzerinde (yerel, production değil)** çalıştırılıp doğrulandı.

## 1. Yerel çalıştırma kanıtı (CI DEĞİL, production DEĞİL)
Gömülü PostgreSQL 16.2 + vault/auth/pgcrypto shim ile koşuldu ve **hepsi geçti**:
`baseline → up → up (idempotent) → invariants` → **CDP3C_INVARIANTS_PASS**;
`tests` → **CDP3C_TESTS_PASS list=T01_default_absent…T39_approve_idem_intent** (39 isimli test);
`down_soft → downsoft_assert` → **CDP3C_DOWNSOFT_ASSERT_PASS**;
`cdp3c_concurrency.sh` (gerçek iki paralel psql) → **CDP3C_CONCURRENCY_PASS**;
`secret_scan_selftest.sh` → **SECRET_SCAN_SELFTEST_PASS**; paket secret-scan → temiz.
> Not: pgcrypto/supabase_vault yerelde SHA-256 tabanlı shim'dir; GERÇEK extension'lar prod/CI'da kullanılır. Bu yüzden `preflight`'ın extension adımı yalnız CI/prod'da yeşile döner (yerelde beklenen noktada durur; öncesi tüm kontroller geçer).

## 2. 16 bulgunun durumu (özet — tam eşleme `CDP3C_CHANGES_v3_to_v4.md`)
1 secret-scan gerçek-değer + self-test · 2 manifest repo-kökü + workflow kapsanır + CLI pinned · 3 fail-closed sıra (teardown→final-scan→tek artifact) · 4 soft-down hard-gate helper'ları KORUR · 5 tüm admin/config RPC'lerde 0C + gerçek iki-bağlantı concurrency · 6 legal_notice typed subject + 0C · 7 anon_merge 0C + hedef-doğrulama · 8 anon consent metin doğrulaması · 9 atomik controller/text switch + valid_to + pointer invariant · 10 hukuk-onayı kapısı (approval table + trigger) · 11 readiness kapalı şema (combo/expires/unique-revoke/evidence) · 12 suppression kombinasyon matrisi · 13 service_role THREAT MODEL (trigger-tabanlı kritik invariant) · 14 preflight tip/nullability/return-type/enum/extension · 15 isimli test listesi + doğru sentinel · 16 teslim + durma.

## 3. Paket içeriği + repo hedef yolları
Repo ağacı (kanonik):
```
.github/workflows/cdp3c-gates.yml        ← workflow (repo kökü)
SHA256SUMS                                ← manifest (repo kökü; workflow'u DA kapsar)
CDP3C_package/CDP3C_up.sql
CDP3C_package/CDP3C_down_soft.sql
CDP3C_package/CDP3C_down_insecure.sql
CDP3C_package/gates/cdp3c_baseline.sql        (CI-only test double)
CDP3C_package/gates/cdp3c_preflight.sql       (prod salt-okunur compatibility)
CDP3C_package/gates/cdp3c_invariants.sql
CDP3C_package/gates/cdp3c_tests.sql           (T01–T39)
CDP3C_package/gates/cdp3c_objects.manifest    (KANONİK 20/12/48)
CDP3C_package/gates/gen_object_manifest.sh + cdp3c_manifest_check.sh (drift gate)
CDP3C_package/gates/cdp3c_preflight_objects.sh (manifest-driven, salt-okunur)
CDP3C_package/gates/cdp3c_privilege_matrix.sh  (dinamik)
CDP3C_package/gates/_ephemeral_guard.sh + cdp3c_guard_selftest.sh + cdp3c_preflight_selftest.sh
CDP3C_package/gates/LOCAL_GATE_EVIDENCE.log
CDP3C_package/gates/cdp3c_downsoft_assert.sql
CDP3C_package/gates/cdp3c_concurrency.sh      (iki-bağlantı 0C)
CDP3C_package/gates/secret_scan.sh
CDP3C_package/gates/secret_scan_selftest.sh
CDP3C_package/CDP3C_EDGE_ADMIN_SPEC.md        (v3 + THREAT MODEL)
CDP3C_package/CDP3C_TEST_MATRIX.md            (v7)
CDP3C_package/CDP3C_APPLY_ROLLBACK.md         (v4)  
CDP3C_package/CDP3C_CHANGES_v1_to_v2.md / _v2_to_v3.md / … / _v6_to_v7.md
CDP3C_package/CDP3C_PACKAGE_REPORT.md         (bu dosya)
CDP3C_package/CDP3C_DELIVERY_MANIFEST.md      (tree + SHA + gate listesi + not-verified)
```
Bütünlük + tam SHA-256 listesi: **`SHA256SUMS`** (`sha256sum -c SHA256SUMS` repo kökünden → hepsi OK, yerelde doğrulandı) ve `CDP3C_DELIVERY_MANIFEST.md`.

## 4. Beklenen gate listesi (CI, onaydan sonra) — GERÇEK SIRA
`manifest_check` → `manifest_selftest` → `sha256sums` → `scan_selftest` → `stack_start` → `extensions` → `baseline` → `guard_selftest`(baseline'dan SONRA) → `preflight`(contract; CI'da PASS) → `preflight_objects`(PRE-APPLY) → `up_apply` → `up_reapply` → `invariants` → `privilege_matrix`(manifest-scoped) → `tests`(T01–T39) → `concurrency`(5 senaryo) → `downsoft`(+assert) → `preflight_selftest`(ayrı ephemeral DB; `db_drop`/`db_create`/`db_baseline`/`db_cleanup` isimli) → **teardown**(residue=0, if:always) → **final secret_scan**(if:always) → **sentinel** `LOCAL_CDP3C_GATES_PASS`(if:success) → tek **artifact**(if:always). Her gate isimli `GATE_FAILED:<ad>` üretir (command-sub'da `rc=$?` yakalanır; stack `init/start/status/db_url` ayrı); sentinel yalnız gates+teardown+scan hepsi geçince.

## 5. Runtime-DOĞRULANMAYAN maddeler (dürüstlük notu)
- **GitHub Actions koşusu yapılmadı** (commit/push yok): ephemeral Supabase CLI davranışı, `supabase/setup-cli` pinned sürüm (1.226.4) gerçek indirme, `supabase start/stop`, docker residue ve artifact upload **CI'da doğrulanmadı**; yerelde eşdeğer psql zinciriyle doğrulandı.
- **pgcrypto/supabase_vault** yerelde shim; gerçek extension davranışı prod/CI'da doğrulanacak.
- **preflight** gerçek production şemasına karşı henüz koşulmadı (apply öncesi salt-okunur adım).
- CLI pinned sürümü ilk kabul koşusunda log'la teyit edilmeli (değişirse manifest+rapor güncellenir).

## 6. Güvenlik/rollback + maliyet
verify_jwt (Edge) korunur; deny-all/force RLS; helper'lar public/anon/authenticated'a kapalı; ham PII/HMAC audit/idem/error'da yok. Kritik invariant'lar **trigger-tabanlı** (service_role dahil enforce; §THREAT MODEL). `down_soft` fail-closed: dış RPC düşer; immutability/append-only/hard-gate trigger + enforcement helper + tablo/veri + pepper + kill-switch korunur (downsoft_assert kanıtlar). Maliyet **$0**; pg_cron yok.

## 7. Sonraki adım (öneri — onay bekliyor)
Bağımsız inceleme → onay → (a) production'da `gates/cdp3c_preflight.sql` salt-okunur → (b) repo-kökü `.github/workflows/cdp3c-gates.yml` ephemeral CI → yeşilse controlled-production-change sırasıyla adım-adım apply. **Onaya kadar beklemede.** Yeni hata bulunursa: ilk hata satırı + kök neden + sınıflandırma + etkilenen dosya + minimal çözüm bildirilip durulur.
