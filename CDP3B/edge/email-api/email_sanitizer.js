/* ASALOCAL · CDP-3A prototip · Email HTML import sanitizer/validator (ALLOWLIST tabanlı)
 * PORTABLE ruleset — aynı mantık Deno Edge (server-side) çalışacak. PROTOTİP; production'a uygulanmadı.
 *
 * TASARIM KARARLARI (CDP-3A kapanış):
 *  - TAG ALLOWLIST: yalnız email-safe etiketler korunur; DİĞER her etiket reddedilir/kaldırılır (yalnız kara-listeye güvenilmez).
 *      · tehlikeli etiketler (script/iframe/style/svg...) alt-ağacıyla SİLİNİR
 *      · bilinmeyen/özel etiketler UNWRAP edilir (içerik/metin korunur, etiket düşer) ve raporlanır
 *  - ATTRIBUTE ALLOWLIST tag-bazlı: izinli olmayan attribute (on*, srcset, poster, xlink:href, namespaced, background, formaction...) KALDIRILIR.
 *  - URL kontrolü: HTML-entity ve boşluk/kontrol karakteri ile GİZLENMİŞ protokoller decode edilir; yalnız http/https/mailto/tel; protocol-relative (//host) reddedilir; img'de sınırlı data:image.
 *  - CSS (korumacı MVP): <style> blokları REDDEDİLİR; inline style'da url()/@import/expression/behavior/position TAMAMEN reddedilir; yalnız allowlist property/value çiftleri (parantez/tırnak farkında ayrıştırıcı, saf string-arama DEĞİL).
 *  - HASH: burada yalnız `prototype_checksum` (djb2, güvenli değil). Gerçek `content_hash` = server-side SHA-256 (bkz. computeHashesSHA256). builder_json_hash ayrı üretilir. Hash'ler audit/idempotency/integrity içindir; güvenlik token'ı DEĞİL.
 *
 * API: EmailSanitizer.process(rawHtml, opts) -> report ; EmailSanitizer.previewSafe(html) ; EmailSanitizer.computeHashesSHA256(sanitizedHtml, builderJson)
 */
(function (root) {
  'use strict';

  // ---- ALLOWLIST'ler ----
  var TAG_ALLOW = ['html','head','body','title','meta','table','thead','tbody','tfoot','tr','th','td',
    'div','span','p','h1','h2','h3','h4','h5','h6','a','img','br','hr','strong','b','em','i','u',
    'ul','ol','li','center','blockquote'];
  var TAG_DANGEROUS = ['script','style','iframe','object','embed','form','input','button','select','textarea',
    'svg','math','link','base','applet','frame','frameset','noscript','template','portal','video','audio','source','picture','marquee','map','area'];
  var ATTR_GLOBAL = ['class','id','style','dir','lang','role','title','align','valign'];
  var ATTR_BY_TAG = {
    a:['href','target','title','rel'],
    img:['src','width','height','alt','title'],
    table:['width','height','align','valign','bgcolor','cellpadding','cellspacing','border','role'],
    td:['width','height','align','valign','bgcolor','colspan','rowspan'],
    th:['width','height','align','valign','bgcolor','colspan','rowspan'],
    tr:['align','valign','bgcolor','height'],
    thead:['align','valign'], tbody:['align','valign'], tfoot:['align','valign']
  };
  var SAFE_PROTOCOLS = ['http:','https:','mailto:','tel:'];
  var STYLE_PROP_ALLOW = ['color','background-color','font','font-family','font-size','font-weight','font-style',
    'line-height','letter-spacing','text-align','text-decoration','text-transform','vertical-align',
    'padding','padding-top','padding-right','padding-bottom','padding-left',
    'margin','margin-top','margin-right','margin-bottom','margin-left',
    'border','border-top','border-right','border-bottom','border-left','border-radius','border-color',
    'border-width','border-style','border-collapse','border-spacing',
    'width','max-width','min-width','height','max-height','min-height','display','white-space','word-break','overflow-wrap','mso-line-height-rule'];
  // 'background' (shorthand) ve 'background-image' KASITEN yok -> url() barındırabilir.
  var STYLE_VALUE_DENY = ['url(','expression','@import','javascript','vbscript','behavior','-moz-binding','/*','*/','\\','position'];

  function djb2(str){ var h=5381,i=str.length; while(i){h=(h*33)^str.charCodeAt(--i);} return (h>>>0).toString(16); }

  // HTML entity + kontrol karakteri decode (protokol gizleme savunması)
  function decodeEntities(s){
    s = String(s);
    s = s.replace(/&#x([0-9a-fA-F]+);?/g, function(_,h){ try{return String.fromCodePoint(parseInt(h,16));}catch(e){return '';} });
    s = s.replace(/&#(\d+);?/g, function(_,d){ try{return String.fromCodePoint(parseInt(d,10));}catch(e){return '';} });
    var named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",colon:':',sol:'/',tab:'\t',newline:'\n',lpar:'(',rpar:')'};
    s = s.replace(/&([a-zA-Z]+);?/g, function(m,n){ n=n.toLowerCase(); return named.hasOwnProperty(n)?named[n]:m; });
    return s;
  }
  function urlClass(raw){
    var d = decodeEntities(raw).replace(new RegExp('['+String.fromCharCode(0)+'-'+String.fromCharCode(32)+']+','g'),''); // gizleyen boşluk/kontrol karakterlerini kaldır
    var low = d.toLowerCase();
    if(low.indexOf('//')===0) return {kind:'protocol_relative', clean:d};
    var m = low.match(/^([a-z][a-z0-9+.\-]*):/);
    if(!m) return {kind:'relative', clean:d};
    var proto = m[1]+':';
    if(proto==='data:') return {kind:'data', clean:d, proto:proto};
    if(SAFE_PROTOCOLS.indexOf(proto)>=0) return {kind:'safe', clean:d, proto:proto};
    return {kind:'bad', clean:d, proto:proto};
  }
  function isBlobOrLocal(raw){
    var u=decodeEntities(raw).trim().toLowerCase();
    return u.indexOf('blob:')===0||u.indexOf('file:')===0||u.indexOf('cid:')===0||u.indexOf('./')===0||u.indexOf('../')===0||/^[a-z]:\\/.test(u);
  }
  function findVariables(html){ var set={},re=/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,m; while((m=re.exec(html))) set[m[1]]=true; return Object.keys(set); }

  // parantez/tırnak farkında declaration ayrıştırıcı (saf split değil)
  function splitDeclarations(style){
    var out=[], buf='', depth=0, q=null;
    for(var i=0;i<style.length;i++){ var c=style[i];
      if(q){ buf+=c; if(c===q) q=null; continue; }
      if(c==='"'||c==="'"){ q=c; buf+=c; continue; }
      if(c==='(') depth++; if(c===')') depth=Math.max(0,depth-1);
      if(c===';'&&depth===0){ if(buf.trim())out.push(buf.trim()); buf=''; } else buf+=c;
    }
    if(buf.trim())out.push(buf.trim());
    return out;
  }
  function sanitizeStyle(style, removed){
    var out=[]; var decls=splitDeclarations(decodeEntities(style));
    for(var i=0;i<decls.length;i++){ var d=decls[i]; var idx=d.indexOf(':'); if(idx<0)continue;
      var prop=d.slice(0,idx).trim().toLowerCase(); var val=d.slice(idx+1).trim(); var low=(prop+':'+val).toLowerCase();
      var bad=false; for(var j=0;j<STYLE_VALUE_DENY.length;j++){ if(low.indexOf(STYLE_VALUE_DENY[j])>=0){bad=true;break;} }
      if(bad){ removed.push('style-decl-denied:'+prop); continue; }
      if(STYLE_PROP_ALLOW.indexOf(prop)<0){ removed.push('style-prop-unlisted:'+prop); continue; }
      out.push(prop+': '+val);
    }
    return out.join('; ');
  }

  function unwrap(el){ var p=el.parentNode; if(!p)return; while(el.firstChild){ p.insertBefore(el.firstChild, el);} p.removeChild(el); }

  function process(rawHtml, opts){
    opts=opts||{};
    var emailClass=opts.emailClass||'marketing';
    var allowedVars=opts.allowedVars||['first_name','city_name','trip_start_date','trip_end_date','days_until_trip','unsubscribe_url'];
    var remoteAllow=opts.remoteImageAllowlist||[];
    var maxB64=opts.maxBase64Bytes||40000;
    var parseHTML=opts.parseHTML;
    var report={ok:true,errors:[],warnings:[],removed:[],variables_found:[],assets:[],stats:{}};
    if(!parseHTML){report.ok=false;report.errors.push('no_parser');return report;}
    if(typeof rawHtml!=='string'||!rawHtml.trim()){report.ok=false;report.errors.push('empty_html');return report;}

    report.variables_found=findVariables(rawHtml);
    var unknownVars=report.variables_found.filter(function(v){return allowedVars.indexOf(v)<0;});
    if(unknownVars.length){report.ok=false;report.errors.push('unknown_variable:'+unknownVars.join(','));}

    var doc=parseHTML(rawHtml);
    var scope=doc.body||doc.documentElement||doc;

    // 1) tehlikeli etiketleri alt-ağaçla SİL
    TAG_DANGEROUS.forEach(function(tag){
      Array.prototype.slice.call(scope.querySelectorAll(tag)).forEach(function(el){
        report.removed.push(tag); if(el.parentNode)el.parentNode.removeChild(el);
      });
    });
    // 1b) meta: yalnız charset / viewport korunur
    Array.prototype.slice.call(scope.querySelectorAll('meta')).forEach(function(el){
      var ok=false; if(el.getAttribute('charset')!=null)ok=true;
      var name=(el.getAttribute('name')||'').toLowerCase(); if(name==='viewport')ok=true;
      if(!ok){ report.removed.push('meta'); if(el.parentNode)el.parentNode.removeChild(el); }
    });

    // 2) bilinmeyen/özel etiketleri UNWRAP (allowlist dışı, tehlikeli değil)
    Array.prototype.slice.call(scope.querySelectorAll('*')).forEach(function(el){
      if(!el.parentNode) return;
      var tag=(el.tagName||'').toLowerCase(); if(!tag) return;
      if(TAG_ALLOW.indexOf(tag)>=0) return;
      if(tag.indexOf('-')>=0) report.removed.push('unknown_custom_element:'+tag);
      else report.removed.push('unknown_tag:'+tag);
      unwrap(el);
    });

    // 3) kalan (allowlist) elementlerde attribute allowlist + url + style + img
    var imgTotal=0,imgNoAlt=0,remoteImg=0,localImg=0,b64Img=0,trackerSuspect=0;
    Array.prototype.slice.call(scope.querySelectorAll('*')).forEach(function(el){
      var tag=(el.tagName||'').toLowerCase();
      var allowed=ATTR_GLOBAL.concat(ATTR_BY_TAG[tag]||[]);
      Array.prototype.slice.call(el.attributes||[]).forEach(function(a){
        var name=a.name.toLowerCase(), val=a.value;
        if(allowed.indexOf(name)<0){ report.removed.push('attr:'+tag+'.'+name); el.removeAttribute(a.name); return; }
        if(name==='href'||name==='src'){
          if(name==='src'&&tag==='img'){
            var c=urlClass(val);
            if(c.kind==='data'){
              if(!/^data:image\/(png|jpe?g|gif|webp)[;,]/i.test(c.clean)){ report.removed.push('img-data-nonimage'); el.removeAttribute('src'); return; }
              if(val.length>maxB64) report.warnings.push('img_base64_too_large');
              b64Img++; report.assets.push({type:'base64',bytes:val.length});
            } else if(isBlobOrLocal(val)){ localImg++; report.assets.push({type:'local_or_blob',src:c.clean,action:'MUST_REHOST'}); report.warnings.push('local_image_needs_rehost'); }
            else if(c.kind==='safe'){ remoteImg++; var host=(c.clean.match(/^https?:\/\/([^\/?#]+)/i)||[])[1]||''; report.assets.push({type:'remote',src:c.clean,host:host,action:(remoteAllow.indexOf(host)>=0?'ALLOW':'REVIEW_OR_REHOST')}); if(remoteAllow.length&&remoteAllow.indexOf(host)<0)report.warnings.push('remote_image_not_allowlisted:'+host); }
            else if(c.kind==='protocol_relative'){ remoteImg++; report.warnings.push('protocol_relative_image_rehost'); report.assets.push({type:'protocol_relative',src:c.clean,action:'MUST_REHOST'}); el.removeAttribute('src'); }
            else { report.removed.push('img-bad-proto'); el.removeAttribute('src'); return; }
          } else {
            var cc=urlClass(val);
            if(cc.kind==='relative'){ if(String(val).trim())report.warnings.push('relative_url:'+name); }
            else if(cc.kind!=='safe'){ report.removed.push('bad-proto:'+name+':'+(cc.proto||cc.kind)); el.removeAttribute(a.name); return; }
          }
        }
        if(name==='style'){ var cleaned=sanitizeStyle(val,report.removed); if(cleaned)el.setAttribute('style',cleaned); else el.removeAttribute('style'); }
        if(name==='target'){ if(!/^_(blank|self)$/.test(val)){ el.setAttribute('target','_blank'); } if(!el.getAttribute('rel')) el.setAttribute('rel','noopener noreferrer'); }
      });
      if(tag==='img'){ imgTotal++; var alt=el.getAttribute('alt'); if(alt===null||alt===''){imgNoAlt++;report.warnings.push('img_missing_alt');}
        var w=parseInt(el.getAttribute('width')||'0',10),h=parseInt(el.getAttribute('height')||'0',10);
        if((w>0&&w<=2)&&(h>0&&h<=2)){trackerSuspect++;report.warnings.push('tracking_pixel_suspect');}
      }
    });

    if(emailClass==='marketing'){
      if(report.variables_found.indexOf('unsubscribe_url')<0){report.ok=false;report.errors.push('missing_unsubscribe_url_variable');}
      var bt=(scope.textContent||'').toLowerCase();
      if(!(bt.indexOf('unsubscribe')>=0||bt.indexOf('abonelik')>=0||bt.indexOf('üyelikten')>=0||report.variables_found.indexOf('unsubscribe_url')>=0)) report.warnings.push('marketing_legal_footer_missing');
    }

    var sanitized=(doc.body?doc.body.innerHTML:scope.innerHTML)||'';
    var tmp=parseHTML('<!doctype html><html><body>'+sanitized+'</body></html>');
    Array.prototype.slice.call((tmp.body||tmp).querySelectorAll('a')).forEach(function(a){ var href=a.getAttribute('href')||'',t=a.textContent||''; if(href&&t&&href.indexOf('{{')<0)a.textContent=t+' ('+href+')'; });
    var plain=((tmp.body||tmp).textContent||'').replace(/[ \t]+/g,' ').replace(/\n\s*\n\s*\n+/g,'\n\n').trim();

    report.sanitized_html=sanitized;
    report.plain_text=plain;
    // NOT: güvenli DEĞİL; production content_hash = server-side SHA-256 (computeHashesSHA256).
    report.prototype_checksum=djb2(sanitized);
    report.stats={images:imgTotal,images_missing_alt:imgNoAlt,remote_images:remoteImg,local_images:localImg,base64_images:b64Img,tracker_suspect:trackerSuspect,bytes:sanitized.length,variables:report.variables_found.length};
    report.removed=Array.from(new Set(report.removed));
    report.warnings=Array.from(new Set(report.warnings));
    report.errors=Array.from(new Set(report.errors));
    if(report.errors.length)report.ok=false;
    return report;
  }

  // Önizleme güvenliği: uzak/local görsel src'lerini boşalt (validate/preview sırasında tracker çağrısı OLMASIN)
  function previewSafe(html){
    return String(html).replace(/(<img\b[^>]*?)\ssrc\s*=\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)/gi, function(m,pre){
      return pre+' src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=" data-preview-blocked="1"';
    });
  }

  // Gerçek content_hash / builder_json_hash = SHA-256 (server-side/deno + browser crypto.subtle uyumlu)
  async function computeHashesSHA256(sanitizedHtml, builderJson){
    async function sha(str){
      var enc=new TextEncoder().encode(str);
      var subtle=(typeof crypto!=='undefined'&&crypto.subtle)?crypto.subtle:(typeof require!=='undefined'?require('crypto').webcrypto.subtle:null);
      var buf=await subtle.digest('SHA-256',enc);
      return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
    }
    var out={content_hash:await sha(String(sanitizedHtml||''))};
    if(builderJson!==undefined&&builderJson!==null){ out.builder_json_hash=await sha(typeof builderJson==='string'?builderJson:JSON.stringify(builderJson)); }
    return out;
  }

  var api={process:process, previewSafe:previewSafe, computeHashesSHA256:computeHashesSHA256, findVariables:findVariables, _decodeEntities:decodeEntities, _prototypeChecksum:djb2,
    TAG_ALLOW:TAG_ALLOW, TAG_DANGEROUS:TAG_DANGEROUS};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.EmailSanitizer=api;
})(typeof window!=='undefined'?window:this);
