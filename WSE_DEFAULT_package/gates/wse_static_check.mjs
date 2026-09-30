// Static checks only. No database and no production connection.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const read = (p) => readFileSync(p, "utf8");

function fail(msg) {
  console.error("FAIL " + msg);
  process.exit(1);
}

const upRaw = read(join(root, "WSE_up.sql"));
const activate = read(join(root, "WSE_ACTIVATE.sql"));
const down = read(join(root, "WSE_down_soft.sql"));
const up = upRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

if (/default_enabled\s*=/.test(up)) fail("up assigns default_enabled");
if (/update\s+public\.service_pref_defaults/i.test(up)) fail("up updates service_pref_defaults");
if (/email_enqueue|email_outbox|smtp/i.test(up)) fail("up mentions send path");
if (/admin_w_activate_welcome/.test(up)) fail("up references activation rpc");
if (/\b(insert\s+into|update|delete\s+from)\s+public\.(marketing_config|member_consent_)/i.test(up)) {
  fail("up writes marketing or consent tables");
}
for (const col of ["effective_from", "policy_version", "configured_at", "configured_by"]) {
  if (!up.includes(col)) fail("up missing column " + col);
}
if (!up.includes("not_configured")) fail("up missing not_configured");
if (!up.includes("auth.users")) fail("up missing auth.users boundary");
if (!/signup'::public\.consent_source/.test(up)) fail("up missing signup source");
if (!activate.includes("activation_refused_without_explicit_arm")) fail("activate missing arm guard");
if (!activate.includes("welcome_service_email.v1")) fail("activate missing policy version");
if (!/default_enabled\s*=\s*true/.test(activate)) fail("activate does not set the flag");
if (/email_enqueue|email_outbox/i.test(activate)) fail("activate mentions outbox");
if (!activate.includes("clock_timestamp()")) fail("activate does not pin effective_from to clock");
if (/delete\s+from\s+public\.member_service_pref/i.test(down)) fail("down deletes pref history");
if (/drop\s+table/i.test(down)) fail("down drops a table");
if (!/drop\s+trigger\s+if\s+exists\s+trg_members_seed_welcome_service_pref/i.test(down)) fail("down does not drop trigger");

const ui = read(join(repo, "amsterdam/index.html"));
if (!ui.includes('const pending=(v==="config_pending"); const on=(v===true);')) {
  fail("member UI predicate changed; not_configured display mapping must be re-checked");
}
const isOn = (v) => v === true;
const pending = (v) => v === "config_pending";
const label = (v) => (pending(v) ? "Varsayılan belirlenmedi" : isOn(v) ? "Açık" : "Kapalı");
if (label("not_configured") !== "Kapalı" || label(true) !== "Açık" || label(false) !== "Kapalı") {
  fail("UI label mapping");
}

console.log("PASS static_and_ui_mapping");
console.log("WSE_STATIC_PASS");
