// ASALOCAL · CDP-3B · LOCAL TEST DOUBLE (docker-free) — Kong key-auth + GoTrue password login, 127.0.0.1 only. Never deployed.
// Lets run_local.sh drive gates/admin_save_draft_ui.mjs in its CI (hybrid) mode, i.e. through the same route.fetch +
// header-rewrite code that CI uses against the real local Kong/GoTrue. Like local Kong, every /auth/v1/* request must carry
// apikey == $ANON_KEY (the production anon key embedded in admin.html is REJECTED with 401), and the password grant must be
// sent with the anon Bearer rewritten to $ANON_KEY. Valid login for $CRM_EMAIL/$CRM_PW returns $CRM_JWT (a local token the
// edge double accepts). Prints "GOTRUE_DOUBLE_READY <port>"; on SIGTERM prints only request counters (no values).
// Usage: node gotrue_double.mjs <port>   (env: ANON_KEY, CRM_EMAIL, CRM_PW, CRM_JWT, CRM_UID)
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.argv[2] || "0");
const E = process.env;
for (const k of ["ANON_KEY", "CRM_EMAIL", "CRM_PW", "CRM_JWT", "CRM_UID"]) if (!E[k]) { console.error("missing env " + k); process.exit(2); }
const stats = { token_ok: 0, token_bad_credentials: 0, rejected_apikey: 0, rejected_anon_bearer: 0, user_ok: 0, user_bad: 0, logout: 0, unknown: 0 };
const user = { id: E.CRM_UID, aud: "authenticated", role: "authenticated", email: E.CRM_EMAIL, app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };

const srv = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const u = new URL(req.url, "http://127.0.0.1");
  const j = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(s === 204 ? "" : JSON.stringify(b)); };
  if (!u.pathname.startsWith("/auth/v1/")) { stats.unknown++; return j(404, { message: "no route" }); }
  if (req.headers.apikey !== E.ANON_KEY) { stats.rejected_apikey++; return j(401, { message: "Invalid authentication credentials" }); }   // Kong key-auth
  if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "password" && req.method === "POST") {
    if (req.headers.authorization !== "Bearer " + E.ANON_KEY) { stats.rejected_anon_bearer++; return j(401, { message: "invalid anon bearer" }); }
    let b = {}; try { b = JSON.parse(body || "{}"); } catch { /* */ }
    if (b.email !== E.CRM_EMAIL || b.password !== E.CRM_PW) { stats.token_bad_credentials++; return j(400, { error: "invalid_grant", error_description: "Invalid login credentials" }); }
    stats.token_ok++;
    return j(200, { access_token: E.CRM_JWT, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "local-refresh-" + randomUUID(), user });
  }
  if (u.pathname === "/auth/v1/user" && req.method === "GET") {
    if (req.headers.authorization === "Bearer " + E.CRM_JWT) { stats.user_ok++; return j(200, user); }
    stats.user_bad++; return j(401, { message: "invalid JWT" });
  }
  if (u.pathname === "/auth/v1/logout") { stats.logout++; return j(204); }
  stats.unknown++; return j(404, { message: "no route" });
});
srv.listen(PORT, "127.0.0.1", () => console.log("GOTRUE_DOUBLE_READY " + srv.address().port));
process.on("SIGTERM", () => { console.log("GOTRUE_DOUBLE_STATS " + JSON.stringify(stats)); srv.close(); process.exit(0); });
