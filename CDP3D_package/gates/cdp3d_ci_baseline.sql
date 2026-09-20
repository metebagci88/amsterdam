-- =====================================================================
-- CDP-3D · CI-ONLY BASELINE (test double) — PRODUCTION'A UYGULANMAZ
-- Amaç: ephemeral Supabase'de, CDP-3D'nin bağlı olduğu ve CDP-3C baseline'ının
--       SAĞLAMADIĞI önceki-faz (CDP-3B) production kontratlarını MİNİMAL taklit etmek.
--       Production'da bu nesneler ZATEN vardır. Yalnız GERÇEKTEN KULLANILAN yüzey.
--
-- CDP-3D'nin bu dosyayla kapatılan önceki-faz boşlukları (statik bağımlılık analizi):
--   1) public.email_templates(id uuid)   — CDP-3B; email_outbox.template_id FK hedefi.
--   2) public.members.blocked (boolean)  — production'da var; _email_send_decision /
--      email_claim_batch 'members.blocked' okur; CDP-3C members double'ında yoktur.
--   Diğer tüm bağımlılıklar (members.user_id/email, contact_suppression_*, member_service_pref_*,
--   _contact_hmac + Vault pepper, _admin_active/_admin_has_role, _append_only_guard, enum'lar,
--   pgcrypto) CDP-3C baseline/up tarafından SAĞLANIR — burada TEKRARLANMAZ.
-- (ON_ERROR_STOP CI'da psql -v ile verilir; dosyada \set kullanılmaz -> araç bağımsız.)
-- =====================================================================

-- (1) email_templates — yalnız FK için gereken 'id' (minimal, production-özgü diğer alanlar taşınmaz)
create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid()
);

-- (2) members.blocked — production kontratı boolean; ephemeral double'a additive ekle
alter table public.members add column if not exists blocked boolean default false;
