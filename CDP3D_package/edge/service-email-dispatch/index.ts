// =====================================================================
// CDP-3D · service-email-dispatch (Edge Function) — v4 (WP8)
// Yetki (verify_jwt=true kalır):
//   (a) service_role JWT (role claim) — eski/manuel operatör yolu, değişmedi; limit 1..100.
//   (b) gateway JWT + x-asalocal-dispatch-token == DISPATCH_TRIGGER_TOKEN (timing-safe).
//       Env yoksa veya 32 karakterden kısaysa (b) KAPALI (fail-closed); limit 1..10.
// Akış: [sweep?] [purge?] -> email_claim_batch -> Resend POST /emails -> email_mark_result.
// WP8: 429 -> email_release_claim (attempt iade, satır başı en fazla 6) + kalan satırlar
//      denenmeden iade + batch durur. 401/403 -> terminal + kalanlar iade + dur.
//      Her istek 15 s timeout; istekler arası >= 1 s; lease (120 s) - 30 s zaman bütçesi;
//      mark/release RPC hatasında batch durur. Kalıcı 4xx sınıflandırması DB'de (mark_result).
// Fail-closed: RESEND_API_KEY yoksa 503; POST değilse 405; yetkisizse 403.
// PII: alıcı e-postası yalnız bellekte; asla loglanmaz, yanıtlanmaz, saklanmaz.
// Yanıt yalnız sayılardır. Sweep/purge sonucu DB'nin döndürdüğü sayaç JSON'udur.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const RESEND_API = "https://api.resend.com/emails";
const UA = "asalocal-cdp3d/1.1";
const PACE_MS = 1000;
const FETCH_TIMEOUT_MS = 15000;
const LEASE_SECONDS = 120;
const TIME_BUDGET_MS = (LEASE_SECONDS - 30) * 1000;
const TOKEN_MIN_LEN = 32;
const SERVICE_ROLE_MAX_LIMIT = 100;
const TOKEN_MAX_LIMIT = 10;

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function decodeRole(auth: string | null): string | null {
  try {
    if (!auth) return null;
    const tok = auth.replace(/^Bearer\s+/i, "");
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
    const payload = JSON.parse(atob(pad(parts[1].replace(/-/g, "+").replace(/_/g, "/"))));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

type Caller = "service_role" | "token" | null;

function caller(req: Request, token: string | undefined): Caller {
  if (decodeRole(req.headers.get("authorization")) === "service_role") return "service_role";
  if (!token || token.length < TOKEN_MIN_LEN) return null;
  const presented = req.headers.get("x-asalocal-dispatch-token") ?? "";
  return presented.length > 0 && timingSafeEqual(presented, token) ? "token" : null;
}

function retryAfterSeconds(h: string | null): number {
  const n = h ? parseInt(h, 10) : NaN;
  if (!Number.isFinite(n) || n < 60) return 60;
  return n > 3600 ? 3600 : n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResp(405, { error: "method_not_allowed" });
  const who = caller(req, Deno.env.get("DISPATCH_TRIGGER_TOKEN"));
  if (!who) return jsonResp(403, { error: "forbidden" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY) return jsonResp(503, { error: "supabase_env_missing" });
  if (!RESEND_API_KEY) return jsonResp(503, { error: "resend_key_missing" }); // fail-closed

  const maxLimit = who === "token" ? TOKEN_MAX_LIMIT : SERVICE_ROLE_MAX_LIMIT;
  let limit = 10, doSweep = false, doPurge = false;
  try {
    const b = await req.json().catch(() => ({}));
    if (b && typeof b.limit === "number" && b.limit >= 1 && b.limit <= maxLimit) limit = Math.floor(b.limit);
    doSweep = b?.sweep === true;
    doPurge = b?.purge === true;
  } catch { /* default */ }
  if (limit > maxLimit) limit = maxLimit;

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let sweep: unknown = null;
  if (doSweep) {
    const { data, error } = await svc.rpc("welcome_enqueue_sweep", { p_limit: null });
    sweep = error ? { error: "sweep_failed" } : data;
  }
  let purge: unknown = null;
  if (doPurge) {
    const { data, error } = await svc.rpc("email_purge_expired_content");
    purge = error ? { error: "purge_failed" } : data;
  }

  const { data: claimed, error: claimErr } = await svc.rpc("email_claim_batch", { p_limit: limit });
  if (claimErr) return jsonResp(500, { error: "claim_failed", sweep, purge });

  const rows: any[] = Array.isArray(claimed) ? claimed : [];
  const t0 = Date.now();
  let sent = 0, failed = 0, released = 0, rateLimited = false;
  let stopped: string | null = null;

  // Kalan (denenmemiş) satırları attempt iadesiyle kuyruğa geri bırak. RPC hatasında dur.
  const releaseFrom = async (from: number, retryAfter: number): Promise<void> => {
    for (const rest of rows.slice(from)) {
      const { error } = await svc.rpc("email_release_claim", {
        p_outbox_id: rest.outbox_id, p_retry_after_seconds: retryAfter, p_not_attempted: true,
      });
      if (error) { stopped = "rpc_error"; return; }
      released++;
    }
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i > 0) await sleep(PACE_MS);
    if (Date.now() - t0 + FETCH_TIMEOUT_MS > TIME_BUDGET_MS) {
      stopped = "time_budget";
      await releaseFrom(i, 60);
      break;
    }
    const payload: Record<string, unknown> = {
      from: `${row.from_name} <${row.from_email}>`,
      to: [row.recipient_email],
      subject: row.subject,
      reply_to: row.reply_to,
    };
    if (row.body_html) payload.html = row.body_html;
    if (row.body_text) payload.text = row.body_text;
    if (!row.body_html && !row.body_text) payload.text = row.subject;

    let status = 0;
    let pid: string | null = null;
    let retryAfter = 60;
    try {
      // Provider idempotency: outbox id'den türetilmiş STABİL key (Resend 24 saat dedupe eder).
      const r = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${RESEND_API_KEY}`,
          "content-type": "application/json",
          "user-agent": UA,
          "idempotency-key": `outbox-${row.outbox_id}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      status = r.status;
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        pid = typeof j?.id === "string" ? j.id : null;
      } else if (r.status === 429) {
        retryAfter = retryAfterSeconds(r.headers.get("retry-after"));
      }
    } catch {
      status = 0; // ağ hatası veya timeout -> network_error (yeniden denenir)
    }

    if (status >= 200 && status < 300) {
      const { error } = await svc.rpc("email_mark_result", { p_outbox_id: row.outbox_id, p_ok: true, p_provider_message_id: pid, p_error: null });
      if (error) { stopped = "rpc_error"; await releaseFrom(i + 1, 60); break; }
      sent++;
    } else if (status === 429) {
      const { error } = await svc.rpc("email_release_claim", { p_outbox_id: row.outbox_id, p_retry_after_seconds: retryAfter, p_not_attempted: false });
      if (error) { stopped = "rpc_error"; break; }
      released++;
      rateLimited = true;
      stopped = "rate_limited";
      await releaseFrom(i + 1, retryAfter);
      break;
    } else {
      const errText = status === 0 ? "network_error" : `resend_${status}`; // gövde loglanmaz (PII riski)
      const { error } = await svc.rpc("email_mark_result", { p_outbox_id: row.outbox_id, p_ok: false, p_provider_message_id: null, p_error: errText });
      if (error) { stopped = "rpc_error"; await releaseFrom(i + 1, 60); break; }
      failed++;
      if (status === 401 || status === 403) {
        stopped = "provider_auth";
        await releaseFrom(i + 1, 60);
        break;
      }
    }
  }

  return jsonResp(200, {
    ok: true, claimed: rows.length, sent, failed, released, rate_limited: rateLimited, stopped, sweep, purge,
  });
});
