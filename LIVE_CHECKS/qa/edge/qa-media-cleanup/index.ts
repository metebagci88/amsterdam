// ASALOCAL · qa-media-cleanup — TEMPORARY, single-purpose QA cleanup (Edge, verify_jwt=true)
//
// Why: admin-api has no media delete action (by design) and the PRD forbids a client
// delete fallback. Live acceptance tests create one synthetic PNG per stage; this
// function removes exactly that object through the Storage API (metadata + blob)
// using the service role that only exists inside the Edge runtime. No key is ever
// handled outside Supabase.
//
// Guards (all must pass):
//   - valid JWT (gateway) AND caller user id == the dedicated QA admin test account
//   - path matches ^venues/<uuid>.(png|jpg|webp)$  (server-generated media_upload form)
//   - exactly one existing object with that name, created less than 3 hours ago
//   - one object per call; body is not logged
// Lifecycle: deployed only for the QA run; replaced by a 410 "gone" stub afterwards
// (same pattern as adim2-dispatch-once).
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QA_ADMIN_ID = "bfb7910a-367e-4ee6-b7f4-c2b15951213a";
const PATH_RE = /^venues\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return j(405, { error: "method_not_allowed" });
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/);
  if (!m) return j(401, { error: "missing_bearer" });
  const uc = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${m[1]}` } }, auth: { persistSession: false } });
  const { data: { user }, error: uerr } = await uc.auth.getUser();
  if (uerr || !user) return j(401, { error: "invalid_token" });
  if (user.id !== QA_ADMIN_ID) return j(403, { error: "forbidden" });
  let body: { path?: unknown };
  try { body = await req.json(); } catch { return j(400, { error: "bad_json" }); }
  const path = typeof body?.path === "string" ? body.path : "";
  if (!PATH_RE.test(path)) return j(400, { error: "bad_path" });
  const name = path.slice("venues/".length);
  const svc = createClient(URL, SRK, { auth: { persistSession: false } });
  const { data: items, error: lerr } = await svc.storage.from("media").list("venues", { search: name, limit: 5 });
  if (lerr) return j(500, { error: "list_failed" });
  const hit = (items ?? []).filter((i) => i.name === name);
  if (hit.length !== 1) return j(404, { error: "not_found" });
  const created = Date.parse(String(hit[0].created_at ?? ""));
  if (!Number.isFinite(created) || Date.now() - created > MAX_AGE_MS) return j(409, { error: "too_old" });
  const { data: removed, error: rerr } = await svc.storage.from("media").remove([path]);
  if (rerr) return j(500, { error: "remove_failed" });
  return j(200, { removed: (removed ?? []).length });
});
