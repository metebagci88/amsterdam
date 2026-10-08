// ASALOCAL · CDP-3B · LOCAL TEST DOUBLE entry point — runs the REAL, unmodified CDP3B/edge/email-api/index.ts in Deno.
// Only two imports are swapped by the generated import map (gates/local_stack/run_local.sh):
//   std/http/server.ts serve -> shim_serve.ts (127.0.0.1 only + verify_jwt gateway double)
//   esm.sh supabase-js       -> shim_supabase.ts (GoTrue/PostgREST double on the local Postgres)
// deno_dom, email_sanitizer.js, CORS, auth order, validation, sanitizer, idem rules and RPC calls are the real code.
// Required env: LOCAL_EDGE_PORT, LOCAL_DB_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (any local value).
// EMAIL_API_E2E is NOT set -> the E2E seams in index.ts stay inert, exactly as in production.
// (shim_serve.ts refuses to start if EMAIL_API_E2E is set.) Static import -> module graph resolved before any code runs.
import "../../edge/email-api/index.ts";
