# WP4 — Üye hesabı ve profil navigasyonu · Rapor

**PRD:** ASALOCAL 12 aşamalı ürünleştirme — İŞ PAKETİ 4 (ve §2 bağlayıcı ilkeler)
**Branch:** `wp4-member-nav` (worktree `/home/user/wp4`), ata: `7801394` (WP3 başı)
**Durum:** yerel kapılar yeşil (`WP4_GATES_PASS`, hem kapsam modunda hem kalıcı modda). İnceleme turu 2'deki 4 bulgu (1 blocker, 3 major) yeniden üretildi ve düzeltildi (§8). Commit/push yapılmadı, deploy yapılmadı, Supabase'e yazılmadı.

## 1. Özet

- Ana sayfadaki üye ikonu (`#acctBtn`) artık iki ayrı durum çiziyor:
  - **Anon:** `aria-label="Giriş yap / üye ol"`, tıklayınca yalnız giriş/kayıt dialogu açılıyor. Özel menü, tercih ya da seyahat alanı açılmıyor.
  - **Girişli:** `aria-label="Hesabım: <ad>"`, `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls="acctMenu"`. Tıklayınca **Hesabım** çekmecesi açılıyor; içinde sırasıyla tam olarak şu beş öğe var: Profilim · E-posta tercihlerim · Kayıtlı seyahatlerim · Yeni seyahat oluştur · Çıkış yap.
- **Profilim** ana sayfada açılıyor; seyahat ya da şehir sayfası gerekmiyor (ikon → Profilim, 2 etkileşim). Ad ve e-posta yalnız `textContent` ile yazılıyor; bu, eski L542 self-XSS açığını kapatıyor. E-posta yalnız gösteriliyor. Seviye/puan bugünkü gibi. WP5 için gizli bir yer tutucu var (`#amWp5Slot[data-wp5-slot="profile-name"]`). İsim düzenleme ya da DB yazma **yok**.
- **E-posta tercihlerim** ana sayfada açılıyor. Şehir sayfasıyla aynı CDP-3C sözleşmesini kullanıyor: okuma `consent_get_my_state`, yazma `service_pref_set{p_key,p_enabled,p_request_id,p_idem(uuid v4)}`.
  - `not_configured` → "Varsayılan belirlenmedi" (asla "Kapalı" değil).
  - Hata ya da `{ok:false}` → `role="alert"` ile gösteriliyor, satır değişmiyor, başarı iddia edilmiyor.
  - Başarıda satır sunucunun onayladığı değerle güncelleniyor ve `role="status"` ile bildiriliyor.
- **Kayıtlı seyahatlerim** menüden her zaman açılabiliyor. Liste yalnız oturumdaki üyenin seyahatlerini gösteriyor. Asıl koruma sunucudaki RLS kuralı; sayfadaki `user_id` süzgeci ek savunma. Yükleme hatası "seyahat yok" diye gösterilmiyor, `role="alert"` ile bildiriliyor.
  - 0 seyahatte boş durum: "Henüz kayıtlı seyahatin yok. Ülke, şehir ve gidiş–dönüş tarihlerini seçip keşfet düğmesiyle ilk seyahatini oluştur." Metin gerçek davranışı söylüyor: `saveTrip` seyahat kaydını yalnız iki tarih de seçiliyse oluşturur (davranış değişmedi).
  - "Yeni seyahat oluştur" (boş durum düğmesi ve menü öğesi) dialogu kapatıp odağı `#countrySel` alanına veriyor. Tarih seçilmemişse arama düğmesinin altındaki `#dInfo` satırında "Seyahatin kaydedilmesi için gidiş ve dönüş tarihlerini seç." yazıyor; iki tarih seçilince bu satır mevcut süre bilgisine dönüyor.
  - Arşivle: odak dialogda kalıyor (aynı sıradaki satırın "Arşivle" düğmesi; liste boşaldıysa "Yeni seyahat oluştur"; o da yoksa ✕). Sonuç `role="status"` ile "Seyahat arşivlendi." olarak bildiriliyor; başarısızlıkta `role="alert"` ile "Seyahat arşivlenemedi. Tekrar dene." yazıyor ve başarı iddia edilmiyor. Arşiv çağrıları aynı (`trip_save`, çakışmada sunucu revizyonuyla bir kez daha).
- **Çıkış yap** mevcut anlamı koruyor (`signOut` + `asa_session` silme). Ek olarak tüm hesap dialoglarını kapatıyor, özel içeriği temizliyor ve odağı `#acctBtn` öğesine veriyor. Çift tıklamada yalnız bir `signOut` çağrılıyor.
- **Ortak erişilebilir dialog yardımcısı (`ASA_DLG`)** dört dialogda kullanılıyor: `#authModal`, `#tripsModal`, `#acctMenu`, `#prefsModal`. Sağladıkları:
  - `role="dialog"`, `aria-modal`, `aria-labelledby`
  - açılışta ilk kontrole odak, Tab/Shift+Tab tuzağı
  - ESC ve dış tıklama ile kapatma
  - kapanınca odağın açan öğeye dönmesi
- **Erişilebilirlik düzeltmeleri:**
  - giriş/kayıt alanlarına görünür `<label for>` ve `autocomplete` eklendi
  - `#amErr` artık `role="alert"`
  - tüm ✕ düğmeleri `aria-label="Kapat"`
  - seyahat düğmelerinde veri satır içi `onclick` yerine `data-*` özniteliğinden okunuyor (şehir adıyla JS enjeksiyonu kapandı)
- **Şehir sayfası** (`amsterdam/index.html`, yalnız 3 satır değişti):
  - tercih etiketi düzeltildi: `not_configured` artık "Varsayılan belirlenmedi"
  - üst bardaki üye düğmesine `aria-label="Üyelik ve hesabım"` eklendi; ikon ligatürü `aria-hidden`
- **WSE tripwire güncellendi:** `WSE_DEFAULT_package/gates/wse_static_check.mjs` şehir sayfasının eski koşulunu ve "`not_configured` → Kapalı" eşlemesini sabitliyordu; WP4 ile kırmızıya dönüyordu. Yeni eşleme sabitlendi (`not_configured`/`config_pending` → "Varsayılan belirlenmedi", `true` → Açık, `false` → Kapalı). `WSE_DESIGN.md`, `WSE_TEST_MATRIX.md` ve `WSE_DEFAULT_package/SHA256SUMS` buna göre güncellendi. WP4 `run_all.sh` artık bu kontrolü de koşuyor.
- **Kapı ikiye ayrıldı:** kalıcı sözleşme kontrolleri her PR'da koşuyor. "Bu PR yalnız şunu değiştirdi" ve "WP5 yok" gibi tek seferlik kontroller yalnız `WP4_SCOPE_CHECKS=1` ile koşuyor. Workflow bunu yalnız `wp4-member-nav` branch'i için açıyor ve bu kontroller PR head commit'ini okuyor (`WP4_HEAD_REF`). Böylece WP5 ya da yeni bir main bu kapıyı kırmızıya çevirmiyor.

## 2. Başlangıç doğrulaması (salt-okunur)

- `origin/main` = `8acfb0e` (PR #13 WP3 merge). `git diff 7801394 8acfb0e` boş, yani WP4'ün atası main ile aynı ağaç.
- Supabase (`tosqsabuaomgqjtogdrn`), yalnız `SELECT`, kişisel veri okunmadı:
  - `pg_policies`:
    - `trips`: select/update/delete `auth.uid() = user_id`; insert yalnız `authenticated`
    - `members`: select/update `auth.uid() = user_id`
  - `consent_get_my_state()`:
    - SECURITY DEFINER, `auth.uid()` yoksa `no_auth`
    - `{consent:{…}, service_prefs:{key: bool | 'not_configured'}}` döner; bir üyenin kayıtlı satırı olmayan anahtar `not_configured` döner
  - `service_pref_set(p_key service_pref_key, p_enabled boolean, p_request_id text, p_idem uuid)`:
    - `_require_request_id`: 1–80 karakter
    - `p_idem` zorunlu
    - `{ok:true,key,enabled}` döner
  - `service_pref_defaults`: 7 anahtar; yalnız `welcome_service_email` için `default_enabled=true` (policy `welcome_service_email.v1`), diğer 6 anahtar `null`
  - `trips.id` bigint, `revision` integer

## 3. PRD gereksinimi → uygulama → test eşlemesi

e2e satırlarının hepsi masaüstü (1280×800) ve mobil (390×844) görünümde ayrı ayrı koşar.

| PRD İŞ PAKETİ 4 maddesi | Uygulama (index.html, aksi yazmıyorsa) | Test |
|---|---|---|
| Bilgi mimarisi: 5 öğeli menü/drawer | `#acctMenu` (sağ çekmece), `nav[aria-label="Hesap menüsü"]` | e2e "member: … exactly the 5 items"; unit "account button and menu" |
| 1. Anon ve girişli durumları ayrı çiz | `renderAcct()` iki dal; `onAcctBtn()` (session → menü, değilse giriş) | e2e "anon: …", "member: …" |
| 2. Anon ikon → giriş/üye ol | `aria-label="Giriş yap / üye ol"`, yalnız `#authModal` | e2e "anon: …" (özel dialog açılmaz; `openPrefs/openTripsModal/acctAction` anon çağrılırsa giriş dialoguna düşer; trips/members sorgusu ve prefs RPC çağrısı yok) |
| 3. Girişli ikon tıklanabilir, klavye erişilebilir, anlamlı label | `Hesabım: <ad>`, `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`; uzun ad `truncate` | e2e "member: …", "keyboard + pointer" (Enter ile açılır), "XSS" (tek satır kalır, taşma yok) |
| 4. Profil seyahat kaydı olmadan açılır | Menü → Profilim = `#authModal` girişli gövdesi (Profilim başlığı) | e2e "Profilim: reached in 2 interactions with ZERO trips" (≤2 tıklama, ad/e-posta/seviye görünür, form alanı yok, DB yazma yok) |
| 5. Kayıtlı seyahat yoksa boş durum + "Yeni seyahat oluştur" | `renderTripsList()` boş durumu (ülke, şehir **ve iki tarih** gerektiğini söyler) + `#tripsEmptyNew` → `focusTripSearch()` (odak `#countrySel`, `#dInfo` tarih ipucu); menüdeki aynı öğe de oraya gider | e2e "Kayıtlı seyahatlerim: zero trips …" (tam metin + `/tarih/`, CTA ve menü öğesi odak + ipucu); e2e "Yeni seyahat: country+city only → no trip is saved; with both dates → exactly one trips insert" |
| 6. Tercihler mevcut `consent_get_my_state`/`service_pref_set` sözleşmesi | `loadHomePrefs()`, `setHomePref()`; `not_configured` → "Varsayılan belirlenmedi"; şehir sayfası etiketi de düzeltildi | e2e "E-posta tercihlerim: …" (argümanlar, uuid v4, eylem başına yeni idem, hata/ok:false → alert, durum korunur), "load error", "city page: …"; unit "prefs RPC contract", "prefState()"; UX check satır 50–51 |
| 7. Logout mevcut session davranışını bozmaz | `doLogout()`: `signOut` + `asa_session` silme (aynı iki satır), dialoglar kapanır, odak `#acctBtn` | e2e "logout from the menu" (çift tıklamada tek signOut), "logout from Profilim"; unit "logout keeps the existing semantics" |
| 8. Mobil bottom bar yoksa ana sayfadan erişim | Üst bardaki `#acctBtn` her genişlikte görünür; çekmece 390px'te 320px genişlik | e2e mobil görünüm (tüm senaryolar) + 390px'te "no overflow" kontrolleri |
| 9. Focus trap, ESC, dış tıklama, screen reader isimleri | `ASA_DLG` (yığın, focusin koruması, sürükle-bırak güvenli dış tıklama); 4 dialogda `aria-labelledby`; ✕ → `aria-label="Kapat"`; arşivden sonra `tripsRefocus()` odağı dialogda tutar, `#tripsOk` (status) / `#tripsErr` (alert) | e2e "keyboard + pointer" (Tab×9 / Shift+Tab×9 tuzak, uçlarda sarma, ESC, dış tıklama, panel içi tıklama kapatmaz; 4 dialog), "anon login dialog", "archive from the hub-opened dialog …" (klavye Enter ile arşiv; odak asla `<body>` değil; son seyahatte boş durum düğmesi; hata yolu), "only the member's own trips" (klavye arşivi, odak sonraki satırda); unit "dialogs: …" |
| Kabul: Ana sayfadan ≤2 etkileşimde Profilim | ikon → Profilim | e2e "Profilim …" (`clicks <= 2`) |
| Kabul: Seyahat olmadan profil açılır | 0 seyahat stub'ı | e2e "Profilim …" (`#tripHub` boş) |
| Kabul: Tercihler ve seyahat listesi doğru kullanıcıya ait | Sunucu: RPC `auth.uid()`, RLS `auth.uid()=user_id` (§2'de doğrulandı). İstemci: `ownTrips()` süzgeci | e2e "only the member's own trips" (stub RLS kapalıyken başka kullanıcının satırı listede ve hub'da görünmez) |
| Kabul: Anon özel alanları göremez | menü/prefs/trips girişleri `session` ister; çıkışta özel içerik temizlenir | e2e "anon: …", "logout from the menu" (prefs/trips/hub içeriği boş) |
| Kabul: Mobil/desktop ve klavye smoke | tüm e2e iki görünümde | e2e 346/346 (kapsam modu) · 342/342 (kalıcı mod) |
| Görev 7: L542 XSS | `#amName`/`#amEmailRo`/`#acctMenuWho` → `textContent`; seyahat düğmeleri `data-*` | e2e "XSS: …" (`<img onerror>` metin olarak görünür; `/x` isteği yok; `window.__wp4xss` tanımsız); unit "XSS: …" |
| Görev 7: giriş alanı etiketleri, `#amErr role=alert` | `amInp(id,type,ph,lbl,ac)` + `<label for>`; Cinsiyet `<label for="amGender">` | e2e "anon: …"; unit "auth form a11y" |
| Görev 7: şehir sayfası üye düğmesi adı | `aria-label="Üyelik ve hesabım"` + ikon `aria-hidden` | e2e "city page: …" (`getByRole('button',{name})`) |
| Görev 8: login/signup/OTP/SMTP değişmez | `doAuth`, `amAuthErr`, `bootAuth`, `CFG` byte-eşit | unit "[scope] login/signup/OTP code is byte-identical to main" (yalnız WP4 PR'ında) |
| Görev 8: WP3 storage, Kopenhag stub, admin sayfaları değişmez | dokunulmadı | unit "Kopenhag stub stays byte-identical to main" (kalıcı), "[scope] untouched by WP4: …"; WP3 kapıları (`CPH_STUB_IDENTICAL`, WP3 e2e 454/454) |
| §2.2 kırmızı kapı bırakma | WSE tripwire yeni eşlemeye güncellendi; kapsam kontrolleri WP5/main değişiminde kırmızıya dönmez | `run_all.sh` 4/5 `WSE_STATIC_PASS` + WSE `SHA256SUMS`; WSE yerel Postgres 16 suite `WSE_EPHEMERAL_GATES_PASS` / `WSE_CONCURRENCY_PASS`; WP5 benzeri mutasyon kalıcı modda yeşil (§8) |
| Konsol hatası 0, 390px'te yatay taşma yok | — | her senaryoda "console/page errors = 0"; mobilde `scrollWidth <= innerWidth` + dialog panelinde iç taşma kontrolü |

## 4. Değişen / eklenen dosyalar (SHA-256)

| Dosya | Durum | SHA-256 |
|---|---|---|
| `index.html` | değişti (+289/−38 satır; ayrıntı `git diff 7801394 -- index.html`) | `a2cfd024764934414f2a1ec9f40df74c2318f46017c004ae3d3f47c4515ae38d` |
| `amsterdam/index.html` | değişti (3 satır) | `abbf1c032687ca96165fa8d158ff0ba538f4c122a57fcf3aaa48e6d1c859f5d8` |
| `SHA256SUMS` | `amsterdam/index.html` satırı güncellendi (`4ad305cc…` → `abbf1c03…`) | `90d1daf105cf400c11b2145aa2128e0343f6ae7a4477c58f3dc4ab6f9dc1d893` |
| `scripts/ux_sprint1_trust_check.mjs` | (+3/−1) `wse ui predicate` pin'i yeni koşula; ana sayfa `prefState` kontrolü eklendi | `12783551c58045af2a9b7031b917e0892300ecc2e9b86b47bcf6b16f62ebde44` |
| `.github/workflows/wp4-member-nav-gates.yml` | yeni (pull_request ilgili yollar + workflow_dispatch; `WP4_SCOPE_CHECKS`, `WP4_HEAD_REF`) | `8d2d161213aedba11ac2e74b12b00d3484b5cba8a81312e2a44b1bd32bd45cfb` |
| `WP4_package/tests/run_all.sh` | yeni | `490d5da6f0e6e99b35bfb7f272e340b90e4d01f5e204aa54b0829a03e643bbcf` |
| `WP4_package/tests/wp4_e2e.mjs` | yeni | `d168e278afce4c3363d24a92b4b5760ab5bcf86312fb8e786a7df4e4602f97dd` |
| `WP4_package/tests/wp4_unit.test.mjs` | yeni | `0a52526216a7785de27a2da1c77cd9a3c70d9993f06bbbc1114ad0a53b76cb31` |
| `WP4_package/tests/tailwind_css.mjs` | yeni (yalnız test) | `11165d8c717dc2e646e6eac0d0dbc508e6b83b7a6f04a2b91fcefaca44bd0907` |
| `WP4_package/tests/stubs/supabase_stub.js` | yeni (yalnız test; deploy edilmez) | `b685653361b2b26cf6f5b8d003e9b315d6c35ca8b2b549692ca89eeb773c18ab` |
| `WSE_DEFAULT_package/gates/wse_static_check.mjs` | değişti (+8/−3): yeni koşul + etiket satırı sabitlendi, `not_configured` → "Varsayılan belirlenmedi" | `2a95f153b86e138b9e15279a70750bab53e57e6d691e495cfdbb934323f5cd89` |
| `WSE_DEFAULT_package/WSE_DESIGN.md` | değişti (1 satır, satır 21) | `9a604e50434d53bda31f55045a05bba4fe4def366cb24e1f8896c892694ee489` |
| `WSE_DEFAULT_package/WSE_TEST_MATRIX.md` | değişti (2 satır, T1 ve "Also asserted") | `132fcb7b061bec1f63ca000d7746f300487c6009b4a96d5ea0486cb3da7cd72c` |
| `WSE_DEFAULT_package/SHA256SUMS` | yukarıdaki 3 dosyanın satırı yenilendi | `4af2890c7fd31ef8fd63a61062bc6b594767d4b41d0b3814f3a1b56d3128867c` |
| `WP4_package/WP4_REPORT.md` | bu dosya | (kendi özeti burada yazılamaz) |
| `kopenhag/index.html` | **değişmedi** | `8428c2228d491e84cdbd57b805018e72bf3333f80c0eb789cadd8fd02a4ce0af` (SHA256SUMS ile aynı) |

Ayrıca değişmedi:
- `lib/asa-storage/asa_storage.js` ve `?v=d3b3e32eb81a46bf` pin'i aynı kaldı; yeni bir `/lib` modülü eklenmedi
- `admin.html`, `CDP3B/admin.html`, `amsterdam.html`, `amsterdam_index_UID.html`

`/lib`'e çıkarma yapılmadı. Tercih kodu yalnız ana sayfada yeni; şehir sayfasında tek satırlık düzeltme yeterliydi. Şehir sayfasını yeni bir scripte bağlamak yeni bir yükleme-hatası yolu açardı, kodda da anlamlı bir azalma sağlamazdı.

## 5. Test komutları ve gerçek çıktı

Ortam: Node 22.22.0, Python 3.13, Chromium `/opt/pw-browsers` (playwright 1.56.1). Ek bağımlılıklar yalnız scratchpad'e kuruldu: jsdom 24.1.3, tailwindcss 3.4.17, @tailwindcss/forms 0.5.10, @tailwindcss/container-queries 0.1.1.

```
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NODE_PATH=<playwright>:<jsdom>:<tailwind> bash WP4_package/tests/run_all.sh
```

Gerçek çıktı, inceleme turu 2 sonrası (özet, scratchpad `wp4fix_runall_final.log`; branch `wp4-member-nav` olduğu için kapsam modu otomatik açık):

```
WP4_SCOPE_CHECKS=1 WP4_HEAD_REF=<working tree>
== 1/5 WP4 node unit (statik sözleşme) ==        # pass 15  # fail 0  # skipped 0
== 2/5 WP4 Playwright e2e (desktop + 390px) ==   WP4_E2E checks pass=346 fail=0 skip=0 (tailwind_build=yes)  WP4_E2E_PASS
== 3/5 WP3 gates (regresyon) ==
   == 1/6 node unit (lib + WP3) ==               # pass 78  # fail 0
   == 2/6 UX Sprint 1 trust check (jsdom) ==     RESULT PASS
   == 3/6 Playwright e2e ==                      WP3_E2E checks pass=454 fail=0  WP3_E2E_PASS
   == 4/6 SHA256SUMS ==                          (sessiz = OK)
   == 5/6 Kopenhag stub byte-identical ==        CPH_STUB_IDENTICAL
   == 6/6 secret scan ==                         secret_scan_clean · SECRET_SCAN_CLEAN
   WP3_GATES_PASS
== 4/5 WSE static tripwire + WSE SHA256SUMS ==   PASS static_and_ui_mapping · WSE_STATIC_PASS  (sha256 sessiz = OK)
== 5/5 WP4 secret scan ==                        secret_scan_clean · SECRET_SCAN_CLEAN
WP4_GATES_PASS        (rc=0, real 1m36s)
```

Kalıcı mod (sonraki PR'ların göreceği durum), `WP4_SCOPE_CHECKS=0 bash WP4_package/tests/run_all.sh` → rc=0:

```
WP4_SCOPE_CHECKS=0 WP4_HEAD_REF=<working tree>
# pass 10  # fail 0  # skipped 5          (5 [scope] testi "one-shot WP4 scope check" diye SKIP)
WP4_E2E checks pass=342 fail=0 skip=0     (kapsam e2e kontrolleri bu modda hiç koşmaz, SKIP sayılmaz)
WP3_E2E checks pass=454 fail=0 · WP3_GATES_PASS · WSE_STATIC_PASS · WP4_GATES_PASS
```

Ayrı ayrı istenen kapılar:

| Komut | Çıktı |
|---|---|
| `node --test lib/asa-storage/asa_storage.test.mjs` | `# pass 65 # fail 0` |
| `NODE_PATH=<jsdom> node scripts/ux_sprint1_trust_check.mjs` | `RESULT PASS` (yeni satırlar dahil: `wse ui predicate intact`, `home prefs: not_configured is never shown as Kapalı`) |
| `sha256sum -c SHA256SUMS` | 53 satırın tamamı `OK` |
| `bash WP3_package/tests/run_all.sh` | `WP3_GATES_PASS` |
| secret scan (CDP3C + CDP3D; WP4 dosyaları, değişen WSE dosyaları, sayfalara WP4'ün eklediği satırlar, gate logları) | `secret_scan_clean` / `SECRET_SCAN_CLEAN` |
| `node WSE_DEFAULT_package/gates/wse_static_check.mjs` | `PASS static_and_ui_mapping` · `WSE_STATIC_PASS` (düzeltmeden önce bu worktree'de `FAIL member UI predicate changed…`, rc=1) |
| `cd WSE_DEFAULT_package && sha256sum -c SHA256SUMS` | 17 satırın tamamı `OK` |
| `bash WSE_DEFAULT_package/gates/wse_ephemeral.sh` (yerel Postgres 16, geçici DB) | `WSE_EPHEMERAL_GATES_PASS` (rc=0) |
| `bash WSE_DEFAULT_package/gates/wse_concurrency.sh` (yerel Postgres 16, geçici DB) | `WSE_CONCURRENCY_PASS` (rc=0) |
| `node CDP3C_package/gates/cdp3c_edge_tests.mjs` (kök `SHA256SUMS` değiştiği için `cdp3c-gates.yml` de tetiklenir) | `CDP3C_EDGE_TESTS pass=61 fail=0` · `RESULT=PASS` |
| `bash CDP3C_package/gates/cdp3c_manifest_check.sh` | `CDP3C_MANIFEST_CHECK_PASS` |

e2e senaryoları ve kontrol sayıları (her biri masaüstü + mobil):

| Senaryo | Kontrol sayısı (kapsam modu) |
|---|---|
| anon: icon opens login/signup only | 23 |
| member: 5 items | 11 |
| Profilim: 2 interactions, zero trips | 14 (2'si `[scope]`) |
| prefs not_configured / toggle / error | 24 |
| prefs load error | 4 |
| trips zero → CTA focus + boş durum metni + tarih ipucu | 13 |
| trips own-only + klavye ile arşiv (odak sonraki satırda, status) | 12 |
| keyboard + pointer | 21 |
| anon login Tab/outside | 3 |
| **yeni:** hub'dan açılan dialogda arşiv (hata → alert; 2 arşiv; son seyahatte boş durum düğmesine odak; açan öğe kaybolunca ESC → `#acctBtn`) | 11 |
| **yeni:** yeni seyahat (yalnız ülke+şehir → kayıt yok; iki tarih → tam 1 `trips` insert) | 10 |
| XSS | 11 |
| logout menu | 8 |
| logout Profilim | 3 |
| city page label | 5 |
| **Toplam** | **173 × 2 = 346** (kalıcı modda 171 × 2 = 342) |

### Testler gerçekten yakalıyor mu? (mutasyon kanıtı)

Depo kopyasında 20 kasıtlı geri-bozma denendi; **20/20'si e2e'de FAIL verdi**:
- XSS: profilde ve düğmede `innerHTML`
- tercih koşulu: ana sayfada ve şehir sayfasında yalnız `config_pending`
- dialog: Tab tuzağı, ESC ve dış tıklama kaldırıldı; odak geri dönüşü kaldırıldı
- seyahat: kendi-seyahat süzgeci kaldırıldı
- tercih yazma: hatada başarı; `ok:false` yok sayıldı; sabit idem
- CTA odağı kaldırıldı; şehir sayfası `aria-label` kaldırıldı
- menü: anon'a menü açıldı; 6. menü öğesi eklendi; giriş etiketleri kaldırıldı
- çıkış: session temizliği kaldırıldı; çift tıklama koruması kaldırıldı
- düğmede `truncate` kaldırıldı

İnceleme turu 2 için ek mutasyon/yeniden üretim kanıtı §8'de.

Tailwind derleme bağımlılığı yoksa e2e yerleşime bağlı kontrolleri `SKIP` eder ve `WP4_E2E_INCOMPLETE` ile exit 4 döner (PASS sayılmaz; denendi: `pass=130 skip=15 rc=4`).

### Görsel kontrol

Gerçek Tailwind CSS ile alınan ekran görüntüleri incelendi (repo'ya eklenmedi, scratchpad'de):
- mobil (390px) ve masaüstü
- anon ana sayfa, giriş ve kayıt formu (görünür etiketlerle)
- girişli ana sayfa, Hesabım çekmecesi, Profilim
- E-posta tercihlerim: 6× "Varsayılan belirlenmedi", Hoş geldin "Açık"
- boş seyahat durumu

## 6. Geri alma (rollback)

- Yalnız statik dosya değişikliği var: migration, RPC, Edge, Auth/SMTP ya da Supabase ayarı değişmedi.
- Geri alma: WP4 commit'i (veya merge'ü) `git revert` edilir (merge için `git revert -m 1 <merge>`), ardından Cloudflare Pages yeniden yayınlar.
- Revert, `SHA256SUMS` içindeki `amsterdam/index.html` satırını da eski değerine (`4ad305cc…`) döndürür.
- Revert WSE dosyalarını da (tripwire, iki doküman, `WSE_DEFAULT_package/SHA256SUMS`) eski hâline döndürür. Bu tutarlıdır: eski tripwire eski şehir sayfası koşulunu bekler, revert ikisini birlikte geri alır.
- Tarayıcı depolaması etkilenmez: WP4 yeni bir depolama anahtarı yazmaz; yalnız mevcut `asa_session` silme davranışı var. Bu yüzden geri alma veri kaybı yaratmaz.
- Kopenhag stub'ı, WP3 depolama kütüphanesi ve admin sayfaları dokunulmadığı için revert'ten etkilenmez.

## 7. Bilinen boşluklar / kapsam dışı (dürüst liste)

**WP5'e bırakıldı (bu PR'da YOK):**
- ad-soyad alanları ve "Profilini tamamla" akışı
- DB migration
- `display_name` üzerine yazma düzeltmesi: şehir sayfası `afterAuth` her girişte `member_upsert_profile(p_display_name=e-posta yerel kısmı)` çağırıyor, ana sayfa `doAuth` da aynı çağrıyı yapıyor; ikisine de dokunulmadı
- e-posta koruması

Profilim'deki gizli `#amWp5Slot` WP5 için ayrıldı. WP5'i engelleyen bir değişiklik yok.

**Diğer boşluklar:**
- **Canlı doğrulama yapılmadı.** Bütün davranış yerel stub'larla doğrulandı; production'da gerçek oturumla smoke merge/deploy sonrası yapılmalı.
- **Gerçek ekran okuyucu (VoiceOver/NVDA) testi yapılmadı.** Kontroller DOM/ARIA özniteliği ve odak davranışı düzeyinde.
- **Arka plan `inert` değil:** yalnız `aria-modal` ve odak tuzağı var. Dialog açıkken sayfa kaydırması kilitlenmiyor.
- **Tailwind derlemesi yaklaşık:** layout testlerindeki CSS, sayfanın kendi config'iyle derlenen Tailwind 3.4.17; Play CDN'in o günkü sürümü birebir aynı olmayabilir.
- **`welcome_service_email`:** katalogda varsayılanı `true`, ancak `consent_get_my_state` satırı olmayan üyeye `not_configured` döndürüyor. UI RPC'nin söylediğini gösteriyor ("Varsayılan belirlenmedi"); varsayılanı UI'da tahmin etmiyor.
- **`not_configured` satırında yalnız "Aç" düğmesi var:** bu, şehir sayfasının mevcut CDP-3C davranışıyla aynı. Doğrudan "Kapat" seçeneği bir ürün kararıdır, eklenmedi.
- **Tercih anahtar sırası farklı:** ana sayfa anahtarları sabit sırayla gösteriyor; şehir sayfası sunucu sırasını kullanıyor.
- **Ana sayfa hub'ı hataları yutuyor:** hub (`renderTripHub`) hâlâ `TripStore.list()` kullanıyor; bu fonksiyon hatada `[]` döndürüp hub'ı gizliyor (mevcut davranış). Yeni liste (`loadOwnTrips`) ise hatayı açıkça gösteriyor.
- **Şehir sayfasının alt bar ikon ligatürleri** (`person` vb.) erişilebilir ada karışıyor. Görev yalnız üst bardaki üye düğmesini istediği için onlara dokunulmadı.
- **Bu PR'ın tetiklediği workflow'lar:** `wp4-member-nav-gates.yml`, `wp3-storage-gates.yml`, `wse-default-gates.yml` (WSE dosyaları değişti), `cdp3c-gates.yml` (kök `SHA256SUMS` değişti) ve main'e açılan her PR'da koşan `cdp3c-edge-integration.yml`. İlk üçünün adımları yerelde yeşil (WSE: SHA256SUMS + statik + yerel Postgres 16 ephemeral + concurrency; CI'daki `apt-get install postgresql` adımı yerelde tekrarlanmadı). `cdp3c-gates.yml` içinde yalnız `cdp3c_edge_tests.mjs` ve `cdp3c_manifest_check.sh` yerelde koştu (PASS); DB isteyen adımları ve `cdp3c-edge-integration.yml` yerelde koşmadı. Hiçbiri GitHub Actions'ta henüz koşmadı, çünkü commit/push yapılmadı.
- **Kapsam kontrolleri ve CI ref'leri:** workflow'da `WP4_SCOPE_CHECKS` = `(github.head_ref || github.ref_name) == 'wp4-member-nav'`, `WP4_HEAD_REF` = `github.event.pull_request.head.sha || github.sha`. Bu ifadeler yalnız yerelde ortam değişkeni verilerek denendi (`WP4_HEAD_REF=7801394` ile kapsam testlerinin gerçekten o commit'i okuduğu doğrulandı: 3 kapsam testi beklendiği gibi FAIL). GitHub'da değerlendirilmeleri henüz görülmedi.
- **Tarih ipucu canlı bölge değil:** `#dInfo` görünür metin; ekran okuyucu "Yeni seyahat oluştur" menü öğesinden sonra bu satırı kendiliğinden okumaz. Boş durum metni (dialog içinde okunur) tarih gereğini zaten söylüyor. `#dInfo`'ya `aria-live` eklemek mevcut süre bildirimlerini de duyurur; ayrı bir karar olarak bırakıldı.
- **Arşiv sonrası odak "Arşivle" düğmesinde:** aynı sıradaki satırın "Arşivle" düğmesine gidiyor (inceleme önerisi). Uygulama arşivi geri almaz; Enter'a basılı tutmak art arda arşivleyebilir. İstek sürerken ikinci tıklama yok sayılıyor (`archBusy`), ama bir sonraki satıra geçen odak bu riski tamamen kaldırmıyor.
- **Stub sınırı (yalnız test):** stub'ın tabloları her sayfa yüklemesinde sıfırlanıyor. "Yeni seyahat" senaryosunda şehir sayfası ana sayfanın eklediği satırı göremediği için kendi misafir-seyahat aktarımıyla ikinci, yalnız-stub'a özgü bir insert yapıyor. Test yalnız ana sayfanın (`/`) yaptığı insert'leri sayıyor; production'da şehir sayfası `?trip=<id>` ile satırı bulur ve aktarım çalışmaz (bu yol WP4'te değişmedi).
- **Yerel ortam notu:** WSE yerel suite'i için yerel Postgres 16 kümesi başlatıldı ve açık bırakıldı (durdurma komutu bu oturumda izin almadı). Repo ve Supabase ile ilgisi yok.

## 8. İnceleme turu 2 — bulgular, yeniden üretim, düzeltme

| # | Önem | Bulgu | Gerçek mi? | Düzeltme | Kanıt |
|---|---|---|---|---|---|
| 1 | major | Boş durum metni "Ülke ve şehir seçip “Keşfet”" diyordu; `saveTrip` kaydı yalnız iki tarih varsa oluşturuyor; düğme adı da şehir seçilince değişiyor | **Gerçek.** Düzeltme öncesi kodda yeni senaryo: ülke+şehir → `/amsterdam/?city=Amsterdam`, `trips` insert 0 (davranış); metin ve ipucu kontrolleri FAIL | Metin: "Henüz kayıtlı seyahatin yok. Ülke, şehir ve gidiş–dönüş tarihlerini seçip keşfet düğmesiyle ilk seyahatini oluştur." `focusTripSearch()` tarih yoksa `#dInfo`'ya "Seyahatin kaydedilmesi için gidiş ve dönüş tarihlerini seç." yazar. `saveTrip` değişmedi | e2e "zero trips" (tam metin + `/tarih/` + `“Keşfet”` alıntısı yok + CTA/menü ipucu); yeni e2e "Yeni seyahat" (yalnız ülke+şehir → 0 insert, iki tarih → tam 1 insert, satırda kendi `user_id`, şehir, iki tarih). Düzeltme öncesi kodda bu metin/ipucu kontrolleri masaüstünde 6, 390px'te 6 FAIL; sonrası 0 |
| 2 | major | Arşivden sonra odak `<body>`'ye düşüyor; test `id===""` kabul ederek bunu gizliyordu | **Gerçek.** Düzeltme öncesi kodda klavye ile arşiv: `{"tag":"BODY","dlg":false}` (desktop + 390px) | `archiveTrip()` aynı çağrılarla; yeniden çizimden sonra `tripsRefocus()` odağı aynı sıradaki "Arşivle"ye, liste boşsa `#tripsEmptyNew`'e, o da yoksa ✕'e verir. `#tripsOk` (`role="status"`): "Seyahat arşivlendi."; `#tripsErr` (`role="alert"`): "Seyahat arşivlenemedi. Tekrar dene." (başarı iddiası yok). Açılışta ve çıkışta temizlenir | e2e "only the member's own trips": `page.focus` + Enter, odak dialogda ve sonraki satırın "Arşivle"sinde (`dlg === "tripsModal"`, gevşek koşul kaldırıldı). Yeni e2e "archive from the hub-opened dialog …": hata yolu, iki arşiv, son seyahatte odak boş durum düğmesinde, hub boşalınca ESC → `#acctBtn`, 390px'te taşma yok. Düzeltme öncesi kodda (her iki görünüm): odak kontrolleri `BODY` ile FAIL, yeni senaryo `#tripsErr`/`#tripsOk` olmadığı için tamamlanamadı ve sayfa hatası verdi — toplam 10 FAIL satırı; sonrası 0 |
| 3 | blocker | `WSE_DEFAULT_package/gates/wse_static_check.mjs` eski koşulu ve "`not_configured` → Kapalı" eşlemesini sabitliyordu; WP4 ile `FAIL member UI predicate changed…` | **Gerçek.** Bu worktree'de rc=1; atada (`7801394`) `WSE_STATIC_PASS` | PRD ve görev "`not_configured` → Varsayılan belirlenmedi" istediği için WP4 değişikliği korundu, tripwire yeni eşlemeye güncellendi (koşul satırı + etiket satırı sabit; `not_configured`/`config_pending` → "Varsayılan belirlenmedi", `true` → Açık, `false` → Kapalı). `WSE_DESIGN.md:21`, `WSE_TEST_MATRIX.md:7,:29` güncellendi; `WSE_DEFAULT_package/SHA256SUMS` 3 satır yenilendi. WP4 `run_all.sh` 4/5 adımı tripwire + WSE sha256'yı koşar; workflow yollarına tripwire ve WSE `SHA256SUMS` eklendi | `WSE_STATIC_PASS`; WSE sha256 17/17 OK; yerel Postgres 16'da `WSE_EPHEMERAL_GATES_PASS` + `WSE_CONCURRENCY_PASS`. Mutasyon: şehir sayfası koşulu eskiye döndürülünce tripwire `FAIL …` rc=1 |
| 4 | major | Sabit ref'lerle karşılaştıran ve "WP5 yok" diyen kontroller her sonraki PR'da koşuyordu; WP5 bu kapıyı kesin kırmızıya çevirirdi | **Gerçek.** Kopyada `#amWp5Slot`'a ad alanı + yeni `db.rpc` eklenince eski test: `not ok 2 …`, `not ok 11 …` (# fail 2) | Kapı ikiye ayrıldı. Kalıcı: prefs RPC sözleşmesi, `prefState`, `asaUuid`, XSS, dialog rol/adları (✕ sayısı artık `>= 4`), 5 menü öğesi, giriş formu a11y, çıkış anlamı, şehir sayfası etiket koşulu + üye düğmesi adı, Kopenhag stub. `[scope]` (yalnız `WP4_SCOPE_CHECKS=1`): `doAuth`/`saveTrip` byte eşitliği, RPC kümesi ve yazma sayıları, "WP5 yok", şehir sayfası tam 3 satır, admin/lib/legacy + depolama pin'i. Kapsam testleri `WP4_HEAD_REF` verilirse o commit'in dosyalarını okur (CI: PR head sha; merge ref'teki yeni main WP4'e sayılmaz). e2e Profilim: kalıcı "WP5 slotu dışında düzenlenebilir alan yok"; `[scope]` "hiç form alanı yok" + "slot gizli". `run_all.sh`: verilmezse branch `wp4-member-nav` ise 1, değilse 0 | WP5 benzeri mutasyon: kalıcı modda unit `# pass 10 # fail 0 # skipped 5`, e2e Profilim 30/30 PASS; kapsam modunda unit 2 FAIL, e2e 4 FAIL (beklenen). E-posta alanı slot dışına eklenen mutasyon: kalıcı e2e FAIL. `WP4_HEAD_REF=7801394` ile 3 kapsam testi FAIL (head okuması çalışıyor) |

Bu turda değişen dosyalar: `index.html`, `WP4_package/tests/{wp4_e2e.mjs, wp4_unit.test.mjs, run_all.sh, stubs/supabase_stub.js}`, `.github/workflows/wp4-member-nav-gates.yml`, `WSE_DEFAULT_package/{gates/wse_static_check.mjs, WSE_DESIGN.md, WSE_TEST_MATRIX.md, SHA256SUMS}`, bu rapor. `amsterdam/index.html`, `scripts/ux_sprint1_trust_check.mjs`, kök `SHA256SUMS`, `kopenhag/index.html` bu turda değişmedi.

Stub eklemeleri (yalnız test): `insert` satırı saklar (sahipli tablolarda yalnız `user_id = auth user`, canlı insert politikası gibi), id atar, `.select().single()` satırı döner; her log kaydı, test `exposeBinding` ile verdiyse `window.__wp4Sink`'e de gider (gezinmeden sonra da sayılabilsin diye).
