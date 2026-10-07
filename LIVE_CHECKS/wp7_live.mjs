// ASALOCAL · WP7 LIVE LAUNCH CHECKS (anonymous, read-only, zero-footprint)
//
// Amsterdam TR V1 beta checklist items that are visible from the outside:
//   #2 canonical www · #3 page smoke · #4 Kopenhag stub + aliases · #5 no internal/personal leaks
//   #6 footer without '#' links · #7 no tracking without consent · beta labels (Kopenhag "hazırlanıyor")
// No login, no credentials, GET only. Config: WP7_BASE (default production) and WP7_REF (the git ref whose
// tree is the deployed one; every repo file outside the public allowlist must answer 3xx, never 200).
//
// Usage: node LIVE_CHECKS/wp7_live.mjs [--selftest]

import { execFileSync } from "node:child_process";

const BASE = (process.env.WP7_BASE || "https://www.asalocal.club").replace(/\/+$/, "");
const REF = process.env.WP7_REF || "origin/main";
const results = [];
const rec = (id, pass, detail) => results.push({ id, result: pass === null ? "SKIP" : pass ? "PASS" : "FAIL", detail: String(detail).slice(0, 300) });

// Files that are meant to be served as-is. Everything else in the tree is internal.
export const PUBLIC_FILES = [
  /^index\.html$/, /^amsterdam\/index\.html$/, /^kopenhag\/index\.html$/, /^amsterdam\.html$/,
  /^CDP3B\/admin\.html$/, /^CDP3B\/vendor\/grapesjs\/[^/]+$/, /^decision_contract\.js$/,
  /^lib\/asa-name\/asa_name\.js$/, /^lib\/asa-storage\/asa_storage\.js$/,
  /^ad_(970x250|728x90|320x100)\.jpg$/, // referenced by live DB ads (owner decision pending)
  /^CNAME$/, /^\.nojekyll$/, /^_redirects$/, /^_headers$/, /^robots\.txt$/,
  /^admin\.html$/, // shadowed by the /admin.html 302
];
export const isPublic = (f) => PUBLIC_FILES.some((re) => re.test(f));
// Leak patterns: personal plan, voice-note/whisper tooling, file paths, owner-only notes, internal source labels.
export const LEAK_RE = /senin notun|kontrol et\b|kontrol edilmeli|senin verdiğin|ses kaydı|önceki araştırmam|ek araştırma|benim listem|whatsapp|whisper|huggingface|file:\/\/|11[–-]31 temmuz/i;
export const TRACKER_RE = /(^|\.)(cloudflareinsights\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.(com|net)|hotjar\.(com|io)|clarity\.ms|segment\.(io|com)|mixpanel\.com|amplitude\.com|tiktok\.com)$/i;

function tree() {
  return execFileSync("git", ["ls-tree", "-r", "--name-only", REF], { maxBuffer: 16 << 20 }).toString("utf8").split("\n").filter(Boolean);
}
const enc = (f) => "/" + f.split("/").map(encodeURIComponent).join("/");

async function checkInternalPaths() {
  const files = tree().filter((f) => !isPublic(f));
  let served = [];
  const q = files.slice();
  const worker = async () => {
    for (let f; (f = q.shift()) !== undefined;) {
      const r = await fetch(BASE + enc(f), { redirect: "manual" }).catch((e) => ({ status: 0, headers: new Headers(), e }));
      if (!(r.status >= 300 && r.status < 400)) served.push(`${r.status} /${f}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  rec(`internal files not served (${files.length} repo files outside the public allowlist -> 3xx)`, files.length > 0 && served.length === 0,
    served.length ? served.slice(0, 8).join(" | ") : `all ${files.length} redirected`);
  for (const p of ["/amsterdam_index_UID.html", "/amsterdam_index_UID"]) {
    const r = await fetch(BASE + p, { redirect: "manual" });
    const loc = r.headers.get("location") || "";
    rec(`legacy personal page ${p} -> 301 /amsterdam/`, r.status === 301 && new URL(loc, BASE).pathname === "/amsterdam/", `http=${r.status} location=${loc || "-"}`);
  }
  for (const [p, to] of [["/copenhagen", "/kopenhag/"], ["/copenhagen/", "/kopenhag/"], ["/kopenhag.html", "/kopenhag/"], ["/copenhagen.html", "/kopenhag/"], ["/admin", "/CDP3B/admin.html"]]) {
    const r = await fetch(BASE + p, { redirect: "manual" });
    const loc = r.headers.get("location") || "";
    const strip = (x) => x.replace(/\.html$/, "");
    rec(`alias ${p} -> ${to}`, [301, 302, 307, 308].includes(r.status) && strip(new URL(loc, BASE).pathname) === strip(to), `http=${r.status} location=${loc || "-"}`);
  }
}

async function checkHeaders() {
  let r = await fetch(BASE + "/");
  rec("headers: / nosniff + referrer policy", r.headers.get("x-content-type-options") === "nosniff" && /strict-origin-when-cross-origin/.test(r.headers.get("referrer-policy") || ""),
    `xcto=${r.headers.get("x-content-type-options")} rp=${r.headers.get("referrer-policy")}`);
  r = await fetch(BASE + "/CDP3B/admin.html", { redirect: "follow" });
  rec("headers: admin noindex + no framing", /noindex/.test(r.headers.get("x-robots-tag") || "") && (r.headers.get("x-frame-options") || "").toUpperCase() === "DENY",
    `xrt=${r.headers.get("x-robots-tag")} xfo=${r.headers.get("x-frame-options")}`);
}

async function checkBrowser() {
  let pw;
  try { pw = await import("playwright"); } catch { rec("browser", null, "playwright not installed"); return; }
  const browser = await pw.chromium.launch();
  try {
    for (const path of ["/", "/amsterdam/", "/kopenhag/"]) {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await ctx.newPage();
      const hosts = new Set(); const trackers = []; const cdnCgi = [];
      page.on("request", (q) => {
        const u = new URL(q.url());
        if (!/^https?:$/.test(u.protocol)) return;
        hosts.add(u.host);
        if (TRACKER_RE.test(u.hostname)) trackers.push(u.host + u.pathname);
        if (u.pathname.startsWith("/cdn-cgi/") && !/\/cdn-cgi\/(challenge-platform|l\/chk_jschl)/.test(u.pathname)) cdnCgi.push(u.pathname);
      });
      await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => {
        const txt = document.body ? document.body.innerText : "";
        const canon = document.querySelector('link[rel="canonical"]');
        const hashLinks = [...document.querySelectorAll('a[href="#"], a[href=""]')].filter((a) => a.offsetParent !== null).length;
        const footer = document.querySelector("footer");
        const footerHash = footer ? [...footer.querySelectorAll("a")].filter((a) => /^#?$/.test(a.getAttribute("href") || "")).length : 0;
        const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
        return { txt, canon: canon ? canon.href : null, hashLinks, footerHash, hasFooter: !!footer, scripts };
      }).catch((e) => ({ err: String(e.message) }));
      const leak = (info.txt || "").match(LEAK_RE);
      rec(`page ${path}: no internal/personal text in the rendered page`, !info.err && !leak, leak ? `hit="${leak[0]}"` : (info.err || "clean"));
      rec(`page ${path}: no tracker hosts (consent-free)`, trackers.length === 0 && cdnCgi.length === 0, (trackers.concat(cdnCgi)).slice(0, 5).join(" | ") || `hosts=${[...hosts].sort().join(",")}`);
      // The Kopenhag stub is byte-pinned by the WP3/WP4/WP5 gates and stays as is (no canonical); / and /amsterdam/ carry one.
      if (path !== "/kopenhag/") rec(`page ${path}: canonical on www`, (info.canon || "").startsWith("https://www.asalocal.club" + path), `canonical=${info.canon || "-"}`);
      rec(`page ${path}: no visible '#' links, footer links real`, info.hashLinks === 0 && info.footerHash === 0, `visible#=${info.hashLinks} footer#=${info.footerHash} footer=${info.hasFooter}`);
      if (path === "/") {
        const t = info.txt || "";
        rec("home: Amsterdam active, Kopenhag marked 'hazırlanıyor'", /Amsterdam/.test(t) && /Kopenhag[^\n]{0,60}hazırlanıyor|hazırlanıyor[^\n]{0,60}Kopenhag/i.test(t), (t.match(/Kopenhag[^\n]{0,60}/) || ["-"])[0]);
        rec("home: no 'Kopenhag'ı keşfet' active CTA", !/Kopenhag.?ı keşfet/i.test(t), "ok");
        rec("home: visible Beta label", /\bBeta\b/.test(t), "ok");
      }
      if (path === "/kopenhag/") rec("kopenhag stub says 'hazırlanıyor'", /hazırlanıyor/i.test(info.txt || ""), "ok");
      await ctx.close();
    }
    // The fake confirmation for 'Yakında' cities must be gone: no element on home carries that copy.
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    const html = await page.content();
    rec("home: no false 'İlgin kaydedildi' promise in the page", !/İlgin kaydedildi/.test(html), "ok");
    await ctx.close();
  } finally { await browser.close(); }
}

function selftest() {
  const ok = [
    isPublic("index.html") && isPublic("CDP3B/vendor/grapesjs/grapes.min.js") && !isPublic("CDP3B/CDP3B_up.sql") && !isPublic("amsterdam_index_UID.html"),
    !isPublic("lib/asa-storage/asa_storage.test.mjs") && !isPublic("CDP3B/edge/admin-api/index.ts") && !isPublic("SHA256SUMS"),
    LEAK_RE.test("Senin notun: harika") && LEAK_RE.test("İki WhatsApp ses kaydı") && LEAK_RE.test("file:///x") && !LEAK_RE.test("Amsterdam kanal turu"),
    TRACKER_RE.test("static.cloudflareinsights.com") && TRACKER_RE.test("www.googletagmanager.com") && !TRACKER_RE.test("tosqsabuaomgqjtogdrn.supabase.co"),
    enc("CDP3B/a b.md") === "/CDP3B/a%20b.md",
  ];
  console.log(JSON.stringify({ selftest: ok.every(Boolean) ? "PASS" : "FAIL", checks: ok }));
  process.exit(ok.every(Boolean) ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else {
  for (const step of [checkInternalPaths, checkHeaders, checkBrowser]) {
    try { await step(); } catch (e) { rec(`step-error:${step.name}`, false, String(e && e.message)); }
  }
  const fail = results.filter((r) => r.result === "FAIL").length;
  console.log("WP7_LIVE_SUMMARY " + JSON.stringify({ ran_at: new Date().toISOString(), base: BASE, ref: REF, total: results.length, pass: results.filter((r) => r.result === "PASS").length, fail, skip: results.filter((r) => r.result === "SKIP").length }));
  for (const r of results) console.log(`${r.result.padEnd(4)} ${r.id} :: ${r.detail}`);
  process.exit(fail ? 1 : 0);
}
