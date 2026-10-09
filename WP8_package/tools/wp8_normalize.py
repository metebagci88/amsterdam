#!/usr/bin/env python3
"""WP8 normalization N (comment-only drift emulation).

Applies N to every dollar-quoted function body of a SQL file:
  N(b) = re.sub(r'[ \\t]*--[^\\n]*', '', re.sub(r'\\n[ \\t]*--[^\\n]*(?=\\n)', '', b))
That is: whole comment lines are dropped and trailing comments are stripped.
This reproduces the live production prosrc of the CDP-3D functions, which were
applied from a comment-stripped copy. Text outside function bodies is kept.
usage: python3 -I wp8_normalize.py <in.sql>  (writes to stdout)
"""
import re
import sys


def norm_body(b: str) -> str:
    return re.sub(r'[ \t]*--[^\n]*', '', re.sub(r'\n[ \t]*--[^\n]*(?=\n)', '', b))


FN_RE = re.compile(r'(create\s+or\s+replace\s+function\s+[^$]*?\bas\s+)\$(\w*)\$(.*?)\$\2\$', re.S | re.I)


def normalize(sql: str) -> str:
    return FN_RE.sub(lambda m: m.group(1) + '$' + m.group(2) + '$' + norm_body(m.group(3)) + '$' + m.group(2) + '$', sql)


if __name__ == '__main__':
    sys.stdout.write(normalize(open(sys.argv[1], encoding='utf-8').read()))
