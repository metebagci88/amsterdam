# WP5 — Ad-soyad ve profil tamamlama (web) · Rapor

**PRD:** ASALOCAL 12 aşamalı ürünleştirme — İŞ PAKETİ 5 (Ad-soyad ve profil tamamlama), frontend kısmı
**Branch:** `wp5-profile-name` (worktree `/home/user/wp5`), ata: `cfdf79e` (main, WP4 sonrası)
**Durum:** yerel kapılar yeşil (`WP5_WEB_GATES_PASS`). Commit/push/PR yok, deploy yok, Supabase'e ve canlı siteye bağlanılmadı.
DB tarafı (`members.first_name/last_name`, `member_set_name`) ayrı paketle (`WP5_package/db`) uygulanıyor; **bu PR DB'ye dokunmaz** ve DB yokken de güvenle yayınlanabilir.

## 1. Ne değişti

| Dosya | Değişiklik |
|---|---|
| `lib/asa-name/asa_name.js` (yeni, 276 satır) | `window.ASA_NAME`: `normalize`, `validate`, `load`, `save`, `isComplete`, `shouldPrompt`, `dismiss`/`isDismissed`, `form()` (DOM API ile Ad/Soyad formu). innerHTML yok. |
| `index.html` (+91 / −4) | `asa_name.js?v=d2eb540e0eed9401`; `<main>` başında "Profilini tamamla" çağrısı; Profilim'de `#amWp5Slot` içine Ad/Soyad; girişte display_name kuralı; çıkışta temizlik. |
| `amsterdam/index.html` (+109 / −4) | Aynı kütüphane ve pin; WP3 bildiriminin altında çağrı; Üye → Kart'ta Ad/Soyad bölümü; `afterAuth` display_name kuralı; çıkışta temizlik; çağrı/alan CSS'i (Tailwind'e bağlı değil). |
| `SHA256SUMS` | Yalnız `amsterdam/index.html` satırı yenilendi (`kopenhag/index.html` aynı). |
| `WP5_package/web/tests/` (yeni) | `run_all.sh`, `wp5_unit.test.mjs`, `wp5_e2e.mjs`, `stubs/supabase_stub.js` (WP4 stub'ının WP5 kopyası). |
| `.github/workflows/wp5-web-gates.yml` (yeni) | PR (ilgili yollar) + `workflow_dispatch`, `contents: read`, sabit sürüm bağımlılıklar, `run_all.sh`, secret scan. |

Dokunulmayanlar: Kopenhag stub'ı (byte-identical), admin sayfaları, eski sayfalar (`amsterdam.html`, `amsterdam_index_UID.html`), `lib/asa-storage`, WP3 depolama davranışı, paywall/teaser, WSE eşlemesi, WP4 menüsü/dialogları. WP4/WP3 testlerinde hiçbir assertion değiştirilmedi; pin/hash güncellemesi de gerekmedi (yalnız `SHA256SUMS`'taki şehir sayfası satırı).

## 2. Davranış

- **Akış:** giriş/kayıt başarılı → oturum → `member_upsert_profile` (satır hazır) → `ASA_NAME.load` (kendi satırı: `first_name,last_name`) → eksikse çağrı → Ad + Soyad → `member_set_name` → "Adın ve soyadın kaydedildi." → normal kullanım. İsim okuması girişi **beklemez**; OTP/Auth kodu yalnız display_name satırında değişti.
- **Çağrı** (ana sayfa `#namePrompt`, şehir `#asaNamePrompt`): metin "Profilini tamamla: adını ve soyadını ekle." + "Zorunlu değil…" ipucu, Ad/Soyad, **Kaydet**, **Şimdi değil**. Gösterim şartı: girişli üye + desteklenen backend + satır hazır + ad ya da soyad eksik + "Şimdi değil" denmemiş. Modal değil, odak çalmaz, sayfanın geri kalanı kullanılabilir.
  - Ana sayfada `<main>` başında, şehir sayfasında WP3 bildiriminin altında; `section aria-labelledby` (adlı bölge).
- **Şimdi değil:** `asa:name_prompt_dismissed:<uid>` = "1" (try/catch). Çağrı kapanır, odak hesap düğmesine gider (ana sayfa `#acctBtn`, şehir üst bardaki üye düğmesi). Yeniden yüklemede ve diğer sayfada da gizli kalır. Depolama kapalı ya da hata veriyorsa yalnız o sayfa açıkken gizli kalır (yeniden yüklemede tekrar sorulur, hata yok).
- **Profilim / Kart:** Ad/Soyad her zaman düzenlenebilir (çağrı kapatılmış olsa da). Ana sayfada alanlar yalnız `#amWp5Slot` içinde (WP4 "Profilim'de yuva dışında alan yok" kontrolü korunur). Kart'ta mevcut "Görünen Ad / cinsiyet / şehir" formu aynen duruyor; Ad/Soyad ayrı bölüm ve ayrı Kaydet. Şehir sayfası Kart'ı sık yeniden çizdiği için form öğesi saklanır: yazılan değer ve süren kayıt yeniden çizimde kaybolmaz.
- **Kayıt başarılıysa** (her iki yerden): çağrı kapanır, Profilim/Kart değerleri güncellenir. Çağrıdan kaydedildiyse onay satırı (`role="status"`) görünür ve odak ona taşınır.
- **Var olan kullanıcı zorlanmaz:** adı ve soyadı doluysa çağrı yok, yazma yok.
- **Backend yok** (`42703` select / `PGRST202`/404 rpc) ya da kütüphane yüklenemedi: çağrı ve alanlar hiç görünmez, başka hiçbir şey değişmez, konsol hatası yok.

## 3. Güvenlik, doğrulama, erişilebilirlik

- İsimler yalnız `input.value` ile yazılır; mesajlar `textContent`. Kütüphanede ve sayfaların WP5 bloklarında innerHTML/insertAdjacentHTML yok (birim testi + innerHTML'i fırlatan sahte DOM).
- **İstemci politikası = sunucu CHECK'i:** `asa_name.js` içindeki karakter sınıfları `WP5_DB_up.sql` CHECK literal'lerinin birebir kopyası (`\xHHH` → `\u{HHH}`). İstemci ek olarak yalnız U+0000 ve eşsiz surrogate'ı reddeder (sunucu zaten saklayamaz). Fark testi: tüm BMP kod noktaları × 3 konum + astral örnekler (≈218 bin girdi) → 0 fark. Drift tripwire: DB paketi checkout'ta varsa literal'ler birebir karşılaştırılır.
- Sunucu otoritedir: `save()` RPC yanıtını eşler (`bad_first/bad_last` → alanı işaretler ve odaklar; `no_auth`, `no_member_row`, ağ hatası, `PGRST202` → Türkçe mesaj). Bilinmeyen `reason` (`__proto__` dahil) → genel mesaj.
- Profil güncelleme yalnız kendine: sayfa uid göndermez; `member_set_name` `auth.uid()` ile çalışır. Okuma yalnız `eq("user_id", uid)` + RLS.
- Başarı ve hata hiçbir zaman birlikte gösterilmez (her denemede ikisi de temizlenir). Çift gönderim: `busy` + tıklama koruması, tek RPC. Kaydederken düğme `aria-disabled` (odak düğmede kalır), "Kaydediliyor…".
- `<label for>`, `autocomplete="given-name"/"family-name"`, `maxlength="50"`, `aria-invalid` + `aria-describedby`, hata `role="alert"`, başarı `role="status"`; Enter gönderir; Tab sırası `#acctBtn → Ad → Soyad → Kaydet → Şimdi değil`.
- Yarış: oturum değişince (çıkış, başka hesap) eski okuma sonucu atılır (sıra sayacı + uid kontrolü).

## 4. display_name kararı

- **Girişte artık ezilmiyor.** Önce kendi satırındaki `display_name` okunur. Doluysa (ya da okunamadıysa) `p_display_name: null` gönderilir; `member_upsert_profile` COALESCE ile mevcut değeri korur. Satır yoksa ya da ad boşsa e-posta yerel kısmı gönderilir.
  - Ana sayfa: giriş yolu (`doAuth`). Şehir sayfası: `afterAuth`. `afterAuth` her sayfa açılışında da çalıştığı için asıl ezilme kaynağı buydu.
  - Görevdeki formülden tek bilinçli sapma: okuma hata verirse `null` gönderilir. Okunamayan değer ezilmez.
- **Kayıt (signup) değişmedi:** yine e-posta yerel kısmı.
- Kullanıcının kendi seçtiği ad (`saveName`, Kart "Değişiklikleri Kaydet") değişmedi.
- **AÇIK ÜRÜN KARARI:** herkese açık görünen ad hâlâ e-posta yerel kısmından türetiliyor (yeni üye, eski üye). Bu, e-posta adresinin bir kısmını herkese açık yapar. Öneri: kayıt/profilde kullanıcının herkese açık bir ad seçmesi; varsayılan e-postadan türetilmesin. Bu PR yalnız ezilmeyi durdurur.

## 5. Test sonuçları (yerel, bu worktree)

`bash WP5_package/web/tests/run_all.sh` → **`WP5_WEB_GATES_PASS`** (rc=0):

| Adım | Sonuç |
|---|---|
| WP5 birim (`node --test`) | 18 test: **17 pass / 0 fail / 1 skip**. Skip = DB drift tripwire, DB paketi bu checkout'ta yok. `WP5_DB_SQL=…/WP5_DB_up.sql` ile **18/18**. |
| WP5 e2e (Playwright) | **405 pass / 0 fail / 0 skip** (Tailwind build: evet). 20 senaryo, her biri 1366 ve 390'da; 2'si ayrıca 360'ta (toplam 42 koşu). Konsol hatası her senaryoda 0. Tek istisna: "kütüphane 404" senaryosu; orada yalnız beklenen 404 kaynak hatası kabul edilir. |
| WP4 birim | 15 test: **10 pass / 0 fail / 5 skip**. Skip'ler WP4'e özel tek seferlik kapsam kontrolleri (`WP4_SCOPE_CHECKS=0`). |
| WP4 e2e | **342 pass / 0 fail** |
| WP3 lib + birim | **78/78** |
| UX Sprint 1 (jsdom) | **RESULT PASS** |
| WP3 e2e | **454 pass / 0 fail** |
| Diğer kapılar | `CPH_STUB_IDENTICAL`, `WSE_STATIC_PASS`, WSE SHA256SUMS OK |
| Pin ve bütünlük | `ASA_NAME_PIN_OK` (iki sayfa, `v=d2eb540e0eed9401`), `SHA256SUMS_OK` |
| Secret scan | Tüm secret scan'ler temiz (WP3, WP4, WP5) |

Önceki durum (`cfdf79e`): WP4 e2e 342/0, WP3 e2e 454/0, WP3 78/78, UX PASS. Sayılar aynı; regresyon yok.

**WP5 e2e kapsamı:**
- anon'a çağrı ve alan yok, isim sorgusu yok
- isimsiz üye: tek çağrı, modal değil, odak çalınmıyor, Tab sırası, klavyeyle yazıp Enter → kayıt
  - onay + odak, yeniden yükleme, Profilim ve Kart'ta değerler
  - başka üyenin satırı değişmiyor
- Şimdi değil: bayrak, yeniden yükleme, şehir sayfası; Profilim'den kayıt
- adı olan üyede çağrı yok, yazma yok, `p_display_name: null`
- ana sayfa ve şehir girişi:
  - mevcut display_name → `null`; satır yok / boş ad → yerel kısım
  - girişten sonra çağrı
  - yanlış şifre mesajı değişmedi
- XSS:
  - `<img src=x onerror=…>` ve `"><script>` istemcide ve sunucu modelinde reddediliyor
  - saklı XSS benzeri değerler yalnız metin olarak görünüyor; eleman eklenmiyor, bayrak yok, `/x` isteği yok
- doğrulama: 51 karakter (yazarken 50'de duruyor, programla 51 → alert), boş, yalnız boşluk, sunucu nedenleri
- backend yok; kütüphane 404
- localStorage hata veriyor
- yarış: bekleyen okuma sırasında çıkış; A'nın gecikmiş okuması B'yi ezmiyor; Profilim açıkken yavaş okuma
- çift gönderim
- Kart yeniden çizimi
- 360/390/1366'da yatay taşma yok

Test ortamı notu: Material Symbols fontu stub'landığında ikon ligatürü metin olarak genişliyor ve şehir sayfası 390px'te (main'de de) taşıyor. WP5 e2e bunun yerine ikon başına 1em CSS koyuyor; gerçek fontun ölçüsü bu.

**Mutasyon kontrolü** (scratch kopyalar, WP5 birim + e2e masaüstü/390): **16/16 yakalandı**.

| # | Bozma | Yakalayan |
|---|---|---|
| M01 | Profilim'de innerHTML ile isim | birim + 6 e2e |
| M02 | dismiss kalıcı değil | 2 birim + 10 e2e |
| M03 | ana sayfa girişinde yerel kısım | birim + 4 e2e |
| M04 | şehir `afterAuth`'ta yerel kısım | birim + 12 e2e |
| M05 | backend yokken çağrı | birim + 10 e2e |
| M06 | alanlar yuva dışında | birim + 2 e2e |
| M07 | çift gönderim koruması yok | birim (e2e'de tıklama koruması ikinci hat) |
| M08 | durum satırları temizlenmiyor | birim + 2 e2e |
| M09 | yarış koruması yok | 4 e2e (ilk turda kaçtı → A→B senaryosu ve stub'da uid'e göre gecikme eklendi) |
| M10 | çağrı odak çalıyor | 2 e2e |
| M11 | istemci doğrulaması yok | 4 birim + 6 e2e |
| M12 | maxlength yok | birim + 4 e2e |
| M13 | adı olan üyeye çağrı | birim + 14 e2e |
| M14 | Kart formu her çizimde yeniden kuruluyor | 4 e2e |
| M15 | şehirde Şimdi değil odak taşımıyor | 2 e2e |
| M16 | lib değişti, pin yenilenmedi | birim |

## 6. Geri alma

PR'ı revert etmek yeterli. Bu PR DB'yi, Edge'i, Auth'u değiştirmez. Revert sonrası sayfalar WP4 haline döner; DB kolonları ve RPC kalsa da kullanılmaz. Revert'le dönen tek davranış: girişte display_name'in yeniden ezilmesi. Tarayıcıda kalan `asa:name_prompt_dismissed:*` anahtarları zararsızdır, hiçbir kod okumaz.

## 7. Canlı kabul planı

1. **DB'den önce (Cloudflare preview):**
   - Çağrı ve alanlar görünmüyor; konsol temiz; giriş ve OTP çalışıyor (backend-missing modu).
   - Ağ sekmesinde `members?select=first_name,last_name` → 400/42703, başka hata yok.
2. **DB paketi uygulandıktan sonra (preview, özel QA üyesi):** QA üyesinin adı ve soyadı boş başlar.
   - Ana sayfada: çağrı → Şimdi değil → yenile (gizli) → şehir sayfası (gizli).
   - Profilim'den kaydet → `{ok:true}` → yenile (değerler duruyor).
   - XSS, 51 karakter ve boş girdi denenir (`role=alert`, RPC yok).
   - display_name girişten önce ve sonra aynı (Supabase'de yalnız QA satırına salt-okuma sorgusuyla bakılır).
   - Başka üye satırı değişmedi.
   - 360/390 mobil.
3. **Production:** aynı adımlar yalnız özel QA üyesiyle yapılır. Gerçek üyelere yazma ve backfill yok.
   - İzlenecek: konsol hataları, `member_set_name` hata oranı (bad_* / no_member_row).
   - Sorunda PR revert edilir (DB'ye dokunmadan).

## 8. Açık riskler / sınırlar

- **Herkese açık display_name** hâlâ e-posta yerel kısmı (§4, ürün kararı bekliyor).
- **`amsterdam_index_UID.html` (eski kopya)** girişte display_name'i hâlâ ezer. Kapsam dışı bırakıldı (WP3/WP4 de dokunmadı). Yayında erişilebiliyorsa kaldırılması ya da yönlendirilmesi önerilir.
- **`maxlength=50` UTF-16 birimi sayar:** düzlem dışı karakterlerde (nadir CJK Ext B–G, Adlam) yazarken 25'te durabilir; sunucu 50 kod noktasına izin verir. Türkçe ve yaygın yazı sistemleri etkilenmez.
- **Kısmi DB uygulaması** (kolon var, RPC yok): çağrı görünür, Kaydet "şu an kaydedilemiyor" der. Kapatılabilir, engellemez.
- **Depolama kapalıysa** "Şimdi değil" kalıcı olmaz (her yüklemede tekrar sorulur).
- **CI henüz koşmadı** (commit/push yok). `wp5-web-gates.yml` yalnız yerelde eşdeğer komutlarla doğrulandı.
- **Stub sınırı:** sunucu modeli SQL CHECK literal'lerini birebir kullanır, ama gerçek PostgREST/RLS değildir. Gerçek davranışı DB paketinin kendi kapıları ve §7 kanıtlar.
