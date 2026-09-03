// ASALOCAL · CDP-3B · Gate 8b — admin.html'in GERÇEK emOpen/_emAssets/emSave fonksiyonlarını jsdom'da koşar.
// GrapesJS YÜKLENMEZ (html_import yolu). Bağımlılıklar (CAPS,$,esc,apiErrText,shell,authClient,CFG,emailApi fetch) stub'lanır;
// e-posta <script> bloğunun TAMAMI gerçek admin.html'den çıkarılıp eval edilir (kod birebir üründen).
// Çıktı: hata -> non-zero exit; başarı -> "ADMIN_REOPEN_OK".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, "..", "admin.html"), "utf8");

// e-posta script bloğunu çıkar (emailApi tanımından, onu içeren <script>'in kapanışına kadar)
const start = html.indexOf("async function emailApi(action, fields){");
assert.ok(start > 0, "emailApi bloğu bulunamadı");
const end = html.indexOf("</script>", start);
assert.ok(end > start, "script kapanışı bulunamadı");
const emailBlock = html.slice(start, end);

// --- Sahte sunucu: template id -> get/save/validate/new_version yanıtları ---
const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATH = "deadbeef.png";
const PUBLISHED_ID = "11111111-1111-4111-8111-111111111111"; // published + draft yok
const DRAFT_ID     = "22222222-2222-4222-8222-222222222222"; // html_import draft + manifest
let lastSave = null;
function serverRespond(action, f){
  if(action==="get" && f.template_id===PUBLISHED_ID)
    return { status:200, body:{ template:{internal_name:"Yayınlı", status:"published", source_type:"html_import", email_class:"marketing"}, draft:null, published:{version_number:3, sanitized_html:"<p>merhaba {{unsubscribe_url}}</p>", asset_manifest:[{asset_id:ASSET_ID, public_path:PATH}]} } };
  if(action==="get" && f.template_id===DRAFT_ID)
    return { status:200, body:{ template:{internal_name:"Taslak", status:"draft", source_type:"html_import", email_class:"marketing", description:"d"}, draft:{version_number:1, subject:"K", preview_text:"p", sender_name:"s", reply_to:null, source_html:"<p>x {{unsubscribe_url}}</p>", sanitized_html:"<p>x {{unsubscribe_url}}</p>", asset_manifest:[{asset_id:ASSET_ID, public_path:PATH}]} } };
  if(action==="validate")
    return { status:200, body:{ ok:true, content_hash:"0".repeat(64), preview_html:"<p>ok</p>", validation_report:{errors:[],warnings:[],plain_text:"ok"} } };
  if(action==="save"){ lastSave = f; return { status:200, body:{ ok:true, version_id:"33333333-3333-4333-8333-333333333333", version_number:1 } }; }
  if(action==="new_version") return { status:200, body:{ ok:true, version_id:"33333333-3333-4333-8333-333333333333", version_number:2 } };
  return { status:400, body:{ error:"unhandled_"+action } };
}

const dom = new JSDOM(`<!doctype html><body>
  <div id="app"></div><div id="emEditor"></div><div id="emList"></div>
</body>`, { runScripts:"outside-only", pretendToBeVisual:true });
const { window } = dom; const { document } = window;
const alerts = [];
// --- stub bağımlılıklar (admin.html'in 1. script bloğundaki yardımcıların testteki karşılığı) ---
window.alert = (m)=>alerts.push(String(m));
window.CFG = { url:"https://local.test", key:"anon" };
window.FN_EMAIL_URL = "https://local.test/functions/v1/email-api";
window.CAPS = { crm:true, superadmin:true };
window.authClient = { auth:{ getSession: async ()=>({ data:{ session:{ access_token:"jwt" } } }) } };
window.$ = (id)=>document.getElementById(id);
window.esc = (s)=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
window.apiErrText = (st)=>"hata:"+st;
window.shell = (h)=>{ document.getElementById("app").innerHTML = h; };
// emailApi gerçek koddaki fetch'i kullanır -> fetch'i stub'la (offline sahte sunucu)
window.fetch = async (_url, opts)=>{ const b=JSON.parse(opts.body); const r=serverRespond(b.action, b); return { status:r.status, json: async ()=>r.body }; };

// e-posta bloğunu (GERÇEK üretim kodu) window bağlamında eval et
window.eval(emailBlock + "\n;window.emOpen=emOpen;window.emSave=emSave;window.emNewImport=emNewImport;");

const run = async () => {
  // 1) YAYINLANMIŞ + draft yok -> "Yeni sürüm oluştur" gösterilir (auto düzenleme YOK)
  await window.emOpen(PUBLISHED_ID);
  const ed = document.getElementById("emEditor").innerHTML;
  assert.ok(/Yeni sürüm oluştur/.test(ed), "published: 'Yeni sürüm oluştur' butonu görünmeli");
  assert.ok(/immutable/.test(ed), "published: immutable rozeti");

  // 2) html_import DRAFT (manifest'li) -> reopen -> _emAssets manifest'ten yeniden kurulur
  await window.emOpen(DRAFT_ID);
  assert.equal(document.getElementById("em_name").value, "Taslak", "draft alanları dolduruldu");
  assert.equal(document.getElementById("em_src").value.length>0, true, "source_html yüklendi");
  // emSave -> save payload.asset_manifest, reopen'da manifest'ten gelen asset'i içermeli
  const ok = await window.emSave();
  assert.equal(ok, true, "emSave true döner");
  assert.ok(lastSave, "save çağrıldı");
  assert.equal(lastSave.asset_manifest.length, 1, "manifest tek asset");
  assert.equal(lastSave.asset_manifest[0].asset_id, ASSET_ID, "_emAssets manifest'ten kuruldu");
  assert.equal(lastSave.asset_manifest[0].public_path, PATH, "public_path korundu");

  console.log("ADMIN_REOPEN_OK");
};
run().catch(e=>{ console.error("ADMIN_REOPEN_FAIL", e && e.stack || e); process.exit(1); });
