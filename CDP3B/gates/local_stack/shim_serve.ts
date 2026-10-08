// ASALOCAL · CDP-3B · LOCAL TEST DOUBLE — replaces https://deno.land/std@0.224.0/http/server.ts via import map ONLY in
// the docker-free local stack (gates/local_stack/run_local.sh). Never deployed.
// serve(handler) hosts the REAL email-api handler on 127.0.0.1:$LOCAL_EDGE_PORT at /functions/v1/email-api and adds a
// double of the platform gateway with verify_jwt=true: a non-OPTIONS request without a known bearer token gets 401
// before the function runs (as the Supabase functions gateway does). Anything else -> 404.
import { tokenUid } from "./shim_supabase.ts";

type Handler = (req: Request) => Response | Promise<Response>;

export function serve(handler: Handler): void {
  if (Deno.env.get("EMAIL_API_E2E")) throw new Error("local stack must run with EMAIL_API_E2E unset (production-inert seams)");
  const port = Number(Deno.env.get("LOCAL_EDGE_PORT") || "0");
  if (!port) throw new Error("LOCAL_EDGE_PORT required");
  Deno.serve({ hostname: "127.0.0.1", port, onListen: () => console.log("LOCAL_EDGE_READY " + port) }, async (req) => {
    const u = new URL(req.url);
    if (u.pathname !== "/functions/v1/email-api") return new Response("not found", { status: 404 });
    if (req.method !== "OPTIONS") {
      const uid = await tokenUid(req.headers.get("Authorization") || "");
      if (!uid) return new Response(JSON.stringify({ msg: "Invalid JWT" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    return await handler(req);
  });
}
