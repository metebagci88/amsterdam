// ASALOCAL · WP4 LIVE CHECK — member account menu with a real logged-in QA member.
//
// Runs inside the QA runner (passwords only in $RUNNER_TEMP/qa_secrets.env, masked).
// Target: ASALOCAL_BASE_URL (production or a Cloudflare preview). Read/navigate only:
// no preference toggles, no trip creation. The only server-side effects are the normal
// login session (closed with local sign-out) and the city/home pages' own profile upsert.
//
// Exit 0 PASS, 1 FAIL. Prints one JSON summary + one line per check.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const BASE = (process.env.ASALOCAL_BASE_URL || "https://www.asalocal.club").replace(/\/+$/, "");
const SECRETS = join(process.env.RUNNER_TEMP || "/tmp", "qa_secrets.env");
const out = [];
const rec = (id, pass, detail = "") => out.push({ id, result: pass ? "PASS" : "FAIL", detail: String(detail).slice(0, 160) });

function secrets() {
  const o = {};
  for (const l of readFileSync(SECRETS, "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
  return o;
}

// playwright lives in $QA_DEPS (installed outside the checkout), same as qa_runner.mjs
const { chromium } = createRequire(join(process.env.QA_DEPS || process.cwd(), "noop.js"))("playwright");
const browser = await chromium.launch();
const s = secrets();
const EMAIL = process.env.ASALOCAL_MEMBER_EMAIL;
const PW = s.ASALOCAL_MEMBER_PASSWORD;

const MENU = ["Profilim", "E-posta tercihlerim", "Kayıtlı seyahatlerim", "Yeni seyahat oluştur", "Çıkış yap"];

for (const vp of [{ name: "desktop", o: { viewport: { width: 1366, height: 900 } } }, { name: "mobile390", o: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }]) {
  const ctx = await browser.newContext(vp.o);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${String(e.message).slice(0, 100)}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 100)); });
  const vis = (sel) => page.locator(sel).first().isVisible().catch(() => false);
  const activeId = () => page.evaluate(() => document.activeElement && document.activeElement.id);
  const P = `${vp.name}`;
  try {
    await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(800);
    // ---- anonymous
    const anonLabel = await page.getAttribute("#acctBtn", "aria-label");
    rec(`${P} anon: account button label is login/signup`, /Giriş yap \/ üye ol/.test(anonLabel || ""), anonLabel);
    await page.click("#acctBtn");
    await page.waitForTimeout(300);
    rec(`${P} anon: login dialog opens (role=dialog)`, await vis("#authModal [role=dialog]") && await vis("#amEmail"));
    rec(`${P} anon: no private account menu`, !(await vis("#acctMenu [role=dialog]")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    rec(`${P} anon: ESC closes and focus returns to #acctBtn`, !(await vis("#authModal [role=dialog]")) && (await activeId()) === "acctBtn");
    // ---- login through the real UI
    await page.click("#acctBtn");
    await page.fill("#amEmail", EMAIL);
    await page.fill("#amPw", PW);
    await page.click("#amAuth");
    await page.waitForFunction(() => /Hesabım/.test(document.getElementById("acctBtn")?.getAttribute("aria-label") || ""), null, { timeout: 20000 }).catch(() => {});
    const inLabel = await page.getAttribute("#acctBtn", "aria-label");
    rec(`${P} login via UI: account button becomes "Hesabım: …"`, /^Hesabım: /.test(inLabel || ""), (inLabel || "").replace(/:.*/, ": ***"));
    // close whatever the login left open (Profilim)
    if (await vis("#authModal [role=dialog]")) { await page.keyboard.press("Escape"); await page.waitForTimeout(250); }
    // ---- menu: exactly the 5 items, opened with the keyboard
    await page.focus("#acctBtn");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const items = await page.locator("#acctMenu [data-acct]").allInnerTexts();
    rec(`${P} menu: exactly the 5 PRD items in order`, JSON.stringify(items.map((t) => t.trim())) === JSON.stringify(MENU), items.join(" | "));
    rec(`${P} menu: aria-expanded=true while open`, (await page.getAttribute("#acctBtn", "aria-expanded")) === "true");
    // Tab trap: 12 tabs stay inside the dialog
    let inside = true;
    for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); inside = inside && await page.evaluate(() => !!document.activeElement.closest("#acctMenu")); }
    rec(`${P} menu: Tab focus stays inside (trap)`, inside);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    rec(`${P} menu: ESC closes, focus back on #acctBtn`, !(await vis("#acctMenu [role=dialog]")) && (await activeId()) === "acctBtn");
    // ---- Profilim within 2 interactions, no trip needed
    await page.click("#acctBtn");
    await page.click("#acctMenu [data-acct=profile]");
    await page.waitForTimeout(500);
    const prof = await page.evaluate(() => ({ title: document.getElementById("authTitle")?.textContent, email: document.getElementById("amEmailRo")?.textContent || "", name: document.getElementById("amName")?.textContent || "", inputs: [...document.querySelectorAll("#authModal input, #authModal textarea")].filter((e) => !e.closest("#amWp5Slot")).length }));
    rec(`${P} Profilim: opens in 2 interactions (no trip)`, prof.title === "Profilim");
    rec(`${P} Profilim: e-mail shown read-only for this member`, prof.email === EMAIL && prof.inputs === 0, `inputs=${prof.inputs}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    // ---- E-posta tercihlerim
    await page.click("#acctBtn");
    await page.click("#acctMenu [data-acct=prefs]");
    await page.waitForFunction(() => (document.getElementById("prefsBody")?.textContent || "").length > 20 || (document.getElementById("prefsErr")?.textContent || "").length > 0, null, { timeout: 15000 }).catch(() => {});
    const pr = await page.evaluate(() => ({ body: document.getElementById("prefsBody")?.textContent || "", err: document.getElementById("prefsErr")?.textContent || "" }));
    rec(`${P} prefs: loaded without error`, pr.err.trim() === "" && pr.body.length > 20, pr.err);
    rec(`${P} prefs: unconfigured keys say "Varsayılan belirlenmedi"`, /Varsayılan belirlenmedi/.test(pr.body), pr.body.slice(0, 80));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    // ---- Kayıtlı seyahatlerim: empty state for a member with no trips
    await page.click("#acctBtn");
    await page.click("#acctMenu [data-acct=trips]");
    await page.waitForFunction(() => !/Yükleniyor/.test(document.getElementById("tripsList")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
    const tl = await page.evaluate(() => ({ list: document.getElementById("tripsList")?.textContent || "", err: document.getElementById("tripsErr")?.textContent || "", cta: !!document.getElementById("tripsEmptyNew") }));
    rec(`${P} trips: loads without error`, tl.err.trim() === "", tl.err);
    rec(`${P} trips: empty state mentions dates + CTA present`, /Henüz kayıtlı seyahatin yok/.test(tl.list) && /tarih/.test(tl.list) && tl.cta, tl.list.slice(0, 90));
    if (tl.cta) {
      await page.click("#tripsEmptyNew");
      await page.waitForTimeout(400);
      rec(`${P} trips: CTA closes dialog and focuses the search form`, !(await vis("#tripsModal [role=dialog]")) && (await activeId()) === "countrySel");
    }
    // ---- logout
    await page.click("#acctBtn");
    await page.click("#acctMenu [data-acct=logout]");
    await page.waitForFunction(() => /Giriş yap/.test(document.getElementById("acctBtn")?.getAttribute("aria-label") || ""), null, { timeout: 15000 }).catch(() => {});
    const after = await page.evaluate(() => ({ label: document.getElementById("acctBtn")?.getAttribute("aria-label"), sess: localStorage.getItem("asa_session"), focus: document.activeElement && document.activeElement.id }));
    rec(`${P} logout: back to anonymous, asa_session cleared, focus on #acctBtn`, /Giriş yap/.test(after.label || "") && after.sess === null && after.focus === "acctBtn");
    if (vp.name === "mobile390") rec(`${P} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    rec(`${P} console errors 0`, errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) {
    rec(`${P} scenario error`, false, String(e && e.message));
  }
  await ctx.close();
}
await browser.close();

const fail = out.filter((r) => r.result === "FAIL").length;
const res = { base: BASE, verdict: fail ? "FAIL" : "PASS", pass: out.length - fail, fail, checks: out };
writeFileSync(join(process.env.S1_OUT_DIR || ".", "wp4_live_result.json"), JSON.stringify(res, null, 2) + "\n");
console.log("WP4_LIVE_SUMMARY " + JSON.stringify({ base: BASE, total: out.length, pass: res.pass, fail, verdict: res.verdict }));
for (const r of out) console.log(`${r.result.padEnd(4)} ${r.id} :: ${r.detail}`);
process.exit(fail ? 1 : 0);
