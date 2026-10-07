// ASALOCAL · WP5 LIVE CHECK — private first/last name + "Profilini tamamla" with the dedicated QA member.
//
// Runs inside the QA runner (passwords only in $RUNNER_TEMP/qa_secrets.env, masked). Target: ASALOCAL_BASE_URL.
// Operator preconditions (SQL, QA member only): first_name/last_name NULL and display_name = DISPLAY_MARK.
// Server-side writes, all on the QA member's own row: one rejected direct PATCH (CHECK 23514), rejected
// member_set_name calls, then one valid name save + one edit. The operator resets the names to NULL afterwards.
//
// Exit 0 PASS, 1 FAIL. Prints one JSON summary + one line per check. Never prints e-mails or tokens.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const BASE = (process.env.ASALOCAL_BASE_URL || "https://www.asalocal.club").replace(/\/+$/, "");
const SECRETS = join(process.env.RUNNER_TEMP || "/tmp", "qa_secrets.env");
const DISPLAY_MARK = "QA Görünen Ad";
const OK_TEXT = "Adın ve soyadın kaydedildi.";
const out = [];
const rec = (id, pass, detail = "") => out.push({ id, result: pass ? "PASS" : "FAIL", detail: String(detail).replace(/[^\s@]+@[^\s@]+/g, "<email>").slice(0, 160) });

function secrets() {
  const o = {};
  for (const l of readFileSync(SECRETS, "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
  return o;
}
// playwright lives in $QA_DEPS (installed outside the checkout), same as qa_runner.mjs
const { chromium } = createRequire(join(process.env.QA_DEPS || process.cwd(), "noop.js"))("playwright");
const browser = await chromium.launch();
const EMAIL = process.env.ASALOCAL_MEMBER_EMAIL;
const PW = secrets().ASALOCAL_MEMBER_PASSWORD;

const VP = { desktop: { viewport: { width: 1366, height: 900 } }, mobile390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } };

async function ctxFor(vp) {
  const ctx = await browser.newContext(VP[vp]);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${String(e.message).slice(0, 100)}`));
  // deliberate negative requests (e.g. the CHECK-violating PATCH → 400) are logged by Chromium as "Failed to load
  // resource"; only those, and only inside an expectNetErr() window, are excluded from the console-error count
  const st = { expect: 0, excused: [] };
  page.on("console", (m) => { if (m.type() !== "error") return; const t = m.text().slice(0, 100); if (st.expect > 0 && /^Failed to load resource: the server responded with a status of 4\d\d/.test(t)) { st.excused.push(t); return; } errs.push(t); });
  page.__wp5 = st;
  return { ctx, page, errs };
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const activeId = (page) => page.evaluate(() => (document.activeElement && document.activeElement.id) || "");
const homeBanner = (page) => page.evaluate(() => {
  const b = document.getElementById("namePrompt");
  return { visible: !!b && !b.hidden && b.offsetParent !== null && b.getBoundingClientRect().height > 0, inputs: document.querySelectorAll("#namePrompt input").length,
           modal: !!(b && (b.getAttribute("aria-modal") || b.getAttribute("role") === "dialog")), focusInside: !!(b && b.contains(document.activeElement)),
           done: (document.getElementById("namePromptDone") || {}).textContent || "", err: (document.getElementById("npErr") || {}).textContent || "", ok: (document.getElementById("npOk") || {}).textContent || "" };
});
const cityBanner = (page) => page.evaluate(() => {
  const b = document.getElementById("asaNamePrompt");
  return { visible: !!b && !b.classList.contains("hide") && b.offsetParent !== null, inputs: document.querySelectorAll("#asaNamePrompt input").length, focusInside: !!(b && b.contains(document.activeElement)) };
});
const injected = (page) => page.evaluate(() => ({ img: document.querySelectorAll('img[src="x"], img[src$="/x"]').length, flag: window.__wp5xss === undefined ? null : window.__wp5xss }));
const val = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return e ? e.value : null; }, id);
// own row through the page's own authenticated client (RLS self-select)
const ownRow = (page) => page.evaluate(async () => { try { const cli = (typeof window.asaDB === "function" && window.asaDB()) || (typeof db !== "undefined" ? db : null); const { data: s } = await cli.auth.getSession(); const uid = s && s.session && s.session.user && s.session.user.id; const r = await cli.from("members").select("first_name,last_name,display_name").eq("user_id", uid).maybeSingle(); return r.error ? { error: r.error.code || r.error.message } : (r.data || { none: true }); } catch (e) { return { error: String(e && e.message) }; } });

async function openHome(page) {
  await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: "load", timeout: 45000 });
  await page.waitForFunction(() => typeof ASA_DLG !== "undefined" && document.getElementById("countrySel") && document.getElementById("countrySel").options.length > 1, null, { timeout: 20000 });
  await page.waitForTimeout(600);
}
async function openCity(page) {
  await page.goto(`${BASE}/amsterdam/?city=Amsterdam&cb=${Date.now()}`, { waitUntil: "load", timeout: 45000 });
  await page.waitForFunction(() => window.ASA && typeof window.ASA.seg === "function" && window.ASA_ST, null, { timeout: 20000 });
  await page.waitForTimeout(800);
}
async function waitMemberHome(page) { await page.waitForFunction(() => /^Hesabım: /.test(document.getElementById("acctBtn")?.getAttribute("aria-label") || ""), null, { timeout: 20000 }).catch(() => {}); }
async function waitNameRead(page, sel) { await page.waitForFunction((s) => !!document.querySelector(s), sel, { timeout: 12000 }).catch(() => {}); await page.waitForTimeout(400); }
async function loginHome(page) {
  await page.click("#acctBtn"); await page.waitForSelector("#amEmail");
  await page.fill("#amEmail", EMAIL); await page.fill("#amPw", PW); await page.click("#amAuth");
  await waitMemberHome(page);
  if (await page.evaluate(() => ASA_DLG.isOpen(document.getElementById("authModal")))) { await page.keyboard.press("Escape"); await page.waitForTimeout(250); }
}
async function loginCity(page) {
  await page.evaluate(() => go("member")); await page.waitForSelector("#asaEmail");
  await page.fill("#asaEmail", EMAIL); await page.fill("#asaPw", PW); await page.click("#asaAuthBtn");
  await page.waitForFunction(() => !!(window.ASA && window.ASA.session), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
}
async function logoutHome(page) {
  await openHome(page); await waitMemberHome(page);
  await page.click("#acctBtn"); await page.click("#acctMenu [data-acct=logout]");
  await page.waitForFunction(() => /Giriş yap/.test(document.getElementById("acctBtn")?.getAttribute("aria-label") || ""), null, { timeout: 15000 }).catch(() => {});
}
async function saveVia(page, prefix, first, last) {
  await page.fill(`#${prefix}First`, first); await page.fill(`#${prefix}Last`, last);
  await page.click(`#${prefix}Save`);
  await page.waitForFunction((p) => (document.getElementById(p + "Ok")?.textContent || "").length > 0 || (document.getElementById(p + "Err")?.textContent || "").length > 0 || !document.getElementById(p + "Save"), prefix, { timeout: 15000 }).catch(() => {});
  return page.evaluate((p) => ({ ok: document.getElementById(p + "Ok")?.textContent || "", err: document.getElementById(p + "Err")?.textContent || "", gone: !document.getElementById(p + "Save") }), prefix);
}

// ---- A) mobile 390, city page first: banner shows for a member without a name; "Şimdi değil" persists across pages
{
  const { ctx, page, errs } = await ctxFor("mobile390");
  const P = "mobile390";
  try {
    await openCity(page);
    let c = await cityBanner(page);
    rec(`${P} city anon: no banner, no name fields`, !c.visible && c.inputs === 0, JSON.stringify(c));
    await loginCity(page);
    await waitNameRead(page, "#asaNamePrompt:not(.hide) #asaNpFirst");
    c = await cityBanner(page);
    rec(`${P} city member without name: banner visible with Ad/Soyad`, c.visible && c.inputs === 2, JSON.stringify(c));
    rec(`${P} city banner does not steal focus`, !c.focusInside);
    rec(`${P} city banner: no horizontal overflow`, await noOverflow(page));
    const r = await ownRow(page);
    rec(`${P} precondition: names empty, display_name = operator marker (login did not overwrite it)`, r.first_name === null && r.last_name === null && r.display_name === DISPLAY_MARK, JSON.stringify({ f: r.first_name, l: r.last_name, dn_is_mark: r.display_name === DISPLAY_MARK, err: r.error || null }));
    await page.click("#asaNpLater"); await page.waitForTimeout(400);
    c = await cityBanner(page);
    rec(`${P} city "Şimdi değil" hides the banner`, !c.visible);
    await openCity(page); await page.waitForTimeout(1500);
    rec(`${P} city: dismissed banner stays hidden after reload`, !(await cityBanner(page)).visible);
    await openHome(page); await waitMemberHome(page); await page.waitForTimeout(1500);
    rec(`${P} home: dismissed on the city page → hidden on home too`, !(await homeBanner(page)).visible);
    await logoutHome(page);
    rec(`${P} logout: back to anonymous`, /Giriş yap/.test((await page.getAttribute("#acctBtn", "aria-label")) || ""));
    rec(`${P} console errors 0`, errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) { rec(`${P} scenario error`, false, String(e && e.message)); }
  await ctx.close();
}

// ---- B) desktop, home: fresh device (no dismissal flag) → banner; client + server rejection; real save; persistence
{
  const { ctx, page, errs } = await ctxFor("desktop");
  const P = "desktop";
  try {
    await openHome(page);
    let b = await homeBanner(page);
    rec(`${P} home anon: no banner`, !b.visible && b.inputs === 0, JSON.stringify(b));
    await loginHome(page);
    await waitNameRead(page, "#namePrompt:not([hidden]) #npFirst");
    b = await homeBanner(page);
    rec(`${P} home member without name (new device): banner visible`, b.visible && b.inputs === 2, JSON.stringify(b));
    rec(`${P} home banner is not a dialog and does not steal focus`, !b.modal && !b.focusInside);
    // client-side rejection
    let s = await saveVia(page, "np", "<img src=x onerror=window.__wp5xss=1>", "Test");
    let inj = await injected(page);
    rec(`${P} XSS payload rejected (role=alert), nothing injected`, s.err.length > 0 && s.ok === "" && inj.img === 0 && inj.flag === null, JSON.stringify({ err: s.err.slice(0, 60), inj }));
    rec(`${P} Ad/Soyad inputs carry maxlength=50`, (await page.getAttribute("#npFirst", "maxlength")) === "50" && (await page.getAttribute("#npLast", "maxlength")) === "50");
    await page.evaluate(() => { document.getElementById("npFirst").value = "a".repeat(51); document.getElementById("npLast").value = "Test"; });
    await page.click("#npSave");
    await page.waitForFunction(() => (document.getElementById("npErr")?.textContent || "").length > 0 || (document.getElementById("npOk")?.textContent || "").length > 0 || !document.getElementById("npSave"), null, { timeout: 15000 }).catch(() => {});
    s = await page.evaluate(() => ({ ok: document.getElementById("npOk")?.textContent || "", err: document.getElementById("npErr")?.textContent || "" }));
    rec(`${P} 51-char name (pasted past maxlength) rejected`, s.err.length > 0 && s.ok === "", s.err.slice(0, 60));
    s = await saveVia(page, "np", "   ", "Test");
    rec(`${P} whitespace-only name rejected`, s.err.length > 0 && s.ok === "", s.err.slice(0, 60));
    // server-side rejection (bypass the client through the page's own authenticated client)
    const srv = await page.evaluate(async () => {
      const call = async (f, l) => { try { const r = await db.rpc("member_set_name", { p_first: f, p_last: l }); return r.error ? "ERR:" + (r.error.code || "") : (r.data && (r.data.reason || (r.data.ok ? "ok" : "?"))); } catch (e) { return "THROW"; } };
      return { script: await call("<script>", "Üye"), filler: await call("ㅤ", "Üye"), long: await call("a".repeat(51), "Üye"), empty: await call("", "Üye"), digits: await call("Qa1", "Üye") };
    });
    rec(`${P} server rejects bad names via member_set_name (script, U+3164, 51, empty, digit)`, srv.script === "bad_first" && srv.filler === "bad_first" && srv.long === "bad_first" && srv.empty === "bad_first" && srv.digits === "bad_first", JSON.stringify(srv));
    page.__wp5.expect++;
    const patch = await page.evaluate(async () => { try { const { data: s } = await db.auth.getSession(); const uid = s.session.user.id; const r = await db.from("members").update({ first_name: "<b>x</b>" }).eq("user_id", uid); return r.error ? (r.error.code || "err") : "accepted"; } catch (e) { return "THROW"; } });
    await page.waitForTimeout(300); page.__wp5.expect--;
    rec(`${P} direct PATCH of first_name with HTML → CHECK 23514`, patch === "23514", patch);
    rec(`${P} the deliberate PATCH produced exactly one excused 4xx console line`, page.__wp5.excused.length === 1, page.__wp5.excused.join(" | "));
    const anonEmail = await page.evaluate(async () => { try { const { data: s } = await db.auth.getSession(); const uid = s.session.user.id; await db.from("members").update({ email: "zz-wp5-live@example.invalid" }).eq("user_id", uid); const r = await db.from("members").select("email").eq("user_id", uid).maybeSingle(); return r.data ? (r.data.email === "zz-wp5-live@example.invalid" ? "changed" : "pinned") : "?"; } catch (e) { return "THROW"; } });
    rec(`${P} e-mail PATCH to another address is pinned by the guard`, anonEmail === "pinned", anonEmail);
    // valid save in the banner
    s = await saveVia(page, "np", "Qa", "Üye Test");
    b = await homeBanner(page);
    rec(`${P} valid save in banner → banner closes, status "${OK_TEXT}"`, !b.visible && b.done === OK_TEXT, JSON.stringify({ visible: b.visible, done: b.done, err: s.err }));
    let r = await ownRow(page);
    rec(`${P} own row: names stored (normalized), display_name unchanged`, r.first_name === "Qa" && r.last_name === "Üye Test" && r.display_name === DISPLAY_MARK, JSON.stringify({ f: r.first_name, l: r.last_name, dn_is_mark: r.display_name === DISPLAY_MARK, err: r.error || null }));
    // persistence + Profilim
    await openHome(page); await waitMemberHome(page); await page.waitForTimeout(1500);
    rec(`${P} reload: complete member sees no banner`, !(await homeBanner(page)).visible);
    await page.click("#acctBtn"); await page.click("#acctMenu [data-acct=profile]");
    await waitNameRead(page, "#amWp5Slot:not([hidden]) #profFirst");
    rec(`${P} Profilim shows the saved Ad/Soyad`, (await val(page, "profFirst")) === "Qa" && (await val(page, "profLast")) === "Üye Test");
    const outside = await page.evaluate(() => [...document.querySelectorAll("#authModal input, #authModal textarea")].filter((e) => !e.closest("#amWp5Slot")).length);
    rec(`${P} Profilim: no inputs outside the WP5 slot (WP4 contract)`, outside === 0, `outside=${outside}`);
    s = await saveVia(page, "prof", "Qa", "Üye");
    rec(`${P} Profilim edit saves (role=status), no error`, s.ok === OK_TEXT && s.err === "", JSON.stringify(s));
    r = await ownRow(page);
    rec(`${P} own row after edit`, r.first_name === "Qa" && r.last_name === "Üye", JSON.stringify({ f: r.first_name, l: r.last_name }));
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);
    await logoutHome(page);
    b = await homeBanner(page);
    rec(`${P} logout: banner and fields gone`, !b.visible && (await page.locator("#profFirst, #npFirst").count()) === 0);
    rec(`${P} console errors 0`, errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) { rec(`${P} scenario error`, false, String(e && e.message)); }
  await ctx.close();
}

// ---- C) desktop, city page on a fresh device: complete member → no banner; Kart shows the names
{
  const { ctx, page, errs } = await ctxFor("desktop");
  const P = "desktop city";
  try {
    await openCity(page);
    await loginCity(page);
    await page.waitForTimeout(1500);
    rec(`${P}: complete member sees no banner (not forced)`, !(await cityBanner(page)).visible);
    await page.evaluate(() => go("member"));
    await waitNameRead(page, "#asaPfFirst");
    rec(`${P}: Kart shows Ad/Soyad`, (await val(page, "asaPfFirst")) === "Qa" && (await val(page, "asaPfLast")) === "Üye");
    rec(`${P}: no horizontal overflow`, await noOverflow(page));
    await logoutHome(page);
    rec(`${P} console errors 0`, errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (e) { rec(`${P} scenario error`, false, String(e && e.message)); }
  await ctx.close();
}

// ---- D) anonymous privacy: names are not reachable through the public API
{
  const { ctx, page } = await ctxFor("desktop");
  try {
    await openHome(page);
    const priv = await page.evaluate(async () => {
      const q = async (t, c) => { try { const r = await db.from(t).select(c).limit(1); return r.error ? (r.error.code || "err") : "rows:" + (r.data || []).length; } catch (e) { return "THROW"; } };
      return { member_public: await q("member_public", "first_name"), comments_public: await q("comments_public", "last_name"), members: await q("members", "first_name"),
               rpc: await (async () => { try { const r = await db.rpc("member_set_name", { p_first: "Ayşe", p_last: "Kaya" }); return r.error ? (r.error.code || "err") : JSON.stringify(r.data); } catch (e) { return "THROW"; } })() };
    });
    rec("anon: member_public has no first_name (42703)", priv.member_public === "42703", priv.member_public);
    rec("anon: comments_public has no last_name (42703)", priv.comments_public === "42703", priv.comments_public);
    rec("anon: members not readable (42501)", priv.members === "42501", priv.members);
    rec("anon: member_set_name not executable (42501)", priv.rpc === "42501", priv.rpc);
  } catch (e) { rec("anon privacy scenario error", false, String(e && e.message)); }
  await ctx.close();
}
await browser.close();

const fail = out.filter((r) => r.result === "FAIL").length;
const res = { base: BASE, verdict: fail ? "FAIL" : "PASS", pass: out.length - fail, fail, checks: out };
writeFileSync(join(process.env.S1_OUT_DIR || ".", "wp5_live_result.json"), JSON.stringify(res, null, 2) + "\n");
console.log("WP5_LIVE_SUMMARY " + JSON.stringify({ base: BASE, total: out.length, pass: res.pass, fail, verdict: res.verdict }));
for (const r of out) console.log(`${r.result.padEnd(4)} ${r.id} :: ${r.detail}`);
process.exit(fail ? 1 : 0);
