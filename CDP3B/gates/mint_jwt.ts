// Yerel/geçici Supabase için HS256 test JWT üretir (yalnız CI/local; production'da KULLANILMAZ).
// deno run gates/mint_jwt.ts <sub-uuid> <jwt-secret>
import { encodeBase64Url } from "https://deno.land/std@0.224.0/encoding/base64url.ts";
const [sub, secret] = Deno.args;
if (!sub || !secret) { console.error("usage: mint_jwt.ts <sub> <secret>"); Deno.exit(2); }
const now = Math.floor(Date.now()/1000);
const enc = (o: unknown) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(o)));
const data = `${enc({alg:"HS256",typ:"JWT"})}.${enc({sub, role:"authenticated", aud:"authenticated", iat:now, exp:now+3600})}`;
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
console.log(`${data}.${encodeBase64Url(sig)}`);
