// =====================================================================
// CDP-3D · resend-webhook (Edge Function)
// verify_jwt=false (Resend Supabase JWT gönderemez). Güvenlik sınırı = SVIX İMZA DOĞRULAMASI.
// Fail-closed: RESEND_WEBHOOK_SECRET yoksa 503; imza geçersiz/eksik -> 401 (ingest YOK).
// Geçerli -> email_ingest_provider_event (service-role). Dedupe DB'de svix_id ile.
// PII: ham e-posta yalnız DB fonksiyonuna parametre geçer, orada hmac'e çevrilir; SAKLANMAZ.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function verifySvix(secret: string, id: string, ts: string, body: string, sigHeader: string): Promise<boolean> {
  try {
    if (!id || !ts || !sigHeader) return false;
    // timestamp toleransı (5 dk)
    const now = Math.floor(Date.now() / 1000);
    const t = parseInt(ts, 10);
    if (!Number.isFinite(t) || Math.abs(now - t) > 300) return false;
    const keyB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const keyBytes = b64ToBytes(keyB64);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signedContent = `${id}.${ts}.${body}`;
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signedContent));
    const expected = bytesToB64(sig);
    // svix-signature: "v1,<b64> v1,<b64> ..." (boşlukla ayrık)
    for (const part of sigHeader.split(" ")) {
      const idx = part.indexOf(",");
      const val = idx >= 0 ? part.slice(idx + 1) : part;
      if (timingSafeEqual(val, expected)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResp(405, { error: "method_not_allowed" });

  const SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SECRET) return jsonResp(503, { error: "webhook_secret_missing" });        // fail-closed
  if (!SUPABASE_URL || !SERVICE_KEY) return jsonResp(503, { error: "supabase_env_missing" });

  const body = await req.text();
  const id = req.headers.get("svix-id") ?? "";
  const ts = req.headers.get("svix-timestamp") ?? "";
  const sig = req.headers.get("svix-signature") ?? "";

  const ok = await verifySvix(SECRET, id, ts, body, sig);
  if (!ok) return jsonResp(401, { error: "invalid_signature" });                 // imza geçersiz -> ingest yok

  let evt: any;
  try { evt = JSON.parse(body); } catch { return jsonResp(400, { error: "bad_json" }); }

  const type: string = typeof evt?.type === "string" ? evt.type : "";
  const data = evt?.data ?? {};
  const providerId: string = typeof data?.email_id === "string" ? data.email_id
    : (typeof data?.id === "string" ? data.id : "");
  const toArr = Array.isArray(data?.to) ? data.to : (typeof data?.to === "string" ? [data.to] : []);
  const recipient: string = toArr.length > 0 ? String(toArr[0]) : "";
  const occurredAt: string = typeof evt?.created_at === "string" ? evt.created_at
    : (typeof data?.created_at === "string" ? data.created_at : new Date().toISOString());
  // Bounce sınıfı: yalnız Permanent -> kalıcı hard_bounce suppression (Transient/Undetermined DEĞİL)
  const bounceType: string | null = (data?.bounce && typeof data.bounce.type === "string") ? data.bounce.type : null;

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { error } = await svc.rpc("email_ingest_provider_event", {
    p_svix_id: id || null,
    p_event_type: type,
    p_provider_message_id: providerId || null,
    p_recipient_email: recipient || null,
    p_occurred_at: occurredAt,
    p_bounce_type: bounceType,
  });
  if (error) return jsonResp(500, { error: "ingest_failed", detail: error.message });

  // 200 -> Resend retry yapmaz (duplicate DB'de idempotent yutulur)
  return jsonResp(200, { ok: true });
});
