// ASALOCAL · CDP-3B · Save-draft backend e2e (Deno) — SD1-SD8 against the EPHEMERAL local stack ONLY.
//   cd CDP3B && deno test --allow-net --allow-env --allow-read=. gates/e2e_save_draft.ts
// Runs inside cdp3b-gates (supabase start + real email-api via `functions serve`, verify_jwt on, real Postgres with
// baseline_fixture + CDP3B_up + patch), or docker-free via gates/local_stack/run_local.sh (same file, unmodified).
// Env (ALL required, fail-closed): EMAIL_API_URL, SUPABASE_DB_URL, SUPER_JWT, CRM_JWT, ANALYST_JWT, MEMBER_JWT,
//   CRM_UID, ANALYST_UID, MEMBER_UID. Optional: SERVICE_KEY (only used to assert it never appears in a response).
// Guard: EMAIL_API_URL and SUPABASE_DB_URL must point at 127.0.0.1 / localhost / host.docker.internal, else exit 1.
// Tokens/keys are never printed; assertion messages carry only response bodies (SD8 proves those hold no secrets).
// Synthetic fixtures only (gates/fixtures/save_draft_synthetic.html + EM_SAMPLE from admin.html); no real e-mail is sent.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const NEED = ["EMAIL_API_URL", "SUPABASE_DB_URL", "SUPER_JWT", "CRM_JWT", "ANALYST_JWT", "MEMBER_JWT", "CRM_UID", "ANALYST_UID", "MEMBER_UID"];
const missing = NEED.filter((k) => !Deno.env.get(k));
if (missing.length) throw new Error("GATE_FAILED:e2e_save_draft_env_missing:" + missing.join(","));
const env = (k: string) => Deno.env.get(k) as string;
const API = env("EMAIL_API_URL"), DB_URL = env("SUPABASE_DB_URL");
const SUPER = env("SUPER_JWT"), CRM = env("CRM_JWT"), ANALYST = env("ANALYST_JWT"), MEMBER = env("MEMBER_JWT");
const CRM_UID = env("CRM_UID"), ANALYST_UID = env("ANALYST_UID"), MEMBER_UID = env("MEMBER_UID");
const SVC = Deno.env.get("SERVICE_KEY") || "";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
if (!LOCAL_HOSTS.has(hostOf(API)) || !LOCAL_HOSTS.has(hostOf(DB_URL))) throw new Error("GATE_FAILED:e2e_save_draft_non_local_host");

const ORIGIN = "https://www.asalocal.club";
const FIXTURE = await Deno.readTextFile(new URL("./fixtures/save_draft_synthetic.html", import.meta.url));
const ADMIN_HTML = await Deno.readTextFile(new URL("../admin.html", import.meta.url));
const EM_SAMPLE = (ADMIN_HTML.match(/const EM_SAMPLE='([^']*)';/) || [])[1] || "";
if (!EM_SAMPLE) throw new Error("GATE_FAILED:e2e_save_draft_em_sample_missing");
const EM_SAMPLE_MARKETING_HASH = "2aad0f7fb0667afaee863cf7e36d625833281c3669891334392e20ef79a55363"; // production oracle
const uuid = () => crypto.randomUUID();
const short = () => uuid().slice(0, 8);
async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const BODIES: string[] = [];   // every response body, for the SD8 leak check
type Resp = { status: number; body: any };
async function call(action: string, fields: Record<string, unknown>, jwt: string | null, opt: { origin?: string | null; raw?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = "Bearer " + jwt;
  const origin = opt.origin === undefined ? ORIGIN : opt.origin;
  if (origin) headers["Origin"] = origin;
  const r = await fetch(API, { method: "POST", headers, body: opt.raw ?? JSON.stringify({ action, ...fields }) });
  const text = await r.text(); BODIES.push(text);
  let body: any = null; try { body = JSON.parse(text); } catch { /* non-JSON (gateway) */ }
  return { status: r.status, body };
}
async function db<T = any>(sql: string, args: unknown[] = []): Promise<T[]> {
  const c = new Client(DB_URL); await c.connect();
  try { const r = await c.queryObject<T>(sql, args as any); return r.rows; } finally { await c.end(); }
}
const n = async (sql: string, args: unknown[] = []) => Number(((await db<{ n: number }>(sql, args))[0] || { n: -1 }).n);
const rowHash = async (vid: string) => (await db<{ h: string }>("select md5(v::text) as h from public.email_template_versions v where id=$1", [vid]))[0]?.h;
const tplHash = async (tid: string) => (await db<{ h: string }>("select md5(t::text) as h from public.email_templates t where id=$1", [tid]))[0]?.h;
const auditCount = async () => n("select count(*)::int as n from public.admin_write_log");

// exact field sets admin.html sends (E4 allowlists are derived from these)
function createFields(name: string, cls: string, idem = uuid()) {
  return { internal_name: name, description: null, email_class: cls, source_type: "html_import", idem, request_id: idem };
}
function saveFields(tid: string, cls: string, html: string, idem = uuid(), extra: Record<string, unknown> = {}) {
  return { template_id: tid, email_class: cls, source_type: "html_import", subject: "TEST konu", preview_text: "", sender_name: "", reply_to: null,
    html, builder_json: null, asset_manifest: [], idem, request_id: idem, ...extra };
}
function validateFields(cls: string, html: string) {
  return { email_class: cls, html, builder_json: null, source_type: "html_import", asset_manifest: [] };
}
async function mkDraft(cls = "transactional", jwt = CRM) {
  const name = "TEST e2e save-draft " + short();
  const c = await call("create", createFields(name, cls), jwt);
  assertEquals(c.status, 200, "create:" + JSON.stringify(c.body));
  return { name, tid: c.body.template_id as string, vid: c.body.version_id as string };
}

const S: Record<string, any> = {};

Deno.test("SD0: preflight — local hosts only, no e-mail outbox (absent or empty)", async () => {
  assert(LOCAL_HOSTS.has(hostOf(API)) && LOCAL_HOSTS.has(hostOf(DB_URL)), "local hosts");
  const reg = await db<{ r: string | null }>("select to_regclass('public.email_outbox')::text as r");
  if (reg[0].r !== null) assertEquals(await n("select count(*)::int as n from public.email_outbox"), 0, "outbox empty");
});

Deno.test("SD1: create html_import (crm) -> v1 draft shell; pointer = version id; 1 audit", async () => {
  const name = "TEST e2e save-draft " + short(); const idem = uuid();
  const c = await call("create", createFields(name, "transactional", idem), CRM);
  assertEquals(c.status, 200, "create:" + JSON.stringify(c.body));
  assertEquals(c.body.version_number, 1, "version_number 1");
  const tid = c.body.template_id, vid = c.body.version_id;
  const t = await db<any>("select * from public.email_templates where id=$1", [tid]);
  assertEquals(t.length, 1, "1 template row");
  assertEquals(t[0].status, "draft"); assertEquals(t[0].email_class, "transactional"); assertEquals(t[0].source_type, "html_import");
  assertEquals(t[0].internal_name, name);
  assertEquals(t[0].current_draft_version_id, vid, "current_draft_version_id = version.id");
  assertEquals(t[0].published_version_id, null, "not published");
  const v = await db<any>("select * from public.email_template_versions where template_id=$1", [tid]);
  assertEquals(v.length, 1, "exactly 1 version row"); assertEquals(v[0].version_number, 1); assertEquals(v[0].is_published, false);
  assertEquals(v[0].template_id, tid, "version.template_id = template.id");
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where idempotency_key=$1 and action='email_template_create'", [idem]), 1, "1 create audit");
  Object.assign(S, { tid, vid, name });
});

Deno.test("SD2: save -> same version, byte-exact source, content_hash = sha256(sanitized), draft only, no publish", async () => {
  assert(S.tid, "SD1 must have passed");
  const s = await call("save", saveFields(S.tid, "transactional", FIXTURE), CRM);
  assertEquals(s.status, 200, "save:" + JSON.stringify(s.body));
  assertEquals(s.body.version_id, S.vid, "same version_id");
  const v = (await db<any>("select * from public.email_template_versions where id=$1", [S.vid]))[0];
  assertEquals(await sha256(v.source_html), await sha256(FIXTURE), "stored source_html byte-exact (sha256)");
  assertEquals(v.content_hash, await sha256(v.sanitized_html), "content_hash = sha256(sanitized_html)");
  assertEquals(s.body.content_hash, v.content_hash, "response content_hash = stored");
  assert(!/<style/i.test(v.sanitized_html) && !/background:/i.test(v.sanitized_html) && !/opacity/i.test(v.sanitized_html), "sanitized_html lost <style>/background/opacity");
  const removed: string[] = v.validation_report.removed || [];
  for (const r of ["style", "meta", "style-prop-unlisted:background", "style-prop-unlisted:opacity", "style-prop-unlisted:overflow"]) assert(removed.includes(r), "validation_report.removed has " + r);
  assertEquals(v.validation_report.ok, true);
  assertEquals(JSON.stringify(v.variable_manifest), JSON.stringify(["first_name"]), "variable_manifest");
  assert(/sentetik/.test(v.plain_text || ""), "plain_text produced");
  assertEquals(v.is_published, false);
  const t = (await db<any>("select status, published_version_id from public.email_templates where id=$1", [S.tid]))[0];
  assertEquals(t.status, "draft"); assertEquals(t.published_version_id, null, "no automatic publish");
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where action='email_publish' and target_id=$1", [S.tid]), 0, "0 publish audits");
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where action='email_version_save' and target_id=$1", [S.vid]), 1, "1 save audit");
  // production oracle: EM_SAMPLE as marketing -> content_hash 2aad0f7f… (same as the 'Claude Design' record)
  const o = await mkDraft("marketing");
  const so = await call("save", saveFields(o.tid, "marketing", EM_SAMPLE), CRM);
  assertEquals(so.status, 200, "oracle save:" + JSON.stringify(so.body));
  assertEquals(so.body.content_hash, EM_SAMPLE_MARKETING_HASH, "EM_SAMPLE oracle hash");
});

Deno.test("SD3: reload -> get returns the v1 draft byte-exact; list row shows draft 1, unpublished", async () => {
  assert(S.tid, "SD1 must have passed");
  const g = await call("get", { template_id: S.tid }, CRM);
  assertEquals(g.status, 200, "get:" + JSON.stringify(g.body));
  assertEquals(g.body.draft.version_number, 1); assertEquals(g.body.draft.id, S.vid);
  assertEquals(await sha256(g.body.draft.source_html), await sha256(FIXTURE), "get source_html sha256");
  assertEquals(g.body.published, null); assertEquals(g.body.template.current_draft_version_id, S.vid);
  const l = await call("list", {}, CRM);
  assertEquals(l.status, 200);
  const row = (l.body.templates || []).find((x: any) => x.id === S.tid);
  assert(row, "row in list"); assertEquals(row.current_draft_version, 1); assertEquals(row.published_version, null); assertEquals(row.status, "draft");
  assertEquals(row.internal_name, S.name);
});

Deno.test("SD4: update in place (same version row, new hash, 2 audits); after publish: save blocked, row immutable, new_version -> v2", async () => {
  assert(S.tid, "SD1 must have passed");
  const before = (await db<any>("select content_hash from public.email_template_versions where id=$1", [S.vid]))[0].content_hash;
  const html2 = FIXTURE.replace("sentetik bir test", "güncellenmiş sentetik bir test");
  const s = await call("save", saveFields(S.tid, "transactional", html2), CRM);
  assertEquals(s.status, 200, "save2:" + JSON.stringify(s.body));
  assertEquals(s.body.version_id, S.vid, "same version_id");
  assertEquals(await n("select count(*)::int as n from public.email_template_versions where template_id=$1", [S.tid]), 1, "still 1 version row");
  const after = (await db<any>("select content_hash, version_number from public.email_template_versions where id=$1", [S.vid]))[0];
  assertNotEquals(after.content_hash, before, "new content_hash"); assertEquals(after.version_number, 1);
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where action='email_version_save' and target_id=$1", [S.vid]), 2, "2 save audits");
  // explicit publish (super_admin) -> the version becomes immutable
  const p = await call("publish", { template_id: S.tid, idem: uuid(), request_id: uuid() }, SUPER);
  assertEquals(p.status, 200, "publish:" + JSON.stringify(p.body));
  const s3 = await call("save", saveFields(S.tid, "transactional", FIXTURE), CRM);
  assertEquals(s3.status, 400, "save after publish:" + JSON.stringify(s3.body)); assertEquals(s3.body.error, "no_draft_version");
  let blocked = false;
  try { await db("update public.email_template_versions set subject='tamper' where id=$1", [S.vid]); } catch { blocked = true; }
  assert(blocked, "UPDATE on the published version row is blocked by the trigger");
  const nv = await call("new_version", { template_id: S.tid, idem: uuid(), request_id: uuid() }, CRM);
  assertEquals(nv.status, 200, "new_version:" + JSON.stringify(nv.body)); assertEquals(nv.body.version_number, 2);
  const t = (await db<any>("select published_version_id, current_draft_version_id from public.email_templates where id=$1", [S.tid]))[0];
  assertEquals(t.published_version_id, S.vid, "published pointer unchanged"); assertEquals(t.current_draft_version_id, nv.body.version_id, "draft pointer -> v2");
});

Deno.test("SD5: duplicates — parallel same-idem create -> 1 template; parallel same-idem save -> 1 audit; changed payload -> 409", async () => {
  const name = "TEST e2e save-draft dup " + short(); const cidem = uuid();
  const [a, b] = await Promise.all([call("create", createFields(name, "transactional", cidem), CRM), call("create", createFields(name, "transactional", cidem), CRM)]);
  assertEquals(a.status, 200, "a:" + JSON.stringify(a.body)); assertEquals(b.status, 200, "b:" + JSON.stringify(b.body));
  assertEquals(a.body.template_id, b.body.template_id, "same template_id");
  assertEquals(await n("select count(*)::int as n from public.email_templates where internal_name=$1", [name]), 1, "exactly 1 template");
  const tid = a.body.template_id, sidem = uuid();
  const [x, y] = await Promise.all([call("save", saveFields(tid, "transactional", FIXTURE, sidem), CRM), call("save", saveFields(tid, "transactional", FIXTURE, sidem), CRM)]);
  assertEquals(x.status, 200, "x:" + JSON.stringify(x.body)); assertEquals(y.status, 200, "y:" + JSON.stringify(y.body));
  assertEquals(x.body.version_id, y.body.version_id, "same result");
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where idempotency_key=$1", [sidem]), 1, "1 audit for the save idem");
  const vid = x.body.version_id; const h0 = await rowHash(vid), a0 = await auditCount();
  const z = await call("save", saveFields(tid, "transactional", FIXTURE.replace("Merhaba", "Selam"), sidem), CRM);
  assertEquals(z.status, 409, "changed payload, same idem:" + JSON.stringify(z.body)); assertEquals(z.body.error, "idempotency_conflict");
  assertEquals(await rowHash(vid), h0, "row unchanged"); assertEquals(await auditCount(), a0, "no audit");
});

Deno.test("SD6: unauthorised — member/analyst/inactive crm/no auth/foreign origin are rejected with no DB residue", async () => {
  const d = await mkDraft();
  const h0 = await rowHash(d.vid), t0 = await tplHash(d.tid);
  const memberAudits0 = await n("select count(*)::int as n from public.admin_write_log where actor_uid=$1", [MEMBER_UID]);
  const analystAudits0 = await n("select count(*)::int as n from public.admin_write_log where actor_uid=$1", [ANALYST_UID]);
  const tpl0 = await n("select count(*)::int as n from public.email_templates");
  // MEMBER (GoTrue user without admin_users row)
  let r = await call("create", createFields("TEST e2e member " + short(), "transactional"), MEMBER);
  assertEquals(r.status, 403, "member create:" + JSON.stringify(r.body)); assertEquals(r.body.error, "forbidden");
  r = await call("save", saveFields(d.tid, "transactional", FIXTURE), MEMBER);
  assertEquals(r.status, 403, "member save:" + JSON.stringify(r.body)); assertEquals(r.body.error, "forbidden");
  r = await call("get", { template_id: d.tid }, MEMBER); assertEquals(r.status, 403); assertEquals(r.body.error, "not_admin");
  r = await call("list", {}, MEMBER); assertEquals(r.status, 403); assertEquals(r.body.error, "not_admin");
  // ANALYST (admin, read-only role)
  r = await call("save", saveFields(d.tid, "transactional", FIXTURE), ANALYST);
  assertEquals(r.status, 403, "analyst save:" + JSON.stringify(r.body)); assertEquals(r.body.error, "forbidden");
  r = await call("create", createFields("TEST e2e analyst " + short(), "transactional"), ANALYST);
  assertEquals(r.status, 403, "analyst create:" + JSON.stringify(r.body)); assertEquals(r.body.error, "forbidden");
  r = await call("get", { template_id: d.tid }, ANALYST); assertEquals(r.status, 200, "analyst may read (positive control)");
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where actor_uid=$1", [ANALYST_UID]), analystAudits0, "no analyst audit");
  // INACTIVE crm: temporarily give the analyst user the crm role (positive control), then deactivate it
  await db("insert into public.admin_roles(user_id, role) values ($1, 'crm') on conflict do nothing", [ANALYST_UID]);
  try {
    const pc = await call("create", createFields("TEST e2e crm-ctrl " + short(), "transactional"), ANALYST);
    assertEquals(pc.status, 200, "active crm may create (positive control):" + JSON.stringify(pc.body));
    await db("update public.admin_users set active=false where user_id=$1", [ANALYST_UID]);
    const tplI = await n("select count(*)::int as n from public.email_templates"), audI = await auditCount();
    r = await call("create", createFields("TEST e2e inactive " + short(), "transactional"), ANALYST);
    assertEquals(r.status, 403, "inactive crm create:" + JSON.stringify(r.body)); assertEquals(r.body.error, "forbidden");
    r = await call("save", saveFields(d.tid, "transactional", FIXTURE), ANALYST);
    assertEquals(r.status, 403, "inactive crm save:" + JSON.stringify(r.body)); assertEquals(r.body.error, "forbidden");
    assertEquals(await n("select count(*)::int as n from public.email_templates"), tplI, "no template by inactive crm");
    assertEquals(await auditCount(), audI, "no audit by inactive crm");
  } finally {
    await db("update public.admin_users set active=true where user_id=$1", [ANALYST_UID]);
    await db("delete from public.admin_roles where user_id=$1 and role='crm'", [ANALYST_UID]);
  }
  // no Authorization -> 401 (gateway verify_jwt or handler)
  r = await call("save", saveFields(d.tid, "transactional", FIXTURE), null); assertEquals(r.status, 401, "no auth");
  r = await call("create", createFields("TEST e2e noauth " + short(), "transactional"), null); assertEquals(r.status, 401, "no auth create");
  // foreign Origin (valid crm JWT) -> 403 forbidden_origin, no side effect
  r = await call("save", saveFields(d.tid, "transactional", FIXTURE), CRM, { origin: "https://evil.example" });
  assertEquals(r.status, 403, "foreign origin:" + JSON.stringify(r.body)); assertEquals(r.body?.error, "forbidden_origin");
  assertEquals(await rowHash(d.vid), h0, "draft row unchanged"); assertEquals(await tplHash(d.tid), t0, "template row unchanged");
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where actor_uid=$1", [MEMBER_UID]), memberAudits0, "0 member audits");
  assertEquals(await n("select count(*)::int as n from public.email_templates where created_by=$1", [MEMBER_UID]), 0, "0 member templates");
  assertEquals(await n("select count(*)::int as n from public.email_templates"), tpl0 + 1, "only the positive-control template was added");
  assertEquals(await n("select count(*)::int as n from public.admin_write_log where actor_uid=$1", [ANALYST_UID]), analystAudits0 + 1, "only the positive-control audit by that user");
});

Deno.test("SD7: bad payload matrix -> documented status, 0 audits, draft row unchanged", async () => {
  const d = await mkDraft();
  const ok = await call("save", saveFields(d.tid, "transactional", FIXTURE), CRM);
  assertEquals(ok.status, 200, "baseline save:" + JSON.stringify(ok.body));
  const tooBigHtml = "<p>" + "a".repeat(400001 - 7) + "</p>"; assertEquals(tooBigHtml.length, 400001);
  const cases: { name: string; action?: string; fields?: Record<string, unknown>; raw?: string; status: number; error?: string | RegExp }[] = [
    { name: "class newsletter", fields: saveFields(d.tid, "newsletter", FIXTURE), status: 422, error: "bad_enum" },
    { name: "template_id 'x' (valid html)", fields: saveFields("x", "transactional", FIXTURE), status: 422, error: "bad_uuid" },
    { name: "unknown template uuid", fields: saveFields(uuid(), "transactional", FIXTURE), status: 400, error: "no_draft_version" },
    { name: "html 400,001 chars", fields: saveFields(d.tid, "transactional", tooBigHtml), status: 422, error: "bad_field:html" },
    { name: "builder_json > 800k", fields: saveFields(d.tid, "transactional", FIXTURE, uuid(), { builder_json: { x: "a".repeat(800001) } }), status: 422, error: "builder_json_too_large" },
    { name: "body > 3,000,000", raw: JSON.stringify({ action: "save", ...saveFields(d.tid, "transactional", "a".repeat(3000100)) }), status: 413 },
    { name: "missing request_id", fields: (() => { const f: any = saveFields(d.tid, "transactional", FIXTURE); delete f.request_id; return f; })(), status: 400, error: "request_id_required" },
    { name: "idem 'abc'", fields: { ...saveFields(d.tid, "transactional", FIXTURE), idem: "abc" }, status: 400, error: "idem_uuid_required" },
    { name: "marketing without {{unsubscribe_url}}", fields: saveFields(d.tid, "marketing", FIXTURE), status: 422, error: "validation_failed" },
    { name: "{{nickname}}", fields: saveFields(d.tid, "transactional", FIXTURE.replace("{{first_name}}", "{{nickname}}")), status: 422, error: "validation_failed" },
    // pinned: the Edge masks these RPC field errors as 400 internal_error (becomes 422 only if follow-up E1 is approved)
    { name: "subject 201 chars (pinned)", fields: { ...saveFields(d.tid, "transactional", FIXTURE), subject: "s".repeat(201) }, status: 400, error: "internal_error" },
    { name: "reply_to 'x' (pinned)", fields: { ...saveFields(d.tid, "transactional", FIXTURE), reply_to: "x" }, status: 400, error: "internal_error" },
    // E4 strict allowlist (code in this PR; not deployed without separate approval)
    { name: "save + unknown field", fields: { ...saveFields(d.tid, "transactional", FIXTURE), evil: 1 }, status: 422, error: "unknown_field:evil" },
    { name: "validate + unknown field", action: "validate", fields: { ...validateFields("transactional", FIXTURE), template_id: d.tid }, status: 422, error: "unknown_field:template_id" },
    { name: "create + unknown field", action: "create", fields: { ...createFields("TEST e2e e4 " + short(), "transactional"), status: "published" }, status: 422, error: "unknown_field:status" },
    { name: "unknown field name is sanitised + capped", fields: { ...saveFields(d.tid, "transactional", FIXTURE), ["<b>x</b>"]: 1, ["k".repeat(300)]: 1 }, status: 422, error: /^unknown_field:\?b\?x\?\?b\?,k{40}$/ },
  ];
  const h0 = await rowHash(d.vid), t0 = await tplHash(d.tid), a0 = await auditCount(), tpl0 = await n("select count(*)::int as n from public.email_templates");
  for (const c of cases) {
    const r = await call(c.action || "save", c.fields || {}, CRM, c.raw ? { raw: c.raw } : {});
    assertEquals(r.status, c.status, c.name + " status:" + JSON.stringify(r.body).slice(0, 300));
    if (c.error instanceof RegExp) assert(c.error.test(String(r.body?.error)), c.name + " error:" + r.body?.error);
    else if (c.error) assertEquals(r.body?.error, c.error, c.name + " error");
    if (c.error && r.body && typeof r.body.error === "string") assert(r.body.error.length <= 200, c.name + " error length capped");
    if (c.name.startsWith("marketing")) assert((r.body.validation_report?.errors || []).includes("missing_unsubscribe_url_variable"), "missing_unsubscribe_url_variable reported");
    if (c.name === "{{nickname}}") assert((r.body.validation_report?.errors || []).includes("unknown_variable:nickname"), "unknown_variable:nickname reported");
    assertEquals(await rowHash(d.vid), h0, c.name + ": draft row unchanged");
    assertEquals(await tplHash(d.tid), t0, c.name + ": template row unchanged");
    assertEquals(await auditCount(), a0, c.name + ": 0 audit rows");
    assertEquals(await n("select count(*)::int as n from public.email_templates"), tpl0, c.name + ": no new template");
  }
  // positive control for E4: exactly the admin.html key sets pass
  const v = await call("validate", validateFields("transactional", FIXTURE), CRM);
  assertEquals(v.status, 200, "validate with the admin.html key set:" + JSON.stringify(v.body).slice(0, 200)); assertEquals(v.body.ok, true);
});

Deno.test("SD8: no response body carries a token or key; outbox still absent/empty", async () => {
  assert(BODIES.length > 40, "collected response bodies");
  const secrets = [SUPER, CRM, ANALYST, MEMBER, SVC].filter((s) => s && s.length >= 8);
  for (const b of BODIES) {
    assert(!b.includes("eyJ"), "no JWT-looking string in a response body");
    for (const s of secrets) assert(!b.includes(s), "no token/key value in a response body");
  }
  const reg = await db<{ r: string | null }>("select to_regclass('public.email_outbox')::text as r");
  if (reg[0].r !== null) assertEquals(await n("select count(*)::int as n from public.email_outbox"), 0, "outbox empty");
});
