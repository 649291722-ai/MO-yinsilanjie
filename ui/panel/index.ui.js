function Screen(ctx) {
// ---- 宿主主题色注入（Operit 深浅切换时自动跟随） ----
var THEME_VARS = ":root{--bg:#FFFFFF;--card:#FFFFFF;--card2:#F6F4FF;--border:rgba(147,124,232,.28);--fg:#3C3757;--dim:#8B86A6;}";
var RUNTIME_DIR = "/sdcard/Download/Operit/plugins/mo_privacy_net/";
var STATE_JSON = RUNTIME_DIR + "state.json";
var ROUTES_JSON = RUNTIME_DIR + "routes.json";
var CUSTOM_JSON = RUNTIME_DIR + "custom_rules.json";
var LOG_JSON = RUNTIME_DIR + "blocked_log.json";
var CUSTOM_ROUTES_JSON = RUNTIME_DIR + "custom_routes.json";
var RULES_JSON = RUNTIME_DIR + "rules.json";
var HB_JSON = RUNTIME_DIR + "heartbeat.json";
var DEFAULT_JSON = RUNTIME_DIR + "default_rules.json";
var PROXY_BASE = "http://127.0.0.1:8095";

async function fsBase(path) {
    var p = String(path || "");
    p = p.split("/").pop();
    return p === "" ? "" : p;
}
async function readFileSafe(path) {
    try {
        var file = await fsBase(path);
        if (!file) return "";
        var r = await httpPost("/admin/fs", { op: "read", file: file });
        if (!r.ok) return "";
        var j;
        try { j = JSON.parse(r.text); } catch (e) { return ""; }
        if (!j || !j.ok) return "";
        return j.content || "";
    } catch (e) {
        return "";
    }
}
async function readJson(path) {
    try {
        var t = await readFileSafe(path);
        if (!t) return null;
        return JSON.parse(t);
    } catch (e) { return null; }
}
async function writeJson(path, obj) {
    try {
        var file = await fsBase(path);
        if (!file) return false;
        var r = await httpPost("/admin/fs", { op: "write", file: file, content: JSON.stringify(obj, null, 2) });
        if (!r.ok) return false;
        var j;
        try { j = JSON.parse(r.text); } catch (e) { return false; }
        return !!(j && j.ok);
    } catch (e) {
        return false;
    }
}
function parseHttpRes(res) {
    var status = 200, text = "";
    if (typeof res === "string") {
        text = res;
    } else if (res && typeof res === "object") {
        status = res.status || res.code || res.statusCode || 200;
        if (typeof res.body === "string") text = res.body;
        else if (typeof res.text === "string") text = res.text;
        else if (typeof res.content === "string") text = res.content;
        else if (typeof res.data === "string") text = res.data;
        else if (res.body != null) text = JSON.stringify(res.body);
        else if (res.data != null) text = JSON.stringify(res.data);
        else if (res.content != null) text = JSON.stringify(res.content);
        else text = JSON.stringify(res);
    } else if (res != null) {
        text = String(res);
    }
    return { ok: status >= 200 && status < 400, status: status, text: text };
}
// v2.0.7-fix：UI 宿主无原生 fetch，统一走 ctx.callTool("http_request")（Operit 官方面板 API）
function parseToolResp(resp) {
    if (resp == null) return { ok: false, status: 0, text: "" };
    var text = "", status = 200;
    if (typeof resp === "string") { text = resp; }
    else if (typeof resp === "object") {
        var content = resp.content;
        if (Array.isArray(content)) {
            var parts = [];
            for (var i = 0; i < content.length; i++) {
                var c = content[i];
                if (c && typeof c === "object") parts.push(c.text != null ? String(c.text) : JSON.stringify(c));
                else parts.push(String(c));
            }
            text = parts.join("");
        } else if (typeof content === "string") { text = content; }
        else if (content != null) { text = JSON.stringify(content); }
        else if (resp.body != null) { text = (typeof resp.body === "string") ? resp.body : JSON.stringify(resp.body); }
        else if (resp.text != null) { text = String(resp.text); }
        else if (resp.data != null) { text = (typeof resp.data === "string") ? resp.data : JSON.stringify(resp.data); }
        else { text = JSON.stringify(resp); }
        status = Number(resp.status || resp.statusCode || resp.code || 200);
    } else { text = String(resp); }
    return { ok: status >= 200 && status < 400, status: status, text: text };
}
async function httpRaw(method, path, headers, bodyObj) {
    try {
        var opts = { url: PROXY_BASE + path, method: String(method || "GET").toUpperCase() };
        var hdrs = {};
        for (var kk in (headers || {})) hdrs[kk] = headers[kk];
        if (bodyObj != null) opts.body = JSON.stringify(bodyObj);
        if (Object.keys(hdrs).length > 0) opts.headers = hdrs;
        var resp = await ctx.callTool("http_request", opts);
        return parseToolResp(resp);
    } catch (e) {
        return { ok: false, status: 0, text: "" };
    }
}
// v2.0.7：面板零 Shizuku —— 不再读取本地令牌文件，不再依赖宿主工具桥，
// 状态与读写全部走 WebView 原生 fetch（浏览器网络栈，无需宿主桥）。
var ADMIN_TOKEN_CACHE = "";
var SESSION_EXPIRES = 0;
async function getSessionToken() {
    var now = Date.now();
    if (ADMIN_TOKEN_CACHE && SESSION_EXPIRES > now + 60000) return ADMIN_TOKEN_CACHE;
    try {
        var r = await httpRaw("POST", "/auth/session", { "Content-Type": "application/json" }, {});
        var j;
        try { j = JSON.parse(r.text || "{}"); } catch (e) { return ""; }
        if (j && j.ok && j.token) {
            ADMIN_TOKEN_CACHE = j.token;
            SESSION_EXPIRES = now + (j.ttl || 1800000);
            return ADMIN_TOKEN_CACHE;
        }
    } catch (e) {}
    return "";
}
async function httpPost(path, bodyObj) {
    var body = bodyObj || {};
    var headers = { "Content-Type": "application/json" };
    if (String(path).indexOf("/admin/") === 0) {
        var tok = await getSessionToken();
        if (tok) headers["X-MO-Admin-Token"] = tok;
    }
    try {
        var r = await httpRaw("POST", path, headers, body);
        return r;
    } catch (e) {
        return { ok: false, status: 0, text: "" };
    }
}

var panelController = ctx.createWebViewController("mo_privacy_net_webview");
panelController.addJavascriptInterface("PrivacyNet", {
    getStatus: async function () {
        try {
            var state = await readJson(STATE_JSON) || {};
            var routesConf = await readJson(ROUTES_JSON) || { routes: {} };
            var custom = await readJson(CUSTOM_JSON) || { nsfw_words: [], whitelist_phrases: [] };
            var rulesConf = await readJson(RULES_JSON) || { scope: {} };
            var hb = await readJson(HB_JSON) || { t: 0, pid: 0 };
            var pub = (rulesConf.scope && rulesConf.scope.public) || {};
            var hard = pub.hard_rules || [];
            var builtin = [];
            for (var i = 0; i < hard.length; i++) {
                var r = hard[i] || {};
                var pat = String(r.pattern || "");
                var words = [];
                var m = pat.match(/^\((.+)\)$/);
                if (m && m[1].indexOf("(") < 0 && m[1].indexOf("\\") < 0) {
                    words = m[1].split("|").filter(function (x) { return x; });
                }
                builtin.push({ id: r.id, reason: r.reason || r.id, words: words, raw: pat });
            }
            var pair = [];
            var pairs = rulesConf.pair_rules || [];
            for (var j = 0; j < pairs.length; j++) {
                var pr = pairs[j] || {};
                pair.push({ id: pr.id, reason: pr.reason || pr.id, keywords: pr.keywords || [] });
            }
            var routes = [];
            var rm = routesConf.routes || {};
            for (var k in rm) {
                var rt = rm[k] || {};
                routes.push({ id: k, enabled: rt.enabled !== false, scope: rt.scope || "public" });
            }
            return JSON.stringify({
                success: true,
                data: {
                    enabled: state.enabled !== false,
                    blocked_total: state.blocked_total || 0,
                    hb: { t: hb.t || 0, pid: hb.pid || 0 },
                    routes: routes,
                    builtin: builtin,
                    pair: pair,
                    keywords: custom.nsfw_words || [],
                    whitelist: custom.whitelist_phrases || [],
                    builtin_whitelist: (rulesConf.builtin_whitelist || [])
                }
            });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    setEnabled: async function (flag) {
        try {
            var state = await readJson(STATE_JSON) || {};
            state.enabled = !!flag;
            await writeJson(STATE_JSON, state);
            return JSON.stringify({ success: true, message: flag ? "拦截已开启（worker 下次请求即时生效）" : "已关闭拦截，代理转为纯转发" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    toggleRoute: async function (json) {
        try {
            var p = JSON.parse(json);
            var rid = String(p.id || "");
            if (!rid) return JSON.stringify({ success: false, message: "路由ID为空" });
            var r = await httpPost("/admin/route", { id: rid, enabled: !!p.enabled });
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法切换" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "切换失败" });
            return JSON.stringify({ success: true, message: j.message });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    addKeyword: async function (kw) {
        try {
            kw = String(kw || "").trim();
            if (!kw) return JSON.stringify({ success: false, message: "关键词不能为空" });
            var custom = await readJson(CUSTOM_JSON) || { nsfw_words: [], whitelist_phrases: [] };
            var whitelist = custom.whitelist_phrases || [];
            if (whitelist.indexOf(kw) >= 0) {
                return JSON.stringify({ success: false, conflict: true, message: "冲突：拦截词「" + kw + "」与白名单短语完全相同，未录入。请先删除该白名单短语。" });
            }
            var words = custom.nsfw_words || [];
            if (words.indexOf(kw) < 0) words.push(kw);
            custom.nsfw_words = words;
            await writeJson(CUSTOM_JSON, custom);
            return JSON.stringify({ success: true, message: "已加入拦截词：「" + kw + "」（热生效）" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    removeKeyword: async function (kw) {
        try {
            kw = String(kw || "").trim();
            var removedFrom = [];
            var custom = await readJson(CUSTOM_JSON) || { nsfw_words: [] };
            var words = custom.nsfw_words || [];
            var i = words.indexOf(kw);
            if (i >= 0) {
                words.splice(i, 1);
                custom.nsfw_words = words;
                await writeJson(CUSTOM_JSON, custom);
                removedFrom.push("自定义");
            }
            var rulesConf = await readJson(RULES_JSON) || { scope: {} };
            var pub = (rulesConf.scope && rulesConf.scope.public) || {};
            var hard = pub.hard_rules || [];
            var hit = false;
            for (var j = 0; j < hard.length; j++) {
                var r = hard[j] || {};
                var pat = String(r.pattern || "");
                var m = pat.match(/^\((.+)\)$/);
                if (m && m[1].split("|").indexOf(kw) >= 0) {
                    var rest = m[1].split("|").filter(function (x) { return x && x !== kw; });
                    if (rest.length > 0) {
                        r.pattern = "(" + rest.join("|") + ")";
                    } else {
                        hard.splice(j, 1);
                        j--;
                    }
                    hit = true;
                }
            }
            if (hit) {
                rulesConf.scope.public.hard_rules = hard;
                await writeJson(RULES_JSON, rulesConf);
                removedFrom.push("内置规则");
            }
            if (removedFrom.length) {
                return JSON.stringify({ success: true, message: "已删除「" + kw + "」（" + removedFrom.join(" + ") + "），热生效" });
            }
            return JSON.stringify({ success: false, message: "没找到「" + kw + "」" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    addWhitelist: async function (ph) {
        try {
            ph = String(ph || "").trim();
            if (!ph) return JSON.stringify({ success: false, message: "短语不能为空" });
            var custom = await readJson(CUSTOM_JSON) || { nsfw_words: [], whitelist_phrases: [] };
            var words = custom.nsfw_words || [];
            if (words.indexOf(ph) >= 0) {
                return JSON.stringify({ success: false, conflict: true, message: "冲突：白名单短语「" + ph + "」与拦截词完全相同，未录入。请先删除拦截词「" + ph + "」。" });
            }
            var list = custom.whitelist_phrases || [];
            if (list.indexOf(ph) < 0) list.push(ph);
            custom.whitelist_phrases = list;
            await writeJson(CUSTOM_JSON, custom);
            return JSON.stringify({ success: true, message: "已加入白名单短语：「" + ph + "」（仅豁免连用场景）" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    removeWhitelist: async function (ph) {
        try {
            ph = String(ph || "").trim();
            var custom = await readJson(CUSTOM_JSON) || { whitelist_phrases: [] };
            var list = custom.whitelist_phrases || [];
            var idx = list.indexOf(ph);
            if (idx < 0) return JSON.stringify({ success: false, message: "白名单短语不存在：" + ph });
            list.splice(idx, 1);
            custom.whitelist_phrases = list;
            await writeJson(CUSTOM_JSON, custom);
            return JSON.stringify({ success: true, message: "已移除白名单短语：「" + ph + "」" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    removeBuiltinWhitelist: async function (ph) {
        try {
            ph = String(ph || "").trim();
            if (!ph) return JSON.stringify({ success: false, message: "短语不能为空" });
            var rulesConf = await readJson(RULES_JSON) || { builtin_whitelist: {} };
            var wl = rulesConf.builtin_whitelist || {};
            if (typeof wl !== "object" || Array.isArray(wl)) return JSON.stringify({ success: false, message: "白名单结构异常，请先执行恢复内置" });
            var found = false;
            var keys = (wl.nsfw || wl.common) ? ["nsfw", "common"] : ["cao", "bi", "common"];
            keys.forEach(function (k) {
                var g = wl[k];
                if (!g || !Array.isArray(g.items)) return;
                var idx = g.items.indexOf(ph);
                if (idx >= 0) { g.items.splice(idx, 1); found = true; }
            });
            if (!found) return JSON.stringify({ success: false, message: "内置白名单不存在：" + ph });
            rulesConf.builtin_whitelist = wl;
            var ok = await writeJson(RULES_JSON, rulesConf);
            if (!ok) return JSON.stringify({ success: false, message: "写回 rules.json 失败" });
            return JSON.stringify({ success: true, message: "已删除内置白名单词条：「" + ph + "」（热生效）" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    removeRule: async function (id) {
        try {
            id = String(id || "").trim();
            if (!id) return JSON.stringify({ success: false, message: "规则ID为空" });
            var rulesConf = await readJson(RULES_JSON) || { scope: {} };
            var pub = (rulesConf.scope && rulesConf.scope.public) || {};
            var hard = pub.hard_rules || [];
            var before = hard.length;
            pub.hard_rules = hard.filter(function (r) { return !(r && r.id === id); });
            rulesConf.scope = rulesConf.scope || {};
            rulesConf.scope.public = pub;
            var ok = await writeJson(RULES_JSON, rulesConf);
            if (!ok) return JSON.stringify({ success: false, message: "写回 rules.json 失败" });
            return JSON.stringify({ success: true, message: pub.hard_rules.length < before ? ("已删除整条规则「" + id + "」，热生效") : ("没找到规则「" + id + "」") });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    restoreBuiltin: async function () {
        try {
            var r = await httpPost("/admin/restore", {});
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法恢复" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "代理响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "恢复失败" });
            return JSON.stringify({ success: true, message: j.message });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    restoreWhitelist: async function () {
        try {
            var r = await httpPost("/admin/restore-whitelist", {});
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法恢复" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "代理响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "恢复失败" });
            return JSON.stringify({ success: true, message: j.message });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    removePairKeyword: async function (kw) {
        try {
            kw = String(kw || "").trim();
            var rulesConf = await readJson(RULES_JSON) || { pair_rules: [] };
            var pairs = rulesConf.pair_rules || [];
            var hit = false;
            for (var i = 0; i < pairs.length; i++) {
                var ks = pairs[i].keywords || [];
                var idx = ks.indexOf(kw);
                if (idx >= 0) { ks.splice(idx, 1); pairs[i].keywords = ks; hit = true; }
            }
            if (hit) {
                rulesConf.pair_rules = pairs;
                await writeJson(RULES_JSON, rulesConf);
                return JSON.stringify({ success: true, message: "已从配对规则移除「" + kw + "」" });
            }
            return JSON.stringify({ success: false, message: "配对规则里没有「" + kw + "」" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    getSemantic: async function () {
        try {
            var r = await httpPost("/admin/semantic", { op: "get" });
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法读取语义配置" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "读取失败" });
            return JSON.stringify({ success: true, data: j.config });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    saveSemantic: async function (json) {
        try {
            var cfg = JSON.parse(json);
            var r = await httpPost("/admin/semantic", { op: "save", config: cfg });
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法保存语义配置" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "保存失败" });
            return JSON.stringify({ success: true, message: "语义配置已保存（热生效）", data: j.config });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    testSemantic: async function (json) {
        try {
            var p = json ? JSON.parse(json) : {};
            var r = await httpPost("/admin/semantic-test", p);
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法测试" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "测试失败" });
            return JSON.stringify({ success: true, data: j });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    checkText: async function (text) {
        try {
            text = String(text || "");
            if (!text) return JSON.stringify({ success: false, message: "输入点内容再自检" });
            var rulesConf = await readJson(RULES_JSON) || { scope: {} };
            var custom = await readJson(CUSTOM_JSON) || { nsfw_words: [] };
            var pub = (rulesConf.scope && rulesConf.scope.public) || {};
            var total = (pub.hard_rules || []).length + (custom.nsfw_words || []).length + (rulesConf.pair_rules || []).length;
            if (total === 0) {
                return JSON.stringify({ success: false, empty: true, message: "无设置拦截内容" });
            }
            var r = await httpPost("/check", { text: text, scope: "public" });
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，请点「一键部署」或在对话中让 AI 执行 start" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) {
                return JSON.stringify({ success: false, message: "代理响应异常：" + r.text.slice(0, 120) });
            }
            return JSON.stringify({ success: true, data: j });
        } catch (e) {
            var msg = String(e && e.message || e);
            if (msg.indexOf("Tools.Net unavailable") >= 0) {
                return JSON.stringify({ success: false, message: "面板通道无法直连代理。可复制内容到对话里让 AI 用 mo_privacy_net:check 自检。" });
            }
            return JSON.stringify({ success: false, message: "代理离线：" + msg.slice(0, 60) });
        }
    },
    listCustom: async function () {
        try {
            var cr = await readJson(CUSTOM_ROUTES_JSON) || { routes: {} };
            return JSON.stringify({ success: true, routes: cr.routes || {} });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    saveCustom: async function (json) {
        try {
            var cr = JSON.parse(json);
            await writeJson(CUSTOM_ROUTES_JSON, cr);
            return JSON.stringify({ success: true, message: "已保存" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    toggleRouteSemantic: async function (json) {
        try {
            var p = JSON.parse(json);
            var rc = await readJson(ROUTES_JSON) || { routes: {} };
            var r = (rc.routes || {})[p.id];
            if (!r) return JSON.stringify({ success: false, message: "路由不存在" });
            r.semantic_enabled = !!p.enabled;
            await writeJson(ROUTES_JSON, rc);
            return JSON.stringify({ success: true, message: p.enabled ? "语义扩展已开启（需全局API已配置才生效）" : "语义扩展已关闭" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    ensureWorker: async function () {
        try {
            var hb = await readJson(HB_JSON) || {};
            var alive = hb.t && (Date.now() - hb.t) < 40000;
            if (alive) return JSON.stringify({ success: true, message: "在线" });
            return JSON.stringify({ success: false, message: "代理离线（worker 未运行）" });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    },
    deployRoutes: async function () {
        try {
            // 一键部署 = 先登记（读取本机全部 MCP，幂等）再部署；回退后也能一键恢复
            var reg = await httpPost("/admin/register", {});
            if (!reg.ok) return JSON.stringify({ success: false, message: "代理离线，无法登记" });
            var regJ;
            try { regJ = JSON.parse(reg.text); } catch (e) { regJ = null; }
            var r = await httpPost("/admin/deploy", {});
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法部署" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "代理响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "部署失败" });
            var lines = (j.message || "").split("\n");
            var regMsg = (regJ && regJ.added && regJ.added.length) ? ("；新登记 " + regJ.added.length + " 个路由") : "";
            return JSON.stringify({ success: true, message: "已接管，重启 MCP 服务后生效" + regMsg + (lines.length ? "：" + lines[0].slice(0, 60) : "") });
        } catch (e) {
            var msg = String(e && e.message || e);
            if (msg.indexOf("Tools.Net unavailable") >= 0) return JSON.stringify({ success: false, message: "面板通道无法直连代理。请在对话中让 AI 执行部署。" });
            return JSON.stringify({ success: false, message: msg.slice(0, 60) });
        }
    },
    rollbackRoutes: async function () {
        try {
            var r = await httpPost("/admin/rollback", {});
            if (!r.ok) return JSON.stringify({ success: false, message: "代理离线，无法回退" });
            var j;
            try { j = JSON.parse(r.text); } catch (e) { return JSON.stringify({ success: false, message: "代理响应异常" }); }
            if (!j.ok) return JSON.stringify({ success: false, message: j.message || "回退失败" });
            var lines = (j.message || "").split("\n");
            return JSON.stringify({ success: true, message: "已回退官方直连" + (lines.length ? "：" + lines[0].slice(0, 60) : "") });
        } catch (e) {
            var msg = String(e && e.message || e);
            if (msg.indexOf("Tools.Net unavailable") >= 0) return JSON.stringify({ success: false, message: "面板通道无法直连代理。请在对话中让 AI 执行回退。" });
            return JSON.stringify({ success: false, message: msg.slice(0, 60) });
        }
    },
    getLog: async function (limit) {
        try {
            var n = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
            var log = await readJson(LOG_JSON);
            if (!Array.isArray(log)) log = [];
            var entries = log.slice(-n).reverse();
            return JSON.stringify({ success: true, data: { entries: entries, total: log.length } });
        } catch (e) {
            return JSON.stringify({ success: false, message: String(e && e.message || e) });
        }
    }
});

return ctx.UI.WebView({
    html: "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no\">\n<style>\n" + ":root{color-scheme:dark;--bg:#0e1014;--card:#181b22;--card2:#20242e;--border:#2a2f3b;--fg:#e7eaf0;--dim:#98a0ad;--accent:#b3a3f5;--accent2:#9c86ee;--onaccent:#0e1014;--ok:#34d399;--bad:#f87171;--warn:#fbbf24}\n@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f7fb;--card:#ffffff;--card2:#eef0f5;--border:#dfe3ea;--fg:#23272f;--dim:#7a8290;--accent:#8f74e8;--accent2:#7a5fd9;--onaccent:#ffffff;--ok:#0fa968;--bad:#e5484d;--warn:#d98a00}}\n*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}\nhtml,body{background:var(--bg);color:var(--fg)}\nbody{font:14px/1.55 system-ui,-apple-system,\"PingFang SC\",\"Noto Sans SC\",sans-serif;padding:12px 14px 36px}\n.hd{display:flex;align-items:center;gap:10px;margin:2px 0 12px}\n.ic{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;color:#fff;flex:none}\n.tt{font-size:17px;font-weight:700;letter-spacing:.3px}\n.sub{font-size:11px;color:var(--dim);margin-top:2px}\n.grow{flex:1;min-width:0}\n.tabs{display:flex;gap:8px;margin-bottom:12px}\n.tab{flex:1;border:1px solid var(--border);background:var(--card);color:var(--dim);border-radius:12px;padding:9px 0;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}\n.tab.on{background:var(--accent);color:var(--onaccent);border-color:var(--accent)}\n.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:13px 14px;margin-bottom:12px}\n.card h3{font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px;margin-bottom:9px}\n.cnt{font-size:11px;color:var(--dim);font-weight:400}\n.row{display:flex;align-items:center;gap:8px}\n.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}\n.dim{color:var(--dim);font-size:12px}\n.sm{font-size:11px}\n.badge{font-size:10px;padding:2px 7px;border-radius:20px;background:var(--card2);color:var(--dim);border:1px solid var(--border);flex:none;display:inline-block}\n.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dim)}\n.dot.ok{background:var(--ok);box-shadow:0 0 6px rgba(52,211,153,.7)}\n.dot.bad{background:var(--bad)}\n.dot.warn{background:var(--warn)}\ninput[type=text],textarea{width:100%;background:var(--card2);border:1px solid var(--border);border-radius:10px;color:var(--fg);font-size:13px;padding:9px 11px;outline:none;font-family:inherit}\ninput[type=text]:focus,textarea:focus{border-color:var(--accent)}\ntextarea{resize:none;line-height:1.45}\n.btn{flex:none;background:var(--accent);color:var(--onaccent);border:none;border-radius:10px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}\n.btn:active{opacity:.8}\n.btn.ghost{background:var(--card2);color:var(--fg);border:1px solid var(--border)}\n.btn.danger{background:rgba(248,113,113,.14);color:var(--bad);border:1px solid rgba(248,113,113,.35)}\n.btn.sm{padding:6px 10px;font-size:12px}\n.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}\n.chip{display:inline-flex;align-items:center;gap:6px;background:var(--card2);border:1px solid var(--border);border-radius:20px;padding:4px 6px 4px 11px;font-size:12.5px;max-width:100%}\n.chip .x{width:18px;height:18px;border-radius:50%;background:rgba(248,113,113,.14);color:var(--bad);display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;flex:none;line-height:1}\n.chip .x:active{background:rgba(248,113,113,.3)}\n.empty{color:var(--dim);font-size:12.5px;padding:6px 2px}\n.hint{color:var(--dim);font-size:11.5px;margin-top:7px;line-height:1.5}\n.sw{position:relative;width:42px;height:24px;flex:none;cursor:pointer}\n.sw input{opacity:0;width:0;height:0;position:absolute}\n.sw .tk{position:absolute;inset:0;border-radius:20px;background:var(--card2);border:1px solid var(--border);transition:all .18s}\n.sw .tk:before{content:\"\";position:absolute;width:18px;height:18px;border-radius:50%;background:var(--dim);top:2px;left:2px;transition:all .18s}\n.sw input:checked + .tk{background:var(--accent);border-color:var(--accent)}\n.sw input:checked + .tk:before{background:var(--onaccent);transform:translateX(18px)}\n.rt{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid rgba(42,47,59,.6)}\n.rt:last-child{border-bottom:none}\n.logitem{border:1px solid var(--border);border-radius:10px;margin-top:8px;overflow:hidden}\n.logitem .top{display:flex;align-items:center;gap:7px;padding:8px 11px;cursor:pointer;background:var(--card2)}\n.logitem .top:active{opacity:.85}\n.logitem .body{display:none;padding:9px 11px;border-top:1px solid var(--border);font-size:12px;color:var(--dim);word-break:break-all;line-height:1.6}\n.logitem.open .body{display:block}\n.subttl{font-size:12.5px;font-weight:600;color:var(--fg);margin:11px 0 6px;display:flex;align-items:center;gap:6px}\n.collapse .bd{display:none}\n.collapse.open .bd{display:block}\n.cchead{display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 0}\n.cchead .arrow{font-size:10px;color:var(--dim);transition:transform .18s;display:inline-block}\n.collapse.open .arrow{transform:rotate(90deg)}\n.result{border-radius:10px;padding:10px 12px;font-size:12.5px;margin-top:9px;display:none;line-height:1.6;word-break:break-all}\n.result.show{display:block}\n.result.ok{background:rgba(52,211,153,.09);border:1px solid rgba(52,211,153,.3);color:var(--ok)}\n.result.bad{background:rgba(248,113,113,.09);border:1px solid rgba(248,113,113,.3);color:var(--bad)}\n.result.warn{background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.28);color:var(--warn)}\n#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:var(--card2);border:1px solid var(--border);color:var(--fg);font-size:12.5px;padding:9px 15px;border-radius:22px;opacity:0;pointer-events:none;transition:all .22s;max-width:86%;text-align:center;z-index:99}\n#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}\n#banner{display:none;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.35);color:var(--bad);font-size:12px;border-radius:10px;padding:8px 11px;margin-bottom:12px;word-break:break-all}\n" + THEME_VARS + "</style>\n</head>\n<body>\n<div class=\"hd\">\n  <div class=\"ic\">默</div>\n  <div class=\"grow\"><div class=\"tt\">MO隐私拦截网</div><div class=\"sub\">本地代理 · 127.0.0.1:8095</div></div>\n  <button class=\"btn ghost sm\" id=\"helpBtn\" title=\"使用说明\">ⓘ</button><button class=\"btn ghost sm\" id=\"refreshBtn\">刷新</button>\n</div>\n<div id=\"banner\"></div>\n<div class=\"tabs\">\n  <button class=\"tab on\" id=\"tabAdd\" data-tab=\"add\">＋ 添加</button>\n  <button class=\"tab\" id=\"tabLib\" data-tab=\"lib\">☰ 规则库</button>\n</div>\n\n<div id=\"viewAdd\">\n  <div class=\"card\">\n    <h3>代理状态</h3>\n    <div class=\"row\" style=\"justify-content:space-between\">\n      <div class=\"row\"><span class=\"dot\" id=\"stateDot\"></span><span id=\"stateText\" style=\"font-size:13px\">读取中…</span></div>\n      <label class=\"sw\"><input type=\"checkbox\" id=\"masterSw\"><span class=\"tk\"></span></label>\n      \n    </div>\n    <div class=\"row\" style=\"margin-top:10px;gap:8px;flex-wrap:wrap\">\n      <span class=\"badge\" id=\"statBlocked\">拦截 0</span>\n      <span class=\"badge\" id=\"statRoutes\">路由 0</span>\n      <span class=\"badge\" id=\"statBd\">内置规则 0</span>\n      <span class=\"badge\" id=\"statKw\">拦截词 0</span>\n      <span class=\"badge\" id=\"statWl\">白名单 0</span>\n    </div>\n  </div>\n\n  <div class=\"card\">\n    <h3>平台接管</h3>\n    <div class=\"row\"><button class=\"btn\" id=\"deployBtn\">一键部署</button><button class=\"btn ghost\" id=\"rollbackBtn\">一键回退</button></div>\n    <div class=\"hint\">一键部署 = 读取本机全部 MCP 直接部署并开启；一键回退 = 全部 MCP 关闭并消失（还原官方直连），除非重新部署。单条平台用下方路由开关单独开/退。</div>\n  </div>\n\n\n  <div class=\"card\">\n    <h3>添加拦截词</h3>\n    <div class=\"row\"><input type=\"text\" id=\"kwInput\" placeholder=\"输入要拦截的词\"><button class=\"btn\" id=\"kwAddBtn\">添加</button></div>\n    <div class=\"hint\">加入后立即生效。若与白名单短语完全相同会被拒绝，先删白名单再添加。</div>\n  </div>\n\n  <div class=\"card\">\n    <h3>添加白名单</h3>\n    <div class=\"row\"><input type=\"text\" id=\"wlInput\" placeholder=\"要放行的短语（单字也可以）\"><button class=\"btn\" id=\"wlAddBtn\">添加</button></div>\n    <div class=\"hint\">白名单只豁免「完整短语连用」的场景，不破坏其他语境下的拦截。</div>\n  </div>\n  <div class=\"card collapse\" id=\"secSem\">\n    <div class=\"cchead\" data-fold=\"1\"><h3 style=\"margin:0\" class=\"grow\">词意检索扩展 <span class=\"cnt\" id=\"semState\"></span></h3><span class=\"arrow\">▶</span></div>\n    <div class=\"bd\">\n      <div class=\"row\" style=\"margin-bottom:8px\">\n        <label class=\"sw\"><input type=\"checkbox\" id=\"semEnable\"><span class=\"tk\"></span></label>\n        <span class=\"sm dim\">启用：本地词表未命中时调用接口检索同词意/相近内容，扩大拦截范围</span>\n      </div>\n      <div style=\"margin-bottom:7px\"><input type=\"text\" id=\"semEndpoint\" placeholder=\"OpenAI 兼容接口地址（…/v1/chat/completions）\"></div>\n      <div style=\"margin-bottom:7px\"><input type=\"text\" id=\"semKey\" placeholder=\"API Key（可留空）\"></div>\n      <div class=\"row\" style=\"gap:7px;margin-bottom:7px\">\n        <input type=\"text\" id=\"semModel\" placeholder=\"模型名（如 gpt-4o-mini）\" style=\"flex:1\">\n        <input type=\"text\" id=\"semTimeout\" placeholder=\"15\" style=\"width:56px\"><span class=\"dim\">秒</span>\n      </div>\n      <div class=\"hint\" style=\"margin:0 0 7px\">超时 = 语义接口最长等待秒数；超时未响应一律按拦截处理（fail-closed），绝不放行。</div>\n      <div class=\"row\" style=\"gap:7px\">\n        <button class=\"btn sm\" id=\"semSaveBtn\">保存</button>\n        <button class=\"btn ghost sm\" id=\"semTestBtn\">测试连接</button>\n        <span class=\"grow\"></span>\n      </div>\n      <div class=\"hint\">可选辅助模块：填入 OpenAI 兼容接口（地址+Key）后启用，本地词表未命中时会做同词意/相近内容检索以扩大拦截范围。<b>不填则完全没有扩展作用</b>，也不影响现有拦截。接口超时/失败时判定为不通过（fail-closed），绝不放行。</div>\n      <div class=\"result\" id=\"semResult\"></div>\n    </div>\n  </div>\n  <div class=\"card collapse\" id=\"secRoutes\">\n    <div class=\"cchead\" data-fold=\"1\"><h3 style=\"margin:0\" class=\"grow\">平台路由 <span class=\"cnt\" id=\"routeCnt\"></span></h3><span class=\"arrow\">▶</span></div>\n    <div class=\"bd\"><div id=\"routeList\"></div><div class=\"hint\">开关 = 单条平台开启/退回：开 = 接入拦截网检查；关 = 退回官方直连不检查。<br><b>语</b> = 语义扩展开关：先决条件为全局「词意检索扩展」已填 API 并开启；开 = 本地词表放行后再调接口兜底扩大拦截；关 = 仅纯词表机械检查（零 API 消耗）。</div></div>\n  </div>\n  <div class=\"card collapse\" id=\"secPorts\">\n    <div class=\"cchead\" data-fold=\"1\"><h3 style=\"margin:0\" class=\"grow\">自定义端口 <span class=\"cnt\" id=\"portCnt\"></span></h3><span class=\"arrow\">▶</span></div>\n    <div class=\"bd\">\n      <div class=\"row\" style=\"margin-bottom:8px\"><input type=\"text\" id=\"portName\" placeholder=\"名称（如小红书接桥）\" style=\"flex:1.4\"><input type=\"text\" id=\"portTarget\" placeholder=\"目标地址 http(s)://...\" style=\"flex:2\"><button class=\"btn\" id=\"portAddBtn\">新增</button></div>\n      <div id=\"portList\"></div>\n      <div class=\"hint\">登记任意平台接桥入口（小红书/邮箱/自建服务器…），接入后走本地代理：机械拦截默认生效，语义扩展按「路由开关 + 全局API配置」才启用。开关=接入/退回，同样可一键部署/一键退回，回退时全部端口回到直连。</div>\n    </div>\n  </div>\n  <div class=\"card collapse\" id=\"secLog\">\n    <div class=\"cchead\" data-fold=\"1\"><h3 style=\"margin:0\" class=\"grow\">拦截日志 <span class=\"cnt\" id=\"logCnt\"></span></h3><span class=\"arrow\">▶</span></div>\n    <div class=\"bd\"><div id=\"logList\"></div></div>\n  </div>\n</div>\n\n<div id=\"viewLib\" style=\"display:none\">\n  <div class=\"card\">\n    <h3>拦截内容 · 可视可删</h3>\n    <div class=\"subttl\">内置规则 <span class=\"cnt\" id=\"bdCnt\"></span><span class=\"grow\"></span><button class=\"btn ghost sm\" id=\"restoreBtn\">恢复内置</button></div>\n    <div id=\"builtinList\"></div>\n    <div class=\"subttl\">自定义拦截词 <span class=\"cnt\" id=\"kwCnt\"></span></div>\n    <div class=\"chips\" id=\"kwList\"></div>\n    <div class=\"subttl\">敏感词配对规则 <span class=\"cnt\" id=\"pairCnt\"></span></div>\n    <div class=\"chips\" id=\"pairList\"></div>\n    <div class=\"hint\">内置规则点开可见每个词，点词上的 ✕ 删单个词；正则规则可整条删除。删除即热生效。</div>\n  </div>\n\n  <div class=\"card\" id=\"secWl\">\n    <h3 style=\"margin:0\">白名单 <span class=\"cnt\" id=\"wlBCnt\"></span></h3>\n    <div class=\"bd\">\n      <div class=\"subttl\">内置白名单 <span class=\"cnt\" id=\"wlCntB\"></span><span class=\"grow\"></span><button class=\"btn ghost sm\" id=\"restoreWlBtn\">恢复内置</button></div>\n      <div class=\"logitem\"><div class=\"top\" data-fold=\"1\"><span class=\"badge\">NSFW误杀组</span><span class=\"grow dim sm\">含易错的合法词</span><span class=\"sm dim\" id=\"wlCntNsfw\"></span></div><div class=\"body\"><div class=\"chips\" id=\"wlNsfwList\"></div></div></div>\n      <div class=\"logitem\"><div class=\"top\" data-fold=\"1\"><span class=\"badge\">通用组</span><span class=\"grow dim sm\">多义词/日常用语</span><span class=\"sm dim\" id=\"wlCntCommon\"></span></div><div class=\"body\"><div class=\"chips\" id=\"wlCommonList\"></div></div></div>\n      <div class=\"subttl\">自定义白名单 <span class=\"cnt\" id=\"wlCnt\"></span></div>\n      <div class=\"chips\" id=\"wlList\"></div>\n      <div class=\"hint\">内置白名单按「NSFW误杀组（含易错的合法词）/ 通用组」两分组，词条可单独删除（热生效，删除即从拦截豁免中移除），恢复内置可一键补齐；自定义白名单在「添加」页自由增删。两者合并生效，只豁免「完整短语连用」的场景。</div>\n    </div>\n  </div>\n  <div class=\"card\">\n    <h3>内容自检</h3>\n    <textarea id=\"checkInput\" rows=\"2\" placeholder=\"把要发到公共平台的内容贴进来试一下…\"></textarea>\n    <div class=\"row\" style=\"margin-top:8px\"><span class=\"grow\"></span><button class=\"btn\" id=\"checkBtn\">自检</button></div>\n    <div class=\"result\" id=\"checkResult\"></div>\n  </div>\n</div>\n\n<div id=\"toast\"></div>\n<div id=\"helpModal\" style=\"display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99;align-items:flex-start;justify-content:center;padding:24px 14px;overflow:auto;\">\n  <div style=\"background:var(--card);border:1px solid var(--border);border-radius:16px;max-width:600px;width:100%;padding:18px 18px 22px;box-shadow:0 8px 30px rgba(0,0,0,.4);\">\n    <div style=\"display:flex;align-items:center;gap:8px;margin-bottom:10px;\">\n      <div style=\"width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex:none;\">i</div>\n      <div style=\"font-size:15px;font-weight:700;flex:1;\">使用说明</div>\n      <button class=\"btn ghost sm\" id=\"helpCloseBtn\" style=\"padding:4px 10px;\">✕</button>\n    </div>\n    <div style=\"font-size:13px;line-height:1.75;color:var(--fg);\">\n      <div style=\"margin-bottom:8px;\"><b>🔄 刷新</b>：手动重新获取面板数据。点击后会先检查代理进程是否存活（万一挂了会尝试拉起），再重新加载状态、路由、自定义端口与拦截日志。面板不会自动刷新，数据变化时点它同步即可。</div>\n      <div style=\"margin-bottom:8px;\"><b>🕸️ 这是什么插件</b>：MO 隐私拦截网 = 一台装在自己手机上的“内容安检门”。它把 AI 即将发往公共平台（论坛、小镇、聊天室等）的内容先拦截下来，发送前做安全检查，防止私密信息（姓名、手机号、密码、私密对话等）流到公开场合。所有检查都在本机完成，内容不会外传，也不上传任何平台。</div>\n      <div style=\"margin-bottom:8px;\"><b>● 代理状态 / 总开关</b>：顶部显示拦截网当前在线状态（绿=代理在线）。总开关：开 = 拦截生效；关 = 代理转为纯转发（发出的内容直接放行、不检查），平台照常使用。平时建议保持开启。</div>\n      <div style=\"margin-bottom:8px;\"><b>🚀 一键部署 / 一键回退</b>：部署 = 一键把本机已安装的全部 AI 平台接入拦截网并开启检查（首次使用点它）；回退 = 一键全部还原官方直连，拦截网全部下班（应急或想放行时用）。部署后想单独控制某平台，用下方“平台路由”的开关。</div>\n      <div style=\"margin-bottom:8px;\"><b>➕ 添加拦截词</b>：补充你自己定义的敏感词（如姓名、住址、手机号）。加入后，只要内容包含这个词就会被拦截，立即生效。</div>\n      <div style=\"margin-bottom:8px;\"><b>白名单</b>：有些正常字句会碰巧含敏感词（比如“干活”里的敏感字），白名单用于豁免“完整短语连用”的场景，防止误拦正常说话。若某短语被误拦，添加进白名单即可放行。</div>\n      <div style=\"margin-bottom:8px;\"><b>🔎 词意检索扩展（可选，一般不用填）</b>：本地词表是“出现这个词就拦”，但它有盲区——换个说法（如把“银行卡号1234”说成“我的卡号1234”）就可能漏掉。这个扩展用 AI 接口对放行的内容再做一次“含义级”检查：填 OpenAI 兼容接口（地址+Key）并启用后生效；不填 = 完全不起作用、零消耗。超时 = 调接口最多等多少秒，超时未响应一律按拦截处理（绝不放行）。</div>\n      <div style=\"margin-bottom:8px;\"><b>📡 平台路由</b>：列出所有被接入的平台，每行两个开关：右侧主开关 = 该平台接不接入检查（开=检查，关=直连不检查）；左侧“语” = 该平台的语义扩展开关（需先填上面的 API 才有效）。按平台自由组合。</div>\n      <div style=\"margin-bottom:8px;\"><b>🔌 自定义端口</b>：为普通接口（小红书、邮箱、自建服务器等）登记入口，同样走拦截网检查，可单独开关，也能随一键部署/回退一起管理。</div>\n      <div style=\"margin-bottom:8px;\"><b>📜 拦截日志</b>：记录每一次被拦截的内容（时间、平台、命中的词、片段）。看到误拦时点开看详情，把误拦的词加白名单即可。所有记录只在本机。</div>\n      <div style=\"margin-bottom:8px;\"><b>☰ 规则库</b>：查看与删除内置规则（NSFW、敏感词等）、自定义拦截词与白名单。“恢复内置”可一键补齐误删的规则。删除即生效，请谨慎。</div>\n      <div><b>✅ 内容自检</b>：把要发的内容先粘贴进去点“自检”，模拟发送一次，看会不会被拦、命中哪些规则。发重要内容前可以先试一遍。</div>\n    </div>\n  </div>\n</div>\n\n<script>\n(function(){\n\"use strict\";\nwindow.onerror=function(msg){try{var b=document.getElementById(\"banner\");if(b){b.style.display=\"block\";b.textContent=\"页面错误：\"+msg;}}catch(e){}};\nfunction q(id){return document.getElementById(id);}\nfunction esc(s){if(s==null){return \"\";}s=String(s);return s.replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\").replace(/\"/g,\"&quot;\");}\nfunction toast(msg,type){var t=q(\"toast\");if(!t){return;}t.textContent=msg;t.className=type||\"\";void t.offsetWidth;t.classList.add(\"show\");clearTimeout(toast._h);toast._h=setTimeout(function(){t.classList.remove(\"show\");},2600);}\nfunction banner(msg){var b=q(\"banner\");if(!b){return;}if(!msg){b.style.display=\"none\";b.textContent=\"\";return;}b.textContent=msg;b.style.display=\"block\";}\nvar BRIDGE=(typeof PrivacyNet!==\"undefined\")?PrivacyNet:((typeof window!==\"undefined\"&&window.PrivacyNet)?window.PrivacyNet:null);\nfunction pcall(fn,arg){\n  if(!BRIDGE){return Promise.resolve({success:false,message:\"桥未注入\"});}\n  var p;\n  try{p=(arg===undefined)?BRIDGE[fn]():BRIDGE[fn](arg);}\n  catch(e){return Promise.resolve({success:false,message:String(e&&e.message||e)});}\n  return Promise.resolve(p).then(function(raw){\n    try{return JSON.parse(raw);}catch(e){return{success:false,message:\"解析失败:\"+String(raw).slice(0,80)};}\n  }).catch(function(e){return{success:false,message:String(e&&e.message||e)};});\n}\nfunction switchTab(name){\n  q(\"viewAdd\").style.display=(name===\"add\")?\"\":\"none\";\n  q(\"viewLib\").style.display=(name===\"lib\")?\"\":\"none\";\n  q(\"tabAdd\").className=\"tab\"+(name===\"add\"?\" on\":\"\");\n  q(\"tabLib\").className=\"tab\"+(name===\"lib\"?\" on\":\"\");\n}\nfunction fmtTime(iso){try{var d=new Date(iso);var p=function(n){return(n<10?\"0\":\"\")+n;};return p(d.getMonth()+1)+\"-\"+p(d.getDate())+\" \"+p(d.getHours())+\":\"+p(d.getMinutes())+\":\"+p(d.getSeconds());}catch(e){return String(iso||\"\");}}\nfunction renderRoutes(routes){\n  var box=q(\"routeList\");q(\"routeCnt\").textContent=routes.length+\" 条\";\n  if(!routes.length){box.innerHTML='<div class=\"empty\">还没有部署路由。在对话里让 AI 执行 deploy。</div>';return;}\n  var h=\"\";\n  for(var i=0;i<routes.length;i++){(function(r){\n    h+='<div class=\"rt\"><div class=\"grow\"><div class=\"mono\">'+esc(r.id)+'</div><div class=\"sm dim\">scope: '+esc(r.scope)+'</div></div><span class=\"sm dim\" title=\"语义扩展（需全局API已配置）\">语</span><label class=\"sw\"><input type=\"checkbox\" data-sem=\"'+esc(r.id)+'\" '+(r.semantic_enabled?\"checked\":\"\")+'><span class=\"tk\"></span></label><label class=\"sw\"><input type=\"checkbox\" data-rid=\"'+esc(r.id)+'\" '+(r.enabled?\"checked\":\"\")+'><span class=\"tk\"></span></label></div>';\n  })(routes[i]);}\n  box.innerHTML=h;\n  var cbs=box.querySelectorAll(\"input[type=checkbox]\");\n  for(var j=0;j<cbs.length;j++){cbs[j].addEventListener(\"change\",function(e){\n    var rid=e.target.getAttribute(\"data-rid\");\n    pcall(\"toggleRoute\",JSON.stringify({id:rid,enabled:e.target.checked})).then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n  });}\n  var sems=box.querySelectorAll(\"input[data-sem]\");\n  for(var k=0;k<sems.length;k++){sems[k].addEventListener(\"change\",function(e){\n    var rid=e.target.getAttribute(\"data-sem\");\n    pcall(\"toggleRouteSemantic\",JSON.stringify({id:rid,enabled:e.target.checked})).then(function(r){toast(r.message,r.success?\"ok\":\"warn\");refresh();});\n  });}\n} \nfunction renderPorts(list){\n  var box=q(\"portList\");q(\"portCnt\").textContent=list.length+\" 个\";\n  if(!list.length){box.innerHTML='<div class=\"empty\">（无）</div>';return;}\n  var h=\"\";\n  for(var i=0;i<list.length;i++){(function(p){\n    h+='<div class=\"rt\"><div class=\"grow\"><div class=\"mono\">'+esc(p.name)+'</div><div class=\"sm dim\">'+esc(p.target)+'</div></div><span class=\"sm dim\" title=\"语义扩展（需全局API已配置）\">语</span><label class=\"sw\"><input type=\"checkbox\" data-psem=\"'+esc(p.id)+'\" '+(p.semantic_enabled?\"checked\":\"\")+'><span class=\"tk\"></span></label><label class=\"sw\"><input type=\"checkbox\" data-pid=\"'+esc(p.id)+'\" '+(p.enabled?\"checked\":\"\")+'><span class=\"tk\"></span></label><button class=\"btn danger sm\" data-pdel=\"'+esc(p.id)+'\">✕</button></div>';\n  })(list[i]);}\n  box.innerHTML=h;\n  var cbs=box.querySelectorAll(\"input[data-pid]\");\n  for(var j=0;j<cbs.length;j++){cbs[j].addEventListener(\"change\",function(e){\n    var pid=e.target.getAttribute(\"data-pid\");\n    pcall(\"listCustom\").then(function(rr){\n      if(!rr.success)return;\n      var cr={routes:(rr.routes||{})};\n      var r=cr.routes[pid];\n      if(!r)return;\n      r.enabled=e.target.checked;\n      pcall(\"saveCustom\",JSON.stringify(cr)).then(function(r2){toast(r2.message,\"ok\");refresh();});\n    });\n  });}\n  var sems=box.querySelectorAll(\"input[data-psem]\");\n  for(var k=0;k<sems.length;k++){sems[k].addEventListener(\"change\",function(e){\n    var pid=e.target.getAttribute(\"data-psem\");\n    pcall(\"listCustom\").then(function(rr){\n      if(!rr.success)return;\n      var cr={routes:(rr.routes||{})};\n      var r=cr.routes[pid];\n      if(!r)return;\n      r.semantic_enabled=e.target.checked;\n      pcall(\"saveCustom\",JSON.stringify(cr)).then(function(r2){toast(r2.message,\"warn\");refresh();});\n    });\n  });}\n  var dels=box.querySelectorAll(\"button[data-pdel]\");\n  for(var d=0;d<dels.length;d++){dels[d].addEventListener(\"click\",function(e){\n    var pid=e.target.getAttribute(\"data-pdel\");\n    pcall(\"listCustom\").then(function(rr){\n      if(!rr.success)return;\n      var cr={routes:(rr.routes||{})};\n      delete cr.routes[pid];\n      pcall(\"saveCustom\",JSON.stringify(cr)).then(function(r2){toast(\"端口已删除\",\"ok\");refresh();});\n    });\n  });}\n}\nfunction renderBuiltin(list){\n  var box=q(\"builtinList\");q(\"bdCnt\").textContent=list.length+\" 条\";\n  if(!list||!list.length){box.innerHTML='<div class=\"empty\">没有内置规则。</div>';return;}\n  var h=\"\";\n  for(var i=0;i<list.length;i++){(function(r){\n    var n=r.words?r.words.length:0;\n    h+='<div class=\"logitem\"><div class=\"top\" data-fold=\"1\"><span class=\"badge\">'+esc(r.id)+'</span><span class=\"grow dim sm\">'+esc(r.reason)+'</span><span class=\"sm dim\">'+n+' 词</span></div><div class=\"body\">';\n    if(r.words&&r.words.length){\n      h+='<span style=\"display:inline-flex;flex-wrap:wrap;gap:6px\">';\n      for(var j=0;j<r.words.length;j++){\n        h+='<span class=\"chip\">'+esc(r.words[j])+'<span class=\"x\" data-act=\"rkw\" data-v=\"'+esc(r.words[j])+'\">✕</span></span>';\n      }\n      h+='</span>';\n    }else{\n      h+='<span class=\"dim sm\">正则规则：'+esc(r.raw)+'</span>';\n    }\n    h+='<div style=\"margin-top:6px\"><button class=\"btn danger sm\" data-rule-id=\"'+esc(r.id)+'\">删除整条规则</button></div>';\n    h+='</div></div>';\n  })(list[i]);}\n  box.innerHTML=h;\n}\nfunction renderChips(boxId,list,act){\n  var box=q(boxId);\n  if(!list||!list.length){box.innerHTML='<div class=\"empty\">（空）</div>';return;}\n  var h=\"\";\n  for(var i=0;i<list.length;i++){\n    if(act){h+='<span class=\"chip\">'+esc(list[i])+'<span class=\"x\" data-act=\"'+act+'\" data-v=\"'+esc(list[i])+'\">✕</span></span>';}\n    else{h+='<span class=\"chip\">'+esc(list[i])+'</span>';}\n  }\n  box.innerHTML=h;\n}\nfunction renderWlGroups(wlObj){\n  var box=q(\"wlNsfwList\"),box2=q(\"wlCommonList\");\n  var mergedNsfw=null;\n  if(wlObj&&!wlObj.nsfw&&(wlObj.cao||wlObj.bi)){\n    mergedNsfw={items:(wlObj.cao&&wlObj.cao.items?wlObj.cao.items.slice():[]).concat(wlObj.bi&&wlObj.bi.items?wlObj.bi.items.slice():[])};\n  }\n  var gNsfw=(wlObj&&wlObj.nsfw)?wlObj.nsfw:mergedNsfw;\n  var gCom=(wlObj&&wlObj.common)?wlObj.common:null;\n  var groups=[gNsfw,gCom];\n  var total=0;\n  for(var gi=0;gi<groups.length;gi++){\n    var g=groups[gi];\n    var items=(g&&g.items)?g.items:[];\n    total+=items.length;\n  }\n  q(\"wlBCnt\").textContent=total+\" 条\";q(\"wlCntB\").textContent=total+\" 个\";\n  function fill(el,cntEl,items){\n    if(!el)return;\n    if(cntEl)cntEl.textContent=items.length+\" 个\";\n    if(!items.length){el.innerHTML=\'<div class=\"empty\">（空）</div>\';return;}\n    var h=\"\";\n    for(var i=0;i<items.length;i++){\n      h+=\'<span class=\"chip\">\'+esc(items[i])+\'<span class=\"x\" data-act=\"rwlb\" data-v=\"\'+esc(items[i])+\'\">✕</span></span>\';\n    }\n    el.innerHTML=h;\n  }\n  fill(box,q(\"wlCntNsfw\"),(gNsfw&&gNsfw.items)||[]);\n  fill(box2,q(\"wlCntCommon\"),(gCom&&gCom.items)||[]);\n}\nfunction renderStatus(d){\n  var ms=q(\"masterSw\"); if(ms){ms.checked=!!d.enabled;}\n  \n  q(\"statBlocked\").textContent=\"拦截 \"+d.blocked_total;\n  q(\"statRoutes\").textContent=\"路由 \"+d.routes.length;\n  q(\"statBd\").textContent=\"内置规则 \"+d.builtin.length;\n  q(\"statKw\").textContent=\"拦截词 \"+d.keywords.length;\n  q(\"statWl\").textContent=\"白名单 \"+d.whitelist.length;\n  renderRoutes(d.routes);\n  renderBuiltin(d.builtin);\n  renderChips(\"kwList\",d.keywords,\"rkw\");q(\"kwCnt\").textContent=d.keywords.length+\" 个\";\n  renderWlGroups(d.builtin_whitelist);\n  renderChips(\"wlList\",d.whitelist,\"rwl\");q(\"wlCnt\").textContent=d.whitelist.length+\" 个\";\n  var pk=[];\n  for(var i=0;i<d.pair.length;i++){for(var j=0;j<d.pair[i].keywords.length;j++){pk.push(d.pair[i].keywords[j]);}}\n  renderChips(\"pairList\",pk,\"rpk\");q(\"pairCnt\").textContent=pk.length+\" 个\";\n  var dot=q(\"stateDot\"),txt=q(\"stateText\");\n  dot.className=\"dot\";\n  var hb=d.hb||{};\n  if(hb.t){\n    var age=Date.now()-hb.t;\n    if(age<30000){dot.classList.add(\"ok\");txt.textContent=\"代理在线 · pid \"+hb.pid;}\n    else{dot.classList.add(\"bad\");txt.textContent=\"代理离线\";}\n  }else{dot.classList.add(\"warn\");txt.textContent=\"没有心跳数据（worker 未写入）\";}\n}\nfunction renderLog(entries,total){\n  var box=q(\"logList\");q(\"logCnt\").textContent=total+\" 条\";\n  if(!entries.length){box.innerHTML='<div class=\"empty\">暂无拦截记录。放行与拦截都发生在本机，不会外传。</div>';return;}\n  var h=\"\";\n  for(var i=0;i<entries.length;i++){(function(en){\n    h+='<div class=\"logitem\"><div class=\"top\" data-fold=\"1\"><span class=\"badge\" style=\"color:var(--bad)\">'+esc(en.route)+'</span><span class=\"grow dim sm\">'+fmtTime(en.t)+'</span></div><div class=\"body\">命中规则：'+esc((en.hits||[]).join(\"、\"))+'<br>片段：'+esc(String(en.snippet||\"\").slice(0,140))+'</div></div>';\n  })(entries[i]);}\n  box.innerHTML=h;\n}\nvar refreshSeq=0;\nfunction refresh(){\n  var seq=++refreshSeq;\n  pcall(\"ensureWorker\");\n  banner(\"\");\n  pcall(\"getStatus\").then(function(r){\n    if(seq!==refreshSeq){return;}\n    if(r.success){renderStatus(r.data);}else{banner(\"读取失败：\"+r.message);toast(\"读取失败：\"+r.message,\"bad\");}\n  });\n  pcall(\"listCustom\").then(function(rc){\n    if(seq!==refreshSeq){return;}\n    if(rc.success){\n      var pl=[];\n      for(var pk in (rc.routes||{})){var pr=rc.routes[pk];pl.push({id:pk,name:pr.name,target:pr.target,enabled:pr.enabled!==false,semantic_enabled:pr.semantic_enabled===true});}\n      renderPorts(pl);\n    }\n  });\n  pcall(\"getLog\",20).then(function(r){\n    if(seq!==refreshSeq){return;}\n    if(r.success){renderLog(r.data.entries,r.data.total);}else{banner(\"日志读取失败：\"+r.message);}\n  });\n}\ndocument.addEventListener(\"click\",function(e){\n  var t=e.target;\n  var fold=t.closest(\"[data-fold]\");\n  if(fold){fold.parentNode.classList.toggle(\"open\");return;}\n  var x=t.closest(\"[data-act]\");\n  if(x){\n    var v=x.getAttribute(\"data-v\"),a=x.getAttribute(\"data-act\");\n    var fn=(a===\"rwlb\")?\"removeBuiltinWhitelist\":(a===\"rwl\")?\"removeWhitelist\":(a===\"rpk\")?\"removePairKeyword\":\"removeKeyword\";\n    pcall(fn,v).then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n    return;\n  }\n  var rb=t.closest(\"[data-rule-id]\");\n  if(rb){\n    var rid=rb.getAttribute(\"data-rule-id\");\n    pcall(\"removeRule\",rid).then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n    return;\n  }\n  var tab=t.closest(\"[data-tab]\");\n  if(tab){switchTab(tab.getAttribute(\"data-tab\"));return;}\n});\nq(\"refreshBtn\").addEventListener(\"click\",refresh);\nq(\"helpBtn\").addEventListener(\"click\",function(){var m=q(\"helpModal\");if(m){m.style.display=\"flex\";}});\nq(\"helpCloseBtn\").addEventListener(\"click\",function(){var m=q(\"helpModal\");if(m){m.style.display=\"none\";}});\nq(\"helpModal\").addEventListener(\"click\",function(e){if(e.target===q(\"helpModal\")){q(\"helpModal\").style.display=\"none\";}});\n\nq(\"kwAddBtn\").addEventListener(\"click\",function(){\n  var v=q(\"kwInput\").value.trim();\n  if(!v){toast(\"先输入关键词\",\"warn\");return;}\n  pcall(\"addKeyword\",v).then(function(r){toast(r.message,(r.conflict?\"warn\":(r.success?\"ok\":\"bad\")));if(r.success){q(\"kwInput\").value=\"\";refresh();}});\n});\nq(\"wlAddBtn\").addEventListener(\"click\",function(){\n  var v=q(\"wlInput\").value.trim();\n  if(!v){toast(\"先输入短语\",\"warn\");return;}\n  pcall(\"addWhitelist\",v).then(function(r){toast(r.message,(r.conflict?\"warn\":(r.success?\"ok\":\"bad\")));if(r.success){q(\"wlInput\").value=\"\";refresh();}});\n});\nq(\"restoreBtn\").addEventListener(\"click\",function(){\n  pcall(\"restoreBuiltin\").then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n});\nq(\"restoreWlBtn\").addEventListener(\"click\",function(){\n  pcall(\"restoreWhitelist\").then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n});\nq(\"deployBtn\").addEventListener(\"click\",function(){\n  toast(\"部署中…\",\"warn\");\n  pcall(\"deployRoutes\").then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n});\nq(\"rollbackBtn\").addEventListener(\"click\",function(){\n  toast(\"回退中…\",\"warn\");\n  pcall(\"rollbackRoutes\").then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n});\nq(\"masterSw\").addEventListener(\"change\",function(){\n  var on=q(\"masterSw\").checked;\n  pcall(\"setEnabled\",on).then(function(r){toast(r.message,r.success?\"ok\":\"bad\");refresh();});\n});\nq(\"portAddBtn\").addEventListener(\"click\",function(){\n  var nm=q(\"portName\").value.trim();\n  var tg=q(\"portTarget\").value.trim();\n  if(!nm){toast(\"先输入名称\",\"warn\");return;}\n  if(!/^https?:\\/\\//i.test(tg)){toast(\"目标地址需 http(s):// 开头\",\"warn\");return;}\n  pcall(\"listCustom\").then(function(rr){\n    if(!rr.success){toast(\"读取失败\",\"bad\");return;}\n    var cr={routes:(rr.routes||{})};\n    var id=\"custom-\"+nm.replace(/[^a-zA-Z0-9_-]/g,\"\").toLowerCase()+\"-\"+String(Date.now()).slice(-4);\n    cr.routes[id]={name:nm,target:tg,enabled:false,scope:\"public\",semantic_enabled:false,created_at:Date.now()};\n    pcall(\"saveCustom\",JSON.stringify(cr)).then(function(r2){toast(\"端口已登记（默认关闭）\",\"ok\");q(\"portName\").value=\"\";q(\"portTarget\").value=\"\";refresh();});\n  });\n});\nq(\"checkBtn\").addEventListener(\"click\",function(){\n  var v=q(\"checkInput\").value.trim();\n  var res=q(\"checkResult\");\n  if(!v){res.className=\"result show warn\";res.textContent=\"先输入要自检的内容。\";return;}\n  res.className=\"result show\";res.textContent=\"自检中…\";\n  pcall(\"checkText\",v).then(function(r){\n    if(!r.success){res.className=\"result show \"+(r.empty?\"warn\":\"bad\");res.textContent=r.empty?(\"· \"+r.message):(\"✕ \"+r.message);return;}\n    var d=r.data;\n    if(d.allowed){res.className=\"result show ok\";res.textContent=\"✓ 放行 — 未命中任何规则\"+(d.whitelist_applied&&d.whitelist_applied.length?(\"（白名单豁免：\"+d.whitelist_applied.join(\"、\")+\"）\"):\"\");}\n    else{var det=(d.details||[]).map(function(x){return x.reason||x.id;}).join(\"、\");res.className=\"result show bad\";res.textContent=\"✕ 拦截 — 命中：\"+((d.hits||[]).join(\"、\")||\"未知\")+(det?\"（\"+det+\"）\":\"\");}\n  });\n});\nfunction fillSemantic(cfg){\n  if(!cfg){return;}\n  var en=q(\"semEnable\"); if(en){en.checked=!!cfg.enable;}\n  var ep=q(\"semEndpoint\"); if(ep){ep.value=String(cfg.endpoint||\"\");}\n  var kk=q(\"semKey\"); if(kk){kk.value=String(cfg.apiKey||\"\");}\n  var mm=q(\"semModel\"); if(mm){mm.value=String(cfg.model||\"\");}\n  var tt=q(\"semTimeout\"); if(tt){tt.value=Math.round((Number(cfg.timeoutMs)||15000)/1000);}\n  var st=q(\"semState\"); if(st){st.textContent=cfg.enable?\"已开启\":\"已关闭\";}\n  var rr=q(\"semResult\");\n  if(rr && cfg.last_test && cfg.last_test.t){\n    rr.className=\"result show \"+(cfg.last_test.ok?\"ok\":\"warn\");\n    rr.textContent=\"上次测试：\"+cfg.last_test.message;\n  }\n}\nfunction collectSemantic(){\n  return {\n    enable: !!q(\"semEnable\").checked,\n    endpoint: String(q(\"semEndpoint\").value||\"\").trim(),\n    apiKey: String(q(\"semKey\").value||\"\").trim(),\n    model: String(q(\"semModel\").value||\"\").trim(),\n    timeoutMs: Math.max(1000, Math.min(120000, (Number(q(\"semTimeout\").value)||15)*1000))\n  };\n}\nfunction loadSemantic(){\n  pcall(\"getSemantic\").then(function(r){\n    if(r.success){fillSemantic(r.data);}\n  });\n}\nq(\"semSaveBtn\").addEventListener(\"click\",function(){\n  pcall(\"saveSemantic\",JSON.stringify(collectSemantic())).then(function(r){\n    toast(r.message,r.success?\"ok\":\"bad\");\n    if(r.success && r.data){fillSemantic(r.data);}\n  });\n});\nq(\"semTestBtn\").addEventListener(\"click\",function(){\n  var res=q(\"semResult\");\n  res.className=\"result show\";res.textContent=\"测试中…\";\n  pcall(\"saveSemantic\",JSON.stringify(collectSemantic())).then(function(r){\n    if(!r.success){res.className=\"result show warn\";res.textContent=r.message;return;}\n    pcall(\"testSemantic\").then(function(r2){\n      if(!r2.success){res.className=\"result show warn\";res.textContent=r2.message;return;}\n      var d=r2.data;\n      if(d && d.result){\n        res.className=\"result show \"+((d.result.ok||d.err)?\"warn\":\"ok\");\n        res.textContent=d.result.message+(d.costMs?\"（耗时\"+d.costMs+\"ms）\":\"\");\n      }else{\n        res.className=\"result show warn\";res.textContent=\"接口无响应\";\n      }\n      loadSemantic();\n    });\n  });\n});\nq(\"semEnable\").addEventListener(\"change\",function(){\n  var cur=collectSemantic();cur.enable=q(\"semEnable\").checked;\n  pcall(\"saveSemantic\",JSON.stringify(cur)).then(function(r){\n    toast(r.message,r.success?\"ok\":\"bad\");\n    if(r.success && r.data){fillSemantic(r.data);}\n  });\n});\nloadSemantic();\nrefresh();\n})();\n</script>\n</body>\n</html>\n",
    baseUrl: "about:blank",
    javaScriptEnabled: true,
    domStorageEnabled: true,
    controller: panelController
});
}
exports.default = Screen;
