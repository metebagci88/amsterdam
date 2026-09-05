// ASALOCAL · CDP-3B (v2, sertleştirilmiş) · Edge "email-api" (verify_jwt=true) — İNCELEME İÇİN; DEPLOY EDİLMEDİ.
// - request_id + idem (uuid) write'larda ZORUNLU (sessizce üretilmez)
// - per-action input schema; server-side içerik/boyut sınırları (JSON, base64, html, builder_json)
// - SSRF (Model A): yalnız güvenilir domain ALLOWLIST'ten uzak görsel; diğerleri manuel upload
// - publish FAIL-CLOSED orchestration: prepare -> verify -> copy -> verify -> promote(RPC) -> finalize(publish RPC)
// - GC: candidates (dry-run) -> storage delete -> finalize (RPC)
// - hata maskeleme: ham DB/storage detayı client'a DÖNMEZ; yalnız server log
// - görsel boyutu gerçek binary'den (client'a güvenilmez)
// Sanitize mantığı canonical ./email_sanitizer.js (SHA bc60ffed…) ile AYNI; Deno'da deno-dom.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
import "./email_sanitizer.js";
// deno-lint-ignore no-explicit-any
const EmailSanitizer = (globalThis as any).EmailSanitizer;

const ADMIN_ORIGINS = ["https://www.asalocal.club", "https://asalocal.club"]; // CORS allowlist
const TRUSTED_IMAGE_HOSTS = ["cdn.asalocal.club"];                            // SSRF Model A allowlist
const ALLOWED_MIME = ["image/png","image/jpeg","image/gif","image/webp"];
const MAX_ASSET_BYTES = 2_000_000, MAX_BASE64 = Math.ceil(2_000_000 * 4 / 3) + 8;
const MAX_HTML = 400_000, MAX_BUILDER = 800_000, MAX_BODY = 3_000_000;
const ALLOWED_VARS = ["first_name","city_name","trip_start_date","trip_end_date","days_until_trip","unsubscribe_url"];
const DRAFT_BUCKET = "email-assets-draft", PUBLIC_BUCKET = "email-assets-public";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(origin: string | null) {
  const allow = origin && ADMIN_ORIGINS.includes(origin) ? origin : ADMIN_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS" };
}
const j = (b: unknown, s = 200, origin: string | null = null) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors(origin), "Content-Type": "application/json" } });

const parseHTML = (h: string) => new DOMParser().parseFromString("<!doctype html><html><body>"+h+"</body></html>", "text/html");
async function sha256Hex(d: Uint8Array | string) {
  const buf = typeof d === "string" ? new TextEncoder().encode(d) : d;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf))).map(b=>b.toString(16).padStart(2,"0")).join("");
}
function sniffMime(b: Uint8Array): string | null {
  if (b.length>=8 && b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47) return "image/png";
  if (b.length>=3 && b[0]===0xff&&b[1]===0xd8&&b[2]===0xff) return "image/jpeg";
  if (b.length>=6 && b[0]===0x47&&b[1]===0x49&&b[2]===0x46) return "image/gif";
  if (b.length>=12 && b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50) return "image/webp";
  return null;
}
// gerçek binary'den boyut (client'a güvenme); webp -> null
function imageSize(b: Uint8Array, mime: string): {w:number|null,h:number|null} {
  try {
    if (mime==="image/png" && b.length>=24) return { w:(b[16]<<24)|(b[17]<<16)|(b[18]<<8)|b[19], h:(b[20]<<24)|(b[21]<<16)|(b[22]<<8)|b[23] };
    if (mime==="image/gif" && b.length>=10) return { w:b[6]|(b[7]<<8), h:b[8]|(b[9]<<8) };
    if (mime==="image/jpeg") { let i=2; while(i<b.length){ if(b[i]!==0xff){i++;continue;} const m=b[i+1];
      if(m>=0xC0&&m<=0xCF&&m!==0xC4&&m!==0xC8&&m!==0xCC){ return { h:(b[i+5]<<8)|b[i+6], w:(b[i+7]<<8)|b[i+8] }; }
      const len=(b[i+2]<<8)|b[i+3]; i+=2+len; } }
    if (mime==="image/webp" && b.length>=30) {
      const fmt=String.fromCharCode(b[12],b[13],b[14],b[15]);
      if (fmt==="VP8 ") { return { w:((b[26]|(b[27]<<8))&0x3fff), h:((b[28]|(b[29]<<8))&0x3fff) }; }               // lossy
      if (fmt==="VP8L") { const b1=b[21],b2=b[22],b3=b[23],b4=b[24]; return { w:1+(((b2&0x3f)<<8)|b1), h:1+(((b4&0x0f)<<10)|(b3<<2)|((b2&0xc0)>>6)) }; } // lossless
      if (fmt==="VP8X") { return { w:1+(b[24]|(b[25]<<8)|(b[26]<<16)), h:1+(b[27]|(b[28]<<8)|(b[29]<<16)) }; }      // extended
    }
  } catch { /* ignore */ }
  return { w:null, h:null };
}
// --- E2E test seam (PRODUCTION'da TAMAMEN INERT) ---
// Yalnız EMAIL_API_E2E=1 iken aktif. Prod ortamında bu değişken ASLA set edilmez -> allowlist/protokol davranışı DEĞİŞMEZ.
// Amaç: CI'da yerel bir test görsel sunucusunu (127.0.0.1) allowlist'e alıp import_host_images'i GERÇEKTEN test edebilmek.
const E2E = Deno.env.get("EMAIL_API_E2E") === "1";
const E2E_HOSTS = E2E ? (Deno.env.get("E2E_IMAGE_HOSTS")||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean) : [];
const E2E_ALLOW_HTTP = E2E && Deno.env.get("E2E_ALLOW_HTTP")==="1";
function ssrfHostAllowed(u: string): boolean {
  try {
    const url=new URL(u);
    const httpsOk = url.protocol==="https:";
    const httpOk  = E2E_ALLOW_HTTP && url.protocol==="http:";
    if(!httpsOk && !httpOk) return false;
    const host = url.hostname.toLowerCase();
    return TRUSTED_IMAGE_HOSTS.includes(host) || E2E_HOSTS.includes(host);
  } catch { return false; }
}
// timeout + streaming byte-cap ile uzak fetch (unbounded arrayBuffer YOK)
async function fetchBounded(url: string, maxBytes: number, timeoutMs = 5000): Promise<Uint8Array | null> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { redirect: "error", signal: ctrl.signal });
    if (!resp.ok || !resp.body) return null;
    const cl = Number(resp.headers.get("content-length") || "0");
    if (cl && cl > maxBytes) return null;
    const reader = resp.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /*noop*/ } return null; } // cap aşıldı
      chunks.push(value);
    }
    const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  } catch { return null; } finally { clearTimeout(t); }
}
function reqStr(v: unknown, max: number, name: string): string {
  if (typeof v !== "string" || v.length>max) throw new HttpErr(422, "bad_field:"+name);
  return v;
}
class HttpErr extends Error { code: number; constructor(code:number,msg:string){ super(msg); this.code=code; } }

// FAIL-CLOSED içerik denetimi (yalnız istemciye güvenilmez): kalıcı girdilerde (source_html + builder_json +
// sanitized_html) YALNIZ manifest asset'lerinin SUNUCU-TÜRETİLMİŞ kanonik public URL'leri bulunabilir.
// signed endpoint / draft bucket / token / geçici editör alanları YASAK. URL-parse + manifest eşleşmesi
// birincil sınır; regex yalnız ek savunma. Manifest dışı managed storage URL -> reddet.
async function assertCanonicalAssets(svc: any, supabaseUrl: string, manifest: any[], strings: (string|null|undefined|unknown)[]) {
  const ids = Array.isArray(manifest) ? manifest.map((m:any)=>m?.asset_id).filter((x:any)=>typeof x==="string" && UUID_RE.test(x)) : [];
  const { data: assets, error } = ids.length
    ? await svc.from("email_assets").select("id,object_path,public_object_path").in("id", ids)
    : { data: [] as any[], error: null };
  if (error) { console.error("assertCanonicalAssets db", error); throw new HttpErr(500, "asset_lookup_failed"); }
  const allowed = new Set<string>();
  const pubBase = `${supabaseUrl}/storage/v1/object/public/${PUBLIC_BUCKET}/`;
  for (const a of (assets||[])) {
    if (a.object_path) allowed.add(pubBase + a.object_path);
    if (a.public_object_path) allowed.add(pubBase + a.public_object_path);
  }
  const FORBIDDEN = /\/storage\/v1\/object\/sign\/|email-assets-draft|[?&]token=|data-asa-pub|data-asa-id/i;
  const storageUrlRe = /https?:\/\/[^\s"'()<>\\]+\/storage\/v1\/object\/[^\s"'()<>\\]+/gi;
  for (const s of strings) {
    if (s === null || s === undefined) continue;
    const str = typeof s === "string" ? s : JSON.stringify(s);
    if (!str) continue;
    if (FORBIDDEN.test(str)) throw new HttpErr(409, "draft_asset_url_in_content");   // ek savunma (regex)
    const urls = str.match(storageUrlRe) || [];
    for (const u of urls) {                                                          // birincil sınır: her storage URL manifest'te olmalı
      const clean = u.replace(/[),.;'"]+$/,"");
      if (!allowed.has(clean)) throw new HttpErr(409, "unmanaged_asset_url");
    }
  }
}

serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return j({ ok:false, error:"method_not_allowed" }, 405, origin);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // body boyut sınırı (bellek koruması)
  const clen = Number(req.headers.get("content-length") || "0");
  if (clen > MAX_BODY) return j({ ok:false, error:"payload_too_large" }, 413, origin);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return j({ ok:false, error:"payload_too_large" }, 413, origin);
  let body: any; try { body = JSON.parse(raw); } catch { return j({ ok:false, error:"bad_json" }, 400, origin); }
  const action = String(body?.action || "");

  // actor JWT'den
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return j({ ok:false, error:"not_authenticated" }, 401, origin);
  const actor = ures.user.id;
  const svc = createClient(SUPABASE_URL, SERVICE);

  const WRITE = ["create","save","publish","new_version","duplicate","archive","asset_upload","import_host_images","asset_gc"];
  // write'larda request_id + idem ZORUNLU (sessizce üretilmez)
  let reqId = "", idem = "";
  if (WRITE.includes(action)) {
    reqId = body?.request_id; idem = body?.idem;
    if (typeof reqId!=="string" || !reqId || reqId.length>80) return j({ ok:false, error:"request_id_required" }, 400, origin);
    if (typeof idem!=="string" || !UUID_RE.test(idem)) return j({ ok:false, error:"idem_uuid_required" }, 400, origin);
  }

  try {
    switch (action) {
      case "taxonomy": return j(await rpc(svc,"admin_q_email_taxonomy",{p_actor:actor}), 200, origin);
      case "list":     return j(await rpc(svc,"admin_q_email_template_list",{p_actor:actor}), 200, origin);
      case "get":      return j(await rpc(svc,"admin_q_email_template_get",{p_actor:actor,p_id:reqUuid(body.template_id)}), 200, origin);
      case "data_health": return j(await rpc(svc,"admin_q_email_data_health",{p_actor:actor}), 200, origin);
      case "reconcile": { // Storage<->DB reconciliation (salt-okunur). Rol: SUPER_ADMIN (gc_candidates = _email_can_publish kapısı)
        await rpc(svc,"admin_q_email_asset_gc_candidates",{p_actor:actor}); // super_admin değilse 'forbidden'
        const { data: rows, error: rerr } = await svc.from("email_assets").select("id,object_path,public_object_path,content_hash,status");
        if (rerr) { console.error("reconcile db", rerr); throw new HttpErr(500,"reconcile_db_error"); } // DB error -> FAIL, boş başarı DÖNME
        // E2E test seam (PRODUCTION'da TAMAMEN INERT): yalnız EMAIL_API_E2E=1 iken ve super_admin rol kapısı (yukarıdaki
        // admin_q_email_asset_gc_candidates) GEÇİLDİKTEN SONRA, 'x-asa-e2e-fault: storage-list-error' başlığı GERÇEK listeleme
        // yardımcısının HATA KOLUNU deterministik tetikler. Prod'da E2E=false -> başlık tamamen yok sayılır. Sahte HTTP yanıtı
        // DÖNMEZ; üretimdeki if(r.error) dalı çalışır ve maskeli 500 reconcile_storage_error üretir (ham ayrıntı yalnız log'a).
        const e2eStorageListFault = E2E && req.headers.get("x-asa-e2e-fault") === "storage-list-error";
        async function listAll(bucket: string): Promise<{names:Set<string>, truncated:boolean}> {
          const names = new Set<string>(); let offset=0; const PAGE=1000, MAX=100000; let truncated=false;
          while (true) {
            const r: { data: any[]|null, error: any } = e2eStorageListFault
              ? { data: null, error: { message: "e2e_injected_storage_list_error" } }
              : await svc.storage.from(bucket).list("", { limit: PAGE, offset });
            if (r.error) { console.error("reconcile list", bucket, r.error); throw new HttpErr(500,"reconcile_storage_error"); } // list error -> FAIL
            const batch = r.data || []; batch.forEach((o:any)=>names.add(o.name)); offset += batch.length;
            if (batch.length < PAGE) break;
            if (offset >= MAX) { truncated = true; break; }
          }
          return { names, truncated };
        }
        const d = await listAll(DRAFT_BUCKET), p = await listAll(PUBLIC_BUCKET);
        const dbDraft = new Map<string,any>(), dbPub = new Map<string,any>();
        (rows||[]).forEach((r:any)=>{ dbDraft.set(r.object_path,r); if(r.public_object_path) dbPub.set(r.public_object_path,r); });
        const storage_only_orphan:string[]=[], db_only_missing:string[]=[], wrong_status_path:string[]=[], published_missing_public:string[]=[];
        d.names.forEach(n=>{ if(!dbDraft.has(n)) storage_only_orphan.push("draft/"+n); });
        p.names.forEach(n=>{ if(!dbPub.has(n)) storage_only_orphan.push("public/"+n); });
        (rows||[]).forEach((r:any)=>{
          if(!d.names.has(r.object_path)) db_only_missing.push("draft/"+r.object_path);
          if(r.status==="draft" && r.public_object_path) wrong_status_path.push(r.id+":draft_with_public_path");
          if(r.status==="published"){ if(!r.public_object_path) published_missing_public.push(r.id+":no_public_path"); else if(!p.names.has(r.public_object_path)) published_missing_public.push("public/"+r.public_object_path); }
        });
        return j({ ok:true, storage_only_orphan, db_only_missing, wrong_status_path, published_missing_public,
          scanned:{ db_rows:(rows||[]).length, draft_objects:d.names.size, public_objects:p.names.size }, truncated: d.truncated||p.truncated }, 200, origin);
      }
      case "gc_candidates": return j(await rpc(svc,"admin_q_email_asset_gc_candidates",{p_actor:actor}), 200, origin);

      case "asset_preview": { // taslak görsel için KISA-ÖMÜRLÜ signed URL (SALT-OKUMA; DB/Storage yazmaz; loglanmaz; no-store)
        const ids: string[] = Array.isArray(body.asset_ids) ? body.asset_ids.filter((x:any)=>typeof x==="string" && UUID_RE.test(x)).slice(0,50) : [];
        if (!ids.length) throw new HttpErr(422,"no_ids");
        const tid = (typeof body.template_id==="string" && UUID_RE.test(body.template_id)) ? body.template_id : null;
        const rows = await rpc(svc,"admin_q_email_asset_preview",{p_actor:actor,p_asset_ids:ids,p_template_id:tid}); // rol/durum/ilişki kapısı; forbidden -> 403
        const okMap = new Map<string,string>();
        for (const r of (rows||[])) okMap.set(r.asset_id, r.object_path);
        const previews: any[] = []; const unavailable: string[] = [];
        for (const id of ids) {
          const objPath = okMap.get(id);
          if (!objPath) { unavailable.push(id); continue; }                                 // yetki/ilişki yok -> SESSİZCE DÜŞÜRME, açıkça bildir
          const sg = await svc.storage.from(DRAFT_BUCKET).createSignedUrl(objPath, 600, { download:false });
          if (sg.error || !sg.data?.signedUrl) { console.error("preview sign", id, sg.error); unavailable.push(id); continue; } // ham storage hatası client'a DÖNMEZ
          previews.push({ asset_id:id, url:sg.data.signedUrl });
        }
        return new Response(JSON.stringify({ ok:true, previews, unavailable_asset_ids: unavailable, ttl:600 }),
          { status:200, headers:{ ...cors(origin), "Content-Type":"application/json", "Cache-Control":"no-store" } });
      }

      case "create":
        reqStr(body.internal_name,120,"internal_name");
        if (body.description!=null) reqStr(body.description,500,"description");
        return j(await rpc(svc,"admin_w_email_template_create",{p_actor:actor,p_internal_name:body.internal_name,p_description:body.description??null,p_email_class:enumv(body.email_class,["marketing","transactional"]),p_source_type:enumv(body.source_type,["visual_builder","html_import"]),p_idem:idem,p_request_id:reqId}), 200, origin);
      case "new_version": return j(await rpc(svc,"admin_w_email_new_version",{p_actor:actor,p_template_id:reqUuid(body.template_id),p_idem:idem,p_request_id:reqId}), 200, origin);
      case "duplicate":   return j(await rpc(svc,"admin_w_email_duplicate",{p_actor:actor,p_template_id:reqUuid(body.template_id),p_idem:idem,p_request_id:reqId}), 200, origin);
      case "archive":     return j(await rpc(svc,"admin_w_email_archive",{p_actor:actor,p_template_id:reqUuid(body.template_id),p_idem:idem,p_request_id:reqId}), 200, origin);

      case "validate": { // yazma yok
        const cls = enumv(body.email_class,["marketing","transactional"]);
        const html = reqStr(body.html ?? "", MAX_HTML, "html");
        await assertCanonicalAssets(svc, SUPABASE_URL, body.asset_manifest ?? [], [html, body.builder_json]); // FAIL-CLOSED: signed/draft/token/unmanaged reddi
        const rep = EmailSanitizer.process(html,{emailClass:cls,allowedVars:ALLOWED_VARS,remoteImageAllowlist:TRUSTED_IMAGE_HOSTS,parseHTML});
        return j({ ok:rep.ok, validation_report:rep, content_hash:await sha256Hex(rep.sanitized_html||""), preview_html:EmailSanitizer.previewSafe(rep.sanitized_html||"") }, 200, origin);
      }
      case "save": {
        const cls = enumv(body.email_class,["marketing","transactional"]);
        const html = reqStr(body.html ?? "", MAX_HTML, "html");
        if (body.builder_json && JSON.stringify(body.builder_json).length>MAX_BUILDER) throw new HttpErr(422,"builder_json_too_large");
        const rep = EmailSanitizer.process(html,{emailClass:cls,allowedVars:ALLOWED_VARS,remoteImageAllowlist:TRUSTED_IMAGE_HOSTS,parseHTML});
        if (!rep.ok) return j({ ok:false, error:"validation_failed", validation_report:rep }, 422, origin);
        // FAIL-CLOSED: kalıcı girdilerin (html + builder_json + üretilen sanitized_html) hepsinde signed/draft/token/unmanaged reddi
        await assertCanonicalAssets(svc, SUPABASE_URL, body.asset_manifest ?? [], [html, body.builder_json, rep.sanitized_html]);
        const content_hash = await sha256Hex(rep.sanitized_html);
        const builder_json_hash = body.builder_json ? await sha256Hex(JSON.stringify(body.builder_json)) : null;
        const out = await rpc(svc,"admin_w_email_version_save",{ p_actor:actor,p_template_id:reqUuid(body.template_id),
          p_subject:body.subject??null,p_preview_text:body.preview_text??null,p_sender_name:body.sender_name??null,p_reply_to:body.reply_to??null,
          p_builder_json:body.builder_json??null,p_source_html:body.source_type==="html_import"?html:null,p_sanitized_html:rep.sanitized_html,p_plain_text:rep.plain_text,
          p_asset_manifest:body.asset_manifest??[],p_variable_manifest:rep.variables_found,p_validation_report:rep,p_content_hash:content_hash,p_builder_json_hash:builder_json_hash,p_idem:idem,p_request_id:reqId });
        return j({ ...out, content_hash, builder_json_hash }, 200, origin);
      }

      case "asset_upload": {
        const b64 = body.data_base64;
        if (typeof b64!=="string" || b64.length===0 || b64.length>MAX_BASE64) throw new HttpErr(422,"bad_base64_size"); // atob'dan ÖNCE
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(b64), c=>c.charCodeAt(0)); } catch { throw new HttpErr(422,"bad_base64"); }
        if (bytes.length===0 || bytes.length>MAX_ASSET_BYTES) throw new HttpErr(422,"bad_size");
        const mime = sniffMime(bytes);
        if (!mime || !ALLOWED_MIME.includes(mime)) throw new HttpErr(422,"bad_mime_content"); // SVG/HTML/JS reddi
        const dim = imageSize(bytes, mime);
        if (dim.w===null || dim.h===null) throw new HttpErr(422,"bad_dimensions"); // boyutu çözülemeyen desteklenen görsel REDDEDİLİR (webp dahil parse edilir)
        const hash = await sha256Hex(bytes);
        const ext = mime==="image/jpeg" ? "jpg" : mime.split("/")[1];
        const path = `${hash}.${ext}`;
        const up = await svc.storage.from(DRAFT_BUCKET).upload(path, bytes, { contentType:mime, upsert:false });
        if (up.error) {
          if (!/exists/i.test(up.error.message)) { console.error("upload", up.error); throw new HttpErr(500,"upload_failed"); }
          // FAIL-CLOSED: mevcut object'i indirip hash/mime/boyut DOĞRULA (exists'i körlemesine başarı sayma)
          const ex = await svc.storage.from(DRAFT_BUCKET).download(path);
          if (ex.error) throw new HttpErr(500,"exists_but_unreadable");
          const eb = new Uint8Array(await ex.data.arrayBuffer());
          if (eb.length!==bytes.length || (await sha256Hex(eb))!==hash || sniffMime(eb)!==mime) throw new HttpErr(409,"storage_hash_conflict");
        }
        const reg = await rpc(svc,"admin_w_email_asset_register",{p_actor:actor,p_object_path:path,p_content_hash:hash,p_mime:mime,p_bytes:bytes.length,p_width:dim.w,p_height:dim.h,p_idem:idem,p_request_id:reqId});
        return j({ ...reg, path, mime, width:dim.w, height:dim.h }, 200, origin);
      }

      case "publish": { // FAIL-CLOSED orchestration
        const tid = reqUuid(body.template_id);
        const cur = await rpc(svc,"admin_q_email_template_get",{p_actor:actor,p_id:tid});
        const draft = cur?.draft;
        if (!draft) {
          // DRAFT YOK: idempotency'yi SQL RPC'ye BIRAK. Tamamlanmış aynı-key publish varsa RPC önceki
          // published_version_id sonucunu döner; gerçekten draft yoksa RPC 'no_draft_version' üretir (Edge kısa devre etmez).
          const out = await rpc(svc,"admin_w_email_publish",{p_actor:actor,p_template_id:tid,p_idem:idem,p_request_id:reqId});
          return j(out, 200, origin);
        }
        const manifest: any[] = draft.asset_manifest || [];
        const failed: string[] = [];
        // A/B/C/D: her asset'i doğrula + public'e kopyala + doğrula + promote (idempotent)
        for (const m of manifest) {
          const aid = m.asset_id;
          const { data: arow, error: aerr } = await svc.from("email_assets").select("*").eq("id", aid).maybeSingle();
          if (aerr || !arow) { failed.push(aid+":missing_db"); continue; }
          const publicPath = arow.object_path; // içerik-hash path korunur
          if (arow.status==="published") {
            // idempotent: public objesi zaten var + hash eşleşmeli
            const head = await svc.storage.from(PUBLIC_BUCKET).download(publicPath);
            if (head.error) { failed.push(aid+":public_missing_but_published"); continue; }
            const buf = new Uint8Array(await head.data.arrayBuffer());
            if (await sha256Hex(buf)!==arow.content_hash) { failed.push(aid+":public_hash_conflict"); continue; }
            continue;
          }
          const dl = await svc.storage.from(DRAFT_BUCKET).download(publicPath);
          if (dl.error) { failed.push(aid+":draft_missing"); continue; }
          const buf = new Uint8Array(await dl.data.arrayBuffer());
          if (await sha256Hex(buf)!==arow.content_hash) { failed.push(aid+":draft_hash_mismatch"); continue; }
          if (sniffMime(buf)!==arow.mime) { failed.push(aid+":mime_mismatch"); continue; }
          const cp = await svc.storage.from(PUBLIC_BUCKET).upload(publicPath, buf, { contentType:arow.mime, upsert:false });
          if (cp.error && !/exists/i.test(cp.error.message)) { failed.push(aid+":copy_failed"); continue; }
          // D: public object doğrula
          const ver = await svc.storage.from(PUBLIC_BUCKET).download(publicPath);
          if (ver.error) { failed.push(aid+":public_verify_failed"); continue; }
          const vbuf = new Uint8Array(await ver.data.arrayBuffer());
          if (await sha256Hex(vbuf)!==arow.content_hash) { failed.push(aid+":public_verify_hash"); continue; }
          // promote (RPC) — DB status=published + public_object_path
          try { await rpc(svc,"admin_w_email_asset_promote",{p_actor:actor,p_asset_id:aid,p_public_object_path:publicPath,p_content_hash:arow.content_hash,p_idem:crypto.randomUUID(),p_request_id:reqId+":"+aid}); }
          catch(e){ console.error("promote", e); failed.push(aid+":promote_failed"); }
        }
        if (failed.length) return j({ ok:false, error:"asset_promotion_failed", failed, note:"şablon YAYINLANMADI; kısmi kopyalar data_health/reconciliation ile ele alınır" }, 409, origin);
        // FAIL-CLOSED: yayınlanacak kalıcı içerikte (sanitized_html + source_html + builder_json) draft/signed/token/unmanaged URL OLMAMALI
        await assertCanonicalAssets(svc, SUPABASE_URL, (draft.asset_manifest || []), [draft.sanitized_html, draft.source_html, draft.builder_json]);
        // E/F: tüm asset'ler promoted -> DB publish (RPC yeniden doğrular)
        const out = await rpc(svc,"admin_w_email_publish",{p_actor:actor,p_template_id:tid,p_idem:idem,p_request_id:reqId});
        return j(out, 200, origin);
      }

      case "import_host_images": { // SSRF Model A: yalnız allowlist domain fetch; diğerleri manuel
        const cls = enumv(body.email_class,["marketing","transactional"]);
        const rep = EmailSanitizer.process(reqStr(body.html??"",MAX_HTML,"html"),{emailClass:cls,allowedVars:ALLOWED_VARS,remoteImageAllowlist:TRUSTED_IMAGE_HOSTS,parseHTML});
        let html = rep.sanitized_html || ""; const manual: string[] = []; const hosted: any[] = [];
        for (const asset of (rep.assets||[]).filter((x:any)=>x.type==="remote")) {
          if (!ssrfHostAllowed(asset.src)) { html = html.replaceAll(asset.src, ""); manual.push(asset.src); continue; } // SSRF: allowlist dışı -> manuel upload
          const buf = await fetchBounded(asset.src, MAX_ASSET_BYTES, 5000);       // timeout + byte-cap
          if (!buf) { html = html.replaceAll(asset.src, ""); manual.push(asset.src); continue; }
          const mime = sniffMime(buf); if (!mime) { html = html.replaceAll(asset.src, ""); manual.push(asset.src); continue; }
          const dim = imageSize(buf, mime);
          if (dim.w===null || dim.h===null) { html = html.replaceAll(asset.src, ""); manual.push(asset.src); continue; } // boyut çözülemez -> rehost yok
          const hash = await sha256Hex(buf), ext = mime==="image/jpeg"?"jpg":mime.split("/")[1], path=`${hash}.${ext}`;
          const up = await svc.storage.from(DRAFT_BUCKET).upload(path, buf, { contentType:mime, upsert:false });
          if (up.error) {
            if (!/exists/i.test(up.error.message)) { console.error("import upload", up.error); html = html.replaceAll(asset.src, ""); manual.push(asset.src); continue; }
            const ex = await svc.storage.from(DRAFT_BUCKET).download(path);       // exists -> FAIL-CLOSED doğrula
            if (ex.error) { html = html.replaceAll(asset.src, ""); manual.push(asset.src); continue; }
            const eb = new Uint8Array(await ex.data.arrayBuffer());
            if (eb.length!==buf.length || (await sha256Hex(eb))!==hash || sniffMime(eb)!==mime) { html = html.replaceAll(asset.src, ""); manual.push(asset.src+":storage_hash_conflict"); continue; }
          }
          let reg:any; try { reg = await rpc(svc,"admin_w_email_asset_register",{p_actor:actor,p_object_path:path,p_content_hash:hash,p_mime:mime,p_bytes:buf.length,p_width:dim.w,p_height:dim.h,p_idem:crypto.randomUUID(),p_request_id:reqId+":"+hash}); }
          catch(e){ console.error("import register", e); html = html.replaceAll(asset.src, ""); manual.push(asset.src); continue; } // register başarısız -> HTML rewrite YOK
          hosted.push({ asset_id: reg.asset_id, path, content_hash: hash, mime });  // gerçek hosted[]
          html = html.replaceAll(asset.src, `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`);
        }
        return j({ ok:rep.ok, rewritten_html:html, hosted, needs_manual_upload:manual, validation_report:rep }, 200, origin);
      }

      case "asset_gc": { // finalize: Edge önce storage objelerini siler, sonra RPC DB satırını
        const ids: string[] = Array.isArray(body.asset_ids) ? body.asset_ids.filter((x:string)=>UUID_RE.test(x)) : [];
        if (!ids.length) throw new HttpErr(422,"no_ids");
        const deletable: string[] = []; const storage_failed: string[] = [];
        for (const id of ids) {
          const { data: arow } = await svc.from("email_assets").select("object_path,status").eq("id", id).maybeSingle();
          if (!arow || arow.status!=="draft") continue;                       // yalnız draft aday
          const rm = await svc.storage.from(DRAFT_BUCKET).remove([arow.object_path]);
          if (rm.error) { console.error("gc remove", rm.error); storage_failed.push(id); continue; } // storage silme BAŞARISIZ -> DB finalize YOK
          deletable.push(id);                                                 // storage silindi (veya zaten yok) -> DB satırı silinebilir
        }
        // finalize YALNIZ storage'ı gerçekten silinen id'ler için (RPC ayrıca orphan-draft re-check yapar)
        const out = deletable.length ? await rpc(svc,"admin_w_email_asset_gc_finalize",{p_actor:actor,p_asset_ids:deletable,p_idem:idem,p_request_id:reqId}) : {ok:true,deleted:0,skipped:0};
        return j({ ...out, storage_failed }, 200, origin);
      }

      default: return j({ ok:false, error:"unknown_action" }, 400, origin);
    }
  } catch (e) {
    if (e instanceof HttpErr) return j({ ok:false, error:e.message }, e.code, origin);
    // ham DB/storage hatasını MASKELE; server log'a yaz, client'a bilinen kodları eşle
    console.error("email-api", action, e);
    const msg = String((e as Error)?.message || "");
    const known = ["forbidden","not_admin","not_found","idempotency_conflict","idem_required","admin_writes_disabled",
      "no_draft_version","already_published","empty_sanitized_html","validation_not_ok","missing_unsubscribe",
      "asset_not_promoted","asset_not_found","content_hash_mismatch","bad_public_path","draft_exists","version_template_mismatch"];
    const hit = known.find(k => msg.includes(k));
    return j({ ok:false, error: hit || "internal_error" }, hit==="forbidden"||hit==="not_admin" ? 403 : (hit==="idempotency_conflict" ? 409 : 400), origin);
  }
});

function reqUuid(v: unknown): string { if (typeof v!=="string" || !UUID_RE.test(v)) throw new HttpErr(422,"bad_uuid"); return v; }
function enumv(v: unknown, allowed: string[]): string { if (typeof v!=="string" || !allowed.includes(v)) throw new HttpErr(422,"bad_enum"); return v; }
async function rpc(svc: any, fn: string, args: Record<string, unknown>) {
  const { data, error } = await svc.rpc(fn, args);
  if (error) throw new Error(fn+":"+error.message);
  return data;
}
