// WP6 · regression: a trip's saved plan must not be replaced on a new device.
// TripSync.hydrate writes the DB plan to storage AFTER the page read dayVenues/calPlans/calNotes into memory;
// without a reload the Plan tab (ensurePlan → autoGeneratePlan) regenerates and autosave overwrites the DB plan.
// Static contract + a behavioural run of the page's own functions in a vm sandbox.
//   node --test WP6_package/tests/wp6_plan_hydrate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const HTML = readFileSync(new URL("../../amsterdam/index.html", import.meta.url), "utf8");

test("TripSync.hydrate reloads the in-memory plan state after writing storage", () => {
  const m = HTML.match(/TS\.hydrate=function\(t\)\{[\s\S]*?\};\n/);
  assert.ok(m, "TS.hydrate found");
  const body = m[0];
  const iWrite = body.indexOf("S('dayven'"), iReload = body.indexOf("__asaReloadPlanState()");
  assert.ok(iWrite > -1 && iReload > iWrite, "reload is called after the storage writes");
});

test("__asaReloadPlanState re-reads dayven/plan/cal and re-renders", () => {
  const m = HTML.match(/window\.__asaReloadPlanState=function\(\)\{([\s\S]*?)\n\};/);
  assert.ok(m, "reload function defined");
  for (const k of ['dayVenues=ASA_ST.get("dayven"', 'calPlans=ASA_ST.get("plan"', 'calNotes=ASA_ST.get("cal"', "renderPlanCtl()", "renderCal()"]) assert.ok(m[1].includes(k), k);
  assert.ok(HTML.indexOf("let CAL=buildCalDays();") < HTML.indexOf("window.__asaReloadPlanState=function"), "defined after CAL");
});

test("behaviour: stale empty memory + hydrate → ensurePlan keeps the saved plan (no autoGeneratePlan)", () => {
  const store = {};
  const ASA_ST = { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set: (k, v) => { store[k] = JSON.stringify(v); return true; } };
  const reload = HTML.match(/window\.__asaReloadPlanState=function\(\)\{[\s\S]*?\n\};/)[0];
  let generated = 0;
  const sb = { window: {}, ASA_ST, document: { getElementById: () => null }, renderPlanCtl() {}, renderCal() {}, renderDay() {},
    buildCalDays: () => ({ days: [{ key: "2099-01-10" }, { key: "2099-01-11" }] }), dayCur: null };
  vm.createContext(sb);
  vm.runInContext('var calNotes=ASA_ST.get("cal",{}), calPlans=ASA_ST.get("plan",{}), dayVenues=ASA_ST.get("dayven",{}), CAL=buildCalDays();', sb);  // page boot: device is empty
  vm.runInContext(reload, sb);
  sb.autoGeneratePlan = () => { generated++; };
  const saved = { "2099-01-10": ["a", "b", "c"], "2099-01-11": ["d", "e", "f", "g"] };
  ASA_ST.set("dayven", saved); ASA_ST.set("plan", { "2099-01-10": "Sabah: a" }); ASA_ST.set("cal", {});   // TripSync.hydrate(t)
  vm.runInContext("window.__asaReloadPlanState()", sb);
  vm.runInContext("if(!CAL.days.some(D=>(dayVenues[D.key]||[]).length)) autoGeneratePlan(false);", sb);   // ensurePlan's decision
  assert.equal(generated, 0, "no regeneration");
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("dayVenues", sb))), saved, "memory holds the saved plan");
});
