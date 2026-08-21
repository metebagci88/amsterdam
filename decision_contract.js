/* =====================================================================
 * ASALOCAL · decision_contract.js — Karar/Plan motoru teşhis SÖZLEŞMESİ
 * Kaynak: şehir uygulamasının DecisionEngine'inden BİREBİR çıkarıldı
 * (matchMode, slotSuitable, parseHours, MODE_MAP, TIME_WINDOWS, DAY, keyword
 * listeleri). Tek doğruluk kaynağı; admin veri-sağlığı (AOÇ-1) ve AOÇ-3
 * motor teşhisi AYNI kodu kullanır → app == admin eşitliği garanti.
 * Bu dosya motor DAVRANIŞINI DEĞİŞTİRMEZ; yalnız aynı kuralları paylaşır.
 * ===================================================================== */
(function (root, factory) {
  var C = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  if (root) root.DecisionContract = C;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var VERSION = 'engine-2026-08 (verbatim from DecisionEngine Faz1 v2)';

  // ---- taksonomi (app ile BİREBİR) ----
  var MODE_MAP = {
    'Kahve': ['kafe','kahve','brunch','kahvaltı'],
    'Yemek': ['restoran','italyan','pizza','burger','taco','meksika','bistro','deniz mahsulleri','deniz ürünleri','tapas','smørrebrød','akdeniz','tavuk','street food','yemek hali','food hall','bagel'],
    'İçki': ['bar','wine bar','şarap','bira','kokteyl'],
    'Yürüyüş': ['park'], 'Park': ['park'],
    'Alışveriş': ['alışveriş','moda','tasarım','vintage','mağaza','mücevher','sneaker','ev','kozmetik','kitap','department store','mobilya','market','lüks','antika']
  };
  var TIME_WINDOWS = {'Sabah':[480,660],'Öğlen':[660,900],'Öğleden sonra':[900,1080],'Akşam':[1080,1320],'Gece':[1320,1500]};
  var DAY = ['Sabah','Öğlen','Öğleden sonra'];
  var FOOD = ['restoran','italyan','pizza','burger','taco','meksika','bistro','deniz mahsulleri','deniz ürünleri','tapas','smørrebrød','akdeniz','tavuk','street food','yemek hali','food hall','bagel','fırın','ekmek'];
  var DRINK = ['bar','wine bar','şarap','bira','kokteyl'];
  var SHOP = ['alışveriş','moda','tasarım','vintage','mağaza','mücevher','sneaker','ev','kozmetik','kitap','department store','mobilya','market','lüks','antika'];
  var VALID_TIME = Object.keys(TIME_WINDOWS);
  var VALID_MODE = ['Çalışmak'].concat(Object.keys(MODE_MAP));

  // ---- primitifler (app ile BİREBİR) ----
  function validCoord(a, b){ return typeof a==='number' && typeof b==='number' && isFinite(a) && isFinite(b) && a>=-90 && a<=90 && b>=-180 && b<=180; }
  function tks(v){ var o=[]; ['cats','tags','best'].forEach(function(k){ (v[k]||[]).forEach(function(x){ if(x!=null) o.push(String(x).toLowerCase()); }); }); return o; }
  function anyIn(l, s){ for(var i=0;i<l.length;i++){ if(s.indexOf(l[i])>-1) return true; } return false; }
  function parseHours(h){ if(!h) return null; var m=String(h).replace(/\s/g,'').match(/^(\d{1,2}):(\d{2})[–\-~](\d{1,2}):(\d{2})$/); if(!m) return null; var o=(+m[1])*60+(+m[2]), c=(+m[3])*60+(+m[4]); if(c<=o) c+=1440; return {open:o, close:c}; }
  function openInWindow(h, win){ var p=parseHours(h); if(!p) return null; function ov(a1,a2,b1,b2){ return a1<b2 && b1<a2; } if(ov(p.open,p.close,win[0],win[1])) return true; if(ov(p.open,p.close,win[0]+1440,win[1]+1440)) return true; return false; }
  function slotOpen(v, slot){ return openInWindow(v.hours, TIME_WINDOWS[slot]||[0,0]); }
  function hasT(v, arr){ return anyIn(tks(v), arr); }
  function isCoffeeCat(v){ var tk=tks(v); return (tk.indexOf('kafe')>-1 || tk.indexOf('kahve')>-1) && !(v.cats||[]).some(function(c){ return String(c).toLowerCase()==='restoran'; }); }
  function isFoodCat(v){ return anyIn(tks(v), FOOD); }
  function isDrinkCat(v){ return anyIn(tks(v), DRINK); }
  function isShopCat(v){ return anyIn(tks(v), SHOP); }
  function isParkCat(v){ return tks(v).indexOf('park')>-1; }

  function matchMode(v, mode){
    if(mode==='Çalışmak') return v.work===true;
    if(mode==='Kahve'){ var tk=tks(v); var hasCoffee=(tk.indexOf('kafe')>-1||tk.indexOf('kahve')>-1); var isRest=(v.cats||[]).some(function(c){ return String(c).toLowerCase()==='restoran'; }); return hasCoffee && !isRest; }
    var s=MODE_MAP[mode]; if(!s) return false; return anyIn(tks(v), s);
  }
  function slotSuitable(v, mode, slot){
    var ow=slotOpen(v, slot); if(ow===false) return false;
    var isDay=DAY.indexOf(slot)>-1, p=parseHours(v.hours);
    if(mode==='Kahve')     return isCoffeeCat(v) && isDay;
    if(mode==='Çalışmak'){ if(v.work!==true) return false; if(slot==='Akşam'||slot==='Gece') return hasT(v,['gece']); return isDay; }
    if(mode==='Yemek'){ if(!isFoodCat(v)) return false; if(slot==='Sabah') return hasT(v,['kahvaltı','brunch']); if(slot==='Gece') return hasT(v,['gece']); return (slot==='Öğlen'||slot==='Öğleden sonra'||slot==='Akşam'); }
    if(mode==='İçki'){ if(!isDrinkCat(v)) return false; if(slot==='Akşam') return true; if(slot==='Gece') return hasT(v,['gece'])||(!!p&&p.close>=1380); return false; }
    if(mode==='Alışveriş') return isShopCat(v) && isDay;
    if(mode==='Yürüyüş'||mode==='Park') return isParkCat(v) && isDay;
    return false;
  }

  // ---- BEKLENEN HÜCRE sınıfı — slotSuitable'DAN TÜRETİLİR (paralel tablo YOK) ----
  // core: mode kategorisi + 24s açık + özel etiket YOK iken slot uygun → sağlıkta değerlendirilir
  // optional: yalnız özel etiket (gece / kahvaltı-brunch) ile uygun → boşsa 'info' (kritik değil)
  // na: hiçbir venue ile uygun olamaz (ör. Kahve+Gece, Park+Gece) → sağlıktan hariç
  function _catToken(mode){
    if(mode==='Kahve') return {cats:['kafe']};
    if(mode==='Yemek') return {cats:['restoran']};
    if(mode==='İçki') return {cats:['bar']};
    if(mode==='Alışveriş') return {cats:['mağaza']};
    if(mode==='Yürüyüş'||mode==='Park') return {cats:['park']};
    if(mode==='Çalışmak') return {cats:['kafe'], work:true};
    return {cats:[]};
  }
  function _mk(base, extraTags, work){ var v=JSON.parse(JSON.stringify(base)); v.hours='00:00-23:59'; v.tags=(v.tags||[]).concat(extraTags||[]); if(work) v.work=true; return v; }
  function cellClass(mode, slot){
    var base=_catToken(mode);
    var core=_mk(base, [], base.work);                                   // özel etiket yok
    if(slotSuitable(core, mode, slot)) return 'core';
    var opt=_mk(base, ['gece','kahvaltı','brunch'], base.work);          // özel etiketli
    if(slotSuitable(opt, mode, slot)) return 'optional';
    return 'na';
  }
  function expectedCells(){
    var out=[]; VALID_MODE.forEach(function(m){ VALID_TIME.forEach(function(s){ var c=cellClass(m,s); if(c!=='na') out.push({mode:m, slot:s, cls:c}); }); }); return out;
  }

  // ---- HAVUZLAR (sağlık) — motorun uygunluk zinciriyle AYNI ----
  function eligibleBase(venues, city){
    return (venues||[]).filter(function(v){ return v && v.active!==false && v.city===city && validCoord(v.lat, v.lng); });
  }
  function modePool(venues, city, mode){ return eligibleBase(venues, city).filter(function(v){ return matchMode(v, mode); }); }
  function poolCount(venues, city, mode, slot){ return modePool(venues, city, mode).filter(function(v){ return slotSuitable(v, mode, slot); }).length; }
  function tier(n){ return n<=2 ? 'critical' : (n<=4 ? 'weak' : 'ok'); }   // 0–2 kritik, 3–4 zayıf, 5+ yeterli

  function healthCells(venues, city){
    var rows=[]; VALID_MODE.forEach(function(m){
      var modeEligible=modePool(venues, city, m).length;
      VALID_TIME.forEach(function(s){
        var cls=cellClass(m,s); if(cls==='na') return;                    // beklenmeyen hücre → hariç
        var n=poolCount(venues, city, m, s);
        rows.push({mode:m, slot:s, cls:cls, count:n, modeEligible:modeEligible,
          severity: cls==='optional' ? (n>0?'ok':'info') : tier(n)});      // optional boşsa 'info', kritik değil
      });
    });
    return rows;
  }
  function modePoolEmpty(venues, city){
    return VALID_MODE.map(function(m){ return {mode:m, eligible: modePool(venues, city, m).length}; })
                     .filter(function(x){ return x.eligible===0; });        // decision_pool_empty
  }

  return {
    version: VERSION,
    MODE_MAP: MODE_MAP, TIME_WINDOWS: TIME_WINDOWS, DAY: DAY, VALID_MODE: VALID_MODE, VALID_TIME: VALID_TIME,
    validCoord: validCoord, tks: tks, parseHours: parseHours, matchMode: matchMode, slotSuitable: slotSuitable,
    cellClass: cellClass, expectedCells: expectedCells,
    eligibleBase: eligibleBase, modePool: modePool, poolCount: poolCount, healthCells: healthCells, modePoolEmpty: modePoolEmpty, tier: tier
  };
});
