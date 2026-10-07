# WP7 — Amsterdam Türkçe V1 beta açılışı (branch `wp7-beta-launch`)

Status: **IN PROGRESS** (the merge waits for WP6 PASS, per PRD §4). Static-only package: HTML, `_redirects`, `_headers` and tests. No DB migration and no Edge change.

## Launch checklist (PRD WP7)

| # | item | state | evidence |
|---|---|---|---|
| 1 | Paket 1–6 PASS | pending | WP6 fix PR and live E2E run (report Stage 06) |
| 2 | Production URL + canonical www | done on branch | apex 301 → www (live smoke). `<link rel=canonical>` + `og:url` on `/` and `/amsterdam/`. The Kopenhag stub stays byte-pinned (WP3/WP4/WP5 gates) |
| 3 | `/`, `/amsterdam/`, `/kopenhag/`, `/admin` smoke | preview PASS | `LIVE_CHECKS/wp7_live.mjs` on the preview at 4d725d6: **26/26 PASS** (Actions run 37694235612). Production smoke after merge |
| 4 | Kopenhag stub + alias redirects kept | done | preview: `/copenhagen`, `/copenhagen/`, `/kopenhag.html`, `/copenhagen.html` → 302 `/kopenhag/`. `/amsterdam/?city=Kopenhag` → `/kopenhag/` |
| 5 | No internal text / personal plan / `file://` / WhatsApp-whisper / test data | done on branch | `amsterdam_index_UID.html` deleted, 301 → `/amsterdam/`. The 146 internal repo files (docs, SQL, gates, Edge sources, zip, checksums, workflows) all answer 3xx on the preview. City page: public source labels, `publicNote()` reader wording, no Unsplash venue images. Member-view dry run is clean |
| 6 | Real footer, no broken `#` links | done | home footer has no anchors. The city page and stub have no footer. Visible `#` links = 0 on the preview |
| 7 | No marketing/cookie tracking without consent | done | preview Chromium request hosts: own site, supabase, jsdelivr, tailwind CDN, Google Fonts, unpkg (Leaflet), Unsplash (home city cards only). No tracker host, no `/cdn-cgi/` beacon. marketing flags false |
| 8 | Marketing/SMS/push/journey closed | done | `marketing_enabled=false`, `marketing_capture_enabled=false`. email essential/service/public_go_live all false. No cron, no pg_net, no http triggers |
| 9 | OTP + membership work | done (WP4/WP5 live) | WP4 37/37, WP5 38/38 on production |
| 10 | Security policy matrix recorded | done | `WP7_SECURITY_MATRIX.md` (57 relations; md5 `79e1b1e3…`) |
| 11 | Support / feedback channel, no fake box | **owner action** | `asalocal.club` has **no MX record** (dig on the runner), so `destek@asalocal.club` cannot receive mail. Showing it would be a fake box. Needs free Cloudflare Email Routing (owner) |
| 12 | Rollback refs | done | `evidence/wp7_pre_rollback_refs_2026-10-07.json` |

## Beta labels
- Amsterdam is the active city. A visible **Beta** badge sits next to the brand on `/` and `/amsterdam/`.
- Kopenhag shows as **hazırlanıyor**: option label, card badge and CTA. It never creates a server trip (WP4 e2e, mutation-checked).
- The other cities are **yakında**: the button is disabled and nothing is promised. The old “✓ İlgin kaydedildi … haber vereceğiz” claim is removed, because nothing was ever stored.
