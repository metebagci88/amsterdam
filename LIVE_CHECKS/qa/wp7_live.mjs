// ASALOCAL · WP7 LIVE CHECK (member view, READ-ONLY) — what a logged-in member sees on the Amsterdam beta.
//
// Runs inside the QA runner (password only in $RUNNER_TEMP/qa_secrets.env, masked). Target: ASALOCAL_BASE_URL.
// No writes: login, open the full venue list, read the rendered DOM, logout. Checks:
//   - full list (member) has no owner-only / internal text (Senin notun, kontrol et, Ses kaydı, Önceki araştırmam …)
//   - no Unsplash category images used as venue images (§2.6), no Instagram URLs as <img src>
//   - the source filter/legend shows no internal source names
//   - /amsterdam/?city=Kopenhag does not render Kopenhag venues as if the city were open
//   - a fresh visitor gets no pre-filled favourites (the owner's picks are not seeded)
// Exit 0 PASS, 1 FAIL. Prints one JSON summary + one line per check. Never prints e-mails or tokens.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const BASE = (process.env.ASALOCAL_BASE_URL || "https://www.asalocal.club").replace(/\/+$/, "");
const SECRETS = join(process.env.RUNNER_TEMP || "/tmp", "qa_secrets.env");
const out = [];
const rec = (id, pass, detail = "") => out.push({ id, result: pass ? "PASS" : "FAIL", detail: String(detail).replace(/[^\s@]+@[^\s@]+/g, "<email>").slice(0, 200) });
export const LEAK_RE = /senin notun|kontrol et\b|kontrol edilmeli|senin verdiğin|ses kaydı|önceki araştırmam|ek araştırma|benim listem|whatsapp|whisper|file:\/\//i;

function secrets() {
  const o = {};
  for (const l of readFileSync(SECRETS, "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
  return o;
}
const { chromium } = createRequire(join(process.env.QA_DEPS || process.cwd(), "noop.js"))("playwright");
const browser = await chromium.launch();
const EMAIL = process.env.ASALOCAL_MEMBER_EMAIL;
const PW = secrets().ASALOCAL_MEMBER_PASSWORD;

async function ctxFor() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${String(e.message).slice(0, 100)}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 100)); });
  return { ctx, page, errs };
}
const scan = (page) => page.evaluate(() => {
  const cards = document.getElementById("cards");
  const imgs = [...document.querySelectorAll("#cards img")].map((i) => i.getAttribute("src") || "");
  const srcOpts = [...document.querySelectorAll("#fSrc option")].map((o) => o.textContent.trim());
  return { n: cards ? cards.children.length : 0, text: cards ? cards.innerText : "", body: document.body.innerText, imgs, srcOpts,
           count: (document.getElementById("count") || {}).textContent || "" };
});

// ---- A) member: full list, read-only
{
  const { ctx, page, errs } = await ctxFor();
  try {
    await page.goto(BASE + "/amsterdam/", { waitUntil: "networkidle", timeout: 45000 });
    await page.evaluate(() => go("member")); await page.waitForSelector("#asaEmail");
    await page.fill("#asaEmail", EMAIL); await page.fill("#asaPw", PW); await page.click("#asaAuthBtn");
    await page.waitForFunction(() => !!(window.ASA && window.ASA.session), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    rec("member: logged in", await page.evaluate(() => !!(window.ASA && window.ASA.session)));
    await page.evaluate(() => go("list"));
    await page.waitForFunction(() => /Tüm mekânlar açık/.test((document.getElementById("count") || {}).textContent || ""), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const s = await scan(page);
    rec("member: full list rendered (more than the 10 teaser venues)", s.n > 10 && /Tüm mekânlar açık/.test(s.count), `cards=${s.n} count="${s.count}"`);
    const leak = (s.text.match(LEAK_RE) || [])[0];
    rec("member: no owner-only / internal text in venue cards", !leak, leak ? `hit="${leak}"` : `clean (${s.text.length} chars)`);
    const leakBody = (s.body.match(LEAK_RE) || [])[0];
    rec("member: no internal text anywhere on the page", !leakBody, leakBody ? `hit="${leakBody}"` : "clean");
    const uns = s.imgs.filter((u) => /images\.unsplash\.com/i.test(u)).length;
    rec("member: no Unsplash category images as venue images (§2.6)", uns === 0, `unsplash=${uns} of ${s.imgs.length} imgs`);
    const ig = s.imgs.filter((u) => /instagram\.com|cdninstagram|fbcdn/i.test(u)).length;
    rec("member: no Instagram URL as <img src>", ig === 0, `instagram=${ig}`);
    const badOpt = s.srcOpts.filter((t) => LEAK_RE.test(t));
    rec("member: source filter shows no internal source names", badOpt.length === 0, s.srcOpts.join(" / ") || "(no source filter)");
    // logout through the page's own client (no data written)
    await page.evaluate(async () => { try { await window.asaDB().auth.signOut(); } catch (e) {} try { localStorage.removeItem("asa_session"); } catch (e) {} });
    rec("member view console errors 0", errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) { rec("member scenario error", false, String(e && e.message)); }
  await ctx.close();
}

// ---- B) anonymous fresh visitor: no seeded favourites; ?city=Kopenhag does not open an unfinished city
{
  const { ctx, page, errs } = await ctxFor();
  try {
    await page.goto(BASE + "/amsterdam/", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1200);
    const fav = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("asa:ams:fav") || "[]").length; } catch (e) { return -1; } });
    rec("fresh visitor: no pre-filled favourites", fav === 0, `asa:ams:fav length=${fav}`);
    await page.goto(BASE + "/amsterdam/?city=Kopenhag", { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1500);
    const k = await page.evaluate(() => ({ path: location.pathname, cards: (document.getElementById("cards") || { children: [] }).children.length,
      cph: (typeof V !== "undefined" ? V : []).filter((v) => v && v.city === "Kopenhag").length, body: document.body.innerText.slice(0, 4000) }));
    rec("/amsterdam/?city=Kopenhag sends the visitor to the honest /kopenhag/ stub", k.path === "/kopenhag/", `path=${k.path} cards=${k.cards} cphVenues=${k.cph}`);
    rec("anon view console errors 0", errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) { rec("anon scenario error", false, String(e && e.message)); }
  await ctx.close();
}
await browser.close();

const fail = out.filter((r) => r.result === "FAIL").length;
const res = { base: BASE, verdict: fail ? "FAIL" : "PASS", pass: out.length - fail, fail, checks: out };
writeFileSync(join(process.env.S1_OUT_DIR || ".", "wp7_live_result.json"), JSON.stringify(res, null, 2) + "\n");
console.log("WP7_LIVE_SUMMARY " + JSON.stringify({ base: BASE, total: out.length, pass: res.pass, fail, verdict: res.verdict }));
for (const r of out) console.log(`${r.result.padEnd(4)} ${r.id} :: ${r.detail}`);
process.exit(fail ? 1 : 0);
