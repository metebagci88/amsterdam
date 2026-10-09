#!/usr/bin/env python3
"""CI-only: print the exact CDP-3C definitions of service_pref_set and
service_delivery_readiness_check (plus their revoke/grant lines) from
CDP3C_package/CDP3C_up.sql, byte-for-byte, so the CI database carries the
same prosrc (md5) as production. Never applied to production.
usage: python3 -I wp8_cdp3c_fns.py <repo_root>
"""
import re
import sys

root = sys.argv[1]
src = open(root + '/CDP3C_package/CDP3C_up.sql', encoding='utf-8').read()
out = []
for name in ('service_delivery_readiness_check', 'service_pref_set'):
    m = None
    for m in re.finditer(r'create or replace function public\.' + name + r'\(.*?\$fn\$.*?\$fn\$;\n', src, re.S):
        pass
    if m is None:
        sys.exit('WP8_CDP3C_EXTRACT_FAIL:' + name)
    stmt = m.group(0)
    tail = src[m.end():].split('\n')
    acl = []
    for line in tail:
        if re.match(r'(revoke|grant) .* function public\.' + name + r'\(', line):
            acl.append(line)
        else:
            break
    out.append(stmt + '\n'.join(acl) + '\n')
sys.stdout.write(''.join(out))
