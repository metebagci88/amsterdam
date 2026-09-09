# CDP-3C · İsimlendirilmiş Test Matrisi (assertion-tabanlı) · v9

> **v9:** 3 harness düzeltmesi (SQL/test-mantığı DEĞİŞMEDİ). preflight_objects fail-open kapatıldı (sorgu rc ana-shell; geçersiz DB URL → `GATE_FAILED:preflight_objects_query`, PASS yok). gen_object_manifest **gerçek multiline** (yorum-strip+whitespace-normalize) + manifest_selftest gerçek fixture (ad ayrı satır/uppercase/yorum-sızıntı/overload) + manifest_check çapraz-sayım `--raw`. guard_selftest ilk mutasyondan ÖNCE tam 3-katman `require_ephemeral`; workflow **baseline → guard_selftest**. T01–T39 aynen.

> **v8:** privilege matrisi **manifest-scoped** (canlı-katalog tüm-fn taraması yerine; önceki-faz `trip_save` benzeri RPC'leri yanlış reddetmez); guard sentinel MARKER. Gate sırası: gates→teardown→final secret-scan→sentinel(if:success)→artifact.

> **v6 eklenenler (yerelde geçti):** T37 marketing_config singleton DELETE reddi; T38 legal_notice idem-first (replay-after-merge aynı sonuç + farklı-payload conflict). Concurrency S3 anon-race artık deterministik (exit-kodları + kesin iki sonuç; timestamp kanıt değil). `gates/cdp3c_preflight_selftest.sh`: 6 negatif fixture non-zero + pozitif kontrol. `gates/cdp3c_invariants.sql`: tüm public RPC + helper için authoritative privilege matrisi. Ham kanıt bölümlü `gates/LOCAL_GATE_EVIDENCE.log` (A geçen / B yerel-preflight EXPECTED-FAIL / C selftest / D çalıştırılmayan).


> **v5 eklenenler (yerelde geçti):** T34 çift-yönlü pointer invariant (deferred constraint + doğrudan service_role deaktivasyon negatifi); T35 legal_notice subject×source matris + varlık negatifleri; T36 suppression çapraz-kombinasyon reddi. `gates/cdp3c_concurrency.sh` 4 gerçek iki-bağlantı senaryosu: same-payload (2×exit0+aynı JSON+audit/ops/state=1), diff-payload (tam 1 başarı + idempotency_conflict; duplicate-key=kusur), anon merge↔consent_set race (merge sonrası event yok), text-switch iki-farklı-hedef (deadlock yok, tam 1 aktif). Ham koşum kanıtı: `gates/LOCAL_GATE_EVIDENCE.log` (SHA256SUMS kapsamında).


> **v4 — yerel çalıştırma kanıtı (CI değil, production değil):** tüm SQL + gate'ler gömülü **Postgres 16.2** (vault/auth/pgcrypto shim) üzerinde koşuldu ve **geçti**: `baseline → up → up(idempotent) → invariants(CDP3C_INVARIANTS_PASS) → tests(CDP3C_TESTS_PASS, T01–T33) → down_soft → downsoft_assert(CDP3C_DOWNSOFT_ASSERT_PASS)`; `cdp3c_concurrency.sh`→`CDP3C_CONCURRENCY_PASS`; `secret_scan_selftest.sh`→`SECRET_SCAN_SELFTEST_PASS`. Runnable koşum yeri: repo-kökü `.github/workflows/cdp3c-gates.yml` (ephemeral Supabase; gerçek pgcrypto/vault). Beklenen sentinel: `LOCAL_CDP3C_GATES_PASS`.
> **v4 eklenen isimli testler:** T28 hukuk-onaysız aktivasyon reddi; T29 suppression kombinasyon matrisi; T30 atomik controller switch + expired rollback; T31 marketing-text atomik switch; T32 config-RPC idem same-result + changed-field conflict; T20stale stale-anon-text; T22c/d readiness combo/expires; + iki-bağlantı concurrency (workflow) + secret-scan self-test (workflow).


Tüm testler **zero-footprint** (transaction + ROLLBACK) veya izole fixture ile; harness **kendi ephemeral kullanıcısını** yaratır — canlı `members`/`auth.users` satırlarına **dokunmaz**; her test açık assertion + doğru hata nedeni üretir.

**Koşum yeri:** `.github/workflows/cdp3c-gates.yml` (repo kökü) → geçici GERÇEK Supabase/Postgres stack (CDP-3B deseni). Gate zinciri: `sha256sum -c SHA256SUMS` → stack → ext → `gates/cdp3c_baseline.sql` (CI-only double) → `gates/cdp3c_preflight.sql` (self-check) → `CDP3C_up.sql` → **ikinci kez apply (idempotency)** → `gates/cdp3c_invariants.sql` (`CDP3C_INVARIANTS_PASS`) → `gates/cdp3c_tests.sql` (`CDP3C_TESTS_PASS`) → `CDP3C_down_soft.sql` + `gates/cdp3c_downsoft_assert.sql` (`CDP3C_DOWNSOFT_ASSERT_PASS`) → secret-scan → fail-closed teardown + residue=0 → `LOCAL_CDP3C_GATES_PASS`. **PGlite tek başına kanıt sayılmaz.**

**v3 eklenen çalıştırılabilir iddialar:** deactivate→mutate immutability [T11a–d]; controller JSONB kapalı-şema negatifleri [T15a–e]; iys lineage/scope + no-fake [T16a–b]; source×action×purpose matrisi [T17a–g]; doğrudan `marketing_config` bypass reddi [T18a–c]; admin 0C conflict [T19]; anon set/expiry/merge/conflict [T20a–e, T23]; legal_notice consent üretmez [T21a–b]; attestation revoke [T22a–b]; purpose_doc immutable [T26]; withdraw fail-closed (email yok) [T25]; PRE=POST [T29]; soft-down gerçek enforcement [downsoft_assert]; ikinci apply [workflow]. **Prod parity:** `gates/cdp3c_preflight.sql` apply öncesi PRODUCTION'da salt-okunur koşulur (düzeltme #17).

Sütun **[T##]** = `gates/cdp3c_tests.sql` içindeki çalıştırılabilir assertion; **[INV]** = `gates/cdp3c_invariants.sql`; **[3D]** = kasıtla ertelendi (bu pakette yok); **[static]** = statik/gözden geçirme denetimi.

## A. Consent çekirdek
| Test | Beklenen | Kanıt |
|---|---|---|
| `default_absent` | kayıtsız purpose → consent boş; marketing fail-closed | [T01] |
| `marketing_capture_disabled` | `marketing_capture_enabled=false` iken grant → `marketing_capture_disabled` | [T02] |
| `granular_channel` | email/sms/push_marketing bağımsız | [T04][T06] |
| `grant_then_withdraw` | grant→event+current=granted; withdraw→yeni event+current=withdrawn | [T04][T07] |
| `invalid_or_stale_version_reject` | yanlış/pasif doc_type veya controller-bağı yok → `invalid_or_stale_consent_version` | [T03] |
| `text_hash_server_derived` | content_hash body'den server-side (`_consent_text_biu`); client hash gönderemez | [T11][static] |
| `immutable_text_body` | yayımlanmış consent_text gövde UPDATE → `consent_text_published_immutable` | [T11] |
| `append_only_events` | member_consent_events UPDATE → `append_only_member_consent_events` | [T12] |
| `user_only_self` | auth.uid() dışına yazılamaz (parametre yok) | [static][INV] |
| `client_cannot_forge_source` | pref_center source'u server sabitler; `consent_set_via_flow` authenticated'a EXECUTE **yok** | [T10][INV] |
| `idempotent_replay` | aynı idem+payload → tek event | [T05] |
| `idem_conflict` | aynı idem, farklı payload → `idempotency_conflict` | [T06] |
| `anon_rpc_denied` / `rls_deny_all` | anon/auth doğrudan RPC/tablo erişimi yok (deny-all + grant yok) | [T18][INV] |
| `audit_no_raw_pii` | event/idempotency/audit'te ham e-posta/telefon/token yok | [T14][static] |

## B. Servis tercihleri
| Test | Beklenen | Kanıt |
|---|---|---|
| `service_pref_is_not_marketing_consent` | service_pref_set member_consent_* yazmaz | [static] |
| `essential_not_closable_by_pref` | OTP/verify/parola sıfırlama enum'da yok → kapatılamaz | [static] |
| `service_pref_config_pending` | default_enabled NULL + user satırı yok → `config_pending` (backfill yok) | [T19] |

## C. Suppression (iki tablo + supersede)
| Test | Beklenen | Kanıt |
|---|---|---|
| `withdraw_creates_user_unsubscribe` | email_marketing withdraw → `user_unsubscribe` suppression (current active) | [T07] |
| `multi_reason_current` | hard_bounce eklenince user_unsubscribe DE korunur (PK reason dahil) | [T08] |
| `grant_supersedes_only_user_unsubscribe` | yeni consent yalnız user_unsubscribe supersede; hard_bounce **active kalır** | [T09] |
| `iys_red_only_after_iys_sync` | iys_red yalnız İYS senkron kanıtıyla kalkar (`iys_supersede_red`) | [static] |
| `bounce_spam_admin_not_auto_cleared` | yeni consent hard_bounce/spam/admin_safety_block'u kaldırmaz | [T09][static] |
| `admin_cannot_set_user_reason` | admin_w_apply_suppression user_unsubscribe/iys_red reddeder | [T13] |
| `admin_suppression_audited_no_raw_hmac` | admin suppression audit üretir; ham HMAC audit'e yazılmaz | [T14] |
| `contact_hmac_no_raw_contact` | suppression'da ham e-posta/telefon yok, yalnız 64-hex HMAC | [static] |

## D. Marketing hard-gate + readiness
| Test | Beklenen | Kanıt |
|---|---|---|
| `marketing_enabled_default_false` | marketing_config.marketing_enabled=false | [INV] |
| `marketing_capture_default_false` | marketing_capture_enabled=false | [INV] |
| `readiness_fail_closed` | attestation yok → ready=false; missing listesi doğru | [T15] |
| `enable_revalidates_in_txn` | admin_w_set_marketing_enabled(true) readiness=false → `marketing_readiness_incomplete` | [T16] |
| `client_flag_cannot_enable_marketing` | yalnız admin_w_set_marketing_enabled + readiness=true; authenticated readiness_check exec **yok** | [INV] |
| `natural_person_alone_not_open_marketing` | yalnız natural_person controller → mersis/tüzel eksik → ready=false | [T15] |

## E. E-posta sınıflandırma + servis şablonu — **[3D — bu pakette YOK]**
| Test | Beklenen | Kanıt |
|---|---|---|
| `email_class_immutable` | yayınlanmış sürüm sınıf UPDATE → red | [3D] |
| `service_template_cannot_include_marketing_content` | assertServiceContent: servis şablonunda promo → red | [3D] |
| `service_template_maker_cannot_self_approve` | maker onaylayamaz (super_admin approval+audit) | [3D] |
| `service_send_only_approved_version` | servis gönderimi yalnız approved immutable sürüm | [3D] |
> Not: `message_class` 3C'den çıkarıldı (düzeltme #1/#10). INV, `email_templates.message_class` ve `journeys` **eklenmediğini** ayrıca doğrular.

## F. Controller / legal entity
| Test | Beklenen | Kanıt |
|---|---|---|
| `natural_person_controller_version` | aktif natural_person sürüm; typed alan zorunluluğu (CHECK) | [T-fixtures][static] |
| `future_legal_entity_leaves_old_evidence` | yeni legal_entity sürümü eski gerçek-kişi kanıtını değiştirmez (immutable) | [static] |
| `published_controller_immutable` | yayınlanmış controller sürümü UPDATE → red | [static] |
| `future_optin_uses_current_controller_version` | opt-in aktif controller+metin sürümüne bağlanır | [T03][T04] |

## G. Anonim consent
| Test | Beklenen | Kanıt |
|---|---|---|
| `anon_purpose_check` | anon consent yalnız analytics/advertising (CHECK); marketing/servis yok | [static] |
| `anon_ttl_blocker` | ttl_days NULL iken `anon_subject_create` → `anon_ttl_not_configured` | [T17] |
| `anon_expires_server_derived` | expires_at server-side türetilir; client veremez | [static] |
| `no_cross_device_auto_match` | cross-device otomatik eşleştirme yok | [static] |

## H. Mevcut hesaplar (dokunulmazlık)
| Test | Beklenen | Kanıt |
|---|---|---|
| `existing_members_not_auto_opted_in` | migration mevcut satırlara consent yazmaz | [static] |
| `no_backfill_no_marketing_prompt` | mevcut üyelere backfill/grant/popup yok | [static] |
| `members_and_auth_unchanged_by_migration` | migration members/auth.users satırlarını değiştirmez | [static] |

## I. Faz sınırı
| Test | Beklenen | Kanıt |
|---|---|---|
| `no_send_or_provider_in_migration` | up.sql'de gönderim/provider/outbox/journey yok | [INV][static] |
| `no_active_legal_text_without_body` | onaylı gövde olmadan `is_active=true` consent_text yok | [static] |

## J. Rollback
| Test | Beklenen | Kanıt |
|---|---|---|
| `down_soft_removes_rpc_keeps_data` | down_soft RPC'leri kaldırır; tablo/RLS/append-only/immutability/veri/pepper/kill-switch korunur | [gates soft-down step] |
| `rollback_zero_business_residue` | test fixture rollback sonrası iş verisi kalıntısı sıfır; teardown residue=0 | [T harness ROLLBACK][gates teardown] |
