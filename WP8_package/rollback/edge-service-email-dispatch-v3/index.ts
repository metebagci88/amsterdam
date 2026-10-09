// =====================================================================
// CDP-3D · service-email-dispatch (Edge Function)
// Yalnız SERVICE_ROLE çağırabilir (verify_jwt=true + role claim = service_role).
// Akış: email_claim_batch (service-role) -> Resend API POST /emails -> email_mark_result.
// Fail-closed: RESEND_API_KEY yoksa 503; POST değilse 405; service_role değilse 403.
// PII: alıcı e-postası yalnız bellekte (claim'den gelir), asla loglanmaz/saklanmaz.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const RESEND_API = "https://api.resend.com/emails";
const UA = "asalocal-cdp3d/1.0";

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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResp(405, { error: "method_not_allowed" });

  // Yalnız service_role
  const role = decodeRole(req.headers.get("authorization"));
  if (role !== "service_role") return jsonResp(403, { error: "forbidden" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY) return jsonResp(503, { error: "supabase_env_missing" });
  if (!RESEND_API_KEY) return jsonResp(503, { error: "resend_key_missing" }); // fail-closed

  let limit = 10;
  try {
    const b = await req.json().catch(() => ({}));
    if (b && typeof b.limit === "number" && b.limit >= 1 && b.limit <= 100) limit = Math.floor(b.limit);
  } catch { /* default */ }

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: claimed, error: claimErr } = await svc.rpc("email_claim_batch", { p_limit: limit });
  if (claimErr) return jsonResp(500, { error: "claim_failed", detail: claimErr.message });

  const rows: any[] = Array.isArray(claimed) ? claimed : [];
  let sent = 0, failed = 0;
  for (const row of rows) {
    const toEmail: string = row.recipient_email;
    const fromDisplay = `${row.from_name} <${row.from_email}>`;
    const payload: Record<string, unknown> = {
      from: fromDisplay,
      to: [toEmail],
      subject: row.subject,
      reply_to: row.reply_to,
    };
    if (row.body_html) payload.html = row.body_html;
    if (row.body_text) payload.text = row.body_text;
    if (!row.body_html && !row.body_text) payload.text = row.subject;

    try {
      // Provider idempotency: outbox id'den türetilmiş STABİL key. Her retry'da aynı kalır ->
      // gönderim başarılı olup HTTP yanıtı kaybolsa bile ikinci e-posta çıkmaz (Resend dedupe eder).
      const r = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${RESEND_API_KEY}`,
          "content-type": "application/json",
          "user-agent": UA,
          "idempotency-key": `outbox-${row.outbox_id}`,
        },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const pid = typeof j?.id === "string" ? j.id : null;
        await svc.rpc("email_mark_result", { p_outbox_id: row.outbox_id, p_ok: true, p_provider_message_id: pid, p_error: null });
        sent++;
      } else {
        const errText = `resend_${r.status}`; // gövde loglanmaz (PII riski)
        await svc.rpc("email_mark_result", { p_outbox_id: row.outbox_id, p_ok: false, p_provider_message_id: null, p_error: errText });
        failed++;
      }
    } catch (e) {
      await svc.rpc("email_mark_result", { p_outbox_id: row.outbox_id, p_ok: false, p_provider_message_id: null, p_error: "network_error" });
      failed++;
    }
  }

  return jsonResp(200, { ok: true, claimed: rows.length, sent, failed });
});
