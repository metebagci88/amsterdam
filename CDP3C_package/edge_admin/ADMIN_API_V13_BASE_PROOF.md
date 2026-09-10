# admin-api · v13 base kanıtı (deployed == repo base + yalnız additive)

## Provenance (canlı kaynak)
Repo'daki `CDP3B/edge/admin-api/index.ts`'in tabanı, canlı Edge Function'dan alınmıştır:
- Proje: `tosqsabuaomgqjtogdrn`, slug: `admin-api`
- `get_edge_function` metadata: **id=`75a6554b-59f5-4cc9-b302-16d9e475f67a`**, **version=13**, `verify_jwt=true`,
  `ezbr_sha256=d48a4a763d1da7785af2d7620e502d871555fb9fe9c8c17f915b6f32316d92b9`.
- İlk satır imzası birebir korunur: `// admin-api v13 / CDP-2B patch2 (segment_needs_review mapping)`.

> Not: Supabase platformu ham `index.ts` için SHA yayınlamaz; yalnız paketlenmiş (ezbr) bundle hash'i
> (`ezbr_sha256`) döner. Bu yüzden ham-dosya SHA eşitliği yerine, en güçlü doğrulama **türetilmiş v13 taban
> + additive-only diff**'tir (aşağıda), artı yukarıdaki canlı provenance metadata'sı.

## Dosyalar
- `admin-api.v13.base.ts` — SHA `7e6a029965e0db5faea970796d1194080209a44639a9673f6ca0c41868e51718`.
  Merged dosyadan CDP-3C additive'leri mekanik olarak çıkarılarak türetildi (`_derive_v13_base.mjs`).
- `CDP3B/edge/admin-api/index.ts` (merged) — SHA `880dd2c4b75814949aff35d9e6a478dbfc9563da74137c2cfc7093e3482fae7b`.

## Additive-only kanıtı (yeniden üretilebilir)
`node CDP3C_package/edge_admin/_derive_v13_base.mjs` → taban türetir.
`diff admin-api.v13.base.ts CDP3B/edge/admin-api/index.ts`:
- **Değişen (`<`) satır sayısı: yalnız 2** — `ROLE_SETS` ve `LIMITS` satırları. Bunlar da yalnızca sonlarına
  2'şer anahtar eklendiği için değişti (`q_member_consent`, `marketing_readiness_check`); mevcut 25
  CDP-2B/2C anahtarı byte-değişmedi.
- **Eklenen (`>`) satır: 15** — additive header yorumu (6) + ROLE_SETS/LIMITS'in yeni hâli (2) + dispatch
  (yorum + 2 else-if) + validate (2 yorum + 2 case).
- Taban dosya, deploy edilen v13'ün TÜM 25 action'ını içerir ve **hiçbir consent action'ı içermez**.
- Taban `esbuild` transpile → temiz (EXIT=0), v13 ile aynı.

## Sonuç
Merged admin-api = **deployed v13 tabanı + yalnız 2 SALT-OKUNUR consent action'ının additive eklenmesi**.
CDP-3B/CDP-2B/2C davranışını değiştiren alakasız hiçbir düzenleme yoktur; rol kapıları, rate-limit,
kill-switch, CORS ve mevcut 25 action byte-korunmuştur.
