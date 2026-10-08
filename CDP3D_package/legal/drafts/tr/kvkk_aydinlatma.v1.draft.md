---
status: DRAFT_LEGAL_REVIEW_REQUIRED
doc_type: kvkk_aydinlatma
version: 1
locale: tr
source: SOURCE_MISSING
controller_ref: "{{CONTROLLER_VERSION}}"
not_for_publication: true
effective_date: "{{EFFECTIVE_DATE}}"
structure: "KVKK m.10 unsurları + yaygın ekler (kategoriler, saklama); avukat yeniden yapılandırabilir"
---

> DRAFT_LEGAL_REVIEW_REQUIRED · SOURCE_MISSING · Hukuk metni içermez: yalnız başlık iskeleti, avukat blokları ve yer tutucular. Yayımlanmaz, aktifleştirilmez, veritabanına yazılmaz.

# KVKK Aydınlatma Metni (taslak iskelet)

## Başlık yapısı: KVKK m.10 unsurları + yaygın ekler (kategoriler, saklama); avukat yeniden yapılandırabilir

## 1. Veri sorumlusu ve varsa temsilcisi (m.10 unsuru)

- Unvan: {{UNVAN}}
- MERSİS: {{MERSIS_16_DIGITS}}
- Adres: {{ADDRESS}}
- KEP: {{KEP}}
- VKN / vergi dairesi: {{VKN}}, {{VERGI_DAIRESI}}
- Telefon: {{TELEFON}}
- E-posta: {{CONTACT_EMAIL}}
- Gerçek kişi seçeneği: {{FULL_NAME}}, {{CONTACT_CHANNEL}}
- VERBİS: {{VERBIS_STATUS}}

[[LAWYER_TEXT_REQUIRED: veri sorumlusunun tanıtımı; tüzel kişi ve gerçek kişi seçeneğinden hangisinin kullanılacağı (controller_identity.draft.json)]]

## 2. Kişisel verilerin işlenme amaçları (m.10 unsuru)

[[LAWYER_TEXT_REQUIRED: amaç listesi; hesap ve üyelik, gezi planlama, Listem ve notlar, servis e-postaları, analitik, kişiselleştirme, pazarlama]]

## 3. Aktarım: alıcı grupları ve aktarım amaçları (m.10 unsuru)

- Hizmet sağlayıcılar: {{PROCESSORS}}
- Yurt dışına aktarım mekanizması: {{TRANSFER_MECHANISM}}

[[LAWYER_TEXT_REQUIRED: alıcı grupları, aktarım amaçları ve yurt dışına aktarım (KVKK m.9) açıklaması]]

## 4. Toplama yöntemi ve hukuki sebep (m.10 unsuru)

[[LAWYER_TEXT_REQUIRED: toplama kanalları (site, hesap, çerezler) ve amaç bazında hukuki sebepler (KVKK m.5 ve m.6)]]

## 5. İlgili kişinin hakları ve başvuru yolu (m.10 unsuru; m.11 hakları)

- Başvuru e-postası: {{CONTACT_EMAIL}}
- Başvuru KEP adresi: {{KEP}}
- Başvuru posta adresi: {{ADDRESS}}

[[LAWYER_TEXT_REQUIRED: m.11 kapsamındaki haklar, m.13 başvuru usulü ve yanıt süresi]]

## 6. İşlenen kişisel veri kategorileri (yaygın ek; m.10 unsuru değil)

[[LAWYER_TEXT_REQUIRED: veri kategorileri; kimlik, iletişim, hesap, kullanım ve tercih verileri gibi gruplar avukatça belirlenir]]

## 7. Saklama süreleri (yaygın ek; m.10 unsuru değil)

- Hesap verisi: {{RETENTION_ACCOUNT}}
- Liste ve notlar: {{RETENTION_LIST_NOTES}}
- Servis e-postası içeriği: {{RETENTION_SERVICE_EMAIL}}
- Rıza kayıtları: {{RETENTION_CONSENT_RECORDS}}
- Kayıt (log) verisi: {{RETENTION_LOGS}}

[[LAWYER_TEXT_REQUIRED: saklama ve silme ilkeleri]]

## 8. Yürürlük ve sürüm

- Yürürlük tarihi: {{EFFECTIVE_DATE}}
- Veri sorumlusu kimlik sürümü: {{CONTROLLER_VERSION}}

[[LAWYER_TEXT_REQUIRED: değişikliklerin duyurulması]]
