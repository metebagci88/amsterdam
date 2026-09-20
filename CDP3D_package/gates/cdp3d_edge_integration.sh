#!/usr/bin/env bash
# CDP-3D · Edge HTTP reddetme testleri (gerçek serve, GERÇEK e-posta GÖNDERMEZ).
# Beklenen env: FN_DISPATCH, FN_WEBHOOK, SERVICE_JWT (supabase service_role JWT).
# Serve --env-file yalnız RESEND_WEBHOOK_SECRET set eder; RESEND_API_KEY set ETMEZ ->
# dispatch service_role ile 503 (key yok) doğrulanır; webhook kötü imza ile 401 doğrulanır.
set -uo pipefail
pass=0; fail=0
chk(){ local n="$1" exp="$2" got="$3"; if [ "$got" = "$exp" ]; then echo "PASS $n ($got)"; pass=$((pass+1)); else echo "FAIL $n (beklenen $exp, gelen $got)"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

# dispatch: GET -> 405
chk "dispatch GET->405" 405 "$(code -X GET "$FN_DISPATCH")"
# dispatch: POST auth yok -> 403 (service_role değil)
chk "dispatch no-auth POST->403" 403 "$(code -X POST "$FN_DISPATCH" -H 'content-type: application/json' -d '{}')"
# dispatch: POST anon JWT -> 403
chk "dispatch anon JWT->403" 403 "$(code -X POST "$FN_DISPATCH" -H "authorization: Bearer ${ANON_JWT:-x.y.z}" -H 'content-type: application/json' -d '{}')"
# dispatch: POST service_role JWT ama RESEND_API_KEY yok -> 503
chk "dispatch service_role no-key->503" 503 "$(code -X POST "$FN_DISPATCH" -H "authorization: Bearer $SERVICE_JWT" -H 'content-type: application/json' -d '{"limit":1}')"

# webhook: GET -> 405
chk "webhook GET->405" 405 "$(code -X GET "$FN_WEBHOOK")"
# webhook: POST imzasız -> 401
chk "webhook no-sig POST->401" 401 "$(code -X POST "$FN_WEBHOOK" -H 'content-type: application/json' -d '{"type":"email.delivered","data":{}}')"
# webhook: POST kötü imza -> 401
chk "webhook bad-sig POST->401" 401 "$(code -X POST "$FN_WEBHOOK" -H 'content-type: application/json' -H 'svix-id: x' -H 'svix-timestamp: 9999999999' -H 'svix-signature: v1,AAAA' -d '{"type":"email.delivered","data":{}}')"

echo ""
echo "HTTP RESULT pass=$pass fail=$fail"
[ "$fail" = "0" ] && echo "CDP3D_EDGE_HTTP_SUITE_PASS" || echo "CDP3D_EDGE_HTTP_SUITE_FAIL"
[ "$fail" = "0" ]
