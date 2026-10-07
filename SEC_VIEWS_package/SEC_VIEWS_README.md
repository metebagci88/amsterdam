# SEC-VIEWS hotfix — public view'ları salt-okunur yap

**Migration:** `sec_public_views_readonly` · **Proje:** asa-local (`tosqsabuaomgqjtogdrn`) · **Tarih:** 2026-10-07
**Kaynak:** İP5 DB paketinin adversarial incelemesi (PRD §2.2 "güvenlik açığı" STOP koşulu → önce bu düzeltme).

## Sorun (production'da doğrulandı)
- `public.member_public` (`SELECT display_name, tier FROM members WHERE blocked = false`) otomatik güncellenebilir bir view
  (`pg_relation_is_updatable = 28`: INSERT+UPDATE+DELETE).
- View `security_invoker=false` ve sahibi `postgres` (tablo sahibi, BYPASSRLS) → yazma isteklerinde **members RLS uygulanmıyor**.
- `anon` ve `authenticated` view üzerinde `arwdDxtm` (tüm yetkiler) taşıyor.
- `members_admin_guard` trigger'ı yalnız BEFORE INSERT/UPDATE (tgtype 23); DELETE'i görmüyor.
- Sonuç: public anon anahtarı olan herkes `DELETE /rest/v1/member_public?<filtre>` ile üye satırlarını silebilir; giriş yapmış
  her kullanıcı başka üyelerin `display_name`'ini değiştirebilir.
- Kanıt: `evidence/pre_zf_prod_2026-10-07.txt` — production'da zero-footprint test (`WHERE false`, sonda REPORT ile rollback):
  `opens=6 … SV_ZF_VERDICT=VULNERABLE`. Hiçbir satıra dokunulmadı.

## Düzeltme
`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` — üç view (`member_public`, `comments_public`,
`comment_reaction_counts`), roller `anon` ve `authenticated`. SELECT korunur. Sitenin kodu bu view'ları yalnız okur
(origin/main: `comments_public` ve `comment_reaction_counts` SELECT; `member_public` sitede kullanılmıyor). service_role,
tablolar, policy'ler, fonksiyonlar, view tanımları değişmez.

## Kapılar
| Kapı | Komut | Sonuç |
|---|---|---|
| MCP metin kapısı | `bash gates/sec_views_token_scan.sh` | `SEC_VIEWS_TOKEN_SCAN_CLEAN` |
| PGlite PG17 / PG18 | `PGLITE_DIR=… node gates/sec_views_pglite_gate.mjs` | 26/26 + 26/26 `SEC_VIEWS_PGLITE_GATE_PASS` |
| Mutasyon (3) | DELETE'i bırak / authenticated'ı bırak / tanım drift | 3/3 yakalandı |
| Production PRE | `gates/sec_views_zero_footprint_test.sql` | `VULNERABLE` (beklenen) |
| Production POST | `gates/sec_views_prod_assert.sql` + ZF test | `SEC_VIEWS_PROD_ASSERT_PASS` + `SV_ZF_VERDICT=PASS` |
| Canlı HTTP | `LIVE_CHECKS/live_smoke.mjs` (anon DELETE/PATCH member_public → 401/42501, GET 200) | PASS |

PGlite modeli production'daki view SQL'ini birebir kullanır (pg_get_viewdef md5'leri production ile eşit) ve açığı gerçek
satırla yeniden üretir (anon DELETE bir satır siler; A, B'nin adını değiştirir), sonra düzeltmeden sonra ikisinin de 42501
ile reddedildiğini, okumaların çalıştığını, ikinci uygulamanın idempotent olduğunu, ACL/tanım drift'inde PRE'nin
reddettiğini, rollback'in kurulmadan çalışmadığını ve kurulunca baseline'ı birebir geri getirdiğini doğrular.

## Uygulama
1. CI (`.github/workflows/sec-views-gates.yml`) yeşil.
2. `apply_migration(name => 'sec_public_views_readonly', query => SEC_VIEWS_up.sql)`.
3. `gates/sec_views_prod_assert.sql` → `SEC_VIEWS_PROD_ASSERT_PASS`; `gates/sec_views_zero_footprint_test.sql` → `PASS`.
4. Canlı smoke (GitHub Actions) — anon yazma reddi + okuma 200 + site sayfaları.

## Geri alma (açığı geri açar)
`SEC_VIEWS_down_INSECURE.sql` — aynı transaction'da `select set_config('sec_views.rollback_armed','YES-REOPEN-HOLE',true);`
olmadan çalışmaz; baseline ACL'i birebir geri yükler. Yalnız SELECT dışı yetkiye gerçekten ihtiyaç duyan bir istemci
bulunursa ve site sahibi açıkça karar verirse.

## Kapsam dışı / sonraki adım
- Kök neden: Supabase varsayılan yetkileri `public` şemadaki yeni view'lara anon/authenticated için tüm yetkileri verir.
  Yeni bir view eklendiğinde aynı açık tekrar oluşabilir. `ALTER DEFAULT PRIVILEGES` değişikliği tüm şemayı etkilediği için
  bu hotfix'e dahil edilmedi; prod assert satır 5 (public şemada yazılabilir view = 0) ileride regresyonu yakalar.
