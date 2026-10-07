# WP3 — Browser storage şehir izolasyonu: rapor

**Durum:** PR'a hazır, **commit/push/merge/deploy YAPILMADI.** Supabase'e dokunulmadı. Canlı site bu ortamdan erişilemediği için canlıda doğrulanmadı.
**Go-live kararı bekleyen tek konu:** takvim fotoğrafları cihaz depolamasının yaklaşık yarısından fazlasını kaplayan kullanıcılar, eski anahtarın güvenli emekliliği onaylanana kadar fotoğraf ekleyip silemez (bkz. §3a bulgu 2/3 ve §6.1). Bu durumda veri kaybı yok, ekran kayıtla tutarlı ve kullanıcıya mesaj gösteriliyor.
**Taban:** dokunulan izlenen dosyalar `origin/main` `7a548e9` ile birebir aynıydı (`git diff origin/main HEAD -- <dosyalar>` boş); yama main'e temiz uygulanır.
**Envanter:** `WP3_package/WP3_INVENTORY.md`.

## 1. Değişen / eklenen dosyalar

| Dosya | Durum | SHA-256 |
|---|---|---|
| `amsterdam/index.html` | değişti | `c00927710d7bb596f7b67530877a4a34e8875cff11961a1a0d415b853c3f2a60` |
| `index.html` | değişti | `1033c4339f0185a739ca93c01ec8d5c9d4a20058cdf93260861fb58034747415` |
| `lib/asa-storage/asa_storage.js` | değişti (işaret, çakışma, şehir filtresi, büyük kopya erteleme, Amsterdam'a bağlanmamış plan tercihleri + açık aktarma; başlık sözleşmesi WIRED) | `32e524e7e15fe4bbcc3760cf8678c58c5c90445d28b2fa958d4015b1fafc1944` |
| `lib/asa-storage/asa_storage.test.mjs` | değişti (main'in 32 testinden 29'u birebir; 3'ü WP3 kablolamasına göre güncellendi; +21 yeni → 53) | `9ba5d169f21026412f211ac470e4d8ef73329406e39e681c9e85d9ea7e5d3923` |
| `scripts/ux_sprint1_trust_check.mjs` | değişti (kütüphaneyi inline eder; seed kontrolleri yeni anahtara) | `6c2ecc762ac564ba245feeb7ac926f356c3c302b3c1e0c15399f513c77035572` |
| `SHA256SUMS` | `amsterdam/index.html` satırı güncellendi (kopenhag satırı aynı) | `89502d8089454613ef46f8fd11a243a76d4c4f071dcbe5f21d79759cd9ca2d7f` |
| `.github/workflows/asa-storage-inert.yml` | yalnız açıklama yorumu (check adı korunsun diye ad değişmedi) | `0a04ec7eb3f0035fdf9209a89470beb93fff026ede4563eb6daf75486634ae61` |
| `.github/workflows/wp3-storage-gates.yml` | yeni | `9ce520553f84f256890a471e20ad55fc53ddbe0aeaa68499847e915b756253f8` |
| `WP3_package/WP3_INVENTORY.md` | yeni | `fe0ea7d1a80bf6b1df75d6c906af01c4882d88445ce0d6674ff2a216aa2c9b10` |
| `WP3_package/tests/run_all.sh` | yeni | `97a18d16920b1b0da594e77ad3d49b3e665f1e09ca458bad7e62893b45684b09` |
| `WP3_package/tests/wp3_unit.test.mjs` | yeni (10 test) | `0cfe2284bd84cea02b300e60146773b48186c2e6e76b5a37ef652a5ba766274f` |
| `WP3_package/tests/wp3_e2e.mjs` | yeni (20 senaryo × 2 viewport) | `64e36e8be2a58b87b23c329141ea5fdf4c46715d03d134a26e2f438e47681d12` |
| `WP3_package/tests/stubs/supabase_stub.js` | yeni (yalnız test) | `ff9d6464f8c1cf6dfeb64ecbe2cc759e5e5d2f4965117fe91252800073951eb5` |
| `WP3_package/tests/stubs/leaflet_stub.js` | yeni (yalnız test) | `d6116425e5e05e0b5a20941781cd4d766880d23af191ef99b7d7d0657c6c92df` |
| `kopenhag/index.html` | **değişmedi** | `8428c2228d491e84cdbd57b805018e72bf3333f80c0eb789cadd8fd02a4ce0af` |

Kütüphane yüklemesi: `<script src="/lib/asa-storage/asa_storage.js?v=32e524e7e15fe4bb">` (mutlak yol; `.nojekyll` var, kök alan adında GitHub Pages/Cloudflare Pages'te çalışır). `?v=` kütüphanenin SHA-256(16)'sıdır (repo'daki `decision_contract.js?v=` geleneği); lib testi bunu zorlar, kütüphane değişip `?v=` güncellenmezse kırmızı. Senkron `<script src>`, her iki sayfada ilk inline script'ten önce.

Hash/sözleşme sabitleyen yerler: `SHA256SUMS` (güncellendi), `scripts/ux_sprint1_trust_check.mjs` (güncellendi), `lib/asa-storage/asa_storage.test.mjs` "live pages do not load the module" testi (WP3 kablolama sözleşmesiyle değiştirildi) ve `?v=` kontrolü, `CDP3C_package/gates/cdp3c_edge_tests.mjs` ve `WSE_DEFAULT_package/gates/wse_static_check.mjs` (değişiklik gerekmedi, PASS). `LIVE_CHECKS/live_smoke.mjs` canlı byte'ı repo ile karşılaştırır — **deploy edilene kadar `/` ve `/amsterdam/` sha kontrolü bu değişiklikle FAIL verir** (LIVE_CHECKS düzenleme yasağı nedeniyle dokunulmadı).

## 2. Davranış özeti
- Amsterdam sayfası tüm şehir verisini `asa:ams:{fav,plan,dayven,cal,calphoto,trip,plan_prefs}` üzerinden okur/yazar (`window.ASA_ST` adaptörü → `AsaStorage`). Ham `localStorage` yalnız `asa_session` için kaldı (dokunulmadı).
- Açılışta `AsaStorage.reconcile(localStorage,"ams")`: idempotent kopya (yalnız ams'ye ait slotlar; Amsterdam sayfası cph anahtarı yazmaz/okumaz), sonra `asa:ams:_migrated` işareti: `{v:1, policy:"A", city, legacy_kept:true, verified, keys:{<eski anahtar>:{fp, state}}, mismatch_ack, stranded_ack, first_at, updated_at}`. `fp` = FNV-1a32+uzunluk değişim dedektörü (güvenlik hash'i değil). İşaret yalnız içerik değişince yazılır; tekrar açılış **sıfır yazım**.
- **Büyük eski değer kopyalanmaz (`deferred`):** 524.288 karakterden (`LARGE_COPY_CHARS`, ~5,24M karakterlik kotanın ~%10'u) uzun eski değer — pratikte fotoğraf data URL'li `ams_calphoto` — açılışta çoğaltılmaz; sayfa onu `get()` eski-anahtar geri düşüşüyle okur. Kullanıcının ilk fotoğraf kaydı yeni anahtarı yazar (işarette `superseded`). Böylece açılışta boş alan yarıya inmez. `migrate()` tek başına (main v1 davranışı) yine her şeyi kopyalar; erteleme yalnız `reconcile`'da (ve `migrate(..., {deferAbove})` ile).
- Eski anahtarlar silinmez. `verified:true` = her mevcut eski anahtar kopyalandı, eşleşti ve o günden beri değişmedi → gelecekte ayrıca onaylanacak emeklilik için önkoşul. Silme API'si yok (main testi `retireLegacy`/`deleteLegacy` yokluğunu zorlar).
- Çakışma: ilk migrasyonda eski≠yeni **veya** migrasyondan sonra eski anahtar değişti (eski sekme/eski sayfa yazdı) ve yeniden farklı → yeni değer kullanılır, hiçbir şey üzerine yazılmaz, Türkçe bildirim (`role="status"`, `aria-live="polite"`, klavyeyle "Anladım"). "Anladım" yalnız işareti günceller (`acknowledged`); eski değer tekrar değişirse bildirim geri gelir. Kullanıcının yeni anahtardaki kendi düzenlemeleri çakışma sayılmaz.
- Yanlış şehir: eski `asa_trip` Kopenhag (ve Amsterdam trip'i yok) / `asa:ams:trip` başka şehir etiketi (ör. Paris) / `?trip=` ile gelen DB seyahati başka şehir → Türkçe uyumsuzluk mesajı, veri Amsterdam'ınki gibi gösterilmez/yazılmaz. `/amsterdam/?city=Kopenhag` → depolama kilitli (okuma/yazma yok) + mesaj.
- **Amsterdam'a bağlanmamış eski plan tercihleri:** `asa_plan_prefs`'i yalnız Amsterdam sayfası yazardı, ama main kütüphanesi onu eski `asa_trip`'in şehrine göre yerleştirir (değiştirilmedi). Eski `asa_trip` Kopenhag ise ve `asa:ams:plan_prefs` yoksa bildirimde ayrı paragraf + **"Amsterdam planına aktar"** düğmesi gösterilir — kullanıcının kendi Amsterdam seyahati sonradan oluşsa bile, kullanıcı karar verene kadar. Aktarma yalnız tıklamayla, `adoptLegacy` ile birebir kopya (varsa üzerine yazılmaz, eski anahtar kalır), sonra planlayıcı yeniden yüklenir. "Anladım" reddi parmak iziyle (`stranded_ack`) kaydedilir; eski değer değişirse yeniden sorulur.
- **Kaydedilemeyen değişiklik ekranda kalmaz:** favori (`toggleFav`), fotoğraf ekleme/silme (`addPhoto`/`delPhoto`) depolama tarafından reddedilirse (kota) bellekteki değişiklik geri alınır ve kullanıcıya mesaj gösterilir; favoride bulut senkronu çağrılmaz. Login favori birleşimi yazılamazsa bildirim gösterilir (birleşim bulut kaynaklı olduğundan bu oturumda görünür kalır, cihazdaki kayıt değişmez, sonraki girişte yeniden birleşir). Genel `saveLS` uyarısından "fotoğrafları silip tekrar dene" önerisi kaldırıldı (silme de başarısız olabildiği için yanıltıcıydı).
- Kütüphane yüklenemezse (404) → sayfa çalışır, kalıcılık kapalı, "yüklenemedi" mesajı, hiçbir yazım/seed yok.
- Favori seed: yalnız `asa:ams:fav` ve `ams_fav` ikisi de yoksa (bozuk değer "var" sayılır) ve depolama yazılabilirse; yalnız `asa:ams:fav`'a.
- Login bulut favorileri: birleşim (cloud ∪ local) aynı; sonuç `asa:ams:fav`'a.
- Ana sayfa (Trip Policy A): Amsterdam → `reconcile("ams")` + `asa:ams:trip`; Kopenhag → **yalnız** `asa:cph:trip` (Kopenhag açılana kadar cph migrasyonu/işareti çalıştırılmaz; eski Amsterdam verisi `asa:cph:*`'a kopyalanmaz); açılmamış şehir (Paris vb.) → hiçbir trip anahtarı yazılmaz. `asa_trip` yazılmaz/silinmez.

## 3. PRD gereksinimleri / testler / kabul kriterleri

| PRD maddesi | Karşılama | Kanıt (test) |
|---|---|---|
| U1 main kütüphanesi authoritative | Mevcut API korunarak genişletildi (`migrate` ikinci/üçüncü parametre opsiyonel; yerleşim kuralları ve REGISTRY eşlemeleri değişmedi); main'in 32 testinin 29'u birebir geçiyor, 3'ü (INERT/WIRED bayrağı, "canlı sayfa yüklemez", kaynak kontrolü) WP3 gerçeğine göre güncellendi | `asa_storage.test.mjs` 53/53 |
| U2 Legacy envanter | `WP3_INVENTORY.md` (dosya:satır, fonksiyon, domain) | — |
| U3 İdempotent `ams_*`→`asa:ams:*` | `reconcile`→`migrate(storage,"ams",{deferAbove})` | unit "reconcile copies legacy once…", "reconcile defers copying a large legacy value…"; e2e "legacy-only user" (byte-identical kopya, reload'da sıfır yazım) |
| U4 Çakışmada veri kaybı yok, yeni otorite, banner, sessiz overwrite yok | `keyState` conflict/acknowledged; `#asaStoreNotice` | unit "pre-existing different…", "legacy written after migration…"; e2e "conflict (legacy != new)", "conflict from an old tab" |
| U5 Legacy hemen silinmez; doğrulama + emeklilik işareti | `asa:ams:_migrated` (`verified`, per-key `state` incl. `deferred`/`superseded`, `legacy_kept`) | unit "reconcile on empty storage…", "corrupt legacy and failed copies…", "reconcile defers…"; e2e "synthetic write failure…", "real quota ~45%/~55%" |
| U6 `asa_trip` Trip Policy A | Ana sayfa şehir koduna göre yazar; bilinmeyen şehir yazmaz; cph migrasyonu açılışa kadar yok | e2e "homepage: Trip Policy A…" (yalnız `asa:cph:trip`); unit "homepage replaces the Amsterdam trip without a false conflict", "homepage Kopenhag trip lands in cph only…" |
| U7 Yanlış şehir → fail-safe mesaj | `checkTripCity`, `findTripMismatch`, `foreignTrip`, kilitli mod, bağlanmamış plan tercihleri bildirimi | e2e "wrong-city legacy trip", "stranded Amsterdam plan prefs", "unknown-city trip (Paris)", "?city=Kopenhag…", "DB trip of another city" |
| U8 Kopenhag stub'a işlev yok | byte-identical; ana sayfa canlıda cph migrasyonu çalıştırmaz | run_all 5/6 `CPH_STUB_IDENTICAL`; e2e stub SHA = SHA256SUMS; lib test "no live cph migration before Kopenhag launches" |
| U9 Login bulut favori birleşimi bozulmaz | union aynı, yazım `asa:ams:fav`; yazım reddinde bildirim | e2e "login: cloud favorites union…" |
| U10 Seed yalnız gerçekten boşsa | `read().present` = yeni **veya** eski | e2e "fresh user", "seed guard"; UX check "seed only when new and legacy fav keys are missing" |
| T: tek sefer taşıma / reload'da çoğalmama | — | e2e "legacy-only user" (storage dump byte-identical, 0 yazım) |
| T: AMS/CPH birbirini görmez | Amsterdam sayfası hiçbir `asa:cph:*` okumaz/yazmaz; ana sayfa Amsterdam verisini cph'ye kopyalamaz | e2e "AMS/CPH isolation" (Storage.prototype enstrümantasyonu), "stranded … cph never gets them"; unit "migrate(storage, city)…", "reconcile and acknowledge never touch… the other city" |
| T: Auth/session korunur | `asa_session`, `sb-*-auth-token` değişmez | e2e "anonymous: asa_session…", "login…" (yalnız sayfanın kendi `saveSession`'ı); unit "adoptLegacy … never touches legacy/cph/protected" |
| T: fav/plan/gün/takvim/foto/seyahat round-trip | UI (kalp, `#dayPlan`, `#dayNote`, `#dayPhotoInput`) + sayfa fonksiyonları (`addDayVenue`, `PSET.setDate`, `TripSync.hydrate`) | e2e "round-trip…" (reload sonrası geri okuma); gerçek kotada foto ekle/sil kalıcılığı "real quota ~45%" |
| T: Mobil ve desktop smoke | tüm senaryolar 1280×800 ve 390×844; 390'da yatay taşma yok (iki düğmeli bildirim dahil) | e2e `[desktop]`/`[mobile]` |
| K: Canlı Amsterdam city-prefixed storage | **Kod hazır, canlıda değil** (deploy yapılmadı) | — |
| K: Mevcut veri kaybolmuyor | eski anahtarlar byte-identical kalıyor; eski plan tercihleri gizlenmiyor (bildirim + açık aktarma); kaydedilemeyen değişiklik ekranda kalmıyor | e2e "legacy-only", "rollback", "stranded…", "real quota ~45%/~55%" |
| K: Kopenhag öncesi izolasyon altyapısı | `cph` anahtar/işaret/migrate testleri | unit + e2e |
| K: Console hatası yok | sayfa kodundan 0 hata (stub'lı ortamda) | e2e her senaryoda "console/page errors = 0" |

### 3a. Review bulguları (3) — doğrulama ve sonuç

Her bulgu önce düzeltme öncesi kodla gerçek Chromium'da (stub'sız kota, ölçülen kota 5.242.880 karakter) yeniden üretildi, sonra düzeltildi; düzeltme e2e/unit ile ve mutasyonla kanıtlandı.

**Bulgu 1 (major) — Kopenhag `asa_trip` + Amsterdam `asa_plan_prefs`: GERÇEK, düzeltildi (a + c + d; kök çözüm b sahibi kararı bekliyor).**
Düzeltme öncesi ölçüm: (1) Amsterdam açılışı `plan_prefs` = `missing`, çakışma 0, bildirim yalnız seyahat uyumsuzluğu; (2) ana sayfada Kopenhag tıklaması `asa:cph:plan_prefs`'e Amsterdam tercihlerini (konaklama koordinatı dahil) yazdı; (3) ardından ana sayfada Amsterdam → bildirim tamamen kayboldu, tercihler erişilemez.
- (a) `index.html`: Kopenhag için `reconcile` çalışmaz; yalnız `asa:cph:trip` yazılır → canlıda cph'ye hiçbir Amsterdam verisi kopyalanmaz.
- (c) Kütüphane: `REGISTRY.plan_prefs.legacyWriter="ams"` (yerleşim `follow-trip` aynen; main testleri birebir geçiyor), `reconcile().stranded`, `acknowledge({stranded:true})`, `adoptLegacy()` (yalnız açık kullanıcı eylemi, üzerine yazmaz, eski anahtarı/cph'yi/korunan anahtarları değiştirmez). Sayfa: bildirimde "Plan tercihleri" paragrafı + "Amsterdam planına aktar"; kendi Amsterdam seyahati oluştuktan sonra da kullanıcı karar verene kadar görünür.
- (d) e2e `wp3_e2e.mjs`'deki eski "prefs gizli olmalı" iddiası kaldırıldı; yerine: "wrong-city…" (paragraf + düğme görünür, "Anladım" reddi kalıcı, kopya yok) ve yeni "stranded Amsterdam plan prefs" senaryosu (Kopenhag eski trip + AMS tercihleri → ana sayfa Kopenhag → ana sayfa Amsterdam → `/amsterdam/`'da bildirim → aktar → `asa:ams:plan_prefs` birebir, planlayıcı tercihleri gösteriyor, reload'da bildirim yok, `asa:cph:plan_prefs` hiç yazılmadı, eski anahtarlar birebir).
- (b) **Uygulanmadı — sahibi kararı:** `REGISTRY.plan_prefs.legacyMap`'i `"ams-only"` yapmak kök çözümdür (otomatik migrasyon, bildirim gerekmez) ama main'in authoritative sözleşmesini ve 3 main testinin plan_prefs iddialarını değiştirir (`asa_storage.test.mjs`: "key builders cover every domain…" `describeDomain("plan_prefs").legacyMap`, "cph legacy fallback follows a Kopenhag or Copenhagen trip only", "migrate copies ams_* only onto asa:ams…" `asa:cph:plan_prefs`). Onaylanırsa: `legacyMap:"ams-only"`, bu testlerin ilgili iddiaları güncellenir, `stranded`/`adoptLegacy` yolu kendiliğinden boş kalır.

**Bulgu 2 (major) ve Bulgu 3 (major) — calphoto'nun ikiye katlanması, sessiz kayıp: GERÇEK; sessiz kayıp ve açılışta yarıya inen alan düzeltildi; >~%50 fotoğraf kullanıcısı için düzenleme engeli emeklilik onayı bekliyor.**
Düzeltme öncesi ölçüm: ~%55'te kopya `copy_failed`; foto silme → "Depolama dolu… fotoğrafları silip tekrar dene" uyarısı, bellekte 10, reload'da 11 (silme kaybolur). ~%45'te kopya başarılı, kullanım %90'a çıktı. Dolu depolamada `toggleFav` ekranda eklendi, reload'da yok, mesaj yok.
- Erteleme (bulgu 3 öneri 1): `reconcile` 524.288 karakterden büyük eski değeri kopyalamaz (`deferred`), okumalar eski anahtardan. Gerçek kotada: ~%45 → açılış sonrası kullanım < %50 (önceden %90); ~%55 → `deferred`, diğer veriler (favori) kaydediliyor.
- Dürüst UI (bulgu 2 öneri 2/3, bulgu 3 öneri 2): `saveLS` sonucu döndürür; `addPhoto`/`delPhoto` reddedilen yazımda bellekteki ekleme/silmeyi geri alır, yeniden çizer ve özel mesaj gösterir; `toggleFav` reddedilen yazımda değişikliği geri alır + mesaj, bulut senkronu çağrılmaz; `syncOnLogin` reddi bildirir.
- Test (bulgu 2 öneri 4, bulgu 3 öneri 4): yalnız `failSet` kullanan senaryo, silme geri alma + mesaj + reload tutarlılığı iddialarıyla genişletildi; **gerçek kota** senaryoları eklendi: ~%55 (açılışta kopya yok; silme ve ekleme kaydedilemiyor → mesaj + ekran geri alınmış + reload'da aynı 11 foto; favori kaydediliyor; eski anahtar birebir) ve ~%45 (açılışta kopya yok; silme+ekleme kaydediliyor ve reload'da kalıcı, işaret `superseded`; depolama doldurulunca favori reddi → mesaj + geri alınmış + reload'da tutarlı).
- **Kalan (go-live kararı):** eski anahtar silinmediği sürece, fotoğrafları kotanın ~%50'sinden fazlası olan kullanıcı fotoğraf ekleyip silemez (yeni anahtar + korunan eski kopya sığmaz). Artık veri kaybı yok ve kullanıcı bilgilendiriliyor; ama WP3 öncesine göre bu bir işlev gerilemesi. Ayrıca ~%50 altındaki kullanıcıda ilk fotoğraf kaydından sonra eski kopya kadar kapasite kaybı olur. Çözüm, PRD U5 "güvenli emeklilik": `ams_calphoto` için, sonraki bir açılışta işaret `verified` veya `superseded` ve eski baytların parmak izi işaretteki ile aynıyken eski anahtarı kaldırıp `{state:"retired", fp}` kaydetmek. Main sözleşmesi ("Legacy keys are never removed… no legacy-delete API"; testler `retireLegacy`/`deleteLegacy` yokluğunu zorlar) bunu **ayrı EVET**'e bağlar — bu yüzden uygulanmadı. Seçenekler: (i) emeklilik EVET'i + uygulama, (ii) WP3'ü EVET'siz yayınlayıp bu kullanıcı grubunu kabul edilen risk olarak işaretlemek.

Mutasyon kontrolü (repo dışı geçici kopyada; her mutasyon ilgili testleri kırmızıya çevirdi — 6/6): ana sayfa yeniden cph `reconcile` → "stranded" senaryosu FAIL; bağlanmamış tercih paragrafı kapatıldı → "wrong-city" FAIL; `toggleFav` geri almıyor → "real quota ~45%" FAIL; `delPhoto` geri almıyor → "real quota ~55%" FAIL; `addPhoto` geri almıyor → "real quota ~55%" FAIL; erteleme kapatıldı (`LARGE_COPY_CHARS=Infinity`) → "real quota ~45%" FAIL. Önceki tur: çakışma tespiti kapatılınca / trip şehir kontrolü kaldırılınca / ana sayfa `asa_trip`'e yazınca / seed eski anahtarı yok sayınca / sayfa `cph` isim alanını kullanınca ilgili testler FAIL (5/5).

## 4. Test komutları ve sonuçlar (bu oturum, yerel)

```
NODE_PATH=<playwright@1.56.1 + jsdom@24.1.3 node_modules> bash WP3_package/tests/run_all.sh
```
Yerelde `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=/opt/node-tools/node_modules:<jsdom dizini>` ile koşuldu → **`WP3_GATES_PASS`, exit 0**:
- `node --test lib/asa-storage/asa_storage.test.mjs WP3_package/tests/wp3_unit.test.mjs` → 63 test, 63 pass, 0 fail (53 lib + 10 WP3)
- `node scripts/ux_sprint1_trust_check.mjs` → `RESULT PASS` (58 PASS satırı + RESULT)
- `node WP3_package/tests/wp3_e2e.mjs` → `WP3_E2E checks pass=328 fail=0` (20 senaryo × 2 viewport)
- `sha256sum -c SHA256SUMS` → OK; Kopenhag stub `7a548e9` ile byte-identical
- `secret_scan.sh` → `secret_scan_clean`; `cdp3d_secret_scan.sh` → `SECRET_SCAN_CLEAN` (yeni dosyalar + sayfalara EKLENEN satırlar). Sayfaların tamamı taranırsa `amsterdam/index.html`'deki public anon key satırları işaretlenir — bunlar `7a548e9`'de aynı sayıda (5 + 1) vardı, WP3 eklemiyor.
- Ayrıca: `cdp3c_edge_tests.mjs` 61/0 PASS, `wse_static_check.mjs` PASS, `live_smoke.mjs --selftest` PASS, `secret_scan_selftest.sh` PASS, `CDP3D_package/SHA256SUMS` OK.

Dış istekler (hepsi route() stub'ı; hiçbiri ağa çıkmadı): `cdn.tailwindcss.com`, `fonts.googleapis.com`, `unpkg.com/leaflet@1.9.4` (js+css), `cdn.jsdelivr.net/npm/@supabase/supabase-js@2`, `images.unsplash.com/*`. Beklenen tek console mesajı: kütüphane-404 senaryosunda "Failed to load resource: 404" (kasıtlı). Gerçek kota senaryolarındaki sentetik fotoğraflar geçerli 1×1 GIF + base64 dolgu (tarayıcı hatasız çizer).

CI: `.github/workflows/wp3-storage-gates.yml` (pull_request: dokunulan yollar + workflow_dispatch; `fetch-depth: 0`; playwright@1.56.1 + jsdom@24.1.3 checkout dışına; `WP3_GATES_PASS` şart). **CI'da koşturulmadı** (push yok). `SHA256SUMS` değiştiği için PR'da `cdp3c-gates.yml` (Supabase yerel stack) de tetiklenir; yerelde yalnız onun SHA256SUMS kapısı ve statik testleri koşturuldu.

## 5. Rollback
Commit revert edilir (yalnız bu dosyalar). Eski kod yalnız eski anahtarları okur ve WP3 bunları hiç silmez/değiştirmez → geri dönüşte veri kaybı yok. Kanıt: e2e "rollback" senaryosu — eski veriyle yeni sayfa açılır (migrasyon), yeni sayfada favori eklenir, ardından **WP3 öncesi sayfa** (`git show 7a548e9:amsterdam/index.html`, aynı origin) açılır: eski favoriler/notlar/seyahat tarihleri görünür, `asa:ams:*` anahtarlarına dokunmaz; yeniden yeni sayfaya geçince WP3 döneminde yapılan düzenleme geri gelir. Sınır: WP3 canlıyken yapılan değişiklikler yalnız `asa:ams:*`'de olduğundan geri dönüş süresince eski kodda görünmez (silinmez; tekrar ileri alınınca döner).

## 6. Bilinen boşluklar / riskler
1. **Fotoğraf kapasitesi (go-live kararı, §3a):** fotoğrafları kotanın ~%50'sinden fazlası olan kullanıcı, eski `ams_calphoto` emekliye ayrılana kadar fotoğraf ekleyip silemez (mesaj + ekran geri alınır, veri kaybı yok). Daha az fotoğrafı olanlarda ilk fotoğraf kaydından sonra eski kopya kadar kapasite kaybı. Çözüm ayrı EVET gerektiren doğrulanmış emeklilik.
2. **`plan_prefs` kök çözümü (sahibi kararı, §3a b):** `legacyMap:"ams-only"` main sözleşmesini değiştirir; şimdilik bildirim + açık aktarma.
3. Canlı site, gerçek Supabase, gerçek Tailwind/Leaflet/supabase-js ile doğrulanmadı (ortam erişemiyor); e2e stub'larla. Bildirim kendi CSS'iyle (Tailwind'e bağlı değil).
4. Ana sayfada açılmamış şehir için "ilgimi bırak" artık yerel seyahat yazmıyor (önceden yalnız `asa_trip`'in üzerine yazıyordu, sunucuya gitmiyordu ve Amsterdam sayfası bunu Amsterdam planı sanıyordu). "İlgin kaydedildi" metni değişmedi — ürün kararı gerekir.
5. Ana sayfa Kopenhag seçiminde cph işareti yazmadığından, ileride Kopenhag sayfası ilk `reconcile("cph")`'ta eski Kopenhag `asa_trip`'i ile ana sayfanın yazdığı `asa:cph:trip` farklıysa "iki kopya" bildirimi gösterebilir (veri kaybı yok, yeni değer otorite). WP11 CPH sayfasını kurarken ele alınmalı; ayrıca `stranded`/`adoptLegacy` yalnız `legacyWriter` şehri (ams) için çalışır.
6. `/amsterdam/?city=Kopenhag` artık kalıcılıksız (kilitli) görünüm; hiçbir yerden linklenmiyor.
7. Bulut favori sorgusu şehir filtresiz (WP3 öncesi de öyle); başka şehir favorisi varsa `asa:ams:fav` kümesine girer (gösterilmez). WP11'de `city` filtresi önerilir.
8. `amsterdam_index_UID.html` (linksiz eski kopya) hâlâ eski anahtarlara yazar; ziyaret edilirse Amsterdam sayfasında çakışma bildirimi çıkar (kayıp yok). Ayrı PR'da emekli edilmesi önerilir.
9. İşaret yazımı kota yüzünden başarısız olursa sonraki açılış "ilk çalışma" sayılır; kullanıcı düzenlemeleri varsa yanlış-pozitif çakışma bildirimi olabilir (veri kaybı yok). Çoklu sekmede eşzamanlı ilk migrasyon için kilit yok.
10. `reconcile` her açılışta eski değerleri parse + hash eder (fotoğraflarla MB'lar); gerçek cihazda ölçülmedi.
11. `TripSync.hydrate` DB'den gelen planı depolamaya yazar ama bellekteki değişkenleri yenilemez (WP3 öncesi davranış, değişmedi). Not/plan metin kutularında kota reddi uyarısı her tuş vuruşunda çıkabilir (WP3 öncesi davranış); metin geri alınmaz.
12. Çalışma `cdp3b-asset-preview-2y4qmd` çalışma ağacında, commit'siz; bu dala eşzamanlı başka bir oturum commit atıyor (ör. izlenmeyen `LIVE_CHECKS/qa/` ve `.github/workflows/qa-live.yml` WP3'e ait değil, dokunulmadı). PR için `origin/main`'den yeni dal açılıp yalnız Bölüm 1'deki dosyalar alınmalı.
13. `asa-storage-inert.yml` adı "inert" kaldı (gerekli-check adı bozulmasın diye); yalnız yorum güncellendi.
