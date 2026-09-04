#!/bin/bash
# MO隐私拦截网 v2.0.5 安全子集端到端测试
# 原则：除 $TD 临时目录外，不触碰任何真实配置（不做 deploy/rollback/route 的真实写操作，
# 仅以无令牌请求验证鉴权防线在写操作前生效）。
TD=/tmp/mo_test205
DEV=/sdcard/Download/Operit/dev_package/mo_privacy_net_205
P=http://127.0.0.1:8095

rm -rf $TD
mkdir -p $TD
cp $DEV/resources/rules/default_rules.json $TD/rules.json 2>/dev/null || echo "note: no default_rules.json copy"
cat > $TD/routes.json <<'EOF'
{"version":1,"routes":{
 "test-clean":{"target":"http://127.0.0.1:18099/up","enabled":true,"scope":"public"},
 "test-token-q":{"target":"http://127.0.0.1:18099/up?token=ABC123","enabled":true,"scope":"public"},
 "test-token-h":{"target":"http://127.0.0.1:18099/up","token":{"type":"header","header":"Authorization","prefix":"Bearer ","value":"SECRETTOKEN"},"enabled":true,"scope":"public"}
}}
EOF
echo '{"enabled":true,"blocked_total":0,"blocks_by_route":{}}' > $TD/state.json
echo '{"exempt":[]}' > $TD/exempt.json

nohup python3 $DEV/test/mock_upstream.py > $TD/mock.log 2>&1 &
echo $! > $TD/mock.pid
sleep 1
MO_DATA_DIR=$TD nohup node $DEV/resources/worker/proxy.js > $TD/proxy.log 2>&1 &
echo $! > $TD/proxy.pid
sleep 1

TOK=$(python3 -c "import json;print(json.load(open('$TD/admin_token.json'))['token'])" 2>/dev/null)
echo "TOKEN_LEN=${#TOK}"

echo '=== A. 基础代理/拦截（原12项） ==='
echo '--- T1 干净内容放行(期望200) ---'
curl -s -m 8 -o /dev/null -w 'HTTP %{http_code}\n' -X POST $P/proxy/test-clean -d '{"text":"今天天气不错，去花园散步"}'
echo '--- T2 NSFW拦截(期望403) ---'
curl -s -m 8 -X POST $P/proxy/test-clean -d '{"text":"阴茎"}'
echo
echo '--- T3 IP拦截(期望403) ---'
curl -s -m 8 -X POST $P/proxy/test-clean -d '{"text":"服务器地址203.0.113.5"}'
echo
echo '--- T4 手机号拦截(期望403) ---'
curl -s -m 8 -X POST $P/proxy/test-clean -d '{"text":"联系电话13800138000"}'
echo
echo '--- T5 /check 放行与拦截 ---'
curl -s -m 8 -X POST $P/check -d '{"text":"hello world","scope":"public"}'
echo
curl -s -m 8 -X POST $P/check -d '{"text":"sk-abcdefghijklmnop123456"}'
echo
echo '--- T6 豁免直连(期望200) ---'
echo '{"exempt":["127.0.0.1"]}' > $TD/exempt.json
curl -s -m 8 -o /dev/null -w 'HTTP %{http_code}\n' -X POST $P/proxy/test-clean -d '{"text":"阴茎"}'
echo '{"exempt":[]}' > $TD/exempt.json
echo '--- T7 总开关关闭纯转发(期望200) ---'
echo '{"enabled":false}' > $TD/state.json
curl -s -m 8 -o /dev/null -w 'HTTP %{http_code}\n' -X POST $P/proxy/test-clean -d '{"text":"阴茎"}'
echo '{"enabled":true}' > $TD/state.json
echo '--- T8 未知路由(期望404) ---'
curl -s -m 8 -X POST $P/proxy/nope -d '{}'
echo
echo '--- T9 query token透传(期望ABC123) ---'
curl -s -m 8 -X POST $P/proxy/test-token-q -d '{"text":"hi"}'
echo
echo '--- T10 header token附加(期望Bearer SECRETTOKEN) ---'
curl -s -m 8 -X POST $P/proxy/test-token-h -d '{"text":"hi"}'
echo
echo '--- T11 状态页(脱敏，无token字段) ---'
curl -s -m 8 $P/state
echo

echo '=== B. 安全整改验证（v2.0.5新增） ==='
echo '--- T13 /admin/fs read 无token(期望401) ---'
curl -s -m 8 -X POST $P/admin/fs -d '{"op":"read","file":"routes.json"}'
echo
echo '--- T14 /admin/fs read 带token(期望200) ---'
curl -s -m 8 -X POST $P/admin/fs -H "X-MO-Admin-Token: $TOK" -d '{"op":"read","file":"routes.json"}' | head -c 120
echo
echo '--- T15 /admin/fs write 无token(期望401) ---'
curl -s -m 8 -X POST $P/admin/fs -d '{"op":"write","file":"custom_rules.json","content":"{}"}'
echo
echo '--- T16 /admin/fs write 带token(期望200) ---'
curl -s -m 8 -X POST $P/admin/fs -H "X-MO-Admin-Token: $TOK" -d '{"op":"write","file":"custom_rules.json","content":"{\"ban_words\":[]}"}'
echo
echo '--- T17 /admin/semantic save 无token(期望401) ---'
curl -s -m 8 -X POST $P/admin/semantic -d '{"op":"save","config":{"endpoint":"https://api.example.com"}}'
echo
echo '--- T18 /admin/semantic save 带token+HTTPS(期望OK) ---'
curl -s -m 8 -X POST $P/admin/semantic -H "X-MO-Admin-Token: $TOK" -d '{"op":"save","config":{"endpoint":"https://api.example.com","enable":false}}'
echo
echo '--- T18b /admin/semantic save 带token+http非回环(期望拒绝) ---'
curl -s -m 8 -X POST $P/admin/semantic -H "X-MO-Admin-Token: $TOK" -d '{"op":"save","config":{"endpoint":"http://api.example.com"}}'
echo
echo '--- T18c /admin/semantic save 带token+http本地回环(期望OK) ---'
curl -s -m 8 -X POST $P/admin/semantic -H "X-MO-Admin-Token: $TOK" -d '{"op":"save","config":{"endpoint":"http://127.0.0.1:18099/up","enable":false}}'
echo
echo '--- T19a /admin/custom-route add 无token(期望401) ---'
curl -s -m 8 -X POST $P/admin/custom-route -d '{"op":"add","name":"web","target":"https://x.com"}'
echo
echo '--- T19b /admin/custom-route add 带token+HTTP非回环(期望拒绝) ---'
curl -s -m 8 -X POST $P/admin/custom-route -H "X-MO-Admin-Token: $TOK" -d '{"op":"add","name":"web","target":"http://x.com"}'
echo
echo '--- T19c /admin/custom-route add 带token+HTTPS(期望OK) ---'
curl -s -m 8 -X POST $P/admin/custom-route -H "X-MO-Admin-Token: $TOK" -d '{"op":"add","name":"web","target":"https://x.com"}'
echo
echo '--- T19d /admin/custom-route list(期望看到web) ---'
curl -s -m 8 -X POST $P/admin/custom-route -H "X-MO-Admin-Token: $TOK" -d '{"op":"list"}'
echo
echo '--- T20a CORS: Origin=http://evil.com(期望无ACAO头) ---'
curl -s -m 8 -D - -o /dev/null -X POST $P/admin/fs -H 'Origin: http://evil.com' -H "X-MO-Admin-Token: $TOK" -d '{"op":"read","file":"state.json"}' | grep -i 'access-control' || echo '(无任何CORS头=正确)'
echo '--- T20b CORS: Origin=http://localhost(期望有ACAO=http://localhost) ---'
curl -s -m 8 -D - -o /dev/null -X POST $P/admin/fs -H 'Origin: http://localhost' -H "X-MO-Admin-Token: $TOK" -d '{"op":"read","file":"state.json"}' | grep -i 'access-control'
echo '--- T20c CORS: Origin=file://(期望有ACAO=file://) ---'
curl -s -m 8 -D - -o /dev/null -X POST $P/admin/fs -H 'Origin: file://' -H "X-MO-Admin-Token: $TOK" -d '{"op":"read","file":"state.json"}' | grep -i 'access-control'
echo '--- T21 /state 无token(期望200脱敏) ---'
curl -s -m 8 $P/state
echo
echo '--- T22 面板路径: body._token方式 /admin/fs read(期望200) ---'
curl -s -m 8 -X POST $P/admin/fs -d "{\"op\":\"read\",\"file\":\"state.json\",\"_token\":\"$TOK\"}" | head -c 120
echo
echo '--- T23 /admin/deploy 无token(期望401，鉴权先于写操作) ---'
curl -s -m 8 -X POST $P/admin/deploy -d '{}'
echo
echo '--- T24 /admin/rollback 无token(期望401) ---'
curl -s -m 8 -X POST $P/admin/rollback -d '{}'
echo
echo '--- T25 /admin/route 无token(期望401) ---'
curl -s -m 8 -X POST $P/admin/route -d '{"id":"x","enabled":true}'
echo
echo '--- T26 /admin/custom-route remove 带token(清理) ---'
CID=$(curl -s -m 8 -X POST $P/admin/custom-route -H "X-MO-Admin-Token: $TOK" -d '{"op":"list"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(list(d.get('routes',{}).keys())[0] if d.get('routes') else '')" 2>/dev/null)
if [ -n "$CID" ]; then curl -s -m 8 -X POST $P/admin/custom-route -H "X-MO-Admin-Token: $TOK" -d "{\"op\":\"remove\",\"id\":\"$CID\"}"; echo; fi

echo '=== 收尾: 清理测试进程 ==='
kill $(cat $TD/proxy.pid) $(cat $TD/mock.pid) 2>/dev/null
echo '--- 代理日志(尾部) ---'
tail -5 $TD/proxy.log
echo '--- E2E v2.0.5 DONE ---'
