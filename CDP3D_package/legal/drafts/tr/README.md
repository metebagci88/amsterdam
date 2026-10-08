# Hukuk metinleri: taslak iskelet (tr)

Durum: **DRAFT_LEGAL_REVIEW_REQUIRED** · Kaynak: **SOURCE_MISSING**

Bu dizin hukuk metni içermez. Kaynak paket `ASALOCAL_METIN_PAKETI_TR_v1.md` bu ortamdan erişilebilir değil: git referansları ve geçmişi, dosya sistemi, yüklemeler, Drive, GitHub kod araması ve oturum kayıtları tarandı, dosya bulunamadı. Bu yüzden hiçbir hukuki metin üretilmedi ve hiçbir şey uydurulmadı. Belgeler yalnız başlık iskeletinden, `[[LAWYER_TEXT_REQUIRED: konu]]` bloklarından ve yer tutuculardan (çift süslü parantez içinde büyük harfli alan adı, ör. `{{UNVAN}}`) oluşur.

## Kurallar

- Yayımlanmaz. Paket dizinleri sitede sunulmamalıdır; kökteki `_redirects` dosyası `/CDP3D_package/*  /  302` satırını içerir (WP7 ile aynı satır).
- Aktifleştirilmez. `consent_text_versions`, `controller_identity_versions`, `consent_text_approvals` ve `readiness_attestations` tablolarına satır yazılmaz. Controller satırı yoktur. `marketing_config.active_controller_version_id` işaretçisi değişmez. Hiçbir rıza akışı açılmaz.
- `legal/` altında SQL dosyası veya veritabanına yazan komut bulunmaz.
- Her yayın, onay ve aktivasyon adımı ayrı ve açık sahip onayı gerektirir (sıra: LAWYER_CHECKLIST.md madde 12).
- Gate: `CDP3D_package/gates/cdp3d_template_check.sh` `CDP3D_package/legal/` ağacının tamamını özyinelemeli tarar. İzin verilen yollar yalnız bu dizindeki dosyalar ve içe aktarma hedefi `legal/source/` dizinidir; başka her yol kırmızıdır. `legal/` altındaki her dosyada DRAFT_LEGAL_REVIEW_REQUIRED arar; yer tutucu dışında 16 haneli (ve 10 ve daha fazla haneli) sayı, e-posta adresi, telefon biçimi, sır benzeri dize veya veritabanına yazan SQL bulursa kırmızı olur. Bu dizindeki her dosyada ayrıca SOURCE_MISSING arar. SOURCE_MISSING durumundaki belgelerde başlık, avukat bloğu, `- Etiket: yer tutucu` satırı ve durum bandı dışında satır kabul etmez; nokta ile biten başlık veya avukat bloğu kabul etmez; altı belgenin baytları gate içinde sabitlenmiştir. Manifest SOURCE_MISSING iken `legal/source/` altında dosya bulunursa kırmızı olur.

## Dosyalar

| Dosya | doc_type | Not |
|---|---|---|
| kvkk_aydinlatma.v1.draft.md | kvkk_aydinlatma | service_delivery ve marketing readiness için gerekir. Başlıklar: KVKK m.10 unsurları + yaygın ekler (kategoriler, saklama); avukat yeniden yapılandırabilir. |
| acik_riza_marketing.v1.draft.md | acik_riza_marketing | email/sms/push_marketing amaçları; marketing ve marketing_capture readiness için gerekir. |
| acik_riza_kisisellestirme.v1.draft.md | acik_riza_kisisellestirme | on_site_personalized_messages ve personalization_profiling amaçları. |
| cerez_politikasi.v1.draft.md | cerez_politikasi | analytics_storage ve advertising_storage amaçları; çerez bandı (policyUrl `/cerez-politikasi`, rota henüz yok). |
| gizlilik_politikasi.v1.draft.md | gizlilik_politikasi | Henüz veritabanı tüketicisi yok. |
| uyelik_sartlari.v1.draft.md | uyelik_sartlari | Henüz veritabanı tüketicisi yok. |
| controller_identity.draft.json | (yok) | `controller_identity_versions` sütunlarının aynası; veritabanı satırı değildir. |
| manifest.json | (yok) | Belge başına doc_type, version, locale, file, status, source, body_sha256, db_consumers, needed_for. |
| LAWYER_CHECKLIST.md | (yok) | Avukatın yanıtlaması gereken sorular. |

`locale` değeri `tr` olarak tutulur, çünkü veritabanı `^[a-z]{2}$` biçimini ister; e-posta şablonu meta verisi `tr-TR` kullanır.

## Kaynak paket geldiğinde içe aktarma

Hedef dizin: `CDP3D_package/legal/source/` (bu dizin şu an yoktur). İçe aktarma tek bir incelenen değişiklikte yapılır ve aşağıdaki adımların hepsini içerir.

1. Kaynakta gerçek kimlik veya iletişim değeri varsa (MERSİS, VKN, telefon, e-posta, KEP, adres, kişi adı), dosya repoya girmeden önce bu değerleri aşağıdaki sözlükteki yer tutucularla değiştir. Gerçek değerler repoya girmez; yalnız ayrı sahip onayıyla veritabanındaki controller satırına girer. Gate bu değerleri `legal/` altında hiçbir yerde kabul etmez.
2. İzin verilen tek diğer düzenleme: kaynakta bilinmeyen olguları yer tutucularla değiştirmek. Başka hiçbir kelime değişmez.
3. Sonucu UTF-8 metin olarak (`.md` veya `.txt`, BOM yok, yalnız LF) `CDP3D_package/legal/source/` altına koy ve ilk satır olarak `> DRAFT_LEGAL_REVIEW_REQUIRED` ekle; altındaki metin birebir kalır. Bu dosyanın sha256 değerini ve bayt boyutunu `manifest.json` içindeki `source_sha256` ve `source_bytes` alanlarına yaz.
4. Her belgenin gövdesini ilgili `<doc_type>.v1.draft.md` dosyasına, front matter bloğunun altına koy ve `source` alanını kaynak dosya adıyla güncelle. `body_sha256` = gövdenin (front matter hariç) UTF-8 baytlarının sha256 değeri. Veritabanı tetikleyicisi `content_hash` değerini aynı şekilde hesaplar ve avukat onayı (`consent_text_approvals.approved_content_hash`) bu değere bağlanır.
5. `status` DRAFT_LEGAL_REVIEW_REQUIRED olarak kalır.
6. Aynı değişiklikte `gates/cdp3d_template_check.sh` içindeki SOURCE_MISSING, iskelet ve bayt sabitleme kurallarını ve `legal/source/` kuralını güncelle (gate şu an yalnız iskeleti kabul eder ve fail-closed çalışır), ardından `CDP3D_package/SHA256SUMS` satırlarını yeniden hesapla.
7. Yayın ve aktivasyon bu adımın parçası değildir; her biri ayrı sahip onayı ister.

## Yer tutucu sözlüğü

| Yer tutucu | Anlam |
|---|---|
| `{{UNVAN}}` | Tüzel kişi ticaret unvanı |
| `{{MERSIS_16_DIGITS}}` | MERSİS numarası (16 hane) |
| `{{ADDRESS}}` | Yayımlanacak adres |
| `{{KEP}}` | KEP adresi |
| `{{VKN}}` | Vergi kimlik numarası |
| `{{VERGI_DAIRESI}}` | Vergi dairesi |
| `{{TELEFON}}` | Telefon |
| `{{CONTACT_EMAIL}}` | Başvuru ve iletişim e-postası |
| `{{CONTACT_CHANNEL}}` | Gerçek kişi controller için iletişim kanalı |
| `{{FULL_NAME}}` | Gerçek kişi controller adı |
| `{{DISPLAY_NAME}}` | Gösterilen ad |
| `{{EFFECTIVE_DATE}}` | Yürürlük tarihi |
| `{{RETENTION_ACCOUNT}}`, `{{RETENTION_LIST_NOTES}}`, `{{RETENTION_SERVICE_EMAIL}}`, `{{RETENTION_CONSENT_RECORDS}}`, `{{RETENTION_LOGS}}`, `{{RETENTION_PERSONALIZATION}}`, `{{RETENTION_COOKIES}}` | Kategori bazında saklama süresi (RETENTION_ önekli) |
| `{{PROCESSORS}}` | Hizmet sağlayıcılar (veri işleyenler) |
| `{{TRANSFER_MECHANISM}}` | Yurt dışına aktarım mekanizması |
| `{{VERBIS_STATUS}}` | VERBİS kayıt durumu |
| `{{AGE_LIMIT}}` | Asgari yaş |
| `{{CONTROLLER_VERSION}}` | Bağlanacak controller kimlik sürümü |

`controller_identity.draft.json` içinde `controller_type` seçimi `{{natural_person|legal_entity}}` yer tutucusuyla gösterilir.

## Sonraki adım (sahip)

`ASALOCAL_METIN_PAKETI_TR_v1.md` dosyasını ve `kreatif/email/welcome/*.html` dosyalarını sohbete veya Drive'a ekle.
