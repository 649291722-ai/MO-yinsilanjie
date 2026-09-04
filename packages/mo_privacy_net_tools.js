/*
METADATA
{
    "name": "mo_privacy_net",
    "display_name": {
        "zh": "MO隐私拦截网💬",
        "en": "MO Privacy Net"
    },
    "description": "通用本地隐私拦截网管理工具：查看代理状态、开启/关闭拦截、部署/回退 MCP 路由、开关单条路由、查看拦截日志、增删拦截关键词、公共发言闸门（publish，三次拦截即拒发）、内容自检。代理监听 127.0.0.1:8095，在网络层机械拦截发往公共平台的敏感内容。纯被动：不扫描平台、不轮询、不重试轰炸。",
    "author": ["MO"],
    "category": "Security",
    "tools": [
        {
            "name": "status",
            "description": "查询拦截网状态：拦截开关、代理进程存活、端口健康、路由表、拦截计数、MCP 配置部署状态。返回内容已脱敏（不含任何 token）。",
            "parameters": []
        },
        {
            "name": "set_enabled",
            "description": "总开关：enabled=true 拦截生效；enabled=false 代理转为纯转发，所有平台照常使用，仅跳过内容检查。不修改任何 MCP 配置，热生效。",
            "parameters": [
                { "name": "enabled", "description": "true 开启拦截，false 关闭拦截（纯转发）", "type": "boolean", "required": true }
            ]
        },
        {
            "name": "start",
            "description": "启动本地代理进程（常驻 127.0.0.1:8095）。若尚未部署路由会返回提示。",
            "parameters": []
        },
        {
            "name": "register",
            "description": "登记路由（作用域建立）：扫描本机已安装 MCP 并把指定（或全部）远程 endpoint 条目写入本插件路由表（routes.json，bridge_deploy=true，默认关闭），绝不修改 mcp_config.json。deploy/rollback/route 仅作用于已登记集合。参数 ids 可选（路由ID数组）。",
            "parameters": [
                {"name": "ids", "type": "array", "required": false, "description": "要登记的路由ID列表；省略则登记全部本机 MCP" }
            ]
        },
        {
            "name": "deploy",
            "description": "一键部署：仅接管本插件登记集合（routes.json 中 bridge_deploy=true 的条目），生成本地 stdio 桥并把登记路由指向本地代理，开启拦截开关。未登记条目绝不触碰。若登记集合为空会提示先执行 register。",
            "parameters": []
        },
        {
            "name": "rollback",
            "description": "一键回退：把全部已部署 MCP 清除干净——MCP 配置恢复官方直连、路由表清空、拦截开关关闭（不再是部署状态），除非重新部署。所有平台无感恢复。",
            "parameters": []
        },
        {
            "name": "toggle_route",
            "description": "开关单条平台：开 = 该平台接入拦截网检查；关 = 该平台退回官方直连（路由保留，可再开）。热生效。",
            "parameters": [
                { "name": "route_id", "description": "路由 ID", "type": "string", "required": true },
                { "name": "enabled", "description": "true 开启（接入拦截网），false 关闭（退回官方直连）", "type": "boolean", "required": true }
            ]
        },
        {
            "name": "list_custom_ports",
            "description": "查看自定义端口（平台接桥）列表：名称、目标地址、接入状态、语义扩展开关。",
            "parameters": []
        },
        {
            "name": "add_custom_port",
            "description": "登记一个自定义端口（平台接桥）：输入名称与目标地址（必须 https:// 开头；本地回环 http://127.0.0.1 / localhost 例外），默认关闭。纳入本地代理的 /proxy/custom-<id> 通用转发，可单独开关、随一键部署/回退。",
            "parameters": [
                { "name": "name", "description": "端口名称（如 小红书接桥）", "type": "string", "required": true },
                { "name": "target", "description": "目标地址，http(s)://开头（平台的 API/网页入口）", "type": "string", "required": true }
            ]
        },
        {
            "name": "remove_custom_port",
            "description": "删除一个自定义端口登记。",
            "parameters": [
                { "name": "port_id", "description": "端口 ID（list_custom_ports 可查）", "type": "string", "required": true }
            ]
        },
        {
            "name": "toggle_custom_port",
            "description": "开关自定义端口：开 = 接入拦截网检查（机械+路由语义）；关 = 退回直连（登记保留）。热生效。",
            "parameters": [
                { "name": "port_id", "description": "端口 ID", "type": "string", "required": true },
                { "name": "enabled", "description": "true 接入，false 退回", "type": "boolean", "required": true }
            ]
        },
        {
            "name": "get_semantic",
            "description": "查看语义 API 兜底审查配置（启用状态、接口地址、模型、超时、上次测试结果）。仅展示本地配置，不发任何外部请求。",
            "parameters": []
        },
        {
            "name": "set_semantic",
            "description": "保存语义 API 兜底审查配置：本地词表未命中时调用该接口兜底判断。fail-closed：接口未配置/未启用时不生效；一旦启用，超时/报错/响应异常一律按「无法确认安全」拦截，绝不因接口故障放行。",
            "parameters": [
                { "name": "enable", "description": "是否启用语义兜底", "type": "boolean", "required": true },
                { "name": "endpoint", "description": "OpenAI 兼容接口地址（…/v1/chat/completions）", "type": "string", "required": false },
                { "name": "api_key", "description": "API Key（可留空）", "type": "string", "required": false },
                { "name": "model", "description": "模型名，如 gpt-4o-mini", "type": "string", "required": false },
                { "name": "timeout_ms", "description": "超时毫秒，默认 15000（为中转站留足响应时间）", "type": "number", "required": false }
            ]
        },
        {
            "name": "test_semantic",
            "description": "测试语义接口连通性：用内置样例文本走一遍接口，返回判定结果与耗时。结果写入配置的 last_test。",
            "parameters": []
        },
        {
            "name": "check",
            "description": "内容自检：把一段文本交给拦截引擎，返回是否放行及命中规则详情（含命中片段）。scope 默认 public。",
            "parameters": [
                { "name": "text", "description": "要检查的文本", "type": "string", "required": true },
                { "name": "scope", "description": "public（公开出口）或 internal（部署链路），默认 public", "type": "string", "required": false }
            ]
        },
        {
            "name": "blocked_log",
            "description": "查看拦截日志（最近 N 条，默认 20）：包含时间、路由、命中规则、命中片段与原文截断。可回溯具体拦截内容。",
            "parameters": [
                { "name": "limit", "description": "返回条数，默认 20，最大 100", "type": "number", "required": false }
            ]
        },
        {
            "name": "self_check",
            "description": "运行自检：worker 文件、规则库、路由表、端口健康。",
            "parameters": []
        },
        {
            "name": "list_rules",
            "description": "查看全部拦截规则：内置硬规则、配对规则（敏感词+值）、用户自定义关键词。",
            "parameters": []
        },
        {
            "name": "add_keyword",
            "description": "增加用户自定义拦截关键词（无条件拦截，含子串即拦）。写入 custom_rules.json，代理热读即时生效。",
            "parameters": [
                { "name": "keyword", "description": "要拦截的关键词", "type": "string", "required": true }
            ]
        },
        {
            "name": "remove_keyword",
            "description": "删除用户自定义拦截关键词。",
            "parameters": [
                { "name": "keyword", "description": "要移除的关键词", "type": "string", "required": true }
            ]
        },
        {
            "name": "publish",
            "description": "公共发言闸门：发言前把内容交给拦截引擎自检。被拦时返回「检测出私密信息，已拦截内容返回」及命中详情，不发送；同一平台连续三次被拦直接拒绝发出并重置计数。放行时返回可发送。不会真正调用任何平台，只做本机判断。",
            "parameters": [
                { "name": "text", "description": "要发布到公共平台的文本", "type": "string", "required": true },
                { "name": "platform", "description": "目标平台标识（如 garden/aisay/crotown），用于三次计数", "type": "string", "required": true }
            ]
        },
        {
            "name": "add_whitelist",
            "description": "增加白名单短语：检测时该「完整短语」被豁免（如「干活」「看着干活」）。短语级匹配，只豁免连用场景；孤立出现的单字（如白名单外语境里的「干」）不受影响。写入 custom_rules.json，代理热读即时生效。",
            "parameters": [
                { "name": "phrase", "description": "要豁免的完整短语（至少两个字符）", "type": "string", "required": true }
            ]
        },
        {
            "name": "remove_whitelist",
            "description": "删除白名单短语。",
            "parameters": [
                { "name": "phrase", "description": "要移除的短语", "type": "string", "required": true }
            ]
        },
        {
            "name": "list_whitelist",
            "description": "查看当前白名单短语列表。",
            "parameters": []
        }
    ]
}
*/

var RUNTIME_DIR = (typeof __dirname !== "undefined") ? (String(__dirname).replace(/[\\/]packages[\\/]?$/, "") + "/") : "/sdcard/Download/Operit/plugins/mo_privacy_net/";
var PKG_SCRIPTS_DIR = RUNTIME_DIR + "scripts/";
var WORKER_JS = RUNTIME_DIR + "worker/proxy.js";
var DEPLOY_PY = PKG_SCRIPTS_DIR + "deploy.py";
var ROLLBACK_PY = PKG_SCRIPTS_DIR + "rollback.py";
var ROUTES_JSON = RUNTIME_DIR + "routes.json";
var STATE_JSON = RUNTIME_DIR + "state.json";
var LOG_JSON = RUNTIME_DIR + "blocked_log.json";
var RULES_JSON = RUNTIME_DIR + "rules.json";
var CUSTOM_RULES_JSON = RUNTIME_DIR + "custom_rules.json";
var RETRY_JSON = RUNTIME_DIR + "retry.json";
var MCP_CONFIG = "/sdcard/Download/Operit/mcp_plugins/mcp_config.json";
var PROXY_HOST = "127.0.0.1";
var PROXY_PORT = 8095;
var PROXY_PREFIX = "http://127.0.0.1:8095/proxy/";
var MAX_PUBLISH_ATTEMPTS = 3;

async function readFileText(path) {
    try {
        var raw = await Tools.Files.read(path);
        var content = "";
        if (typeof raw === "string") content = raw;
        else if (raw && typeof raw.content === "string") content = raw.content;
        else if (raw && raw.data && typeof raw.data.content === "string") content = raw.data.content;
        if (content && content.trim().indexOf("[") === 0) {
            try {
                var arr = JSON.parse(content);
                if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "string") content = arr[0];
            } catch (e) {}
        }
        return content;
    } catch (e) {
        return "";
    }
}
async function writeFileText(path, text) {
    try {
        await Tools.Files.write(path, text);
        return true;
    } catch (e) {
        return false;
    }
}
async function readJson(path) {
    var t = await readFileText(path);
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
}
async function writeJson(path, obj) {
    await writeFileText(path, JSON.stringify(obj, null, 2));
}
// v2.0.7：会话令牌优先（/auth/session，零 Shizuku）；文件读取仅作回退
var SESSION_CACHE = "";
var SESSION_EXPIRES = 0;
async function readSessionToken() {
    var now = Date.now();
    if (SESSION_CACHE && SESSION_EXPIRES > now + 60000) return SESSION_CACHE;
    try {
        if (typeof fetch === "function") {
            var r = await fetch("http://" + PROXY_HOST + ":" + PROXY_PORT + "/auth/session", { method: "POST" });
            var j = JSON.parse(await r.text() || "{}");
            if (j && j.ok && j.token) {
                SESSION_CACHE = j.token;
                SESSION_EXPIRES = now + (j.ttl || 1800000);
                return SESSION_CACHE;
            }
        }
    } catch (e) {}
    try {
        var t = await readFileText(RUNTIME_DIR + "admin_token.json");
        if (!t) return "";
        var j = JSON.parse(t);
        return (j && typeof j.token === "string") ? j.token : "";
    } catch (e) { return ""; }
}
async function readAdminToken() { return await readSessionToken(); }
function httpRequest(method, path, bodyObj) {
    var url = "http://" + PROXY_HOST + ":" + PROXY_PORT + path;
    var payload = bodyObj ? JSON.stringify(bodyObj) : "";
    // v2.0.7：原生 fetch 优先（零 Shizuku）；宿主无 fetch 时回退 Tools.Net
    if (typeof fetch === "function") {
        return (async function () {
            try {
                var headers = { "Content-Type": "application/json" };
                if (method !== "GET") {
                    var tok = await readSessionToken();
                    if (tok) headers["X-MO-Admin-Token"] = tok;
                }
                var r = await fetch(url, {
                    method: method,
                    headers: headers,
                    body: (method === "GET") ? undefined : (bodyObj ? JSON.stringify(bodyObj) : "{}")
                });
                var text = await r.text();
                return { ok: r.status >= 200 && r.status < 400, status: r.status, text: text };
            } catch (e) {
                return { ok: false, status: 0, text: String(e && e.message || e) };
            }
        })();
    }
    return new Promise(function (resolve) {
        var p;
        try {
            if (method === "GET") {
                p = Promise.resolve(Tools.Net.httpGet(url));
            } else {
                p = readAdminToken().then(function (tok) {
                    var body = bodyObj ? JSON.parse(JSON.stringify(bodyObj)) : {};
                    if (tok) body._token = tok;
                    return Tools.Net.httpPost(url, JSON.stringify(body));
                });
            }
        } catch (e) {
            resolve({ ok: false, status: 0, text: String(e && e.message || e) });
            return;
        }
        p.then(function (res) {
            var status = 200;
            var text = "";
            if (typeof res === "string") {
                text = res;
            } else if (res && typeof res === "object") {
                status = res.status || res.code || res.statusCode || 200;
                if (typeof res.body === "string") text = res.body;
                else if (typeof res.text === "string") text = res.text;
                else if (typeof res.content === "string") text = res.content;
                else if (typeof res.data === "string") text = res.data;
                else if (res.body !== undefined && res.body !== null) text = JSON.stringify(res.body);
                else if (res.data !== undefined && res.data !== null) text = JSON.stringify(res.data);
                else if (res.content !== undefined && res.content !== null) text = JSON.stringify(res.content);
                else text = JSON.stringify(res);
            } else if (res !== undefined && res !== null) {
                text = String(res);
            }
            var ok = status >= 200 && status < 400;
            resolve({ ok: ok, status: status, text: text });
        }, function (e) {
            resolve({ ok: false, status: 0, text: String(e && e.message || e) });
        });
    });
}
function execShell(cmd) {
    var candidates = [];
    if (typeof Tools !== "undefined") {
        if (Tools.System && Tools.System.terminal && typeof Tools.System.terminal.exec === "function") {
            candidates.push(function () { return Tools.System.terminal.exec(cmd); });
        }
        if (Tools.System && typeof Tools.System.exec === "function") {
            candidates.push(function () { return Tools.System.exec(cmd); });
        }
        // 注意：不探测 Tools.System.shell（Shizuku 通道）。拦截网本身零权限，
        // 启动 worker 的职责不依赖任何底层权限，宁可失败也不走 Shizuku。
        if (Tools.Shell && typeof Tools.Shell.exec === "function") {
            candidates.push(function () { return Tools.Shell.exec(cmd); });
        }
    }
    if (candidates.length === 0) {
        return Promise.resolve({ success: false, output: "no shell capability" });
    }
    var lastErr = "";
    var attempt = function (i) {
        if (i >= candidates.length) {
            return Promise.resolve({ success: false, output: "shell failed: " + lastErr });
        }
        var p;
        try { p = candidates[i](); } catch (e) { lastErr = "" + e; return attempt(i + 1); }
        return Promise.resolve(p).then(function (r) {
            var out = "";
            if (typeof r === "string") out = r;
            else if (r && typeof r.output === "string") out = r.output;
            else if (r && typeof r.stdout === "string") out = r.stdout;
            else if (r && typeof r.result === "string") out = r.result;
            else if (r != null) out = JSON.stringify(r);
            return { success: true, output: out };
        }, function (e) {
            lastErr = "" + (e && e.message ? e.message : e);
            return attempt(i + 1);
        });
    };
    return attempt(0);
}
function sanitizeRoutes(routes) {
    var out = {};
    for (var k in routes) {
        var r = routes[k] || {};
        out[k] = {
            enabled: r.enabled !== false,
            scope: r.scope || "public",
            target: String(r.target || "").split("?")[0]
        };
    }
    return out;
}
async function healthCheck() {
    var r = await httpRequest("GET", "/state", null);
    if (!r.ok) return null;
    try { return JSON.parse(r.text); } catch (e) { return null; }
}
async function status() {
    var routesConf = await readJson(ROUTES_JSON) || { routes: {} };
    var state = await readJson(STATE_JSON) || {};
    var health = await healthCheck();
    var running = !!health;
    var deployed = {};
    var mcpConf = await readJson(MCP_CONFIG) || {};
    var meta = mcpConf.pluginMetadata || {};
    for (var k in meta) {
        var v = meta[k];
        if (!v || typeof v !== "object") continue;
        var ep = v.endpoint || "";
        if (!String(ep).startsWith("http")) continue;
        deployed[k] = String(ep).startsWith(PROXY_PREFIX) ? "proxied" : "direct";
    }
    return {
        success: true,
        data: {
            state: {
                enabled: state.enabled !== false,
                blocked_total: state.blocked_total || 0,
                blocks_by_route: state.blocks_by_route || {}
            },
            running: running,
            health: health,
            routes: sanitizeRoutes(routesConf.routes || {}),
            route_count: Object.keys(routesConf.routes || {}).length,
            deployed: deployed
        }
    };
}
async function set_enabled(params) {
    var enabled = !!params.enabled;
    var state = await readJson(STATE_JSON) || {};
    state.enabled = enabled;
    await writeJson(STATE_JSON, state);
    return { success: true, message: enabled ? "拦截已开启" : "已关闭拦截，代理转为纯转发（平台不受影响）" };
}
async function start() {
    var routes = await readJson(ROUTES_JSON);
    if (!routes || !routes.routes || Object.keys(routes.routes).length === 0) {
        return { success: false, message: "尚未部署路由，请先执行 deploy" };
    }
    var hc = await healthCheck();
    if (hc) {
        return { success: true, message: "代理已在运行" };
    }
    var rr = await execShell("cd " + RUNTIME_DIR + " && nohup node " + WORKER_JS + " >> " + RUNTIME_DIR + "proxy.log 2>&1 & echo STARTED:$!");
    if (rr.success && rr.output.indexOf("STARTED:") >= 0) {
        var pid = rr.output.split("STARTED:")[1].trim().split(/\s+/)[0];
        var state = await readJson(STATE_JSON) || {};
        state.pid = parseInt(pid, 10);
        await writeJson(STATE_JSON, state);
        return { success: true, message: "代理已启动 pid=" + pid };
    }
    return { success: false, message: "启动失败：" + rr.output + "（沙盒内无命令执行环境，worker 请由外部终端拉起；拦截网功能不受此影响）" };
}
async function register(params) {
    params = params || {};
    var body = {};
    if (params && Array.isArray(params.ids)) body.ids = params.ids.map(String);
    var r = await httpRequest("POST", "/admin/register", body);
    if (!r.ok || r.status === 0) {
        return { success: false, message: "代理不可达：请先执行 start（或确认 worker 已运行）再登记" };
    }
    try {
        var j = JSON.parse(r.text);
        if (j && j.ok) {
            return { success: true, message: j.message || ("已登记 " + ((j.added || []).length) + " 个路由"), data: j };
        }
        return { success: false, message: (j && j.message) || "登记失败" };
    } catch (e) {
        return { success: false, message: "代理响应异常：" + String(r.text).slice(0, 200) };
    }
}
async function deploy() {
    var r = await httpRequest("POST", "/admin/deploy", null);
    if (!r.ok || r.status === 0) {
        return { success: false, message: "代理不可达：请先执行 start（或确认 worker 已运行）再部署" };
    }
    try {
        var j = JSON.parse(r.text);
        return { success: !!(j && j.ok), message: (j && j.message) || (j && j.ok ? "部署完成" : "部署失败") };
    } catch (e) {
        return { success: false, message: "代理响应异常：" + r.text.slice(0, 200) };
    }
}
async function rollback() {
    var r = await httpRequest("POST", "/admin/rollback", null);
    if (!r.ok || r.status === 0) {
        return { success: false, message: "代理不可达：请先执行 start（或确认 worker 已运行）再回退" };
    }
    try {
        var j = JSON.parse(r.text);
        return { success: !!(j && j.ok), message: (j && j.message) || (j && j.ok ? "回退完成" : "回退失败") };
    } catch (e) {
        return { success: false, message: "代理响应异常：" + r.text.slice(0, 200) };
    }
}
async function toggle_route(params) {
    var rid = String(params.route_id || "");
    var enabled = !!params.enabled;
    if (!rid) return { success: false, message: "路由ID为空" };
    var r = await httpRequest("POST", "/admin/route", { id: rid, enabled: enabled });
    if (!r.ok || r.status === 0) {
        return { success: false, message: "代理不可达，无法切换" };
    }
    try {
        var j = JSON.parse(r.text);
        return { success: !!(j && j.ok), message: (j && j.message) || "切换失败" };
    } catch (e) {
        return { success: false, message: "代理响应异常" };
    }
}
async function get_semantic() {
    var r = await httpRequest("POST", "/admin/semantic", {});
    if (!r.ok || r.status === 0) return { success: false, message: "代理不可达" };
    try {
        var j = JSON.parse(r.text);
        if (!j || !j.ok) return { success: false, message: (j && j.message) || "读取失败" };
        return { success: true, data: { config: j.config || {} } };
    } catch (e) {
        return { success: false, message: "代理响应异常" };
    }
}
async function set_semantic(params) {
    var cfg = {
        enable: !!params.enable,
        endpoint: String(params.endpoint || "").trim(),
        apiKey: String(params.api_key || "").trim(),
        model: String(params.model || "").trim(),
        timeoutMs: Math.max(1000, Math.min(120000, (parseInt(params.timeout_ms, 10) || 15) * 1000))
    };
    var r = await httpRequest("POST", "/admin/semantic", { op: "save", config: cfg });
    if (!r.ok || r.status === 0) return { success: false, message: "代理不可达" };
    try {
        var j = JSON.parse(r.text);
        if (!j || !j.ok) return { success: false, message: (j && j.message) || "保存失败" };
        return { success: true, message: j.message || "语义配置已保存", data: { config: j.config || cfg } };
    } catch (e) {
        return { success: false, message: "代理响应异常" };
    }
}
async function test_semantic() {
    var r = await httpRequest("POST", "/admin/semantic-test", {});
    if (!r.ok || r.status === 0) return { success: false, message: "代理不可达" };
    try {
        var j = JSON.parse(r.text);
        if (!j || !j.ok) return { success: false, message: (j && j.message) || "测试失败" };
        return { success: true, data: { result: j.result, costMs: j.costMs, hits: j.hits || [], details: j.details || [], err: j.err || null } };
    } catch (e) {
        return { success: false, message: "代理响应异常" };
    }
}
async function check(params) {
    var text = String(params.text || "");
    var scope = params.scope === "internal" ? "internal" : "public";
    var r = await httpRequest("POST", "/check", { text: text, scope: scope });
    if (!r.ok) return { success: false, message: "代理不可达，请先 start/deploy" };
    try {
        var j = JSON.parse(r.text);
        return { success: true, data: j };
    } catch (e) {
        return { success: false, message: "代理响应异常：" + r.text.slice(0, 200) };
    }
}
async function blocked_log(params) {
    var limit = Math.min(100, Math.max(1, parseInt(params && params.limit, 10) || 20));
    var log = await readJson(LOG_JSON) || [];
    var entries = log.slice(-limit).reverse();
    return { success: true, data: { entries: entries, total: log.length } };
}
async function self_check() {
    var out = [];
    out.push("worker: " + ((await readFileText(WORKER_JS)) ? "OK" : "MISSING"));
    out.push("routes: " + ((await readJson(ROUTES_JSON)) ? "OK" : "MISSING"));
    out.push("rules: " + ((await readJson(RULES_JSON)) ? "OK" : "MISSING"));
    out.push("custom_rules: " + ((await readJson(CUSTOM_RULES_JSON)) ? "OK" : "MISSING"));
    var hc = await healthCheck();
    out.push("port8095: " + (hc ? "OK" : "DOWN"));
    return { success: true, data: { checks: out } };
}
async function list_rules() {
    var rules = await readJson(RULES_JSON) || {};
    var custom = await readJson(CUSTOM_RULES_JSON) || {};
    var pub = (rules.scope && rules.scope.public) || {};
    var builtin = (pub.hard_rules || []).map(function (r) {
        return { id: r.id, reason: r.reason || "", pattern: r.pattern || "", editable: false };
    });
    var pair = (rules.pair_rules || []).map(function (r) {
        return { id: r.id, reason: r.reason || "", keywords: r.keywords || [], value_pattern: r.value_pattern || "", editable: false };
    });
    var customWords = (custom.nsfw_words || []).map(function (w) {
        return { word: w, editable: true };
    });
    var whitelist = custom.whitelist_phrases || [];
    return { success: true, data: { builtin_hard_rules: builtin, pair_rules: pair, custom_keywords: customWords, custom_keyword_count: customWords.length, whitelist_phrases: whitelist, whitelist_count: whitelist.length } };
}
async function add_keyword(params) {
    var kw = String(params.keyword || "").trim();
    if (!kw) return { success: false, message: "关键词不能为空" };
    var custom = await readJson(CUSTOM_RULES_JSON) || { version: 2, nsfw_words: [], whitelist_phrases: [] };
    var whitelist = custom.whitelist_phrases || [];
    if (whitelist.indexOf(kw) >= 0) {
        return { success: false, message: "冲突：拦截关键词「" + kw + "」与白名单短语完全相同，未录入。请先删除该白名单短语，或改用其他词。" };
    }
    var words = custom.nsfw_words || [];
    if (words.indexOf(kw) < 0) words.push(kw);
    custom.nsfw_words = words;
    await writeJson(CUSTOM_RULES_JSON, custom);
    return { success: true, message: "已加入拦截关键词：" + kw + "（热生效，无需重启）" };
}
async function remove_keyword(params) {
    var kw = String(params.keyword || "").trim();
    var custom = await readJson(CUSTOM_RULES_JSON) || { version: 1, nsfw_words: [] };
    var words = custom.nsfw_words || [];
    var idx = words.indexOf(kw);
    if (idx < 0) return { success: false, message: "自定义关键词不存在：" + kw };
    words.splice(idx, 1);
    custom.nsfw_words = words;
    await writeJson(CUSTOM_RULES_JSON, custom);
    return { success: true, message: "已移除拦截关键词：" + kw + "（热生效，无需重启）" };
}
async function add_whitelist(params) {
    var ph = String(params.phrase || "").trim();
    if (!ph) return { success: false, message: "短语不能为空" };
    if (ph.length < 2) return { success: false, message: "短语至少两个字符，请填完整词（如「干活」），单字白名单不生效" };
    var custom = await readJson(CUSTOM_RULES_JSON) || { version: 2, nsfw_words: [], whitelist_phrases: [] };
    var words = custom.nsfw_words || [];
    if (words.indexOf(ph) >= 0) {
        return { success: false, message: "冲突：白名单短语「" + ph + "」与拦截关键词完全相同，未录入。请先删除拦截关键词「" + ph + "」，或改用其他短语。" };
    }
    var list = custom.whitelist_phrases || [];
    if (list.indexOf(ph) < 0) list.push(ph);
    custom.whitelist_phrases = list;
    await writeJson(CUSTOM_RULES_JSON, custom);
    return { success: true, message: "已加入白名单短语：" + ph + "（热生效，无需重启）" };
}
async function remove_whitelist(params) {
    var ph = String(params.phrase || "").trim();
    var custom = await readJson(CUSTOM_RULES_JSON) || { version: 2, nsfw_words: [], whitelist_phrases: [] };
    var list = custom.whitelist_phrases || [];
    var idx = list.indexOf(ph);
    if (idx < 0) return { success: false, message: "白名单短语不存在：" + ph };
    list.splice(idx, 1);
    custom.whitelist_phrases = list;
    await writeJson(CUSTOM_RULES_JSON, custom);
    return { success: true, message: "已移除白名单短语：" + ph + "（热生效，无需重启）" };
}
async function list_whitelist() {
    var custom = await readJson(CUSTOM_RULES_JSON) || {};
    return { success: true, data: { whitelist_phrases: custom.whitelist_phrases || [] } };
}
// ===== 自定义端口（平台接桥）=====
var CUSTOM_ROUTES_JSON = RUNTIME_DIR + "custom_routes.json";
async function customPortsReq(op, payload) {
    var r = await httpRequest("POST", "/admin/custom-route", Object.assign({ op: op }, payload || {}));
    if (!r.ok || r.status === 0) {
        return { success: false, message: "代理不可达（如已在测试可先放行）" };
    }
    try {
        var j = JSON.parse(r.text);
        return { success: !!(j && j.ok), data: j, message: (j && j.message) || (j && j.ok ? "完成" : "失败") };
    } catch (e) {
        return { success: false, message: "代理响应异常：" + String(r.text || "").slice(0, 120) };
    }
}
async function list_custom_ports() {
    var res = await customPortsReq("list", {});
    if (!res.success) return res;
    var rt = (res.data && res.data.routes) || {};
    var list = [];
    for (var k in rt) {
        list.push({ id: k, name: rt[k].name, target: rt[k].target, enabled: rt[k].enabled !== false, semantic_enabled: rt[k].semantic_enabled === true });
    }
    return { success: true, data: { ports: list } };
}
async function add_custom_port(params) {
    var name = String(params.name || "").trim();
    var target = String(params.target || "").trim();
    if (!name) return { success: false, message: "请填写端口名称" };
    if (!/^https?:\/\//i.test(target)) return { success: false, message: "目标地址需 http(s):// 开头" };
    return await customPortsReq("add", { name: name, target: target });
}
async function remove_custom_port(params) {
    var rid = String(params.port_id || params.id || "");
    if (!rid) return { success: false, message: "缺少端口 ID" };
    return await customPortsReq("remove", { id: rid });
}
async function toggle_custom_port(params) {
    var rid = String(params.port_id || params.id || "");
    if (!rid) return { success: false, message: "缺少端口 ID" };
    return await customPortsReq("toggle", { id: rid, enabled: params.enabled !== false });
}
async function publish(params) {
    var text = String(params.text || "");
    var platform = String(params.platform || "unknown").trim();
    if (!text) return { success: false, message: "内容不能为空" };
    var state = await readJson(STATE_JSON) || {};
    if (state.enabled === false) {
        return { success: true, message: "拦截已关闭（纯转发模式），直接发送", skipped: true };
    }
    var r = await httpRequest("POST", "/check", { text: text, scope: "public" });
    var j = null;
    try { j = JSON.parse(r.text); } catch (e) {}
    if (!r.ok || !j) {
        return { success: false, message: "代理不可达，出于安全考虑不放行。请先 start，或关闭总开关。", fail_closed: true };
    }
    if (j.allowed) {
        var retryOk = await readJson(RETRY_JSON) || {};
        if (retryOk[platform]) {
            delete retryOk[platform];
            await writeJson(RETRY_JSON, retryOk);
        }
        return { success: true, message: "内容检查通过，可以发送", checked: true };
    }
    var retry = await readJson(RETRY_JSON) || {};
    var entry = retry[platform] || { count: 0 };
    entry.count += 1;
    entry.last_at = Date.now();
    retry[platform] = entry;
    await writeJson(RETRY_JSON, retry);
    if (entry.count >= MAX_PUBLISH_ATTEMPTS) {
        delete retry[platform];
        await writeJson(RETRY_JSON, retry);
        return {
            success: false,
            exhausted: true,
            message: "三次内容修改无果，已拒绝发出。剧情继续，本次内容未发送。",
            hits: j.hits || [],
            details: j.details || [],
            attempts: entry.count
        };
    }
    return {
        success: false,
        message: "检测出私密信息，已拦截内容返回",
        hits: j.hits || [],
        details: j.details || [],
        attempts: entry.count,
        remaining: MAX_PUBLISH_ATTEMPTS - entry.count
    };
}
exports.status = status;
exports.register = register;
exports.set_enabled = set_enabled;
exports.start = start;
exports.deploy = deploy;
exports.rollback = rollback;
exports.toggle_route = toggle_route;
exports.list_custom_ports = list_custom_ports;
exports.add_custom_port = add_custom_port;
exports.remove_custom_port = remove_custom_port;
exports.toggle_custom_port = toggle_custom_port;
exports.get_semantic = get_semantic;
exports.set_semantic = set_semantic;
exports.test_semantic = test_semantic;
exports.check = check;
exports.blocked_log = blocked_log;
exports.self_check = self_check;
exports.list_rules = list_rules;
exports.add_keyword = add_keyword;
exports.remove_keyword = remove_keyword;
exports.publish = publish;
exports.add_whitelist = add_whitelist;
exports.remove_whitelist = remove_whitelist;
exports.list_whitelist = list_whitelist;