#!/usr/bin/env node
// SEC-MEDIA · Stage 1 · PRE/MID0/MID/POST snapshot karşılaştırıcı (offline; ağ yok).
// Diffs outputs of gates/s1_snapshot.sql and asserts the Stage 1 invariants per phase.
//   --phase pre   --cur pre.json                                   (PRD §3 baseline; mismatch = STOP)
//   --phase mid0  --pre pre.json --cur mid0.json                   (negatives created nothing)
//   --phase mid   --pre pre.json --cur mid.json  --upload s1_upload_result.json   (exactly +1 object)
//   --phase post  --pre pre.json --cur post.json --upload s1_upload_result.json   (residue=0)
//   --selftest
// Exit: 0 PASS · 1 FAIL · 2 usage · 3 STOP
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE1_DIR, defaultOutDir, isMain, makeChecker, nowIso, writeJsonGuarded } from "./s1_lib.mjs";

// PRD §3 + live read-only baseline (2026-10-07). Policy definitions verbatim from pg_policies.
export const EXPECTED_BASELINE = {
  policies: [
    { cmd: "DELETE", qual: "(bucket_id = 'media'::text)", roles: ["public"], permissive: "PERMISSIVE", policyname: "media anon delete", with_check: null },
    { cmd: "INSERT", qual: null, roles: ["public"], permissive: "PERMISSIVE", policyname: "media anon insert", with_check: "(bucket_id = 'media'::text)" },
    { cmd: "SELECT", qual: "(bucket_id = 'media'::text)", roles: ["public"], permissive: "PERMISSIVE", policyname: "media anon read", with_check: null },
    { cmd: "UPDATE", qual: "(bucket_id = 'media'::text)", roles: ["public"], permissive: "PERMISSIVE", policyname: "media anon update", with_check: "(bucket_id = 'media'::text)" },
  ],
  policies_md5: "91917deced4566c09eebc1f7b79d9fd6",
  bucket_public: { media: true, "email-assets-public": true, "email-assets-draft": false },
};

export function loadSnapshot(textOrPath, isText = false) {
  let v = isText ? textOrPath : readFileSync(textOrPath, "utf8");
  for (let i = 0; i < 4; i++) {
    if (typeof v === "string") { v = v.trim(); if (!v) throw new Error("empty snapshot"); v = JSON.parse(v); continue; }
    if (Array.isArray(v)) { if (v.length !== 1) throw new Error("snapshot array must have exactly one row"); v = v[0]; continue; }
    if (v && typeof v === "object" && "s1_snapshot" in v) { v = v.s1_snapshot; continue; }
    break;
  }
  if (!v || v.schema !== "s1_snapshot.v1") throw new Error("not an s1_snapshot.v1 document");
  return v;
}

const canon = (x) => JSON.stringify(x, (k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map((kk) => [kk, val[kk]])) : val));
const bucketShape = (s) => (s.buckets || []).map((b) => ({ id: b.id, public: b.public, file_size_limit: b.file_size_limit, allowed_mime_types: b.allowed_mime_types }));
const otherBucketCounts = (s) => Object.fromEntries((s.buckets || []).filter((b) => b.id !== "media").map((b) => [b.id, b.objects]));
const stripExt = (m) => String(m || "").replace(/\.[a-z0-9]+$/i, "");

export function diffSnapshots({ phase, pre = null, cur, upload = null }) {
  const checks = [];
  const add = (id, name, ok, detail, sev = "FAIL") => checks.push({ id, name, status: ok ? "PASS" : sev, detail });
  if (phase === "pre") {
    const bp = Object.fromEntries((cur.buckets || []).map((b) => [b.id, b.public]));
    add("B1", "media bucket public=true", cur.media_bucket_public === true && bp.media === true, { media_public: cur.media_bucket_public }, "STOP");
    add("B2", "storage.objects policy'leri = PRD §3 dört anon policy (tanımlar birebir)", canon(cur.storage_objects_policies) === canon(EXPECTED_BASELINE.policies), { names: (cur.storage_objects_policies || []).map((p) => p.policyname) }, "STOP");
    add("B3", "policy digest beklenen", cur.storage_objects_policies_md5 === EXPECTED_BASELINE.policies_md5, { md5: cur.storage_objects_policies_md5 }, "STOP");
    add("B4", "email-assets-public public=true, email-assets-draft public=false", bp["email-assets-public"] === true && bp["email-assets-draft"] === false, bp, "STOP");
    add("B5", "media object sayısı 0 (değilse güncel değer raporlanır)", cur.media_objects === 0, { media_objects: cur.media_objects }, "WARN");
    add("B6", "storage.objects RLS açık", cur.storage_objects_rls_enabled === true, null, "STOP");
    add("B7", "protect_objects_delete trigger mevcut+etkin (cleanup tasarımı varsayımı)", cur.protect_objects_delete_trigger && cur.protect_objects_delete_trigger.present && cur.protect_objects_delete_trigger.enabled, cur.protect_objects_delete_trigger, "WARN");
    checks.push({ id: "B8", name: "admin_rate_events media_upload PRE değeri (kayıt)", status: "INFO", detail: { total: cur.rate_media_upload_total, last_at: cur.rate_media_upload_last_at } });
    return checks;
  }
  if (!pre) throw new Error("--pre required");
  add("D01", "captured_at ilerliyor", Date.parse(cur.captured_at) >= Date.parse(pre.captured_at), { pre: pre.captured_at, cur: cur.captured_at });
  add("D02", "storage.objects policy'leri PRE ile birebir aynı (Stage 1'de policy değişmez)", canon(cur.storage_objects_policies) === canon(pre.storage_objects_policies) && cur.storage_objects_policies_md5 === pre.storage_objects_policies_md5, { pre_md5: pre.storage_objects_policies_md5, cur_md5: cur.storage_objects_policies_md5 });
  add("D03", "bucket tanımları (public/limit/mime) PRE ile aynı", canon(bucketShape(cur)) === canon(bucketShape(pre)), null);
  add("D04", "media dışı bucket obje sayıları değişmedi", canon(otherBucketCounts(cur)) === canon(otherBucketCounts(pre)), { pre: otherBucketCounts(pre), cur: otherBucketCounts(cur) });
  add("D05", "RLS + protect_delete trigger durumu değişmedi", cur.storage_objects_rls_enabled === pre.storage_objects_rls_enabled && canon(cur.protect_objects_delete_trigger) === canon(pre.protect_objects_delete_trigger), null);
  const dObj = cur.media_objects - pre.media_objects;
  const dRate = cur.rate_media_upload_total - pre.rate_media_upload_total;
  const obj = upload && upload.object ? upload.object : null;
  const hit = obj ? (cur.media_recent || []).find((r) => r.name_sha256 === obj.path_sha256) : null;
  if (phase === "mid0") {
    add("M0-1", "negatif testler obje OLUŞTURMADI (media_objects değişmedi)", dObj === 0, { delta: dObj });
    add("M0-2", "negatif testler rate token TÜKETMEDİ (red IDX:74 öncesi)", dRate === 0, { delta: dRate });
  } else if (phase === "mid") {
    if (!obj) throw new Error("--upload required for phase mid");
    add("M1", "tam +1 media objesi", dObj === 1, { delta: dObj });
    add("M2", "tam +1 media_upload rate token (Edge yolu kullanıldı)", dRate === 1, { delta: dRate });
    add("M3", "yeni obje = acceptance çıktısındaki obje (sha256(name) eşleşir)", !!hit, { path_masked: obj.path_masked });
    add("M4", "obje image/png, boyut test görseliyle aynı, prefix venues", !!hit && hit.mimetype === "image/png" && Number(hit.size) === Number(upload.test_image && upload.test_image.bytes) && stripExt(obj.path_masked) === hit.name_masked, hit ? { mimetype: hit.mimetype, size: hit.size, name_masked: hit.name_masked } : null);
    add("M5", "obje upload anından sonra oluşturuldu", !!hit && Date.parse(hit.created_at) >= Date.parse(obj.uploaded_after), hit ? { created_at: hit.created_at } : null);
    const pv = (pre.media_objects_by_prefix || {}).venues || 0, cv = (cur.media_objects_by_prefix || {}).venues || 0;
    add("M6", "venues prefix sayacı +1, diğer prefix'ler aynı", cv - pv === 1 && canon({ ...cur.media_objects_by_prefix, venues: 0 }) === canon({ ...pre.media_objects_by_prefix, venues: 0 }), { pre: pre.media_objects_by_prefix, cur: cur.media_objects_by_prefix });
  } else if (phase === "post") {
    if (!obj) throw new Error("--upload required for phase post");
    add("P1", "residue=0: media_objects PRE değerine döndü", dObj === 0, { pre: pre.media_objects, post: cur.media_objects });
    add("P2", "test objesi artık yok (sha256(name) bulunmuyor)", !hit, { path_masked: obj.path_masked });
    add("P3", "toplam tam 1 Edge upload yapıldı (rate token +1, fazlası yok)", dRate === 1, { delta: dRate });
    add("P4", "media prefix dağılımı PRE ile aynı", canon(cur.media_objects_by_prefix) === canon(pre.media_objects_by_prefix), { pre: pre.media_objects_by_prefix, post: cur.media_objects_by_prefix });
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
  return checks;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; o[k] = v; } }
  return o;
}

async function selftest() {
  const c = makeChecker("s1_snapshot_diff selftest");
  const base = loadSnapshot(join(STAGE1_DIR, "fixtures", "s1_snapshot_readonly_2026-10-07.json"));
  c.ok(base.media_objects === 0 && base.storage_objects_policies.length === 4, "fixture loads (MCP row form)");
  c.ok(loadSnapshot(JSON.stringify(JSON.stringify({ s1_snapshot: base })), true).schema === "s1_snapshot.v1", "loader handles double-encoded JSON");
  c.ok(diffSnapshots({ phase: "pre", cur: base }).every((x) => x.status === "PASS" || x.status === "INFO"), "live baseline passes phase pre");
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const later = (s, sec) => { s.captured_at = new Date(Date.parse(base.captured_at) + sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"); return s; };
  const upload = { object: { path_masked: "venues/0f8fad5b-****.png", path_sha256: "a".repeat(64), uploaded_after: "2026-10-07T11:30:00Z" }, test_image: { bytes: 1234 } };
  const mid0 = later(clone(base), 60);
  c.ok(diffSnapshots({ phase: "mid0", pre: base, cur: mid0 }).every((x) => x.status === "PASS"), "mid0 unchanged → PASS");
  const mid = later(clone(base), 300);
  mid.media_objects = 1; mid.rate_media_upload_total = 1; mid.media_objects_by_prefix = { venues: 1 };
  mid.buckets.find((b) => b.id === "media").objects = 1;
  mid.media_recent = [{ name_masked: "venues/0f8fad5b-****", name_sha256: "a".repeat(64), created_at: "2026-10-07T11:31:00Z", size: 1234, mimetype: "image/png", cache_control: "max-age=3600" }];
  c.ok(diffSnapshots({ phase: "mid", pre: base, cur: mid, upload }).every((x) => x.status === "PASS"), "mid +1 matching object → PASS");
  const post = later(clone(base), 900); post.rate_media_upload_total = 1;
  c.ok(diffSnapshots({ phase: "post", pre: base, cur: post, upload }).every((x) => x.status === "PASS"), "post residue=0 → PASS");
  // faults
  const f1 = clone(post); f1.media_objects = 1; f1.media_recent = mid.media_recent; f1.media_objects_by_prefix = { venues: 1 };
  c.ok(diffSnapshots({ phase: "post", pre: base, cur: f1, upload }).some((x) => x.id === "P1" && x.status === "FAIL"), "post residue≠0 → FAIL");
  const f2 = clone(post); f2.storage_objects_policies = f2.storage_objects_policies.filter((p) => p.cmd !== "INSERT"); f2.storage_objects_policies_md5 = "x";
  c.ok(diffSnapshots({ phase: "post", pre: base, cur: f2, upload }).some((x) => x.id === "D02" && x.status === "FAIL"), "policy change detected → FAIL");
  const f3 = clone(mid0); f3.rate_media_upload_total = 1;
  c.ok(diffSnapshots({ phase: "mid0", pre: base, cur: f3 }).some((x) => x.id === "M0-2" && x.status === "FAIL"), "negatives consumed rate token → FAIL");
  const f4 = clone(mid); f4.media_objects = 2; f4.rate_media_upload_total = 2;
  c.ok(diffSnapshots({ phase: "mid", pre: base, cur: f4, upload }).filter((x) => x.status === "FAIL").length >= 2, "two uploads → FAIL");
  const f5 = clone(mid); f5.media_recent[0].mimetype = "text/html";
  c.ok(diffSnapshots({ phase: "mid", pre: base, cur: f5, upload }).some((x) => x.id === "M4" && x.status === "FAIL"), "wrong mimetype → FAIL");
  const f6 = clone(base); f6.buckets.find((b) => b.id === "media").public = false; f6.media_bucket_public = false;
  c.ok(diffSnapshots({ phase: "pre", cur: f6 }).some((x) => x.status === "STOP"), "baseline drift → STOP");
  const f7 = clone(post); f7.buckets.find((b) => b.id === "email-assets-draft").objects = 3;
  c.ok(diffSnapshots({ phase: "post", pre: base, cur: f7, upload }).some((x) => x.id === "D04" && x.status === "FAIL"), "other bucket write detected → FAIL");
  const r = c.done();
  return r.fail === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (a.selftest) process.exit(await selftest());
  if (!a.phase || !a.cur) { console.log("usage: --phase pre|mid0|mid|post --cur <file> [--pre <file>] [--upload <s1_upload_result.json>]"); process.exit(2); }
  let checks;
  try {
    const cur = loadSnapshot(a.cur);
    const pre = a.pre ? loadSnapshot(a.pre) : null;
    const upload = a.upload ? JSON.parse(readFileSync(a.upload, "utf8")) : null;
    checks = diffSnapshots({ phase: a.phase, pre, cur, upload });
  } catch (e) { console.log(`S1_SNAPSHOT_DIFF usage/input error: ${e.message}`); process.exit(2); }
  const stop = checks.some((x) => x.status === "STOP");
  const fail = checks.some((x) => x.status === "FAIL");
  const verdict = stop ? "STOP" : fail ? "FAIL" : "PASS";
  const out = { schema: "s1_snapshot_diff.v1", phase: a.phase, verdict, at: nowIso(), checks };
  writeJsonGuarded(join(defaultOutDir(), `s1_diff_${a.phase}.json`), out);
  console.log(`S1_SNAPSHOT_DIFF phase=${a.phase} verdict=${verdict}`);
  for (const x of checks) console.log(`  [${x.status}] ${x.id} ${x.name}${x.detail ? " :: " + JSON.stringify(x.detail) : ""}`);
  process.exit(stop ? 3 : fail ? 1 : 0);
}
