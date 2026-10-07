# İŞ PAKETİ 5 — Ad-soyad ve profil tamamlama · DB paketi (uygulama / kabul / geri alma)

**Durum:** HAZIRLIK PAKETİ — production'a **UYGULANMADI**. Bu dosyadaki adımlar sahibin (Mete) onayıyla, PRD §2 kurallarına göre yürütülür.
**Migration adı:** `wp5_member_private_name` (Supabase `apply_migration`)
**Kapsam:** yalnız veritabanı (members isim kolonları + CHECK + `member_set_name` RPC + e-posta kilidi). Frontend (profil tamamlama banner'ı / Profilim formu) ayrı PR'dır.

---

## 1. Gerekçe (2026-10-07 salt-okunur inceleme bulguları)

PRD İP5 madde 1 gereği mevcut `members` kolonları ve RPC'ler **salt-okunur** incelendi (Supabase MCP `execute_sql`, yalnız şema/fonksiyon tanımı; e-posta/isim/kişisel veri seçilmedi). Kanıt: `evidence/wp5_pre_assert_prod_readonly_2026-10-07.json` (`WP5_PRE_ASSERT_PASS`, 0 FAIL / 20 counted).

| Bulgu | Sonuç |
|---|---|
| `members` kolonları: email (PK), display_name, tier, points, home_city, bio, created_at, updated_at, blocked, gender, user_id | Ad/soyad için **uygun alan yok**. `display_name` herkese açık (`member_public`, anon okunabilir) → özel ad/soyad için kullanılamaz. Paralel/çakışan alan yaratılmıyor: yalnız `first_name`, `last_name` eklenir (madde 2). |
| `authenticated` tablo düzeyinde SELECT/INSERT/UPDATE/DELETE + RLS `members_self_*` (auth.uid() = user_id) | Kullanıcı kendi satırının **her kolonunu** (email dahil) doğrudan PATCH edebiliyor. |
| `guard_member_admin_fields()` tier/points/blocked/user_id'yi sabitliyor, **email'i sabitlemiyor** | Kullanıcı kendi `members.email`'ini başka birinin adresine çevirebilir; `_email_send_decision` alıcıyı `members.email`'den okur → servis e-postası yanlış kişiye gidebilir. PRD madde 5 ("E-posta client'tan tekrar yazdırılmamalı") ihlali. Ayrıca satırı olmayan kullanıcı doğrudan INSERT ile sahte e-postalı satır açabilir. Gate'te baseline'da kanıtlandı (red-before-green). |
| `member_upsert_profile` SECURITY INVOKER, doğrulama yok, email = `auth.jwt()->>'email'` | Değiştirilmez (kapsam); WP5 sonrası davranışı baseline ile **birebir** (gate: davranış eşdeğerliği testi). |
| Supabase varsayılan ayrıcalıkları: public şemada yeni fonksiyon → anon/authenticated/service_role EXECUTE | Yeni RPC'de açık REVOKE zorunlu (yapıldı; ACL = postgres + authenticated). |
| `member_public`, `comments_public` kolonları açık liste; members'a bağımlı 4 view'ın hiçbiri `*` kullanmıyor | Yeni kolonlar hiçbir view'da görünmez (POST guard + prod_assert satır 19: rewrite bağımlılığı = 0). |

## 2. PRD eşleme tablosu

| PRD İP5 maddesi | Karşılık | Kanıt (gate / assert) |
|---|---|---|
| 1. Mevcut kolon ve RPC'leri salt-okunur incele | §1; `gates/wp5_pre_assert.sql` | production PRE 0 FAIL / 20 (evidence JSON); fixture'da aynı 20 değer birebir |
| 2. Uygun alan varsa kullan; paralel isim alanı yaratma | `display_name` herkese açık → uygun değil; yalnız `first_name`/`last_name` | `static: UP tam 2 fonksiyon`, prod_assert 3 |
| 3. Migration additive + RLS/RPC kontrollü | `ADD COLUMN IF NOT EXISTS` (varsayılan/backfill yok); yazma yolu RLS self-update + INVOKER RPC; policy/grant/view değişikliği yok | `up#1/#2`, `up: veri değişmedi`, `static: UP policy/view/tablo-grant ... yok` |
| 4. Uzunluk, trim, Unicode, zararlı HTML kontrolü | CHECK politika v1 (P1–P6, aşağıda) + RPC normalizasyonu (boşluk dizisi → tek boşluk, trim, NFC) | `check(first_name/last_name)`: 18 kabul / 37 ret; `set_name: ret nedenleri`; ZF `A.patch_first_name 23514` |
| 5. E-posta client'tan tekrar yazdırılmamalı | guard'a 2 satır: INSERT → email = JWT claim; UPDATE → email yalnız kendi JWT claim'ine eşitlenebilir, aksi OLD | `email:` 7 test; ZF `A.patch_email_other pinned`, `C.insert spoofed_email -> jwt_email` |
| 6. Admin alanlarına client erişimi verilmemeli | guard'ın tier/points/blocked/user_id sabitlemesi birebir korunur; yeni RPC yalnız first/last/updated_at yazar; admin RPC'leri değişmez | `static: UP guard = production gövdesi + YALNIZ 4 WP5 satırı`; `email: yeni kullanıcı ... tier/points/blocked sabit` |
| 7. Audit'te gereksiz PII çoğaltılmamalı | `member_set_name` hiçbir audit/log tablosuna yazmaz; members'ta audit trigger'ı yok | `set_name: audit/log/başka tablo satırı yazılmadı` |
| Kabul: Yeni kullanıcı ad/soyad ekleyebilir | `member_set_name` (satır `member_upsert_profile` ile oluşur) | `set_name: sahip -> {ok:true}`; ZF `A.set_name ok` |
| Kabul: Var olan kullanıcılar zorla güncellenmez | backfill yok, kolonlar NULL, NOT NULL değil; mevcut satır verisi değişmez | `up: mevcut satırlarda ... NULL`, `up: veri değişmedi` |
| Kabul: OTP/Auth SMTP bozulmaz | auth şeması/GoTrue/SMTP'ye dokunulmaz; login akışının çağırdığı `member_upsert_profile` davranışı birebir | `davranış: ... baseline ile birebir` |
| Kabul: Profil güncelleme yalnız kullanıcının kendisine | INVOKER + RLS; B satırı birebir; anon 42501; sub'sız no_auth | `set_name:` / `rls:` testleri; ZF `B.untouched`, `A.update_B rows=0` |
| Kabul: XSS/uzun veri/boş değer testleri | CHECK + RPC | `check(...)` matrisi, `set_name: ret nedenleri` |
| §2.2 ilk gerçek hata kuralı | apply tek çağrı; FAIL → retry yok, STOP raporu | §4 |
| §2.4 secret/kişisel veri | dosyalarda secret/JWT/e-posta literali yok; assert'ler yalnız sayı/md5 seçer; ZF yalnız kendi geçici uuid'lerini hedefler | `secret_scan_clean`, `static: e-posta literali yok` |
| §2.5 kapsam dışı sistemler | Kill-switch v3, CDP-3B/3C, Auth/Resend ayarları, Edge değişmez | `static: UP ...` |

## 3. Tasarım

### 3.1 Kolonlar
`members.first_name text NULL`, `members.last_name text NULL` — varsayılan yok, backfill yok. `NULL` = "girilmedi". Kolon açıklamaları `WP5: PRIVATE ...`.

### 3.2 İsim karakter politikası v1 (CHECK `members_first_name_wp5_policy`, `members_last_name_wp5_policy`)
Locale'den bağımsızdır (yalnız kod noktası aralıkları; `[[:alpha:]]` gibi ICU/libc'ye bağlı sınıflar kullanılmaz). NULL değilse hepsi:

- **P1** 1–50 karakter (kod noktası).
- **P2** Unicode NFC normalize (`IS NFC NORMALIZED`; server_encoding UTF8 — PRE guard doğrular).
- **P3** baş/son boşluk yok, çift boşluk yok; izinli tek boşluk U+0020.
- **P4** ASCII'de yalnız harf, boşluk, `'`, `-`, `.` izinli; rakamlar, `<` `>` `"` `\` `{` `}` `[` `]` `|` `&` `;` `=` `$` `%` `#` `@` `*` `+` `?` `!` `^` `~` `/` `:` `_` `,` `(` `)`, ters tırnak (backtick) ve tüm kontrol karakterleri (U+0001–U+001F, U+007F, C1) ret.
- **P5** Ret: NBSP ve diğer tüm boşluk türleri, soft hyphen, Latin-1 sembolleri (× ÷ « » ´ vb.), sıfır-genişlik/bidi/biçim karakterleri, U+2000–U+2BFF noktalama/sembol blokları (istisna: U+2010 `‐` tire ve U+2019 `’` tipografik kesme — iOS akıllı noktalaması için), CJK sembolleri, özel kullanım alanları, varyasyon seçicileri, tam/yarım genişlik biçimleri, matematik alfanümerik, emoji, etiket karakterleri, Arapça/Farsça rakamlar.
- **P6** İlk karakter ayraç/boşluk/birleştirici olamaz; son karakter boşluk/tire olamaz; ardışık iki ayraç olamaz; en fazla 2 ardışık birleştirici aksan.

Kabul örnekleri: `Ayşe`, `Çağrı`, `O'Neil`, `O’Neil`, `Jean-Luc`, `İlkay Nur`, `J. R.`, `José María`, `Øyvind`, `Nguyễn`, `Владимир`, `محمد`, `李小龍`. Ret örnekleri: `<script>`, `'  a'`, `'a  '`, `''`, 51 karakter, kontrol karakterleri, `{`, `"`, rakam, emoji, sıfır-genişlik, bidi override, NFC olmayan dizi.
CHECK savunma hattıdır; frontend isimleri **her zaman textContent** ile basmalıdır.

### 3.3 `public.member_set_name(p_first text, p_last text) returns jsonb`
- **SECURITY INVOKER** (gerekçe): `authenticated` zaten members üzerinde UPDATE yetkisine ve `members_self_update` policy'sine sahip; ek yetki gerekmez. INVOKER, fonksiyonda hata olsa bile RLS'in başka satırları korumasını garanti eder; DEFINER saldırı yüzeyi açılmaz. `search_path = pg_catalog, pg_temp`, tüm nesneler şema-nitelikli.
- Satır yoksa **oluşturmaz** → `no_member_row` (satır, login akışında mevcut `member_upsert_profile` ile oluşur; e-posta mantığı tek yerde kalır).
- Normalizasyon: her tür boşluk dizisi (TAB/CR/LF/NBSP/U+2000–U+200A/U+3000 …) → tek U+0020, trim, NFC. Boş/NULL/yalnız boşluk → ret (**sessiz temizleme yok**; isim silme bu RPC'nin kapsamı dışında — kullanıcı kendi satırında `NULL` PATCH'i ile silebilir, V1 UI'da sunulmaz).
- Sonuç: `{ok:true}` | `{ok:false, reason: 'no_auth' | 'bad_first' | 'bad_last' | 'no_member_row'}`. `bad_*` kararı tek kaynaktan, CHECK'ten gelir (ikisi de geçersizse `bad_first`: PG CHECK'leri ada göre alfabetik değerlendirir). 200 karakter üstü girdi regex'e girmeden reddedilir.
- Yetki: `REVOKE ALL FROM public, anon, service_role`; `GRANT EXECUTE TO authenticated` → ACL `{postgres=X/postgres,authenticated=X/postgres}`.
- Audit/log satırı yazmaz.

### 3.4 E-posta kilidi (`guard_member_admin_fields`)
Mevcut gövde, öznitelikler (SECURITY DEFINER, search_path, sahip, ACL) ve güven testi (`auth.role()='service_role'` veya `asalocal.trusted='1'`) **birebir** korunur; yalnız 4 satır eklenir (gate statik diff'i):
- INSERT (güvenilmeyen çağıran): `NEW.email := auth.jwt()->>'email'` — `member_upsert_profile`'ın zaten yazdığı değerle aynı. JWT'de email claim'i yoksa NOT NULL (23502) ile reddedilir (bilinçli; ASALOCAL yalnız e-posta OTP kullanır).
- UPDATE (güvenilmeyen çağıran): `NEW.email` kendi JWT email claim'inden farklıysa `OLD.email`'e sabitlenir. Böylece `member_upsert_profile`'ın "e-postayı doğrulanmış JWT e-postasına senkronla" davranışı korunur, keyfi değer yazılamaz.
- service_role / trusted yollar (admin RPC'leri, `_recompute_points`, Edge) değişmez.

## 4. Uygulama adımları (sahip onayıyla; her adım tek sefer, FAIL → STOP, retry yok)

0. **Önkoşul:** `wp5-db-gates` CI yeşil (PGlite PG17 + PG18, MCP token scan, secret scan, SHA256SUMS). PRD sırası: İP4 tamam.
1. **P0 (salt-okunur):** `execute_sql(gates/wp5_pre_assert.sql)` → `WP5_PRE_ASSERT_PASS` (20/20). Farklıysa STOP (baseline drift).
2. **Apply:** `apply_migration(name => 'wp5_member_private_name', query => <WP5_DB_up.sql içeriği>)`. Dosya MCP metin kapısını tetikleyen kelimeyi içermez. PRE/POST guard hatası → tüm transaction geri alınır, STOP.
3. **P1 (salt-okunur):** `execute_sql(gates/wp5_prod_assert.sql)` → `WP5_PROD_ASSERT_PASS` (23 counted).
4. **P2 (zero-footprint davranış):** `execute_sql(gates/wp5_zero_footprint_test.sql)` → **beklenen** `ERROR: REPORT: ... WP5_ZF_VERDICT=PASS fails=0` (hata metni rapordur; RAISE her şeyi geri alır).
5. **P3:** `wp5_prod_assert.sql` tekrar → satır 22 `0|0` (kalıntı yok).
6. İsteğe bağlı: `get_advisors(security)` → WP5 kaynaklı yeni uyarı yok.
7. Frontend (ayrı PR): OTP sonrası mevcut `member_upsert_profile` → `members.first_name/last_name` NULL ise kapatılabilir "Profilini tamamla" banner'ı → `rpc('member_set_name', {p_first, p_last})`; `reason` → kullanıcı mesajı; isimler textContent ile; isimler hiçbir herkese açık yüzeyde gösterilmez.

## 5. Kabul (production)
- P0 PASS, apply başarılı, P1 PASS, P2 VERDICT=PASS fails=0, P3 kalıntı 0|0.
- Ledger'da `wp5_member_private_name` (prod_assert satır 21).
- Frontend PR'ı sonrası İP6 uçtan uca testinde: yeni kullanıcı ad/soyad kaydeder; "Şimdi değil" sonrası Profilim'den yeniden erişilir.

## 6. Geri alma (rollback)
- **Dosya:** `WP5_DB_down.sql` — **sahip tarafından Supabase Dashboard SQL Editor'de** çalıştırılır. **DROP içerir; MCP ile gönderilmez.**
- **Sıra:** önce frontend'den `member_set_name` çağrısı kaldırılır/deploy edilir, sonra DB geri alınır.
- **Silahlandırma:** dosyadaki `-- set local wp5.down_confirm = 'DELETE_PRIVATE_NAMES';` satırının başındaki `-- ` kaldırılmadan hiçbir şey yapmaz (`WP5_DOWN_NOT_ARMED`).
- **Ne yapar:** PRE guard (yalnız WP5-uygulanmış veya zaten-baseline durumdan) → `member_set_name` kaldırılır → iki CHECK kaldırılır → iki kolon kaldırılır → guard production gövdesi birebir geri yüklenir → POST guard: `md5(prosrc)=9bba990aa5a30cd94c93f7609babb7d2`, `md5(pg_get_functiondef)=48bd6e33c6becde922a033d6093a81b5`, kolon imzası/ACL/policy/trigger baseline. Kendi `BEGIN/COMMIT`'i vardır; hata → hiçbir şey kalmaz. İdempotent.
- **Veri kaybı:** yalnız `first_name`/`last_name` içindeki isimler (diğer kolonlar/satırlar değişmez — gate `down(veri)`). Geri alma ayrıca e-posta kilidini kaldırır (WP5 öncesi açık geri gelir).
- **Sonra:** `wp5_pre_assert.sql` → satır 20 (ledger) hariç PASS beklenir; ledger satırı geçmiş kaydı olarak kalır (yeniden uygulamada yeni migration adı kullanılır, örn. `wp5_member_private_name_r2`, ve pre_assert satır 20 bu ada göre güncellenir).

## 7. Gizlilik notları
- Ad/soyad **özeldir**: yalnız sahibi (RLS self-select) ve service_role okur; anon'un members üzerinde hiçbir yetkisi yoktur; `member_public` / `comments_public` ve members'a bağlı diğer view'lar bu kolonları içermez; istemcinin çağırabildiği hiçbir fonksiyon members satırını bütün olarak döndürmez (2026-10-07 inceleme).
- `display_name` herkese açık kalır (değişiklik yok). Not: mevcut frontend login'de `display_name`'i e-postanın `@` öncesi kısmıyla dolduruyor (bkz. §9) — WP5 frontend PR'ında ele alınmalı.
- Audit/log'a isim yazılmaz; testler gerçek kullanıcı verisine dokunmaz; raporlarda isim/e-posta yer almaz.

## 8. Kapsam dışı (non-goals)
Frontend UI; isimlerin zorunlu yapılması; mevcut kullanıcılar için backfill; admin panelinde isim gösterimi; `display_name` politikası; Auth e-posta değişimi akışı; `member_public` view DML sertleştirmesi (§9); i18n; `member_upsert_profile` / `complete_profile` değişikliği.

## 9. Açık riskler ve ön-mevcut bulgular
1. **ÖN-MEVCUT GÜVENLİK BULGUSU (WP5 kapsamı DIŞI, PRD §2.2 STOP sınıfı):** `member_public` otomatik-güncellenebilir (`pg_relation_is_updatable = 28`), `security_invoker=false` (sahip postgres, BYPASSRLS) ve anon/authenticated'a INSERT/UPDATE/DELETE verilmiş. Model kanıtı (gate FINDING satırları): anon `DELETE FROM member_public WHERE ...` members satırını siler (RLS atlanır); authenticated bir kullanıcı başka üyenin `display_name`'ini değiştirebilir. Production'da yalnız katalog düzeyinde doğrulandı (yazma testi yapılmadı). WP5 bunu kötüleştirmez (isim kolonlarına view üzerinden erişim yok — gate `bulgu sınırı`). Ayrı paket önerisi: `member_public`/`comments_public` (ve benzeri view'lar) üzerinde anon/authenticated için INSERT/UPDATE/DELETE/TRUNCATE geri alınması — sahip kararı gerekir.
2. Frontend `member_upsert_profile(p_display_name: email.split("@")[0])` → e-posta yerel kısmı herkese açık `display_name` olur ve her login'de üzerine yazılır.
3. JWT'de email claim'i olmayan (telefon/anonim) oturumlar members satırı açamaz (23502) — `member_upsert_profile` zaten aynı; ASALOCAL e-posta OTP kullanır.
4. Politika bazı nadir meşru biçimleri reddeder: rakam, Farsça ZWNJ, emoji, tam genişlik harf, `´` ile kesme (kullanıcı `'` veya `’` kullanır), 50 karakter üstü.
5. `ALTER TABLE ... ADD COLUMN` kısa ACCESS EXCLUSIVE kilidi alır (2 satır; `lock_timeout 5s` → kilit alınamazsa değişiklik olmadan hata).
6. CHECK tanım md5 literalleri PGlite PG17.5 ve PG18.3'te aynı; production PG17.6 deparse'ı farklı olursa POST guard **fail-closed** davranır (rollback, değişiklik yok) → paket revizyonu.
7. Model sınırı: WSE welcome seed trigger'ı fixture'da no-op stub, `_email_send_decision` modellenmedi; production davranışı P2 zero-footprint testiyle doğrulanır (geçici kullanıcılar `created_at=2000-01-01` → WSE future-only kuralı tetiklenmez).

## 10. Dosyalar
| Dosya | Açıklama |
|---|---|
| `WP5_DB_up.sql` | Migration (MCP-safe; dış BEGIN/COMMIT yok; PRE/NULL/POST guard; idempotent) |
| `WP5_DB_down.sql` | Sahip-çalıştırmalı geri alma (DROP içerir; silahlandırma satırı) |
| `gates/wp5_fixture_baseline.sql` | Production members modelinin PGlite kopyası (yalnız yerel) |
| `gates/wp5_pglite_gate.mjs` | Yerel kapı (PG17 + PG18) — sentinel `WP5_LOCAL_PGLITE_GATE_PASS` |
| `gates/wp5_mcp_token_scan.sh` | MCP metin kapısı taraması — sentinel `WP5_MCP_TOKEN_SCAN_CLEAN` |
| `gates/wp5_pre_assert.sql` | Salt-okunur baseline (P0) |
| `gates/wp5_prod_assert.sql` | Salt-okunur apply sonrası (P1/P3) |
| `gates/wp5_zero_footprint_test.sql` | Hosted davranış testi (P2), her zaman REPORT ile geri alınır |
| `evidence/wp5_pre_assert_prod_readonly_2026-10-07.json` | Production P0 salt-okunur sonucu |
| `SHA256SUMS` | Paket bütünlüğü (+ `.github/workflows/wp5-db-gates.yml`) |
