#!/usr/bin/env node
/*
 * MO-privacy-net MCP-Over-STDIO Bridge
 * 纯被动双向管道：stdio (MCP) <-> HTTP (127.0.0.1:8095/proxy/<routeId>)
 * 只转发，不轮询，空闲零网络。跨进程常驻由部署生成。
 * 用法: node mcp_bridge.js --route <routeId> [--target http://127.0.0.1:8095/proxy/<routeId>]
 */
"use strict";

// ---------- 参数 ----------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const ROUTE = argVal('route', '');
const TARGET = argVal('target', ROUTE ? 'http://127.0.0.1:8095/proxy/' + ROUTE : '');

if (!ROUTE || !TARGET) {
  process.stderr.write('mcp_bridge: missing --route/--target\n');
  process.exit(2);
}

// ---------- IO ----------
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------- HTTP 转发（含 SSE 流式）----------
const http = require('http');
const https = require('https');
function forward(method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(TARGET);
    const lib = u.protocol === 'https:' ? https : http;
    const hdrs = Object.assign({}, headers || {});
    if (hdrs['content-length']) delete hdrs['content-length'];
    const data = body ? Buffer.from(body) : null;
    if (data) hdrs['content-length'] = data.length;
    const req = lib.request({
      method: method || 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: hdrs
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => { chunks.push(c); if (Buffer.concat(chunks).length > 8 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); } });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text, text: text });
      });
    });
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- SSE/JSON 响应解析 ----------
function parseResponse(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const dataLines = [];
  for (const l of lines) {
    if (l.indexOf('data:') === 0) { dataLines.push(l.slice(5).trim()); }
  }
  for (const dl of dataLines) {
    if (dl) { try { return JSON.parse(dl); } catch (e) {} }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

// ---------- rpc 处理 ----------
let requestId = 1;
async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'initialize') {
    // 本地完成：验证/握手不依赖上游
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params && msg.params.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mo-privacy-bridge', version: '1.0.0' }
      }
    });
    return;
  }
  if (msg.method === 'notifications/initialized' || (msg.method || '').startsWith('notifications/')) {
    return; // 通知无需应答
  }
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'tools/list') {
    try {
      const res = await forward('POST', JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'tools/list', params: {} }),
        { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' });
      if (res.status === 200) {
        // 上游404等由内容兜底
        let parsed = null;
        parsed = parseResponse(res.text);
        if (parsed && parsed.result) { send({ jsonrpc: '2.0', id: msg.id, result: parsed.result }); return; }
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
    }
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const arguments_ = (msg.params && msg.params.arguments) || {};
    try {
      const res = await forward('POST', JSON.stringify({
        jsonrpc: '2.0', id: requestId++, method: 'tools/call',
        params: { name: name, arguments: arguments_ }
      }), { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' });
      let parsed = null;
      parsed = parseResponse(res.text);
      if (parsed && parsed.result) {
        send({ jsonrpc: '2.0', id: msg.id, result: parsed.result });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: 'upstream HTTP ' + res.status + ': ' + res.text.slice(0, 500) }],
          isError: res.status !== 200
        }});
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'bridge error: ' + (e && e.message || e) }], isError: true
      }});
    }
    return;
  }
  // 未知方法：尽力转发
  try {
    const res = await forward('POST', JSON.stringify(msg), { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' });
    let parsed = null;
    parsed = parseResponse(res.text);
    if (parsed) send(parsed);
    else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'upstream unreadable: HTTP ' + res.status } });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } });
  }
}

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    handle(msg).catch((e) => {
      if (msg && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } });
    });
  } catch (e) {
    // 忽略无法解析的行（可能是其他协议流量）
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('[bridge] listening via stdio, route=' + ROUTE + ' target=' + TARGET + '\n');