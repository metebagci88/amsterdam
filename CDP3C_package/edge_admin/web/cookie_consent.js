/* =====================================================================
   CDP-3C · Çerez tercih altyapısı — v2 (FAIL-CLOSED, PRODUCTION'A WIRE EDİLMEDİ)
   ---------------------------------------------------------------------
   Bu modül BİLEREK pasif (inert) varsayılanda gelir. Aktif hukuk metni ve
   çalışan anon sunucu ucu HENÜZ YOK; bu yüzden bu tur production'a BAĞLANMAZ.
   Tasarım ilkeleri (bağımsız inceleme kapanışları):
   1) Consent-mode İLK DURUM = denied (analytics_storage/ad_storage/ad_user_data/
      ad_personalization=denied). Analitik/reklam script'i YALNIZ sunucu onay
      yazımı BAŞARILI olunca yüklenir.
   2) localStorage AUTHORITATIVE DEĞİLDİR: script yüklemeyi ASLA localStorage
      tetiklemez. localStorage yalnız "banner yanıtlandı mı" ipucu + sunucu-teyitli
      karar önbelleğidir (text_version + subject + expiry ile). Önbellek granted
      olsa bile script yükleme yalnız sunucu DOĞRULAMA/yazma başarısından sonra olur.
   3) Aktif hukuk metni (server active_text_version) YOKSA veya endpoint YOKSA:
      grant TOPLANMAZ (accept-all gösterilmez), hiçbir gated script yüklenmez.
   4) "Kabul et" ancak: (a) çalışan endpoint, (b) sunucudan gelen aktif text_version,
      (c) geçerli anon subject/token yaşam döngüsü varken gösterilir; ve YALNIZ
      sunucu 2xx yazımından SONRA consent-mode güncellenir + script yüklenir.
      Sunucu reddederse -> consent-mode denied KALIR, script yüklenmez.
   5) Çerez Politikası linki YALNIZ geçerli bir policyUrl yapılandırıldıysa basılır
      (kırık link deploy edilmez).
   6) Ham çerez değeri/PII loglanmaz. Ham hata client'a sızdırılmaz.
   ---------------------------------------------------------------------
   AKTİVASYON (gelecekte, ayrı ve denetimli): sayfaya şu konfig enjekte edilir:
     window.ASA_COOKIE_CONFIG = {
       endpoint: "https://.../functions/v1/<anon-cookie-fn>",  // çalışan anon uç
       policyUrl: "/cerez-politikasi",                          // geçerli, yayınlanmış
       ttlDays: 180,                                            // karar ömrü
       analyticsSrc: "https://.../analytics.js",                // gerçek loader (ops.)
       adsSrc: "https://.../ads.js"                             // gerçek loader (ops.)
     };
   Bu alanların HERHANGİ biri eksikse modül pasif kalır (fail-closed).

   AKTİVASYON BLOCKER'LARI (bu tur TAMAMLANMADI — modül CANLIYA ALINABİLİR DEĞİL):
     [ ] Sunucu uçları: cookie_active_text (aktif metin sürümü), anon_subject_create (anon subject+TTL),
         cookie_consent (grant/withdraw YAZMA), cookie_consent_status (SALT-OKUNUR durum; YENİ olay üretmez).
     [ ] Yayınlanmış aktif çerez hukuk metni (text_version) + geçerli policyUrl.
     [ ] Gerçek analyticsSrc/adsSrc loader URL'leri (yoksa yükleme yapılmaz).
   Bu blocker'lar kapanana dek modül hiçbir HTML'e WIRE EDİLMEZ ve "hazır/canlıya alınabilir" RAPORLANMAZ.
   Not: önbellekteki granted karar HER sayfa yüklemesinde YENİ consent olayı ÜRETMEZ; yalnız cookie_consent_status
   ile SALT-OKUNUR teyit edilir (yeni idem/yeni yazma yok).
   ===================================================================== */
(function(){
  "use strict";
  var LS_KEY = "asa_cookie_decision_v2"; // yalnız sunucu-teyitli karar önbelleği (JWT/authoritative DEĞİL)

  // ---- 1) Consent-mode default: HER ŞEY denied (fail-safe) ----
  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  try {
    gtag('consent', 'default', {
      ad_storage:'denied', analytics_storage:'denied',
      ad_user_data:'denied', ad_personalization:'denied',
      wait_for_update: 500
    });
  } catch(e){}

  // ---- Konfig (enjekte edilmezse tümü yok -> pasif) ----
  var CFG = (window.ASA_COOKIE_CONFIG && typeof window.ASA_COOKIE_CONFIG==="object") ? window.ASA_COOKIE_CONFIG : {};
  var ENDPOINT   = (typeof CFG.endpoint==="string" && /^https:\/\//.test(CFG.endpoint)) ? CFG.endpoint : null;
  var POLICY_URL = (typeof CFG.policyUrl==="string" && CFG.policyUrl.length>1) ? CFG.policyUrl : null;
  var TTL_DAYS   = (typeof CFG.ttlDays==="number" && CFG.ttlDays>0 && CFG.ttlDays<=400) ? CFG.ttlDays : 180;

  // ---- Önbellek yardımcıları (yalnız okuma-ipucu; script yüklemez) ----
  function readCache(){ try{ return JSON.parse(localStorage.getItem(LS_KEY)||"null"); }catch(e){ return null; } }
  function writeCache(o){ try{ localStorage.setItem(LS_KEY, JSON.stringify(o)); }catch(e){} }
  function cacheValid(c, activeTextVersion){
    if(!c || typeof c!=="object") return false;
    if(c.text_version !== activeTextVersion) return false;         // metin sürümü değiştiyse önbellek geçersiz
    if(!c.subject) return false;
    if(typeof c.exp!=="number" || Date.now() > c.exp) return false; // TTL dolmuş
    return (c.decision==="granted" || c.decision==="denied");
  }

  // ---- Gerçek gated script yükleyiciler (YALNIZ sunucu onayından sonra çağrılır) ----
  // Boş/sahte stub DEĞİL: konfigürasyondaki GERÇEK URL'lerden <script> enjekte eder.
  // URL yoksa hiçbir şey yüklenmez (yine de "çalışıyormuş gibi" yapılmaz).
  function injectScript(src){
    if(typeof src!=="string" || !/^https:\/\//.test(src)) return;
    var s=document.createElement("script"); s.async=true; s.src=src; document.head.appendChild(s);
  }
  function loadGatedScripts(grants){
    if(grants.analytics_storage==='granted') injectScript(CFG.analyticsSrc);
    if(grants.ad_storage==='granted')        injectScript(CFG.adsSrc);
  }
  function applyConsentModeUpdate(grants){
    try { gtag('consent','update',{
      analytics_storage: grants.analytics_storage,
      ad_storage: grants.ad_storage,
      ad_user_data: grants.ad_storage,
      ad_personalization: grants.ad_storage
    }); } catch(e){}
  }

  // ---- Sunucu yaşam döngüsü (anon subject + aktif metin + consent yazımı/doğrulaması) ----
  // NOT: Bu uç HENÜZ deploy edilmedi. ENDPOINT null iken bu fonksiyonlar ÇAĞRILMAZ (aşağıda gate).
  function postJson(action, extra){
    var body = Object.assign({ action: action }, extra||{});
    return fetch(ENDPOINT, { method:"POST", headers:{ "Content-Type":"application/json" }, credentials:"omit",
      body: JSON.stringify(body) }).then(function(r){
        return r.json().catch(function(){ return { ok:false, error:"bad_response" }; }).then(function(j){
          return { status:r.status, ok: r.ok && j && j.ok!==false, body:j };
        });
      }).catch(function(){ return { status:0, ok:false, body:{ error:"network" } }; }); // ham hata yutulur
  }
  // Aktif çerez metni sürümünü sunucudan al; yoksa null (grant TOPLANMAZ).
  function fetchActiveText(){ return postJson("cookie_active_text", {}).then(function(r){
    return (r.ok && r.body && typeof r.body.text_version==="string") ? r.body.text_version : null; }); }
  // Anon subject yaşam döngüsü: mevcut geçerli subject yoksa oluştur.
  function ensureAnonSubject(){
    var c = readCache();
    if(c && c.subject && typeof c.exp==="number" && Date.now() < c.exp) return Promise.resolve(c.subject);
    return postJson("anon_subject_create", {}).then(function(r){
      return (r.ok && r.body && typeof r.body.subject==="string") ? r.body.subject : null; });
  }
  // Consent YAZIMI (yeni OLAY): yalnız kullanıcı banner'da açık aksiyon aldığında (accept/reject) çağrılır.
  // Sunucu anon_consent_set (analytics_storage/advertising_storage). YALNIZ 2xx başarıda döner true.
  function serverWriteConsent(subject, textVersion, grants){
    var idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now())+Math.random());
    return postJson("cookie_consent", {
      subject: subject, text_version: textVersion,
      analytics: grants.analytics_storage==='granted',
      advertising: grants.ad_storage==='granted',
      request_id: "ck-"+Date.now(), idem: idem
    }).then(function(r){ return r.ok===true; });
  }
  // SALT-OKUNUR durum doğrulaması: YENİ consent OLAYI ÜRETMEZ (idem YOK, yazma YOK). Sayfa her yüklendiğinde
  // önbellekteki granted kararını sunucuyla teyit etmek için kullanılır; mevcut aktif grant'i sorar.
  function serverVerifyConsent(subject, textVersion){
    return postJson("cookie_consent_status", { subject: subject, text_version: textVersion })
      .then(function(r){ return r.ok===true && r.body && r.body.analytics===true && r.body.advertising===true; });
  }

  var ALL_DENIED  = { analytics_storage:'denied',  ad_storage:'denied'  };
  var ALL_GRANTED = { analytics_storage:'granted', ad_storage:'granted' };

  // ---- Banner (YALNIZ endpoint + aktif metin varken ve grant toplanabilirken) ----
  function renderBanner(activeTextVersion){
    if(document.getElementById("asa-cookie-banner")) return;
    var el = document.createElement("div");
    el.id = "asa-cookie-banner";
    el.setAttribute("role","dialog"); el.setAttribute("aria-label","Çerez tercihleri");
    el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#2f2a22;color:#f4efe6;padding:16px;font-family:Inter,system-ui,Arial,sans-serif";
    var policyLink = POLICY_URL ? (' <a href="'+POLICY_URL+'" style="color:#e3c98f">Çerez Politikası</a>') : ''; // kırık link basılmaz
    el.innerHTML =
      '<div style="max-width:900px;margin:0 auto;display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between">'+
      '<div style="flex:1;min-width:240px;font-size:13.5px">Zorunlu çerezler sitenin çalışması için gereklidir. '+
      'Analitik ve reklam çerezleri yalnız açık onayınızla ve onayınız sunucuya kaydedildikten sonra yüklenir.'+policyLink+'</div>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
      '<button id="asa-ck-reject" style="flex:1;min-width:150px;background:#fff;color:#23211c;border:0;border-radius:9px;padding:10px 14px;cursor:pointer">Opsiyonelleri reddet</button>'+
      '<button id="asa-ck-accept" style="flex:1;min-width:150px;background:#9a6a4e;color:#fff;border:0;border-radius:9px;padding:10px 14px;cursor:pointer">Tümünü kabul et</button>'+
      '</div><div id="asa-ck-err" style="flex-basis:100%;color:#f0c0a0;font-size:12.5px;min-height:0"></div></div>';
    document.body.appendChild(el);
    function setErr(m){ var e=document.getElementById("asa-ck-err"); if(e)e.textContent=m||""; }
    function done(){ var b=document.getElementById("asa-cookie-banner"); if(b)b.remove(); }

    document.getElementById("asa-ck-reject").onclick = function(){
      // Reddet: consent-mode denied KALIR. Sunucuya (varsa) denied yazılır; başarısızlık güvenli tarafta.
      ensureAnonSubject().then(function(subject){
        if(subject){ serverWriteConsent(subject, activeTextVersion, ALL_DENIED); } // sonuç önemli değil: denied zaten güvenli
        writeCache({ decision:"denied", text_version:activeTextVersion, subject:subject||null, exp:Date.now()+TTL_DAYS*864e5 });
        done();
      });
    };
    document.getElementById("asa-ck-accept").onclick = function(){
      setErr("");
      var btn=document.getElementById("asa-ck-accept"); btn.disabled=true; btn.textContent="Kaydediliyor…";
      ensureAnonSubject().then(function(subject){
        if(!subject){ btn.disabled=false; btn.textContent="Tümünü kabul et"; setErr("Şu an kaydedilemedi, lütfen tekrar deneyin."); return; }
        serverWriteConsent(subject, activeTextVersion, ALL_GRANTED).then(function(ok){
          if(!ok){ // sunucu reddetti/erişilemedi -> consent-mode denied KALIR, script YÜKLENMEZ
            btn.disabled=false; btn.textContent="Tümünü kabul et"; setErr("Onay kaydedilemedi; analitik/reklam çerezleri yüklenmedi.");
            return;
          }
          // YALNIZ sunucu başarısından SONRA: consent-mode update + gerçek script yükleme + önbellek
          applyConsentModeUpdate(ALL_GRANTED);
          loadGatedScripts(ALL_GRANTED);
          writeCache({ decision:"granted", text_version:activeTextVersion, subject:subject, exp:Date.now()+TTL_DAYS*864e5 });
          done();
        });
      });
    };
  }

  // ---- init: fail-closed sıralı gate ----
  function init(){
    // (a) endpoint yoksa: TAM PASİF. Hiçbir banner/script yok. (consent-mode zaten denied.)
    if(!ENDPOINT) return;
    // (b) aktif hukuk metni yoksa: grant TOPLANMAZ (banner yok, script yok).
    fetchActiveText().then(function(activeTextVersion){
      if(!activeTextVersion) return; // fail-closed: aktif metin yok -> pasif
      // (c) sunucu-teyitli geçerli önbellek varsa:
      var c = readCache();
      if(cacheValid(c, activeTextVersion)){
        if(c.decision==="granted"){
          // Önbellek TEK BAŞINA script yüklemez ve YENİ consent olayı ÜRETMEZ: yalnız SALT-OKUNUR durum
          // doğrulaması (cookie_consent_status). Aktif grant doğrulanırsa consent-mode update + script yüklenir.
          serverVerifyConsent(c.subject, activeTextVersion).then(function(active){
            if(active){ applyConsentModeUpdate(ALL_GRANTED); loadGatedScripts(ALL_GRANTED); }
            // active değilse: denied kalır, script yok (banner'ı tekrar sormayız; kullanıcı değiştirebilir)
          });
        }
        // denied önbellek: hiçbir şey yükleme, banner gösterme
        return;
      }
      // (d) geçerli karar yok -> banner göster (grant toplanabilir; yalnız buraya kadar geldiyse)
      renderBanner(activeTextVersion);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // Test/again API — script yükleme YOK; yalnız güvenli reset ve pasif-durum sorgusu.
  window.CDP3C_Cookie = {
    reset: function(){ try{ localStorage.removeItem(LS_KEY); }catch(e){} },
    isInert: function(){ return !ENDPOINT; },        // endpoint yoksa modül pasiftir
    forceDenied: function(){ applyConsentModeUpdate(ALL_DENIED); }
  };
})();
