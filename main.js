"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;
exports.onApplicationCreate = onApplicationCreate;
exports.onApplicationForeground = onApplicationForeground;
var ui = __importDefault(require("./ui/panel/index.ui.js"));
var Screen = ui.default;
var RUN_DIR = (typeof __dirname !== "undefined") ? (String(__dirname).replace(/\/+$/, "") + "/") : "/sdcard/Download/Operit/plugins/mo_privacy_net/";
var WORKER_JS = RUN_DIR + "resources/worker/proxy.js";

// 幂等拉起：端口已监听则跳过；否则后台拉起 worker。不做任何探测、不轮询，
// 不产生宿主错误记录（备份版行为，保留）。
async function ensureWorker() {
    try {
        if (typeof Tools === "undefined" || !Tools.System || !Tools.System.terminal) { return; }
        var term = Tools.System.terminal;
        var cmd = "(node -e 'var h=require(\"http\");var r=h.get({host:\"127.0.0.1\",port:8095,path:\"/state\",timeout:2000},function(res){var d=\"\";res.on(\"data\",function(c){d+=c});res.on(\"end\",function(){process.exit(d.indexOf(\"alive\")>=0?0:1)})});r.on(\"timeout\",function(){r.destroy();process.exit(1)});r.on(\"error\",function(){process.exit(1)})' 2>/dev/null) || (cd " + RUN_DIR + " && setsid nohup node " + WORKER_JS + " >> " + RUN_DIR + "proxy.log 2>&1 &)";
        // 模式A：create 会话 -> exec(sessionId, cmd)
        try {
            if (typeof term.create === "function") {
                var sessionOr = term.create("mo_privacy_worker");
                var sessionId = "";
                if (sessionOr && typeof sessionOr.then === "function") {
                    var sess = await sessionOr;
                    sessionId = String((sess && sess.sessionId) || "").trim();
                } else {
                    sessionId = String((sessionOr && sessionOr.sessionId) || sessionOr || "").trim();
                }
                if (sessionId && typeof term.exec === "function") {
                    var r = term.exec(sessionId, cmd, 5000);
                    if (r && typeof r.then === "function") { await r; }
                    return;
                }
            }
        } catch (e) {}
        // 模式B：exec(cmd) 单参（工具包 mo_privacy_net_tools.js 验证过的宿主形态）
        try {
            if (typeof term.exec === "function") {
                var r4 = term.exec(cmd);
                if (r4 && typeof r4.then === "function") { await r4; }
                return;
            }
        } catch (e) {}
        // 模式C：exec(cmd, timeoutMs)（部分宿主形态，失败静默）
        try {
            if (typeof term.exec === "function") {
                var r3 = term.exec(cmd, 5000);
                if (r3 && typeof r3.then === "function") { await r3; }
            }
        } catch (e) {}
    } catch (e) {}
}

function onApplicationCreate() {
    try {
        // 不阻塞 OP 启动链：异步探活（幂等，已在听端口则跳过）
        void ensureWorker();
    } catch (e) {}
    return { ok: true };
}
function onApplicationForeground() {
    try {
        void ensureWorker();
    } catch (e) {}
    return { ok: true };
}
function registerToolPkg() {
    try {
        ToolPkg.registerUiRoute({
            id: "mo_privacy_net_panel",
            runtime: "compose_dsl",
            screen: Screen,
            params: {},
            title: {
                zh: "MO隐私拦截网💬",
                en: "MO Privacy Net"
            }
        });
        ToolPkg.registerNavigationEntry({
            id: "mo_privacy_net_panel_entry",
            route: "toolpkg:com.mo.privacy_net:ui:mo_privacy_net_panel",
            surface: "main_sidebar_plugins",
            title: {
                zh: "MO隐私拦截网💬",
                en: "MO Privacy Net"
            },
            order: 1
        });
        ToolPkg.registerAppLifecycleHook({
            id: "mo_privacy_net_worker_autostart",
            event: "application_on_create",
            function: onApplicationCreate
        });
        ToolPkg.registerAppLifecycleHook({
            id: "mo_privacy_net_worker_fg",
            event: "application_on_foreground",
            function: onApplicationForeground
        });
        // 注册期立即点火：ToolPkg 加载时第一时间拉起 worker，
        // 争取在 Operit 验证远端 MCP 之前让 8095 就绪，减少「验证失败」红窗。
        try { void ensureWorker(); } catch (e) {}
        // fix4：常驻保活 watchdog——每45秒探活 /state，失活自动拉起（带并发锁）。
        // 不依赖 Shizuku：插件进程常驻即保活，worker 被系统杀也不怕。
        var workerStarting = false;
        function probeWorkerAlive(cb) {
            try {
                var h = require('http');
                var req = h.get({ host: '127.0.0.1', port: 8095, path: '/state', timeout: 2500 }, function (res) {
                    var d = '';
                    res.on('data', function (c) { d += c; });
                    res.on('end', function () { cb(d.indexOf('alive') >= 0); });
                });
                req.on('timeout', function () { req.destroy(); cb(false); });
                req.on('error', function () { cb(false); });
            } catch (e) { cb(false); }
        }
        function watchdogTick() {
            if (workerStarting) { return; }
            probeWorkerAlive(function (ok) {
                if (ok) { return; }
                workerStarting = true;
                void ensureWorker();
                setTimeout(function () { workerStarting = false; }, 10000);
            });
        }
        try {
            setInterval(watchdogTick, 45000);
            setTimeout(watchdogTick, 15000);
        } catch (e) {}
        return true;
    } catch (e) {
        return false;
    }
}