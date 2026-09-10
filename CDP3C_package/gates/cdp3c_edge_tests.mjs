/* =====================================================================
   CDP-3C · Edge/Admin/Üye/Çerez — DESTEKLEYİCİ testler (Node, AĞ GEREKTİRMEZ)
   Çalıştırma:  node CDP3C_package/gates/cdp3c_edge_tests.mjs
   ---------------------------------------------------------------------
   ⚠️ BU DOSYA DEPLOY KANITI DEĞİLDİR. Gerçek handler'ı ÇALIŞTIRMAZ; email-api'den
   KOPYALANMIŞ saf yardımcıları (birim) ve gerçek dosyalara karşı regex/statik kaynak
   SÖZLEŞMELERİNİ test eder. Deploy kabulü için gerçek HTTP/RPC gateّi kullanılır:
   `.github/workflows/cdp3c-edge-integration.yml` + `gates/cdp3c_edge_integration.sh`
   (supabase functions serve ile gerçek birleşik Edge handler'ları + gerçek DB RPC).
   Bu dosya YALNIZCA o entegrasyon gate'ini destekleyen hızlı yerel kontroldür.
   ---------------------------------------------------------------------
   İki katman:
     (A) BİRİM: email-api'nin saf doğrulama/CORS/hata-eşleme mantığı (kaynaktan birebir kopya).
     (B) STATİK SÖZLEŞME: gerçek birleşik dosyalara karşı grep-tabanlı garanti assert'leri.
   ===================================================================== */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
let pass = 0, fail = 0; const fails = [];
function ok(name, cond){ if(cond){ pass++; } else { fail++; fails.push(name); console.log("  ✗ "+name); } }
function grp(t){ console.log("\n== "+t+" =="); }

/* ---------- (A) email-api saf mantık (kaynaktan birebir) ---------- */
const ADMIN_ORIGINS = ["https://www.asalocal.club", "https://asalocal.club"];
function originState(origin){ const present=!!origin; const allow=present && ADMIN_ORIGINS.includes(origin); return {present,allow}; }
function cors(origin){ const h={ "Vary":"Origin","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS" }; if(originState(origin).allow) h["Access-Control-Allow-Origin"]=origin; return h; }
class HttpErr extends Error{ constructor(code,msg){ super(msg); this.code=code; } }
function strictBool(v,name){ if(v!==true&&v!==false) throw new HttpErr(422,"bad_bool:"+name); return v; }
function inSet(v,allowed,name){ if(typeof v!=="string"||!allowed.includes(v)) throw new HttpErr(422,"bad_value:"+name); return v; }
function optUuidOrNull(v,name){ const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; if(v===null||v===undefined) return null; if(typeof v!=="string"||!UUID_RE.test(v)) throw new HttpErr(422,"bad_uuid:"+name); return v; }
function closedFields(body,allowed){ for(const k of Object.keys(body)) if(!allowed.includes(k)) throw new HttpErr(400,"unknown_field:"+k); }
const PREF_CENTER_PURPOSES=["email_marketing","sms_marketing","push_marketing","on_site_personalized_messages","personalization_profiling"];
const CONSENT_LOCALES=["tr","en"];
// hata-eşleme (email-api catch bloğundan)
function mapErr(msg){
  const known=["forbidden","not_admin","idempotency_conflict","analytics_managed_by_cookie_flow","withdraw_text_version_must_be_null","no_active_controller","invalid_or_stale_consent_version","marketing_capture_disabled","cookie_purpose_requires_cookie_banner","cookie_banner_purpose_only","signup_cannot_grant_marketing","anon_purpose_not_allowed"];
  const hit=known.find(k=>msg.includes(k));
  const S409=new Set(["idempotency_conflict","no_active_controller","invalid_or_stale_consent_version","marketing_capture_disabled","signup_cannot_grant_marketing"]);
  const S422=new Set(["analytics_managed_by_cookie_flow","withdraw_text_version_must_be_null","cookie_purpose_requires_cookie_banner","cookie_banner_purpose_only","anon_purpose_not_allowed"]);
  const code=(hit==="forbidden"||hit==="not_admin")?403:S409.has(hit)?409:S422.has(hit)?422:400;
  return {hit:hit||"internal_error", code};
}
function throws(fn){ try{ fn(); return false; }catch(e){ return e instanceof HttpErr ? e : true; } }

grp("(A) BİRİM · CORS / origin");
ok("T01a unknown origin => not allowed (403 yolu), ACAO yok", (()=>{ const s=originState("https://evil.example"); const h=cors("https://evil.example"); return s.present&&!s.allow&&!("Access-Control-Allow-Origin" in h); })());
ok("T01b allowlist origin => ACAO=origin", cors("https://www.asalocal.club")["Access-Control-Allow-Origin"]==="https://www.asalocal.club");
ok("T01c no-origin => present=false, ACAO yok", (()=>{ const s=originState(null); const h=cors(null); return !s.present && !("Access-Control-Allow-Origin" in h); })());

grp("(A) BİRİM · strict boolean ('false'/'0' reddi)");
ok("T02a string 'false' => 422", (()=>{ const e=throws(()=>strictBool("false","grant")); return e&&e.code===422; })());
ok("T02b string '0' => 422", (()=>{ const e=throws(()=>strictBool("0","grant")); return e&&e.code===422; })());
ok("T02c number 1 => 422", (()=>{ const e=throws(()=>strictBool(1,"grant")); return e&&e.code===422; })());
ok("T02d gerçek true kabul", strictBool(true,"grant")===true);

grp("(A) BİRİM · allowlist + closed-field + withdraw");
ok("T06a analytics_storage pref_center'da reddedilir", (()=>{ const e=throws(()=>inSet("analytics_storage",PREF_CENTER_PURPOSES,"purpose")); return e&&e.code===422; })());
ok("T06b advertising_storage reddedilir", (()=>{ const e=throws(()=>inSet("advertising_storage",PREF_CENTER_PURPOSES,"purpose")); return e&&e.code===422; })());
ok("T06c email_marketing kabul", inSet("email_marketing",PREF_CENTER_PURPOSES,"purpose")==="email_marketing");
ok("Txx locale allowlist (de => 422)", (()=>{ const e=throws(()=>inSet("de",CONSENT_LOCALES,"locale")); return e&&e.code===422; })());
ok("Txx unknown field => 400", (()=>{ const e=throws(()=>closedFields({action:"consent_set",purpose:"x",evil:1},["action","purpose"])); return e&&e.code===400; })());
ok("T-withdraw: grant=false + text_version!=null => 422 (manuel kural)", (()=>{ const grant=false; const tvid=optUuidOrNull("11111111-1111-1111-1111-111111111111","t"); const e=throws(()=>{ if(!grant&&tvid!==null) throw new HttpErr(422,"withdraw_text_version_must_be_null"); }); return e&&e.code===422; })());

grp("(A) BİRİM · hata-kod eşleme (maskeli 409/422/403)");
ok("T07 no_active_controller => 409 (marketing grant metni yok)", mapErr("consent_set_pref_center:no_active_controller").code===409);
ok("T11 idempotency_conflict => 409 (farklı payload aynı idem)", mapErr("service_pref_set:idempotency_conflict").code===409);
ok("T-mask analytics_managed_by_cookie_flow => 422", mapErr("consent_set_pref_center:analytics_managed_by_cookie_flow").code===422);
ok("T-mask forbidden => 403", mapErr("admin_q:forbidden").code===403);
ok("T-mask bilinmeyen => internal_error/400", (()=>{ const m=mapErr("pg: some raw detail 0xdeadbeef"); return m.hit==="internal_error"&&m.code===400; })());

/* ---------- (B) STATİK SÖZLEŞME (gerçek dosyalar) ---------- */
const emailApi = read("CDP3B/edge/email-api/index.ts");
const adminApi = read("CDP3B/edge/admin-api/index.ts");
const adminHtml = read("CDP3B/admin.html");
const ams = read("amsterdam/index.html");
const cph = read("kopenhag/index.html");
const cookie = read("CDP3C_package/edge_admin/web/cookie_consent.js");
const up = read("CDP3C_package/CDP3C_up.sql");

grp("(B) STATİK · email-api");
ok("T01d serve girişinde origin-403 gate auth'tan ÖNCE", (()=>{ const gate=emailApi.indexOf('forbidden_origin'); const auth=emailApi.indexOf('getUser'); return gate>0&&auth>0&&gate<auth; })());
ok("T03 geçersiz JWT => 401 (not_authenticated)", /not_authenticated/.test(emailApi) && /getUser/.test(emailApi));
ok("T04a consent action'ları userClient ile (svc değil)", /rpc\(userClient,\s*"consent_get_my_state"/.test(emailApi) && /rpc\(userClient,\s*"consent_set_pref_center"/.test(emailApi) && /rpc\(userClient,\s*"service_pref_set"/.test(emailApi));
ok("T04b consent write'ları request_id+idem WRITE kapısında", /const WRITE = \[[^\]]*"consent_set"[^\]]*"service_pref_set"/.test(emailApi));
ok("T08 CDP-3B 17 action korunuyor", ["taxonomy","list","get","data_health","reconcile","gc_candidates","asset_preview","create","new_version","duplicate","archive","validate","save","asset_upload","publish","import_host_images","asset_gc"].every(a=>emailApi.includes('case "'+a+'"')));
ok("T-deps pin korunuyor", emailApi.includes("std@0.224.0")&&emailApi.includes("supabase-js@2.45.4")&&emailApi.includes("deno_dom@v0.1.45"));
ok("T-CORS credentials KASITLI yok (belge + header yok)", /Access-Control-Allow-Credentials KASITLI/.test(emailApi) && !/["']Access-Control-Allow-Credentials["']\s*:/.test(emailApi));
ok("T15a ham body console.log'a yazılmıyor (yalnız action+e)", !/console\.(log|error)\([^)]*body/.test(emailApi));

grp("(B) STATİK · admin-api (admin opt-in VEREMEZ)");
ok("T05a consent action'ları READ (WRITE_ACTIONS'ta DEĞİL)", (()=>{ const wa=adminApi.match(/const WRITE_ACTIONS = new Set\(\[([^\]]*)\]/)[1]; return !wa.includes("q_member_consent") && !wa.includes("marketing_readiness_check"); })());
ok("T05b admin tarafında consent YAZMA RPC'si yok", !/admin.*consent.*set|consent_set|service_pref_set/.test(adminApi));
ok("T05c q_member_consent + readiness dispatch mevcut", /rpc\("admin_q_member_consent"/.test(adminApi) && /rpc\("marketing_readiness_check"/.test(adminApi));
ok("T03b admin-api geçersiz token => 401", /invalid_token/.test(adminApi));
// Not: idempotency_key v13 CDP-2B write action'larının meşru istek parametresidir (consent yanıt sızıntısı değil).
// Sızıntı riski olan alanlar: contact_hmac / fingerprint / evidence — KOD'da (yorumlar hariç) HİÇ geçmemeli.
const adminApiCode = adminApi.split("\n").map(l=>l.replace(/\/\/.*$/,"")).join("\n"); // // yorumları çıkar
ok("T15b admin-api KODUNDA ham hmac/fingerprint/evidence yok", !/contact_hmac|fingerprint|evidence/i.test(adminApiCode));

grp("(B) STATİK · admin.html (regresyon + salt-okunur)");
ok("T05d admin.html'de consent YAZMA action string'i yok", !/consent_set|service_pref_set/.test(adminHtml));
ok("T05e renderConsent salt-okunur (q_member_consent + readiness)", /q_member_consent/.test(adminHtml) && /marketing_readiness_check/.test(adminHtml));
ok("T08b renderEmail (CDP-3B editör) hâlâ var", /function renderEmail\(/.test(adminHtml));

grp("(B) STATİK · üye Tercih Merkezi (yalnız servis; marketing gizli)");
for(const [nm,src] of [["amsterdam",ams],["kopenhag",cph]]){
  ok("T06d "+nm+": marketing UI tamamen YOK (auto-open/capability iddiası yok)", !/marketing_available/.test(src) && !/asaMktBlock|marketingBlock/.test(src));
  ok("T09 "+nm+": save sonrası server'dan yeniden okur (optimistic yok)", /loadPrefs\(\);\s*\/\/ sunucu durumunu yeniden oku/.test(src));
  ok("Txx "+nm+": 'Tümünü reddet' kontrolü yok", !/reject-all|Tümünü reddet<\/button>|pc-reject-all/.test(src));
  ok("T14 "+nm+": pref sekmesi yalnız kullanıcı açınca (auto-invoke/popup yok)", /else if\(curSeg==="prefs"\)\{ b.innerHTML=prefsShellHtml\(\); loadPrefs\(\); \}/.test(src) && !/loadPrefs\(\);\s*\/\/\s*auto/.test(src));
  ok("T06e "+nm+": yalnız service_pref_set yazar (consent_set yok)", /db.rpc\("service_pref_set"/.test(src) && !/db.rpc\("consent_set_pref_center"/.test(src));
}

grp("(B) STATİK · çerez modülü (fail-closed)");
// Her loadGatedScripts(ALL_GRANTED) çağrısı bir serverWriteConsent(...).then(function(ok){...}) bloğunun İÇİNDE olmalı.
// Yapısal kanıt: bu deseni say; loadGatedScripts(ALL_GRANTED) çağrı sayısına EŞİT olmalı (hepsi server-write dalında).
ok("T12a loadGatedScripts yalnız server round-trip (write.ok / verify.active) içinde", (()=>{
  const calls=(cookie.match(/loadGatedScripts\(ALL_GRANTED\)/g)||[]).length;
  const g1=(cookie.match(/serverWriteConsent\([\s\S]{0,90}\)\.then\(function\(ok\)\{[\s\S]{0,700}?loadGatedScripts\(ALL_GRANTED\)/g)||[]).length;
  const g2=(cookie.match(/serverVerifyConsent\([\s\S]{0,90}\)\.then\(function\(active\)\{[\s\S]{0,400}?loadGatedScripts\(ALL_GRANTED\)/g)||[]).length;
  return calls>=1 && (g1+g2)===calls;
})());
ok("T12c önbellek granted YENİ consent olayı üretmez (serverVerifyConsent, write değil)", /if\(c.decision==="granted"\)\{[\s\S]{0,260}serverVerifyConsent\(/.test(cookie) && !/if\(c.decision==="granted"\)\{[\s\S]{0,260}serverWriteConsent\(/.test(cookie));
ok("T-cookie aktivasyon blocker'ı olarak işaretli (canlıya-alınabilir değil)", /AKTİVASYON BLOCKER'LARI/.test(cookie) && /WIRE EDİLMEZ ve "hazır\/canlıya alınabilir" RAPORLANMAZ/.test(cookie));
ok("T12b readCache/cacheValid injectScript ÇAĞIRMAZ (doğrudan)", !/cacheValid[\s\S]{0,120}injectScript/.test(cookie));
ok("T13 endpoint yoksa tam pasif (init'te if(!ENDPOINT) return)", /if\(!ENDPOINT\) return;/.test(cookie));
ok("T13b aktif metin yoksa grant toplanmaz (fetchActiveText null => return)", /if\(!activeTextVersion\) return;/.test(cookie));
ok("T-policy kırık link basılmaz", /POLICY_URL \?/.test(cookie));
ok("T-consent-mode default denied", /gtag\('consent', 'default'/.test(cookie) && /analytics_storage:'denied'/.test(cookie));

grp("(B) STATİK · DB sınırları (marketing off, PII/HMAC)");
ok("T06f up.sql: consent_set_pref_center analytics/advertising reddeder", /analytics_managed_by_cookie_flow/.test(up));
ok("T15c suppression yalnız 64-hex HMAC (ham e-posta saklanamaz)", /contact_hmac text not null check \(contact_hmac ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(up));
ok("T15d _contact_hmac client rollerinden revoke", /revoke all on function public\._contact_hmac\(text,int\) from public, anon, authenticated/.test(up));
ok("T-admin_q_member_consent allowlist (evidence/hmac dönmez)", (()=>{ const m=up.match(/function public.admin_q_member_consent[\s\S]*?\$fn\$;/); return m && !/hmac|fingerprint|idempotency|evidence/i.test(m[0]); })());

/* ---------- özet ---------- */
console.log("\n===============================");
console.log("CDP3C_EDGE_TESTS  pass="+pass+"  fail="+fail);
if(fail){ console.log("FAILED: "+fails.join(", ")); console.log("CDP3C_EDGE_TESTS_RESULT=FAIL"); process.exit(1); }
console.log("CDP3C_EDGE_TESTS_RESULT=PASS");
