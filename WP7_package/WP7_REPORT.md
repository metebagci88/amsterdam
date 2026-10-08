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

## WP7 (5/n) public labels · (6/n) admin venue-editor labels — uncommitted in the worktree (the operator commits)

Display layer only: no DB column, `src` code, storage key or table is renamed; no data is deleted from the DB. Nothing was
deployed, migrated or sent; production was not contacted.

### Public vocabulary (city page `amsterdam/index.html`)
| surface | before (wp7 4/n) | now |
|---|---|---|
| heart button on every card | icon only, no accessible name | `aria-label="Listeme ekle"` + `aria-pressed` (true/false); icon `aria-hidden` |
| chip / CTA / legend / map help | `❤️ Favori` · `Favorilerim · Öncelikli yerler` · `Favori` · `kalp = favori` | `❤️ Listem` · `Listem · Eklediğin yerler` · `Listem` · `kalp = Listem` |
| paywall / gate / list notes | `Favorilerime git`, `Favorilerin bu cihazda…`, `Henüz favorin yok…`, `favorilerini buluta kaydet` | `Listeme git`, `Listen bu cihazda…`, `Listen henüz boş. Mekânlar’da kalbe dokunarak listene ekle.`, `listeni hesabına kaydet` |
| venue modal + decision-engine toggle | `🤍 Kaydet` / `❤️ Kayıtlı`; reason `Favorilerinde` | `🤍 Listeme ekle` / `❤️ Listemde`; reason `Listende` |
| member area | tab `Beğeniler`, `Kaydettiklerin (N)`, taste texts | tab `Listem`, `Listem (N)`, `Listesi seninkine en çok benzeyen üyeler…` |
| storage names / messages | `Favoriler`, `Takvim notları`, `Gün planı notları`, `Favorin kaydedilemedi…` | `Listem`, `Kendi notların`, `Plan notların`, `Listen güncellenemedi: cihaz depolaması dolu. Değişiklik geri alındı.` |
| own notes | `🗒️ Kişisel not`, `Diğer not (serbest)` | `🗒️ Kendi notun` + **`Notumu kaydet`** button + `role=status` line; `Kendi notun (serbest)` (`📝 Plan notu` kept) |
| editorial scenario | `Favori mekanlardan kısa rota · En sevdiklerin` | `Editörün favorilerinden kısa rota · Editör seçimi` |
| verification wording | DE chip `⚠ Saat bilgisini kontrol et`; location error `…konum servislerini kontrol et.` | `⚠ Saat bilgisi doğrulanmadı`; `…konum servislerinin açık olduğundan emin ol.` |
| source labels | `Editör seçimi` / `Gezilecek yer` (WP7 4/n) | unchanged — **owner decision** on the wording |

- **Venue notes:** cards, the venue modal and the map popup render only `v.tip`, through `publicNote()`, escaped. `venues.note` is
  never rendered (the old `tip||note` fallback is gone). `publicNote` drops `Senin notun:` / `Editör notu:` prefixes, the old
  `❤️ (Öncelikli) Favori.` marker and the research prefixes, strips markup, and turns editorial to-dos into reader wording
  (`… henüz doğrulanmadı`) — no `teyit et`. The 6 embedded tips with a to-do now read e.g. “Rezervasyon bilgisi henüz doğrulanmadı.”
- **Notumu kaydet** reuses the existing save path only (`saveLS("cal")` → `asa:ams:cal`; for a member with a trip, the existing
  `TripSync.flush()`); no new storage key. It shows `Notun kaydedildi.` (synced) / `Notun kaydedildi (bu cihazda).` (device only)
  **only** when the write succeeded; otherwise a plain failure line. The member sync pill says `Notun kaydedildi` after a
  note-triggered save that succeeded.
- **Seeding stopped:** a fresh visitor's `asa:ams:fav` starts empty (nothing is written until the first heart). The editor's
  picks (`v.fav`) are no longer copied into the visitor's list; stored (new or legacy) lists are read as before.

### Embedded venue note values removed from the served page
`amsterdam/index.html`'s built-in fallback data no longer carries note text: all **49** `note:"…"` values → `note:""` (key kept,
shape unchanged; 109 venues; every other field deep-equal before/after — tip/description md5 `457302c9…` both sides). Notes are
never rendered publicly any more, and the production DB holds them. Read-only parity check run by the operator (2026-10-08) of
the embedded per-id note/tip md5s against `public.venues`: **106 / 109 embedded notes byte-identical in the DB**; **3 differ**
(`barcentraal`, `lusconi`, `saintjean`) because the DB holds newer edited versions. Tips differ for 4 ids (`barcentraal`, `flos`,
`lusconi`, `oficina`) — tips/descriptions are **not** changed here. Git history keeps all old bytes (e.g. `7ae9030`).
Raw served bytes after the change: `/` and `/kopenhag/` F1 = F2 = 0; `/amsterdam/` F1 = 0 and F2 = 6 — exactly the 6 embedded
fallback tips above (`kontrol et`), which render as reader wording; the leak gate pins them by venue id + sha256 of the tip and
fails on any other raw hit (see owner decision 5).

### Admin venue editor (`CDP3B/admin.html`, venue region only; the e-mail module is byte-identical — PR A owns it)
- `Not` → `Editör notu (sitede gösterilmez)`; `Yerli tüyosu (tip)` → `Yerli tüyosu (sitede görünür)`; `Açıklama` →
  `Açıklama (sitede görünür)`; photo hint → `Fotoğraf (boşsa sitede nötr yer tutucu gösterilir)`.
- `Kaynak`: free text → labelled select over the **unchanged** codes: user `Editör seçimi`, deck `Araştırma notu · önceki`,
  extra `Araştırma notu · ek`, audio `Sesli not`, poi `Gezilecek yer`; an unknown stored code shows as `(diğer: code)` and is
  saved back unchanged; empty stays empty (`null`).
- `Güven`: `Yüksek / Orta / Düşük`. **Bug fixed:** the old select offered only `high/med/low`, so opening and saving one of the
  11 `medium` venues silently wrote `high`. The stored value is now preserved (`medium` and legacy `med` both show `Orta` and are
  saved as stored; empty/unknown values are kept). New venues still default to `high`.
- Pill `kontrol` → `Teyit et`; dashboard stat `Kontrol gereken` → `Teyit bekleyen`.
- Not built (owner-decision proposals only, see below): `Kaynak gerekli`, `Yayına hazır`.

### Gates
- New `scripts/public_leak_gate.mjs`: anon + member × 1280 + 390 × embedded data + stub-DB sentinel rows (every DB note carries a
  sentinel token and internal phrases; empty tip; a DB tip with `kontrol et`; src null/`audio`/unknown; conf `medium`; resv null).
  Surfaces: `/`, `/kopenhag/`, `/amsterdam/`, `/amsterdam/?city=Amsterdam` (whole body incl. hidden views), every view, the
  Listem chip view, card + venue modal + popup for every venue, the day modal, the decision engine 7 × 5, every member segment,
  notices, dialogs, the sync pill, title/meta/og. DOM clone extraction (+ title/aria-label/placeholder/alt, options), NFC,
  scanned with `tr` and root lower-casing. Families F1 internal, F2 admin vocabulary, F3 escaped markup, F4 legacy list words
  (Listem / own-note selectors only). Positive assertions: heart aria-label + aria-pressed (and its flip on click), `❤️ Listem`
  chip / CTA / legend / member tab / `Listem (N)`, venue-modal toggle, `Kendi notun` + `Notumu kaydet` → `Notun kaydedildi` only
  after a real write (device-refused and server-refused paths show a failure line), fresh visitor's list empty, the sentinel
  note never rendered. Raw bytes of `/`, `/amsterdam/`, `/kopenhag/`: F1 = 0, F2 = 0 outside the 6 pinned tips. `_redirects`:
  UID page 301, package/internal paths 302. `--selftest`: 8 mutations (note value back in the bytes; `Benim listem` injected into
  the hidden map filter at run time; publicNote rewrite removed; `❤️ Favori` chip; heart without aria-label; seeding back;
  `tip||note` fallback back; `Notun kaydedildi` despite a refused write) must each FAIL, the unmutated copy must PASS.
- New `scripts/wp7_labels_unit.test.mjs` (node --test + jsdom): publicNote/srcGroup/SRCLBL, the 6 tips' exact reader wording,
  the embedded data (no note values), the vocabulary, the `Notumu kaydet` path, no seeding, and the **real** admin
  `editVenue` + `saveVenue` round-trip for every Güven/Kaynak value (stored value preserved). One-time scope check (WP7 branch):
  the admin e-mail module region is byte-identical to `7ae9030`.
- New CI `.github/workflows/wp7-launch-gates.yml` (paths: pages, `CDP3B/admin.html`, `_redirects`, `_headers`, `scripts/**`,
  `WP3_package/**`, `WP4_package/**`, `WP5_package/web/**`, `lib/**`, `SHA256SUMS`, the workflow): the WP5 web chain
  (`WP5_WEB_GATES_PASS`), the unit tests, the leak gate and its self-test, then a secret scan of the files and logs. Fail-closed:
  each step greps its exact PASS marker; INCOMPLETE (exit 4) is red.

### Tests updated (each change carries a `WP7 (5/n)` / `WP7 (6/n)` comment)
- `scripts/ux_sprint1_trust_check.mjs`: paywall `Listeme git`, Listem copy ×3, seeding → “no seed” (source + empty storage stays empty).
- `WP3_package/tests/wp3_e2e.mjs`: fresh user → no seed, first heart writes `asa:ams:fav`; notice names `Listem` / `Kendi notların`
  / `Plan notların`; refused write → `Listen güncellenemedi`; seed-guard scenario kept (comment).
- `WP3_package/tests/wp3_unit.test.mjs`: comment only (the predicate now only decides whether a stored list is read).
- `lib/asa-storage/asa_storage.test.mjs`: the initFav source pin follows “no seed” (+ an explicit no-`v.fav`-copy assertion).
- `WP5_package/web/tests/wp5_unit.test.mjs`: `CDP3B/admin.html` is no longer byte-pinned to the WP5 parent (WP7 6/n changes its
  venue region; PR A its e-mail block); it is still checked not to load WP5.
- `CDP3C_package/gates/cdp3c_edge_tests.mjs`: `/Veri notları/` → `/veri not(u|ları)/i`.
- `SHA256SUMS` (lines for `CDP3B/admin.html`, `amsterdam/index.html`, `cdp3c_edge_tests.mjs`) and `CDP3B/SHA256SUMS` (`admin.html`).
- WP4 tests needed no change.

### Merge / rebase notes
- PR A (`fix/admin-save-draft-feedback`) touches the same `SHA256SUMS` line 39 and the `CDP3B/SHA256SUMS` admin.html line —
  whichever merges second recomputes them. The two admin regions do not overlap.
- WP6 (`wp6-plan-hydrate-fix`) rewrites the favourites sync: at rebase re-apply the strings and update
  `wp6_sync_integrity.test.mjs:802` (`Favorin kaydedilemedi` → `Listen güncellenemedi`) and the `SEED_FAV_IDS` cases (seeding stops).
- `LIVE_CHECKS` (separate branch, not edited here): `qa/wp6_live.mjs` 456/467-470 (`Favorilerime git` → `Listeme git`), 475/673
  (`Favorilerin bu cihazda` / `Henüz favorin yok` → Listem copy); `wp7_live.mjs` / `qa/wp7_live.mjs` LEAK_RE should adopt the
  leak gate's families and scan hidden views.

### Owner decisions (flagged, not decided here)
1. Public source labels `Editör seçimi` / `Gezilecek yer` (kept from WP7 4/n).
2. Toggle wording `❤️ Listemde` (alternative `Listemden çıkar`), and the CTA subtitle `Eklediğin yerler`.
3. The new `Notumu kaydet` button (the owner's phrase) and the device-only suffix `(bu cihazda)`.
4. Stopping the favourite seeding is a behaviour change (done as instructed; fresh visitors start with an empty Listem).
5. Raw-bytes F2 is **not 0** on `/amsterdam/`: 6 embedded fallback tips (`shiraz`, `cheznina`, `escobar`, `barracuda`,
   `fabus`, `september`) still say `kontrol et` in the source bytes (they render as reader wording). Tips were not edited, as
   instructed. Reaching 0 needs the owner to reword these tips in the DB **and** the embedded copy (a production data change,
   separate approval); then drop `RAW_TIP_EXEMPT` from the gate.
6. Proposed (not built) admin pills: `Kaynak gerekli` = conf low and no web and no ig; `Yayına hazır` = inactive and conf ≠ low
   and (tip or description) — must exclude temporarily-closed and coordinate-invalid venues, and a deliberately deactivated
   venue would be mislabelled “ready”; needs the owner's definition first.
7. `venues.note` is still readable by anon over REST (separate, approval-gated production change). Before revoking anon's
   column grant, the city page's two `from("venues").select("*")` calls must switch to an explicit column list, or the venue
   load fails with a permission error.

### Local evidence (2026-10-08, container; no network, no production)
- `WP4_SCOPE_CHECKS=0 bash WP5_package/web/tests/run_all.sh` → `WP5_WEB_GATES_PASS` (inside: `WP5_E2E_PASS`, `WP4_E2E_PASS`,
  `WP3_E2E_PASS`, `WP3_GATES_PASS`, `WSE_STATIC_PASS`, `WP4_GATES_PASS`, `SHA256SUMS_OK`, secret scans clean).
- `node --test scripts/wp7_labels_unit.test.mjs` → 13/13 pass. Against the pre-change files (7ae9030) → 11 of the 12 content
  tests fail, including the Güven round-trip (`medium` → `high`).
- `node scripts/public_leak_gate.mjs` → `PUBLIC_LEAK_GATE_PASS` (8 runs, 136 checks, 0 hits). Against the pre-change WP7 tree →
  FAIL (40 failed checks, 478 hits); against origin/main → FAIL (48 failed checks, 698 hits).
- `node scripts/public_leak_gate.mjs --selftest` → `PUBLIC_LEAK_GATE_SELFTEST_PASS` (unmutated copy PASS; M1–M8 each FAIL).
- `CDP3C_package/gates/cdp3c_edge_tests.mjs` → 61/61 PASS; CDP3B `admin_reopen_test` → `ADMIN_REOPEN_OK`, `gjs_serialize_test` →
  `GJS_SERIALIZE_OK`, `media_upload_client.test` → 54/54; `sha256sum -c` root + `CDP3B/SHA256SUMS` OK.
- Member dry run (`LIVE_CHECKS/qa/dryrun/run_dryrun.sh`, `DRY_SCRIPT=wp7_live.mjs`, local stub of this tree) → **PASS 11/11**
  (before: 10/11, “fresh visitor: no pre-filled favourites” failed with 7 seeded ids).
- CI-only (need `supabase start`): `cdp3b-gates` (fires on `CDP3B/**`), `cdp3c-edge-integration`, the DB part of `cdp3c-gates`.
