# Avukat kontrol listesi (taslak)

Durum: **DRAFT_LEGAL_REVIEW_REQUIRED** · Kaynak: **SOURCE_MISSING**

Bu liste hukuki görüş değildir; avukatın yanıtlaması gereken soruları ve kodda doğrulanmış teknik olguları toplar. Hiçbir madde yayın, onay veya aktivasyon anlamına gelmez.

1. **Veri sorumlusu.** Gerçek kişi mi, tüzel kişi mi? (Marketing readiness, MERSİS numaralı aktif bir legal_entity controller ister.) Tam unvan, adres, KEP, VKN ve iletişim kanalı nedir? VERBİS kaydı gerekli mi?
2. **Hukuki sebep (KVKK m.5 / m.6), amaç bazında:** hesap ve üyelik, gezi planlama, Listem ve notlar, servis e-postaları, analitik, kişiselleştirme, pazarlama.
3. **Hoş geldin e-postasının sınıfı.** Şablon `optional_service` olarak gönderiliyor ve "Bu bir servis e-postasıdır; pazarlama değildir" diyor. 6563 sayılı Kanun ve İYS bakımından ticari elektronik ileti sayılır mı? `/preferences` üzerinden vazgeçme yeterli mi? (Bu bağlantının şu an sitede bir rotası yok.)
4. **Açık rıza metinleri.** Aydınlatma metninden ayrı, amaca özgü, özgür iradeyle verilen ve geri alınabilir olmalı. marketing_capture readiness ayrıca bir `legal_signoff` attestation ister.
5. **Yurt dışına aktarım (KVKK m.9).** Repoda kullanılan veri işleyenler için aktarım mekanizması ve gerekiyorsa Kurul bildirimi. Liste ve bölgeleri sahip teyit eder: Resend (e-posta; CDP3D go-live notu ABD'de işleme olduğunu belirtiyor), Supabase (veritabanı ve kimlik doğrulama), Cloudflare (barındırma). Sonuç `processor_transfer_assessment` attestation'ına bağlanır.
6. **Saklama ve silme süreleri:** servis e-postası içeriğinin temizlenmesi (outbox content purge) ve `recipient_hmac`, hesap verisi, liste ve notlar, kayıtlar (log).
7. **İlgili kişi başvuru kanalı (m.11 / m.13)** ve yanıt süresi. Çalışan bir posta kutusu gerekir; destek adresinin alan adında MX kaydı olmadığı bildiriliyor (burada doğrulanmadı).
8. **Çerez politikası:** kategoriler, zorunlu olmayan depolamadan önce rıza, bant metni, `/cerez-politikasi` rotası (henüz yok).
9. **Üyelik şartları:** uygulanacak hukuk, sorumluluk, asgari yaş. Ayrıca: üyelere özel bir kapı var (ücretsiz kayıt); kodda ücretli katman yok; ücretli katman planlanırsa tüketici hukuku yükümlülüklerini teyit et.
10. **Gizlilik politikası ile aydınlatma metninin ilişkisi:** örtüşme ve hangisinin esas alınacağı.
11. **Onay belirli baytlara bağlıdır.** `consent_text_approvals` onayı metnin `content_hash` değerine bağlar; avukat, hash'i sabitlenmiş dosyayı onaylar. Metinde onaydan sonra yapılan her değişiklik yeni bir onay gerektirir.
12. **Aktivasyon sırası.** Hepsi ayrı sahip onayıyla yapılır ve hiçbiri şimdi yapılmaz: controller satırı → controller yayımı → metin satırları → onaylar → aktivasyon → readiness attestation'ları.
