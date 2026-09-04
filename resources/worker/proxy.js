/**
 * MO隐私拦截网 · 本地代理 worker v2.0.7（完整版·面板零Shizuku）
 * - 管理端点鉴权（本地令牌）/ 外部语义与自定义端口强制 HTTPS（本地回环例外）
 * - rollback 仅回退本插件登记条目 / 自动拉起进程已披露
 * - v2.0.5 安全整改：/admin/fs 读写一律纳入令牌鉴权（移除只读豁免）；CORS 仅授予本机来源，
 *   任意网页/WebView 无法跨域读取含凭据文件；deploy 仅接管 mcpServers 内登记的远程条目
 * - v2.0.7 完整版：新增本机会话握手 /auth/session（仅127.0.0.1回环可达）——面板无需读取本地令牌文件，
 *   凭本机来源换取30分钟短效会话令牌；管理端点接受长效令牌或有效会话令牌，凭据暴露面更小
 * 通用化设计：
 * - 泛路由：/proxy/<route-id> 由运行时配置决定，不内置任何平台
 * - 通用接管：register 登记本机 MCP 入本插件路由表；deploy 仅接管登记集合（bridge_deploy=true），rollback 仅还原登记集合（不触碰无关配置）
 * - 总开关：state.json enabled=false 时全放行（仅转发，不检查）
 * - 单路由开关：/admin/route 控制单个 MCP 的接入/退回官方直连
 * - 语义兜底：semantic.json 本地词表未命中时调用外部接口审查，fail-closed：超时/出错按拦截处理，绝不因接口故障放行
 * - 语义扩展为「三重开关」：全局 semantic.json enable+endpoint 已配置，且该路由 semantic_enabled=true，才触发（默认关闭，零 token 消耗）
 * - 自定义端口：custom_routes.json 登记的平台接桥（/proxy/custom-<id>），独立于 MCP 路由，一键回退同样覆盖
 * - 纯被动：无轮询、无主动外连、无重试轰炸，只处理路过本机的请求
 * v1.1 规则引擎升级：
 * - pair_rules：敏感词 + 疑似具体值 才拦截（如「密码」+114477），仅有词无值放行，防误判
 * - custom_rules.json：用户自定义拦截关键词，每次请求热读，增删即时生效
 * - 拦截日志记录命中片段（snippet），可回溯具体拦截内容
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.MO_PORT) || 8095;
const DATA_DIR = process.env.MO_DATA_DIR || path.join(__dirname, '..', '..');
const BUILTIN_RULES = path.join(DATA_DIR, 'default_rules.json');
const MAX_BODY = 2 * 1024 * 1024; // 2MB
const MAX_LOG = 500;
const SNIPPET_PAD = 12; // 命中片段前后各保留字符数

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveJson(file, obj) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[save]', file, e.message);
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let state = loadJson('state.json') || { enabled: true, blocked_total: 0, blocks_by_route: {} };

function loadState() {
  const s = loadJson('state.json');
  if (s) state = s;
  return state;
}

function loadRules() {
  let rules = loadJson('rules.json');
  if (!rules) {
    try {
      rules = JSON.parse(fs.readFileSync(BUILTIN_RULES, 'utf8'));
    } catch (e) {
      rules = { version: 1, scope: {} };
    }
  }
  // 合并用户自定义规则（热读，增删即时生效）
  const custom = loadJson('custom_rules.json') || {};
  const merged = JSON.parse(JSON.stringify(rules));
  merged.scope = merged.scope || { public: { hard_rules: [] }, internal: { hard_rules: [] } };
  merged.scope.public = merged.scope.public || { hard_rules: [] };
  merged.scope.internal = merged.scope.internal || { hard_rules: [] };

  const nsfwWords = Array.isArray(custom.nsfw_words) ? custom.nsfw_words : [];
  const bannedWords = Array.isArray(custom.ban_words) ? custom.ban_words : [];
  const allCustom = nsfwWords.concat(bannedWords).map(function (w) { return String(w).trim(); })
    .filter(function (w) { return w.length > 0; });
  if (allCustom.length > 0) {
    const pat = allCustom.map(escapeRegExp).join('|');
    merged.scope.public.hard_rules.push({ id: 'custom_word', type: 'regex', pattern: '(' + pat + ')', reason: '用户自定义拦截词' });
    merged.scope.internal.hard_rules.push({ id: 'custom_word', type: 'regex', pattern: '(' + pat + ')', reason: '用户自定义拦截词' });
  }

  // pair 规则：可对内置 pair_rules 的关键词做用户扩充
  if (merged.pair_rules && custom.pair_keywords) {
    for (const r of merged.pair_rules) {
      const extra = custom.pair_keywords[r.id];
      if (Array.isArray(extra)) {
        for (const kw of extra) {
          if (r.keywords.indexOf(kw) < 0) r.keywords.push(kw);
        }
      }
    }
  }
  return merged;
}

function findPairHits(text, pairRules, origText) {
  const hits = [];
  for (const r of pairRules) {
    try {
      const keywords = r.keywords || [];
      const valueRe = new RegExp(r.value_pattern || '[0-9]{4,}', 'i');
      const window = r.window || 40;
      const textLower = text.toLowerCase();
      let matched = false;
      for (const kw of keywords) {
        const kwLower = String(kw).toLowerCase();
        let idx = 0;
        let pos;
        while ((pos = textLower.indexOf(kwLower, idx)) >= 0) {
          const after = text.slice(pos + kwLower.length, pos + kwLower.length + window);
          if (valueRe.test(after)) { matched = true; break; }
          idx = pos + kwLower.length;
        }
        if (matched) break;
      }
      if (matched) hits.push({ id: r.id, reason: r.reason || '敏感词后跟疑似具体值', snippet: (origText || text).slice(0, 120) });
    } catch (e) {
      console.error('[pair-bad]', r.id, e.message);
    }
  }
  return hits;
}

// 白名单：检测前先等长遮蔽白名单短语，再跑规则。
// 短语级匹配——白名单只豁免「完整短语连用」的场景（如「干活」「看着干活」），
// 孤立出现的单字（如白名单外语境里的「干」）不受影响。
// 遮蔽用 \u0000 等长占位，保证命中位置与原文一一对应，snippet 仍从原文截取。
function maskWhitelist(text) {
  const custom = loadJson('custom_rules.json') || {};
  const rules = loadJson('rules.json') || {};
  const wlMap = {};
  function collectItems(g) {
    if (Array.isArray(g)) return g.slice();
    if (g && g.items && Array.isArray(g.items)) return g.items.slice();
    return [];
  }
  const defObj = rules.builtin_whitelist;
  const defWl = collectItems(defObj && defObj.nsfw).concat(collectItems(defObj && defObj.common));
  if (Array.isArray(defObj)) { defWl.length = 0; defWl.push.apply(defWl, defObj); }
  const curWl = Array.isArray(custom.whitelist_phrases) ? custom.whitelist_phrases : collectItems(custom.whitelist_phrases);
  defWl.concat(curWl).forEach(function (p) { wlMap[String(p).trim()] = 1; });
  const wl = Object.keys(wlMap).filter(function (p) { return p.length > 0; });
  let scanText = text;
  const applied = [];
  for (const phrase of wl) {
    const p = String(phrase).trim();
    if (p.length < 1) continue;
    while (scanText.indexOf(p) >= 0) {
      applied.push(p);
      scanText = scanText.split(p).join('\u0000'.repeat(p.length));
    }
  }
  return { scanText: scanText, applied: applied };
}

function checkText(text, scope) {
  const wl = maskWhitelist(text);
  const scanText = wl.scanText;
  const rules = loadRules();
  const scopeConf = (rules.scope && rules.scope[scope]) || (rules.scope && rules.scope.public) || {};
  const list = scopeConf.hard_rules || [];
  const hits = [];
  const details = [];
  for (const r of list) {
    try {
      const re = new RegExp(r.pattern, 'ig');
      let m;
      while ((m = re.exec(scanText)) !== null) {
        hits.push(r.id);
        details.push({
          id: r.id,
          reason: r.reason || '',
          snippet: text.slice(Math.max(0, m.index - SNIPPET_PAD), m.index + m[0].length + SNIPPET_PAD),
        });
        if (details.length >= 10) break;
      }
    } catch (e) {
      console.error('[rule-bad]', r.id, e.message);
    }
  }
  const pairRules = rules.pair_rules || [];
  if (pairRules.length > 0) {
    for (const p of findPairHits(scanText, pairRules, text)) {
      hits.push(p.id);
      details.push(p);
    }
  }
  const result = { hits: hits, details: details };
  if (wl.applied.length > 0) result.whitelist_applied = wl.applied;
  return result;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) {
        req.destroy();
        finish('');
      }
    });
    req.on('end', () => finish(data));
    req.on('error', () => finish(''));
    req.on('close', () => finish(data));
  });
}

function forward(routeId, route, req, body, res) {
  let target;
  try {
    target = new URL(route.target);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'guard-proxy: bad target for ' + routeId }));
    }
    return;
  }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;

  // 还原原始路径：去掉 /proxy/<id> 前缀，拼到 target 的 pathname + query 之后
  const prefix = '/proxy/' + routeId;
  let rest = (req.url || '').replace(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '');
  if (!rest) rest = '';
  let outPath = target.pathname + (target.search || '') + rest;
  if (!outPath) outPath = '/';

  const headers = { ...req.headers };
  headers.host = target.host;
  headers['content-length'] = Buffer.byteLength(body);
  delete headers['accept-encoding'];

  // 自定义头（部署时从配置提取）
  if (route.headers && typeof route.headers === 'object') {
    for (const hk of Object.keys(route.headers)) {
      headers[hk] = String(route.headers[hk]);
    }
  }
  // 认证 token 附加（仅当目标地址本身未携带时）
  if (route.token && route.token.type === 'header') {
    const hn = route.token.header || 'Authorization';
    headers[hn] = String(route.token.prefix || '') + String(route.token.value || '');
  } else if (route.token && route.token.type === 'query') {
    const qk = route.token.key || 'token';
    if (outPath.indexOf(qk + '=') < 0) {
      outPath += (outPath.indexOf('?') >= 0 ? '&' : '?') + qk + '=' + encodeURIComponent(String(route.token.value || ''));
    }
  }

  const opts = {
    method: req.method,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: outPath,
    headers: headers,
  };
  const preq = lib.request(opts, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'guard-proxy: upstream unreachable' }));
    }
  });
  // SSE 长连接不设 60 秒掐断（否则验证/订阅流会被强杀，导致上游断连判定）
  const isStream = String(headers['accept'] || '').indexOf('text/event-stream') >= 0;
  if (!isStream) {
    preq.setTimeout(60000, () => preq.destroy());
  }
  preq.end(body);
}

function recordBlock(routeId, result, body) {
  loadState();
  state.blocked_total += 1;
  state.last_block_at = Date.now();
  state.blocks_by_route[routeId] = (state.blocks_by_route[routeId] || 0) + 1;
  saveJson('state.json', state);

  let log = loadJson('blocked_log.json') || [];
  log.push({
    t: new Date().toISOString(),
    route: routeId,
    hits: result.hits.slice(0, 10),
    details: (result.details || []).slice(0, 6),
    len: body.length,
    snippet: body.slice(0, 160),
  });
  if (log.length > MAX_LOG) log = log.slice(log.length - MAX_LOG);
  saveJson('blocked_log.json', log);
  console.log('[block]', routeId, result.hits.join(','));
}

// ===== 语义 API 兜底审查（semantic.json，用户专用配置入口） =====
const SEM_JSON = path.join(DATA_DIR, 'semantic.json');
function defaultSemantic() {
  return {
    enable: false,
    endpoint: '',
    apiKey: '',
    model: '',
    timeoutMs: 15000,
    prompt: '你是内容安全审查器。判断用户文本是否包含色情/淫秽/性行为描写等违规内容（语义层面判断，不限于词面）。只输出 JSON：{"hit":true,"reason":"命中原因"} 或 {"hit":false}。',
    last_test: { t: 0, ok: false, message: '' }
  };
}
function loadSemantic() {
  try {
    return Object.assign(defaultSemantic(), JSON.parse(fs.readFileSync(SEM_JSON, 'utf8')));
  } catch (e) {
    return defaultSemantic();
  }
}
function saveSemantic(cfg) {
  try {
    fs.writeFileSync(SEM_JSON, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}
function semPostJson(url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (err, data) => { if (!done) { done = true; resolve({ err: err, data: data }); } };
    let u;
    try { u = new URL(url); } catch (e) { return fin(new Error('bad endpoint'), null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, headers || {})
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 4 * 1024 * 1024) req.destroy(); });
      res.on('end', () => fin(null, data));
      res.on('error', (err) => fin(err, null));
    });
    req.on('error', (err) => fin(err, null));
    req.setTimeout(Number(timeoutMs) || 15000, () => { req.destroy(); fin(new Error('timeout'), null); });
    req.end(body);
  });
}
// 语义兜底：本地词表未命中时才调用；开关关/未配置时不干涉（仅无扩展作用）；一旦启用，超时/报错/响应异常一律按「无法确认安全」拦截（fail-closed），绝不因接口故障放行
function semanticReview(text) {
  const cfg = loadSemantic();
  if (!cfg.enable || !cfg.endpoint) return Promise.resolve({ hits: [], details: [] });
  if (!isAllowedHttps(cfg.endpoint)) {
    return Promise.resolve({
      hits: ['semantic'],
      details: [{ id: 'semantic', reason: '语义接口地址非 HTTPS（fail-closed 拦截，未发送）', snippet: String(text).slice(0, 120) }],
      err: 'endpoint not https'
    });
  }
  const payload = JSON.stringify({
    model: cfg.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: cfg.prompt || '你是内容安全审查器，只输出 JSON。' },
      { role: 'user', content: '待审文本：\n' + String(text).slice(0, 2000) }
    ],
    temperature: 0,
    max_tokens: 64
  });
  const headers = {};
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  return semPostJson(cfg.endpoint, headers, payload, cfg.timeoutMs || 15000).then((r) => {
    if (r.err || !r.data) {
      const em = String((r.err && r.err.message) || r.err || 'no response');
      return Promise.resolve({
        hits: ['semantic'],
        details: [{ id: 'semantic', reason: '语义兜底不可用（' + em + '），fail-closed拦截', snippet: String(text).slice(0, 120) }],
        err: em
      });
    }
    let j = null;
    try { j = JSON.parse(r.data); } catch (e) {
      return Promise.resolve({
        hits: ['semantic'],
        details: [{ id: 'semantic', reason: '语义接口响应异常（bad response），fail-closed拦截', snippet: String(text).slice(0, 120) }],
        err: 'bad response'
      });
    }
    let content = '';
    try { content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''; } catch (e) { content = ''; }
    let verdict = null;
    const m = String(content).match(/\{[\s\S]*\}/);
    try { verdict = JSON.parse(m ? m[0] : content); } catch (e) { verdict = null; }
    if (verdict && verdict.hit) {
      return Promise.resolve({
        hits: ['semantic'],
        details: [{ id: 'semantic', reason: String(verdict.reason || '语义审查命中'), snippet: String(text).slice(0, 120) }]
      });
    }
    return Promise.resolve({ hits: [], details: [] });
  });
}

// ===== MCP 扫描（仅用于“登记发现”，不做任何接管，不改任何配置）=====
function collectAllMcpEndpoints(cfg) {
  const found = [];
  const seen = new Set();
  const servers = (cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object') ? cfg.mcpServers : {};
  for (const rid of Object.keys(servers)) {
    const node = servers[rid];
    if (!node || typeof node !== 'object') continue;
    const ep = (node.endpoint || node.url || node.sseUrl || null);
    if (typeof ep === 'string' && /^https?:\/\//i.test(ep)) {
      if (!seen.has(rid)) {
        seen.add(rid);
        found.push({ id: rid, node: node, endpoint: ep });
      }
    }
  }
  return found;
}

// ===== 接管集合（v2.0.6 审核修复）：仅本插件登记在册（routes.json 中 bridge_deploy=true）且仍存在于 mcpServers 的条目 =====
// deploy/rollback/route 一律只作用于该集合，与“回退仅还原登记条目”的安全承诺完全一致；无关配置绝不触碰。
function collectMcpEndpoints(cfg) {
  const routes = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'routes.json'), 'utf8')).routes || {}; } catch (e) { return {}; } })();
  const servers = (cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object') ? cfg.mcpServers : {};
  const found = [];
  for (const rid of Object.keys(routes)) {
    const r = routes[rid];
    if (!r || r.bridge_deploy !== true) continue;
    const node = servers[rid];
    if (!node || typeof node !== 'object') continue;
    const ep = (node.endpoint || node.url || node.sseUrl || r.original_endpoint || null);
    if (typeof ep === 'string' && /^https?:\/\//i.test(ep)) {
      found.push({ id: rid, node: node, endpoint: ep });
    }
  }
  return found;
}

//心跳：面板经文件通道读取在线状态（宿主 WebView 不直连 proot 端口）
const HB_FILE = path.join(DATA_DIR, 'heartbeat.json');
function heartbeat() {
  try {
    fs.writeFileSync(HB_FILE, JSON.stringify({ t: Date.now(), pid: process.pid }));
  } catch (e) {}
}
heartbeat();
setInterval(heartbeat, 8000);

// ===== 管理端点鉴权（本地令牌 admin_token.json, 0600） =====
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin_token.json');
function loadAdminToken() {
  try {
    const t = JSON.parse(fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8'));
    if (t && typeof t.token === 'string' && t.token.length >= 16) return t.token;
  } catch (e) {}
  try {
    const crypto = require('crypto');
    const tok = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(ADMIN_TOKEN_FILE, JSON.stringify({ token: tok, created_at: Date.now() }), { mode: 0o600 });
    return tok;
  } catch (e) { return ''; }
}
const ADMIN_TOKEN = loadAdminToken();
// ===== 本机会话令牌（v2.0.7：面板免读令牌文件，Shizuku 零依赖） =====
const SESSION_TOKENS = new Map(); // token -> expiresAt
const SESSION_TTL = 30 * 60 * 1000; // 30 分钟
function issueSessionToken() {
  const crypto = require('crypto');
  const tok = crypto.randomBytes(24).toString('hex');
  SESSION_TOKENS.set(tok, Date.now() + SESSION_TTL);
  return tok;
}
function sessionValid(tok) {
  if (!tok) return false;
  const exp = SESSION_TOKENS.get(tok);
  if (!exp) return false;
  if (Date.now() > exp) { SESSION_TOKENS.delete(tok); return false; }
  return true;
}
function isLoopbackReq(req) {
  try {
    const addr = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr === '';
  } catch (e) { return false; }
}
function adminAuthorized(req, body) {
  try {
    const h = String(req.headers['x-mo-admin-token'] || '');
    if (h && ((ADMIN_TOKEN && h === ADMIN_TOKEN) || sessionValid(h))) return true;
    let b = body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
    if (b && b._token && ((ADMIN_TOKEN && b._token === ADMIN_TOKEN) || sessionValid(b._token))) return true;
  } catch (e) {}
  return false;
}
function adminDeny(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: false, message: '管理操作需本地令牌（admin_token.json）：一切 /admin/* 读写（含 /admin/fs）均须携带 X-MO-Admin-Token 或 _token，请通过持有凭据的客户端或面板调用' }));
}
function isAllowedHttps(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    const host = String(u.hostname || '').toLowerCase();
    if (u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) return true;
  } catch (e) {}
  return false;
}
const server = http.createServer(async (req, res) => {
  // CORS：仅允许本机来源（无 Origin / localhost / 127.0.0.1 / ::1 / file:// 应用内页面），
  // 其他来源一律不授予跨域读取（浏览器将拦截响应）；杜绝任意网页或 WebView 跨域读取凭据。
  const reqOrigin = String(req.headers.origin || '').trim();
  const isLocalOrigin = !reqOrigin ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(reqOrigin) ||
    reqOrigin.indexOf('file://') === 0 ||
    reqOrigin.toLowerCase() === 'null';
  if (isLocalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin || 'null');
    if (reqOrigin) res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MO-Admin-Token');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const urlPath = (req.url || '').split('?')[0];
  loadState();
  // ===== 本机会话握手（v2.0.7）：仅本机回环来源可换取短期会话令牌 =====
  // 面板/客户端无需读取本地 admin_token.json，凭本机来源握手获得 30 分钟短效授权；
  // 服务仅监听 127.0.0.1（不对外），外部网络无法触达该端点，凭据暴露面小于文件方案。
  if (req.method === 'POST' && urlPath === '/auth/session') {
    if (!isLoopbackReq(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, message: '仅限本机来源' }));
    }
    const tok = issueSessionToken();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, token: tok, ttl: SESSION_TTL }));
  }
  // 管理端点：统一读取 body、执行令牌鉴权（所有 /admin/* 读写一律鉴权，含 /admin/fs）
  let adminBody = null;
  if (urlPath.indexOf('/admin/') === 0) {
    const raw = await readBody(req);
    try { adminBody = JSON.parse(raw || '{}'); } catch (e) { adminBody = {}; }
    if (!adminAuthorized(req, adminBody)) return adminDeny(res);
  }

  // 状态页（仅本机）
  if (req.method === 'GET' && urlPath === '/state') {
    const routes = loadJson('routes.json') || { routes: {} };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      alive: true,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      ts: Date.now(),
      enabled: state.enabled,
      port: PORT,
      blocked_total: state.blocked_total,
      routes: Object.keys(routes.routes || {}).map((k) => ({
        id: k,
        enabled: routes.routes[k].enabled !== false,
        scope: routes.routes[k].scope || 'public',
      })),
    }));
  }

  // 手动检查接口：任何平台包都可在发言前调用
  if (req.method === 'POST' && urlPath === '/check') {
    const body = await readBody(req);
    let scope = 'public';
    let checkTextSrc = body;
    try {
      const j = JSON.parse(body);
      if (j && j.scope === 'internal') scope = 'internal';
      if (j && typeof j.text === 'string') checkTextSrc = j.text;
    } catch (e) { /* 非 JSON 也照常扫 */ }
    const result = checkText(checkTextSrc, scope);
    if (result.hits.length === 0) {
      try {
        const sem = await semanticReview(checkTextSrc);
        result.hits = result.hits.concat(sem.hits || []);
        result.details = result.details.concat(sem.details || []);
        if (sem.err) result.semantic_err = sem.err;
      } catch (e) {
        // fail-closed：语义兜底异常也未确认安全，按拦截处理
        result.hits.push('semantic');
        result.details.push({ id: 'semantic', reason: '语义兜底异常（fail-closed拦截）', snippet: String(checkTextSrc).slice(0, 120) });
        result.semantic_err = String((e && e.message) || e);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ allowed: result.hits.length === 0, hits: result.hits, details: result.details, whitelist_applied: result.whitelist_applied || [], semantic_err: result.semantic_err || null }));
  }

  // ===== 管理端点 =====
  // 文件 IO（白名单：仅 DATA_DIR 下的 JSON）
  if (req.method === 'POST' && urlPath === '/admin/fs') {
    try {
      const body = adminBody || {};
      const file = String(body.file || '').replace(/^.*[\/]/, ''); // 只取文件名
      const ALLOWED = ['rules.json','custom_rules.json','custom_routes.json','routes.json','state.json','heartbeat.json','blocked_log.json','default_rules.json','semantic.json']; // admin_token.json 严禁列入：令牌不可经fs泄露
      if (ALLOWED.indexOf(file) < 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: '文件不在白名单: ' + file }));
      }
      if (body.op === 'read') {
        const content = fs.existsSync(path.join(DATA_DIR, file)) ? fs.readFileSync(path.join(DATA_DIR, file), 'utf8') : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, content: content }));
      }
      if (body.op === 'write') {
        fs.writeFileSync(path.join(DATA_DIR, file), String(body.content || ''), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: String(e && e.message || e) }));
    }
  }
  // 登记（仅写本插件 routes.json，绝不修改 mcp_config.json）：建立 deploy/rollback/route 的作用域集合
  // v2.0.6 审核修复：所有接管/还原操作仅作用于本集合，杜绝触碰无关 MCP 配置。
  if (req.method === 'POST' && urlPath === '/admin/register') {
    try {
      const MCP = process.env.MO_MCP_CONFIG || '/sdcard/Download/Operit/mcp_plugins/mcp_config.json';
      if (!fs.existsSync(MCP)) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:'MCP 配置未找到: '+MCP})); }
      const cfg = JSON.parse(fs.readFileSync(MCP, 'utf8'));
      const body = adminBody || {};
      let onlyIds = null;
      try { if (Array.isArray(body.ids)) onlyIds = body.ids.map(String); } catch (e) {}
      const all = collectAllMcpEndpoints(cfg);
      const routesConf = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'routes.json'),'utf8')); } catch(e) { return { routes: {} }; } })();
      if (!routesConf.routes) routesConf.routes = {};
      const added = [];
      for (const item of all) {
        if (onlyIds && onlyIds.indexOf(item.id) < 0) continue;
        const rid = item.id;
        const already = routesConf.routes[rid];
        if (already && already.bridge_deploy === true) continue; // 已登记，跳过
        routesConf.routes[rid] = routesConf.routes[rid] || {};
        routesConf.routes[rid].target = item.endpoint;
        routesConf.routes[rid].original_endpoint = item.endpoint;
        routesConf.routes[rid].enabled = false;
        routesConf.routes[rid].scope = 'public';
        routesConf.routes[rid].bridge_deploy = true;
        routesConf.routes[rid].registered_at = Date.now();
        added.push(rid);
      }
      fs.writeFileSync(path.join(DATA_DIR,'routes.json'), JSON.stringify(routesConf, null, 2), 'utf8');
      const totalReg = Object.keys(routesConf.routes).filter((k) => routesConf.routes[k] && routesConf.routes[k].bridge_deploy === true).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, added: added, total_registered: totalReg, message: '已登记 ' + added.length + ' 个路由（本插件路由表共 ' + totalReg + ' 个；未修改任何 MCP 配置）' }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: String(e && e.message || e) }));
    }
  }
  // 部署（桥模式）：仅接管本插件登记集合（routes.json 中 bridge_deploy=true），生成本地 stdio 桥；验证秒过不依赖8095/终端
  if (req.method === 'POST' && urlPath === '/admin/deploy') {
    try {
      const MCP = process.env.MO_MCP_CONFIG || '/sdcard/Download/Operit/mcp_plugins/mcp_config.json';
      if (!fs.existsSync(MCP)) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:'MCP 配置未找到: '+MCP})); }
      const cfg = JSON.parse(fs.readFileSync(MCP, 'utf8'));
      const PREFIX = 'http://127.0.0.1:' + PORT + '/proxy/';
      const BRIDGE = '/root/mcp_bridge.js';
      // 确保桥文件在 Linux 侧（proot /root）：从代理资源复制
      try {
        const srcBridge = path.join(DATA_DIR, 'resources', 'worker', 'mcp_bridge.js');
        if (fs.existsSync(srcBridge)) { fs.copyFileSync(srcBridge, BRIDGE); }
      } catch (e) { /* 桥不存在则后续桥注册会尝试失败，report中提示 */ }
      const existing = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'routes.json'),'utf8')).routes || {}; } catch(e) { return {}; } })();
      const cfgOld = (() => { try { return JSON.parse(fs.readFileSync(MCP, 'utf8')); } catch(e) { return null; } })();
      const list = collectMcpEndpoints(cfg);
      if (!list.length) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:'暂无登记路由。请先执行登记（/admin/register，或在对话中让 AI 执行 mo_privacy_net:register）。登记只写本插件路由表，不改动任何 MCP 配置。'})); }
      const report = [];
      let changed = false;
      if (!cfg.mcpServers) cfg.mcpServers = {};
      if (!cfg.pluginMetadata) cfg.pluginMetadata = {};
      for (const item of list) {
        const rid = item.id;
        const ep = item.endpoint;
        if (!/^https?:\/\//i.test(ep)) { report.push('SKIP  ' + rid + '（非HTTP，无法接管）'); continue; }
        // 已在桥模式内，跳过
        if (cfg.mcpServers[rid] && String(cfg.mcpServers[rid].args || '').indexOf('mcp_bridge') >= 0) { report.push('KEEP  ' + rid + '（已在桥模式）'); continue; }
        // 还原官方直连地址（旧版部署可能已把它改成8095前缀）
        let origEp = ep;
        const oldRouteEntry = existing[rid];
        if (oldRouteEntry && oldRouteEntry.original_endpoint) origEp = oldRouteEntry.original_endpoint;
        else if (ep.startsWith(PREFIX)) origEp = ep.slice(PREFIX.length).split('?')[0]; // 兜底：无法还原则跳过接管提示
        if (!/^https?:\/\//i.test(origEp) && ep.startsWith(PREFIX)) { report.push('WARN  ' + rid + '（原始地址不可推断，保持当前）'); origEp = ep; }
        let token = null;
        const node = item.node;
        if (node.bearerToken) { token = { type: 'header', header: 'Authorization', prefix: 'Bearer ', value: node.bearerToken }; }
        else {
          try {
            const qs = new URL(ep);
            if (qs.searchParams.has('token')) { token = { type: 'query', key: 'token', value: qs.searchParams.get('token') }; }
          } catch (e) { /* ignore */ }
        }
        // 1) 注册本地 stdio 桥（验证秒过，业务经8095拦截）；node 低堆瘦身
        cfg.mcpServers[rid] = {
          command: 'node',
          args: ['--max-old-space-size=16', BRIDGE, '--route', rid],
          env: {}
        };
        // 2) 远程条目挂起（避免双份验证）
        if (cfg.pluginMetadata[rid]) {
          const pm = cfg.pluginMetadata[rid];
          existing[rid] = existing[rid] || {};
          existing[rid].orig_disabled = pm.disabled === true;
          existing[rid].orig_endpoint_field = pm.endpoint;
          pm.disabled = true;
          pm.endpoint = origEp; // 挂起时endpoint冗余存储为官方地址（未被使用）
          report.push('BRIDGE ' + rid + ' -> 本地stdio桥接入（远程已挂起）');
        } else {
          report.push('BRIDGE ' + rid + ' -> 本地stdio桥接入');
        }
        existing[rid] = existing[rid] || {};
        existing[rid].target = origEp;
        if (token) existing[rid].token = token;
        existing[rid].headers = (node.headers && typeof node.headers === 'object' && Object.keys(node.headers).length) ? node.headers : null;
        existing[rid].enabled = true;
        existing[rid].scope = 'public';
        existing[rid].original_endpoint = origEp;
        existing[rid].bridge_deploy = true;
        existing[rid].deployed_at = Date.now();
        changed = true;
      }
      if (changed) {
        const bak = MCP + '.guardbak.' + new Date().toISOString().replace(/[-:T]/g,'').slice(0,14);
        fs.copyFileSync(MCP, bak);
        fs.writeFileSync(MCP, JSON.stringify(cfg, null, 2), 'utf8');
        report.push('BACKUP -> ' + bak);
      } else {
        report.push('DEPLOY_NOTHING');
      }
      fs.writeFileSync(path.join(DATA_DIR,'routes.json'), JSON.stringify({version:2, proxy_prefix:PREFIX, bridge_js:BRIDGE, routes:existing}, null, 2), 'utf8');
      loadState(); state.enabled = true; saveJson('state.json', state);
      report.push('STATE  -> enabled（拦截开关已开启 = 部署状态）');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: report.join('\n') }));
    } catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:String(e&&e.message||e)})); }
  }
  // 回退：清除全部已部署（本地桥移除 + 远程条目还原 + 路由表清空 + 拦截开关关闭）
  if (req.method === 'POST' && urlPath === '/admin/rollback') {
    try {
      const MCP = process.env.MO_MCP_CONFIG || '/sdcard/Download/Operit/mcp_plugins/mcp_config.json';
      const PREFIX = 'http://127.0.0.1:' + PORT + '/proxy/';
      const routes = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'routes.json'),'utf8')).routes || {}; } catch(e) { return {}; } })();
      const cfg = JSON.parse(fs.readFileSync(MCP, 'utf8'));
      let changed = false; const report = [];
      // 1) 删除本地 stdio 桥条目（仅本插件登记在册的 bridge_deploy 条目）
      if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
        for (const rid of Object.keys(routes)) {
          const rt = routes[rid];
          if (!rt || rt.bridge_deploy !== true) continue;
          const sv = cfg.mcpServers[rid];
          if (sv && String(sv.args || '').indexOf('mcp_bridge') >= 0) {
            delete cfg.mcpServers[rid];
            changed = true;
            report.push('UNBRIDGE ' + rid + '（本地桥已移除）');
          }
        }
      }
      // 2) 远程条目还原（disabled/endpoint 恢复部署前状态）
      if (cfg.pluginMetadata && typeof cfg.pluginMetadata === 'object') {
        for (const rid of Object.keys(cfg.pluginMetadata)) {
          const pm = cfg.pluginMetadata[rid];
          const rt = routes[rid];
          if (!pm || !rt || !rt.bridge_deploy) continue;
          pm.disabled = rt.orig_disabled === true;
          if (rt.original_endpoint) pm.endpoint = rt.original_endpoint;
          else if (rt.orig_endpoint_field) pm.endpoint = rt.orig_endpoint_field;
          changed = true;
          report.push('RESTORE ' + rid + '（远程已还原）');
        }
      }
      if (changed) { fs.writeFileSync(MCP, JSON.stringify(cfg, null, 2), 'utf8'); }
      else { report.push('ROLLBACK_NOTHING'); }
      fs.writeFileSync(path.join(DATA_DIR,'routes.json'), JSON.stringify({version:2, proxy_prefix:PREFIX, routes:{}}, null, 2), 'utf8');
      report.push('ROUTES  -> cleared（已登记路由全部清除，还原官方直连）');
      // 自定义端口同样全部退回（enabled=false，保留登记信息）
      try {
        const cr = loadJson('custom_routes.json');
        if (cr && cr.routes) {
          let n = 0;
          for (const k of Object.keys(cr.routes)) { if (cr.routes[k].enabled) { cr.routes[k].enabled = false; n++; } }
          if (n > 0) { saveJson('custom_routes.json', cr); report.push('CUSTOM  -> ' + n + ' 个端口已退回'); }
          else { report.push('CUSTOM  -> 无启用的自定义端口'); }
        }
      } catch (e) {}
      loadState(); state.enabled = false; saveJson('state.json', state);
      report.push('STATE  -> disabled（拦截开关已关闭 = 退回官方直连）');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: report.join('\n') }));
    } catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:String(e&&e.message||e)})); }
  }
  // 单路由开关：开 = 该 MCP 接入拦截网；关 = 该 MCP 退回官方直连（路由仍保留，可再开）
  if (req.method === 'POST' && urlPath === '/admin/route') {
    try {
      const body = adminBody || {};
      const rid = String(body.id || '');
      const wantEnabled = body.enabled !== false;
      const MCP = process.env.MO_MCP_CONFIG || '/sdcard/Download/Operit/mcp_plugins/mcp_config.json';
      const PREFIX = 'http://127.0.0.1:' + PORT + '/proxy/';
      const routesConf = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'routes.json'),'utf8')); } catch(e) { return { routes: {} }; } })();
      const route = (routesConf.routes || {})[rid];
      if (!route || !route.original_endpoint) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: '路由不存在：' + rid }));
      }
      const cfg = JSON.parse(fs.readFileSync(MCP, 'utf8'));
      let hit = false;
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        for (const k of Object.keys(node)) {
          const v = node[k];
          if (typeof v === 'string' && (v === PREFIX + rid || v === route.original_endpoint)) {
            node[k] = wantEnabled ? PREFIX + rid : route.original_endpoint;
            hit = true;
          } else if (v && typeof v === 'object') {
            walk(v);
          }
        }
      })(cfg);
      if (hit) { fs.writeFileSync(MCP, JSON.stringify(cfg, null, 2), 'utf8'); }
      route.enabled = wantEnabled;
      fs.writeFileSync(path.join(DATA_DIR,'routes.json'), JSON.stringify(routesConf, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: wantEnabled ? '已接入拦截网' : '已退回官方直连' }));
    } catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:String(e&&e.message||e)})); }
  }
  // 路由语义扩展开关（MCP 路由级：semantic_enabled）
  if (req.method === 'POST' && urlPath === '/admin/route-semantic') {
    try {
      const body = adminBody || {};
      const rid = String(body.id || '');
      const want = body.enabled === true;
      const routesConf = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR,'routes.json'),'utf8')); } catch(e) { return { routes: {} }; } })();
      const route = (routesConf.routes || {})[rid];
      if (!route) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: '路由不存在：' + rid }));
      }
      route.semantic_enabled = want;
      fs.writeFileSync(path.join(DATA_DIR,'routes.json'), JSON.stringify(routesConf, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: want ? '语义扩展已开启（需全局API已配置才生效）' : '语义扩展已关闭' }));
    } catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:String(e&&e.message||e)})); }
  }
  // 自定义端口管理（custom_routes.json，独立于 MCP 路由表）
  if (req.method === 'POST' && urlPath === '/admin/custom-route') {
    try {
      const body = adminBody || {};
      const op = String(body.op || '');
      const CUSTOM_FILE = path.join(DATA_DIR, 'custom_routes.json');
      const cr = (() => { try { return JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch (e) { return { routes: {} }; } })();
      cr.routes = cr.routes || {};
      if (op === 'list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, routes: cr.routes }));
      }
      if (op === 'add') {
        const name = String(body.name || '').trim();
        const target = String(body.target || '').trim();
        if (!name || !/^https?:\/\//i.test(target)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, message: '名称或目标地址无效（目标需 http(s):// 开头）' }));
        }
        if (!isAllowedHttps(target)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, message: '自定义端口目标必须使用 HTTPS（本地回环 http://127.0.0.1 / localhost 除外）' }));
        }
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'port';
        const id = 'custom-' + safeName + '-' + String(Date.now()).slice(-4);
        cr.routes[id] = { name: name, target: target, enabled: false, scope: 'public', semantic_enabled: false, created_at: Date.now() };
        fs.writeFileSync(CUSTOM_FILE, JSON.stringify(cr, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, id: id, message: '端口已登记（默认关闭，可一键部署纳入）' }));
      }
      if (op === 'remove') {
        const rid = String(body.id || '');
        if (cr.routes[rid]) {
          delete cr.routes[rid];
          fs.writeFileSync(CUSTOM_FILE, JSON.stringify(cr, null, 2), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, message: '端口已删除' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: '端口不存在：' + rid }));
      }
      if (op === 'toggle') {
        const rid = String(body.id || '');
        const want = body.enabled !== false;
        const r = cr.routes[rid];
        if (!r) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, message: '端口不存在：' + rid }));
        }
        r.enabled = want;
        fs.writeFileSync(CUSTOM_FILE, JSON.stringify(cr, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: want ? '端口已接入拦截网（机械检查生效）' : '端口已退回（直连目标）' }));
      }
      if (op === 'semantic') {
        const rid = String(body.id || '');
        const want = body.enabled === true;
        const r = cr.routes[rid];
        if (!r) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, message: '端口不存在：' + rid }));
        }
        r.semantic_enabled = want;
        fs.writeFileSync(CUSTOM_FILE, JSON.stringify(cr, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: want ? '语义扩展已开启（需全局API已配置才生效）' : '语义扩展已关闭' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: '未知操作：' + op }));
    } catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:String(e&&e.message||e)})); }
  }
  // 语义 API 配置读写（独立入口：读取/保存，含测试结果）
  if (req.method === 'POST' && urlPath === '/admin/semantic') {
    try {
      const body = adminBody || {};
      if (body.op === 'save') {
        const cur = loadSemantic();
        const cfg = body.config || {};
        const epRaw = String(cfg.endpoint || '').trim();
        if (epRaw && !isAllowedHttps(epRaw)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, message: '语义接口地址必须使用 HTTPS（本地回环 http://127.0.0.1 / localhost 除外）' }));
        }
        const merged = Object.assign(cur, {
          enable: !!cfg.enable,
          endpoint: String(cfg.endpoint || '').trim(),
          apiKey: String(cfg.apiKey || '').trim(),
          model: String(cfg.model || '').trim(),
          timeoutMs: Math.max(1000, Math.min(60000, Number(cfg.timeoutMs) || 6000)),
          prompt: String(cfg.prompt || cur.prompt)
        });
        saveSemantic(merged);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: '语义配置已保存（热生效）', config: merged }));
      }
      const cfg = loadSemantic();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, config: cfg }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: String(e && e.message || e) }));
    }
  }
  // 语义连通性测试：用样例文本走一遍接口，结果写入 last_test
  if (req.method === 'POST' && urlPath === '/admin/semantic-test') {
    try {
      const body = adminBody || {};
      const cfg = loadSemantic();
      if (!cfg.endpoint) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: '请先填写语义接口地址再测试' }));
      }
      const sample = String(body.text || '测试文本：她在床上轻声喘息，双腿夹紧。');
      const t0 = Date.now();
      const sem = await semanticReview(sample);
      const cost = Date.now() - t0;
      cfg.last_test = {
        t: Date.now(),
        ok: sem.hits.length > 0,
        message: sem.err ? ('接口异常（fail-closed：将拦截，绝不放行）：' + sem.err) : (sem.hits.length > 0 ? ('已识别违规语义：' + (sem.details[0] && sem.details[0].reason || '命中')) : '接口正常，样例未命中')
      };
      saveSemantic(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result: cfg.last_test, costMs: cost, hits: sem.hits, details: sem.details, err: sem.err || null }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: String(e && e.message || e) }));
    }
  }
  // 恢复内置规则
  if (req.method === 'POST' && urlPath === '/admin/restore') {
    try {
      const defSrc = fs.existsSync(path.join(DATA_DIR,'default_rules.json')) ? path.join(DATA_DIR,'default_rules.json') : BUILTIN_RULES;
      const def = JSON.parse(fs.readFileSync(defSrc, 'utf8'));
      if (!def || !def.scope || !def.scope.public) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:'默认规则文件不存在或损坏'})); }
      const cur = JSON.parse(fs.readFileSync(path.join(DATA_DIR,'rules.json'),'utf8')) || { scope: {} };
      cur.scope = cur.scope || {};
      cur.scope.public = cur.scope.public || {};
      const defHard = def.scope.public.hard_rules || [];
      const curHard = cur.scope.public.hard_rules || [];
      const ids = {}; curHard.forEach(r => { ids[r.id] = 1; });
      let added = 0;
      defHard.forEach(r => { if (!ids[r.id]) { curHard.push(r); added++; ids[r.id] = 1; } });
      cur.scope.public.hard_rules = curHard;
      const defPair = def.pair_rules || [];
      const curPair = cur.pair_rules || [];
      const pids = {}; curPair.forEach(r => { pids[r.id || (r.keywords||[]).join('|')] = 1; });
      let addedPair = 0;
      defPair.forEach(r => { const pid = r.id || (r.keywords||[]).join('|'); if (!pids[pid]) { curPair.push(r); addedPair++; pids[pid]=1; } });
      cur.pair_rules = curPair;
      fs.writeFileSync(path.join(DATA_DIR,'rules.json'), JSON.stringify(cur, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: '已恢复内置规则 ' + added + ' 条、配对规则 ' + addedPair + ' 条' }));
    } catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:String(e&&e.message||e)})); }
  }
  // 恢复内置白名单（与内置规则同构：把 default_rules.json 的 builtin_whitelist 并入运行时 rules.json）
  if (req.method === 'POST' && urlPath === '/admin/restore-whitelist') {
    try {
      const defSrc = fs.existsSync(path.join(DATA_DIR,'default_rules.json')) ? path.join(DATA_DIR,'default_rules.json') : BUILTIN_RULES;
      const def = JSON.parse(fs.readFileSync(defSrc, 'utf8'));
      function collectItems(g) {
        if (Array.isArray(g)) return g.slice();
        if (g && g.items && Array.isArray(g.items)) return g.items.slice();
        return [];
      }
      function mergeDedup(arr, src) {
        src.forEach(function (p) { if (arr.indexOf(p) < 0) arr.push(p); });
        return arr;
      }
      const defObj = def.builtin_whitelist;
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(path.join(DATA_DIR,'rules.json'),'utf8')) || {}; } catch (e2) { cur = {}; }
      const curObj = cur.builtin_whitelist;
      const nextWl = {
        nsfw: { desc: 'NSFW误杀组（含操/逼的合法词）', items: [] },
        common: { desc: '通用组（多义词/日常用语）', items: [] }
      };
      if (Array.isArray(curObj)) { nextWl.nsfw.items = curObj.slice(); }
      else if (curObj) {
        nextWl.nsfw.items = collectItems(curObj.nsfw).concat(collectItems(curObj.cao)).concat(collectItems(curObj.bi));
        nextWl.common.items = collectItems(curObj.common);
      }
      let added = 0;
      if (Array.isArray(defObj)) {
        var before = nextWl.nsfw.items.length;
        mergeDedup(nextWl.nsfw.items, defObj);
        added += nextWl.nsfw.items.length - before;
      } else if (defObj) {
        added += (defObj.nsfw ? defObj.nsfw.items.filter(function (p) { return nextWl.nsfw.items.indexOf(p) < 0; }).length : 0);
        added += (defObj.common ? defObj.common.items.filter(function (p) { return nextWl.common.items.indexOf(p) < 0; }).length : 0);
        mergeDedup(nextWl.nsfw.items, collectItems(defObj.nsfw));
        mergeDedup(nextWl.common.items, collectItems(defObj.common));
      }
      cur.builtin_whitelist = nextWl;
      fs.writeFileSync(path.join(DATA_DIR,'rules.json'), JSON.stringify(cur, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: '已恢复内置白名单 ' + added + ' 条' }));
    } catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,message:String(e&&e.message||e)})); }
  }

  // 泛路由匹配
  const m = (req.url || '').match(/^\/proxy\/([^/?]+)/);
  console.log('[MO-guard] ' + new Date().toISOString() + ' REQ ' + req.method + ' ' + (req.url || '') + ' ua=' + String(req.headers['user-agent'] || '').slice(0, 40));
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'guard-proxy: unknown path, expect /proxy/<route-id>' }));
  }
  const routeId = m[1];
  const routesConf = loadJson('routes.json') || { routes: {} };
  let route = routesConf.routes && routesConf.routes[routeId];
  let isCustom = false;
  if (!route && routeId.indexOf('custom-') === 0) {
    const customConf = loadJson('custom_routes.json') || { routes: {} };
    route = customConf.routes && customConf.routes[routeId];
    isCustom = true;
  }
   if (!route || route.enabled === false) {
    // disabled = 退回官方直连（不检查、不拦截，工具照常；保留路由可再开）
    if (route && route.original_endpoint) {
      const directRoute = Object.assign({}, route, { target: route.original_endpoint });
      // v2.0.7-fix3: 放行分支 POST 必须带原始 body（否则官方端点收空 body 无法解析，MCP 工具调用全失败）
      if (req.method === 'GET' || req.method === 'HEAD') {
        return forward(routeId, directRoute, req, '', res);
      }
      const directBody = await readBody(req);
      return forward(routeId, directRoute, req, directBody, res);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'guard-proxy: route not found or disabled: ' + routeId }));
  }
   // GET/HEAD（含 SSE 订阅流）无出站内容：直接管道透传，避免 readBody 挂起 Operit 的验证/订阅请求
   if (req.method === 'GET' || req.method === 'HEAD') {
     return forward(routeId, route, req, '', res);
   }
   const body = await readBody(req);

  // 总开关（拦截开关）：关闭 = 纯转发不检查（等效官方直连，MCP 零影响）
  if (!state.enabled) {
    return forward(routeId, route, req, body, res);
  }
  // 内容检查
  const scope = route.scope || 'public';
  const result = checkText(body, scope);
  if (result.hits.length === 0) {
    // 语义扩展三重开关：全局 semantic.json enable+endpoint 已配置，且该路由 semantic_enabled=true，才触发
    const semCfg = loadSemantic();
    const routeSem = route.semantic_enabled === true;
    if (routeSem && semCfg.enable && semCfg.endpoint) {
      try {
        const sem = await semanticReview(body);
        result.hits = result.hits.concat(sem.hits || []);
        result.details = result.details.concat(sem.details || []);
      } catch (e) {
        // fail-closed：语义兜底异常也未确认安全，按拦截处理
        result.hits.push('semantic');
        result.details.push({ id: 'semantic', reason: '语义兜底异常（fail-closed拦截）', snippet: String(body).slice(0, 120) });
      }
    }
  }
  if (result.hits.length > 0) {
    recordBlock(routeId, result, body);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'blocked by MO-privacy-net', hits: result.hits, details: result.details, note: 'This block is user-mandated by the device owner via MO Privacy Net (用户强制要求的拦截，非代理自主行为)' }));
  }

  forward(routeId, route, req, body, res);
});

server.on('error', (err) => {
  // 防多实例争抢：端口已有实例在听（EADDRINUSE）时静默退出，不刷崩溃日志；其余错误照常记录
  if (err && err.code === 'EADDRINUSE') {
    console.log('[MO-guard] port ' + PORT + ' already in use by another instance, exiting quietly.');
    process.exit(0);
  }
  console.error('[MO-guard] server error:', err && err.message || err);
});
server.listen(PORT, '127.0.0.1', () => {
  try {
    state.pid = process.pid;
    state.updated_at = Date.now();
    saveJson('state.json', state);
  } catch (e) {}
  console.log('[MO-guard] listening on 127.0.0.1:' + PORT);
});