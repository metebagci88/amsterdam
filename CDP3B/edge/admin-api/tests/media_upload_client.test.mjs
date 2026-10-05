import { readFileSync } from "node:fs";
const FILES = ["admin.html", "CDP3B/admin.html"];
let pass=0, fail=0;
function ok(c,m){ if(c){pass++;} else {fail++; console.log("FAIL: "+m);} }
function extractFn(src, sig){ const i=src.indexOf(sig); if(i<0) throw new Error("sig yok: "+sig); const b=src.indexOf("{",i); let d=0; for(let j=b;j<src.length;j++){const c=src[j]; if(c==="{")d++; else if(c==="}"){d--; if(d===0) return src.slice(i,j+1);}} throw new Error("brace: "+sig); }
const TOKEN="SESSIONTOKEN_do_not_log_123456789";
const CFG={url:"https://tosqsabuaomgqjtogdrn.supabase.co", key:"ANON_KEY_PLACEHOLDER"};
const FN_URL=CFG.url+"/functions/v1/admin-api";
function makeFetch(resp){ const calls=[]; const fn=async(url,opts)=>{ calls.push({url,opts}); if(resp&&resp.throw) throw new Error("net"); return {ok:resp.status>=200&&resp.status<300,status:resp.status,json:async()=>resp.body}; }; fn.calls=calls; return fn; }
function makeAuth(session){ return {auth:{getSession:async()=>({data:{session}})}}; }
for(const file of FILES){
  const src=readFileSync(file,"utf8");
  const srcErr=extractFn(src,"function uploadErrMsg(status,code){");
  const srcUp =extractFn(src,"async function uploadToMedia(file, prefix){");
  ok(!/storage\.from\(/.test(srcUp), file+": storage.from yok (fallback yok)");
  ok(/FN_URL/.test(srcUp), file+": admin-api yolu");
  const logbuf=[]; const orig={log:console.log,error:console.error,warn:console.warn,info:console.info};
  for(const k of Object.keys(orig)) console[k]=(...a)=>logbuf.push(a.map(String).join(" "));
  const build=(fi,au)=> new Function("authClient","CFG","FN_URL","fetch","FormData", srcErr+"\n"+srcUp+"\n return {uploadToMedia, uploadErrMsg};")(au,CFG,FN_URL,fi,FormData);
  const blob=new Blob([new Uint8Array([0xff,0xd8,0xff])],{type:"image/jpeg"}); const file1=blob;
  let f=makeFetch({status:200,body:{request_id:"r",data:{bucket:"media",path:"venues/u.jpg",public_url:"https://x/venues/u.jpg",mime:"image/jpeg",bytes:3}}}); let api=build(f,makeAuth({access_token:TOKEN}));
  let url=await api.uploadToMedia(file1,"venues");
  ok(url==="https://x/venues/u.jpg", file+": venues happy public_url");
  ok(f.calls.length===1&&f.calls[0].url===FN_URL&&f.calls[0].opts.method==="POST", file+": POST FN_URL");
  const h=f.calls[0].opts.headers;
  ok(h["Authorization"]==="Bearer "+TOKEN, file+": Authorization session token");
  ok(h["apikey"]===CFG.key, file+": apikey");
  ok(!Object.keys(h).map(x=>x.toLowerCase()).includes("content-type"), file+": Content-Type set EDİLMEDİ");
  const fd=f.calls[0].opts.body; ok(fd instanceof FormData&&fd.get("action")==="media_upload"&&fd.get("prefix")==="venues"&&fd.get("file")!=null, file+": FormData alanları");
  f=makeFetch({status:200,body:{data:{public_url:"https://x/ads/u.png"}}}); api=build(f,makeAuth({access_token:TOKEN}));
  url=await api.uploadToMedia(file1,"ads"); ok(url==="https://x/ads/u.png"&&f.calls[0].opts.body.get("prefix")==="ads", file+": ads prefix");
  f=makeFetch({status:200,body:{}}); api=build(f,makeAuth({access_token:TOKEN})); let t=false; try{await api.uploadToMedia(file1,"evil");}catch(e){t=true;} ok(t&&f.calls.length===0, file+": bilinmeyen prefix reddi fetch yok");
  f=makeFetch({status:200,body:{}}); api=build(f,makeAuth(null)); t=false; let m=""; try{await api.uploadToMedia(file1,"venues");}catch(e){t=true;m=e.message;} ok(t&&f.calls.length===0&&/Oturumunuz/.test(m), file+": oturum yok 401 fetch yok");
  const EM=api.uploadErrMsg;
  ok(/Oturumunuz/.test(EM(401)),file+":401"); ok(/yetkiniz/.test(EM(403)),file+":403"); ok(/5 MB/.test(EM(413)),file+":413");
  ok(/5 MB/.test(EM(400,"bad_size")),file+":400 bad_size"); ok(/WebP/.test(EM(400,"bad_mime_content")),file+":400 bad_mime");
  ok(/WebP/.test(EM(415)),file+":415"); ok(/WebP/.test(EM(422)),file+":422"); ok(/Çok fazla/.test(EM(429)),file+":429");
  ok(/yüklenemedi/.test(EM(500))&&/yüklenemedi/.test(EM(409,"object_exists"))&&/yüklenemedi/.test(EM(0)),file+":nötr");
  for(const [st,code,re] of [[413,null,/5 MB/],[400,"bad_mime_content",/WebP/],[403,null,/yetkiniz/],[429,null,/Çok fazla/],[500,"internal",/yüklenemedi/]]){
    f=makeFetch({status:st,body:{error:code}}); api=build(f,makeAuth({access_token:TOKEN})); t=false;m="";let ec=null; try{await api.uploadToMedia(file1,"venues");}catch(e){t=true;m=e.message;ec=e.code;}
    ok(t&&re.test(m)&&ec===st&&!/stack|supabase|bucket|Bearer|eyJ/.test(m), file+": status "+st+" doğru mesaj iç detay yok");
  }
  f=makeFetch({throw:true}); api=build(f,makeAuth({access_token:TOKEN})); t=false;m=""; try{await api.uploadToMedia(file1,"venues");}catch(e){t=true;m=e.message;} ok(t&&/yüklenemedi/.test(m), file+": network nötr");
  for(const k of Object.keys(orig)) console[k]=orig[k];
  ok(!logbuf.join("\n").includes(TOKEN), file+": token console'a yazılmadı");
}
console.log(`\nSEC-MEDIA client test: pass=${pass} fail=${fail}`);
if(fail>0){console.log("MEDIA_WIRING_TEST_FAIL");process.exit(1);} console.log("MEDIA_WIRING_TEST_PASS");
