#!/usr/bin/env bash
# CDP-3C · gen_object_manifest PARSER selftest (v9-#2: GERÇEK multiline).
# Kanıtlar:
#  (a) CREATE anahtar sözcüğü ile OBJE ADI AYRI SATIRLARDA olsa bile yakalanır (satır-bazlı grep KAÇIRIRDI);
#  (b) UPPERCASE + gömülü fazladan whitespace yakalanır;
#  (c) YORUM içindeki sahte CREATE (-- ve /* */) MANIFESTE GİRMEZ (aksi drift-şişirme);
#  (d) aynı ada OVERLOAD → uniq tek ad AMA --raw dup-sayımı 2 → tutarsızlık fail-closed yakalanabilir.
# Pozitif + negatif; her adım gerçek çıkış koduyla.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; GEN="$DIR/gen_object_manifest.sh"; TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<'SQL'
-- GERÇEK multiline: anahtar sözcük bir satırda, ad SONRAKİ satırda
CREATE TABLE
public.hidden_multiline (id int);
CREATE   TABLE   IF   NOT   EXISTS
   public.spaced_tbl(x int);
CREATE
  TYPE
  public.MyType AS ENUM ('a');
CREATE OR REPLACE
FUNCTION
public.baz(a int) returns void language sql as $$ select $$;
create or replace function
public.baz(a text) returns void language sql as $$ select $$;
-- YORUM içindeki sahte CREATE — MANIFESTE GİRMEMELİ:
-- create table public.fake_line_comment(z int);
/* create type public.fake_block_comment as enum ('q');
   create table public.fake_block_comment2(w int); */
SQL

out="$(bash "$GEN" "$TMP")" || { echo "MANIFEST_SELFTEST_FAIL:gen_rc"; exit 1; }

# (a)(b) gerçek multiline / uppercase / fazladan whitespace yakalandı mı
grep -qx 'table:hidden_multiline' <<<"$out" || { echo "MANIFEST_SELFTEST_FAIL:multiline_table_name_on_next_line_missed"; echo "$out"; exit 1; }
grep -qx 'table:spaced_tbl'       <<<"$out" || { echo "MANIFEST_SELFTEST_FAIL:multiline_if_not_exists_missed"; echo "$out"; exit 1; }
grep -qx 'type:mytype'            <<<"$out" || { echo "MANIFEST_SELFTEST_FAIL:multiline_type_missed"; echo "$out"; exit 1; }
grep -qx 'func:baz'               <<<"$out" || { echo "MANIFEST_SELFTEST_FAIL:multiline_func_missed"; echo "$out"; exit 1; }

# (c) yorumdaki sahte CREATE'ler manifeste GİRMEMELİ
for fake in table:fake_line_comment type:fake_block_comment table:fake_block_comment2; do
  if grep -qx "$fake" <<<"$out"; then echo "MANIFEST_SELFTEST_FAIL:comment_create_leaked($fake)"; echo "$out"; exit 1; fi
done

# (d) overload: uniq tek 'baz' AMA --raw dup-sayımı 2 → count tutarsızlığı tespit edilebilir olmalı
nf=$(grep -c '^func:' <<<"$out")
raw="$(bash "$GEN" "$TMP" --raw)" || { echo "MANIFEST_SELFTEST_FAIL:gen_raw_rc"; exit 1; }
cf=$(printf '%s\n' "$raw" | grep -c '^func:')
[ "$nf" = 1 ] || { echo "MANIFEST_SELFTEST_FAIL:uniq_func_count(nf=$nf beklenen 1)"; exit 1; }
[ "$cf" = 2 ] || { echo "MANIFEST_SELFTEST_FAIL:raw_func_count(cf=$cf beklenen 2)"; exit 1; }
[ "$cf" != "$nf" ] || { echo "MANIFEST_SELFTEST_FAIL:overload_not_detectable(cf=$cf nf=$nf)"; exit 1; }

echo "MANIFEST_SELFTEST_PASS (gerçek multiline+uppercase yakalandı; yorum-CREATE sızmadı; overload raw/uniq tutarsızlığı tespit edilebilir)"
