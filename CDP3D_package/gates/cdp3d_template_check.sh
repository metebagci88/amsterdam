#!/usr/bin/env bash
# =====================================================================
# CDP-3D · İçerik gate'i (fail-closed): welcome v3.2 kanonik şablonu + hukuk taslak iskeleti.
# Yalnız GATE_FAILED:template_check:<kural>[:<dosya>] satırları ve sonuç sentinel'i basar;
# dosya içeriği ASLA basılmaz. Ağ, DB, Docker gerekmez.
#
# A) email/ ağacı: yalnız email/templates/welcome_service_email.v3.2.{html,txt,json}.
#    html/txt hash pin'leri, CR/BOM yok, görsel politikası (img/data:/url()/VML/background yok),
#    değişken allowlist (yalnız first_name), selamlama = {{first_name}}, bağlantı kümesi,
#    tek e-posta destek@asalocal.club, sır benzeri dize yok. Meta veri (json): zorunlu anahtarlar,
#    hash'ler, ham (redaksiyon öncesi) gövdelerin özetleri/boyutları YOK (adı brute-force ile geri
#    verirler), yalnız izinli hex dizeleri, e-posta yalnız destek@asalocal.club, 10+ haneli sayı /
#    telefon / IBAN yok, saat hassasiyetinde zaman damgası yok.
# B) legal/ ağacının TAMAMI (özyinelemeli): izinli yollar yalnız legal/drafts/tr/<sabit küme> ve
#    içe aktarma hedefi legal/source/ (manifest SOURCE_MISSING iken boş olmalı). Her dosyada
#    DRAFT_LEGAL_REVIEW_REQUIRED; drafts/tr'de ayrıca SOURCE_MISSING; yer tutucu dışında 10+ haneli
#    sayı (MERSİS 16, TCKN 11, VKN 10), 4'lü gruplu 16 hane, telefon, IBAN, e-posta yok;
#    consent/controller/readiness tablolarına yazan SQL veya aktivasyon RPC çağrısı yok; yer tutucu
#    sözlüğü; manifest ve controller_identity aynası; SOURCE_MISSING belgelerde hukuk metni yok
#    (satır grameri + altı belgenin bayt pin'i).
# C) Paket geneli: bilinen migration/gate dosyaları dışındaki *.sql dosyalarında consent/controller/
#    readiness tablolarına yazma yok; hiçbir dosyada değişken olmayan 'Merhaba <ad>,' selamlaması
#    yok (ham outbox kopyası içerikle yakalanır, hash deny-list'i yok); '*.raw.*' dosya adı yok.
#
# Kullanım: bash gates/cdp3d_template_check.sh [CDP3D_package dizini]   (varsayılan: .)
# =====================================================================
set -uo pipefail
PKG="${1:-.}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -d "$PKG/email/templates" ] || { echo "GATE_FAILED:template_check:no_email_templates_dir"; exit 1; }
[ -d "$PKG/legal/drafts/tr" ] || { echo "GATE_FAILED:template_check:no_legal_drafts_dir"; exit 1; }

rc=0
python3 -I - "$PKG" <<'PY' || rc=1
import hashlib, json, os, re, sys

PKG = sys.argv[1]
TPL = os.path.join(PKG, 'email', 'templates')
LEGROOT = os.path.join(PKG, 'legal')
LEG = os.path.join(LEGROOT, 'drafts', 'tr')
FAILS = []
def rel(p): return os.path.relpath(p, PKG).replace(os.sep, '/')
def fail(rule, f=None):
    FAILS.append(rule + (':' + os.path.basename(f) if f else ''))
def failr(rule, p):                      # ağaç taramalarında paket-göreli yol
    FAILS.append(rule + ':' + rel(p))
def sha(b): return hashlib.sha256(b).hexdigest()
def read(p):
    with open(p, 'rb') as fh: return fh.read()
def walk(top):
    """Dosya yollarını verir; .git/node_modules atlanır. Sembolik bağ (dosya veya dizin) kırmızıdır:
    taramanın dışına çıkılmasın."""
    for root, dirs, files in os.walk(top):
        for d in list(dirs):
            if os.path.islink(os.path.join(root, d)): failr('symlink', os.path.join(root, d))
        dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.git') and not os.path.islink(os.path.join(root, d)))
        for fn in sorted(files):
            p = os.path.join(root, fn)
            if os.path.islink(p): failr('symlink', p); continue
            yield p

HTML_SHA = '77e9aeda87bf93250fa70ccc68d2e52e35653361ee0809702a92395880c741eb'
TEXT_SHA = '818164c11d23badc6636e5a816c366a952f6034f751ff51258464fe18d65fe56'
SANITIZER_SHA = '11490786a1d5de4f685c0db25f9555af56cc95611c5e2f6ea09fc8cf15592bf9'   # CDP3C email_sanitizer.js
# Meta veride izinli hex dizeleri (>= 8): iki dosya hash'i, sanitizer hash'i, outbox satır ön ekleri,
# sanitize çıktısının ön eki. Başka her hex dizesi (ör. ham gövde özeti veya ön eki) kırmızıdır.
JSON_HEX_ALLOW = {HTML_SHA, TEXT_SHA, SANITIZER_SHA, '4cf96896', '8a532f77', 'ce2107df', 'd3f0edcc'}

SECRET_RES = [re.compile(p) for p in (
    r'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{5,}',   # JWT
    r'sb_secret_[A-Za-z0-9_-]{8,}', r'sb_publishable_[A-Za-z0-9_-]{8,}', r'sbp_[A-Za-z0-9]{20,}',
    r're_[A-Za-z0-9]{16,}', r'sk_live_[A-Za-z0-9]{8,}', r'AKIA[0-9A-Z]{16}',
    r'-----BEGIN [A-Z ]*PRIVATE KEY', r'gh[posru]_[A-Za-z0-9]{20,}', r'github_pat_[A-Za-z0-9_]{20,}',
    r'://[A-Za-z0-9._%+-]+:[^@/\s]{3,}@[A-Za-z0-9.-]+',
    r'(SERVICE_ROLE_KEY|SERVICE_KEY|SECRET_KEY|API_KEY|ACCESS_KEY|DB_PASSWORD|SUPABASE_KEY)\s*[:=]\s*[A-Za-z0-9/_+.-]{12,}',
    r'password\s*=\s*[^\s"\']{8,}',
)]
EMAIL_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
HASH64_RE = re.compile(r'(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])')     # sha256 özetleri önce çıkarılır
DIGIT_RES = [re.compile(r'(?<!\d)\d{10,}(?!\d)'),                               # MERSİS (16), TCKN (11), VKN (10); bitişik harf fark etmez
             re.compile(r'(?<!\d)\d{4}([ .-]\d{4}){3}(?!\d)'),                  # 16 hane, 4'lü gruplar
             re.compile(r'(\+90|(?<!\d)0)[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}(?!\d)'),   # TR telefon
             re.compile(r'(?<![A-Za-z])TR\d{2}[ ]?\d{4}', re.I)]                # IBAN
def digits_bad(s):
    s = HASH64_RE.sub(' ', s)
    return any(r.search(s) for r in DIGIT_RES)
# Değişken olmayan selamlama: 'Merhaba <ad>,' (yalnız 'Merhaba {{first_name}},' serbest)
GREET_ANY = re.compile(r'Merhaba\s+(?!\{\{\s*first_name\s*\}\}\s*,)([^\s,<]+)\s*,', re.I)
def greeting_bad(s):
    if GREET_ANY.search(s): return True
    flat = re.sub(r'<[^<>]{0,300}>', '', s).replace('&nbsp;', ' ').replace('&#160;', ' ')   # etiketli/nbsp'li biçimler
    return bool(GREET_ANY.search(flat))
TABLES = (r'("?public"?\s*\.\s*)?"?(consent_\w+|member_consent_\w+|anon_consent_\w+|controller_identity_versions|'
          r'readiness_attestations|marketing_config|legal_notice_events|app_privacy_config|service_pref_defaults|'
          r'member_service_pref_\w+)\b')
RPC_RES = [re.compile(p, re.I) for p in (
    r'\bactive_controller_version_id\s*:?=',
    r'\badmin_w_(publish_controller_version|publish_consent_text|approve_consent_text|add_readiness_attestation|set_marketing_enabled|set_marketing_capture_enabled|set_service_pref_default)\s*\(',
    r'\b(consent_set_pref_center|consent_set_via_flow|anon_consent_set|legal_notice_record)\s*\(',
)]
TABLE_WRITE_RES = [re.compile(r'\b(insert\s+into|delete\s+from|merge\s+into|truncate(\s+table)?|copy|update)\s+(only\s+)?' + TABLES, re.I)] + RPC_RES
# legal/ altında veri yazan her türlü SQL yasak (tablo fark etmez) + yukarıdakiler
SQL_RES = [re.compile(p, re.I) for p in (
    r'\binsert\s+into\b', r'\bdelete\s+from\b', r'\bupsert\b', r'\bcopy\s+\S+\s+from\b', r'\bmerge\s+into\b',
)] + TABLE_WRITE_RES

def text_ok(b, f, relpath=False):
    """UTF-8, BOM yok, CR yok, sondaki LF var."""
    F = (lambda r: failr(r, f)) if relpath else (lambda r: fail(r, f))
    if b.startswith(b'\xef\xbb\xbf'): F('bom')
    if b'\r' in b: F('cr')
    if not b.endswith(b'\n'): F('no_trailing_lf')
    try: return b.decode('utf-8')
    except UnicodeDecodeError: F('not_utf8'); return None

def secrets(s, f, relpath=False):
    for r in SECRET_RES:
        if r.search(s):
            (failr if relpath else fail)('secret_like', f); return

# ------------------------------------------------------------------ A) e-mail template
H = os.path.join(TPL, 'welcome_service_email.v3.2.html')
T = os.path.join(TPL, 'welcome_service_email.v3.2.txt')
J = os.path.join(TPL, 'welcome_service_email.v3.2.json')
want = {os.path.basename(H), os.path.basename(T), os.path.basename(J)}
have = set(os.listdir(TPL))
if have != want: fail('template_fileset')
ALLOWED_EMAIL = {rel(H), rel(T), rel(J)}
for p in walk(os.path.join(PKG, 'email')):
    if rel(p) not in ALLOWED_EMAIL: failr('email_path_not_allowed', p)
hb = read(H) if os.path.isfile(H) else b''
tb = read(T) if os.path.isfile(T) else b''
jb = read(J) if os.path.isfile(J) else b''
if sha(hb) != HTML_SHA: fail('html_sha')
if sha(tb) != TEXT_SHA: fail('text_sha')
hs = text_ok(hb, H) or ''
ts = text_ok(tb, T) or ''
js = text_ok(jb, J) or ''
if re.search(r'<img\b|data:|url\(|<v:image\b|<v:fill\b|\bbackground\s*=|background-image|\bsrc\s*=|<svg\b|<picture\b|srcset', hs, re.I):
    fail('image_policy', H)
if re.search(r'data:|<img\b', ts, re.I): fail('image_policy', T)
var_re = re.compile(r'\{\{\s*([a-zA-Z0-9_]+)\s*\}\}')
if var_re.findall(hs) != ['first_name']: fail('vars', H)
if var_re.findall(ts) != ['first_name']: fail('vars', T)
greet = re.compile(r'Merhaba\s+([^\s,<]+)\s*,')
for s, f in ((hs, H), (ts, T)):          # selamlama yalnız değişken olabilir, asla gerçek bir ad
    if greet.findall(s) != ['{{first_name}}']: fail('greeting', f)
LINKS = {'https://asalocal.club/', 'https://asalocal.club/preferences', 'mailto:destek@asalocal.club'}
if set(re.findall(r'href\s*=\s*"([^"]*)"', hs, re.I)) != LINKS: fail('links', H)
if re.search(r"href\s*=\s*'", hs, re.I): fail('links_single_quoted', H)
if not set(re.findall(r'https?://[^\s)<>"\']+', ts)) <= {'https://asalocal.club/', 'https://asalocal.club/preferences'}: fail('links', T)
if set(EMAIL_RE.findall(hs + ts)) != {'destek@asalocal.club'}: fail('emails')
m_title = re.search(r'<title>([^<]*)</title>', hs)
if not m_title or m_title.group(1) != 'Aramıza hoş geldin': fail('title', H)
if not re.search(r'<html[^>]*\blang="tr"', hs): fail('lang', H)
for s, f in ((hs, H), (ts, T), (js, J)): secrets(s, f)

try:
    m = json.loads(js) if js else {}
except ValueError:
    m = {}; fail('meta_json_parse', J)
if not isinstance(m, dict): m = {}; fail('meta_json_parse', J)
def g(o, *ks):
    for k in ks:
        if not isinstance(o, dict) or k not in o: return None
        o = o[k]
    return o
def meta(cond, rule):
    if not cond: fail('meta_' + rule, J)
meta(g(m, 'template_key') == 'welcome_service_email', 'template_key')
meta(g(m, 'version') == 'v3.2', 'version')
meta(g(m, 'status') == 'approved_source_not_published', 'status')
meta(g(m, 'subject') == 'Aramıza hoş geldin' and (m_title is not None and g(m, 'subject') == m_title.group(1)), 'subject')
meta(g(m, 'class') == 'optional_service', 'class')
meta(g(m, 'service_pref_key') == 'welcome_service_email', 'service_pref_key')
meta(g(m, 'locale') == 'tr-TR', 'locale')
meta(g(m, 'personalization', 'allowlist') == ['first_name'], 'allowlist')
meta(g(m, 'personalization', 'occurrences') == {'html': 1, 'text': 1}, 'occurrences')
for k, b, s in (('html', hb, hs), ('text', tb, ts)):
    meta(g(m, 'files', k, 'sha256') == sha(b) and g(m, 'files', k, 'bytes') == len(b) and g(m, 'files', k, 'chars') == len(s), 'files_' + k)
meta(g(m, 'files', 'html', 'sha256') == HTML_SHA and g(m, 'files', 'text', 'sha256') == TEXT_SHA, 'files_pins')
ip = g(m, 'image_policy') or {}
meta(all(ip.get(k) == 0 for k in ('img_tags', 'data_uri', 'remote_images', 'css_background_images'))
     and ip.get('inline_or_data_uri_logo') is False and 'wordmark' in str(ip.get('logo', '')), 'image_policy')
va = g(m, 'approval', 'visual_approval') or {}
meta(va.get('client') == 'Gmail' and va.get('result') == 'passed' and va.get('recorded_by') == 'owner', 'visual_approval')
meta(g(m, 'approval', 'legal_review') == 'legal review not addressed by the brief; classification is on the lawyer checklist', 'legal_review')
meta(g(m, 'provenance', 'source_kind') == 'AUTHORITATIVE_OUTBOX_COPY', 'source_kind')
# Ham (redaksiyon öncesi) gövdelerin özetleri, boyutları ve hash ön ekleri kısa bir adı geri verir: yayımlanmaz.
pv = g(m, 'provenance')
meta(isinstance(pv, dict) and 'original' not in pv and str(pv.get('original_digests', '')).startswith('withheld'), 'no_original_digests')
meta(set(re.findall(r'[0-9a-fA-F]{8,}', js)) <= JSON_HEX_ALLOW, 'hex_allowlist')
meta(set(EMAIL_RE.findall(js)) <= {'destek@asalocal.club'}, 'email')
meta(not digits_bad(js), 'digits')
meta(not re.search(r'(?<!\d)\d{1,2}:\d{2}(?!\d)', js), 'timestamp_precision')        # yalnız tarih; saat yok
tr = {t.get('id'): t for t in (g(m, 'provenance', 'transformations') or []) if isinstance(t, dict)}
meta(set(tr) == {'S1', 'S2'}, 'transformations')
s2 = tr.get('S2', {})
meta(s2.get('status') == 'applied' and s2.get('needs_owner_ok') is False and "no-PII" in str(s2.get('decided_by', '')), 'S2_applied')
meta('template_version_id' not in js, 'no_template_version_id')    # email_outbox has no such column
meta(not re.search(r'not required', js, re.I), 'no_not_required_wording')
meta(g(m, 'not_published') is True, 'not_published')
oi = g(m, 'open_issues')
meta(isinstance(oi, list) and len(oi) >= 1 and not any('20 of 21' in str(x) for x in oi), 'open_issues')

# ------------------------------------------------------------------ B) legal/ (whole tree)
DOCS = ['kvkk_aydinlatma', 'acik_riza_marketing', 'acik_riza_kisisellestirme', 'cerez_politikasi', 'gizlilik_politikasi', 'uyelik_sartlari']
LFILES = {d + '.v1.draft.md' for d in DOCS} | {'README.md', 'LAWYER_CHECKLIST.md', 'manifest.json', 'controller_identity.draft.json'}
# SOURCE_MISSING iskeletinin incelenmiş baytları. İçe aktarma bu pin'leri aynı değişiklikte günceller.
DRAFT_PINS = {
    'kvkk_aydinlatma':           '196db422512ae1cf6a52169513d37bbd339949e82bbd6134b7e59dc07eaa7463',
    'acik_riza_marketing':       'f5a97047547c23f0a225e20065d5961c99986ac2ae29439df53b7a42b463d347',
    'acik_riza_kisisellestirme': '1b9bc21a6a10de9e366366f8557c9277146778a6c0e0f9a67a0f859b1efdfb26',
    'cerez_politikasi':          '7f8468a94a435e3f0bbb94725e3e4fa8a366fbab2631b54ef6e2e94ffb3fa745',
    'gizlilik_politikasi':       'd6174e934c66c4bf93b181f9b131174987c63e9b34f872f2edfa4d599f97bf3e',
    'uyelik_sartlari':           '455b97c981823090039cba5cc2f48461f5928099bd5d9103d43c4fa0ccc9613e',
}
lhave = set(os.listdir(LEG))
if lhave != LFILES: fail('legal_fileset')
VOCAB = {'UNVAN', 'MERSIS_16_DIGITS', 'ADDRESS', 'KEP', 'VKN', 'VERGI_DAIRESI', 'TELEFON', 'CONTACT_EMAIL', 'CONTACT_CHANNEL',
         'FULL_NAME', 'DISPLAY_NAME', 'EFFECTIVE_DATE', 'PROCESSORS', 'TRANSFER_MECHANISM', 'VERBIS_STATUS', 'AGE_LIMIT',
         'CONTROLLER_VERSION', 'natural_person|legal_entity'}
PH_RE = re.compile(r'\{\{([^{}]*)\}\}')
BANNER = ('> DRAFT_LEGAL_REVIEW_REQUIRED · SOURCE_MISSING · Hukuk metni içermez: yalnız başlık iskeleti, '
          'avukat blokları ve yer tutucular. Yayımlanmaz, aktifleştirilmez, veritabanına yazılmaz.')
KVKK_LABEL = 'KVKK m.10 unsurları + yaygın ekler (kategoriler, saklama); avukat yeniden yapılandırabilir'
PH = r'\{\{[A-Za-z0-9_|]+\}\}'
LINE_OK = [re.compile(r'^#{1,4} \S.{0,118}$'),
           re.compile(r'^\[\[LAWYER_TEXT_REQUIRED: [^\[\]]{3,300}\]\]$'),
           re.compile(r'^- [^:{}\[\]]{1,48}: ' + PH + r'(, ' + PH + r')*$')]
SENTENCE_RE = re.compile(r'[.!?…]\s*$|[.!?…]\s+[A-ZÇĞİÖŞÜ]')     # cümle sonu / cümle sınırı = hukuk metni
def line_text(ln):
    """Başlık / avukat bloğu içindeki serbest metin (numara öneki çıkarılmış)."""
    if ln.startswith('[[LAWYER_TEXT_REQUIRED: '): return ln[len('[[LAWYER_TEXT_REQUIRED: '):-2]
    if ln.startswith('#'): return re.sub(r'^#{1,4} (\d+(\.\d+)*\.? )?', '', ln)
    return ''

texts = {}
src_files = []
for p in walk(LEGROOT):
    r = rel(p)
    in_tr = os.path.dirname(p) == LEG and os.path.basename(p) in LFILES
    in_src = r.startswith('legal/source/')
    if not (in_tr or in_src): failr('legal_path_not_allowed', p)
    if in_src:
        src_files.append(p)
        if not re.search(r'\.(md|txt)$', p): failr('legal_source_ext', p)
    F = (lambda rule, p=p: fail(rule, p)) if in_tr else (lambda rule, p=p: failr(rule, p))
    s = text_ok(read(p), p, relpath=not in_tr)
    if s is None: continue
    if in_tr: texts[os.path.basename(p)] = s
    if 'DRAFT_LEGAL_REVIEW_REQUIRED' not in s: F('legal_status_marker')
    if in_tr and 'SOURCE_MISSING' not in s: F('legal_source_missing_marker')
    phs = PH_RE.findall(s)
    if any(not (x in VOCAB or re.fullmatch(r'RETENTION_[A-Z][A-Z_]*', x)) for x in phs): F('legal_placeholder_vocab')
    bare = PH_RE.sub(' ', s)            # yer tutucular dışarıda bırakılır
    if EMAIL_RE.search(bare): F('legal_email')
    if digits_bad(bare): F('legal_digits')
    if any(rx.search(s) for rx in SQL_RES): F('legal_sql')
    if 'Merhaba' in s: F('legal_greeting')
    secrets(s, p, relpath=not in_tr)

try: man = json.loads(texts.get('manifest.json', ''))
except ValueError: man = {}; fail('legal_manifest_parse')
if not isinstance(man, dict): man = {}; fail('legal_manifest_parse')
def lm(cond, rule):
    if not cond: fail('legal_manifest_' + rule)
lm(man.get('status') == 'DRAFT_LEGAL_REVIEW_REQUIRED' and man.get('source') == 'SOURCE_MISSING', 'status')
lm(man.get('source_sha256') is None and man.get('source_bytes') is None, 'source_hash_null')
lm(man.get('not_published') is True and man.get('not_activated') is True, 'not_published')
# Manifest SOURCE_MISSING iken (bu gate yalnız o durumu kabul eder) legal/source/ boş olmalı; içe aktarma
# manifest'i, bu kuralı ve pin'leri aynı incelenen değişiklikte günceller (README adım 6).
if src_files: fail('legal_source_unexpected')
docs = man.get('documents') if isinstance(man.get('documents'), list) else []
lm([d.get('doc_type') for d in docs if isinstance(d, dict)] == DOCS, 'doc_types')
for d in docs:
    if not isinstance(d, dict): lm(False, 'entry'); continue
    dt = d.get('doc_type')
    lm(d.get('version') == 1 and isinstance(d.get('locale'), str) and re.fullmatch(r'[a-z]{2}', d.get('locale')) and d.get('locale') == 'tr', 'version_locale')
    lm(d.get('file') == '%s.v1.draft.md' % dt and d.get('status') == 'DRAFT_LEGAL_REVIEW_REQUIRED' and d.get('source') == 'SOURCE_MISSING', 'entry_fields')
    lm(d.get('body_sha256') is None, 'body_sha256_null')
    lm(isinstance(d.get('db_consumers'), list) and isinstance(d.get('needed_for'), list) and d.get('needed_for'), 'consumers')

for dt in DOCS:
    fn = dt + '.v1.draft.md'; s = texts.get(fn)
    if s is None: continue
    p = os.path.join(LEG, fn)
    if sha(s.encode('utf-8')) != DRAFT_PINS[dt]: fail('legal_draft_pin', p)
    lines = s.split('\n')
    if lines[0] != '---' or '---' not in lines[1:]: fail('legal_front_matter', p); continue
    end = lines.index('---', 1)
    fm = {}
    for ln in lines[1:end]:
        k, sep, v = ln.partition(': ')
        if not sep or k in fm: fail('legal_front_matter', p); continue
        fm[k] = v
    exp = {'status': 'DRAFT_LEGAL_REVIEW_REQUIRED', 'doc_type': dt, 'version': '1', 'locale': 'tr', 'source': 'SOURCE_MISSING',
           'controller_ref': '"{{CONTROLLER_VERSION}}"', 'not_for_publication': 'true', 'effective_date': '"{{EFFECTIVE_DATE}}"'}
    if set(fm) != set(exp) | {'structure'} or any(fm.get(k) != v for k, v in exp.items()): fail('legal_front_matter', p)
    if dt == 'kvkk_aydinlatma':
        if fm.get('structure') != '"%s"' % KVKK_LABEL or ('## Başlık yapısı: ' + KVKK_LABEL) not in lines: fail('legal_kvkk_label', p)
    body = [ln for ln in lines[end + 1:] if ln.strip()]
    if body.count(BANNER) != 1: fail('legal_banner', p)
    # SOURCE_MISSING: hukuk metni (serbest satır) yasak; yalnız başlık / avukat bloğu / '- Etiket: yer tutucu';
    # başlık ve avukat bloğu cümle olamaz (nokta ile biten veya cümle sınırı içeren satır kırmızı)
    if any(ln != BANNER and (not any(rx.match(ln) for rx in LINE_OK) or SENTENCE_RE.search(line_text(ln))) for ln in body):
        fail('legal_prose_line', p)
    if not any(ln.startswith('[[LAWYER_TEXT_REQUIRED: ') for ln in body): fail('legal_no_lawyer_block', p)

try: ci = json.loads(texts.get('controller_identity.draft.json', ''))
except ValueError: ci = {}; fail('legal_controller_parse')
if not isinstance(ci, dict): ci = {}; fail('legal_controller_parse')
COLS = {'controller_type', 'version', 'display_name', 'natural_person_fields', 'legal_entity_fields',
        'published_address_form', 'is_active', 'is_published', 'valid_from', 'valid_to'}
col = ci.get('columns') if isinstance(ci.get('columns'), dict) else {}
ok = (ci.get('status') == 'DRAFT_LEGAL_REVIEW_REQUIRED' and ci.get('source') == 'SOURCE_MISSING' and ci.get('not_a_db_row') is True
      and set(col) == COLS and col.get('controller_type') == '{{natural_person|legal_entity}}' and col.get('version') == 1
      and col.get('display_name') == '{{DISPLAY_NAME}}'
      and col.get('natural_person_fields') == {'full_name': '{{FULL_NAME}}', 'contact_channel': '{{CONTACT_CHANNEL}}'}
      and col.get('legal_entity_fields') == {'legal_name': '{{UNVAN}}', 'mersis': '{{MERSIS_16_DIGITS}}'}
      and col.get('published_address_form') == '{{ADDRESS}}'
      and col.get('is_active') is False and col.get('is_published') is False
      and col.get('valid_from') is None and col.get('valid_to') is None
      and set(ci.get('server_set_columns') or []) == {'id', 'created_by', 'created_at'})
if not ok: fail('legal_controller_mirror')

ck = texts.get('LAWYER_CHECKLIST.md', '')
nums = [int(x) for x in re.findall(r'(?m)^(\d+)\. ', ck)]
if nums != list(range(1, 13)): fail('legal_checklist_items')
if 'üyelere özel bir kapı var (ücretsiz kayıt); kodda ücretli katman yok; ücretli katman planlanırsa tüketici hukuku yükümlülüklerini teyit et' not in ck:
    fail('legal_checklist_item9')

# ------------------------------------------------------------------ C) whole package: SQL writes, greeting, raw names
KNOWN_SQL = {'CDP3D_up.sql', 'CDP3D_down_soft.sql', 'gates/cdp3d_baseline_contract.sql',
             'gates/cdp3d_ci_baseline.sql', 'gates/cdp3d_prereq_stub.sql'}      # SHA256SUMS ile sabitli migration/gate dosyaları
for p in walk(PKG):
    r = rel(p)
    if re.search(r'(^|[._-])raw([._-]|$)', os.path.basename(p), re.I): failr('raw_file_name', p)
    try: b = read(p)
    except OSError: failr('unreadable', p); continue
    s = b.decode('utf-8', 'replace')
    if greeting_bad(s): failr('pii_greeting', p)
    if r.lower().endswith('.sql') and r not in KNOWN_SQL and any(rx.search(s) for rx in TABLE_WRITE_RES):
        failr('sql_write', p)

for f in FAILS: print('GATE_FAILED:template_check:' + f)
sys.exit(1 if FAILS else 0)
PY

# Paketin kendi secret scan'i (email/ ve legal/ ağaçlarındaki her dosya)
if [ "$rc" = "0" ]; then
  files=()
  while IFS= read -r -d '' f; do files+=("$f"); done < <(find "$PKG/email" "$PKG/legal" -type f -print0)
  scan_out="$(bash "$HERE/cdp3d_secret_scan.sh" "${files[@]}" 2>&1)"; src=$?
  if [ "$src" != "0" ] || ! grep -qx 'SECRET_SCAN_CLEAN' <<< "$scan_out"; then   # here-string: pipefail altında SIGPIPE yarışı yok
    echo "GATE_FAILED:template_check:secret_scan"; rc=1
  fi
fi
if [ "$rc" = "0" ]; then echo "TEMPLATE_CHECK_PASS"; exit 0; fi
echo "TEMPLATE_CHECK_FAIL"; exit 1
