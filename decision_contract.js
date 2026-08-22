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
  var VERSION = 'engine-2026-08 (verbatim from DecisionEngine Faz1 v2 + AOÇ-2 tempClosed + AOÇ-3 diagnoseVenue)';

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

  // ---- GEÇİCİ KAPANIŞ (AOÇ-2) — app ile BİREBİR ----
  // tempClosed = temporarily_closed===true  VEYA  closed_until >= bugün(YMD). active=false AYRI/kalıcı.
  function _ymd(x){ return String(x).slice(0,10); }
  // ÖNCELİK: closed_until doluysa YALNIZ tarih geçerli (>= bugün → kapalı; geçmişse boolean'dan
  // BAĞIMSIZ otomatik açık). closed_until boşsa temporarily_closed=true → manuel açılana kadar kapalı.
  function isTempClosed(v, nowYmd){
    if(!v) return false;
    var cu=v.closed_until;
    if(cu!=null && cu!=='') { var n=nowYmd || new Date().toISOString().slice(0,10); return _ymd(cu) >= n; }
    return (v.temporarily_closed===true || v.temporarily_closed==='true');
  }

  // ---- HAVUZLAR (sağlık) — motorun uygunluk zinciriyle AYNI ----
  function eligibleBase(venues, city, nowYmd){
    return (venues||[]).filter(function(v){ return v && v.active!==false && !isTempClosed(v, nowYmd) && v.city===city && validCoord(v.lat, v.lng); });
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

  // ---- AOÇ-3 · MEKAN-BAZLI TEŞHİS — canlı motorun DOĞRULANMIŞ AYNASI (app ile birebir) ----
  var CONF_RANK={high:3,medium:2,low:1};
  function toRad(x){return x*Math.PI/180;}
  function haversine(aLat,aLng,bLat,bLng){var R=6371,dLa=toRad(bLat-aLat),dLo=toRad(bLng-aLng);var h=Math.sin(dLa/2)*Math.sin(dLa/2)+Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*Math.sin(dLo/2)*Math.sin(dLo/2);return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
  var CITY_COVERAGE={ 'Amsterdam':{lat:52.37043,lng:4.88901,radiusKm:30}, 'Kopenhag':{lat:55.68429,lng:12.57498,radiusKm:45} };
  function matchResv(v,r){if(r==='Fark etmez')return true;if(r==='Yok')return v.resv==='no';if(r==='Var')return v.resv==='rec'||v.resv==='req';return true;}
  function matchGarden(v,g){if(g==='Fark etmez')return true;if(g==='Bahçeli')return v.garden===true;if(g==='Bahçesiz')return v.garden===false;return true;}
  function _cmp(a,b){if(a.km!==b.km)return a.km-b.km;var ca=CONF_RANK[a.v.conf]||0,cb=CONF_RANK[b.v.conf]||0;if(ca!==cb)return cb-ca;return String(a.v.id)<String(b.v.id)?-1:(String(a.v.id)>String(b.v.id)?1:0);}
  function _slotOpen(v,slot){ return openInWindow(v.hours, TIME_WINDOWS[slot]||[0,0]); }
  function _slotReason(v,mode,slot){ var ow=_slotOpen(v,slot); if(ow===null) return 'Saat bilgisi ayrıştırılamıyor'; if(ow===false) return 'Seçilen saatte kapalı'; if(!slotSuitable(v,mode,slot)) return mode+' için '+slot+' uygun değil'; return 'Uygun'; }

  // v: teşhis edilen mekân; ctx:{city,mode,time,resv,garden,loc,targetCount}; allVenues: tüm mekânlar (V)
  function diagnoseVenue(v, ctx, allVenues){
    ctx=ctx||{}; allVenues=allVenues||[];
    var city=ctx.city||v.city, mode=ctx.mode, time=ctx.time;
    var resv=ctx.resv||'Fark etmez', garden=ctx.garden||'Fark etmez';
    var loc=ctx.loc, targetN=ctx.targetCount||5, nowYmd=ctx.nowYmd;   // nowYmd: şehir tz'sinde bugün (admin sağlar)
    var elig0 = (v && v.active!==false && !isTempClosed(v, nowYmd) && v.city===city && validCoord(v.lat,v.lng));

    // (a) mod×zaman grid — yalnız mekân-içsel (konum/kullanıcı-filtresi HARİÇ)
    var grid=[];
    VALID_MODE.forEach(function(m){ VALID_TIME.forEach(function(s){
      var mm=matchMode(v,m), ss=!!(elig0&&mm&&slotSuitable(v,m,s));
      grid.push({mode:m, slot:s, cls:cellClass(m,s), eligible:elig0, matchMode:mm, slotSuitable:!!(mm&&slotSuitable(v,m,s)), qualifies:ss});
    });});

    // (b) SIRALI kapılar (decide zinciriyle aynı; venue_within_coverage ENGEL DEĞİL)
    var gates=[]; function g(k,p,r){ gates.push({key:k,pass:!!p,reason:r}); return !!p; }
    g('active', v.active!==false, v.active!==false?'Aktif':'Pasif (active=false)');
    g('temporarily_closed', !isTempClosed(v, nowYmd), isTempClosed(v, nowYmd)?'Geçici kapalı':'Kapalı değil');
    g('city', v.city===city, v.city===city?('Şehir eşleşti: '+city):('Farklı şehir: '+v.city));
    g('validCoord', validCoord(v.lat,v.lng), validCoord(v.lat,v.lng)?'Geçerli koordinat':'Koordinat yok/geçersiz');
    var mm=(mode!=null)?matchMode(v,mode):null;
    if(mode!=null) g('matchMode', mm, mm?(mode+' kategorisiyle eşleşiyor'):(mode+' kategorisinde değil'));
    if(mode!=null&&time!=null) g('slotSuitable', (elig0&&mm&&slotSuitable(v,mode,time)), _slotReason(v,mode,time));
    g('matchResv', matchResv(v,resv), resv==='Fark etmez'?'Rezervasyon filtresi yok':(matchResv(v,resv)?'Rezervasyon filtresini geçti':'Geçemedi (resv='+(v.resv||'?')+')'));
    g('matchGarden', matchGarden(v,garden), garden==='Fark etmez'?'Bahçe filtresi yok':(matchGarden(v,garden)?'Bahçe filtresini geçti':'Geçemedi (garden='+String(v.garden)+')'));
    var venuePassesExact = elig0 && (mode!=null&&time!=null?(mm&&slotSuitable(v,mode,time)):false) && matchResv(v,resv) && matchGarden(v,garden);

    // (c) konum önizleme — "tam eşleşme sırası" + "ilk N tam eşleşmeye girer mi?"
    var cov=CITY_COVERAGE[city];
    var location={ provided:!!(loc&&validCoord(loc.lat,loc.lng)) };
    // BİLGİLENDİRİCİ: mekân–ŞEHİR MERKEZİ mesafesi (kullanıcı konumundan BAĞIMSIZ; engelleyici DEĞİL, sıra/kapı etkilemez)
    location.venueDistanceFromCityCenter = (cov && validCoord(v.lat,v.lng))? haversine(v.lat,v.lng,cov.lat,cov.lng) : null;
    location.coverageNote = (location.venueDistanceFromCityCenter!=null)
      ? (location.venueDistanceFromCityCenter > cov.radiusKm
          ? ('Bilgi: mekân şehir merkezinden '+location.venueDistanceFromCityCenter.toFixed(1)+' km (kapsama '+cov.radiusKm+' km) — motor bunu ENGEL olarak KULLANMAZ')
          : ('Mekân şehir merkezine '+location.venueDistanceFromCityCenter.toFixed(1)+' km (kapsama içi)'))
      : null;
    if(location.provided){
      location.cityCoverageOk = cov? (haversine(loc.lat,loc.lng,cov.lat,cov.lng) <= cov.radiusKm) : true;
      location.distanceKm = validCoord(v.lat,v.lng)? haversine(loc.lat,loc.lng,v.lat,v.lng) : null;   // kullanıcı→mekân (yalnız gösterim)
      if(mode!=null&&time!=null){
        if(location.cityCoverageOk===false){
          location.exactMatchRank=null; location.appearsInTopNExact=false; location.exactMatchCount=null; location.topN=targetN;
          location.appearReason='Kullanıcı konumu şehir kapsamı dışında (out_of_area) — hiçbir sonuç çıkmaz';
        } else {
          var pool=allVenues.filter(function(x){ return x && x.active!==false && !isTempClosed(x, nowYmd) && x.city===city && validCoord(x.lat,x.lng)
              && matchMode(x,mode) && slotSuitable(x,mode,time) && matchResv(x,resv) && matchGarden(x,garden); })
            .map(function(x){ return {v:x, km:haversine(loc.lat,loc.lng,x.lat,x.lng)}; }).sort(_cmp);
          var idx=-1; for(var i=0;i<pool.length;i++){ if(pool[i].v.id===v.id){ idx=i; break; } }
          location.exactMatchCount=pool.length; location.topN=targetN;
          location.exactMatchRank = idx>=0?(idx+1):null;
          location.appearsInTopNExact = idx>=0 && idx<targetN;
          location.appearReason = idx<0 ? 'Bu mekân tam eşleşme havuzunda değil (bir kapıyı geçemiyor)'
            : (location.appearsInTopNExact ? ('İlk '+targetN+' tam eşleşmeye giriyor (sıra '+(idx+1)+'/'+pool.length+')')
                                           : ('Tam eşleşme sırası '+(idx+1)+'/'+pool.length+'; ilk '+targetN+' dışında (daha yakın '+idx+' mekân)'));
        }
      }
    }
    location.alternativesNote='Alternatif/gevşetme sırasında görünme durumu bu fazda hesaplanmıyor';

    return { venue:{id:v.id,name:v.name,city:v.city}, ctx:{city:city,mode:mode,time:time,resv:resv,garden:garden,loc:location.provided?loc:null},
      grid:grid, gates:gates, venuePassesExact:!!venuePassesExact, location:location };
  }

  return {
    version: VERSION,
    MODE_MAP: MODE_MAP, TIME_WINDOWS: TIME_WINDOWS, DAY: DAY, VALID_MODE: VALID_MODE, VALID_TIME: VALID_TIME,
    validCoord: validCoord, tks: tks, parseHours: parseHours, matchMode: matchMode, slotSuitable: slotSuitable,
    cellClass: cellClass, expectedCells: expectedCells, isTempClosed: isTempClosed,
    eligibleBase: eligibleBase, modePool: modePool, poolCount: poolCount, healthCells: healthCells, modePoolEmpty: modePoolEmpty, tier: tier,
    matchResv: matchResv, matchGarden: matchGarden, haversine: haversine, CITY_COVERAGE: CITY_COVERAGE, diagnoseVenue: diagnoseVenue
  };
});
