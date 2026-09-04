#!/bin/bash
# MO隐私拦截网 v2.0.5 · 最终全量验证（沙盒隔离，不触碰真实配置）
# 覆盖：风险/信息泄露/端口泄露/拦截/白名单/语义扩展/语义与拦截单键/内置拦截/mcp部署鉴权
set -u
TD=/tmp/mo_final2
DEV=/sdcard/Download/Operit/dev_package/mo_privacy_net_205
P=http://127.0.0.1:8095
rm -rf $TD; mkdir -p $TD
PASS=0; FAIL=0
ok(){ echo "[PASS] $1"; PASS=$((PASS+1)); }
bad(){ echo "[FAIL] $1"; FAIL=$((FAIL+1)); }

# ===== 环境铺底（与原版 e2e 同构） =====
cp $DEV/resources/rules/default_rules.json $TD/rules.json
cat > $TD/routes.json <<'EOF'
{"version":1,"routes":{
 "test-clean":{"target":"http://127.0.0.1:18099/up","enabled":true,"scope":"public"},
 "test-ip":{"target":"http://127.0.0.1:18099/up","enabled":true,"scope":"public"},
 "test-word":{"target":"http://127.0.0.1:18099/up","enabled":true,"scope":"public"}
}}
EOF
echo '{"enabled":true,"blocked_total":0,"blocks_by_route":{}}' > $TD/state.json
echo '{"exempt":[]}' > $TD/exempt.json

# 模拟上游
cat > $TD/mock_upstream.py <<'PYEOF'
#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        ln = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(ln).decode('utf-8', 'replace')
        resp = json.dumps({'upstream': 'ok', 'echo': body}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', 18099), H).serve_forever()
PYEOF
python3 $TD/mock_upstream.py > $TD/mock.log 2>&1 &
MOCK_PID=$!
sleep 1

# 起 v2.0.5 worker
MO_DATA_DIR=$TD nohup node $DEV/resources/worker/proxy.js > $TD/proxy.log 2>&1 &
W_PID=$!
sleep 2
TOKEN=$(node -e "try{const t=require('$TD/admin_token.json');console.log(t.token||'')}catch(e){console.log('')}" 2>/dev/null)
echo "TOKEN_LEN=${#TOKEN}"
H="X-MO-Admin-Token: $TOKEN"

# ===== A. 安全红线 =====
echo '===== A. 安全红线/泄露 ====='
CODE=$(curl -s -o $TD/a1.out -w '%{http_code}' -X POST $P/admin/fs -H 'Content-Type: application/json' -d '{"op":"read","file":"rules.json"}')
[ "$CODE" = "401" ] && ok "A1 无token读admin/fs => 401 (拒绝)" || bad "A1 => $CODE"
CODE=$(curl -s -o $TD/a2.out -w '%{http_code}' -X POST $P/admin/fs -H "$H" -H 'Content-Type: application/json' -d '{"op":"read","file":"rules.json"}')
[ "$CODE" = "200" ] && ok "A2 带token读admin/fs => 200 (面板可用)" || bad "A2 => $CODE"
# 非白名单文件仍被拒
CODE=$(curl -s -o $TD/a2b.out -w '%{http_code}' -X POST $P/admin/fs -H "$H" -H 'Content-Type: application/json' -d '{"op":"read","file":"../../etc/passwd"}')
echo "$(cat $TD/a2b.out)" | grep -q '不在白名单' && ok "A2b 路径穿越/非白名单文件被拒" || bad "A2b => $CODE $(cat $TD/a2b.out)"
RESP=$(curl -s -i -X OPTIONS $P/admin/fs -H 'Origin: http://evil.com' -H 'Access-Control-Request-Method: POST' | tr -d '\r')
echo "$RESP" | grep -qi 'Access-Control-Allow-Origin: \*' && bad "A3 任意Origin仍ACAO:*" || ok "A3 第三方Origin无ACAO授权头"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $P/state)
[ "$CODE" = "200" ] && ok "A4 本机 /state 可读" || bad "A4 => $CODE"

# ===== B. 拦截功能 =====
echo '===== B. 拦截功能 ====='
CODE=$(curl -s -o $TD/b1.out -w '%{http_code}' -X POST $P/proxy/test-clean -H 'Content-Type: application/json' -d '{"text":"阴茎"}')
[ "$CODE" = "403" ] && ok "B1 NSFW拦截 => 403" || bad "B1 => $CODE $(cat $TD/b1.out)"
CODE=$(curl -s -o $TD/b2.out -w '%{http_code}' -X POST $P/proxy/test-ip -H 'Content-Type: application/json' -d '{"text":"服务器地址203.0.113.5"}')
[ "$CODE" = "403" ] && ok "B2 私网IP拦截 => 403" || bad "B2 => $CODE"
CODE=$(curl -s -o $TD/b3.out -w '%{http_code}' -X POST $P/proxy/test-word -H 'Content-Type: application/json' -d '{"text":"联系电话13800138000"}')
[ "$CODE" = "403" ] && ok "B3 手机号敏感拦截 => 403" || bad "B3 => $CODE"
CODE=$(curl -s -o $TD/b4.out -w '%{http_code}' -X POST $P/proxy/test-clean -H 'Content-Type: application/json' -d '{"text":"今天天气不错，去花园散步"}')
[ "$CODE" = "200" ] && ok "B4 干净内容放行 => 200" || bad "B4 => $CODE"

# ===== C. 内置白名单（短语级豁免） =====
echo '===== C. 内置白名单 ====='
CODE=$(curl -s -o $TD/c1.out -w '%{http_code}' -X POST $P/proxy/test-clean -H 'Content-Type: application/json' -d '{"text":"干活"}')
[ "$CODE" = "200" ] && ok "C1 白名单短语(干活)放行 => 200" || bad "C1 => $CODE $(cat $TD/c1.out)"
CODE=$(curl -s -o $TD/c2.out -w '%{http_code}' -X POST $P/proxy/test-clean -H 'Content-Type: application/json' -d '{"text":"我想干你"}')
[ "$CODE" = "403" ] && ok "C2 非白名单语境仍拦截 => 403" || bad "C2 => $CODE"

# ===== D. 语义扩展（全局开关） =====
echo '===== D. 语义扩展 ====='
CODE=$(curl -s -o $TD/d1.out -w '%{http_code}' -X POST $P/admin/semantic -H "$H" -H 'Content-Type: application/json' -d '{"op":"save","config":{"enable":true,"endpoint":"http://127.0.0.1:18099/up","apiKey":"test"}}')
[ "$CODE" = "200" ] && ok "D1 语义配置保存 => 200" || bad "D1 => $CODE $(cat $TD/d1.out)"
grep -q '"enable":true' $TD/semantic.json && ok "D2 语义enable落盘 semantic.json" || bad "D2 语义落盘: $(cat $TD/semantic.json 2>/dev/null)"
CODE=$(curl -s -o $TD/d3.out -w '%{http_code}' -X POST $P/admin/semantic -H "$H" -H 'Content-Type: application/json' -d '{"op":"save","config":{"enable":false,"endpoint":"","apiKey":""}}')
grep -q '"enable":false' $TD/semantic.json && ok "D3 语义单键关闭生效" || bad "D3 => $(cat $TD/semantic.json 2>/dev/null)"

# ===== E. 语义/拦截独立单键 =====
echo '===== E. 语义与拦截单键 ====='
CODE=$(curl -s -o $TD/e1.out -w '%{http_code}' -X POST $P/admin/route -H "$H" -H 'Content-Type: application/json' -d '{"id":"test-clean","enabled":false}')
[ "$CODE" = "200" ] && ok "E1 单路由拦截开关(关) => 200" || bad "E1 => $CODE"
CODE=$(curl -s -o $TD/e2.out -w '%{http_code}' -X POST $P/admin/route-semantic -H "$H" -H 'Content-Type: application/json' -d '{"id":"test-clean","enabled":true}')
[ "$CODE" = "200" ] && ok "E2 单路由语义开关(开) => 200" || bad "E2 => $CODE $(cat $TD/e2.out)"
CODE=$(curl -s -o $TD/e3.out -w '%{http_code}' -X POST $P/admin/route -H "$H" -H 'Content-Type: application/json' -d '{"id":"test-clean","enabled":true}')
[ "$CODE" = "200" ] && ok "E3 路由拦截恢复(开) => 200" || bad "E3 => $CODE"

# ===== F. 部署/回退鉴权层（功能逻辑经 diff 确认未改，此处只验门槛） =====
echo '===== F. mcp部署/退回 鉴权 ====='
CODE=$(curl -s -o $TD/f1.out -w '%{http_code}' -X POST $P/admin/deploy -H 'Content-Type: application/json' -d '{"server":"x"}')
[ "$CODE" = "401" ] && ok "F1 无token deploy被拒 => 401" || bad "F1 => $CODE"
CODE=$(curl -s -o $TD/f2.out -w '%{http_code}' -X POST $P/admin/rollback -H 'Content-Type: application/json' -d '{}')
[ "$CODE" = "401" ] && ok "F2 无token rollback被拒 => 401" || bad "F2 => $CODE"

# ===== G. 端口绑定（worker 存活时核查） =====
echo '===== G. 端口 ====='
LST=$(ss -tlnp 2>/dev/null | grep 8095)
echo "$LST" | grep -q '127.0.0.1:8095' && ok "G1 8095 仅绑定回环" || bad "G1 绑定异常: $LST"
echo "$LST" | grep -q '0.0.0.0:8095' && bad "G2 8095 暴露公网!" || ok "G2 无公网监听"

kill $MOCK_PID $W_PID 2>/dev/null
echo ''
echo "===== 最终结果: PASS=$PASS FAIL=$FAIL ====="