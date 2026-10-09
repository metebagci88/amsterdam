#!/usr/bin/env node
// WP8 build: generates WP8_package/db/WP8_DB_up.sql and WP8_package/db/WP8_MANIFEST.json
// from WP8_package/db/WP8_DB_up.src.sql and the byte-exact welcome v3.2 repo files.
// Deterministic. No network, no secrets. Node built-ins only.
//   node WP8_package/tools/wp8_build.mjs            write the outputs
//   node WP8_package/tools/wp8_build.mjs --check    exit 1 unless the committed outputs equal the build
//   --root <dir>                                    repo root (default: two levels above this file)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const check = args.includes("--check");
const ri = args.indexOf("--root");
const ROOT = ri >= 0 ? resolve(args[ri + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const P = {
  src: join(ROOT, "WP8_package/db/WP8_DB_up.src.sql"),
  out: join(ROOT, "WP8_package/db/WP8_DB_up.sql"),
  manifest: join(ROOT, "WP8_package/db/WP8_MANIFEST.json"),
  html: join(ROOT, "CDP3D_package/email/templates/welcome_service_email.v3.2.html"),
  txt: join(ROOT, "CDP3D_package/email/templates/welcome_service_email.v3.2.txt"),
  json: join(ROOT, "CDP3D_package/email/templates/welcome_service_email.v3.2.json"),
};

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const wrapHex = (buf) => (buf.toString("hex").match(/.{1,120}/g) || []).join("\n");
const die = (m) => { console.error("WP8_BUILD_FAIL:" + m); process.exit(1); };

const src = readFileSync(P.src, "utf8");
const html = readFileSync(P.html);
const txt = readFileSync(P.txt);
const meta = JSON.parse(readFileSync(P.json, "utf8"));
const subject = meta.subject;
if (typeof subject !== "string" || subject.length === 0) die("subject_missing");

// Function manifest (signature, body md5, expected service_role EXECUTE).
const grants = new Set([...src.matchAll(/^grant execute on function (public\.\w+)\(/gm)].map((m) => m[1]));
const fns = [];
for (const m of src.matchAll(/create or replace function (public\.\w+)\s*\(([^)]*)\)[\s\S]*?\bas \$fn\$([\s\S]*?)\$fn\$/g)) {
  const name = m[1];
  const types = m[2].split(",").map((a) => a.trim()).filter(Boolean).map((a) => {
    const t = a.replace(/\s+default\s+[\s\S]*$/i, "").trim().split(/\s+/);
    return (/^p(_\w+)?$/.test(t[0]) ? t.slice(1) : t).join(" ");
  });
  fns.push({ signature: `${name}(${types.join(",")})`, body_md5: md5(m[3]), service_role_execute: grants.has(name) });
}
if (fns.length < 10) die("function_parse");
const sigs = new Set(fns.map((f) => f.signature));
if (sigs.size !== fns.length) die("duplicate_function");
const tables = [...src.matchAll(/^create table if not exists (public\.\w+)/gm)].map((m) => m[1]);
const claim = fns.find((f) => f.signature === "public.email_claim_batch(int)");
const mark = fns.find((f) => f.signature === "public.email_mark_result(uuid,boolean,text,text)");
if (!claim || !mark) die("claim_or_mark_missing");

const fnValues = fns.map((f) => `    ('${f.signature}', '${f.body_md5}', ${f.service_role_execute})`).join(",\n");
const tblValues = tables.map((t) => `    ('${t}')`).join(",\n");

let out = src
  .split("@@HTML_HEX@@").join(wrapHex(html))
  .split("@@TXT_HEX@@").join(wrapHex(txt))
  .split("@@SUBJECT_HEX@@").join(Buffer.from(subject, "utf8").toString("hex"))
  .split("@@WP8_CLAIM_MD5@@").join(claim.body_md5)
  .split("@@WP8_MARK_MD5@@").join(mark.body_md5)
  .split("@@WP8_FN_MANIFEST@@").join(fnValues)
  .split("@@WP8_TABLE_MANIFEST@@").join(tblValues);
if (out.includes("@@")) die("unreplaced_placeholder");

const manifest = {
  generated_by: "WP8_package/tools/wp8_build.mjs",
  source: "WP8_package/db/WP8_DB_up.src.sql",
  output: "WP8_package/db/WP8_DB_up.sql",
  output_sha256: sha256(Buffer.from(out, "utf8")),
  template: {
    html_path: "CDP3D_package/email/templates/welcome_service_email.v3.2.html",
    html_bytes: html.length, html_sha256: sha256(html),
    text_path: "CDP3D_package/email/templates/welcome_service_email.v3.2.txt",
    text_bytes: txt.length, text_sha256: sha256(txt),
    subject_hex: Buffer.from(subject, "utf8").toString("hex"),
  },
  claim_md5: claim.body_md5,
  mark_md5: mark.body_md5,
  functions: fns,
  tables,
};
const manifestText = JSON.stringify(manifest, null, 2) + "\n";

if (check) {
  const a = existsSync(P.out) ? readFileSync(P.out, "utf8") : "";
  const b = existsSync(P.manifest) ? readFileSync(P.manifest, "utf8") : "";
  if (a !== out) die("WP8_DB_up.sql_differs_from_build");
  if (b !== manifestText) die("WP8_MANIFEST.json_differs_from_build");
  console.log(`WP8_BUILD_CHECK_OK functions=${fns.length} tables=${tables.length} claim=${claim.body_md5} mark=${mark.body_md5}`);
} else {
  writeFileSync(P.out, out);
  writeFileSync(P.manifest, manifestText);
  console.log(`WP8_BUILD_OK functions=${fns.length} tables=${tables.length} claim=${claim.body_md5} mark=${mark.body_md5} sha256=${manifest.output_sha256}`);
}
