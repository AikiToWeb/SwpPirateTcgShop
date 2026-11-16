#!/usr/bin/env python3
"""Local-only review of the real shop with disposable H2 and synthetic accounts.
Never reads .env.shop. Usage: python3 scripts/review-shop.py --java /path/to/java
Open /__review/admin or /__review/customer on the printed loopback URL.
"""
import argparse
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java', required=True)
args = parser.parse_args()
origin = 'http://127.0.0.1:18175'
accounts = {role: (secrets.token_hex(32), secrets.token_hex(24)) for role in ('admin', 'customer')}
with tempfile.TemporaryDirectory(prefix='swp-review-') as directory:
    directory = Path(directory)
    seed = directory / 'accounts.sql'
    statements = []
    for role, (token, csrf) in accounts.items():
        statements.append(f"INSERT INTO shop_users(id,nickname,role) VALUES('review-{role}','검증 {role}','{'ADMIN' if role == 'admin' else 'CUSTOMER'}');")
        statements.append(f"INSERT INTO sessions(token,user_id,csrf,expires) VALUES('{hashlib.sha256(token.encode()).hexdigest()}','review-{role}','{csrf}',{int(time.time())+7200});")
    seed.write_text('\n'.join(statements))
    seed.chmod(0o600)
    env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT')}
    env.update(SHOP_ORIGIN=origin, SHOP_DATABASE_URL='jdbc:h2:mem:shop-review;DB_CLOSE_DELAY=-1', SHOP_DATABASE_USERNAME='sa', SHOP_DATABASE_PASSWORD='', SHOP_IMPORT_ENABLED='false', SMARTSTORE_SYNC_ENABLED='false', SMARTSTORE_AUTO_SYNC_ENABLED='false', PORT='18081')
    log = open(directory / 'server.log', 'w')
    process = subprocess.Popen([args.java, '-jar', str(root / 'backend/target/swp-shop-0.2.0.jar'), '--spring.sql.init.data-locations='+seed.as_uri()], cwd=directory, env=env, stdout=log, stderr=log)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *unused): pass
        def forward(self):
            if self.path.startswith('/__review/'):
                role = self.path.removeprefix('/__review/')
                if self.command != 'GET' or role not in accounts:
                    self.send_error(404); return
                self.send_response(303)
                self.send_header('Set-Cookie', f'swp_session={accounts[role][0]}; Path=/shop-api; HttpOnly; SameSite=Lax')
                self.send_header('Location', '/rolling.html')
                self.end_headers(); return
            connection = http.client.HTTPConnection('127.0.0.1', 18081, timeout=30)
            try:
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'connection')}
                connection.request(self.command, self.path, body=body, headers=headers)
                response = connection.getresponse()
                data = response.read()
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in ('transfer-encoding', 'connection', 'content-length'):
                        self.send_header(key, value)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers(); self.wfile.write(data)
            except (OSError, http.client.HTTPException): self.send_error(502)
            finally: connection.close()
        do_GET = do_POST = do_PUT = do_DELETE = forward
    try:
        for unused in range(100):
            if process.poll() is not None: raise RuntimeError('Review server failed; no production settings were loaded.')
            try:
                with urllib.request.urlopen('http://127.0.0.1:18081/shop-api/health', timeout=1): break
            except OSError: time.sleep(0.2)
        else: raise RuntimeError('Review server did not become ready.')
        print(f'Isolated review ready: {origin}/__review/admin and {origin}/__review/customer', flush=True)
        print('Disposable memory H2 only. No Kakao or SmartStore credentials. Ctrl-C stops all review services.', flush=True)
        ThreadingHTTPServer(('127.0.0.1', 18175), Handler).serve_forever()
    except KeyboardInterrupt: pass
    finally:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        log.close()
