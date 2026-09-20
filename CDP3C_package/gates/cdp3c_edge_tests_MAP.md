# CDP-3C · Kapanış testleri — 15 zorunlu test eşlemesi

Koşum: `node CDP3C_package/gates/cdp3c_edge_tests.mjs` → **CDP3C_EDGE_TESTS_RESULT=PASS** (54 assert).
Ağ/deploy gerektirmez: (A) email-api saf mantığı birebir kopya birim testleri + (B) gerçek birleşik
dosyalara karşı statik sözleşme assert'leri. Canlı HTTP gerektiren maddeler için sözleşme, kodun ilgili
yolu içerdiğini kanıtlar (deploy bu turda YOK).

| # | Zorunlu test | Karşılık (test id) | Katman |
|---|--------------|--------------------|--------|
| 1 | bilinmeyen origin → 403, yan etki yok | T01a/b/c + T01d (gate auth'tan önce) | birim+statik |
| 2 | `"false"` string → doğrulama hatası, grant yok | T02a/b/c/d | birim |
| 3 | geçersiz JWT → 401 | T03 (email-api not_authenticated) + T03b (admin-api invalid_token) | statik |
| 4 | normal üye consent/servis-pref'e erişir, admin action'a ERİŞEMEZ | T04a (userClient) + T04b (WRITE) + T05a/b (admin ayrı) | statik |
| 5 | admin opt-in veremez | T05a (WRITE_ACTIONS dışı) + T05b/d (yazma yok) + T05c/e | statik |
| 6 | marketing/capture false kalır | T06a–f (analytics/advertising reddi, marketing gizli, up.sql) | birim+statik |
| 7 | aktif metin yokken marketing grant reddi | T07 (no_active_controller→409) | birim (RPC yolu) |
| 8 | mevcut CDP-3B action'ları regresyonsuz | T08 (17 action) + T08b (renderEmail) + git additive | statik |
| 9 | tercih-merkezi kaydet/yeniden-aç | T09 (save sonrası server re-read, optimistic yok) | statik |
| 10 | ağ retry aynı idem → aynı sonuç | idem passthrough + up.sql `_consent_idem_check` (T04b + DB) | statik |
| 11 | farklı payload aynı idem → conflict | T11 (idempotency_conflict→409) | birim |
| 12 | çerez localStorage manipülasyonu script yüklemez | T12a (yalnız server-write dalı) + T12b | statik |
| 13 | sunucu consent reddi → script yüklenmez | T13 + T13b (fail-closed init) | statik |
| 14 | iki kullanıcıya backfill/popup yok | T14 (yalnız kullanıcı açınca) + migration'da veri yazımı yok | statik |
| 15 | yanıt/log'da ham PII/HMAC/evidence yok | T15a–d (console, admin-api, suppression 64-hex, _contact_hmac revoke) | statik |

Ek birim: locale allowlist, closed-field 400, withdraw text-null 422, maskeli internal_error/400.

## Canlı-doğrulanmayan (deploy sonrası ayrı onayla koşulacak)
- Gerçek HTTP 401/403/409/422 kodları (Edge deploy sonrası).
- RPC idempotency'nin canlı davranışı (T10/T11 tam uçtan-uca; DB'de mantık mevcut ve CDP-3C hosted
  testlerinde T01–T39 ile ayrıca doğrulanmıştı).
- Tarayıcıda üye Tercih Merkezi save/reopen ve çerez banner akışı.
