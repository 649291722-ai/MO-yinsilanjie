#!/usr/bin/env python3
# MO隐私拦截网 · 回退脚本（通用版）
# 行为：
#   1. 按 routes.json 的 original_endpoint 还原 MCP 配置（优先）
#   2. routes.json 缺失/不全时，回退最近一次 guardbak 备份（兜底）
#   3. 停掉代理进程
#   4. state.enabled = false
# 纯本地操作，不触碰任何平台。
import glob
import json
import os
import signal
import sys
import time

MCP_CONFIG = '/sdcard/Download/Operit/mcp_plugins/mcp_config.json'
DATA_DIR = '/sdcard/Download/Operit/plugins/mo_privacy_net'
ROUTES_FILE = os.path.join(DATA_DIR, 'routes.json')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
PROXY_PREFIX = 'http://127.0.0.1:8095/proxy/'


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def save(p, obj):
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def main():
    routes = {}
    if os.path.exists(ROUTES_FILE):
        try:
            routes = load(ROUTES_FILE).get('routes', {}) or {}
        except Exception:
            routes = {}

    cfg = load(MCP_CONFIG)
    meta = cfg.get('pluginMetadata', {}) or {}
    restored = []
    changed = False

    for k, v in meta.items():
        if not isinstance(v, dict):
            continue
        ep = v.get('endpoint') or ''
        if not ep.startswith(PROXY_PREFIX):
            continue
        rid = ep[len(PROXY_PREFIX):].split('/')[0]
        orig = (routes.get(rid) or {}).get('original_endpoint')
        if orig:
            v['endpoint'] = orig
            restored.append('%s -> %s' % (rid, orig[:70]))
            changed = True

    if changed:
        save(MCP_CONFIG, cfg)
        for line in restored:
            print('RESTORE', line)
    else:
        # 兜底：guardbak
        baks = sorted(glob.glob(MCP_CONFIG + '.guardbak.*'), reverse=True)
        if baks:
            with open(baks[0], encoding='utf-8') as f:
                data = json.load(f)
            with open(MCP_CONFIG, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            print('ROLLBACK_BAK ->', baks[0])
        else:
            print('ROLLBACK_NOTHING: 没有需要还原的路由，也没有 guardbak 备份')

    # 停代理
    state = {}
    if os.path.exists(STATE_FILE):
        try:
            state = load(STATE_FILE)
        except Exception:
            state = {}
    pid = state.get('pid')
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
            print('PROXY_STOP pid=%d' % pid)
        except ProcessLookupError:
            print('PROXY_DEAD pid=%d (未在运行)' % pid)
        except Exception as e:
            print('PROXY_STOP_FAIL pid=%d err=%s' % (pid, e))
    state['enabled'] = False
    state['updated_at'] = int(time.time() * 1000)
    save(STATE_FILE, state)
    print('ROLLBACK_OK (next: restart MCP services 使客户端按还原 endpoint 重连)')


if __name__ == '__main__':
    main()