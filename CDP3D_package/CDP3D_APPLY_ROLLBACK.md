# CDP-3D · Uygulama Sırası + Rollback (PR/CI YEŞİL SONRASI)

**Önkoşul:** PR (`cdp3d-resend-service`) → CI (cdp3d-gates + cdp3d-edge-integration) TAM YEŞİL.
PR/CI yeşil olmadan migration/Edge/secret/DNS/SMTP/Resend production ayarı YAPILMAZ.

## Önkoşul objeler (production'da zaten var — CDP-3C)
`_contact_hmac`, `contact_suppression_*`, `_suppression_combo_*`, `member_service_pref_*`,
`service_pref_defaults`, `_append_only_guard`, `_admin_active/_admin_has_role`, `admin_write_log`,
`members(user_id,email,blocked)`, Vault `cdp3c_contact_pepper_v1`.

## Uygulama sırası
1. **Migration (additive):** CDP3D_up.sql. Sonuç: kapılar KAPALI (essential/service/public_go_live=false). Gözlemlenebilir davranış DEĞİŞMEZ.
2. **Advisor/lint** — CDP-3D kaynaklı uyarıyı sertleştir.
3. **Edge deploy:** service-email-dispatch (verify_jwt=true), resend-webhook (verify_jwt=false + Svix).
   Canlı reddetme: dispatch no-service-role→403, GET→405, key-yok→503; webhook kötü imza→401, secret-yok→503.
4. **Secret'lar (Supabase):** RESEND_API_KEY (sending-only, send.asalocal.club domain kısıtı),
   RESEND_WEBHOOK_SECRET. Repo/log'a ASLA.
5. **Auth SMTP (Supabase panel):** smtp.resend.com:465, user resend, pass = auth-scoped key;
   from no-reply@send.asalocal.club / ASALOCAL; reply-to destek@asalocal.club.
6. **Resend webhook:** tek endpoint = resend-webhook URL; olaylar sent/delivered/bounced/complained/delivery_delayed.
7. **2-adres kabul:** email_send_allowlist'e yalnız 2 gerçek kullanıcı; biri optional_service pref'i AÇIKÇA enable;
   essential_enabled/service_enabled=true; **public_go_live=false kalır**. enqueue→dispatch→delivered + negatifler.
8. **PRE/POST:** consent/suppression/service-pref/auth.users/members değişmedi; kill-switch v3 aynı.

## Rollback
- **down_soft:** CDP3D_down_soft.sql → yalnız CDP-3D yüzeyi; CDP-3C KORUNUR; güvenliği gevşetmez.
- **Anlık durdurma:** `update email_provider_config set essential_enabled=false, service_enabled=false, public_go_live=false;`
- **Insecure rollback YOK** (CDP-3D güvenlik kontrolü sıkılaştırmaz).

## Go-live kapısı (ayrı — CDP-3D KURAR, AÇMAZ)
Genel/public gönderim öncesi: (a) Resend ABD veri işleme gizlilik/aydınlatma metni, (b) aktif natural-person controller.
Bu marketing izni DEĞİL; veri sorumlusu/işleyen/yurt dışı aktarım şeffaflığı. public_go_live ancak bu kapı sonrası açılır.
