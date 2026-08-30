# CDP-2 · Final Rapor (server uygulandı; admin.html yayını bekliyor)

Segment oluşturucu (MVP). Tarayıcıdan **serbest SQL YOK** — yapısal JSON + sunucu allowlist evaluator. $0.

## Uygulanan (server)
1. **Migration** `cdp2_segments_builder` + `cdp2_events_explorer`: `segments` tablo (RLS deny-all) + `_segment_leaf`/`_segment_build_where` (allowlist evaluator) + `admin_q_segment_preview`/`admin_q_segment_list`/`admin_w_segment_upsert`/`admin_w_segment_run`/`admin_w_segment_duplicate`/`admin_w_segment_set_active` + `admin_q_events`. Grants yalnız service_role; rate allowlist güncel.
2. **Hosted testler: 15/15 PASS** (sıfır-iz): **enjeksiyon nötralize** (tier'a SQL → count=0, tüm kullanıcı değil; literal kaçıldı), bad_field reddi, rol gating (analyst preview ✓ / write 403), preview count + **maskeli** örnek, upsert/run/duplicate/set_active/list, segments RLS deny-all + grants kapalı.
3. **Edge admin-api v10 ACTIVE**: +segment_preview/list/upsert/run/duplicate/set_active (super_admin+crm[+analyst]) +events_list.
4. **Advisors:** yalnız beklenen `segments`/`behavior_event_log` deny-all INFO + evaluator/preview'in authenticated değil service_role oluşu; yeni ERROR yok (view zaten yok).

## admin.html "Segmentler" sekmesi (CAPS.crm||superadmin) — yayın bekliyor
- **Davranış olayı gezgini:** tarih/tür/şehir/kullanıcı filtreleri (events_list; maskeli).
- **Segment kurucu:** AND/OR gruplar + kural satırları; alanlar **"Mevcut durum (türetilmiş)"** ve **"Geçmiş olay (kalıcı)"** olarak optgroup ile AÇIKÇA ayrı.
- **Önizleme:** kaydetmeden sayı + maskeli örnek.
- **Kaydet:** ad + kısa açıklama.
- **Kayıtlı segmentler:** çalıştır (sayı günceller) / düzenle / çoğalt / pasifle-aktifle.
- Manuel segment etiketi (Üye 360) burada bir KURAL ALANI (`manual_segment`) ama otomatik segmentler ayrı `segments` tablosunda.

## Desteklenen kurallar (MVP)
Şehir/trip durumu (`trip_city`,`trip_status`), son X günde Karar (`decision_used_last_days`), Karar modu/zamanı, tam-eşleşme/gösterilen bucket, favori/yorum/plan/seyahat var-yok, puan (≥/≤), tier, üyelik tarihi, son aktivite tarihi, manuel segment etiketi.

## Güvenlik
Serbest SQL yok (JSON→allowlist şablon, değerler quote_literal/cast). segments/behavior RLS deny-all; RPC'ler yalnız service_role (Edge). Rol: yönetim super_admin+crm, önizleme +analyst. Sonuç yalnız sayı + maskeli önizleme; ham PII yok.

## SHA
migration `97416b67` (+events) · Edge v10 (ezbr `35f71a39…`) · admin `91236aef832d768e` · contract değişmedi.

## Kalan: admin.html yükleme
Repo köküne `admin.html` (SHA `91236aef832d768e`). Sonra `/admin` → Segmentler: olay gezgini + kurucu + önizleme + kaydet + kayıtlı liste doğrulaması.

## Kapsam dışı (CDP-3/4)
CSV export, e-posta, journey, Meta/Google aktarımı, gerçek-zamanlı otomasyon.
