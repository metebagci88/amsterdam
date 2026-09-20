import crypto from "node:crypto";
// --- Edge'deki verifySvix ile AYNI algoritma (Web Crypto yerine node crypto ile birebir) ---
function b64ToBytes(b64){ return Buffer.from(b64,"base64"); }
function timingSafeEqual(a,b){ if(a.length!==b.length) return false; let r=0; for(let i=0;i<a.length;i++) r|=a.charCodeAt(i)^b.charCodeAt(i); return r===0; }
function sign(secret,id,ts,body){ const key=b64ToBytes(secret.startsWith("whsec_")?secret.slice(6):secret); const h=crypto.createHmac("sha256",key); h.update(`${id}.${ts}.${body}`); return h.digest("base64"); }
function verify(secret,id,ts,body,sigHeader){
  const now=Math.floor(Date.now()/1000); const t=parseInt(ts,10);
  if(!Number.isFinite(t)||Math.abs(now-t)>300) return false;
  const expected=sign(secret,id,ts,body);
  for(const part of sigHeader.split(" ")){ const idx=part.indexOf(","); const val=idx>=0?part.slice(idx+1):part; if(timingSafeEqual(val,expected)) return true; }
  return false;
}
let pass=0,fail=0; const L=[];
const ok=(n,c)=>{c?(pass++,L.push("PASS "+n)):(fail++,L.push("FAIL "+n));};
const secret="whsec_"+Buffer.from("supersecretkey_1234567890").toString("base64");
const id="msg_1", ts=String(Math.floor(Date.now()/1000)), body=JSON.stringify({type:"email.delivered",data:{email_id:"x"}});
const good=sign(secret,id,ts,body);
ok("geçerli imza doğrulanır", verify(secret,id,ts,body,"v1,"+good)===true);
ok("çoklu imzada biri doğruysa geçer", verify(secret,id,ts,body,"v1,AAAA v1,"+good)===true);
ok("gövde değişince reddeder", verify(secret,id,ts,body+"x","v1,"+good)===false);
ok("yanlış secret reddeder", verify("whsec_"+Buffer.from("other").toString("base64"),id,ts,body,"v1,"+good)===false);
ok("eski timestamp reddeder", verify(secret,id,String(Math.floor(Date.now()/1000)-600),body,"v1,"+sign(secret,id,String(Math.floor(Date.now()/1000)-600),body))===false);
ok("imza header boş reddeder", verify(secret,id,ts,body,"")===false);
console.log(L.join("\n")); console.log(`\nSVIX pass=${pass} fail=${fail}`); console.log(fail===0?"SVIX_PASS":"SVIX_FAIL"); process.exit(fail?1:0);
