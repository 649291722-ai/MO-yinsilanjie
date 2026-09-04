#!/usr/bin/env python3
# MO隐私拦截网 · 部署脚本（通用版）
# 原则：
#   - 不内置任何平台特判；接管范围 = pluginMetadata 中所有远程 endpoint - 用户豁免清单(exempt.json)
#   - 纯本地操作：只改本机 MCP 配置 + 写本地路由表，不触碰平台、不扫描平台、不重试轰炸
#   - 可随时由 rollback.py 无感还原
import json
import os
import shutil
import subprocess
import sys
import time
from urllib.parse import urlparse, parse_qs

MCP_CONFIG = '/sdcard/Download/Operit/mcp_plugins/mcp_config.json'
DATA_DIR = '/sdcard/Download/Operit/plugins/mo_privacy_net'
DEV_DIR = '/sdcard/Download/Operit/dev_package/mo_privacy_net'
PKG_DIR = '/sdcard/Download/Operit/plugins/com.mo.privacy_net'
ROUTES_FILE = os.path.join(DATA_DIR, 'routes.json')
EXEMPT_FILE = os.path.join(DATA_DIR, 'exempt.json')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
RULES_DST = os.path.join(DATA_DIR, 'rules.json')
# 内置文件候选路径：包安装目录优先，dev 目录兜底（分发后 dev 目录不存在）
CANDIDATE_RULES = [
    os.path.join(PKG_DIR, 'resources', 'rules', 'default_rules.json'),
    os.path.join(DEV_DIR, 'resources', 'rules', 'default_rules.json'),
]
CANDIDATE_WORKERS = [
    os.path.join(PKG_DIR, 'resources', 'worker', 'proxy.js'),
    os.path.join(DEV_DIR, 'resources', 'worker', 'proxy.js'),
]
PROXY_PREFIX = 'http://127.0.0.1:8095/proxy/'


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def save(p, obj):
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    # 用户豁免清单
    exempt = []
    if os.path.exists(EXEMPT_FILE):
        try:
            exempt = [str(x).strip().lower() for x in load(EXEMPT_FILE).get('exempt', []) if x]
        except Exception:
            exempt = []

    cfg = load(MCP_CONFIG)
    meta = cfg.get('pluginMetadata', {}) or {}

    routes = {}
    if os.path.exists(ROUTES_FILE):
        try:
            routes = load(ROUTES_FILE).get('routes', {}) or {}
        except Exception:
            routes = {}

    report = []
    changed = False

    for k, v in meta.items():
        if not isinstance(v, dict):
            continue
        rid = v.get('id') or k
        endpoint = v.get('endpoint') or ''
        bearer = v.get('bearerToken') or ''
        headers = v.get('headers') or {}

        if endpoint.startswith(PROXY_PREFIX):
            # 已被接管（幂等保护）：不覆盖路由表已有条目
            report.append('ALREADY  %s' % rid)
            continue
        if not endpoint.startswith('http'):
            report.append('SKIP(no remote)  %s' % rid)
            continue
        host = ''
        try:
            host = (urlparse(endpoint).hostname or '').lower()
        except Exception:
            pass
        if host and any(host == e or host.endswith('.' + e) for e in exempt):
            report.append('SKIP(exempt)  %s  (%s)' % (rid, endpoint[:60]))
            continue

        # token 解析：header 型或 query 型
        token = None
        up = urlparse(endpoint)
        qs = parse_qs(up.query)
        if bearer:
            token = {'type': 'header', 'header': 'Authorization', 'prefix': 'Bearer ', 'value': bearer}
        elif 'token' in qs:
            token = {'type': 'query', 'key': 'token', 'value': qs['token'][0]}

        routes[rid] = {
            'target': endpoint,
            'token': token,
            'headers': headers if isinstance(headers, dict) and headers else None,
            'enabled': True,
            'scope': 'public',
            'original_endpoint': endpoint,
            'deployed_at': int(time.time() * 1000),
        }
        v['endpoint'] = PROXY_PREFIX + rid
        changed = True
        report.append('ROUTE  %s  ->  %s' % (rid, PROXY_PREFIX + rid))

    if not changed:
        print('DEPLOY_NOTHING: 没有新的远程路由需要接管（可能已部署或全部豁免）')
    else:
        bak = MCP_CONFIG + '.guardbak.' + time.strftime('%Y%m%d_%H%M%S')
        shutil.copy2(MCP_CONFIG, bak)
        save(MCP_CONFIG, cfg)
        print('BACKUP ->', bak)

    # 路由表（含 token，收紧权限）
    save(ROUTES_FILE, {'version': 1, 'proxy_prefix': PROXY_PREFIX, 'routes': routes})
    os.chmod(ROUTES_FILE, 0o600)
    print('ROUTES_FILE ->', ROUTES_FILE, '(chmod 600), route count:', len(routes))

    # 规则库就位（用户已改过则不覆盖）
    if not os.path.exists(RULES_DST):
        for src in CANDIDATE_RULES:
            if os.path.exists(src):
                shutil.copy2(src, RULES_DST)
                print('RULES ->', RULES_DST)
                break

    # worker 就位
    worker_dst = os.path.join(DATA_DIR, 'worker', 'proxy.js')
    os.makedirs(os.path.dirname(worker_dst), exist_ok=True)
    if not os.path.exists(worker_dst):
        for src in CANDIDATE_WORKERS:
            if os.path.exists(src):
                shutil.copy2(src, worker_dst)
                print('WORKER ->', worker_dst)
                break
    else:
        print('WORKER_KEEP ->', worker_dst)

    # 状态文件（保留历史拦截计数）
    state = {'enabled': True, 'blocked_total': 0, 'blocks_by_route': {}, 'port': 8095}
    if os.path.exists(STATE_FILE):
        try:
            old = load(STATE_FILE)
            state['blocked_total'] = old.get('blocked_total', 0)
            state['blocks_by_route'] = old.get('blocks_by_route', {})
        except Exception:
            pass
    state['enabled'] = True
    state['updated_at'] = int(time.time() * 1000)

    # 启动代理（已存活则跳过）
    alive = False
    if state.get('pid'):
        try:
            os.kill(state['pid'], 0)
            alive = True
        except Exception:
            alive = False
    if not alive:
        logf = open(os.path.join(DATA_DIR, 'proxy.log'), 'a')
        p = subprocess.Popen(
            ['node', worker_dst],
            stdout=logf, stderr=logf,
            start_new_session=True,
            cwd=os.path.dirname(worker_dst),
        )
        state['pid'] = p.pid
        state['start_count'] = state.get('start_count', 0) + 1
        print('PROXY_START pid=%d' % p.pid)
    else:
        print('PROXY_ALIVE pid=%d' % state['pid'])

    save(STATE_FILE, state)
    for line in report:
        print(line)
    print('DEPLOY_OK (next: restart MCP services 使客户端按新 endpoint 重连)')


if __name__ == '__main__':
    main()