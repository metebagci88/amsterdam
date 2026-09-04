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
  const up = await api("asset_upload",{data_base64:PNG_1x1,idem:uuid(),request_id:uuid()},CRM);
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
