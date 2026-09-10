# CDP-3C · Suppression / HMAC sınır notu (kapanış #8)

## Bulgu (kapandı)
Silinen taslak `edge/consent-api.ts` içindeki `serverApplySuppression` yorumu "ham e-postayı
kendisi HMAC'e çevirir" diyordu; oysa kod 64-hex HMAC BEKLİYORDU (`/^[0-9a-f]{64}$/`). Bu çelişki,
taslak dosyanın **tümüyle kaldırılmasıyla** giderildi. Aşağıdaki gerçek DB sözleşmesi tek doğrudur.

## Gerçek (production) sözleşme
- `public.admin_w_apply_suppression(p_actor, p_contact_hmac text, p_channel, p_scope, p_reason,
  p_reason_text, p_request_id, p_idem)` — **service_role**. `p_contact_hmac` ZATEN hesaplanmış
  **64-hex** olmalıdır; bu fonksiyon ham e-posta KABUL ETMEZ, çevirmez.
- `public._contact_hmac(p_contact text, p_pepper_version int)` — **server-only** dönüştürücü
  (`revoke ... from public, anon, authenticated`). Vault pepper (`cdp3c_contact_pepper_v1`) ile
  `hmac(lower(trim(email)), pepper, sha256)` üretir. YALNIZ SECURITY DEFINER akışların İÇİNDEN çağrılır
  (ör. `consent_set` içinde `email_marketing` withdraw → satır 660: `_contact_hmac(v_email,1)`).
- `contact_suppression_events` / `contact_suppression_current`: `contact_hmac ~ '^[0-9a-f]{64}$'`
  CHECK'i ile **ham e-posta saklanamaz**.

## Bu turdaki karar (CDP-3C)
- CDP-3C'de **gerçek gönderim yok** (Resend/outbox/journey kapalı). Bu yüzden suppression çağrı yüzeyi
  hiçbir **public/client** route'a **bağlanmadı**. `admin_w_apply_suppression` yalnız service_role'e açık
  kalır; Edge/admin/üye yüzeylerinden çağrılmaz.
- Ham e-posta → HMAC dönüşümü ve pepper sınırı **CDP-3D** provider/webhook katmanına bırakıldı. O katman
  ya (a) `_contact_hmac`'i SECURITY DEFINER içinden kullanır, ya da (b) kendi server-only alanında HMAC'i
  üretip `admin_w_apply_suppression`'a 64-hex geçirir. Her iki yolda da ham e-posta **SECURITY DEFINER /
  server-only sınırını** geçmez.

## Değişmez güvence
Ham e-posta (PII) hiçbir yerde şuraya **girmez**: RPC parametreleri (client'tan), audit/event kayıtları,
client hata mesajları, idempotency anahtarı/fingerprint, admin API yanıtları. Suppression kayıtları yalnız
64-hex HMAC + pepper_version tutar. Bu tur bu sınırlar KOD/ŞEMA düzeyinde korunmuş ve test edilmiştir
(bkz. `gates/cdp3c_edge_tests.md` T-SUP-*).
