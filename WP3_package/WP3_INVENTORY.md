# WP3 — Browser storage envanteri (İŞ PAKETİ 3)

Kapsam: canlı sayfalardaki tüm `localStorage` / `sessionStorage` okuma-yazma-silme noktaları.
Satır numaraları **WP3 öncesi** `7a548e9` (origin/main) içindir; "WP3 sonrası" sütunu bu dalda aynı noktanın yeni karşılığıdır.
Domain eşlemesi `lib/asa-storage/asa_storage.js` REGISTRY'sidir: `fav`, `plan`, `dayven`, `cal`, `calphoto`, `trip`, `plan_prefs` → `asa:<şehir>:<domain>`.

## 1. `amsterdam/index.html` (Amsterdam şehir sayfası, `/amsterdam/`)

| Satır (7a548e9) | Fonksiyon / blok | İşlem | Anahtar | Domain | WP3 sonrası |
|---|---|---|---|---|---|
| 596 | `TripSync` → `P(k,d)` (genel okuyucu) | get | (parametre) | — | 601 `P(domain)` → `ASA_ST.get` |
| 600 | `TripSync.collect` | get | `asa_plan_prefs`, `asa_trip` | plan_prefs, trip | 607 `P('plan_prefs')`, `T()` (şehir kontrollü trip) |
| 603 | `TripSync.collect` | get | `ams_dayven`, `ams_cal`, `ams_plan` | dayven, cal, plan | 610 `P('dayven'/'cal'/'plan')` |
| 621 | `TripSync.hydrate` (DB → yerel) | set | `asa_plan_prefs` | plan_prefs | 628 `S('plan_prefs')` |
| 622 | `TripSync.hydrate` | set | `ams_dayven`, `ams_cal`, `ams_plan` | dayven, cal, plan | 629 `S(...)` |
| 954 | `initFav` (favori seed kararı) | get | `ams_fav` | fav | 1016 `ASA_ST.read("fav")` (yeni **veya** eski varsa "present") |
| 962 | `initFav` (seed yazımı) | set | `ams_fav` | fav | 1023 `ASA_ST.set("fav")` — yalnız yeni+eski ikisi de yoksa ve depolama yazılabilirse |
| 966 | `toggleFav` | set | `ams_fav` | fav | 1027 `ASA_ST.set("fav")`; yazım reddedilirse (kota) değişiklik geri alınır + mesaj, bulut senkronu çağrılmaz |
| 1363 | üst düzey `calNotes` | get | `ams_cal` | cal | 1424 `ASA_ST.get("cal",{})` |
| 1365 | üst düzey `calPlans` | get | `ams_plan` | plan | 1426 |
| 1366 | üst düzey `calPhotos` | get | `ams_calphoto` | calphoto | 1427 (büyük eski değer kopyalanmamışsa — `deferred` — eski anahtardan okunur) |
| 1368 | üst düzey `dayVenues` | get | `ams_dayven` | dayven | 1429 |
| 1371 | `saveLS(k,o)` (genel yazıcı + `__tripDirty`) | set | (parametre) | — | 1432 `saveLS(domain,o,quiet)` → `ASA_ST.set`, sonucu döndürür; kota hatasında uyarı ("fotoğrafları sil" önerisi kaldırıldı) |
| 1372 | `addPhoto` → `saveLS` | set | `ams_calphoto` | calphoto | 1433 `saveLS("calphoto")`; kaydedilemezse fotoğraf ekrandan geri alınır + mesaj |
| 1373 | `delPhoto` → `saveLS` | set | `ams_calphoto` | calphoto | 1434; kaydedilemezse silme geri alınır + mesaj |
| 1375 | `buildCalDays` | get | `asa_trip` | trip | 1436 `ASA_ST.trip()` (başka şehir → null) |
| 1409 | `tripInterests` | get | `asa_trip` | trip | 1470 |
| 1446 | `autoGeneratePlan` → `saveLS` | set | `ams_dayven`, `ams_plan` | dayven, plan | 1507 |
| 1450 | `clearPlan` → `saveLS` | set | `ams_dayven`, `ams_plan` | dayven, plan | 1511 |
| 1471 | `PSET.trip()` | get | `asa_trip` | trip | 1532 `ASA_ST.trip()||{}` |
| 1472 | `PSET.prefs()` | get | `asa_plan_prefs` | plan_prefs | 1533 |
| 1492 | `PSET API.setDate` | set | `asa_trip` | trip | 1553 `ASA_ST.set("trip")` |
| 1503 | `PSET savePrefs` | set | `asa_plan_prefs`, `asa_trip` | plan_prefs, trip | 1564 |
| 1619 | `runEngine` → `saveLS` | set | `ams_dayven` | dayven | 1680 |
| 1675 | `addDayVenue` → `saveLS` | set | `ams_dayven` | dayven | 1736 |
| 1676 | `removeDayVenue` → `saveLS` | set | `ams_dayven` | dayven | 1737 |
| 1701 | `commitDayOrder` → `saveLS` | set | `ams_dayven` | dayven | 1762 |
| 1742 | `renderDay` `#dayPlan` input | set | `ams_plan` | plan | 1803 |
| 1743 | `renderDay` `#dayNote` input | set | `ams_cal` | cal | 1804 |
| 2104 | `ASA.saveSession` | set | `asa_session` | **paylaşılan auth — dokunulmadı** | 2165 (aynı) |
| 2105 | `ASA.loadSession` (tanımlı, çağrılmıyor) | get | `asa_session` | **dokunulmadı** | 2166 (aynı) |
| 2127 | `ASA.loadTripContext` (`?trip=` köprüsü) | get | `asa_trip` | trip | 2190 `ASA_ST.trip()`; öncesinde 2183 yazılabilirlik + 2186 DB trip şehir kontrolü |
| 2131 | `ASA.loadTripContext` | set | `asa_trip` | trip | 2194 |
| 2139 | `ASA.importGuestTrip` | get | `asa_trip` | trip | 2203 (2202 yazılabilirlik kontrolü) |
| 2147 | `ASA.importGuestTrip` (mevcut DB trip benimsenir) | set | `asa_trip` | trip | 2211 |
| 2152 | `ASA.importGuestTrip` (yeni DB trip) | set | `asa_trip` | trip | 2216 |
| 2200 | `ASA.syncOnLogin` (engelli üye) | remove | `asa_session` | **dokunulmadı** | 2264 (aynı) |
| 2212 | `ASA.syncOnLogin` (bulut ∪ yerel favori) | set | `ams_fav` | fav | 2276 `ASA_ST.set("fav")`; yazım reddedilirse bildirim (birleşim bu oturumda gösterilir, cihazdaki kayıt değişmez) |
| 2252 | `ASA.logout` | remove | `asa_session` | **dokunulmadı** | 2316 (aynı) |
| 2445 | `renderTripBanner` | get | `asa_trip` | trip | 2509 `ASA_ST.trip()` |
| — | `supabase-js` SDK (sayfa kodu değil) | get/set/remove | `sb-<ref>-auth-token` | **dokunulmadı** | aynı |

Yeni noktalar (WP3): 569 kütüphane yüklemesi (`/lib/asa-storage/asa_storage.js?v=<sha256(16)>`, ilk inline script'ten önce); 966–1011 `window.ASA_ST` adaptörü (`reconcile` sayfa açılışında bir kez, uyarı/afiş; Amsterdam'a bağlanmamış eski plan tercihleri için yalnız kullanıcı tıklayınca çalışan `adoptLegacy` — "Amsterdam planına aktar"; kota reddinde `full()` mesajı, `say()` bildirimi); 435 `#asaStoreNotice` (`role="status"`, `aria-live="polite"`).

### Login sonrası bulut favori birleşimi (2197–2220 → 2261–2284)
`syncOnLogin`: `cloud = favorites.select(venue_id).eq(user_id)`, `local = [...favSet]`, `union = cloud ∪ local`; yalnız-yerel olanlar `favorites.upsert` ile buluta gider; `favSet = union` ve yerel yazım. WP3'te mantık aynı, yazım `asa:ams:fav`'a gider (`ams_fav` dokunulmaz); yazım kota yüzünden reddedilirse kullanıcıya bildirilir (birleşim bulut kaynaklı olduğundan bu oturumda gösterilmeye devam eder; sonraki girişte yeniden birleşir). Not: bulut sorgusu şehir filtresi içermez (WP3 öncesi de yoktu) — bkz. rapor "bilinen boşluklar".

### Favori seed mantığı (952–963 → 1015–1024)
WP3 öncesi: `ams_fav` anahtarı **yoksa** (`raw===null`) `V` içindeki `fav:true` mekânlar seed edilip yazılırdı; bozuk/boş dizi "var" sayılırdı. WP3: seed yalnız `asa:ams:fav` **ve** `ams_fav` ikisi de yoksa (`AsaStorage.get(...).source==="missing"`) ve depolama yazılabilirse (`ASA_ST.writable()`) çalışır; bozuk değer yine "var" sayılır (seed yok). Seed yalnız `asa:ams:fav`'a yazılır.

### Eski plan tercihleri (`asa_plan_prefs`) — yazan tek yer Amsterdam sayfası
`7a548e9`'de `asa_plan_prefs`'i yazan yerler yalnız `amsterdam/index.html` (`PSET savePrefs` 1503, `TripSync.hydrate` 621) ve linksiz eski kopya `amsterdam_index_UID.html`; ana sayfa her şehir seçiminde yalnız `asa_trip`'i yeniden yazıyordu. Kütüphane (main sözleşmesi, değişmedi) `asa_plan_prefs`'i eski `asa_trip`'in şehrine göre yerleştirir (`follow-trip`). Bu yüzden son ana sayfa seçimi Kopenhag olan bir kullanıcının Amsterdam tercihleri `ams` dışında kalır. WP3: `REGISTRY.plan_prefs.legacyWriter="ams"`; Amsterdam açılışında bu durum `reconcile().stranded` ile raporlanır, bildirimde gösterilir ve yalnız kullanıcı "Amsterdam planına aktar" derse `adoptLegacy` ile `asa:ams:plan_prefs`'e birebir kopyalanır (varsa üzerine yazılmaz; eski anahtar kalır). "Anladım" reddi parmak iziyle işarete yazılır.

## 2. `index.html` (ana sayfa — seyahat oluşturur)

| Satır (7a548e9) | Fonksiyon | İşlem | Anahtar | Domain | WP3 sonrası |
|---|---|---|---|---|---|
| 422 | `saveTrip(navigate)` | set | `asa_trip` | trip | 427: Trip Policy A — `cityCodeFromLabel(sel.city)`: Amsterdam→`asa:ams:trip`, Kopenhag→`asa:cph:trip`, açılmamış şehir (ör. Paris)→**yazım yok**. Amsterdam'da yazmadan önce `reconcile("ams")` (migrasyon+işaret) çalışır; Kopenhag açılana kadar **cph migrasyonu çalıştırılmaz** (yalnız seyahat yazılır, eski Amsterdam verisi `asa:cph:*`'a kopyalanmaz). `asa_trip` yazılmaz/silinmez. |
| 544 | `renderAuthBody` → `amLogout` | remove | `asa_session` | **dokunulmadı** | 549 (aynı) |
| — | `supabase-js` SDK | get/set/remove | `sb-<ref>-auth-token` | **dokunulmadı** | aynı |

Yeni: 291 kütüphane yüklemesi (aynı `?v=`).

## 3. Diğer yayındaki dosyalar (WP3 ile değişmedi)

| Dosya | Depolama erişimi | Not |
|---|---|---|
| `kopenhag/index.html` | yok (`<script>` yok) | Stub; byte-identical (SHA `8428c222…`). CPH izolasyonu yalnız testlerle kanıtlanır. |
| `amsterdam.html` | yok | `/amsterdam/`'a yönlendirme. |
| `admin.html`, `CDP3B/admin.html` | `sessionStorage` `asa-admin-auth` (supabase `storageKey`) | Şehir verisi yok; dokunulmadı. |
| `amsterdam_index_UID.html` | **eski anahtarlar**: `ams_fav` 958/962/2056, `ams_cal` 1326, `ams_plan` 1328, `ams_calphoto` 1329, `ams_dayven` 1331, `saveLS` 1334, `asa_trip` 1338/1372/1434/1455/1466/2226, `asa_plan_prefs` 1435/1466, `asa_session` 1992/1993/2044/2096 | Eski (11–31 Temmuz) anlık görüntü; hiçbir sayfadan link yok ama URL ile erişilebilir. **Bağlanmadı.** Ziyaret edilirse eski anahtarlara yazar → Amsterdam sayfası bunu "çakışma" olarak gösterir (yeni değer korunur). Ayrı PR'da emekliye ayrılması önerilir. |
| `CDP3C_package/edge_admin/web/cookie_consent.js` | `asa_cookie_decision_v2` | Canlı sayfalarca yüklenmiyor; korumalı anahtar listesinde, dokunulmadı. |

## 4. Korunan (şehir dışı) anahtarlar
`asa_session`, `sb-<ref>-auth-token`, `sb-<ref>-auth-token-code-verifier`, `asa-admin-auth`, `asa_cookie_decision_v2`. Kütüphane bu anahtarlara yazmayı reddeder (`invalid_domain` / `refusing_protected_key`); `migrate`/`reconcile`/`clearCity` öncesi-sonrası anlık görüntüyle değişmediklerini doğrular.
