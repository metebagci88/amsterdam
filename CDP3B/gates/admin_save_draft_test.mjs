// ASALOCAL · CDP-3B · Gate 8d — "Taslak kaydet" feedback / plain errors / no demo prefill (T0, offline jsdom, ~1-2 s).
// Same harness style as admin_reopen_test.mjs: the REAL e-mail <script> block of admin.html is cut out and eval'ed;
// CAPS, $, authClient, CFG, FN_EMAIL_URL, shell, fetch and alert are stubbed; esc() and apiErrText() are the REAL first-block
// functions (cut out of admin.html, not copied). An in-memory fake email-api runs the REAL email_sanitizer.js (jsdom parser)
// and records every request. F9 (tab restore from #hash) boots the WHOLE admin.html in jsdom with a fake supabase client.
// Covers F1-F10 + critique items: removed[]/warnings[] summary, one emErrText table, null content_hash, class lock text,
// CAPS-restricted hash, E4 allowlist == what admin.html sends. Every visible text / alert is checked for leaked codes.
// Fix round 2: save/publish race (editor switched while a save is in flight) -> busy guards + snapshot of the template id,
// stored name for existing templates (name/description read-only), create-ok/save-failed shell is listed and retryable.
// Output: success -> "ADMIN_SAVE_DRAFT_OK"; any failure -> non-zero exit. No network, no secrets, synthetic fixtures only.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const html = readFileSync(join(ROOT, "admin.html"), "utf8");
const indexTs = readFileSync(join(ROOT, "edge/email-api/index.ts"), "utf8");
const sanSrc = readFileSync(join(ROOT, "edge/email-api/email_sanitizer.js"), "utf8");
const upSql = readFileSync(join(ROOT, "CDP3B_up.sql"), "utf8");
const FIXTURE = readFileSync(join(HERE, "fixtures/save_draft_synthetic.html"), "utf8");
const redirects = readFileSync(join(ROOT, "..", "_redirects"), "utf8");
const require = createRequire(import.meta.url);
const Sanitizer = require(join(ROOT, "edge/email-api/email_sanitizer.js"));
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ---- real code slices ----
const start = html.indexOf("async function emailApi(action, fields){");
assert.ok(start > 0, "emailApi bloğu bulunamadı");
const end = html.indexOf("</script>", start);
const emailBlock = html.slice(start, end);
const escSrc = (html.match(/^const esc=.*$/m) || [])[0];
assert.ok(escSrc, "esc() bulunamadı");
const aeStart = html.indexOf("function apiErrText(status){");
const apiErrSrc = html.slice(aeStart, html.indexOf("\n}\n", aeStart) + 2);
assert.ok(aeStart > 0 && apiErrSrc.includes("Beklenmeyen hata"), "apiErrText() bulunamadı");
const EM_SAMPLE = (html.match(/const EM_SAMPLE='([^']*)';/) || [])[1];
const ALLOWED_VARS = ["first_name", "city_name", "trip_start_date", "trip_end_date", "days_until_trip", "unsubscribe_url"];

// ---- every internal code we can find in the real sources (for the leak check) ----
const CODES = new Set(["no_session", "network", "unknown_field", "super_admin"]);
for (const m of indexTs.matchAll(/HttpErr\(\d+,\s*"([a-z_]+)/g)) CODES.add(m[1]);
for (const m of indexTs.matchAll(/error:\s*"([a-z_]+)"/g)) CODES.add(m[1]);
for (const m of (indexTs.match(/const known = \[([\s\S]*?)\];/) || ["", ""])[1].matchAll(/"([a-z_]+)"/g)) CODES.add(m[1]);
for (const m of sanSrc.matchAll(/(?:errors|warnings|removed)\.push\('([a-z_-]+)/g)) CODES.add(m[1]);
for (const m of upSql.matchAll(/raise exception '([a-z_]+)'/g)) CODES.add(m[1]);
const LEAK_RE = /validation_failed|internal_error|bad_|P0001|supabase|postgres|\brpc\b|admin_w_|admin_q_|stack|Error:|TypeError|undefined|\[object|style-prop-unlisted|style-decl-denied|img-data-nonimage|img-bad-proto|bad-proto|\battr:/i;
function leakCheck(text, where) {
  let t = String(text);
  for (const v of ALLOWED_VARS) t = t.split(v).join("");          // template variables are user-facing by design
  const snake = t.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g);
  assert.equal(snake, null, where + ": snake_case code leaked: " + JSON.stringify(snake));
  assert.ok(!LEAK_RE.test(t), where + ": internal text leaked: " + (t.match(LEAK_RE) || [])[0]);
  for (const c of CODES) if (/[_:-]/.test(c)) assert.ok(!t.includes(c), where + ": code leaked: " + c);
}

// ---- fake email-api (real sanitizer) ----
function makeServer() {
  const S = { reqs: [], tpl: new Map(), idem: new Map(), override: {}, gate: null, nextHash: true };
  const parser = new (new JSDOM("").window.DOMParser)();
  const parseHTML = (h) => parser.parseFromString("<!doctype html><html><body>" + h + "</body></html>", "text/html");
  const run = (h, cls) => Sanitizer.process(h, { emailClass: cls, allowedVars: ALLOWED_VARS, remoteImageAllowlist: ["cdn.asalocal.club"], parseHTML });
  S.respond = (a, f) => {
    if (S.override[a]) { const o = S.override[a]; const r = typeof o === "function" ? o(f) : o; if (r) return r; }
    if (a === "list") return { status: 200, body: { ok: true, templates: [...S.tpl.values()].map((t) => ({ id: t.id, internal_name: t.name, email_class: t.cls, source_type: t.src, status: t.status, current_draft_version: t.draft ? 1 : null, published_version: null })) } };
    if (a === "get") { const t = S.tpl.get(f.template_id); if (!t) return { status: 400, body: { ok: false, error: "not_found" } };
      return { status: 200, body: { ok: true, template: { internal_name: t.name, status: t.status, source_type: t.src, email_class: t.cls, description: null }, draft: t.draft, published: null } }; }
    if (a === "validate") { const rep = run(f.html, f.email_class); return { status: 200, body: { ok: rep.ok, validation_report: rep, content_hash: sha256(rep.sanitized_html || ""), preview_html: "" } }; }
    if (a === "create") { if (S.idem.has(f.idem)) return { status: 200, body: S.idem.get(f.idem) };
      const id = "t" + (S.tpl.size + 1) + "-0000-4000-8000-000000000000"; S.tpl.set(id, { id, name: f.internal_name, cls: f.email_class, src: f.source_type, status: "draft", draft: null });
      const out = { ok: true, template_id: id, version_id: "v-" + id, version_number: 1 }; S.idem.set(f.idem, out); return { status: 200, body: out }; }
    if (a === "save") { const rep = run(f.html, f.email_class); if (!rep.ok) return { status: 422, body: { ok: false, error: "validation_failed", validation_report: rep } };
      const t = S.tpl.get(f.template_id); if (!t) return { status: 400, body: { ok: false, error: "no_draft_version" } };
      t.draft = { version_number: 1, subject: f.subject, preview_text: f.preview_text, sender_name: f.sender_name, reply_to: f.reply_to, source_html: f.html, sanitized_html: rep.sanitized_html, asset_manifest: f.asset_manifest };
      const body = { ok: true, version_id: "v-" + t.id }; if (S.nextHash) body.content_hash = sha256(rep.sanitized_html); return { status: 200, body }; }
    if (a === "asset_preview") return { status: 200, body: { ok: true, previews: [], unavailable_asset_ids: [] } };
    return { status: 400, body: { ok: false, error: "unhandled_" + a } };
  };
  return S;
}

// ---- one isolated page per scenario ----
function page(opts = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div></body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom; const { document } = window;
  const S = makeServer(); const alerts = [];
  window.alert = (m) => alerts.push(String(m));
  window.CFG = { url: "https://local.test", key: "anon-test" };
  window.FN_EMAIL_URL = "https://local.test/functions/v1/email-api";
  window.CAPS = Object.assign({ crm: true, superadmin: true }, opts.caps || {});
  window.authClient = { auth: { getSession: async () => ({ data: { session: { access_token: "local-fake-token" } } }) } };
  window.$ = (id) => document.getElementById(id);
  window.shell = (h) => { document.getElementById("app").innerHTML = h; };
  window.fetch = async (_url, o) => {
    const b = JSON.parse(o.body); S.reqs.push(b);
    if (S.gate) await S.gate(b.action);
    if (S.override["__network__" + b.action]) throw new Error("offline");
    const r = S.respond(b.action, b);
    return { status: r.status, json: async () => { if (r.raw) throw new SyntaxError("not json"); return r.body; } };
  };
  window.eval(escSrc + "\n" + apiErrSrc + "\nwindow.esc=esc; window.apiErrText=apiErrText;");
  window.eval(emailBlock + "\n;" + ["emSave", "emPublish", "emValidate", "emOpen", "emNewImport", "emNewVisual", "emHostImages", "emAssetUpload",
    "emNewVersion", "emDuplicate", "emArchive", "renderEmail", "emRefreshList", "emErrText"].map((f) => "window." + f + "=" + f).join(";")
    + ";window.__EM_SAMPLE=EM_SAMPLE;window.__busy=function(){return _emBusy;};window.__curId=function(){return _emCurId;};window.__setLoadGrapes=function(f){loadGrapes=f;};"
    + "window.__setBusy=function(v){_emBusy=v;};");
  const $ = (id) => document.getElementById(id);
  const txt = (id) => ($(id) ? $(id).textContent : "");
  const visible = () => ["emStatus", "emReport", "emList", "emListStatus"].map(txt).join("\n") + "\n" + alerts.join("\n");
  const set = (vals) => { for (const [k, v] of Object.entries(vals)) $(k).value = v; };
  const actions = (from = 0) => S.reqs.slice(from).map((r) => r.action);
  return { window, document, S, alerts, $, txt, visible, set, actions };
}
async function importPage(opts) { const P = page(opts); await P.window.renderEmail(); P.S.reqs.length = 0; P.window.emNewImport(); return P; }
const results = [];
async function scenario(name, fn) { await fn(); results.push(name); console.log("PASS " + name); }

const LOCKED_TXT = 'Bu şablonun sınıfı değiştirilemez; doğru sınıfla "+ HTML içe aktar" ile yeni şablon oluştur.';
const UNSUB_TXT = "Marketing e-postasında abonelikten çıkış bağlantısı ({{unsubscribe_url}}) yok.";
const strictKeys = (() => {
  const m = indexTs.match(/const EMAIL_STRICT_KEYS[^=]*=\s*\{([\s\S]*?)\n\};/); assert.ok(m, "EMAIL_STRICT_KEYS (E4) index.ts'te yok");
  const out = {}; for (const a of ["create", "save", "validate"]) { const r = m[1].match(new RegExp(a + ":\\s*\\[([^\\]]*)\\]")); assert.ok(r, "E4 list " + a); out[a] = [...r[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort(); }
  return out;
})();

// ===================== scenarios =====================
await scenario("static: renderEmail kept, no consent write strings, EM_SAMPLE byte-identical, prototype path 302", async () => {
  assert.ok(/function renderEmail\(/.test(html));
  assert.ok(!/consent_set|service_pref_set/.test(html));
  assert.equal(sha256(EM_SAMPLE), "b5f5dfc66d8a34e9f699eb7623b18c9fc2ae0d1434f8af51d0f2b18df91165f7", "EM_SAMPLE constant unchanged");
  const lines = redirects.split("\n").map((l) => l.trim());
  for (const l of ["/CDP3B/admin_email_module.html  /  302", "/CDP3B/admin_email_module  /  302", "/admin  /CDP3B/admin.html  302", "/vendor/grapesjs/*  /CDP3B/vendor/grapesjs/:splat  200"]) assert.ok(lines.includes(l), "_redirects: " + l);
  assert.ok(!/console\.(log|error|warn)\(/.test(emailBlock), "no console logging in the e-mail block");
});

await scenario("F3/F4/F5 markup: import editor starts EMPTY (no 'Claude Design'/EM_SAMPLE), class unselected, hint, maxlength, #emStatus above #emReport", async () => {
  const P = await importPage();
  const { $ } = P;
  assert.equal($("em_name").value, ""); assert.equal($("em_subject").value, ""); assert.equal($("em_src").value, "");
  assert.equal($("em_name").placeholder, "Şablon adı (iç)"); assert.equal($("em_subject").placeholder, "Konu satırı"); assert.equal($("em_src").placeholder, "Claude Design HTML yapıştır");
  assert.equal($("em_class").value, "", "class not preselected");
  const o0 = $("em_class").options[0]; assert.equal(o0.value, ""); assert.ok(o0.disabled && o0.selected); assert.equal(o0.textContent, "Sınıf seç…");
  assert.ok($("emEditor").textContent.includes("Marketing seçilirse abonelikten çıkış bağlantısı ({{unsubscribe_url}}) zorunludur."));
  for (const [id, n] of [["em_name", 120], ["em_desc", 500], ["em_subject", 200], ["em_preview", 200], ["em_sender", 100], ["em_reply", 200]]) assert.equal($(id).maxLength, n, id + " maxlength");
  const st = $("emStatus"); assert.ok(st); assert.equal(st.getAttribute("role"), "status"); assert.equal(st.getAttribute("aria-live"), "polite");
  assert.equal(st.nextElementSibling, $("emReport"), "#emStatus directly above #emReport");
  assert.equal(P.window.__EM_SAMPLE, EM_SAMPLE);
  // visual editor: no 'Yaz Kampanyası'/'Amsterdam' prefill; editor-load failure is a plain sentence
  const V = page(); await V.window.renderEmail(); V.window.__setLoadGrapes(() => Promise.reject(new Error("blocked")));
  await V.window.emNewVisual();
  assert.equal(V.$("em_name").value, ""); assert.equal(V.$("em_subject").value, ""); assert.equal(V.$("em_class").value, "");
  assert.equal(V.$("emStatus").nextElementSibling, V.$("emReport"));
  assert.ok(V.txt("emStatus").includes("Görsel editör yüklenemedi; sayfayı yenileyip tekrar dene.")); leakCheck(V.visible(), "visual load fail");
});

await scenario("F4: no class -> emSave/emValidate/emHostImages refuse with the plain sentence and send NO request", async () => {
  const P = await importPage(); P.set({ em_name: "TEST sınıfsız", em_src: FIXTURE });
  assert.equal(await P.window.emSave(), false);
  assert.ok(P.txt("emStatus").includes("E-posta sınıfını seç (Marketing / Transactional)."));
  assert.equal(await P.window.emValidate(), null); assert.ok(P.txt("emStatus").includes("E-posta sınıfını seç"));
  await P.window.emHostImages(); assert.ok(P.txt("emStatus").includes("E-posta sınıfını seç"));
  assert.deepEqual(P.actions(), [], "0 requests"); leakCheck(P.visible(), "no class"); assert.equal(P.alerts.length, 0);
});

await scenario("F5: client limits mirror the server (no request, plain message); code-point semantics for subject", async () => {
  const cases = [
    [{ em_name: "   " }, "Şablon adı gerekli."],
    [{ em_name: "a".repeat(121) }, "Şablon adı en fazla 120 karakter olabilir."],
    [{ em_desc: "d".repeat(501) }, "Açıklama en fazla 500 karakter olabilir."],
    [{ em_subject: "s".repeat(201) }, "Konu satırı en fazla 200 karakter olabilir."],
    [{ em_preview: "p".repeat(201) }, "Önizleme metni en fazla 200 karakter olabilir."],
    [{ em_sender: "g".repeat(101) }, "Gönderen adı en fazla 100 karakter olabilir."],
    [{ em_reply: "x" }, "Reply-to boş bırakılmalı ya da geçerli bir e-posta adresi olmalı (en fazla 200 karakter)."],
    [{ em_reply: "a@b" }, "Reply-to boş bırakılmalı"],
    [{ em_reply: "x".repeat(196) + "@b.co" }, "Reply-to boş bırakılmalı"],
    [{ em_src: "   \n " }, "HTML içeriği boş."],
    [{ em_src: "<p>" + "a".repeat(400001) + "</p>" }, "HTML çok büyük (en fazla 400.000 karakter)."],
  ];
  for (const [vals, msg] of cases) {
    const P = await importPage(); P.set(Object.assign({ em_name: "TEST sınır", em_class: "transactional", em_src: FIXTURE }, vals));
    assert.equal(await P.window.emSave(), false, JSON.stringify(Object.keys(vals)));
    assert.ok(P.txt("emStatus").includes(msg), "message for " + Object.keys(vals) + ": " + P.txt("emStatus"));
    assert.deepEqual(P.actions(), [], "0 requests for " + Object.keys(vals)); leakCheck(P.visible(), "F5 " + Object.keys(vals));
  }
  // 200 astral characters = 200 PG characters (UTF-16 length 400) -> allowed; valid reply_to -> allowed
  const P = await importPage(); P.set({ em_name: "TEST emoji", em_class: "transactional", em_src: FIXTURE, em_subject: "😀".repeat(200), em_reply: "destek@example.com" });
  assert.equal(await P.window.emSave(), true); assert.deepEqual(P.actions(), ["validate", "create", "save", "list"]);
});

await scenario("F3 guard: HTML still equal to EM_SAMPLE (import) -> plain message, NO request", async () => {
  for (const src of [EM_SAMPLE, "  " + EM_SAMPLE + "\n"]) {
    const P = await importPage(); P.set({ em_name: "TEST örnek", em_class: "marketing", em_src: src });
    assert.equal(await P.window.emSave(), false);
    assert.ok(P.txt("emStatus").includes("Bu, editörün örnek içeriği. Kaydetmek için kendi HTML'ini yapıştır."));
    assert.deepEqual(P.actions(), []); leakCheck(P.visible(), "EM_SAMPLE guard");
  }
});

await scenario("F6: marketing fixture without {{unsubscribe_url}} -> validate only, NO create (no empty shell), plain unsubscribe sentence", async () => {
  const P = await importPage(); P.set({ em_name: "TEST pazarlama", em_class: "marketing", em_src: FIXTURE });
  assert.equal(await P.window.emSave(), false);
  assert.deepEqual(P.actions(), ["validate"], "validate-before-create");
  assert.equal(P.S.tpl.size, 0, "no template shell");
  const st = P.txt("emStatus");
  assert.ok(st.includes("Kaydedilmedi: içerik doğrulamadan geçmedi."));
  assert.ok(st.includes(UNSUB_TXT + " Bu bir hizmet e-postasıysa sınıfı kontrol et."), st);
  assert.ok(P.txt("emReport").includes("ENGELLENDİ") && P.txt("emReport").includes(UNSUB_TXT));
  assert.ok(P.txt("emReport").includes("Marketing e-postasında abonelik/yasal alt bilgi metni bulunamadı."), "warning as sentence");
  assert.ok(!P.$("em_class").disabled, "class still selectable (nothing created)");
  leakCheck(P.visible(), "F6"); assert.equal(P.alerts.length, 0);
});

await scenario("F1/F2/F10 + sanitizer summary: success -> status line, no alert, report+preview kept, list refreshed, editor stays open, class locked, payload keys == E4 allowlists", async () => {
  const P = await importPage(); const name = "TEST <b>kayıt</b> & sınama";
  P.set({ em_name: name, em_class: "transactional", em_src: FIXTURE, em_subject: "Konu", em_reply: "" });
  assert.equal(await P.window.emSave(), true);
  assert.deepEqual(P.actions(), ["validate", "create", "save", "list"], "1 validate, 1 create, 1 save, list refresh; no asset_preview (F10), no publish");
  assert.equal(P.alerts.length, 0, "no alert on success");
  const st = P.txt("emStatus");
  assert.ok(st.includes("Taslak kaydedildi: «" + name + "» · taslak (yayınlanmadı) · e-posta gönderilmedi · "), st);
  assert.match(st, /· \d\d:\d\d/); assert.match(P.$("emStatus").querySelector(".notice > span.muted").textContent, /^içerik özeti [0-9a-f]{8}$/);
  assert.ok(!P.$("emStatus").innerHTML.includes("<b>kayıt</b>"), "name escaped");
  for (const s of ["<style> bloğu (mobil kurallar dahil) kaldırıldı", "meta etiketleri kaldırıldı", "background/opacity/overflow stilleri kaldırıldı"]) {
    assert.ok(st.includes(s), "status summary: " + s); assert.ok(P.txt("emReport").includes(s), "report summary: " + s);
  }
  assert.ok(P.txt("emReport").includes("GEÇTİ") && P.$("emReport").querySelectorAll("iframe").length === 2, "report + preview kept");
  assert.ok(P.$("em_src") && P.$("em_src").value === FIXTURE, "editor still open with the content");
  const list = P.txt("emList"); assert.ok(list.includes(name) && list.includes("Transactional") && list.includes("HTML içe aktarma") && list.includes("Taslak"), list);
  assert.ok(P.$("em_class").disabled, "class locked after create"); assert.equal(P.$("em_class").title, "Sınıf, şablon oluşturulduktan sonra değiştirilemez.");
  for (const a of ["create", "save", "validate"]) assert.deepEqual(Object.keys(P.S.reqs.find((r) => r.action === a)).sort(), strictKeys[a], a + " payload keys == E4 allowlist");
  leakCheck(P.visible(), "F1 success");
  // second save of the same (now existing) template: validate + save only, same template id
  const id = P.window.__curId(); P.set({ em_src: FIXTURE.replace("Merhaba", "Selam") });
  const n0 = P.S.reqs.length; assert.equal(await P.window.emSave(), true);
  assert.deepEqual(P.actions(n0), ["validate", "save", "list"]); assert.equal(P.window.__curId(), id); assert.equal(P.S.tpl.size, 1);
});

await scenario("F1: content_hash absent in the save response -> no hash fragment, still true; F2: list 400 tolerated", async () => {
  const P = await importPage(); P.S.nextHash = false; P.S.override.list = { status: 400, body: { error: "unhandled_list" } };
  P.set({ em_name: "TEST özet yok", em_class: "transactional", em_src: FIXTURE });
  assert.equal(await P.window.emSave(), true);
  assert.ok(P.txt("emStatus").includes("Taslak kaydedildi: «TEST özet yok»")); assert.ok(!P.txt("emStatus").includes("içerik özeti"));
  assert.ok(P.txt("emList").includes("Liste yüklenemedi (hata 400). Biraz sonra tekrar dene."), P.txt("emList"));
  assert.equal(P.alerts.length, 0); leakCheck(P.visible(), "null hash");
});

await scenario("F8: in-flight guard — second call returns false, buttons disabled while saving, one validate/create/save", async () => {
  const P = await importPage(); P.set({ em_name: "TEST çift tık", em_class: "transactional", em_src: FIXTURE });
  let release; const held = new Promise((r) => { release = r; });
  P.S.gate = async (a) => { if (a === "create") await held; };
  const p1 = P.window.emSave(); const p2 = P.window.emSave();
  assert.equal(await p2, false, "second click ignored");
  await new Promise((r) => setTimeout(r, 20));
  const btns = [...P.$("emEditor").querySelectorAll("button")].filter((b) => /^(emSave|emPublish|emValidate)\b/.test(b.getAttribute("onclick") || ""));
  assert.ok(btns.length >= 3 && btns.every((b) => b.disabled), "save/publish/validate buttons disabled in flight");
  assert.ok(P.txt("emStatus").includes("Kaydediliyor…")); assert.equal(P.window.__busy(), true);
  assert.equal(await P.window.emPublish(), undefined); assert.equal(P.S.reqs.filter((r) => r.action === "publish").length, 0, "publish blocked while busy");
  release(); assert.equal(await p1, true);
  assert.ok(btns.every((b) => !b.disabled), "re-enabled"); assert.equal(P.window.__busy(), false);
  assert.deepEqual(P.actions().filter((a) => a !== "list"), ["validate", "create", "save"]); assert.equal(P.S.tpl.size, 1);
});

await scenario("F7: every create/save/publish/validate error renders ONE plain sentence (no codes, no raw body.error)", async () => {
  const E = (status, error, extra = {}) => ({ status, body: Object.assign({ ok: false, error }, extra) });
  const v422 = (errors) => E(422, "validation_failed", { validation_report: { ok: false, errors, warnings: [], removed: [] } });
  const cases = [
    ["create", E(403, "forbidden"), "Bu veriye erişim yetkiniz yok."],
    ["create", E(401, "not_authenticated"), "Oturum gerekli — yönetici olarak tekrar giriş yap."],
    ["create", "__network__", "Ağ hatası — bağlantını kontrol et."],
    ["create", E(400, "admin_writes_disabled"), "Yönetim yazma işlemleri şu an kapalı."],
    ["create", E(422, "bad_enum"), "E-posta sınıfı geçersiz; listeden seç."],
    ["create", E(422, "bad_field:internal_name"), "Şablon adı en fazla 120 karakter olabilir."],
    ["create", E(422, "unknown_field:evil"), "İstek beklenmeyen bir alan içeriyor; sayfayı yenileyip tekrar dene."],
    ["create", E(400, "request_id_required"), "İstek eksik veya geçersiz oluşturuldu; sayfayı yenileyip tekrar dene."],
    ["create", E(403, "forbidden_origin"), "Bu işlem yalnız asalocal.club yönetim panelinden yapılabilir."],
    ["save", v422(["missing_unsubscribe_url_variable"]), "Kaydedilmedi: içerik doğrulamadan geçmedi."],
    ["save", v422(["unknown_variable:nickname,takma"]), "Tanınmayan değişken: nickname, takma. İzinli: first_name, city_name, trip_start_date, trip_end_date, days_until_trip, unsubscribe_url."],
    ["save", v422(["empty_html"]), "HTML içeriği boş."],
    ["save", v422(["no_parser"]), "İçerik kuralı ihlali."],
    ["save", E(422, "bad_field:html"), "HTML çok büyük (en fazla 400.000 karakter)."],
    ["save", E(422, "builder_json_too_large"), "Görsel editör içeriği çok büyük."],
    ["save", E(422, "bad_uuid"), "Şablon bulunamadı; sayfayı yenileyip yeniden aç."],
    ["save", E(413, "payload_too_large"), "İçerik çok büyük."],
    ["save", { status: 413, raw: true, body: null }, "İçerik çok büyük."],
    ["save", E(409, "draft_asset_url_in_content"), 'İçerikte izin verilmeyen görsel bağlantısı var; "Görselleri barındır" ile yeniden dene.'],
    ["save", E(409, "unmanaged_asset_url"), 'İçerikte izin verilmeyen görsel bağlantısı var; "Görselleri barındır" ile yeniden dene.'],
    ["save", E(409, "idempotency_conflict"), "İşlem çakışması — sayfayı yenileyip tekrar deneyin."],
    ["save", E(400, "no_draft_version"), 'Bu şablonun düzenlenebilir taslağı yok; "Yeni sürüm oluştur" kullan.'],
    ["save", E(400, "internal_error"), "Kaydedilemedi (hata 400). Alanları kontrol edip tekrar dene."],
    ["save", E(500, "admin_w_email_version_save: P0001 supabase stack TypeError"), "Kaydedilemedi (hata 500). Alanları kontrol edip tekrar dene."],
    ["save", E(400, "constructor"), "Kaydedilemedi (hata 400). Alanları kontrol edip tekrar dene."],
    ["save", E(429, "rate_limited"), "Çok fazla istek — kısa süre bekleyip tekrar dene."],
    ["save", E(503, "x"), "Admin servisi geçici olarak kapalı."],
    ["validate", E(422, "bad_enum"), "E-posta sınıfı geçersiz; listeden seç."],
    ["validate", E(409, "unmanaged_asset_url"), "İçerikte izin verilmeyen görsel bağlantısı var"],
  ];
  for (const [action, resp, expect] of cases) {
    const P = await importPage(); P.set({ em_name: "TEST hata", em_class: "transactional", em_src: FIXTURE });
    if (resp === "__network__") P.S.override["__network__" + action] = true; else P.S.override[action] = resp;
    assert.equal(await P.window.emSave(), false, action + " " + JSON.stringify(resp));
    const st = P.txt("emStatus"); assert.ok(st.includes(expect), action + " " + JSON.stringify(resp).slice(0, 80) + " -> " + st);
    assert.ok(P.$("emStatus").querySelector(".notice.err"), "rendered as notice err");
    if (resp && resp.body && resp.body.error) assert.ok(!P.visible().includes(resp.body.error), "raw body.error not shown: " + resp.body.error);
    if (action === "validate") assert.equal(P.S.reqs.filter((r) => r.action === "create").length, 0, "no create after validate failure");
    leakCheck(P.visible(), "F7 " + action + " " + JSON.stringify(resp).slice(0, 60)); assert.equal(P.alerts.length, 0);
  }
  // the "Doğrula" button path (emValidate) — incl. the automatic validate inside emOpen — uses the same table
  for (const [resp, expect] of [[E(422, "bad_enum"), "E-posta sınıfı geçersiz; listeden seç."], [E(409, "draft_asset_url_in_content"), "İçerikte izin verilmeyen görsel bağlantısı var"],
    [E(400, "internal_error"), "Doğrulanamadı (hata 400). Biraz sonra tekrar dene."], [E(401, "no_session"), "Oturum gerekli"]]) {
    const P = await importPage(); P.set({ em_class: "transactional", em_src: FIXTURE }); P.S.override.validate = resp;
    assert.equal(await P.window.emValidate(), null);
    assert.ok(P.txt("emStatus").includes(expect), "emValidate " + resp.body.error + " -> " + P.txt("emStatus"));
    assert.equal(P.txt("emReport"), "", "no stale report"); assert.ok(!P.visible().includes(resp.body.error));
    leakCheck(P.visible(), "emValidate " + resp.body.error);
  }
  // publish: missing_unsubscribe + generic; superadmin role text
  const P = await importPage(); P.set({ em_name: "TEST yayın", em_class: "transactional", em_src: FIXTURE });
  P.S.override.publish = E(400, "missing_unsubscribe"); await P.window.emPublish();
  assert.ok(P.txt("emStatus").includes("Yayınlanamaz: marketing şablonunda abonelikten çıkış bağlantısı yok.")); leakCheck(P.visible(), "publish");
  P.S.override.publish = E(400, "validation_not_ok"); await P.window.emPublish();
  assert.ok(P.txt("emStatus").includes("Yayınlanamaz: kaydedilen içerik doğrulamadan geçmemiş")); leakCheck(P.visible(), "publish2");
  const Q = await importPage({ caps: { superadmin: false } }); await Q.window.emPublish();
  assert.ok(Q.txt("emStatus").includes("Yayınlama yalnız süper yönetici yetkisiyle yapılabilir.")); assert.deepEqual(Q.actions(), []); leakCheck(Q.visible(), "publish role");
});

await scenario("U5 (T0): CAPS.crm=false -> no 'Taslak kaydet' button; emSave() false with 'Bu veriye erişim yetkiniz yok.'; 0 requests", async () => {
  const P = page({ caps: { crm: false, superadmin: false } }); await P.window.renderEmail(); P.S.reqs.length = 0; P.window.emNewImport();
  assert.ok(![...P.$("emEditor").querySelectorAll("button")].some((b) => /Taslak kaydet/.test(b.textContent)), "no save button");
  P.set({ em_name: "TEST yetkisiz", em_class: "transactional", em_src: FIXTURE });
  assert.equal(await P.window.emSave(), false); assert.ok(P.txt("emStatus").includes("Bu veriye erişim yetkiniz yok.")); assert.deepEqual(P.actions(), []);
});

await scenario("sanitizer summary: validate button explains removed[]/warnings[] in plain Turkish (tags, attributes, links, remote host)", async () => {
  const P = await importPage();
  const h = '<table><tr><td onclick="x()" style="color:red;position:absolute;opacity:.5"><font color="red">Merhaba {{first_name}}</font>'
    + '<img src="https://img.example.org/a.png"><a href="javascript:alert(1)">tık</a><a href="sayfa.html">göreli</a><script>evil()</script></td></tr></table>';
  P.set({ em_class: "transactional", em_src: h });
  const body = await P.window.emValidate(); assert.ok(body && body.ok === true);
  const r = P.txt("emReport");
  for (const s of ["<script> etiketleri içerikleriyle birlikte kaldırıldı", "desteklenmeyen etiketler kaldırıldı, içerikleri korundu: <font>", "izin verilmeyen öznitelikler kaldırıldı: td.onclick",
    "opacity stilleri kaldırıldı", "güvensiz stil kuralları kaldırıldı (position)", "güvensiz bağlantı adresleri kaldırıldı (href)",
    "Görsel izinli alan adında değil: img.example.org", "Bazı görsellerde alternatif metin (alt) yok.", "Göreli veya değişkenli bağlantı var"]) assert.ok(r.includes(s), "summary has: " + s + "\n" + r);
  assert.ok(r.includes("içerik özeti ") && !r.includes("content_hash"), "hash label is plain");
  assert.deepEqual(P.actions(), ["validate"], "F10: no asset_preview without managed assets");
  leakCheck(P.visible(), "summary");
});

await scenario("F4 lock + (5): reopened marketing draft without unsubscribe -> class locked; message points to '+ HTML içe aktar' (no 'check the class')", async () => {
  const P = page(); await P.window.renderEmail();
  P.S.tpl.set("t9-0000-4000-8000-000000000000", { id: "t9-0000-4000-8000-000000000000", name: "TEST kilitli", cls: "marketing", src: "html_import", status: "draft",
    draft: { version_number: 1, subject: "K", preview_text: "", sender_name: "", reply_to: null, source_html: FIXTURE, sanitized_html: "", asset_manifest: [] } });
  P.S.reqs.length = 0; await P.window.emOpen("t9-0000-4000-8000-000000000000");
  assert.deepEqual(P.actions(), ["get", "validate"], "F10: reopen without assets -> no asset_preview");
  assert.ok(P.$("em_class").disabled && P.$("em_class").value === "marketing", "class locked on reopen");
  assert.ok(P.txt("emReport").includes(UNSUB_TXT + " " + LOCKED_TXT), P.txt("emReport"));
  assert.ok(!P.txt("emReport").includes("sınıfı kontrol et"));
  const n0 = P.S.reqs.length; assert.equal(await P.window.emSave(), false);
  assert.deepEqual(P.actions(n0), ["validate"], "no save request"); assert.ok(P.txt("emStatus").includes(LOCKED_TXT));
  leakCheck(P.visible(), "locked");
  // with a managed asset the preview swap still asks asset_preview (reopen behaviour unchanged)
  P.S.tpl.get("t9-0000-4000-8000-000000000000").draft.asset_manifest = [{ asset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", public_path: "a.png" }];
  const n1 = P.S.reqs.length; await P.window.emOpen("t9-0000-4000-8000-000000000000"); assert.deepEqual(P.actions(n1), ["get", "validate", "asset_preview"]);
});

await scenario("other e-mail actions: host images / asset upload / new version / duplicate / archive / open errors are plain sentences", async () => {
  const E = (status, error) => ({ status, body: { ok: false, error } });
  let P = await importPage(); P.set({ em_class: "marketing", em_src: FIXTURE });
  P.S.override.import_host_images = E(422, "bad_field:html"); await P.window.emHostImages();
  assert.ok(P.txt("emStatus").includes("HTML çok büyük (en fazla 400.000 karakter).")); leakCheck(P.visible(), "host err");
  P = await importPage(); P.set({ em_class: "transactional", em_src: FIXTURE });
  P.S.override.import_host_images = { status: 200, body: { ok: true, rewritten_html: FIXTURE, hosted: [], needs_manual_upload: ["https://img.example.org/a.png", "https://img.example.org/b.png:storage_hash_conflict"], validation_report: {} } };
  await P.window.emHostImages(); await new Promise((r) => setTimeout(r, 30));
  const st = P.txt("emStatus"); assert.ok(st.includes("https://img.example.org/a.png") && st.includes("https://img.example.org/b.png (depoda aynı adla farklı görsel var)"), st);
  assert.ok(!st.includes("storage_hash_conflict")); leakCheck(P.visible(), "host manual");
  P = await importPage(); await P.window.emAssetUpload({ files: [{ size: 3000000 }] });
  assert.ok(P.txt("emStatus").includes("Görsel çok büyük (en fazla 2 MB).")); assert.deepEqual(P.actions(), []);
  P = await importPage(); P.S.override.asset_upload = E(422, "bad_mime_content");
  await P.window.emAssetUpload({ files: [new P.window.File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })] });
  assert.ok(P.txt("emStatus").includes("Desteklenmeyen görsel türü; PNG, JPEG, GIF veya WebP yükle."), P.txt("emStatus")); leakCheck(P.visible(), "upload");
  P = page(); await P.window.renderEmail();
  P.S.override.new_version = E(400, "draft_exists"); await P.window.emNewVersion("t1-0000-4000-8000-000000000000");
  assert.ok(P.txt("emListStatus").includes('Bu şablonun zaten bir taslağı var; listeden "Aç" ile düzenle.'));
  P.S.override.duplicate = E(403, "forbidden"); await P.window.emDuplicate("t1-0000-4000-8000-000000000000");
  assert.ok(P.txt("emListStatus").includes("Bu veriye erişim yetkiniz yok."));
  P.S.override.archive = E(400, "not_found"); await P.window.emArchive("t1-0000-4000-8000-000000000000");
  assert.ok(P.txt("emListStatus").includes("Şablon bulunamadı; sayfayı yenileyip yeniden aç."));
  P.S.override.get = E(403, "not_admin"); await P.window.emOpen("t1-0000-4000-8000-000000000000");
  assert.ok(P.txt("emListStatus").includes("Bu veriye erişim yetkiniz yok.")); leakCheck(P.visible(), "list actions"); assert.equal(P.alerts.length, 0);
  const Q = page({ caps: { superadmin: false } }); await Q.window.renderEmail(); await Q.window.emArchive("x");
  assert.ok(Q.txt("emListStatus").includes("Arşivleme yalnız süper yönetici yetkisiyle yapılabilir.")); leakCheck(Q.visible(), "archive role");
  // no editor and no list status -> alert fallback, still plain
  const R = page(); await R.window.emNewVersion("x"); assert.ok(R.alerts.length === 1); leakCheck(R.alerts.join("\n"), "alert fallback");
  assert.equal(R.window.emErrText(422, { error: "missing_unsubscribe" }, "Yayınlanamadı"), "Yayınlanamaz: marketing şablonunda abonelikten çıkış bağlantısı yok.");
});

// ---- race: the editor must not be switched under an in-flight save; a save/publish always targets the template it started on ----
const BUSY_TXT = "Kaydetme sürüyor; bitince tekrar dene.";
const TA = "aaaaaaaa-0000-4000-8000-00000000000a", TB = "bbbbbbbb-0000-4000-8000-00000000000b";
const SRC_A = FIXTURE.replace("Merhaba", "A şablonu"), SRC_B = FIXTURE.replace("Merhaba", "B şablonu"), SRC_A2 = FIXTURE.replace("Merhaba", "A düzenlendi");
function seedAB(P) {
  for (const [id, name, src] of [[TA, "TEST A şablonu", SRC_A], [TB, "TEST B şablonu", SRC_B]])
    P.S.tpl.set(id, { id, name, cls: "transactional", src: "html_import", status: "draft",
      draft: { version_number: 1, subject: "K", preview_text: "", sender_name: "", reply_to: null, source_html: src, sanitized_html: "", asset_manifest: [] } });
}
function holdNext(P, action) {   // holds the NEXT request of that action until release()
  let release, armed = true; const held = new Promise((r) => { release = r; });
  P.S.gate = async (a) => { if (armed && a === action) { armed = false; await held; } };
  return () => release();
}
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function abPage(opts) { const P = page(opts); await P.window.renderEmail(); seedAB(P); await P.window.emRefreshList(); await P.window.emOpen(TA); P.set({ em_src: SRC_A2 }); return P; }

await scenario("race guard: while saving A, Aç/Çoğalt/Arşivle/Yeni sürüm/+ HTML/+ Görsel/barındır/görsel yükle are refused (plain text, 0 requests); save goes to A, B untouched", async () => {
  const P = await abPage();
  assert.ok(P.$("em_name").readOnly && P.$("em_desc").readOnly, "name/description read-only on reopen");
  const release = holdNext(P, "validate"); const n0 = P.S.reqs.length;
  const p = P.window.emSave(); await tick();
  const ctl = [...P.$("emEditor").querySelectorAll("button,input[type=file]")].filter((b) => /^(emSave|emPublish|emValidate|emHostImages|emImportFile)\b/.test(b.getAttribute("onclick") || b.getAttribute("onchange") || ""));
  assert.ok(ctl.length >= 5 && ctl.every((b) => b.disabled), "save/publish/validate/host/file controls disabled in flight");
  await P.window.emOpen(TB); assert.ok(P.txt("emListStatus").includes(BUSY_TXT), "Aç refused: " + P.txt("emListStatus"));
  assert.equal(P.window.emNewImport(), false); assert.equal(await P.window.emNewVisual(), false);
  await P.window.emDuplicate(TB); await P.window.emArchive(TB); await P.window.emNewVersion(TB);
  await P.window.emHostImages(); assert.ok(P.txt("emStatus").includes(BUSY_TXT));
  await P.window.emAssetUpload({ files: [new P.window.File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })] });
  assert.deepEqual(P.actions(n0), ["validate"], "nothing but the held validate was sent");
  assert.equal(P.$("em_src").value, SRC_A2, "editor still shows A"); assert.equal(P.window.__curId(), TA);
  release(); assert.equal(await p, true);
  const sv = P.S.reqs.filter((r) => r.action === "save").pop();
  assert.equal(sv.template_id, TA, "save.template_id === A"); assert.equal(sv.html, SRC_A2);
  assert.equal(P.S.tpl.get(TA).draft.source_html, SRC_A2, "A saved"); assert.equal(P.S.tpl.get(TB).draft.source_html, SRC_B, "B draft unchanged");
  assert.ok(P.txt("emStatus").includes("Taslak kaydedildi: «TEST A şablonu»"), P.txt("emStatus"));
  assert.ok(ctl.every((b) => !b.disabled), "controls re-enabled"); assert.equal(P.window.__busy(), false);
  assert.ok(!P.txt("emListStatus").includes(BUSY_TXT), "busy notice cleared after the save");
  leakCheck(P.visible(), "race guard"); assert.equal(P.alerts.length, 0);
  const n1 = P.S.reqs.length; await P.window.emOpen(TB); assert.deepEqual(P.actions(n1), ["get", "validate"]); assert.equal(P.$("em_src").value, SRC_B, "Aç works again after the save");
  // Aç(B) clicked first (its get still in flight), then "Taslak kaydet" on A: the late get must NOT switch the editor
  const R = await abPage(); const relGet = holdNext(R, "get"); const o = R.window.emOpen(TB); await tick();
  const relVal = holdNext(R, "validate"); const sp = R.window.emSave(); await tick(); relGet(); await o;
  assert.equal(R.$("em_src").value, SRC_A2, "editor still A after the late get"); assert.equal(R.window.__curId(), TA, "still bound to A"); assert.ok(R.txt("emListStatus").includes(BUSY_TXT));
  relVal(); assert.equal(await sp, true); assert.equal(R.S.reqs.filter((r) => r.action === "save").pop().template_id, TA); assert.equal(R.S.tpl.get(TB).draft.source_html, SRC_B);
  // publish variant: emPublish(A) with validate held, Aç(B) refused -> save AND publish go to A
  const Q = await abPage(); Q.S.override.publish = { status: 200, body: { ok: true } };
  const rel2 = holdNext(Q, "validate"); const q = Q.window.emPublish(); await tick();
  await Q.window.emOpen(TB); assert.ok(Q.txt("emListStatus").includes(BUSY_TXT));
  rel2(); await q;
  assert.equal(Q.S.reqs.filter((r) => r.action === "save").pop().template_id, TA);
  assert.equal(Q.S.reqs.filter((r) => r.action === "publish").pop().template_id, TA, "publish.template_id === A");
  assert.equal(Q.S.tpl.get(TB).draft.source_html, SRC_B); assert.deepEqual(Q.alerts, ["Yayınlandı (immutable)."]);
});

await scenario("race snapshot (defence in depth): editor replaced mid-save (re-render or a guard bypass) -> requests keep A's id, outcome goes to the list line, new editor untouched", async () => {
  // (a) navigation re-renders the e-mail tab while A is saving
  let P = await abPage(); let release = holdNext(P, "validate");
  let p = P.window.emSave(); await tick(); await P.window.renderEmail(); release(); assert.equal(await p, true);
  assert.equal(P.S.reqs.filter((r) => r.action === "save").pop().template_id, TA); assert.equal(P.S.tpl.get(TA).draft.source_html, SRC_A2);
  assert.ok(P.txt("emListStatus").includes("Taslak kaydedildi: «TEST A şablonu» · taslak (yayınlanmadı) · e-posta gönderilmedi."), P.txt("emListStatus"));
  assert.equal(P.$("em_src"), null, "no editor resurrected"); leakCheck(P.visible(), "snapshot a");
  // (b) the busy guard is bypassed and B is opened while A's validate is in flight
  P = await abPage(); release = holdNext(P, "validate");
  p = P.window.emSave(); await tick(); P.window.__setBusy(false); await P.window.emOpen(TB); P.window.__setBusy(true);
  assert.equal(P.$("em_src").value, SRC_B); release(); assert.equal(await p, true);
  const sv = P.S.reqs.filter((r) => r.action === "save").pop();
  assert.equal(sv.template_id, TA, "save keeps A's id"); assert.equal(sv.html, SRC_A2);
  assert.equal(P.S.tpl.get(TB).draft.source_html, SRC_B, "B draft unchanged"); assert.equal(P.S.tpl.get(TA).draft.source_html, SRC_A2);
  assert.equal(P.window.__curId(), TB, "editor still bound to B"); assert.equal(P.$("em_src").value, SRC_B, "B editor content untouched");
  assert.ok(!P.txt("emStatus").includes("Taslak kaydedildi"), "B's status line does not claim a save");
  assert.ok(P.txt("emReport").includes("B şablonu") && !P.txt("emReport").includes("A düzenlendi"), "A's report is not rendered into B's editor");
  assert.ok(P.txt("emListStatus").includes("Taslak kaydedildi: «TEST A şablonu»"), P.txt("emListStatus")); leakCheck(P.visible(), "snapshot b");
  // (b') same, but A's save fails -> the error names A on the list line, B's status stays clean
  P = await abPage(); P.S.override.save = { status: 409, body: { ok: false, error: "unmanaged_asset_url" } }; release = holdNext(P, "validate");
  p = P.window.emSave(); await tick(); P.window.__setBusy(false); await P.window.emOpen(TB); P.window.__setBusy(true); release(); assert.equal(await p, false);
  assert.equal(P.S.reqs.filter((r) => r.action === "save").pop().template_id, TA);
  assert.ok(P.txt("emListStatus").includes('«TEST A şablonu»: İçerikte izin verilmeyen görsel bağlantısı var'), P.txt("emListStatus"));
  assert.ok(!P.$("emStatus").querySelector(".notice.err"), "no error in B's editor"); leakCheck(P.visible(), "snapshot b'");
  // (c) new template: a fresh editor is opened while create is in flight -> the new editor is NOT bound to the created id
  P = await importPage(); P.set({ em_name: "TEST yeni N", em_class: "transactional", em_src: FIXTURE }); release = holdNext(P, "create");
  p = P.window.emSave(); await tick(); P.window.__setBusy(false); assert.equal(P.window.emNewImport(), true); P.window.__setBusy(true);
  release(); assert.equal(await p, true);
  const created = [...P.S.tpl.values()].find((t) => t.name === "TEST yeni N");
  assert.ok(created && created.draft && created.draft.source_html === FIXTURE, "N created and saved");
  assert.equal(P.S.reqs.filter((r) => r.action === "save").pop().template_id, created.id);
  assert.equal(P.window.__curId(), null, "fresh editor stays a NEW editor"); assert.ok(!P.$("em_class").disabled && !P.$("em_name").readOnly, "fresh editor not locked");
  assert.equal(P.$("em_src").value, "", "fresh editor untouched");
  assert.ok(P.txt("emListStatus").includes("Taslak kaydedildi: «TEST yeni N»")); leakCheck(P.visible(), "snapshot c");
  // (d) publish: B opened (bypass) during A's validate -> save + publish go to A; B's editor is not closed
  P = await abPage(); P.S.override.publish = { status: 200, body: { ok: true } }; release = holdNext(P, "validate");
  p = P.window.emPublish(); await tick(); P.window.__setBusy(false); await P.window.emOpen(TB); P.window.__setBusy(true); release(); await p;
  assert.equal(P.S.reqs.filter((r) => r.action === "save").pop().template_id, TA);
  assert.equal(P.S.reqs.filter((r) => r.action === "publish").pop().template_id, TA, "publish keeps A's id");
  assert.equal(P.$("em_src").value, SRC_B, "B editor still open"); assert.ok(P.txt("emListStatus").includes("«TEST A şablonu» yayınlandı."), P.txt("emListStatus"));
  assert.equal(P.alerts.length, 0); leakCheck(P.visible(), "snapshot d");
});

await scenario("existing template: success line shows the STORED name (name/description read-only; save never renames)", async () => {
  const P = await abPage();
  assert.ok(P.$("em_name").readOnly && P.$("em_desc").readOnly); assert.equal(P.$("em_name").title, "Ad ve açıklama, şablon oluşturulduktan sonra bu ekrandan değiştirilemez.");
  P.$("em_name").value = "YENİDEN ADLANDIRILDI";   // programmatic change bypasses readOnly
  assert.equal(await P.window.emSave(), true);
  assert.ok(P.txt("emStatus").includes("Taslak kaydedildi: «TEST A şablonu»"), P.txt("emStatus")); assert.ok(!P.visible().includes("YENİDEN ADLANDIRILDI"));
  assert.ok(!("internal_name" in P.S.reqs.filter((r) => r.action === "save").pop()), "save sends no name");
  const Q = await importPage(); Q.set({ em_name: "TEST yeni ad", em_class: "transactional", em_src: FIXTURE });
  assert.ok(!Q.$("em_name").readOnly); assert.equal(await Q.window.emSave(), true); assert.ok(Q.$("em_name").readOnly && Q.$("em_desc").readOnly, "locked after create");
  Q.$("em_name").value = "BAŞKA AD"; assert.equal(await Q.window.emSave(), true); assert.ok(Q.txt("emStatus").includes("Taslak kaydedildi: «TEST yeni ad»"));
});

await scenario("F4 mid-flight: class/name/description changed while validate or create of a NEW template is in flight -> locked fields show what create stored; next save uses the stored class", async () => {
  const SRC_MKT = FIXTURE.replace('<p><a href="https://www.asalocal.club/"', '<p><a href="{{unsubscribe_url}}">Abonelikten çık</a></p><p><a href="https://www.asalocal.club/"');
  // direction 1: stored transactional, select switched to Marketing during validate (would let publish skip the marketing unsubscribe check)
  // direction 2: stored marketing, select switched to Transactional during create (would show Transactional while publish demands an unsubscribe link)
  for (const [from, to, hold, src] of [["transactional", "marketing", "validate", FIXTURE], ["marketing", "transactional", "create", SRC_MKT]]) {
    const P = await importPage(); const name = "TEST uçuşta " + from;
    P.set({ em_name: name, em_desc: "ilk açıklama", em_class: from, em_src: src });
    const release = holdNext(P, hold); const p = P.window.emSave(); await tick();
    assert.ok(!P.$("em_class").disabled && !P.$("em_name").readOnly, "fields still editable before create (" + hold + " held)");
    P.set({ em_class: to, em_name: name + " yeniden adlandırıldı", em_desc: "uçuşta değişti" });
    release(); assert.equal(await p, true);
    const c = P.S.reqs.find((r) => r.action === "create"); const stored = P.S.tpl.get(P.window.__curId());
    assert.equal(c.email_class, from, "create used the snapshot class"); assert.equal(stored.cls, from);
    assert.equal(P.$("em_class").value, c.email_class, hold + ": locked select shows the stored class, not the mid-flight pick");
    assert.ok(P.$("em_class").disabled, "class locked after create");
    assert.equal(P.$("em_name").value, c.internal_name, "read-only name shows the stored name"); assert.ok(P.$("em_name").readOnly && P.$("em_desc").readOnly);
    assert.equal(P.$("em_desc").value, c.description, "read-only description shows the stored description");
    assert.ok(P.txt("emStatus").includes("Taslak kaydedildi: «" + name + "»"), P.txt("emStatus"));
    // the next save (same editor) validates and saves under the STORED class, to the same template
    const n0 = P.S.reqs.length; P.set({ em_src: src.replace("Merhaba", "Selam") }); assert.equal(await P.window.emSave(), true);
    const v2 = P.S.reqs.slice(n0).find((r) => r.action === "validate"), s2 = P.S.reqs.slice(n0).find((r) => r.action === "save");
    assert.equal(v2.email_class, stored.cls, "second validate uses the stored class"); assert.equal(s2.email_class, stored.cls, "second save uses the stored class");
    assert.equal(s2.template_id, stored.id); assert.equal(P.S.tpl.size, 1); leakCheck(P.visible(), "F4 mid-flight " + from);
  }
  // marketing stored + the user removes the unsubscribe link: the refusal now matches the (locked) Marketing select
  const P = await importPage(); P.set({ em_name: "TEST uçuşta kontrol", em_class: "marketing", em_src: SRC_MKT });
  const release = holdNext(P, "validate"); const p = P.window.emSave(); await tick(); P.set({ em_class: "transactional" }); release(); assert.equal(await p, true);
  assert.equal(P.$("em_class").value, "marketing"); P.set({ em_src: FIXTURE });
  const n0 = P.S.reqs.length; assert.equal(await P.window.emSave(), false);
  assert.deepEqual(P.actions(n0), ["validate"], "no save without unsubscribe"); assert.equal(P.S.reqs[n0].email_class, "marketing");
  assert.ok(P.txt("emStatus").includes(UNSUB_TXT), P.txt("emStatus"));
});

await scenario("create ok, save failed -> list refreshed (empty draft visible) + plain sentence; retry saves into the SAME template (no second create)", async () => {
  const P = await importPage(); P.set({ em_name: "TEST yarım", em_class: "transactional", em_src: FIXTURE });
  P.S.override.save = { status: 500, body: { ok: false, error: "internal_error" } };
  assert.equal(await P.window.emSave(), false);
  assert.deepEqual(P.actions(), ["validate", "create", "save", "list"], "list refreshed after the failed save");
  const st = P.txt("emStatus");
  assert.ok(st.includes("Kaydedilemedi (hata 500). Alanları kontrol edip tekrar dene."), st);
  assert.ok(st.includes('Şablon boş bir taslak olarak oluşturuldu ve listeye eklendi; içerik henüz kaydedilmedi. Sorunu giderip "Taslak kaydet" ile yeniden dene.'), st);
  assert.ok(P.txt("emList").includes("TEST yarım"), "empty shell visible in the list"); leakCheck(P.visible(), "create ok save fail");
  const id = P.window.__curId(); assert.ok(id); delete P.S.override.save;
  const n0 = P.S.reqs.length; assert.equal(await P.window.emSave(), true);
  assert.deepEqual(P.actions(n0), ["validate", "save", "list"], "retry: no second create"); assert.equal(P.S.tpl.size, 1);
  assert.equal(P.S.reqs.filter((r) => r.action === "save").pop().template_id, id);
  const keys = P.S.reqs.filter((r) => r.action === "save").map((r) => r.idem); assert.equal(keys[0], keys[1], "stable save idem across the retry");
  assert.ok(P.txt("emStatus").includes("Taslak kaydedildi: «TEST yarım»"));
});

// ---- F9: whole admin.html in jsdom (fake supabase client), tab restored from #hash only if CAPS allow it ----
async function bootFull(hash, caps) {
  const reqs = [];
  const dom = new JSDOM(html, { url: "https://www.asalocal.club/CDP3B/admin.html" + hash, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.alert = () => {}; w.console.error = () => {};
      const q = { select() { return q; }, order() { return q; }, eq() { return q; }, then(res) { res({ data: [], error: null }); } };
      w.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session: { access_token: "local-fake-token" } } }), signOut: async () => ({}), signInWithPassword: async () => ({ error: null }) },
        rpc: async (fn, a) => ({ data: fn === "is_current_user_admin" ? !!caps.admin : fn === "current_user_has_admin_role" ? (caps.roles || []).includes(a && a.role_name) : !!caps[fn] }),
        from: () => q }) };
      w.fetch = async (u, o) => { let b = {}; try { b = JSON.parse(o.body); } catch { /* */ } reqs.push(String(u).replace(/^.*\/functions\/v1\//, "") + ":" + b.action);
        return { status: 503, json: async () => ({ ok: false, error: "x" }) }; };
    } });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.document.querySelector("#nav button"); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
  const on = w.document.querySelector("#nav button.on"); const navs = [...w.document.querySelectorAll("#nav button")].map((b) => b.textContent);
  return { w, on: on ? on.textContent : null, navs, reqs };
}
await scenario("F9: reload keeps the e-mail tab via #email; hash outside the CAPS-derived tab list is ignored; go() writes the hash", async () => {
  const CRM = { admin: true, roles: ["crm"] }, MEMBERS = { admin: true, _can_manage_members: true, roles: [] };
  let b = await bootFull("#email", CRM); assert.equal(b.on, "E-posta", "crm + #email -> E-posta"); assert.ok(b.reqs.includes("email-api:list"));
  b = await bootFull("#email", MEMBERS); assert.equal(b.on, "Özet", "no crm -> #email ignored"); assert.ok(!b.reqs.some((r) => r.startsWith("email-api")), "no email-api call");
  b = await bootFull("#segments", MEMBERS); assert.equal(b.on, "Özet", "#segments needs crm (not in the CAPS tab list)");
  b = await bootFull("#consent", MEMBERS); assert.equal(b.on, "İzin Görünümü", "#consent allowed for members (in the tab list)");
  b = await bootFull("#%3Cimg%20src%3Dx%3E", CRM); assert.equal(b.on, "Özet", "garbage hash ignored");
  b = await bootFull("", CRM); assert.equal(b.on, "Özet", "no hash -> Özet");
  b.w.go("email"); assert.equal(b.w.location.hash, "#email", "go() writes the hash");
  await new Promise((r) => setTimeout(r, 20)); assert.equal(b.w.document.querySelector("#nav button.on").textContent, "E-posta");
});

console.log("scenarios=" + results.length);
console.log("ADMIN_SAVE_DRAFT_OK");
process.exit(0);
