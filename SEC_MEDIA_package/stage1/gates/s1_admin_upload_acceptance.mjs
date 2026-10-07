#!/usr/bin/env node
// SEC-MEDIA · Stage 1 (İŞ PAKETİ 1) · canlı admin UI üzerinden TEK güvenli medya yükleme kabul testi.
// Live admin UI acceptance: real login, ONE synthetic PNG via the real "Fotoğraf yükle" control
// (prefix venues), network + response + public URL evidence. Never prints token/secret/email values.
//
// Modes:
//   --selftest     offline checks (no network, no browser)
//   --preflight    live page load + static source checks only (NO login, NO upload)
//   --runtime      S1-00b admin-api runtime acceptance: real UI login, Özet "counts" → 200,
//                  in-page OPTIONS from the site origin → 200, local logout (NO upload, NO object)
//   (default)      full run; requires S1_CONFIRM_UPLOAD=YES (creates exactly ONE production object)
// Evidence files are never overwritten: the upload result is create-only; a full-mode run that
// stops before the one-shot marker writes s1_upload_blocked.<run_id>.json instead.
// Exit codes: 0 PASS · 1 FAIL · 2 config/usage · 3 STOP (safety interlock)
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ALLOWED_PREFIX, REPO_ROOT, RESPONSE_DATA_KEYS, classifyPublicKey, classifyRequest, decodeJwtPayload, defaultOutDir, discoverConfig,
  findLeaks, inspectPng, isMain, loadModule, makeChecker, makeLogger, makeRedactor, makeTestPng, maskObjectPath,
  maskPublicUrl, maskUuid, newRunId, nowIso, parseMultipart, resolveBaseUrl, sha256hex, sniffMimeLocal,
  staticCheckAdminHtml, validatePublicUrl, writeJsonGuarded,
} from "./s1_lib.mjs";

const RESULT_FILE = "s1_upload_result.json";
const PREFLIGHT_FILE = "s1_preflight_result.json";
const RUNTIME_FILE = "s1_runtime_result.json";
const blockedFile = (runId) => `s1_upload_blocked.${runId}.json`;
const MARKER_FILE = "s1_upload.attempt";
// Local-only operator reference (full object path/URL) for cleanup verification. Gitignored; never part of a report.
const REF_FILE = "s1_object_ref.local.json";
const GONE_FILE = "s1_verify_gone_result.json";
const T = { nav: 45_000, upload: 60_000, short: 15_000 };

// In-page instrumentation: records ONLY header NAMES and FormData field names/string values
// for admin-api calls. Header values (Authorization/apikey) are never stored.
const FETCH_WRAPPER = `(() => {
  const rec = [];
  Object.defineProperty(window, "__s1rec", { value: rec });
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      if (/\\/functions\\/v1\\/admin-api(\\?|$)/.test(url)) {
        const h = (init && init.headers) || {};
        let keys = [];
        if (typeof Headers !== "undefined" && h instanceof Headers) keys = Array.from(h.keys());
        else if (Array.isArray(h)) keys = h.map((x) => String(x[0]).toLowerCase());
        else keys = Object.keys(h).map((k) => k.toLowerCase());
        const body = init && init.body;
        const e = { url, method: String((init && init.method) || "GET").toUpperCase(), headerKeys: keys, bodyType: (typeof FormData !== "undefined" && body instanceof FormData) ? "FormData" : typeof body, fields: null };
        if (e.bodyType === "FormData") {
          e.fields = [];
          for (const [k, v] of body.entries()) e.fields.push(typeof v === "string" ? { name: k, value: v.length <= 64 ? v : "[long]" } : { name: k, file: true, type: v.type, size: v.size });
        }
        rec.push(e);
      }
    } catch (_) {}
    return of.apply(this, arguments);
  };
})();`;

function addCheck(list, id, name, status, detail) { list.push({ id, name, status, ...(detail !== undefined ? { detail } : {}) }); }

export async function runAcceptance({
  env = process.env, mode = "full", outDir = defaultOutDir(), installRoutes = null, launchOptions = {}, quiet = false,
} = {}) {
  const base = resolveBaseUrl(env.ASALOCAL_BASE_URL);
  const email = env.ASALOCAL_ADMIN_EMAIL || "";
  const pw = env.ASALOCAL_ADMIN_PASSWORD || "";
  const secrets = [email, pw];
  let redact = makeRedactor(secrets);
  const log = makeLogger((s) => redact(s), quiet);
  const runId = newRunId();
  const checks = [];
  // true only after THIS run created the one-shot marker, i.e. the single production upload is attempted.
  let markerWritten = false;
  const result = { schema: "s1_upload_result.v1", stage: "SEC_MEDIA_STAGE1", mode, run_id: runId, started_at: nowIso(), verdict: "FAIL", ...(mode === "full" ? { upload_attempted: false } : {}), checks };
  const summarize = () => { result.summary = { pass: checks.filter((c) => c.status === "PASS").length, fail: checks.filter((c) => c.status === "FAIL").length, info: checks.filter((c) => c.status === "INFO" || c.status === "WARN").length }; };
  const finish = (verdict, code) => {
    result.verdict = verdict; result.finished_at = nowIso();
    summarize();
    // preflight/runtime are repeatable (no production object) → overwrite is fine.
    // full: only the run that wrote the marker may create s1_upload_result.json, create-only (never overwrites the
    // single upload's evidence). Every other full-mode exit (A00 STOP, config, pre-upload gate) goes to its own file.
    let target = mode === "preflight" ? PREFLIGHT_FILE : mode === "runtime" ? RUNTIME_FILE : markerWritten ? RESULT_FILE : blockedFile(runId);
    try {
      try { writeJsonGuarded(join(outDir, target), result, secrets, { exclusive: mode === "full" }); }
      catch (e) {
        if (!(e && e.code === "EEXIST" && target === RESULT_FILE)) throw e;
        // Another run's evidence appeared in this out dir meanwhile: keep it untouched, write ours aside, FAIL.
        target = `s1_upload_result.${runId}.json`;
        addCheck(checks, "A21", "s1_upload_result.json tekil: mevcut kanıtın üzerine yazılmadı (aynı out dizininde eşzamanlı koşu?)", "FAIL", { written_to: target });
        verdict = "FAIL"; code = 1; result.verdict = "FAIL"; summarize();
        writeJsonGuarded(join(outDir, target), result, secrets, { exclusive: true });
      }
    } catch (e) { log(`OUTPUT_GUARD: ${e.message}`); verdict = "FAIL"; code = 1; result.verdict = "FAIL"; target = "(not written)"; }
    log(`S1_ACCEPTANCE ${mode} verdict=${result.verdict} pass=${result.summary.pass} fail=${result.summary.fail} file=${basename(target)}`);
    for (const c of checks) log(`  [${c.status}] ${c.id} ${c.name}${c.detail !== undefined ? " :: " + JSON.stringify(c.detail) : ""}`);
    return { code, result, file: target };
  };

  // ---------------------------------------------------------------- A00 config
  if (!base.ok) { addCheck(checks, "A00", "ASALOCAL_BASE_URL geçerli origin (https)", "FAIL", base.error); return finish("FAIL", 2); }
  result.base_url = base.origin;
  if (!base.isProd && !base.loopback) addCheck(checks, "A00w", "base URL production değil: admin-api CORS yalnız https://www.asalocal.club'a izin verir (index.ts:19,37)", "WARN", base.origin);
  if (mode === "full" || mode === "runtime") {
    if (!email || !pw) { addCheck(checks, "A00", "ASALOCAL_ADMIN_EMAIL / ASALOCAL_ADMIN_PASSWORD env mevcut", "FAIL", "missing"); return finish("FAIL", 2); }
  }
  if (mode === "full") {
    if (env.S1_CONFIRM_UPLOAD !== "YES") { addCheck(checks, "A00", "S1_CONFIRM_UPLOAD=YES (tek prod objesi oluşturma onayı)", "FAIL", "not_confirmed"); return finish("STOP", 3); }
    // Marker OR earlier evidence present → STOP. Deleting only the marker does not re-arm the upload.
    const prior = [MARKER_FILE, RESULT_FILE, REF_FILE].filter((f) => existsSync(join(outDir, f)));
    if (prior.length) {
      addCheck(checks, "A00", "önceki upload denemesi/kanıtı yok (retry yasak, PRD 2.2; kanıt dosyaları korunur)", "FAIL", { present_in_out_dir: prior });
      return finish("STOP", 3);
    }
  }
  addCheck(checks, "A00", "konfigürasyon", "PASS", { base: base.origin, mode });

  const pw_ = await loadModule("playwright");
  if (!pw_ || !pw_.chromium) { addCheck(checks, "A00p", "playwright modülü yüklenebilir", "FAIL", "npm install (stage1/) veya global playwright gerekli"); return finish("FAIL", 2); }
  const lo = { headless: env.S1_HEADED !== "1", ...launchOptions };
  if (env.S1_CHROMIUM_PATH) lo.executablePath = env.S1_CHROMIUM_PATH;
  if (env.S1_BROWSER_PROXY) lo.proxy = { server: env.S1_BROWSER_PROXY };
  let browser;
  try { browser = await pw_.chromium.launch(lo); }
  catch (e1) {
    if (!lo.executablePath && existsSync("/opt/pw-browsers/chromium")) {
      try { browser = await pw_.chromium.launch({ ...lo, executablePath: "/opt/pw-browsers/chromium" }); } catch (_) { /* below */ }
    }
    if (!browser) { addCheck(checks, "A00b", "chromium başlatılabilir", "FAIL", redact(String(e1.message).split("\n")[0])); return finish("FAIL", 2); }
  }

  const net = []; // classified request log (no header values)
  const pending = [];
  const adminPosts = new Map(); // Request -> { entry, infoPromise, multipart, info, resp }
  let upload = null; // { reqInfo, resp }
  let supabaseOrigin = null, fnUrl = null, anonKey = null;
  const consoleErrors = []; const pageErrors = [];
  let verdictCode = 1;
  const rememberSecret = (v) => { if (v && !secrets.includes(v)) { secrets.push(v); redact = makeRedactor(secrets); } };
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  try {
    if (installRoutes) await installRoutes(context);
    await context.addInitScript({ content: FETCH_WRAPPER });
    context.on("request", (req) => {
      if (!supabaseOrigin) return;
      const cls = classifyRequest(req.url(), req.method(), supabaseOrigin);
      const entry = { t: Date.now(), method: req.method(), kind: cls.kind, touchesMedia: !!cls.touchesMedia, table: cls.table ?? null };
      net.push(entry);
      if (cls.kind === "admin_api" && req.method() === "POST") {
        const recd = { entry, multipart: false, info: null, resp: null };
        adminPosts.set(req, recd);
        recd.infoPromise = (async () => {
          const h = await req.allHeaders();
          const ct = h["content-type"] || "";
          const auth = h["authorization"] || "";
          const tok = /^Bearer\s+(\S+)$/.exec(auth);
          if (tok) rememberSecret(tok[1]);
          if (!/^multipart\/form-data/i.test(ct)) {
            entry.adminJson = true;
            try { const a = JSON.parse(req.postData() || "{}").action; entry.action = typeof a === "string" && /^[a-z_]{1,40}$/.test(a) ? a : "[other]"; }
            catch (_) { entry.action = "[unparsed]"; }
            return;
          }
          const payload = tok ? decodeJwtPayload(tok[1]) : null;
          const buf = req.postDataBuffer();
          const parsed = buf ? parseMultipart(ct, buf) : { ok: false, error: "post_data_unavailable" };
          const info = {
            url_equals_fn_url: req.url() === fnUrl,
            method: req.method(),
            content_type_shape: ct.replace(/boundary=.*/i, "boundary=<browser>"),
            boundary_present: /;\s*boundary=\S+/i.test(ct),
            boundary_browser_generated: /boundary=-{4}WebKitFormBoundary[A-Za-z0-9]{16}$/.test(ct),
            authorization: auth ? "present" : "absent",
            bearer_scheme: !!tok,
            bearer_role: payload && typeof payload.role === "string" ? payload.role : null,
            bearer_is_anon_key: !!tok && tok[1] === anonKey,
            apikey_header: h["apikey"] ? "present" : "absent",
            body_parsed: parsed.ok,
            body_parse_error: parsed.ok ? null : parsed.error,
            form_fields: parsed.ok ? parsed.parts.map((p) => p.name) : null,
            action: parsed.ok ? (parsed.parts.find((p) => p.name === "action")?.data.toString("utf8") ?? null) : null,
            prefix: parsed.ok ? (parsed.parts.find((p) => p.name === "prefix")?.data.toString("utf8") ?? null) : null,
            file_part_content_type: parsed.ok ? (parsed.parts.find((p) => p.name === "file")?.contentType ?? null) : null,
            file_part_sha256: parsed.ok ? (() => { const f = parsed.parts.find((p) => p.name === "file"); return f ? sha256hex(f.data) : null; })() : null,
          };
          entry.multipart = true;
          recd.multipart = true;
          recd.info = info;
        })();
        pending.push(recd.infoPromise);
      }
    });
    context.on("response", (resp) => {
      const recd = adminPosts.get(resp.request());
      if (!recd) return;
      recd.entry.status = resp.status();
      pending.push((async () => {
        await recd.infoPromise;
        if (!recd.multipart) return; // JSON admin calls (e.g. counts): body is never read
        const h = await resp.allHeaders();
        let body = null; let text = "";
        try { text = (await resp.body()).toString("utf8"); body = JSON.parse(text); } catch (_) { body = null; }
        recd.resp = { status: resp.status(), contentType: h["content-type"] || "", requestId: h["x-request-id"] || null, body, rawLeaks: findLeaks(text, secrets) };
      })());
    });

    const page = await context.newPage();
    const logoutLocal = async () => {
      const r = await page.evaluate(async () => { try { const x = await authClient.auth.signOut({ scope: "local" }); return x && x.error ? "error" : "ok"; } catch (_) { return "exception"; } }).catch(() => "exception");
      addCheck(checks, "A20", "oturum kapatma (scope=local; diğer admin oturumları etkilenmez)", r === "ok" ? "INFO" : "WARN", r);
    };
    const consoleInfo = () => addCheck(checks, "A19", "konsol/page hataları (bilgi; Stage 1 kapısı değil)", consoleErrors.length + pageErrors.length === 0 ? "INFO" : "WARN", { console_errors: consoleErrors.length, page_errors: pageErrors.length, samples: consoleErrors.concat(pageErrors).slice(0, 3) });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(redact(m.text()).slice(0, 200)); });
    page.on("pageerror", (e) => pageErrors.push(redact(String(e && e.message)).slice(0, 200)));

    // ------------------------------------------------------------ A01 live page
    const nav = await page.goto(`${base.origin}/admin`, { waitUntil: "domcontentloaded", timeout: T.nav });
    const finalUrl = new URL(page.url());
    const html = nav ? await nav.text() : "";
    result.admin_page = { status: nav ? nav.status() : null, final_path: finalUrl.pathname, html_sha256: sha256hex(Buffer.from(html, "utf8")) };
    addCheck(checks, "A01", "/admin → canlı admin sayfası 200 (_redirects: /admin → /CDP3B/admin.html)", nav && nav.status() === 200 && finalUrl.origin === base.origin ? "PASS" : "FAIL", result.admin_page);
    try {
      const repoSha = sha256hex(readFileSync(join(REPO_ROOT, "CDP3B", "admin.html")));
      addCheck(checks, "A01i", "canlı HTML sha256 == repo CDP3B/admin.html (bilgi)", result.admin_page.html_sha256 === repoSha ? "INFO" : "WARN", { live: result.admin_page.html_sha256.slice(0, 16), repo: repoSha.slice(0, 16) });
    } catch (_) { /* repo file not present */ }

    // ------------------------------------------------------------ A02 config discovery
    const cfg = discoverConfig(html);
    if (!cfg.ok) { addCheck(checks, "A02", "CFG (supabase url/anon key) canlı sayfadan okunur", "FAIL", cfg.error); return finish("FAIL", 1); }
    supabaseOrigin = cfg.supabaseUrl; fnUrl = cfg.fnUrl; anonKey = cfg.anonKey;
    secrets.push(anonKey); redact = makeRedactor(secrets);
    result.supabase_origin = supabaseOrigin;
    result.anon_key = `present(${cfg.key.kind})`;
    const cfgOk = cfg.key.ok && cfg.fnDecl && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(supabaseOrigin);
    addCheck(checks, "A02", "CFG: https *.supabase.co + public anon/publishable key + FN_URL=.../functions/v1/admin-api", cfgOk ? "PASS" : "FAIL", { origin: supabaseOrigin, key: cfg.key.kind, fn_decl: cfg.fnDecl });
    if (cfg.key.kind === "service_role_jwt" || cfg.key.kind === "secret_key") { result.stop_reason = "privileged_key_in_public_page"; return finish("STOP", 3); }

    // ------------------------------------------------------------ A03 static checks on LIVE source
    const st = staticCheckAdminHtml(html);
    result.static_live_source = st;
    addCheck(checks, "A03", "canlı kaynak statik kontrolleri (S01–S13)", st.every((c) => c.ok) ? "PASS" : "FAIL", st.filter((c) => !c.ok).map((c) => `${c.id}:${c.name}`));
    if (mode === "preflight") {
      const ok = checks.every((c) => c.status !== "FAIL");
      return finish(ok ? "PREFLIGHT_PASS" : "FAIL", ok ? 0 : 1);
    }
    if (!checks.every((c) => c.status !== "FAIL")) return finish("FAIL", 1);

    // ------------------------------------------------------------ A05 login through the real UI
    await page.waitForSelector("#le", { timeout: T.nav });
    await page.fill("#le", email);
    await page.fill("#lp", pw);
    await page.click("#abtn");
    await page.waitForFunction(() => {
      if (document.querySelector("#nav button")) return true;
      const t = (document.getElementById("app") || {}).innerText || "";
      return /erişimi yok|Giriş olmadı|Bağlantı yok/.test(t);
    }, null, { timeout: T.nav });
    const navLabels = await page.$$eval("#nav button", (bs) => bs.map((b) => b.textContent.trim()));
    const hasVenues = navLabels.includes("Mekanlar");
    addCheck(checks, "A05", "gerçek UI ile admin girişi; Mekanlar sekmesi görünür (CAPS.venues)", hasVenues ? "PASS" : "FAIL", { nav_tabs: navLabels.length, venues_tab: hasVenues });
    if (!hasVenues) { await logoutLocal(); return finish("FAIL", 1); }
    // Let the Özet "counts" call finish first, so its late render cannot race the venues view.
    await page.waitForFunction(() => !document.querySelector("#ozetBody .skel"), null, { timeout: mode === "runtime" ? T.nav : T.short }).catch(() => {});

    // ------------------------------------------------------------ S1-00b runtime acceptance (no upload)
    if (mode === "runtime") {
      await settle(pending);
      const jsonCalls = [...adminPosts.values()].filter((r) => r.entry.adminJson).map((r) => ({ action: r.entry.action ?? null, status: r.entry.status ?? null }));
      const counts = jsonCalls.filter((c) => c.action === "counts");
      result.admin_json_calls = jsonCalls;
      addCheck(checks, "R01", "admin-api 'counts' (Özet, gerçek UI oturumu) → 200", counts.length >= 1 && counts.every((c) => c.status === 200) ? "PASS" : "FAIL", { counts_calls: counts.length, statuses: counts.map((c) => c.status) });
      // Explicit OPTIONS from the page (site origin). Not a CORS-safelisted method → the browser preflights it too,
      // so a 200 here proves both the preflight and the function's OPTIONS branch (index.ts:36) answer for this origin.
      const opt = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { method: "OPTIONS", cache: "no-store" }); const t = await r.text().catch(() => ""); return { status: r.status, body_ok: t.trim() === "ok" }; }
        catch (_) { return { status: null, error: "fetch_failed_or_cors_blocked" }; }
      }, fnUrl);
      result.options_probe = { page_origin: base.origin, ...opt };
      addCheck(checks, "R02", "tarayıcıdan (site origin'i) admin-api OPTIONS → 200, CORS izinli", opt.status === 200 ? "PASS" : "FAIL", result.options_probe);
      await settle(pending);
      const multis = [...adminPosts.values()].filter((r) => r.multipart).length;
      const sw = net.filter((n) => n.kind === "storage_write").length, rw = net.filter((n) => n.kind === "rest_write").length;
      addCheck(checks, "R03", "runtime modunda upload / Storage yazma / REST tablo yazma yok", multis === 0 && sw === 0 && rw === 0 ? "PASS" : "FAIL", { multipart_posts: multis, storage_writes: sw, rest_table_writes: rw });
      result.network = summarizeNet(net);
      await logoutLocal();
      consoleInfo();
      const ok = !checks.some((c) => c.status === "FAIL");
      return finish(ok ? "RUNTIME_PASS" : "FAIL", ok ? 0 : 1);
    }
    await page.locator("#nav button", { hasText: "Mekanlar" }).click();
    await page.locator("button", { hasText: "+ Yeni mekan" }).first().click();
    await page.waitForFunction(() => { const m = document.getElementById("modal"); const h = document.querySelector("#sheet h2"); return m && !m.classList.contains("hide") && h && h.textContent.trim() === "Yeni mekan"; }, null, { timeout: T.short });
    const input = page.locator('#sheet input[type="file"][onchange^="venuePhotoUpload"]');
    const inputCount = await input.count();
    addCheck(checks, "A07", "Yeni mekan formu açık; 'Fotoğraf yükle' input'u venuePhotoUpload'a bağlı (kayıt YAPILMAZ)", inputCount === 1 ? "PASS" : "FAIL", { inputs: inputCount });
    if (inputCount !== 1) { await logoutLocal(); return finish("FAIL", 1); }

    // ------------------------------------------------------------ A06 client-side prefix guard (no fetch)
    const recBefore = await page.evaluate(() => window.__s1rec.length);
    const netBefore = net.filter((n) => n.kind === "admin_api").length;
    const guard = await page.evaluate(async () => {
      try { await uploadToMedia(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "evil"); return { threw: false }; }
      catch (e) { return { threw: true, code: e && e.code }; }
    });
    await page.waitForTimeout(500);
    const recAfter = await page.evaluate(() => window.__s1rec.length);
    const netAfter = net.filter((n) => n.kind === "admin_api").length;
    result.client_prefix_guard = { threw: guard.threw, code: guard.code ?? null, admin_api_requests_issued: netAfter - netBefore, fetch_calls_issued: recAfter - recBefore };
    addCheck(checks, "A06", "izinsiz prefix istemcide fetch öncesi reddedilir (admin.html uploadToMedia guard)", guard.threw && guard.code === -1 && netAfter === netBefore && recAfter === recBefore ? "PASS" : "FAIL", result.client_prefix_guard);

    // ------------------------------------------------------------ the ONE upload
    const png = makeTestPng({ label: `ASALOCAL SEC-MEDIA S1 acceptance test image; synthetic; no personal data; run=${runId}` });
    const pngInfo = inspectPng(png);
    const clientStem = `s1-acceptance-${runId}`;
    result.test_image = { mime: "image/png", bytes: png.length, sha256: png ? sha256hex(png) : null, width: pngInfo.width, height: pngInfo.height, label: "synthetic; no personal data; tEXt-labeled", client_filename_stem: clientStem };
    addCheck(checks, "A04", "test görseli: geçerli PNG, <200KB, kişisel veri yok", pngInfo.ok && png.length < 200 * 1024 && sniffMimeLocal(png) === "image/png" ? "PASS" : "FAIL", { bytes: png.length });
    // First real error stops the run (PRD 2.2): no marker, no upload, no production object after a failed gate.
    if (checks.some((c) => c.status === "FAIL")) {
      result.stop_reason = "pre_upload_gate_failed";
      result.network = summarizeNet(net);
      await logoutLocal();
      return finish("FAIL", 1);
    }
    // Create-only: if a marker appeared meanwhile this throws (→ AXX FAIL) before any upload.
    writeFileSync(join(outDir, MARKER_FILE), JSON.stringify({ run_id: runId, at: nowIso(), note: "one upload attempted; do not re-run without an explicit decision (PRD 2.2)" }) + "\n", { flag: "wx" });
    markerWritten = true;
    result.upload_attempted = true;
    const tUpload = Date.now();
    await input.setInputFiles({ name: `${clientStem}.png`, mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => { const m = document.getElementById("f_upmsg"); return !!m && /✓|Hata/.test(m.textContent || ""); }, null, { timeout: T.upload });
    await page.waitForTimeout(1000);
    await settle(pending);
    const uiStatus = (await page.textContent("#f_upmsg")) || "";
    const photoUrl = await page.inputValue("#f_photo_url");
    const rec = await page.evaluate(() => window.__s1rec.filter((r) => r.bodyType === "FormData"));

    // ------------------------------------------------------------ A08–A12 request evidence
    const multis = [...adminPosts.values()].filter((r) => r.multipart);
    upload = multis.length ? { reqInfo: multis[0].info, resp: multis[0].resp } : null;
    addCheck(checks, "A08", "yükleme penceresinde tam 1 multipart POST admin-api'ye", multis.length === 1 && rec.length === 1 ? "PASS" : "FAIL", { multipart_posts_network: multis.length, multipart_fetch_calls: rec.length });
    if (!upload) { result.network = summarizeNet(net); return finish("FAIL", 1); }
    const ri = upload.reqInfo;
    result.upload_request = { ...ri };
    addCheck(checks, "A09", "istek URL'si = admin-api function endpoint, method POST", ri.url_equals_fn_url && ri.method === "POST" ? "PASS" : "FAIL", { url_equals_fn_url: ri.url_equals_fn_url, method: ri.method });
    const w = rec.length === 1 ? rec[0] : null;
    const pageSetCt = w ? w.headerKeys.includes("content-type") : null;
    result.upload_request.page_set_content_type = pageSetCt;
    result.upload_request.page_header_names = w ? w.headerKeys.slice().sort() : null;
    addCheck(checks, "A10", "multipart/form-data + browser boundary; Content-Type sayfa kodunca set EDİLMEDİ", ri.content_type_shape.startsWith("multipart/form-data") && ri.boundary_present && pageSetCt === false ? "PASS" : "FAIL", { boundary_present: ri.boundary_present, browser_generated: ri.boundary_browser_generated, page_set_content_type: pageSetCt });
    addCheck(checks, "A11", "Authorization başlığı mevcut, Bearer şeması, oturum JWT'si (değer yazdırılmaz); rol authenticated; anon key değil", ri.authorization === "present" && ri.bearer_scheme && ri.bearer_role === "authenticated" && !ri.bearer_is_anon_key ? "PASS" : "FAIL", { authorization: ri.authorization, role: ri.bearer_role, is_anon_key: ri.bearer_is_anon_key });
    const wFields = w && w.fields ? w.fields.map((f) => f.name) : null;
    const wAction = w && w.fields ? (w.fields.find((f) => f.name === "action") || {}).value : null;
    // Network body is authoritative; the page-side wrapper is accepted only when DevTools exposes no body at all.
    const devOk = ri.body_parsed && JSON.stringify(ri.form_fields) === JSON.stringify(["action", "prefix", "file"]) && ri.action === "media_upload" && ri.prefix === ALLOWED_PREFIX && ri.file_part_sha256 === result.test_image.sha256;
    const devAbsent = !ri.body_parsed && ri.body_parse_error === "post_data_unavailable";
    const fieldsOk = (devOk || devAbsent) && JSON.stringify(wFields) === JSON.stringify(["action", "prefix", "file"]) && wAction === "media_upload";
    result.upload_request.evidence_sources = [ri.body_parsed ? "devtools_network_body" : null, w ? "page_fetch_wrapper" : null].filter(Boolean);
    addCheck(checks, "A12", "form: action=media_upload, prefix=venues, file (bayt sha256 eşleşir); istemci obje adı/bucket alanı yok", fieldsOk ? "PASS" : "FAIL", { devtools_fields: ri.form_fields, devtools_parse_error: ri.body_parse_error, wrapper_fields: wFields, action: ri.action ?? wAction, prefix: ri.prefix, file_sha_match: ri.file_part_sha256 === result.test_image.sha256 });

    // ------------------------------------------------------------ A14–A15 response
    const rs = upload.resp || null;
    const data = rs && rs.body && rs.body.data ? rs.body.data : null;
    const keys = data ? Object.keys(data).sort() : null;
    result.upload_response = rs ? { status: rs.status, content_type: rs.contentType.split(";")[0], request_id_prefix: rs.requestId ? maskUuid(rs.requestId) : null, top_keys: rs.body ? Object.keys(rs.body).sort() : null, data_keys: keys, body_leaks: rs.rawLeaks } : null;
    const respOk = rs && rs.status === 200 && /application\/json/.test(rs.contentType) && data && typeof data.public_url === "string"
      && keys.every((k) => RESPONSE_DATA_KEYS.includes(k)) && data.bucket === "media" && data.mime === "image/png" && data.bytes === png.length && rs.rawLeaks.length === 0;
    addCheck(checks, "A14", "yanıt 200 JSON; data allowlist {bucket,path,public_url,mime,bytes}; mime image/png; bytes eşleşir; sızıntı yok", respOk ? "PASS" : "FAIL", result.upload_response);
    if (!data || typeof data.public_url !== "string") { result.network = summarizeNet(net); return finish("FAIL", 1); }
    const v = validatePublicUrl(data.public_url, { supabaseOrigin, prefix: ALLOWED_PREFIX, ext: "png", clientFileStem: clientStem, dataPath: typeof data.path === "string" ? data.path : null });
    result.object = { path_masked: maskObjectPath(v.objectPath), path_sha256: v.objectPath ? sha256hex(Buffer.from(v.objectPath, "utf8")) : null, public_url_masked: maskPublicUrl(data.public_url), uploaded_after: new Date(tUpload - 5000).toISOString() };
    addCheck(checks, "A15", "public_url: https, aynı supabase origin, /storage/v1/object/public/media/venues/<server UUIDv4>.png, istemci dosya adı yok", v.ok ? "PASS" : "FAIL", { errors: v.errors, path_masked: result.object.path_masked });
    writeJsonGuarded(join(outDir, REF_FILE), { note: "LOCAL ONLY - cleanup verification reference; do not paste into reports", run_id: runId, path: typeof data.path === "string" ? data.path : null, public_url: data.public_url, path_sha256: result.object.path_sha256 }, secrets, { exclusive: true });

    // ------------------------------------------------------------ A16 UI consumed only public_url
    addCheck(checks, "A16", "UI yalnız public_url'i tüketti: #f_photo_url == public_url; durum '✓ yüklendi'", photoUrl === data.public_url && /✓ yüklendi/.test(uiStatus) ? "PASS" : "FAIL", { field_equals_public_url: photoUrl === data.public_url, ui_status_ok: /✓ yüklendi/.test(uiStatus) });

    // ------------------------------------------------------------ close modal WITHOUT saving
    await page.locator("#sheet .foot button", { hasText: "Vazgeç" }).click();
    await page.waitForTimeout(300);
    const modalHidden = await page.evaluate(() => document.getElementById("modal").classList.contains("hide"));
    result.ui = { modal_closed_without_save: modalHidden };

    // ------------------------------------------------------------ A17 public GET
    if (v.ok) {
      const p2 = await context.newPage();
      const r2 = await p2.goto(data.public_url, { waitUntil: "load", timeout: T.short });
      const body2 = r2 ? await r2.body() : Buffer.alloc(0);
      const ct2 = r2 ? ((await r2.allHeaders())["content-type"] || "") : "";
      result.public_fetch = { status: r2 ? r2.status() : null, content_type: ct2, bytes: body2.length, sha256_match: sha256hex(body2) === result.test_image.sha256 };
      await p2.close();
      addCheck(checks, "A17", "public URL GET 200, Content-Type image/png, gövde sha256 yüklenen PNG ile aynı", result.public_fetch.status === 200 && /^image\/png\b/.test(ct2) && result.public_fetch.sha256_match ? "PASS" : "FAIL", result.public_fetch);
    } else {
      addCheck(checks, "A17", "public URL GET (URL doğrulanmadığı için yapılmadı)", "FAIL", "skipped_invalid_url");
    }

    // ------------------------------------------------------------ A13 network-wide invariants
    await settle(pending);
    result.network = summarizeNet(net);
    const directWrites = net.filter((n) => n.kind === "storage_write").length;
    const restWrites = net.filter((n) => n.kind === "rest_write").length;
    addCheck(checks, "A13", "doğrudan Storage yazma isteği yok (/storage/v1/object/media vb.); REST tablo yazımı yok (mekan kaydedilmedi)", directWrites === 0 && restWrites === 0 && modalHidden ? "PASS" : "FAIL", { storage_writes: directWrites, rest_table_writes: restWrites, modal_closed_without_save: modalHidden });

    // ------------------------------------------------------------ logout (local scope only)
    await logoutLocal();
    consoleInfo();
    result.cleanup_required = true;
    result.cleanup_hint = `Supabase Dashboard → Storage → media → ${result.object.path_masked} (S1_ACCEPTANCE.md §8)`;
    verdictCode = checks.some((c) => c.status === "FAIL") ? 1 : 0;
    return finish(verdictCode === 0 ? "PASS" : "FAIL", verdictCode);
  } catch (e) {
    addCheck(checks, "AXX", "beklenmeyen hata", "FAIL", redact(String(e && e.message).split("\n")[0]).slice(0, 300));
    result.network = summarizeNet(net);
    return finish("FAIL", 1);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function settle(pending) { while (pending.length) await Promise.all(pending.splice(0)); }

function summarizeNet(net) {
  const by = {};
  for (const n of net) by[n.kind] = (by[n.kind] || 0) + 1;
  return { by_kind: by, storage_write_touching_media: net.filter((n) => n.kind === "storage_write" && n.touchesMedia).length, rest_write_tables: [...new Set(net.filter((n) => n.kind === "rest_write").map((n) => n.table))] };
}

// ------------------------------------------------------------------ selftest (offline)
async function selftest() {
  const c = makeChecker("s1_admin_upload_acceptance selftest");
  // synthetic PNG
  const png = makeTestPng({ label: "selftest" });
  const info = inspectPng(png);
  c.ok(info.ok && info.crcOk && info.rawOk && info.width === 96 && info.height === 96, "PNG valid (CRC, IDAT inflate, IHDR)");
  c.ok(png.length < 200 * 1024, "PNG < 200KB");
  c.ok(sniffMimeLocal(png) === "image/png", "PNG sniff");
  c.ok(/no personal data|selftest/.test(info.text || ""), "PNG tEXt label");
  // cross-check with the real server module (Node type stripping)
  let mu = null;
  try { mu = await import(join(REPO_ROOT, "CDP3B/edge/admin-api/inert/media_upload.ts")); } catch (_) { mu = null; }
  c.ok(!!mu, "server module media_upload.ts importable (Node >= 22.6 type stripping)");
  const origin = "https://abcdefghijklmnopqrst.supabase.co";
  if (mu) {
    c.ok(mu.sniffMime(new Uint8Array(png)) === "image/png", "server sniffMime(PNG) = image/png");
    const planned = await mu.planMediaUpload({ prefix: "venues", bytes: new Uint8Array(png), supabaseUrl: origin, newUuid: () => crypto.randomUUID(), upload: async (a) => ({ error: null, path: a.path }) });
    c.ok(planned.ok && planned.status === 200, "server planMediaUpload ok with fake uploader");
    if (planned.ok) {
      const v = validatePublicUrl(planned.data.public_url, { supabaseOrigin: origin, clientFileStem: "s1-acceptance-x", dataPath: planned.data.path });
      c.ok(v.ok, "validator accepts real server-built public_url: " + v.errors.join(","));
      c.ok(Object.keys(planned.data).sort().join(",") === RESPONSE_DATA_KEYS.join(","), "server data keys == RESPONSE_DATA_KEYS");
      c.ok(maskObjectPath(planned.data.path) === `venues/${planned.data.path.slice(7, 15)}-****.png`, "mask format venues/xxxxxxxx-****.png");
      c.ok(!maskPublicUrl(planned.data.public_url).includes(planned.data.path.slice(16)), "masked URL hides uuid tail");
    }
  }
  // URL validator negatives
  const good = `${origin}/storage/v1/object/public/media/venues/0f8fad5b-d9cb-469f-a165-70867728950e.png`;
  c.ok(validatePublicUrl(good, { supabaseOrigin: origin }).ok, "good URL ok");
  const bad = {
    http: good.replace("https:", "http:"),
    other_origin: good.replace("abcdefghijklmnopqrst", "zzzzzzzzzzzzzzzzzzzz"),
    wrong_bucket: good.replace("/media/", "/email-assets-public/"),
    not_public: good.replace("/object/public/", "/object/"),
    wrong_prefix: good.replace("/venues/", "/ads/"),
    not_uuid: good.replace("0f8fad5b-d9cb-469f-a165-70867728950e", "s1-acceptance-x"),
    uuid_v1: good.replace("469f", "169f"),
    jpg_ext: good.replace(".png", ".jpg"),
    query: good + "?x=1",
    hash: good + "#x",
    traversal: `${origin}/storage/v1/object/public/media/venues/../ads/0f8fad5b-d9cb-469f-a165-70867728950e.png`,
    nested: good.replace("/venues/", "/venues/sub/"),
  };
  for (const [k, u] of Object.entries(bad)) c.ok(!validatePublicUrl(u, { supabaseOrigin: origin }).ok, `bad URL rejected: ${k}`);
  c.ok(!validatePublicUrl(good, { supabaseOrigin: origin, dataPath: "venues/other.png" }).ok, "data.path mismatch rejected");
  // request classification
  const cls = (u, m) => classifyRequest(u, m, origin);
  c.ok(cls(`${origin}/functions/v1/admin-api`, "POST").kind === "admin_api", "classify admin_api");
  c.ok(cls(`${origin}/functions/v1/admin-api`, "OPTIONS").kind === "admin_api_preflight", "classify preflight");
  c.ok(cls(`${origin}/storage/v1/object/media/venues/a.png`, "POST").kind === "storage_write" && cls(`${origin}/storage/v1/object/media/venues/a.png`, "POST").touchesMedia, "classify direct media upload = storage_write");
  c.ok(cls(`${origin}/storage/v1/object/media/venues/a.png`, "PUT").kind === "storage_write", "classify PUT upsert = storage_write");
  c.ok(cls(`${origin}/storage/v1/object/media`, "DELETE").kind === "storage_write", "classify bulk delete = storage_write");
  c.ok(cls(`${origin}/storage/v1/upload/resumable`, "POST").kind === "storage_write", "classify TUS = storage_write");
  c.ok(cls(good, "GET").kind === "storage_public_read", "classify public read");
  c.ok(cls(`${origin}/rest/v1/venues?on_conflict=id`, "POST").kind === "rest_write", "classify venue upsert = rest_write");
  c.ok(cls(`${origin}/rest/v1/venues?select=*`, "GET").kind === "rest_read", "classify rest read");
  c.ok(cls(`${origin}/rest/v1/rpc/is_current_user_admin`, "POST").kind === "rest_rpc", "classify rpc");
  c.ok(cls("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", "GET").kind === "external", "classify external");
  // multipart parse on a real browser-like body (undici FormData)
  const fd = new FormData();
  fd.append("action", "media_upload"); fd.append("prefix", "venues"); fd.append("file", new Blob([png], { type: "image/png" }), "s1.png");
  const rq = new Request("https://x.invalid/", { method: "POST", body: fd });
  const ct = rq.headers.get("content-type");
  const mp = parseMultipart(ct, Buffer.from(await rq.arrayBuffer()));
  c.ok(mp.ok && mp.parts.map((p) => p.name).join(",") === "action,prefix,file", "parseMultipart field order");
  c.ok(mp.ok && sha256hex(mp.parts[2].data) === sha256hex(png) && mp.parts[2].contentType === "image/png", "parseMultipart file bytes/ctype");
  c.ok(!parseMultipart("multipart/form-data", Buffer.from("x")).ok, "parseMultipart no boundary → not ok");
  // static checks on repo copy of live admin page (+ injected faults must be caught)
  const html = readFileSync(join(REPO_ROOT, "CDP3B/admin.html"), "utf8");
  const st = staticCheckAdminHtml(html);
  c.ok(st.every((x) => x.ok), "static checks PASS on repo CDP3B/admin.html: " + st.filter((x) => !x.ok).map((x) => x.id).join(","));
  const cfg = discoverConfig(html);
  c.ok(cfg.ok && cfg.fnDecl && cfg.key.ok && cfg.key.kind === "anon_jwt", "discoverConfig on repo admin.html (anon key role=anon)");
  const faults = {
    content_type_set: html.replace('headers:{"apikey":CFG.key,"Authorization":"Bearer "+session.access_token},body:fd', 'headers:{"apikey":CFG.key,"Content-Type":"multipart/form-data","Authorization":"Bearer "+session.access_token},body:fd'),
    storage_fallback: html.replace("return d.public_url;", 'try{await authClient.storage.from("media").upload("venues/x.png",file);}catch(_){}\n  return d.public_url;'),
    extra_field: html.replace('fd.append("file",file);', 'fd.append("file",file);\n  fd.append("path","venues/x.png");'),
    consumes_path: html.replace("return d.public_url;", "return d.path||d.public_url;"),
    no_prefix_guard: html.replace('if(prefix!=="venues"&&prefix!=="ads"){ const e=new Error(uploadErrMsg(-1)); e.code=-1; throw e; }', ""),
  };
  for (const [k, h] of Object.entries(faults)) { c.ok(h !== html, `fault applied: ${k}`); c.ok(!staticCheckAdminHtml(h).every((x) => x.ok), `fault detected: ${k}`); }
  // redaction / leak guard (fixtures built at runtime from parts; no literal secrets in this file)
  const J = "ey" + "J";
  const fakeJwt = `${J}hbGciOiJIUzI1NiJ9.${J}yb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlZmFrZQ`;
  const r = makeRedactor(["hunter2-not-real", fakeJwt]);
  const s = r(`Authorization: Bearer ${fakeJwt} pw=hunter2-not-real mail=someone@example.test`);
  c.ok(!s.includes(fakeJwt) && !s.includes("hunter2-not-real") && !s.includes("someone@example.test"), "redactor strips token/pw/email");
  c.ok(findLeaks(`{"a":"${fakeJwt}"}`).includes("jwt"), "leak guard detects JWT");
  c.ok(findLeaks('{"a":"x"}', ["hunter2-not-real"]).length === 0, "leak guard clean on clean JSON");
  let threw = false; try { writeJsonGuarded("/nonexistent-dir-s1/x.json", { t: fakeJwt }); } catch (e) { threw = /output_leak_guard/.test(e.message); }
  c.ok(threw, "writeJsonGuarded refuses secret-bearing output");
  const td = mkdtempSync(join(tmpdir(), "s1-selftest-"));
  try {
    writeJsonGuarded(join(td, "e.json"), { v: 1 }, [], { exclusive: true });
    let eex = false; try { writeJsonGuarded(join(td, "e.json"), { v: 2 }, [], { exclusive: true }); } catch (e) { eex = e && e.code === "EEXIST"; }
    c.ok(eex && JSON.parse(readFileSync(join(td, "e.json"), "utf8")).v === 1, "exclusive writeJsonGuarded never overwrites existing evidence (EEXIST)");
  } finally { rmSync(td, { recursive: true, force: true }); }
  c.ok(classifyGone(400) === "GONE" && classifyGone(404) === "GONE" && classifyGone(200) === "STILL_SERVED" && classifyGone(500) === "UNEXPECTED", "verify-gone classification");
  c.ok(classifyPublicKey(`${J}hbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.sig`).kind === "service_role_jwt", "service_role key detected");
  const res = c.done();
  return res.fail === 0 ? 0 : 1;
}

/** Post-cleanup check: the public URL must no longer serve the object (400/404). Read-only GET with cache-buster. */
export function classifyGone(status) {
  if (status === 400 || status === 404) return "GONE";
  if (status === 200) return "STILL_SERVED";
  return "UNEXPECTED";
}
async function verifyGone(outDir = defaultOutDir()) {
  let ref;
  try { ref = JSON.parse(readFileSync(join(outDir, REF_FILE), "utf8")); } catch (_) { console.log(`S1_VERIFY_GONE: ${REF_FILE} not found in out dir`); return 2; }
  const v = validatePublicUrl(ref.public_url, { supabaseOrigin: new URL(ref.public_url).origin });
  if (!v.ok) { console.log(`S1_VERIFY_GONE: stored URL failed validation (${v.errors.join(",")}); refusing to fetch`); return 2; }
  const url = `${ref.public_url}?s1cb=${Date.now().toString(36)}`;
  let status = null;
  try { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) }); status = r.status; await r.arrayBuffer().catch(() => {}); }
  catch (e) { console.log(`S1_VERIFY_GONE: network error ${String(e.message).split("\n")[0]}`); return 1; }
  const verdict = classifyGone(status);
  const out = { schema: "s1_verify_gone.v1", at: nowIso(), public_url_masked: maskPublicUrl(ref.public_url), status, verdict, note: verdict === "STILL_SERVED" ? "SQL (snapshot P1/P2) is authoritative; a 200 here can be CDN cache (cache-control max-age=3600). Re-check read-only after >= 3600 s." : null };
  writeJsonGuarded(join(outDir, GONE_FILE), out);
  console.log(`S1_VERIFY_GONE verdict=${verdict} status=${status} url=${out.public_url_masked}`);
  return verdict === "GONE" ? 0 : 1;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) process.exit(await selftest());
  if (argv.includes("--verify-gone")) process.exit(await verifyGone());
  const mode = argv.includes("--preflight") ? "preflight" : argv.includes("--runtime") ? "runtime" : "full";
  const { code } = await runAcceptance({ mode });
  process.exit(code);
}
