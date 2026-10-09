#!/usr/bin/env python3
"""WP8 md5 parity gate (python3 -I). Re-derives the live production md5(prosrc) constants
from the repo on every run (STOP-1: comment-only drift of 6 CDP-3D functions).

- For the 6 drifted CDP-3D functions: md5(N(repo body)) == live and md5(repo body) == raw.
- For the 8 others: md5(repo body) == live (CDP-3D raw, WSE, CDP-3C).
- The migration, PRE/POST/rollback asserts and the rollback bodies carry exactly these values.
Sentinel WP8_MD5_PARITY_PASS only when pass == EXPECTED and fail == 0.
"""
import hashlib
import os
import re
import sys

ROOT = os.path.abspath(os.environ.get('WP8_ROOT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
EXPECTED = 34


def rd(p):
    return open(os.path.join(ROOT, p), encoding='utf-8').read()


def norm(b):
    return re.sub(r'[ \t]*--[^\n]*', '', re.sub(r'\n[ \t]*--[^\n]*(?=\n)', '', b))


def body(src, name):
    m = None
    for m in re.finditer(r'create\s+or\s+replace\s+function\s+public\.' + name + r'\s*\(.*?\$fn\$(.*?)\$fn\$', src, re.S | re.I):
        pass
    if m is None:
        raise SystemExit('WP8_MD5_PARITY_FAIL:body_not_found:' + name)
    return m.group(1)


md5 = lambda s: hashlib.md5(s.encode('utf-8')).hexdigest()
# name: (source file, live md5 from the 2026-10-08 PRE capture, raw repo md5 or None when identical)
TABLE = {
    '_email_can_set_delivery': ('CDP3D_package/CDP3D_up.sql', '164c0e3f3dea09585542573229d8179d', '2a017fd53d0e9d6473659449676b4d4c'),
    '_email_send_decision': ('CDP3D_package/CDP3D_up.sql', '4da18d72fb4822ba4307da5f7ff06ba2', 'cd4968cfd9609292ef01ce476583fd1f'),
    '_email_status_rank': ('CDP3D_package/CDP3D_up.sql', '444c0b885722582d4ea1278488bede3f', None),
    '_email_system_apply_suppression': ('CDP3D_package/CDP3D_up.sql', 'cbc5c3cc473ea251ae7e86a6ff7e0032', None),
    '_seed_welcome_service_pref_on_member_insert': ('WSE_DEFAULT_package/WSE_up.sql', '92e4db755ce2d41584c302073e60fdb1', None),
    'admin_q_email_delivery_status': ('CDP3D_package/CDP3D_up.sql', '49e1ae64d77f0f922b5ecef7dffd5c4c', None),
    'consent_get_my_state': ('WSE_DEFAULT_package/WSE_up.sql', '32b33d6ca355f9d89804eb74b5e2bbaf', None),
    'email_claim_batch': ('CDP3D_package/CDP3D_up.sql', '08fc00397182c86929bcb9afa6a6a995', '317199cf1aecb938c354602287b03b36'),
    'email_enqueue': ('CDP3D_package/CDP3D_up.sql', 'ba947a7c1c2f085e8b251877bb67c9a6', 'ed3c0fcd5236646e6043b79ea2eeefeb'),
    'email_ingest_provider_event': ('CDP3D_package/CDP3D_up.sql', '8688c2d9c96cbc7428fd297d8f2fedc0', 'c79386a511a0d4fe886247de20c8444d'),
    'email_mark_result': ('CDP3D_package/CDP3D_up.sql', '5d34c6af5d4934e23f6508a4a56a562c', 'e3f69dd307263b4ba5efdb50dbe65a17'),
    'email_purge_expired_content': ('CDP3D_package/CDP3D_up.sql', 'efec09f92a2d7f8fd4610b9461ecbc4c', None),
    'service_delivery_readiness_check': ('CDP3C_package/CDP3C_up.sql', '5e74aa1d695c2b573e90cc85fb2d4060', None),
    'service_pref_set': ('CDP3C_package/CDP3C_up.sql', 'f171f1ab1a2c183f861f63060a1ad5de', None),
}
passed = failed = 0


def ck(name, cond, info=''):
    global passed, failed
    if cond:
        passed += 1
        print('PASS ' + name)
    else:
        failed += 1
        print('FAIL ' + name + (' :: ' + str(info) if info else ''))


drift = 0
for name, (path, live, raw) in TABLE.items():
    b = body(rd(path), name)
    if raw is None:
        ck(f'{name}: repo body md5 == live ({path})', md5(b) == live, md5(b))
    else:
        drift += 1
        ck(f'{name}: md5(N(repo)) == live, md5(repo) == raw (comment-only drift)', md5(norm(b)) == live and md5(b) == raw, (md5(norm(b)), md5(b)))
ck('exactly 6 functions drift, all by comments only', drift == 6)

up = rd('WP8_package/db/WP8_DB_up.src.sql')
pre_guard = up[up.index('do $wp8_pre$'):up.index('$wp8_pre$;')]
for name in ('_email_send_decision', 'email_enqueue', 'email_ingest_provider_event', '_email_can_set_delivery', 'email_claim_batch', 'email_mark_result'):
    _, live, raw = TABLE[name]
    ck(f'migration PRE guard accepts live and raw md5 of {name}', live in pre_guard and raw in pre_guard)
for name in ('_seed_welcome_service_pref_on_member_insert', 'service_pref_set', 'service_delivery_readiness_check', 'email_purge_expired_content'):
    ck(f'migration PRE guard pins {name}', TABLE[name][1] in pre_guard)
post_guard = up[up.index('do $wp8_post$'):]
ck('migration POST guard pins seed/pref_set/readiness/purge', all(TABLE[n][1] in post_guard for n in ('_seed_welcome_service_pref_on_member_insert', 'service_pref_set', 'service_delivery_readiness_check', 'email_purge_expired_content')))
pre_assert = rd('WP8_package/db/WP8_DB_pre_assert.sql')
ck('PRE assert pins all 14 live md5', all(v[1] in pre_assert for v in TABLE.values()))
post_assert = rd('WP8_package/db/WP8_DB_post_assert.sql')
ck('POST assert pins decision/enqueue/ingest/can_set (live+raw) and seed/pref_set/readiness/purge',
   all(TABLE[n][1] in post_assert for n in TABLE if n not in ('email_claim_batch', 'email_mark_result', '_email_status_rank', 'admin_q_email_delivery_status', 'consent_get_my_state'))
   and all(TABLE[n][2] in post_assert for n in ('_email_send_decision', 'email_enqueue', 'email_ingest_provider_event', '_email_can_set_delivery')))
rb = rd('WP8_package/db/WP8_DB_rollback.sql')
ck('rollback restores the live (normalized) claim body', md5(body(rb, 'email_claim_batch')) == TABLE['email_claim_batch'][1])
ck('rollback restores the live (normalized) mark body', md5(body(rb, 'email_mark_result')) == TABLE['email_mark_result'][1])
ck('rollback bodies equal N(CDP3D_up.sql) byte-for-byte',
   body(rb, 'email_claim_batch') == norm(body(rd('CDP3D_package/CDP3D_up.sql'), 'email_claim_batch'))
   and body(rb, 'email_mark_result') == norm(body(rd('CDP3D_package/CDP3D_up.sql'), 'email_mark_result')))
ck('post-rollback assert expects the live claim/mark md5', TABLE['email_claim_batch'][1] in rd('WP8_package/db/WP8_DB_post_rollback_assert.sql')
   and TABLE['email_mark_result'][1] in rd('WP8_package/db/WP8_DB_post_rollback_assert.sql'))
ck('cleanup guard requires the live claim/mark md5', TABLE['email_claim_batch'][1] in rd('WP8_package/db/WP8_DB_rollback_cleanup_optional.sql'))
ck('no WP8 function body contains "--" (a comment-stripping apply path cannot change it)',
   all('--' not in m.group(1) for m in re.finditer(r'\$fn\$(.*?)\$fn\$', rd('WP8_package/db/WP8_DB_up.sql'), re.S)))

print(f'\nMD5 PARITY RESULT pass={passed} fail={failed} expected={EXPECTED}')
if failed == 0 and passed == EXPECTED:
    print('WP8_MD5_PARITY_PASS')
else:
    print('WP8_MD5_PARITY_FAIL')
    sys.exit(1)
