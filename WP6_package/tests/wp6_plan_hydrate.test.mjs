// WP6 · regression: a trip's saved plan must not be replaced on a new device.
// TripSync.hydrate writes the DB plan to storage AFTER the page read dayVenues/calPlans/calNotes into memory;
// without a reload the Plan tab (ensurePlan → autoGeneratePlan) regenerates and autosave overwrites the DB plan.
// Static contract + a behavioural run of the page's own functions (real CALENDAR block, real buildCalDays) in a vm sandbox.
// Signatures since the WP6 sync-integrity fix: TS.hydrate(t,o) and window.__asaReloadPlanState(mem).
//   node --test WP6_package/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { boot, fakeStorage, read, J } from "./_page.mjs";

const HTML = read("amsterdam/index.html");

test("TripSync.hydrate reloads the in-memory plan state after writing storage", () => {
  const i = HTML.indexOf("TS.hydrate=function(t,o){");
  assert.ok(i > 0, "TS.hydrate(t,o) found");
  const body = HTML.slice(i, HTML.indexOf("\n  TS.", i + 10));
  const iWrite = body.indexOf("S('dayven'"), iReload = body.indexOf("__asaReloadPlanState(");
  assert.ok(iWrite > -1 && iReload > iWrite, "reload is called after the storage writes");
});

test("__asaReloadPlanState re-reads dayven/plan/cal and re-renders", () => {
  const m = HTML.match(/window\.__asaReloadPlanState=function\(mem\)\{([\s\S]*?)\n\};/);
  assert.ok(m, "reload function defined");
  for (const k of ['dayVenues=ASA_ST.get("dayven"', 'calPlans=ASA_ST.get("plan"', 'calNotes=ASA_ST.get("cal"', "renderPlanCtl()", "renderCal()"]) assert.ok(m[1].includes(k), k);
  assert.ok(HTML.indexOf("let CAL=buildCalDays();") < HTML.indexOf("window.__asaReloadPlanState=function"), "defined after CAL");
});

test("behaviour: stale empty memory + hydrate → ensurePlan keeps the saved plan (no autoGeneratePlan)", () => {
  // page boot on an empty device whose trip has dates: the real CALENDAR block reads empty dayven/plan/cal into memory
  const storage = fakeStorage({ "asa:ams:trip": JSON.stringify({ city: "Amsterdam", start_date: "2099-01-10", end_date: "2099-01-11" }) });
  const h = boot({ storage });
  assert.deepEqual(h.val("CAL.days.map(d=>d.key)"), ["2099-01-10", "2099-01-11"], "real buildCalDays from the trip dates");
  assert.deepEqual(h.val("dayVenues"), {});
  h.run("var __generated=0; autoGeneratePlan=function(){ __generated++; };");
  const saved = { "2099-01-10": ["a", "b", "c"], "2099-01-11": ["d", "e", "f", "g"] };
  storage.setItem("asa:ams:dayven", JSON.stringify(saved));                         // TripSync.hydrate wrote storage …
  storage.setItem("asa:ams:plan", JSON.stringify({ "2099-01-10": "Sabah: a" }));
  storage.setItem("asa:ams:cal", "{}");
  h.run("window.__asaReloadPlanState()");                                             // … and reloads memory
  h.run("if(!CAL.days.some(D=>(dayVenues[D.key]||[]).length)) autoGeneratePlan(false);");   // ensurePlan's decision
  assert.equal(h.run("__generated"), 0, "no regeneration");
  assert.deepEqual(h.val("dayVenues"), saved, "memory holds the saved plan");
  assert.deepEqual(J(h.sb.__renderCal.at(-1)), ["2099-01-10", "2099-01-11"], "calendar re-rendered");
});
