// admin-api merged -> pure v13 base türet (yalnız CDP-3C additive'leri çıkar), sonra additive-only kanıtla.
import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("CDP3B/edge/admin-api/index.ts", "utf8");
const before = s;
// 1) additive header comment (6 satır)
s = s.replace(/\/\/ ── CDP-3C ADDITIVE[\s\S]*?rate-limit, kill-switch DEĞİŞMEDEN korunur\.\n/, "");
// 2) ROLE_SETS iki anahtar (kapanış ' };' baz haline döner)
s = s.replace(/, q_member_consent:\["super_admin","support","crm"\], marketing_readiness_check:\["super_admin","support","crm"\] \};/, " };");
// 3) LIMITS iki anahtar
s = s.replace(/, q_member_consent:\{min:60,day:2000\}, marketing_readiness_check:\{min:60,day:2000\} \};/, " };");
// 4) dispatch (yorum + 2 else-if)
s = s.replace(/\n  \/\/ ── CDP-3C SALT-OKUNUR consent[^\n]*\n  else if\(action==="q_member_consent"\)\{[^\n]*\}\n  else if\(action==="marketing_readiness_check"\)\{[^\n]*\}\n/, "\n");
// 5) validate (2 yorum + 2 case)
s = s.replace(/\n \/\/ ── CDP-3C: SALT-OKUNUR consent[^\n]*\n if\(action==="q_member_consent"\)\{[^\n]*\}\n \/\/ ── CDP-3C: pazarlama readiness[^\n]*\n if\(action==="marketing_readiness_check"\)return\{ok:true\};\n/, "\n");
writeFileSync("CDP3C_package/edge_admin/admin-api.v13.base.ts", s);
const hasConsent = /q_member_consent|marketing_readiness_check/.test(s);
console.log("base lines:", s.split("\n").length, "| base still has consent action:", hasConsent, "| changed from merged:", s !== before);
