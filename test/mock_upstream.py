#!/usr/bin/env python3
# mock 上游服务器：模拟公共平台 MCP 端点，仅回显请求信息。
# 用途：验证 MO隐私拦截网 的转发与拦截，不产生任何真实平台流量。
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def _reply(self):
        body = b''
        length = int(self.headers.get('Content-Length') or 0)
        if length:
            body = self.rfile.read(length)
        payload = {
            'upstream': 'mock',
            'method': self.command,
            'path': self.path,
            'query_token': self.path.split('token=')[1].split('&')[0] if 'token=' in self.path else None,
            'auth': self.headers.get('Authorization'),
            'body': body.decode('utf-8', 'replace')[:500],
        }
        data = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _reply
    do_POST = _reply

    def log_message(self, fmt, *args):
        print('[mock]', fmt % args)

if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 18099), H).serve_forever()