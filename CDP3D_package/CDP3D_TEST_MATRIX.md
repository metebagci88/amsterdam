# CDP-3D · Test Matrisi

## 1) PGlite SQL gate (gates/cdp3d_pglite_gate.mjs) — 47 kabul, hepsi PASS
Gerçek Postgres (WASM) üzerinde CDP3D_up.sql + **ikinci apply idempotent**:
- Enum: yalnız 2 sınıf, `marketing` yok; from_email varsayılan `no-reply@send.asalocal.club`.
- Karar kapıları (fail-closed): class_disabled, not_in_allowlist, service_pref_missing (backfill yok),
  service_pref_disabled, allow, essential allow, recipient_missing_email.
- **Suppression matrisi (#3):** unsubscribe/all_email → optional_service BLOCK, essential ALLOW;
  hard_bounce/all_email → her iki sınıf BLOCK.
- **0C idempotency (#2):** aynı key+payload → aynı id; aynı key+farklı payload → `idempotency_conflict`; tek satır.
- **Lease/reclaim (#3-claim):** claim → sending+lease; lease dolunca reclaim+yeniden claim.
- **Monoton durum (#4):** mark tekrar → ignored; delivered sonra geç `sent` → delivered kalır.
- **Webhook dedupe (#5):** atomik ON CONFLICT svix_id → duplicate.
- **Bounce sınıfı (#6):** Permanent → hard_bounce suppression + failed + sonraki BLOCK;
  Transient → kalıcı suppression YOK; delivery_delayed → durum değişmez.
- Sistem suppression user reason YASAK.
- **PII-min (#7):** outbox/events ham e-posta yok; recipient_hmac 64-hex; retention purge çalışır.
- Append-only: send_events UPDATE/DELETE engellenir.
- ACL: email_enqueue anon/authenticated REVOKE; claim_batch service_role GRANT. Admin okuma super_admin; non-admin forbidden.
- public_go_live=false (go-live kapısı kurulu, açık değil).
- Rollback: CDP-3D düşer; `_contact_hmac` + `contact_suppression_current` + verisi KORUNUR.

## 2) Svix birim testi (gates/cdp3d_svix_test.mjs) — 6 PASS
Geçerli/çoklu imza kabul; gövde/secret/eski-timestamp/boş-header RED.

## 3) Edge parse (esbuild) — 2 OK
service-email-dispatch (+ provider Idempotency-Key header) + resend-webhook (+ bounce.type) temiz.

## 4) Gerçek ephemeral Supabase CI (kabul kanıtı)
### DB suite (gates/cdp3d_db_suite.mjs, gerçek Postgres + node-pg)
migration + ikinci apply; ACL/RLS (anon EXECUTE+SELECT reddi); **iki-bağlantı enqueue concurrency**
(tek satır + idempotent, farklı payload → conflict); **claim lease/reclaim**; **monoton** (delivered sonrası
geç sent); **paralel webhook dedupe** (aynı svix_id iki bağlantı → tek event/suppression);
**transient vs permanent bounce**; pref/allowlist negatifleri; unsubscribe→essential ALLOW; PII-min.
### Edge HTTP reddetme (gates/cdp3d_edge_integration.sh)
dispatch GET→405, no-auth→403, anon JWT→403, service_role+key-yok→503; webhook GET→405, imzasız→401, kötü-imza→401.
### Provider idempotency
dispatcher `Idempotency-Key: outbox-<id>` (retry'da sabit) — kod + reclaim güvenliğiyle çift-gönderim engeli.
### Soft rollback + residue + secret scan + teardown residue=0.

## Canlı (production apply aşaması)
Aynı reddetme yolları canlı Edge'de + 2-adres enqueue→dispatch→delivered + PRE/POST değişmezlik.
