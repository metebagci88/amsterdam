-- =====================================================================
-- CDP-3D · CI-ONLY BASELINE (test double) — PRODUCTION'A UYGULANMAZ
-- Amaç: ephemeral Supabase'de, CDP-3D'nin FK ile bağlı olduğu ÖNCEKİ FAZ (CDP-3B)
--       'public.email_templates' tablosunun MİNİMAL karşılığını oluşturmak.
--       Production'da bu tablo ZATEN vardır (CDP-3B). Bu dosya yalnız CI içindir;
--       CDP3D_up.sql'in 'email_outbox.template_id -> email_templates(id)' FK'sinin
--       fresh stack'te çözülebilmesi için gereklidir. Gerçek prod tanımı DEĞİLDİR.
-- =====================================================================
\set ON_ERROR_STOP on

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  internal_name text,
  description text,
  email_class text,
  source_type text,
  status text,
  current_draft_version_id uuid,
  published_version_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
