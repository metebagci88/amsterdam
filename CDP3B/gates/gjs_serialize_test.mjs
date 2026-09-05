// ASALOCAL · CDP-3B patch · Gate 8c — admin.html'in GERÇEK emSerializeCanonical/emSwapToPreview/_emManagedImgs
// fonksiyonlarını, VENDORLANMIŞ GERÇEK GrapesJS (grapes.min.js) component modeli üzerinde jsdom'da koşar.
// Amaç (zorunlu test matrisi, client tarafı):
//   - Görsel yükleme sonrası managed img editörde signed src ile GÖRÜNÜR.
//   - Kaydet serileştirmesi (emSerializeCanonical): source_html VE builder_json'da signed/draft/token/data-asa-id = 0;
//     kalıcı referans yalnız kanonik public URL (email-assets-public/<path>).
//   - STATE KAYBI YOK: serileştirme sonrası canlı editör signed görünüme + data-asa-id'ye geri döner (aynı component kimliği).
//   - Reopen (loadProjectData round-trip) project/component/style KORUR; managed img korunur.
//   - Değişiklik yok -> tekrar serileştir -> AYNI html + AYNI builder_json (deterministik hash).
//   - TTL/refresh: emSwapToPreview managed img src'yi component MODELİNDE signed'a çevirir (yeniden kurma YOK; aynı cid).
//   - İçe aktarılan data-asa-pub KEYFİ URL'ye dönüşemez: manifest'te olmayan (foreign) img kanonik public URL'ye
//     ÇEVRİLMEZ; src olduğu gibi kalır (server fail-closed reddeder) — client kanonik URL UYDURAMAZ.
// GrapesJS 'grapesjs-preset-newsletter' eklentisi jsdom'da ağır/asılı kaldığından NO-OP stub ile kaydedilir;
// core component modeli (getWrapper/components/getAttributes/addAttributes/removeAttributes/get('src')/set('src')/
// getProjectData/loadProjectData/getHtml) GERÇEKTİR. Çıktı: hata -> non-zero exit; başarı -> "GJS_SERIALIZE_OK".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, "..", "admin.html"), "utf8");
const gjsSrc = readFileSync(join(HERE, "..", "vendor", "grapesjs", "grapes.min.js"), "utf8");

// e-posta script bloğunu çıkar (admin_reopen_test.mjs ile aynı sınırlar; kod BİREBİR üründen)
const start = html.indexOf("async function emailApi(action, fields){");
assert.ok(start > 0, "emailApi bloğu bulunamadı");
const end = html.indexOf("</script>", start);
assert.ok(end > start, "script kapanışı bulunamadı");
const emailBlock = html.slice(start, end);

const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATH = "deadbeef0123.png";
const CFG_URL = "https://proj.supabase.co";
const PUBLIC_URL = CFG_URL + "/storage/v1/object/public/email-assets-public/" + PATH;
const SIGNED_URL = CFG_URL + "/storage/v1/object/sign/email-assets-draft/" + PATH + "?token=EYJ_FAKE_SIGNED_TOKEN";
const SIGNED_URL2 = CFG_URL + "/storage/v1/object/sign/email-assets-draft/" + PATH + "?token=EYJ_FAKE_REFRESH_TOKEN";
const FOREIGN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVIL_URL = "https://evil.example.com/track.png";

// Fake email-api sunucusu (offline). asset_preview -> signed URL üretir.
let previewCount = 0;
function serverRespond(action, f){
  if(action==="asset_preview"){
    previewCount++;
    const ids = f.asset_ids || [];
    const previews = [], unavailable = [];
    for(const id of ids){
      if(id===ASSET_ID){ previews.push({ asset_id:id, url: previewCount>=2 ? SIGNED_URL2 : SIGNED_URL }); }
      else { unavailable.push(id); }   // manifest'te olmayan/foreign -> unavailable (sessizce düşmez)
    }
    return { status:200, body:{ ok:true, previews, unavailable_asset_ids:unavailable, ttl:600 } };
  }
  if(action==="validate") return { status:200, body:{ ok:true, content_hash:"0".repeat(64), preview_html:"<p>ok</p>", validation_report:{errors:[],warnings:[],plain_text:"ok", sanitized_html:"<p>ok</p>"} } };
  return { status:400, body:{ error:"unhandled_"+action } };
}

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="app"></div><div id="emEditor"></div><div id="emList"></div>
  <div id="gjs"></div><div id="emReport"></div>
</body></html>`, { runScripts:"outside-only", pretendToBeVisual:true, url: CFG_URL + "/" });
const { window } = dom; const { document } = window;

// GrapesJS için jsdom polyfill'leri
window.requestAnimationFrame = (cb)=>setTimeout(cb,0);
window.cancelAnimationFrame = (id)=>clearTimeout(id);
window.Element.prototype.getBoundingClientRect = function(){ return {width:0,height:0,top:0,left:0,right:0,bottom:0,x:0,y:0}; };
window.document.elementFromPoint = ()=>null;
window.matchMedia = ()=>({matches:false,media:"",addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false;}});

// GERÇEK GrapesJS core'u yükle + newsletter preset'i NO-OP stub olarak kaydet (jsdom'da gerçek preset asılıyor)
window.eval(gjsSrc);
assert.equal(typeof window.grapesjs, "object", "grapesjs yüklendi");
window.grapesjs.plugins.add("grapesjs-preset-newsletter", function(){ /* no-op: core component modeli test edilir */ });

const alerts = [];
window.alert = (m)=>alerts.push(String(m));
window.CFG = { url: CFG_URL, key:"anon" };
window.FN_EMAIL_URL = CFG_URL + "/functions/v1/email-api";
window.CAPS = { crm:true, superadmin:true };
window.authClient = { auth:{ getSession: async ()=>({ data:{ session:{ access_token:"jwt" } } }) } };
window.$ = (id)=>document.getElementById(id);
window.esc = (s)=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
window.apiErrText = (st)=>"hata:"+st;
window.shell = (h)=>{ document.getElementById("app").innerHTML = h; };
window.newId = ()=>"id-"+Math.random().toString(16).slice(2);
window.loadGrapes = async ()=>{};   // vendor SRI yükleyicisi yerine no-op (grapesjs zaten yüklendi)
window.fetch = async (_url, opts)=>{ const b=JSON.parse(opts.body); const r=serverRespond(b.action, b); return { status:r.status, json: async ()=>r.body }; };

// e-posta bloğunu (GERÇEK üretim kodu) window bağlamında eval et + iç fonksiyon/değişkenleri dışa aç.
// NOT: emNewVisual ÇAĞRILMAZ — o Node-realm `loadGrapes`'i await eder ve JSDOM/Node realm sınırında promise
// gözlemlenemez. Bunun yerine GERÇEK GrapesJS editörü Node'da init edilip _emEditor'a ENJEKTE edilir; test edilen
// emSerializeCanonical/emSwapToPreview/_emManagedImgs GERÇEK component modeli üzerinde koşar (üretim kodu birebir).
window.eval(emailBlock + "\n;" + [
  "window.emSerializeCanonical=emSerializeCanonical",
  "window.emSwapToPreview=emSwapToPreview",
  "window._emManagedImgs=_emManagedImgs",
  "window._emPubUrl=_emPubUrl",
  "window.__getEditor=function(){return _emEditor;}",
  "window.__setEditor=function(e){_emEditor=e;}",
  "window.__setMode=function(m){_emMode=m;}",
  "window.__setAssets=function(a){_emAssets=a;}",
  "window.__getAssets=function(){return _emAssets;}",
  "window.__setCurId=function(v){_emCurId=v;}",
].join(";") + ";");

const NO_SIGNED = (s, where)=>{
  assert.ok(!/\/storage\/v1\/object\/sign\//.test(s), where+": signed endpoint (sign/) İÇERMEMELİ");
  assert.ok(!/email-assets-draft/.test(s), where+": draft bucket adı İÇERMEMELİ");
  assert.ok(!/[?&]token=/.test(s), where+": token query İÇERMEMELİ");
  assert.ok(!/data-asa-id/.test(s), where+": geçici data-asa-id İÇERMEMELİ");
  assert.ok(!/data-asa-pub/.test(s), where+": data-asa-pub İÇERMEMELİ");
};
const imgSrc = (c)=>{ const at=c.getAttributes()||{}; return at.src!=null?at.src:(c.get&&c.get('src'))||null; };

const run = async () => {
  // GERÇEK GrapesJS editörünü Node'da init et + _emEditor'a enjekte et (visual mode). Üretimde emNewVisual bunu yapar;
  // burada realm-sınırı promise sorununu (loadGrapes) atlamak için doğrudan enjekte edilir. Component modeli GERÇEK.
  const ed = window.grapesjs.init({ container:'#gjs', height:'380px', storageManager:false, plugins:['grapesjs-preset-newsletter'] });
  window.__setEditor(ed); window.__setMode('visual');
  assert.ok(ed && ed.getWrapper, "GrapesJS editörü init edildi (_emEditor)");
  window.__setAssets([{ id:ASSET_ID, path:PATH }]);   // server-approved asset (manifest)

  // Zengin, stilli bir şablon + managed img (signed src + geçici data-asa-id) — yükleme sonrası editör durumunu taklit eder
  ed.setComponents('<div class="wrap"><h1 class="ttl">Başlık {{first_name}}</h1>'
    + '<img data-asa-id="'+ASSET_ID+'" src="'+SIGNED_URL+'" alt="görsel"/>'
    + '<p class="bd">İçerik metni</p></div>');
  ed.setStyle('.wrap{padding:12px;background:#fafafa}.ttl{color:#c8102e;font-size:22px}.bd{color:#444}');

  // (T1) yükleme sonrası managed img editörde signed src ile GÖRÜNÜR
  let imgs = window._emManagedImgs();
  assert.equal(imgs.length, 1, "T1: tam 1 managed img");
  assert.equal(imgSrc(imgs[0]), SIGNED_URL, "T1: img signed preview src ile görünür");
  const cidBefore = imgs[0].getId ? imgs[0].getId() : imgs[0].cid;

  // (T2) emSerializeCanonical -> source_html + builder_json KANONİK (signed/draft/token/data-asa-id = 0)
  const ser = window.emSerializeCanonical();
  assert.ok(ser && typeof ser.html==="string", "T2: serialize html döndü");
  NO_SIGNED(ser.html, "T2 source_html");
  assert.ok(ser.html.includes("/object/public/email-assets-public/"+PATH), "T2: source_html kanonik public URL içerir");
  const bjStr = JSON.stringify(ser.builder_json);
  NO_SIGNED(bjStr, "T2 builder_json");
  assert.ok(bjStr.includes(PATH), "T2: builder_json kanonik public path içerir");

  // (T3) STATE KAYBI YOK: serialize SONRASI canlı editör signed görünüme + data-asa-id'ye geri döner, AYNI component kimliği
  imgs = window._emManagedImgs();
  assert.equal(imgs.length, 1, "T3: img hâlâ tek (yeniden kurulmadı)");
  assert.equal(imgSrc(imgs[0]), SIGNED_URL, "T3: canlı editör src signed'a geri döndü");
  assert.equal((imgs[0].getAttributes()||{})["data-asa-id"], ASSET_ID, "T3: data-asa-id geri kondu");
  const cidAfter = imgs[0].getId ? imgs[0].getId() : imgs[0].cid;
  assert.equal(cidAfter, cidBefore, "T3: aynı component kimliği (getHtml->setComponents ile yeniden kurma YOK)");
  // stil korunur
  assert.ok((/rgb\(200,\s*16,\s*46\)/.test(ed.getCss())||/c8102e/i.test(ed.getCss())), "T3: stil (renk) canlı editörde korunur");

  // (T4) DETERMİNİZM: değişiklik yok -> tekrar serialize -> AYNI html + AYNI builder_json
  const ser2 = window.emSerializeCanonical();
  assert.equal(ser2.html, ser.html, "T4: source_html deterministik (aynı)");
  assert.equal(JSON.stringify(ser2.builder_json), bjStr, "T4: builder_json deterministik (aynı)");

  // (T5) REOPEN: kaydedilen KANONİK builder_json'ı loadProjectData ile geri yükle -> project/component/style KORUNUR
  ed.loadProjectData(ser.builder_json);
  const reimgs = window._emManagedImgs();
  assert.equal(reimgs.length, 1, "T5: reopen sonrası managed img korunur");
  assert.equal(imgSrc(reimgs[0]), PUBLIC_URL, "T5: reopen'da img kanonik public URL (kaydedilen hâl)");
  assert.ok((/rgb\(200,\s*16,\s*46\)/.test(ed.getCss())||/c8102e/i.test(ed.getCss())), "T5: reopen stil korunur");
  assert.ok(/Başlık/.test(ed.getHtml()) && /İçerik metni/.test(ed.getHtml()), "T5: component içerikleri korunur");

  // (T6) TTL/refresh: emSwapToPreview managed img src'yi component MODELİNDE signed'a çevirir (yeniden kurma YOK; aynı cid)
  const cidPre = reimgs[0].getId ? reimgs[0].getId() : reimgs[0].cid;
  await window.emSwapToPreview();
  let simgs = window._emManagedImgs();
  assert.equal(simgs.length, 1, "T6: swap sonrası tek img");
  assert.equal(imgSrc(simgs[0]), SIGNED_URL, "T6: img src signed preview)e çevrildi (görsel görünür)");
  const cidPost = simgs[0].getId ? simgs[0].getId() : simgs[0].cid;
  assert.equal(cidPost, cidPre, "T6: swap aynı component kimliği (rebuild YOK -> props/style korunur)");
  // refresh (2. çağrı) -> yeni signed token (re-upload YOK)
  await window.emSwapToPreview();
  simgs = window._emManagedImgs();
  assert.equal(imgSrc(simgs[0]), SIGNED_URL2, "T6: ikinci swap TTL refresh (yeni token, re-upload olmadan)");
  // swap sonrası serialize yine KANONİK (signed sızmaz)
  const ser3 = window.emSerializeCanonical();
  NO_SIGNED(ser3.html, "T6 swap-sonrası source_html");
  NO_SIGNED(JSON.stringify(ser3.builder_json), "T6 swap-sonrası builder_json");

  // (T7) İçe aktarılan data-asa-pub KEYFİ URL'ye dönüşemez: manifest'te OLMAYAN foreign img kanonik public'e ÇEVRİLMEZ.
  ed.setComponents('<div><img data-asa-id="'+FOREIGN_ID+'" data-asa-pub="'+EVIL_URL+'" src="'+EVIL_URL+'" alt="f"/></div>');
  // NOT: _emAssets yalnız ASSET_ID içerir; FOREIGN_ID server-approved DEĞİL.
  const serF = window.emSerializeCanonical();
  assert.ok(!serF.html.includes("/email-assets-public/"), "T7: foreign img kanonik public URL'ye UYDURULMADI");
  assert.ok(serF.html.includes(EVIL_URL), "T7: foreign src olduğu gibi kaldı (server fail-closed reddedecek)");

  console.log("previewCount(asset_preview çağrısı) =", previewCount);
  console.log("GJS_SERIALIZE_OK");
  process.exit(0);
};
run().catch(e=>{ console.error("GJS_SERIALIZE_FAIL", e && e.stack || e); process.exit(1); });
