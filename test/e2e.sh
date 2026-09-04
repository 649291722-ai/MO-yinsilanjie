#!/system/bin/sh
# MO隐私拦截网 · 端到端测试
TD=/tmp/mo_test
DEV=/sdcard/Download/Operit/dev_package/mo_privacy_net
P=http://127.0.0.1:8095

rm -rf $TD
mkdir -p $TD
cp $DEV/resources/rules/default_rules.json $TD/rules.json
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
echo '--- T10 header token附加(期望Bearer <服务Token>) ---'
curl -s -m 8 -X POST $P/proxy/test-token-h -d '{"text":"hi"}'
echo
echo '--- T11 状态页 ---'
curl -s -m 8 $P/state
echo
echo '--- T12 代理日志 ---'
cat $TD/proxy.log
kill $(cat $TD/proxy.pid) $(cat $TD/mock.pid) 2>/dev/null
echo '--- E2E DONE ---'