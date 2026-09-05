// ASALOCAL · CDP-3B · Gate 4-9 GERÇEK assertion + fault-injection testleri (Deno).
//   deno test --allow-net --allow-env gates/e2e_gates.ts
// Ortam (ZORUNLU): EMAIL_API_URL, SUPER_JWT, CRM_JWT, SUPABASE_DB_URL, SERVICE_KEY
// Opsiyonel (Gate8 accept alt-durumu için): E2E_IMG_URL (edge fonksiyonunun ERİŞEBİLECEĞİ, allowlist'e alınmış http(s) PNG)
// Production'a DOKUNMAZ; yalnız yerel/geçici stack. Her test assertion üretir; hata -> non-zero exit.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const API = Deno.env.get("EMAIL_API_URL")!;
const SUPER = Deno.env.get("SUPER_JWT")!;
const CRM = Deno.env.get("CRM_JWT")!;
const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const SERVICE_KEY = Deno.env.get("SERVICE_KEY") || "";
const STORAGE = API.replace(/\/functions\/v1\/email-api$/, "") + "/storage/v1";
const DRAFT_BUCKET = "email-assets-draft";
const uuid = () => crypto.randomUUID();
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// GATE6 izolasyonu için AYRI, deterministik, geçerli 1x1 RGBA PNG (farklı binary/SHA/path; PNG_1x1 ile paylaşılmaz)
const PNG_UNIQUE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO4I2LzHwAFKAIsz1ZnywAAAABJRU5ErkJggg==";
const b64bytes = (b64:string)=>Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
async function sha256Hex(u:Uint8Array){ const d=await crypto.subtle.digest("SHA-256",u); return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join(""); }

// --- freshTestImage(): her çağrıda BENZERSİZ + biçim-geçerli 1x1 PNG (içerik-hash dedupe'u tetiklenmez).
// Geçerli PNG_1x1'in IHDR'sinden HEMEN SONRA rasgele UUID içeren GEÇERLİ bir tEXt ancillary chunk eklenir (CRC hesaplı).
// magic (PNG imzası) + IHDR (1x1 boyut, offset 16..23) DEĞİŞMEZ -> sunucu magic/boyut kontrolünü geçer; ham baytlar
// FARKLI -> sha256 içerik-hash'i FARKLI. Bozuk dosyaya rasgele bayt EKLENMEZ; gerçek, CRC-geçerli chunk kullanılır.
const _CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
function _crc32(b:Uint8Array){let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=_CRC[(c^b[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function _u32(n:number){return new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);}
function _pngChunk(type:string,data:Uint8Array){
  const tb=new TextEncoder().encode(type); const body=new Uint8Array(tb.length+data.length); body.set(tb,0); body.set(data,tb.length);
  const out=new Uint8Array(4+body.length+4); out.set(_u32(data.length),0); out.set(body,4); out.set(_u32(_crc32(body)),4+body.length); return out;
}
function freshTestImage():string{
  const base=b64bytes(PNG_1x1);                          // sig(8)+IHDR(25)+IDAT+IEND ; head(sig+IHDR)=33
  const head=base.slice(0,33), tail=base.slice(33);      // tEXt'i IHDR sonrası / IDAT öncesi ekle (geçerli chunk sırası)
  const text=new TextEncoder().encode("Comment"+String.fromCharCode(0)+uuid());  // GEÇERLİ tEXt: keyword \0 text (rasgele -> benzersiz)
  const t=_pngChunk("tEXt",text);
  const out=new Uint8Array(head.length+t.length+tail.length); out.set(head,0); out.set(t,head.length); out.set(tail,head.length+t.length);
  let s=""; for(let i=0;i<out.length;i++) s+=String.fromCharCode(out[i]); return btoa(s);
}

async function api(action:string, fields:Record<string,unknown>, jwt:string, extraHeaders:Record<string,string>={}){
  const r = await fetch(API,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+jwt,...extraHeaders},body:JSON.stringify({action,...fields})});
  let body:any=null; try{ body=await r.json(); }catch{ /*noop*/ }
  return { status:r.status, body };
}
async function db<T=any>(sql:string, args:unknown[]=[]):Promise<T[]>{
  const c=new Client(DB_URL); await c.connect();
  try{ const r=await c.queryObject<T>(sql, args as any); return r.rows; } finally{ await c.end(); }
}
// storage REST (service_role) — fault injection için object yaz/sil.
// Response body DETERMİNİSTİK olarak tam tüketilir (await resp.text()); ham Response caller'a DÖNMEZ
// -> Deno resource-leak dedektörü tetiklenmez (sanitizeResources/Ops GEVŞETİLMEZ).
async function putObject(bucket:string, path:string, bytes:Uint8Array, mime:string):Promise<{ok:boolean,status:number,bodyText:string}>{
  const resp=await fetch(`${STORAGE}/object/${bucket}/${path}`,{method:"POST",headers:{apikey:SERVICE_KEY,Authorization:"Bearer "+SERVICE_KEY,"Content-Type":mime,"x-upsert":"true"},body:bytes});
  const bodyText=await resp.text();
  return { ok:resp.ok, status:resp.status, bodyText };
}
async function delObject(bucket:string, path:string):Promise<{ok:boolean,status:number,bodyText:string}>{
  const resp=await fetch(`${STORAGE}/object/${bucket}/${path}`,{method:"DELETE",headers:{apikey:SERVICE_KEY,Authorization:"Bearer "+SERVICE_KEY}});
  const bodyText=await resp.text();
  return { ok:resp.ok, status:resp.status, bodyText };
}
async function mkPublishedTemplate(){
  const c = await api("create",{internal_name:"E2E "+uuid().slice(0,8),description:"e2e",email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  assertEquals(c.status,200,"create"); const tid=c.body.template_id;
  const up = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  assertEquals(up.status,200,"asset_upload:"+JSON.stringify(up.body)); const aid=up.body.asset_id, path=up.body.path;
  const pub=`${API.replace(/\/functions\/v1\/email-api$/,"")}/storage/v1/object/public/email-assets-public/${path}`;
  const html=`<table><tr><td><img src="${pub}" alt="x" width="1" height="1"><a href="{{unsubscribe_url}}">çık</a></td></tr></table>`;
  const sidem=uuid();
  const s=await api("save",{template_id:tid,email_class:"marketing",source_type:"visual_builder",subject:"E2E",html,builder_json:{root:1},asset_manifest:[{asset_id:aid,public_path:path}],idem:sidem,request_id:sidem},CRM);
  assertEquals(s.status,200,"save:"+JSON.stringify(s.body));
  const p=await api("publish",{template_id:tid,idem:uuid(),request_id:uuid()},SUPER);
  assertEquals(p.status,200,"publish:"+JSON.stringify(p.body));
  return { tid, aid, path };
}

// ---------- GATE 4: publish retry -> DB audit sayısı = 1 (aynı published_version_id) ----------
Deno.test("GATE4: aynı-key publish retry -> tek audit (admin_write_log idem=1) + aynı published_version_id", async () => {
  const c = await api("create",{internal_name:"G4 "+uuid().slice(0,8),description:null,email_class:"transactional",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const tid=c.body.template_id;
  const s=await api("save",{template_id:tid,email_class:"transactional",source_type:"visual_builder",subject:"g4",html:"<p>kod 123 {{unsubscribe_url}}</p>",builder_json:{r:1},asset_manifest:[],idem:uuid(),request_id:uuid()},CRM);
  assertEquals(s.status,200,"save:"+JSON.stringify(s.body));
  const pidem=uuid();
  const p1=await api("publish",{template_id:tid,idem:pidem,request_id:pidem},SUPER);
  assertEquals(p1.status,200,"publish1:"+JSON.stringify(p1.body)); const v1=p1.body.published_version_id;
  const n1=await db<{n:bigint}>("select count(*)::int as n from public.admin_write_log where idempotency_key=$1",[pidem]);
  assertEquals(Number(n1[0].n),1,"ilk publish sonrası tam 1 audit satırı");
  // yanıt kaybı simülasyonu: AYNI idem retry
  const p2=await api("publish",{template_id:tid,idem:pidem,request_id:pidem},SUPER);
  assertEquals(p2.status,200,"publish2"); assertEquals(p2.body.published_version_id,v1,"retry aynı published_version_id");
  const n2=await db<{n:bigint}>("select count(*)::int as n from public.admin_write_log where idempotency_key=$1",[pidem]);
  assertEquals(Number(n2[0].n),1,"retry sonrası HÂLÂ tek audit (ikinci audit YOK)");
});

// ---------- GATE 5A: aynı-idem paralel new_version -> aynı version_id, version-delta=1, tek unpublished, pointer eşleşir, tek audit ----------
Deno.test("GATE5A: paralel new_version aynı idem -> aynı version_id + version-delta=1 + tek unpublished + pointer eşleşir + tek audit", async () => {
  const t=await mkPublishedTemplate(); const nidem=uuid();
  // (A) çağrılardan ÖNCE: toplam version sayısı + version ID listesi
  const before=await db<{id:string}>("select id from public.email_template_versions where template_id=$1",[t.tid]);
  const beforeIds=new Set(before.map(r=>r.id));
  const [a,b]=await Promise.all([
    api("new_version",{template_id:t.tid,idem:nidem,request_id:nidem},CRM),
    api("new_version",{template_id:t.tid,idem:nidem,request_id:nidem},CRM),
  ]);
  assertEquals(a.status,200,"a"); assertEquals(b.status,200,"b");
  assertEquals(a.body.version_id,b.body.version_id,"aynı idem -> aynı version_id");
  const vid=a.body.version_id;
  // (B) çağrılardan SONRA: toplam version = before+1; tam 1 yeni ID = response version_id
  const after=await db<{id:string}>("select id from public.email_template_versions where template_id=$1",[t.tid]);
  assertEquals(after.length, before.length+1, "toplam version tam olarak before+1");
  const newIds=after.map(r=>r.id).filter(id=>!beforeIds.has(id));
  assertEquals(newIds.length,1,"tam olarak 1 yeni version eklendi");
  assertEquals(newIds[0], vid, "yeni version ID = başarılı response version_id");
  // is_published=false (draft) sayısı tam 1
  const unpub=await db<{n:number}>("select count(*)::int as n from public.email_template_versions where template_id=$1 and is_published=false",[t.tid]);
  assertEquals(Number(unpub[0].n),1,"tam 1 unpublished (current draft) version");
  // email_templates.current_draft_version_id = response version_id
  const ptr=await db<{cid:string|null}>("select current_draft_version_id as cid from public.email_templates where id=$1",[t.tid]);
  assertEquals(ptr[0].cid, vid, "current_draft_version_id = response version_id");
  // aynı idem retry -> tek audit
  const aud=await db<{n:number}>("select count(*)::int as n from public.admin_write_log where idempotency_key=$1",[nidem]);
  assertEquals(Number(aud[0].n),1,"tek audit");
});

// ---------- GATE 5B: FARKLI-idem paralel new_version -> biri kazanır, diğeri draft_exists; version-delta=1, tek unpublished, pointer eşleşir ----------
Deno.test("GATE5B: paralel new_version farklı idem -> biri 200 biri draft_exists + version-delta=1 + tek unpublished + pointer eşleşir", async () => {
  const t=await mkPublishedTemplate();
  // (A) çağrılardan ÖNCE: toplam version sayısı + version ID listesi
  const before=await db<{id:string}>("select id from public.email_template_versions where template_id=$1",[t.tid]);
  const beforeIds=new Set(before.map(r=>r.id));
  const [a,b]=await Promise.all([
    api("new_version",{template_id:t.tid,idem:uuid(),request_id:uuid()},CRM),
    api("new_version",{template_id:t.tid,idem:uuid(),request_id:uuid()},CRM),
  ]);
  const oks=[a,b].filter(x=>x.status===200);
  const rej=[a,b].filter(x=>x.status>=400);
  assertEquals(oks.length,1,"tam biri başarılı");
  assertEquals(rej.length,1,"tam biri reddedildi");
  assertEquals(rej[0].body?.error,"draft_exists","reddin sebebi draft_exists");
  const vid=oks[0].body.version_id;
  // (B) çağrılardan SONRA: toplam version = before+1; tam 1 yeni ID = başarılı response version_id
  const after=await db<{id:string}>("select id from public.email_template_versions where template_id=$1",[t.tid]);
  assertEquals(after.length, before.length+1, "toplam version tam olarak before+1");
  const newIds=after.map(r=>r.id).filter(id=>!beforeIds.has(id));
  assertEquals(newIds.length,1,"tam olarak 1 yeni version eklendi");
  assertEquals(newIds[0], vid, "yeni version ID = başarılı response version_id");
  // is_published=false (draft) sayısı tam 1
  const unpub=await db<{n:number}>("select count(*)::int as n from public.email_template_versions where template_id=$1 and is_published=false",[t.tid]);
  assertEquals(Number(unpub[0].n),1,"yalnız tek current draft (unpublished)");
  // DB pointer = başarılı response version_id
  const ptr=await db<{cid:string|null}>("select current_draft_version_id as cid from public.email_templates where id=$1",[t.tid]);
  assertEquals(ptr[0].cid, vid, "current_draft_version_id = başarılı response version_id");
});

// ---------- GATE 6: storage_hash_conflict GERÇEK fault injection (İZOLE: benzersiz fixture) ----------
Deno.test("GATE6: benzersiz görsel path'ini boz -> asset_upload 409 storage_hash_conflict + register/audit YOK (izole)", async () => {
  assert(SERVICE_KEY.length>0,"SERVICE_KEY gerekli (fault injection)");
  // AYRI, deterministik ikinci fixture (farklı binary/SHA/path). PNG_1x1 KULLANILMAZ.
  const bytes=b64bytes(PNG_UNIQUE); const hash=await sha256Hex(bytes); const path=`${hash}.png`;
  const png1Hash=await sha256Hex(b64bytes(PNG_1x1));
  assertNotEquals(hash, png1Hash, "benzersiz fixture hash'i PNG_1x1 hash'inden FARKLI olmalı");
  // Precondition-1: bu hash/path için email_assets kaydı YOK
  const reg0=await db<{n:number}>("select count(*)::int as n from public.email_assets where content_hash=$1 or object_path=$2",[hash,path]);
  assertEquals(Number(reg0[0].n),0,"precondition: bu hash/path için register=0");
  // Precondition-2: draft bucket'ta bu path fiziksel olarak YOK
  const obj0=await db<{n:number}>("select count(*)::int as n from storage.objects where bucket_id=$1 and name=$2",[DRAFT_BUCKET,path]);
  assertEquals(Number(obj0[0].n),0,"precondition: draft bucket'ta path yok");
  try{
    // draft path'e YANLIŞ (farklı uzunlukta) içerik koy -> hash uyuşmazlığı zorla.
    // PUT HTTP başarısızlığı SESSİZCE YUTULMAZ (assert + bodyText).
    const corrupt=new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13]);
    const pr=await putObject(DRAFT_BUCKET,path,corrupt,"image/png");
    assert(pr.ok||pr.status===200,"corrupt put başarısız: status="+pr.status+" body="+pr.bodyText);
    const idem=uuid();
    const up=await api("asset_upload",{data_base64:PNG_UNIQUE,idem,request_id:idem},CRM);
    assertEquals(up.status,409,"bozuk object -> 409:"+JSON.stringify(up.body));
    assertEquals(up.body?.error,"storage_hash_conflict","hata storage_hash_conflict");
    const aud=await db<{n:number}>("select count(*)::int as n from public.admin_write_log where idempotency_key=$1",[idem]);
    assertEquals(Number(aud[0].n),0,"conflict'te audit YOK");
    const reg=await db<{n:number}>("select count(*)::int as n from public.email_assets where content_hash=$1 and object_path=$2",[hash,path]);
    assertEquals(Number(reg[0].n),0,"conflict'te register YOK");
  } finally {
    // Test object'ini draft bucket'tan TAMAMEN sil (doğru içeriği geri YÜKLEME).
    // DELETE HTTP sonucu ASSERT edilir (sessizce yutulmaz), sonra fiziksel silme DB'den doğrulanır -> orphan yok.
    const del=await delObject(DRAFT_BUCKET,path);
    assert(del.ok||del.status===200||del.status===204,"cleanup delete başarısız: status="+del.status+" body="+del.bodyText);
    const obj1=await db<{n:number}>("select count(*)::int as n from storage.objects where bucket_id=$1 and name=$2",[DRAFT_BUCKET,path]);
    assertEquals(Number(obj1[0].n),0,"cleanup: test object'i tamamen silinmiş olmalı (reconcile için orphan yok)");
  }
});

// ---------- GATE 7/8: import_host_images allowlist-reject (her ortamda gerçek) ----------
Deno.test("GATE8-reject: allowlist dışı host -> hosted boş, needs_manual_upload dolu, src rewrite YOK", async () => {
  const evil="https://evil.example.com/x.png";
  const html=`<table><tr><td><img src="${evil}" width="2" height="2"><a href="{{unsubscribe_url}}">çık</a></td></tr></table>`;
  const r=await api("import_host_images",{email_class:"marketing",html,idem:uuid(),request_id:uuid()},CRM);
  assertEquals(r.status,200,"status:"+JSON.stringify(r.body));
  assertEquals((r.body.hosted||[]).length,0,"hosted boş");
  assert((r.body.needs_manual_upload||[]).includes(evil),"needs_manual_upload evil src içerir");
  assert(!String(r.body.rewritten_html||"").includes(evil),"evil src rewrite edilmedi (kaldırıldı)");
});

// ---------- GATE 8: import_host_images GERÇEK rehost (allowlist'li E2E host) ----------
Deno.test({
  name: "GATE8-accept: allowlist'li host -> rehost, managed public path, manifest->save->publish, get manifest korunur",
  ignore: !Deno.env.get("E2E_IMG_URL"),
  fn: async () => {
    const imgUrl=Deno.env.get("E2E_IMG_URL")!;   // edge fonksiyonunun erişebildiği, allowlist'e alınmış PNG
    const t=await api("create",{internal_name:"G8 "+uuid().slice(0,8),description:"g8",email_class:"marketing",source_type:"html_import",idem:uuid(),request_id:uuid()},CRM);
    const tid=t.body.template_id;
    const html=`<table><tr><td><img src="${imgUrl}" width="1" height="1"><a href="{{unsubscribe_url}}">çık</a></td></tr></table>`;
    const imp=await api("import_host_images",{email_class:"marketing",html,idem:uuid(),request_id:uuid()},CRM);
    assertEquals(imp.status,200,"import:"+JSON.stringify(imp.body));
    assertEquals((imp.body.hosted||[]).length,1,"tam 1 hosted");
    const hp=imp.body.hosted[0].path;
    assert(String(imp.body.rewritten_html).includes(`/object/public/email-assets-public/${hp}`),"managed public path'e rewrite");
    assert(!String(imp.body.rewritten_html).includes(imgUrl),"orijinal uzak src kaldı MI (kalmamalı)");
    const s=await api("save",{template_id:tid,email_class:"marketing",source_type:"html_import",subject:"G8",html:imp.body.rewritten_html,asset_manifest:[{asset_id:imp.body.hosted[0].asset_id,public_path:hp}],idem:uuid(),request_id:uuid()},CRM);
    assertEquals(s.status,200,"save:"+JSON.stringify(s.body));
    const p=await api("publish",{template_id:tid,idem:uuid(),request_id:uuid()},SUPER);
    assertEquals(p.status,200,"publish:"+JSON.stringify(p.body));
    const g=await api("get",{template_id:tid},SUPER);
    const man=g.body.published?.asset_manifest||[];
    assert(man.some((m:any)=>m.asset_id===imp.body.hosted[0].asset_id),"reopen'da manifest korunur");
  }
});

// ---------- GATE 7: immutability — yayınlanmışta save reddi ----------
Deno.test("GATE7: yayınlanmışta save -> no_draft_version (immutable)", async () => {
  const t=await mkPublishedTemplate();
  const s=await api("save",{template_id:t.tid,email_class:"marketing",source_type:"visual_builder",subject:"x",html:"<p>{{unsubscribe_url}}</p>",builder_json:{r:1},asset_manifest:[],idem:uuid(),request_id:uuid()},CRM);
  assert(s.status>=400,"yayınlanmışta save reddi"); assertEquals(s.body.error,"no_draft_version");
});

// ---------- GATE 9: reconcile fail-closed shape + rol + DB/storage error fault injection + pagination ----------
Deno.test("GATE9a: reconcile super_admin shape + crm forbidden + scanned pagination", async () => {
  const r=await api("reconcile",{},SUPER);
  assertEquals(r.status,200,"reconcile super:"+JSON.stringify(r.body));
  for (const k of ["storage_only_orphan","db_only_missing","wrong_status_path","published_missing_public","scanned","truncated"]) assert(k in r.body,"alan "+k);
  const dbrows=await db<{n:number}>("select count(*)::int as n from public.email_assets",[]);
  assertEquals(Number(r.body.scanned.db_rows),Number(dbrows[0].n),"scanned.db_rows == gerçek email_assets sayısı (DB okundu)");
  assert(typeof r.body.scanned.draft_objects==="number" && typeof r.body.scanned.public_objects==="number","scanned object sayıları numerik (list sayfalandı)");
  assertEquals(r.body.truncated,false,"küçük veri setinde truncated=false");
  const rc=await api("reconcile",{},CRM);
  assert(rc.status===403||rc.body?.error==="forbidden","crm reconcile forbidden");
});

Deno.test("GATE9b: DB error fault injection -> 500 reconcile_db_error (asla ok/0 dönmez)", async () => {
  assert(SERVICE_KEY.length>0,"SERVICE_KEY gerekli");
  await db("revoke select on public.email_assets from service_role",[]);
  try{
    const r=await api("reconcile",{},SUPER);
    assertEquals(r.status,500,"db error -> 500:"+JSON.stringify(r.body));
    assertEquals(r.body?.error,"reconcile_db_error","reconcile_db_error");
    assertNotEquals(r.body?.ok,true,"asla ok:true");
  } finally { await db("grant select on public.email_assets to service_role",[]); }
});

// GATE9c: reconcile Storage-list hata kolu -> 500 reconcile_storage_error.
// Yaklaşım: EMAIL_API_E2E=1 test-seam. 'x-asa-e2e-fault: storage-list-error' başlığı, GERÇEK listeleme yardımcısının
// hata kolunu ({data:null,error} eşdeğeri) deterministik tetikler; ardından ÜRETİMDEKİ if(error) dalı maskeli 500 üretir.
// Prod'da EMAIL_API_E2E set edilmez -> başlık TAMAMEN inert. Bu, GERÇEK altyapı kesintisi DEĞİLDİR; yalnız Storage istemcisinin
// gerçek hata-işleme dalını deterministik çalıştırır (gerçek kesinti testi ayrı staging işidir).
Deno.test("GATE9c: E2E storage-list fault seam -> 500 reconcile_storage_error (rol kapısı korunur, prod-inert)", async () => {
  const FAULT = { "x-asa-e2e-fault": "storage-list-error" };
  // (1) super_admin + fault başlığı: rol kapısı GEÇİLİR, sonra listeleme yardımcısının hata kolu -> maskeli 500
  const r = await api("reconcile", {}, SUPER, FAULT);
  assertEquals(r.status, 500, "super+fault -> 500:"+JSON.stringify(r.body));
  assertEquals(r.body?.error, "reconcile_storage_error", "error tam olarak reconcile_storage_error");
  assertNotEquals(r.body?.ok, true, "asla ok:true");
  // ham hata ayrıntısı istemciye SIZMAMALI (yalnız maskeli kod döner)
  assert(!JSON.stringify(r.body||{}).includes("e2e_injected"), "ham hata ayrıntısı istemciye sızmamalı");
  // (2) CRM/yetkisiz rol + AYNI başlık: rol kapısı fault'tan ÖNCE -> forbidden. Başlık yetki kapısını AŞMAZ.
  const rc = await api("reconcile", {}, CRM, FAULT);
  assert(rc.status===403 || rc.body?.error==="forbidden", "crm+fault -> forbidden (rol kapısı önce):"+rc.status+" "+JSON.stringify(rc.body));
  assertNotEquals(rc.body?.error, "reconcile_storage_error", "crm+fault -> storage_error DEĞİL (rol kapısı fault'tan önce)");
  // (3) fault YOK -> hemen sonraki normal reconcile: HTTP 200 + ok:true (kalıcı yan etki YOK; seam idempotent/inert)
  const r2 = await api("reconcile", {}, SUPER);
  assertEquals(r2.status, 200, "fault sonrası normal reconcile 200:"+JSON.stringify(r2.body));
  assertEquals(r2.body?.ok, true, "normal reconcile ok:true");
});

// ==================== CDP-3B PATCH · taslak görsel önizleme + fail-closed içerik denetimi ====================
const BASE = API.replace(/\/functions\/v1\/email-api$/, "");
const PUBURL = (p:string)=>`${BASE}/storage/v1/object/public/email-assets-public/${p}`;

// asset'i verilen template'in CURRENT DRAFT sürümüne bağla (save -> manifest). aid+path döndürür.
async function bindAssetToCurrentDraft(tid:string, jwt:string){
  const up = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},jwt);
  assertEquals(up.status,200,"asset_upload:"+JSON.stringify(up.body));
  const aid=up.body.asset_id, path=up.body.path;
  const html=`<table><tr><td><img src="${PUBURL(path)}" alt="x" width="1" height="1"><a href="{{unsubscribe_url}}">çık</a></td></tr></table>`;
  const s=await api("save",{template_id:tid,email_class:"marketing",source_type:"visual_builder",subject:"bind",html,builder_json:{root:1},asset_manifest:[{asset_id:aid,public_path:path}],idem:uuid(),request_id:uuid()},jwt);
  assertEquals(s.status,200,"save:"+JSON.stringify(s.body));
  return { aid, path };
}
const FNSIG = "public.admin_q_email_asset_preview(uuid,uuid[],uuid)";

// ---------- AP1: kendi yeni ve henüz bağlanmamış upload -> preview VAR (+ signed/token/no-store/ttl) ----------
Deno.test("AP1: kendi taze (hiçbir sürüme bağlı olmayan) upload -> preview VAR; signed URL + token + no-store + ttl=600", async () => {
  const up = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  assertEquals(up.status,200,"asset_upload:"+JSON.stringify(up.body)); const aid=up.body.asset_id;
  const p = await api("asset_preview",{asset_ids:[aid]},CRM);          // template YOK -> yalnız branch (B) taze-upload yolu
  assertEquals(p.status,200,"preview:"+JSON.stringify(p.body));
  assertEquals((p.body.previews||[]).length,1,"taze upload: tam 1 preview");
  assertEquals(p.body.previews[0].asset_id,aid,"preview asset_id eşleşir");
  assert(/\/storage\/v1\/object\/sign\//.test(p.body.previews[0].url),"signed endpoint (sign/)");
  assert(/[?&]token=/.test(p.body.previews[0].url),"kısa-ömürlü token query");
  assertEquals((p.body.unavailable_asset_ids||[]).length,0,"unavailable yok");
  assertEquals(p.body.ttl,600,"ttl=600");
  const raw = await fetch(API,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+CRM},body:JSON.stringify({action:"asset_preview",asset_ids:[aid]})});
  assertEquals(raw.headers.get("cache-control"),"no-store","Cache-Control: no-store");
  await raw.text();
});

// ---------- AP2: current draft'a bağlı kendi asset'i -> preview VAR ----------
Deno.test("AP2: current draft sürümüne bağlı kendi asset'i -> preview VAR (branch A, doğru template_id)", async () => {
  const c = await api("create",{internal_name:"AP2 "+uuid().slice(0,8),email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const tid=c.body.template_id;
  const { aid } = await bindAssetToCurrentDraft(tid, CRM);            // artık bir sürüm manifestinde -> branch B kapanır, branch A açılır
  const ok = await api("asset_preview",{asset_ids:[aid],template_id:tid},CRM);
  assertEquals(ok.status,200,"ok:"+JSON.stringify(ok.body));
  assertEquals((ok.body.previews||[]).length,1,"current draft: preview VAR");
  assertEquals(ok.body.previews[0].asset_id,aid,"asset_id eşleşir");
  // NOT: branch (A) aktör kontrolü yapmaz (bir template'in taslak asset'ini herhangi bir editör önizleyebilir);
  //      SUPER da doğru template_id ile önizleyebilir — bu tasarım gereğidir, AP3/AP5 sızıntıyı ayrıca dışlar.
});

// ---------- AP3: aynı actor'ın BAŞKA template current draft'ına bağlı asset'i -> preview YOK ----------
Deno.test("AP3: aynı actor'ın başka template current draft'ına bağlı asset'i -> FARKLI template_id ile ve template'siz -> preview YOK", async () => {
  const c1 = await api("create",{internal_name:"AP3a "+uuid().slice(0,8),email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const tid1=c1.body.template_id;
  const { aid } = await bindAssetToCurrentDraft(tid1, CRM);           // aid, tid1'in current draft'ına bağlı (CRM sahibi)
  const c2 = await api("create",{internal_name:"AP3b "+uuid().slice(0,8),email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const tid2=c2.body.template_id;
  // (1) BAŞKA template_id (tid2) ile: branch A tid2 current draft'ında yok; branch B kapalı (aid bir sürüme bağlı) -> YOK
  const r1 = await api("asset_preview",{asset_ids:[aid],template_id:tid2},CRM);
  assertEquals(r1.status,200,"r1:"+JSON.stringify(r1.body));
  assertEquals((r1.body.previews||[]).length,0,"başka template: preview YOK (created_by tek başına yetki vermez)");
  assert((r1.body.unavailable_asset_ids||[]).includes(aid),"başka template: unavailable");
  // (2) template'siz: branch A uygulanamaz; branch B kapalı (bağlı) -> YOK
  const r2 = await api("asset_preview",{asset_ids:[aid]},CRM);
  assertEquals((r2.body.previews||[]).length,0,"template'siz: preview YOK (bağlı asset created_by ile dönmez)");
  assert((r2.body.unavailable_asset_ids||[]).includes(aid),"template'siz: unavailable");
});

// ---------- AP4: aynı template'in ESKİ/non-current draft'ına bağlı asset -> preview YOK ----------
Deno.test("AP4: aynı template'in non-current (pointer'ı kaldırılmış) draft'ına bağlı asset -> preview YOK", async () => {
  const c = await api("create",{internal_name:"AP4 "+uuid().slice(0,8),email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const tid=c.body.template_id;
  const { aid } = await bindAssetToCurrentDraft(tid, CRM);            // aid, tid'in (o an current) draft'ının manifestinde
  // O draft'ı NON-CURRENT yap: pointer'ı kaldır (deferred pointer-check yalnız not-null'da doğrular; null geçerli).
  // Sürüm hâlâ is_published=false ve manifestinde aid var; ama artık current_draft_version_id DEĞİL. Asset status='draft'.
  await db("update public.email_templates set current_draft_version_id=null where id=$1",[tid]);
  const r = await api("asset_preview",{asset_ids:[aid],template_id:tid},CRM);
  assertEquals(r.status,200,"r:"+JSON.stringify(r.body));
  assertEquals((r.body.previews||[]).length,0,"non-current draft bağı: preview YOK (branch A yalnız current draft)");
  assert((r.body.unavailable_asset_ids||[]).includes(aid),"non-current draft bağı: unavailable");
});

// ---------- AP5: başka actor'ın bağlanmamış asset'i -> preview YOK ----------
Deno.test("AP5: başka actor'ın (SUPER) taze/bağlanmamış asset'ini CRM önizleyemez -> preview YOK", async () => {
  const up = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},SUPER); // created_by=SUPER
  assertEquals(up.status,200,"asset_upload:"+JSON.stringify(up.body)); const aid=up.body.asset_id;
  const r = await api("asset_preview",{asset_ids:[aid]},CRM);          // CRM sahibi değil, bağ yok -> her iki branch kapalı
  assertEquals(r.status,200,"r:"+JSON.stringify(r.body));
  assertEquals((r.body.previews||[]).length,0,"başka actor unbound: preview YOK");
  assert((r.body.unavailable_asset_ids||[]).includes(aid),"başka actor unbound: unavailable");
});

// ---------- AP6: published asset -> signed draft preview YOK (kanonik public URL kullanılır) ----------
Deno.test("AP6: published asset -> signed draft preview YOK (status filtresi 'draft','promoting' ile dışlanır)", async () => {
  const t=await mkPublishedTemplate();                                // t.aid publish sonrası status='published'
  const st=await db<{status:string}>("select status from public.email_assets where id=$1",[t.aid]);
  assertEquals(st[0]?.status,"published","önkoşul: asset published");
  const r = await api("asset_preview",{asset_ids:[t.aid],template_id:t.tid},SUPER);
  assertEquals(r.status,200,"r:"+JSON.stringify(r.body));
  assertEquals((r.body.previews||[]).length,0,"published: signed preview YOK");
  assert((r.body.unavailable_asset_ids||[]).includes(t.aid),"published: unavailable (public URL kullanılmalı)");
  assert(!/\/storage\/v1\/object\/sign\//.test(JSON.stringify(r.body)),"published: yanıtta hiç signed endpoint yok");
});

// ---------- AP7: 2 asset'ten biri yetkisiz -> previews yalnız yetkiliyi, unavailable diğerini döndürür ----------
Deno.test("AP7: karışık istek -> previews yalnız yetkili asset'i, unavailable_asset_ids yalnız yetkisizi döndürür", async () => {
  const upOwn = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);   // CRM taze -> yetkili (B)
  const aOwn=upOwn.body.asset_id;
  const upOther = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},SUPER); // SUPER taze -> CRM için yetkisiz
  const aOther=upOther.body.asset_id;
  const r = await api("asset_preview",{asset_ids:[aOwn,aOther]},CRM);
  assertEquals(r.status,200,"r:"+JSON.stringify(r.body));
  assertEquals((r.body.previews||[]).length,1,"tam 1 preview (yalnız yetkili)");
  assertEquals(r.body.previews[0].asset_id,aOwn,"preview yalnız kendi asset'i");
  assertEquals((r.body.unavailable_asset_ids||[]).length,1,"tam 1 unavailable");
  assertEquals(r.body.unavailable_asset_ids[0],aOther,"unavailable yalnız yetkisiz asset");
});

// ---------- AP8: CRM/super_admin izinli; yetkisiz rol/authenticated forbidden ----------
Deno.test("AP8: CRM+SUPER izinli (200); RPC EXECUTE yalnız service_role (anon/authenticated FORBIDDEN)", async () => {
  const upC = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  const rc = await api("asset_preview",{asset_ids:[upC.body.asset_id]},CRM);
  assertEquals(rc.status,200,"CRM izinli:"+JSON.stringify(rc.body));
  const upS = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},SUPER);
  const rs = await api("asset_preview",{asset_ids:[upS.body.asset_id]},SUPER);
  assertEquals(rs.status,200,"SUPER izinli:"+JSON.stringify(rs.body));
  // Yetki sınırı (deny-all): parametreli RPC yalnız service_role'e EXECUTE. anon/authenticated doğrudan çağıramaz.
  const g=await db<{svc:boolean,auth:boolean,anon:boolean}>(
    `select has_function_privilege('service_role',$1,'execute') as svc,
            has_function_privilege('authenticated',$1,'execute') as auth,
            has_function_privilege('anon',$1,'execute') as anon`,[FNSIG]);
  assertEquals(g[0].svc,true,"service_role EXECUTE var");
  assertEquals(g[0].auth,false,"authenticated EXECUTE YOK (forbidden)");
  assertEquals(g[0].anon,false,"anon EXECUTE YOK (forbidden)");
});

// ---------- AP9: ham UUID/path dışında storage hatası client'a sızmaz ----------
Deno.test("AP9: yanıt sözleşmesi sızdırmaz — yalnız {ok,previews[{asset_id,url}],unavailable_asset_ids,ttl}; storage hata iç detayı YOK", async () => {
  // (1) yapısal: yetkili + yetkisiz karışık istek -> yanıt anahtarları sabit; preview öğeleri yalnız asset_id,url
  const upOwn = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  const rr = await api("asset_preview",{asset_ids:[upOwn.body.asset_id, uuid()]},CRM); // ikinci id: kayıtsız (RPC hiç dönmez)
  assertEquals(rr.status,200,"rr:"+JSON.stringify(rr.body));
  assertEquals(Object.keys(rr.body).sort().join(","),"ok,previews,ttl,unavailable_asset_ids","yanıt anahtarları tam sabit");
  for (const pv of (rr.body.previews||[])) assertEquals(Object.keys(pv).sort().join(","),"asset_id,url","preview öğesi yalnız asset_id,url (object_path YOK)");
  assert(!JSON.stringify(rr.body).includes("object_path"),"yanıtta object_path anahtarı yok");
  // (2) gerçek sign-hatası fault: bağlanmamış kendi asset'inin object_path'ini var-olmayan geçerli-biçimli path ile değiştir.
  //     RPC yine döner (branch B: created_by=CRM, bağsız), ama createSignedUrl 404 -> index.ts unavailable'a düşer, ham hata DÖNMEZ.
  const upF = await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  const aF=upF.body.asset_id;
  // object_path check '<64hex>.<ext>' ve mime=png ister; storage'da fiziksel karşılığı OLMAYAN geçerli-biçimli path ata.
  const ghostPath="".padStart(64,"a")+".png"; // 64-hex + .png: biçim/mime-tutarlı, ama draft bucket'ta yok
  await db("update public.email_assets set object_path=$2 where id=$1",[aF, ghostPath]);
  const rf = await api("asset_preview",{asset_ids:[aF]},CRM);
  assertEquals(rf.status,200,"rf:"+JSON.stringify(rf.body));
  assertEquals(Object.keys(rf.body).sort().join(","),"ok,previews,ttl,unavailable_asset_ids","fault: yanıt anahtarları hâlâ sabit");
  // ham storage hata iç detayı (StorageApiError/Bucket/stack/statusCode) SIZMAMALI
  const blob=JSON.stringify(rf.body);
  for (const leak of ["StorageApiError","Bucket","statusCode","\"error\"","stack","InternalError"]) assert(!blob.includes(leak),"fault: '"+leak+"' iç detayı sızmamalı");
});

// ---------- AP10: RLS deny-all + service-role-only RPC korunur ----------
Deno.test("AP10: 4 email tablosu RLS enabled + anon/authenticated grant YOK; RPC EXECUTE yalnız service_role", async () => {
  const T=["email_templates","email_template_versions","email_assets","email_version_assets"];
  const rls=await db<{relname:string,rls:boolean}>(
    `select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname = any($1)`,[T]);
  assertEquals(rls.length,4,"4 tablo bulundu");
  for (const r of rls) assertEquals(r.rls,true,r.relname+" RLS enabled");
  const grants=await db<{n:number}>(
    `select count(*)::int as n from information_schema.role_table_grants
     where table_schema='public' and table_name = any($1) and grantee in ('anon','authenticated')`,[T]);
  assertEquals(Number(grants[0].n),0,"anon/authenticated tablo grant YOK (deny-all)");
  const g=await db<{svc:boolean,auth:boolean,anon:boolean}>(
    `select has_function_privilege('service_role',$1,'execute') as svc,
            has_function_privilege('authenticated',$1,'execute') as auth,
            has_function_privilege('anon',$1,'execute') as anon`,[FNSIG]);
  assertEquals(g[0].svc,true,"RPC service_role EXECUTE var");
  assertEquals(g[0].auth,false,"RPC authenticated EXECUTE YOK");
  assertEquals(g[0].anon,false,"RPC anon EXECUTE YOK");
});

// ---------- AP-EDGE: asset_preview boş id -> 422 no_ids (fail-closed giriş doğrulaması) ----------
Deno.test("AP-EDGE: asset_preview boş id listesi -> 422 no_ids", async () => {
  const r = await api("asset_preview",{asset_ids:[]},CRM);
  assertEquals(r.status,422,"no_ids -> 422:"+JSON.stringify(r.body));
  assertEquals(r.body?.error,"no_ids","hata no_ids");
});

// ---------- GATE CF: save/validate FAIL-CLOSED (html VE builder_json; signed/draft/token/data-asa-pub/unmanaged) + temiz geçer ----------
Deno.test("GATE-CF: save+validate builder_json+html fail-closed (signed/draft/token/data-asa-pub/unmanaged) + temiz kanonik geçer", async () => {
  const c = await api("create",{internal_name:"CF "+uuid().slice(0,8),email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const tid=c.body.template_id;
  const SIGNED=`${BASE}/storage/v1/object/sign/email-assets-draft/x.png?token=ABC123`;
  const clean="<p>ok {{unsubscribe_url}}</p>";      // sanitize-geçerli; kalıcı denetim builder_json üzerinden test edilir
  const REJ=["draft_asset_url_in_content","unmanaged_asset_url"];
  // NOT: SAVE'de assertCanonicalAssets sanitize'DAN SONRA koşar; bu yüzden SAVE reddi testlerinde yasaklı içerik
  // builder_json'a konur (sanitizer'a dokunmaz, html temiz kalır) -> rep.ok=true -> reddi assertCanonicalAssets üretir.
  // HTML-kaynağı reddi ise VALIDATE ile test edilir (validate'te assertCanonicalAssets sanitize'DAN ÖNCE koşar).
  const mkSave=(fields:Record<string,unknown>)=>api("save",{template_id:tid,email_class:"marketing",source_type:"visual_builder",subject:"CF",html:clean,asset_manifest:[],idem:uuid(),request_id:uuid(),...fields},CRM);
  const mkValidate=(html:string,extra:Record<string,unknown>={})=>api("validate",{email_class:"marketing",source_type:"visual_builder",html,builder_json:{r:1},asset_manifest:[],...extra},CRM);
  // 1) SAVE: signed URL builder_json'da -> reddet (builder_json DA denetlenir; client temizliğine güvenilmez)
  let r=await mkSave({builder_json:{blocks:[{src:SIGNED}]}});
  assert(r.status>=400,"signed builder_json reddi:"+JSON.stringify(r.body)); assert(REJ.includes(r.body?.error),"kod:"+r.body?.error);
  // 2) SAVE: data-asa-pub builder_json'da -> reddet (geçici editör alanı kalıcı içerikte yasak)
  r=await mkSave({builder_json:{blocks:[{attrs:"data-asa-pub=https://evil"}]}});
  assert(r.status>=400,"data-asa-pub reddi:"+JSON.stringify(r.body)); assertEquals(r.body?.error,"draft_asset_url_in_content");
  // 3) SAVE: token query builder_json'da (public görünse de) -> reddet
  r=await mkSave({builder_json:{blocks:[{src:`${PUBURL("y.png")}?token=Z`}]}});
  assert(r.status>=400,"token reddi:"+JSON.stringify(r.body)); assertEquals(r.body?.error,"draft_asset_url_in_content");
  // 4) SAVE: manifest DIŞI managed public storage URL builder_json'da -> unmanaged_asset_url (URL-parse+manifest; regex tek sınır değil)
  r=await mkSave({builder_json:{blocks:[{src:PUBURL("notinmanifest.png")}]}});
  assert(r.status>=400,"unmanaged reddi:"+JSON.stringify(r.body)); assertEquals(r.body?.error,"unmanaged_asset_url");
  // 5) VALIDATE: signed URL HTML KAYNAĞINDA -> reddet (validate DE fail-closed; sanitize'dan ÖNCE, html-source reddi)
  let v=await mkValidate(`<p><img src="${SIGNED}"></p>`);
  assert(v.status>=400,"validate signed html reddi:"+JSON.stringify(v.body)); assert(REJ.includes(v.body?.error),"validate kod:"+v.body?.error);
  // 6) VALIDATE: manifest DIŞI managed public URL HTML kaynağında -> unmanaged_asset_url
  v=await mkValidate(`<p><img src="${PUBURL("notinmanifest.png")}"></p>`);
  assert(v.status>=400,"validate unmanaged reddi:"+JSON.stringify(v.body)); assertEquals(v.body?.error,"unmanaged_asset_url");
  // 7) TEMİZ managed (manifest'li kanonik public; html + builder_json) -> save 200
  const up=await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM); const aid=up.body.asset_id, path=up.body.path;
  const okr=await mkSave({html:`<table><tr><td><img src="${PUBURL(path)}">{{unsubscribe_url}}</td></tr></table>`,builder_json:{blocks:[{src:PUBURL(path)}]},asset_manifest:[{asset_id:aid,public_path:path}]});
  assertEquals(okr.status,200,"temiz kanonik geçer:"+JSON.stringify(okr.body));
});

// ---------- GATE CF-PUB: publish fail-closed sonrası yayınlanan içerik signed/draft/token/temp-attr = 0 ----------
Deno.test("GATE-CF-PUB: yayınlanan sanitized_html/source_html/builder_json signed/draft/token/data-asa-* = 0", async () => {
  const t=await mkPublishedTemplate();
  const g=await api("get",{template_id:t.tid},SUPER);
  assertEquals(g.status,200,"get:"+JSON.stringify(g.body));
  const pub=g.body.published||{};
  const blob=JSON.stringify([pub.sanitized_html??"",pub.source_html??"",pub.builder_json??null]);
  assert(!/\/storage\/v1\/object\/sign\//.test(blob),"published: signed endpoint yok");
  assert(!/email-assets-draft/.test(blob),"published: draft bucket yok");
  assert(!/[?&]token=/.test(blob),"published: token yok");
  assert(!/data-asa-pub|data-asa-id/.test(blob),"published: geçici editör alanı yok");
});

// ==================== CDP-3B FIX doğrulama (Run #10 kök nedenleri A+B için zorunlu assertion'lar) ====================
// (2) E2E alias YALNIZ EMAIL_API_E2E=1 iken kabul edilir -> POZİTİF taraf (save+alias public URL geçer) yukarıdaki
//     mkPublishedTemplate/AP2/GATE-CF testlerinin artık geçmesiyle kanıtlanır (CI'da E2E=1).
// (3) E2E=false iken aynı alias URL -> unmanaged_asset_url: index.ts'te `if(!E2E) return null` ile YAPISAL garanti;
//     ampirik olarak Run #10'un kendisi (alias env'siz) tam da bu davranışı (127.0.0.1 URL -> unmanaged) gösterdi.

// FIX-6: iki freshTestImage() -> FARKLI asset_id + FARKLI content_hash (dedupe tetiklenmez); magic+1x1 server'da geçti.
Deno.test("FIX-6: iki freshTestImage benzersiz asset_id + content_hash üretir", async () => {
  const a=await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  const b=await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  assertEquals(a.status,200,"a upload:"+JSON.stringify(a.body)); assertEquals(b.status,200,"b upload:"+JSON.stringify(b.body));
  assertNotEquals(a.body.asset_id,b.body.asset_id,"farklı asset_id");
  const rows=await db<{content_hash:string}>("select content_hash from public.email_assets where id = any($1)",[[a.body.asset_id,b.body.asset_id]]);
  assertEquals(rows.length,2,"iki asset da kayıtlı");
  assertNotEquals(rows[0].content_hash,rows[1].content_hash,"farklı content_hash (dedupe YOK)");
  assertEquals(a.body.width,1,"magic+boyut: width=1"); assertEquals(a.body.height,1,"height=1");
});

// FIX-7: BİLİNÇLİ aynı içerik (PNG_1x1) iki kez -> dedupe KORUNUR (aynı asset_id/path).
Deno.test("FIX-7: aynı içerik tekrar upload -> dedupe korunur (aynı asset_id)", async () => {
  const a=await api("asset_upload",{data_base64:PNG_1x1,idem:uuid(),request_id:uuid()},CRM);
  const b=await api("asset_upload",{data_base64:PNG_1x1,idem:uuid(),request_id:uuid()},CRM);
  assertEquals(a.status,200,"a:"+JSON.stringify(a.body)); assertEquals(b.status,200,"b:"+JSON.stringify(b.body));
  assertEquals(a.body.asset_id,b.body.asset_id,"aynı içerik -> aynı asset_id (dedupe)");
  assertEquals(a.body.path,b.body.path,"aynı path (content-hash)");
});

// FIX-1: internal SUPABASE_URL DEĞİŞMEDİ -> asset_preview signed URL'i draft-bucket 'sign' endpoint'idir (internal storage istemcisi çalışır).
Deno.test("FIX-1: signed preview internal storage istemcisiyle üretiliyor (SUPABASE_URL değişmedi)", async () => {
  const up=await api("asset_upload",{data_base64:freshTestImage(),idem:uuid(),request_id:uuid()},CRM);
  const p=await api("asset_preview",{asset_ids:[up.body.asset_id]},CRM);
  assertEquals(p.status,200,"preview:"+JSON.stringify(p.body));
  assertEquals((p.body.previews||[]).length,1,"taze upload -> 1 preview");
  const u=p.body.previews[0].url;
  assert(/\/storage\/v1\/object\/sign\/email-assets-draft\//.test(u),"signed draft-bucket endpoint (internal storage istemcisi çalışıyor)");
  assert(/[?&]token=/.test(u),"kısa-ömürlü token");
});

// FIX-4: E2E alias host DOĞRU olsa da manifest DIŞI object_path (yanlış path) yine reddedilir.
Deno.test("FIX-4: alias host doğru + manifest dışı path -> unmanaged_asset_url", async () => {
  const c=await api("create",{internal_name:"FIX4 "+uuid().slice(0,8),email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const { aid, path }=await bindAssetToCurrentDraft(c.body.template_id, CRM);
  const bogus=PUBURL("".padStart(64,"b")+".png");   // biçim-geçerli, ama hiçbir manifest asset'ine ait DEĞİL
  const html=`<table><tr><td><img src="${PUBURL(path)}"><img src="${bogus}"><a href="{{unsubscribe_url}}">x</a></td></tr></table>`;
  const s=await api("save",{template_id:c.body.template_id,email_class:"marketing",source_type:"visual_builder",subject:"FIX4",html,builder_json:{root:1},asset_manifest:[{asset_id:aid,public_path:path}],idem:uuid(),request_id:uuid()},CRM);
  assert(s.status>=400,"manifest dışı path reddedilmeli:"+JSON.stringify(s.body));
  assertEquals(s.body?.error,"unmanaged_asset_url","alias host doğru olsa da yanlış path -> unmanaged_asset_url");
});

// FIX-5: alias origin + token -> FORBIDDEN aynen çalışır (draft_asset_url_in_content); origin'den bağımsız.
Deno.test("FIX-5: alias origin + token -> draft_asset_url_in_content (FORBIDDEN)", async () => {
  const c=await api("create",{internal_name:"FIX5 "+uuid().slice(0,8),email_class:"marketing",source_type:"visual_builder",idem:uuid(),request_id:uuid()},CRM);
  const { aid, path }=await bindAssetToCurrentDraft(c.body.template_id, CRM);
  const tokened=`${PUBURL(path)}?token=ABC123`;     // doğru managed public URL fakat token'lı -> FORBIDDEN
  const html=`<table><tr><td><img src="${tokened}"><a href="{{unsubscribe_url}}">x</a></td></tr></table>`;
  const s=await api("save",{template_id:c.body.template_id,email_class:"marketing",source_type:"visual_builder",subject:"FIX5",html,builder_json:{root:1},asset_manifest:[{asset_id:aid,public_path:path}],idem:uuid(),request_id:uuid()},CRM);
  assert(s.status>=400,"token'lı URL reddedilmeli:"+JSON.stringify(s.body));
  assertEquals(s.body?.error,"draft_asset_url_in_content","alias üzerinden bile token/sign/draft FORBIDDEN");
});
