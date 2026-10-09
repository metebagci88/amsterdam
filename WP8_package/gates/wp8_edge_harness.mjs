// WP8 Edge harness: bundles the REAL CDP3D_package/edge/service-email-dispatch/index.ts with
// esbuild and runs it against fakes only (fake supabase-js client, fake Deno, mocked fetch,
// instant timers, controllable clock). No network, no secrets, nothing is sent.
//   node WP8_package/gates/wp8_edge_harness.mjs [path/to/index.ts]
// Module resolution: WP8_NODE_MODULES (a node_modules dir) or WP8_package/gates/node_modules.
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WP8_ROOT || resolve(HERE, "..", "..");
const NM = process.env.WP8_NODE_MODULES || join(HERE, "node_modules");
const req = createRequire(join(NM, "_wp8_resolve.js"));
const { build } = req("esbuild");
const EXPECTED = 44;

const target = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "CDP3D_package/edge/service-email-dispatch/index.ts");
const fake = `export function createClient(){ return { rpc: (n,a)=>globalThis.__rpc(n,a) }; }`;
const res = await build({
  entryPoints: [target], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent",
  plugins: [{ name: "fake-supabase", setup(b) {
    b.onResolve({ filter: /^https:\/\/esm\.sh\// }, (a) => ({ path: a.path, namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: fake, loader: "js" }));
  } }],
});
const outFile = join(mkdtempSync(join(tmpdir(), "wp8edge-")), "bundle.mjs");
writeFileSync(outFile, res.outputFiles[0].text);

let handler; const env = {};
globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => env[k] } };
const delays = [];
globalThis.setTimeout = (fn, ms) => { delays.push(ms); queueMicrotask(fn); return 0; };
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
await import(pathToFileURL(outFile).href);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };
const jwt = (role) => "x." + Buffer.from(JSON.stringify({ role })).toString("base64url") + ".y";
const TOKEN = "t".repeat(40);
const SR = { authorization: "Bearer " + jwt("service_role") };
const TK = { authorization: "Bearer " + jwt("anon"), "x-asalocal-dispatch-token": TOKEN };

let fetches = [];
function setup({ rows = [], statuses = [], rpcError = {}, claimError = false, onFetch = null } = {}) {
  const calls = []; let si = 0; fetches = []; delays.length = 0; skew = 0;
  globalThis.__rpc = async (n, a) => {
    calls.push([n, a]);
    if (n === "email_claim_batch") return claimError ? { data: null, error: { message: "boom recipient@example.test" } } : { data: rows, error: null };
    const key = n + ":" + (a && a.p_outbox_id ? a.p_outbox_id : "");
    if (rpcError[key] || rpcError[n]) return { data: null, error: { message: "rpc failure" } };
    if (n === "welcome_enqueue_sweep") return { data: { ok: true, gate: "auto_disabled" }, error: null };
    if (n === "email_purge_expired_content") return { data: { ok: true, purged: 0 }, error: null };
    return { data: { ok: true }, error: null };
  };
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, init });
    if (onFetch) onFetch(fetches.length);
    const s = statuses[si++] ?? 200;
    if (s === "throw") throw new TypeError("network down");
    return new Response(s === 200 ? JSON.stringify({ id: "prov-" + si }) : "{}", { status: s, headers: s === 429 ? { "retry-after": "120" } : {} });
  };
  return calls;
}
const post = (h, body = {}) => handler(new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }));
const rowsN = (n) => Array.from({ length: n }, (_, k) => ({ outbox_id: "o" + (k + 1), recipient_email: "r" + (k + 1) + "@example.test", from_name: "A", from_email: "f@example.test", subject: "s", body_html: "<p>h</p>", body_text: "h", reply_to: "x@example.test" }));
const rpcs = (calls, n) => calls.filter(([m]) => m === n);
const arg0 = (calls, n) => ((rpcs(calls, n)[0] || [null, {}])[1]) || {};

// --- HTTP surface (same as cdp3d_edge_integration.sh: GET 405, no auth 403, anon 403, service_role no key 503)
Object.assign(env, { SUPABASE_URL: "http://local", SUPABASE_SERVICE_ROLE_KEY: "k", RESEND_API_KEY: "rk" });
ok("GET -> 405", (await handler(new Request("http://x/"))).status === 405);
setup(); ok("no auth -> 403", (await post({})).status === 403);
ok("anon JWT, DISPATCH_TRIGGER_TOKEN unset -> 403", (await post({ authorization: "Bearer " + jwt("anon") })).status === 403);
ok("anon JWT + token header, env token unset -> 403", (await post(TK)).status === 403);
env.DISPATCH_TRIGGER_TOKEN = "short";
ok("env token shorter than 32 disables the token path -> 403", (await post({ authorization: "Bearer " + jwt("anon"), "x-asalocal-dispatch-token": "short" })).status === 403);
env.DISPATCH_TRIGGER_TOKEN = TOKEN;
ok("wrong token -> 403", (await post({ authorization: "Bearer " + jwt("anon"), "x-asalocal-dispatch-token": "u".repeat(40) })).status === 403);
ok("token of a different length -> 403", (await post({ authorization: "Bearer " + jwt("anon"), "x-asalocal-dispatch-token": TOKEN + "x" })).status === 403);
let calls = setup(); ok("token ok -> 200", (await post(TK)).status === 200);
calls = setup(); ok("service_role -> 200", (await post(SR)).status === 200);
delete env.RESEND_API_KEY; setup();
ok("service_role, no RESEND_API_KEY -> 503", (await post(SR)).status === 503);
ok("token, no RESEND_API_KEY -> 503", (await post(TK)).status === 503);
env.RESEND_API_KEY = "rk";
delete env.DISPATCH_TRIGGER_TOKEN; setup();
ok("service_role still works with DISPATCH_TRIGGER_TOKEN unset", (await post(SR)).status === 200);
env.DISPATCH_TRIGGER_TOKEN = TOKEN;

// --- limits
calls = setup(); await post(TK, { limit: 50 });
ok("token path: limit capped at 10", arg0(calls, "email_claim_batch").p_limit === 10);
calls = setup(); await post(TK, { limit: 3 });
ok("token path: limit 3 honoured", arg0(calls, "email_claim_batch").p_limit === 3);
calls = setup(); await post(SR, { limit: 50 });
ok("service_role path: limit 50 honoured", arg0(calls, "email_claim_batch").p_limit === 50);

// --- 429: release (attempted) + release rest (not attempted), stop, no mark for them
calls = setup({ rows: rowsN(3), statuses: [200, 429, 200] });
let r = await post(SR); let j = await r.json();
ok("429: batch stops, sent=1 released=2 rate_limited", j.sent === 1 && j.released === 2 && j.rate_limited === true && j.stopped === "rate_limited");
ok("429: row 2 released as attempted with Retry-After 120", calls.some(([n, a]) => n === "email_release_claim" && a.p_outbox_id === "o2" && a.p_not_attempted === false && a.p_retry_after_seconds === 120));
ok("429: row 3 released as not attempted", calls.some(([n, a]) => n === "email_release_claim" && a.p_outbox_id === "o3" && a.p_not_attempted === true));
ok("429: no mark_result for rows 2 and 3", !calls.some(([n, a]) => n === "email_mark_result" && a.p_outbox_id !== "o1"));
ok("429: row 3 never sent to the provider", fetches.length === 2);
ok("response carries no address", !JSON.stringify(j).includes("@"));

// --- other statuses
calls = setup({ rows: rowsN(3), statuses: [500, 200, 200] }); j = await (await post(SR)).json();
ok("500 -> mark_result(false,'resend_500') and the batch continues", calls.some(([n, a]) => n === "email_mark_result" && a.p_outbox_id === "o1" && a.p_ok === false && a.p_error === "resend_500") && j.sent === 2 && j.failed === 1);
calls = setup({ rows: rowsN(3), statuses: [422, 200, 200] }); j = await (await post(SR)).json();
ok("422 -> mark_result(false,'resend_422') (terminal in DB), batch continues", calls.some(([n, a]) => n === "email_mark_result" && a.p_outbox_id === "o1" && a.p_error === "resend_422") && j.sent === 2);
for (const st of [401, 403]) {
  calls = setup({ rows: rowsN(3), statuses: [st, 200, 200] }); j = await (await post(SR)).json();
  ok(`${st} -> mark_result(false,'resend_${st}'), rest released not attempted, batch stops`,
    calls.some(([n, a]) => n === "email_mark_result" && a.p_outbox_id === "o1" && a.p_error === "resend_" + st)
    && rpcs(calls, "email_release_claim").length === 2 && rpcs(calls, "email_release_claim").every(([, a]) => a.p_not_attempted === true)
    && fetches.length === 1 && j.stopped === "provider_auth");
}
calls = setup({ rows: rowsN(2), statuses: ["throw", 200] }); j = await (await post(SR)).json();
ok("network error -> mark_result(false,'network_error')", calls.some(([n, a]) => n === "email_mark_result" && a.p_outbox_id === "o1" && a.p_error === "network_error") && j.sent === 1);

// --- request hygiene
calls = setup({ rows: rowsN(3), statuses: [200, 200, 200] }); j = await (await post(SR)).json();
ok("idempotency-key is outbox-<id>", fetches.every((f, k) => f.init.headers["idempotency-key"] === "outbox-o" + (k + 1)));
ok("every provider request has an abort signal (timeout)", fetches.every((f) => f.init.signal instanceof AbortSignal));
ok("pacing: >= 1000 ms between sends", delays.length === 2 && delays.every((d) => d >= 1000));
ok("success: mark_result(true, provider id) per row", rpcs(calls, "email_mark_result").length === 3 && rpcs(calls, "email_mark_result").every(([, a]) => a.p_ok === true && /^prov-/.test(a.p_provider_message_id)));
ok("response keys are counts only", JSON.stringify(Object.keys(j).sort()) === JSON.stringify(["claimed", "failed", "ok", "purge", "rate_limited", "released", "sent", "stopped", "sweep"]));

// --- time budget (lease 120 s - 30 s): stop and release unattempted rows
calls = setup({ rows: rowsN(3), statuses: [200, 200, 200], onFetch: (k) => { if (k === 1) skew = 80000; } });
j = await (await post(SR)).json();
ok("time budget: stops after the budget, rest released not attempted", j.sent === 1 && j.released === 2 && j.stopped === "time_budget" && fetches.length === 1
  && rpcs(calls, "email_release_claim").every(([, a]) => a.p_not_attempted === true));

// --- RPC error injection: stop the batch
calls = setup({ rows: rowsN(3), statuses: [200, 200, 200], rpcError: { "email_mark_result:o1": true } });
j = await (await post(SR)).json();
ok("mark_result RPC error -> batch stops, no further sends", fetches.length === 1 && j.stopped === "rpc_error" && j.sent === 0);
ok("mark_result RPC error -> remaining rows released not attempted", rpcs(calls, "email_release_claim").length === 2 && rpcs(calls, "email_release_claim").every(([, a]) => a.p_not_attempted === true));
calls = setup({ rows: rowsN(3), statuses: [429, 200, 200], rpcError: { "email_release_claim:o1": true } });
j = await (await post(SR)).json();
ok("release RPC error on 429 -> batch stops, nothing else called", j.stopped === "rpc_error" && rpcs(calls, "email_release_claim").length === 1 && fetches.length === 1 && !calls.some(([n]) => n === "email_mark_result"));
calls = setup({ rows: rowsN(3), statuses: [500, 200, 200], rpcError: { "email_mark_result:o1": true } });
j = await (await post(SR)).json();
ok("mark_result(false) RPC error -> batch stops", fetches.length === 1 && j.stopped === "rpc_error");
calls = setup({ rows: rowsN(3), statuses: [200, 429, 200], rpcError: { "email_release_claim:o3": true } });
j = await (await post(SR)).json();
ok("release-rest RPC error -> stops releasing", j.stopped === "rpc_error" && j.released === 1);

// --- claim failure: no detail echo
calls = setup({ claimError: true }); r = await post(SR); j = await r.json();
ok("claim error -> 500 without detail", r.status === 500 && j.error === "claim_failed" && !("detail" in j) && !JSON.stringify(j).includes("@"));

// --- sweep / purge flags
calls = setup(); j = await (await post(SR, { sweep: true, purge: true })).json();
ok("sweep + purge run in order before the claim", calls.length >= 3 && calls[0][0] === "welcome_enqueue_sweep" && calls[1][0] === "email_purge_expired_content" && calls[2][0] === "email_claim_batch");
ok("sweep result is passed through (counts only)", !!(j.sweep && j.sweep.gate === "auto_disabled" && j.purge && j.purge.purged === 0));
ok("sweep called with p_limit null", arg0(calls, "welcome_enqueue_sweep").p_limit === null && rpcs(calls, "welcome_enqueue_sweep").length === 1);
calls = setup(); await post(SR);
ok("no sweep and no purge by default", calls.length === 1 && calls[0][0] === "email_claim_batch");
calls = setup(); await post(TK, { sweep: "yes", purge: 1 });
ok("sweep/purge need literal true", calls.length === 1);
calls = setup({ rpcError: { welcome_enqueue_sweep: true } }); j = await (await post(SR, { sweep: true })).json();
ok("sweep RPC error is reported without detail and the claim still runs", !!(j.sweep && j.sweep.error === "sweep_failed") && rpcs(calls, "email_claim_batch").length === 1);

console.log(`\nEDGE RESULT pass=${pass} fail=${fail} expected=${EXPECTED}`);
if (fail === 0 && pass === EXPECTED) console.log("WP8_EDGE_HARNESS_PASS"); else console.log("WP8_EDGE_HARNESS_FAIL");
process.exit(fail === 0 && pass === EXPECTED ? 0 : 1);
