#!/usr/bin/env bash
# =====================================================================
# CDP-3D · İçerik gate'i SELF-TEST (pozitif + negatif).
#  - Pozitif: değiştirilmemiş kopya -> TEMPLATE_CHECK_PASS.
#  - Negatif: her vaka kopyada TEK bir bozulma yapar -> gate KIRMIZI olmalı ve beklenen kural
#    kod(lar)ını basmalı (virgülle ayrılmış liste: hepsi aranır). Sahte e-posta/JWT/selamlama gibi
#    değerler çalışma anında parçalardan üretilir; bu dosyada düz 'Merhaba <ad>,' kalıbı yoktur.
# Gerçek dosyalara dokunmaz; yalnız mktemp altındaki kopyaları değiştirir. İçerik basmaz.
# Kullanım: bash gates/cdp3d_template_check_selftest.sh [CDP3D_package dizini]  (varsayılan: .)
# =====================================================================
set -uo pipefail
PKG="${1:-.}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/cdp3d_template_check.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

fresh(){ rm -rf "$TMP/pkg"; mkdir -p "$TMP/pkg/email" "$TMP/pkg/legal/drafts";
         cp -R "$PKG/email/templates" "$TMP/pkg/email/templates";
         cp -R "$PKG/legal/drafts/tr" "$TMP/pkg/legal/drafts/tr"; }

mutate(){ python3 -I - "$TMP/pkg" "$1" <<'PY'
import json, os, sys
P, case = sys.argv[1], sys.argv[2]
TPL = os.path.join(P, 'email', 'templates'); LEG = os.path.join(P, 'legal', 'drafts', 'tr')
H = os.path.join(TPL, 'welcome_service_email.v3.2.html'); T = os.path.join(TPL, 'welcome_service_email.v3.2.txt')
J = os.path.join(TPL, 'welcome_service_email.v3.2.json')
AT = chr(64)
FAKE_GREETING = 'Merhaba' + ' Deneme,'   # sahte ad; dosyada düz 'Merhaba <ad>,' kalıbı bulunmasın
def rd(p): return open(p, encoding='utf-8', newline='').read()
def wr(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf-8', newline='').write(s)
def wrb(p, b):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(b)
R = lambda *a: os.path.join(P, *a)
DIG16 = '0123456789' + '012345'
def meta_set(path, val):
    def f(d):
        o = d
        for k in path[:-1]: o = o[k]
        o[path[-1]] = val
    return lambda: jedit(J, f)
def meta_append(path, suffix):
    def f(d):
        o = d
        for k in path[:-1]: o = o[k]
        o[path[-1]] = o[path[-1]] + suffix
    return lambda: jedit(J, f)
def raw_like():                       # şablonun ham-benzeri kopyası: değişken yerine sahte ad, +1 satır sonu
    return rd(H).replace('{{first_name}}', 'Den' + 'eme') + '\n'
def sub(p, a, b):
    s = rd(p); assert a in s, (case, 'anchor'); wr(p, s.replace(a, b, 1))
def add(p, line): s = rd(p); wr(p, s + line + '\n')
def jedit(p, fn):
    d = json.loads(rd(p)); fn(d); wr(p, json.dumps(d, indent=2, ensure_ascii=False) + '\n')
L = lambda f: os.path.join(LEG, f)
def jwt(): return 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiJ4In0' + '.' + 'c2lnbmF0dXJlLXRlc3Q'
cases = {
 'html_byte':        lambda: add(H, '<!-- x -->'),
 'html_img':         lambda: sub(H, '</body>', '<img src="https://cdn.example.org/a.png" alt=""></body>'),
 'html_data_uri':    lambda: sub(H, '</body>', '<a href="https://asalocal.club/">data:image/png;base64,AAAA</a></body>'),
 'html_name':        lambda: sub(H, 'Merhaba {{first_name}},', FAKE_GREETING),
 'text_name':        lambda: sub(T, 'Merhaba {{first_name}},', FAKE_GREETING),
 'html_link':        lambda: sub(H, '</body>', '<a href="https://evil.example.org/">x</a></body>'),
 'html_email':       lambda: sub(H, '</body>', 'kisi' + AT + 'example.org</body>'),
 'html_crlf':        lambda: wr(H, rd(H).replace('\n', '\r\n')),
 'tpl_stray':        lambda: wr(os.path.join(TPL, 'raw_copy.html'), '<p>x</p>\n'),
 'meta_tvid':        lambda: jedit(J, lambda d: d['provenance']['row'].__setitem__('template_version_id', None)),
 'meta_s2':          lambda: jedit(J, lambda d: [t.__setitem__('needs_owner_ok', True) for t in d['provenance']['transformations'] if t['id'] == 'S2']),
 'meta_legal':       lambda: jedit(J, lambda d: d['approval'].__setitem__('legal_review', 'not required for this file by the brief')),
 'meta_sha':         lambda: jedit(J, lambda d: d['files']['html'].__setitem__('sha256', '0' * 64)),
 'meta_img':         lambda: jedit(J, lambda d: d['image_policy'].__setitem__('img_tags', 1)),
 'meta_visual':      lambda: jedit(J, lambda d: d['approval'].pop('visual_approval')),
 'meta_class':       lambda: jedit(J, lambda d: d.__setitem__('class', 'marketing')),
 'leg_status':       lambda: wr(L('cerez_politikasi.v1.draft.md'), rd(L('cerez_politikasi.v1.draft.md')).replace('DRAFT_LEGAL_REVIEW_REQUIRED', 'DRAFT')),
 'leg_source':       lambda: wr(L('README.md'), rd(L('README.md')).replace('SOURCE_MISSING', 'SOURCE')),
 'leg_mersis':       lambda: add(L('kvkk_aydinlatma.v1.draft.md'), '- MERSİS: ' + '0123456789' + '012345'),
 'leg_grouped16':    lambda: add(L('README.md'), 'Kart: 1234 5678 9012 3456'),
 'leg_phone':        lambda: add(L('LAWYER_CHECKLIST.md'), 'Telefon: +90 212 555 01 02'),
 'leg_email':        lambda: add(L('README.md'), 'İletişim: hukuk' + AT + 'example.org'),
 'leg_email_ph':     lambda: add(L('README.md'), 'İletişim: {{hukuk' + AT + 'example.org}}'),
 'leg_sql_insert':   lambda: add(L('README.md'), "insert into public.consent_text_versions(doc_type) values ('kvkk_aydinlatma');"),
 'leg_sql_pointer':  lambda: add(L('README.md'), 'update marketing_config set active_controller_version_id = null;'),
 'leg_sql_rpc':      lambda: add(L('README.md'), "select admin_w_publish_consent_text('x');"),
 'leg_prose':        lambda: add(L('kvkk_aydinlatma.v1.draft.md'), 'Kişisel verileriniz yalnız hizmet için işlenir.'),
 'leg_vocab':        lambda: add(L('gizlilik_politikasi.v1.draft.md'), '- Yeni alan: {{FOO_BAR}}'),
 'leg_fm_source':    lambda: sub(L('uyelik_sartlari.v1.draft.md'), 'source: SOURCE_MISSING', 'source: IMPORTED'),
 'leg_kvkk_label':   lambda: sub(L('kvkk_aydinlatma.v1.draft.md'), '## Başlık yapısı: ', '## Yapı: '),
 'leg_no_banner':    lambda: wr(L('acik_riza_marketing.v1.draft.md'), '\n'.join(l for l in rd(L('acik_riza_marketing.v1.draft.md')).split('\n') if not l.startswith('> '))),
 'leg_manifest_loc': lambda: jedit(L('manifest.json'), lambda d: d['documents'][0].__setitem__('locale', 'tr-TR')),
 'leg_manifest_sha': lambda: jedit(L('manifest.json'), lambda d: d['documents'][1].__setitem__('body_sha256', 'ab' * 32)),
 'leg_manifest_doc': lambda: jedit(L('manifest.json'), lambda d: d['documents'].pop()),
 'leg_ctrl_extra':   lambda: jedit(L('controller_identity.draft.json'), lambda d: d['columns']['legal_entity_fields'].__setitem__('kep', '{{KEP}}')),
 'leg_ctrl_active':  lambda: jedit(L('controller_identity.draft.json'), lambda d: d['columns'].__setitem__('is_active', True)),
 'leg_sql_file':     lambda: wr(L('seed.sql'), 'select 1;\n'),
 'leg_item9':        lambda: wr(L('LAWYER_CHECKLIST.md'), rd(L('LAWYER_CHECKLIST.md')).replace('üyelere özel bir kapı var (ücretsiz kayıt)', 'arayüzde bir ödeme duvarı var')),
 'leg_jwt':          lambda: add(L('README.md'), 'anahtar ' + jwt()),
 'leg_dir_missing':  lambda: __import__('shutil').rmtree(LEG),
 # ---- tur 1 düzeltmeleri: paket geneli selamlama, ham ad, legal/ ağacı, *.sql, meta veri, hane kuralı
 'pii_greet_gates':  lambda: wr(R('gates', 'x.html'), '<p>' + FAKE_GREETING + '</p>\n'),
 'pii_greet_email':  lambda: wr(R('email', 'notes.txt'), FAKE_GREETING + '\n'),
 'pii_greet_tagged': lambda: wr(R('gates', 'y.html'), '<p>' + 'Merhaba' + ' <b>Deneme</b>,</p>\n'),
 'pii_greet_nbsp':   lambda: wr(R('gates', 'z.html'), '<p>' + 'Merhaba' + '&nbsp;' + 'Deneme,</p>\n'),
 'raw_copy_newline': lambda: wr(R('gates', 'x.html'), raw_like()),
 'raw_copy_root':    lambda: wr(R('welcome_copy.html'), raw_like()),
 'raw_name':         lambda: wr(R('gates', 'welcome.raw.html'), '<p>x</p>\n'),
 'email_sibling':    lambda: wr(R('email', 'old', 'a.html'), '<p>x</p>\n'),
 'leg_sibling_dir':  lambda: wr(R('legal', 'drafts', 'en', 'x.md'), 'Bu bir hukuk metnidir.\nMERSIS ' + DIG16 + '\n'),
 'leg_sql_outside_tr': lambda: wr(R('legal', 'seed.sql'), "insert into public.consent_text_versions(doc_type) values ('kvkk_aydinlatma');\n"),
 'leg_source_present': lambda: wr(R('legal', 'source', 'kaynak.md'), '> DRAFT_LEGAL_REVIEW_REQUIRED\n# Kaynak\n'),
 'leg_source_binary':  lambda: wrb(R('legal', 'source', 'kaynak.docx'), b'PK\x03\x04\xff\xfe\n'),
 'leg_symlink':      lambda: os.symlink(os.path.abspath(TPL), R('legal', 'ext')),
 'sql_gates':        lambda: wr(R('gates', 'seed_controller.sql'), "insert into public.controller_identity_versions (controller_type) values ('legal_entity');\n"),
 'sql_root_update':  lambda: wr(R('x.sql'), 'update "public"."marketing_config" set marketing_enabled = true;\n'),
 'leg_prose_heading': lambda: add(L('kvkk_aydinlatma.v1.draft.md'), '## Kişisel verileriniz yalnızca hizmet amacıyla işlenir ve üçüncü kişilerle hiçbir şekilde paylaşılmaz'),
 'leg_prose_block':  lambda: add(L('kvkk_aydinlatma.v1.draft.md'), '[[LAWYER_TEXT_REQUIRED: Kişisel verileriniz yalnız hizmet için işlenir. Saklama süresi iki yıldır.]]'),
 'leg_hex16a':       lambda: add(L('README.md'), 'MERSİS: a' + DIG16),
 'leg_hex16b':       lambda: add(L('README.md'), 'Kart: ' + DIG16 + 'f'),
 'leg_10digits':     lambda: add(L('README.md'), 'VKN: ' + '1234567890'),
 'meta_email':       meta_append(['approval', 'visual_approval', 'basis'], ' (owner contact: someone' + AT + 'gmail.com)'),
 'meta_phone':       meta_append(['approval', 'visual_approval', 'basis'], ' (+90 532 111 22 33)'),
 'meta_digits16':    meta_append(['approval', 'visual_approval', 'basis'], ' ref ' + DIG16),
 'meta_hex64':       meta_set(['provenance', 'original_digests'], 'withheld; html ' + '5d' * 32),
 'meta_hex_prefix':  meta_set(['provenance', 'original_digests'], 'withheld; text prefix ' + '9c1e' + '7b3a'),
 'meta_original':    meta_set(['provenance', 'original'], {'text': {'bytes': 1}}),
 'meta_digests_gone': lambda: jedit(J, lambda d: d['provenance'].pop('original_digests')),
 'meta_timestamp':   meta_set(['provenance', 'row', 'created_at'], '2026-09-30T10:35Z'),
}
cases[case]()
PY
}

run(){ out="$(bash "$CHECK" "$TMP/pkg" 2>&1)"; rc=$?; }

# POZİTİF
fresh; run
if [ "$rc" = "0" ] && grep -qx TEMPLATE_CHECK_PASS <<< "$out"; then echo "PASS pozitif: değiştirilmemiş kopya -> PASS"; pass=$((pass+1));
else echo "FAIL pozitif: değiştirilmemiş kopya kırmızı"; grep '^GATE_FAILED' <<< "$out" | head -20; fail=$((fail+1)); fi

# NEGATİF: <vaka> <beklenen kural kod(lar)ı, virgülle (her biri bir GATE_FAILED satırının öneki olmalı)>
neg(){ fresh; if ! mutate "$1" >/dev/null 2>&1; then echo "FAIL negatif: $1 bozulma uygulanamadı"; fail=$((fail+1)); return; fi
       run
       local ok=1 code
       [ "$rc" != "0" ] || ok=0
       ! grep -qx TEMPLATE_CHECK_PASS <<< "$out" || ok=0
       IFS=',' read -r -a codes <<< "$2"
       # 'printf | grep -q' yerine here-string: pipefail altında grep -q yazanı SIGPIPE ile kesebilir (kararsız sonuç)
       for code in "${codes[@]}"; do grep -qF "GATE_FAILED:template_check:$code" <<< "$out" || ok=0; done
       if [ "$ok" = "1" ]; then echo "PASS negatif: $1 -> $2"; pass=$((pass+1))
       else echo "FAIL negatif: $1 YAKALANMADI (beklenen $2, rc=$rc)"; fail=$((fail+1)); fi; }
neg html_byte        html_sha
neg html_img         image_policy
neg html_data_uri    image_policy
neg html_name        greeting:welcome_service_email.v3.2.html
neg text_name        greeting:welcome_service_email.v3.2.txt
neg html_link        links
neg html_email       emails
neg html_crlf        cr
neg tpl_stray        template_fileset
neg meta_tvid        meta_no_template_version_id
neg meta_s2          meta_S2_applied
neg meta_legal       meta_legal_review
neg meta_sha         meta_files_html
neg meta_img         meta_image_policy
neg meta_visual      meta_visual_approval
neg meta_class       meta_class
neg leg_status       legal_status_marker:cerez_politikasi
neg leg_source       legal_source_missing_marker:README.md
neg leg_mersis       legal_digits:kvkk_aydinlatma
neg leg_grouped16    legal_digits:README.md
neg leg_phone        legal_digits:LAWYER_CHECKLIST.md
neg leg_email        legal_email:README.md
neg leg_email_ph     legal_placeholder_vocab:README.md
neg leg_sql_insert   legal_sql:README.md
neg leg_sql_pointer  legal_sql:README.md
neg leg_sql_rpc      legal_sql:README.md
neg leg_prose        legal_prose_line:kvkk_aydinlatma
neg leg_vocab        legal_placeholder_vocab:gizlilik_politikasi
neg leg_fm_source    legal_front_matter:uyelik_sartlari
neg leg_kvkk_label   legal_kvkk_label
neg leg_no_banner    legal_banner:acik_riza_marketing
neg leg_manifest_loc legal_manifest_version_locale
neg leg_manifest_sha legal_manifest_body_sha256_null
neg leg_manifest_doc legal_manifest_doc_types
neg leg_ctrl_extra   legal_controller_mirror
neg leg_ctrl_active  legal_controller_mirror
neg leg_sql_file     legal_fileset
neg leg_item9        legal_checklist_item9
neg leg_jwt          secret_like:README.md
neg leg_dir_missing  no_legal_drafts_dir
neg pii_greet_gates   pii_greeting:gates/x.html
neg pii_greet_email   pii_greeting:email/notes.txt,email_path_not_allowed:email/notes.txt
neg pii_greet_tagged  pii_greeting:gates/y.html
neg pii_greet_nbsp    pii_greeting:gates/z.html
neg raw_copy_newline  pii_greeting:gates/x.html
neg raw_copy_root     pii_greeting:welcome_copy.html
neg raw_name          raw_file_name:gates/welcome.raw.html
neg email_sibling     email_path_not_allowed:email/old/a.html
neg leg_sibling_dir   legal_path_not_allowed:legal/drafts/en/x.md,legal_status_marker:legal/drafts/en/x.md,legal_digits:legal/drafts/en/x.md
neg leg_sql_outside_tr legal_path_not_allowed:legal/seed.sql,legal_sql:legal/seed.sql,legal_status_marker:legal/seed.sql
neg leg_source_present legal_source_unexpected
neg leg_source_binary legal_source_ext:legal/source/kaynak.docx,not_utf8:legal/source/kaynak.docx,legal_source_unexpected
neg leg_symlink       symlink:legal/ext
neg sql_gates         sql_write:gates/seed_controller.sql
neg sql_root_update   sql_write:x.sql
neg leg_prose_heading legal_draft_pin:kvkk_aydinlatma
neg leg_prose_block   legal_prose_line:kvkk_aydinlatma,legal_draft_pin:kvkk_aydinlatma
neg leg_hex16a        legal_digits:README.md
neg leg_hex16b        legal_digits:README.md
neg leg_10digits      legal_digits:README.md
neg meta_email        meta_email:welcome_service_email.v3.2.json
neg meta_phone        meta_digits:welcome_service_email.v3.2.json
neg meta_digits16     meta_digits:welcome_service_email.v3.2.json
neg meta_hex64        meta_hex_allowlist
neg meta_hex_prefix   meta_hex_allowlist
neg meta_original     meta_no_original_digests
neg meta_digests_gone meta_no_original_digests
neg meta_timestamp    meta_timestamp_precision

echo ""
echo "SELFTEST pass=$pass fail=$fail"
if [ "$fail" = "0" ]; then echo "TEMPLATE_CHECK_SELFTEST_PASS"; exit 0; fi
echo "TEMPLATE_CHECK_SELFTEST_FAIL"; exit 1
