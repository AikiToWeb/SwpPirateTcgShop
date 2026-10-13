"""SWP shop API. Separate from the unauthenticated operations demo API."""
from contextlib import contextmanager
from pathlib import Path
import hashlib
import json
import os
import secrets
import sqlite3
import time
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parents[1]
# Local credentials are never exposed to the frontend or committed.
env_file = ROOT / '.env.shop'
if env_file.exists():
    for line in env_file.read_text(encoding='utf-8-sig').splitlines():
        if line.strip() and not line.lstrip().startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

DB_PATH = os.getenv('SHOP_DATABASE_PATH', str(ROOT / 'data/swp.db'))
ORIGIN = os.getenv('SHOP_ORIGIN', 'http://127.0.0.1:5175').rstrip('/')
CLIENT_ID = os.getenv('KAKAO_REST_API_KEY', '')
CLIENT_SECRET = os.getenv('KAKAO_CLIENT_SECRET', '')
CALLBACK = ORIGIN + '/shop-api/auth/callback'
COOKIE = 'swp_session'
SECURE = ORIGIN.startswith('https://')
SEED = [
    ('M13-224', '진화하는 야생지', 'Evolving Wilds', 'Magic 2013', 500, 3, 'evolving-wilds.png'),
    ('ISD-239', '가보니 거주구', 'Gavony Township', 'Innistrad', 8400, 8, 'gavony-township.png'),
    ('M12-219', '축지장화', 'Swiftfoot Boots', 'Magic 2012', 6000, 3, 'swiftfoot-boots.png'),
    ('M13-212', '칼로니아의 반지', 'Ring of Kalonia', 'Magic 2013', 900, 8, 'ring-of-kalonia.png'),
]


@contextmanager
def db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    try:
        conn.execute('BEGIN IMMEDIATE')
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize():
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,name TEXT,en TEXT,"set" TEXT,
          price INTEGER CHECK(price>=0),stock INTEGER CHECK(stock>=0),image TEXT);
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,nickname TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),
          csrf TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS oauth_states(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS binders(user_id TEXT REFERENCES users(id),card_id TEXT REFERENCES cards(id),
          PRIMARY KEY(user_id,card_id));
        CREATE TABLE IF NOT EXISTS carts(user_id TEXT REFERENCES users(id),card_id TEXT REFERENCES cards(id),
          quantity INTEGER CHECK(quantity>0),PRIMARY KEY(user_id,card_id));
        CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),
          request_key TEXT NOT NULL,status TEXT NOT NULL,total INTEGER NOT NULL,created INTEGER NOT NULL,
          UNIQUE(user_id,request_key));
        CREATE TABLE IF NOT EXISTS order_items(order_id TEXT REFERENCES orders(id),card_id TEXT REFERENCES cards(id),
          name TEXT,price INTEGER,quantity INTEGER,PRIMARY KEY(order_id,card_id));
        ''')
        c.executemany('INSERT OR IGNORE INTO cards VALUES(?,?,?,?,?,?,?)', SEED)


app = FastAPI(title='SWP shop', docs_url='/shop-api/docs', openapi_url='/shop-api/openapi.json')
initialize()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def session(request, required=True):
    token = request.cookies.get(COOKIE, '')
    with db() as c:
        row = c.execute('SELECT s.*,u.nickname FROM sessions s JOIN users u ON u.id=s.user_id '
                        'WHERE token=? AND expires>?', (digest(token), int(time.time()))).fetchone()
    if not row and required:
        raise HTTPException(401, '로그인이 필요합니다.')
    return dict(row) if row else None


def mutation(request):
    # A browser's exact origin and a session-bound CSRF token are both required.
    if request.headers.get('origin') != ORIGIN:
        raise HTTPException(403, '허용되지 않은 요청입니다.')
    s = session(request)
    if not secrets.compare_digest(request.headers.get('x-csrf-token', ''), s['csrf']):
        raise HTTPException(403, '요청을 다시 시도하세요.')
    return s['user_id']


@app.get('/shop-api/health')
def health():
    return {'status': 'ok', 'kakao_configured': bool(CLIENT_ID and CLIENT_SECRET), 'checkout': 'store_pickup'}


@app.get('/shop-api/cards')
def cards():
    with db() as c:
        return [{**dict(r), 'condition': 'NM', 'game': '매직 더 개더링'} for r in c.execute('SELECT * FROM cards ORDER BY rowid')]


@app.get('/shop-api/me')
def me(request: Request):
    s = session(request, False)
    return {'user': {'id': s['user_id'], 'nickname': s['nickname']} if s else None,
            'csrf': s['csrf'] if s else None, 'kakao_configured': bool(CLIENT_ID and CLIENT_SECRET)}


@app.get('/shop-api/auth/kakao')
def login():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(503, '카카오 앱 설정을 진행 중입니다.')
    state = secrets.token_urlsafe(32)
    with db() as c:
        c.execute('DELETE FROM oauth_states WHERE expires<?', (int(time.time()),))
        c.execute('INSERT INTO oauth_states VALUES(?,?)', (digest(state), int(time.time()) + 600))
    response = RedirectResponse('https://kauth.kakao.com/oauth/authorize?' + urlencode({
        'client_id': CLIENT_ID, 'redirect_uri': CALLBACK, 'response_type': 'code', 'state': state,
    }))
    response.set_cookie('swp_oauth', state, max_age=600, httponly=True, secure=SECURE, samesite='lax', path='/shop-api')
    return response


@app.get('/shop-api/auth/callback')
def callback(request: Request, state: str = '', code: str = '', error: str = ''):
    cookie = request.cookies.get('swp_oauth', '')
    valid = bool(state and cookie and secrets.compare_digest(state, cookie))
    with db() as c:
        row = c.execute('SELECT expires FROM oauth_states WHERE token=?', (digest(state),)).fetchone()
        c.execute('DELETE FROM oauth_states WHERE token=?', (digest(state),))
    if not valid or not row or row['expires'] <= time.time():
        raise HTTPException(400, '로그인 요청이 만료되었거나 유효하지 않습니다.')
    response = RedirectResponse(ORIGIN + '/rolling.html?login=failed', status_code=303)
    if error or not code:
        response.delete_cookie('swp_oauth', path='/shop-api')
        return response
    try:
        with httpx.Client(timeout=15) as client:
            token_response = client.post('https://kauth.kakao.com/oauth/token', data={
                'grant_type': 'authorization_code', 'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET,
                'redirect_uri': CALLBACK, 'code': code,
            })
            token_response.raise_for_status()
            access = token_response.json()['access_token']
            profile = client.get('https://kapi.kakao.com/v2/user/me', headers={'Authorization': 'Bearer ' + access})
            profile.raise_for_status()
            account = profile.json()
    except (httpx.HTTPError, KeyError, ValueError):
        response.delete_cookie('swp_oauth', path='/shop-api')
        return response
    user_id = str(account['id'])
    nickname = str(account.get('properties', {}).get('nickname') or '회원')[:80]
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with db() as c:
        c.execute('INSERT INTO users VALUES(?,?) ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname', (user_id, nickname))
        c.execute('DELETE FROM sessions WHERE expires<?', (int(time.time()),))
        if request.cookies.get(COOKIE):
            c.execute('DELETE FROM sessions WHERE token=?', (digest(request.cookies[COOKIE]),))
        c.execute('INSERT INTO sessions VALUES(?,?,?,?)', (digest(token), user_id, csrf, int(time.time())+604800))
    response = RedirectResponse(ORIGIN + '/rolling.html?login=success', status_code=303)
    response.delete_cookie('swp_oauth', path='/shop-api')
    response.set_cookie(COOKIE, token, max_age=604800, httponly=True, secure=SECURE, samesite='lax', path='/shop-api')
    return response


@app.post('/shop-api/auth/logout')
def logout(request: Request, response: Response):
    mutation(request)
    with db() as c:
        c.execute('DELETE FROM sessions WHERE token=?', (digest(request.cookies.get(COOKIE, '')),))
    response.delete_cookie(COOKIE, path='/shop-api')
    return {'ok': True}


@app.get('/shop-api/binder')
def binder(request: Request):
    user_id = session(request)['user_id']
    with db() as c:
        return [r['card_id'] for r in c.execute('SELECT card_id FROM binders WHERE user_id=?', (user_id,))]


class Saved(BaseModel):
    saved: bool


@app.put('/shop-api/binder/{card_id}')
def save_card(card_id: str, body: Saved, request: Request):
    user_id = mutation(request)
    with db() as c:
        if not c.execute('SELECT id FROM cards WHERE id=?', (card_id,)).fetchone():
            raise HTTPException(404, '상품이 없습니다.')
        if body.saved:
            c.execute('INSERT OR IGNORE INTO binders VALUES(?,?)', (user_id, card_id))
        else:
            c.execute('DELETE FROM binders WHERE user_id=? AND card_id=?', (user_id, card_id))
    return {'ok': True}


class CartItem(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    quantity: int = Field(strict=True, ge=1, le=100)


class Cart(BaseModel):
    items: list[CartItem] = Field(max_length=100)


@app.get('/shop-api/cart')
def get_cart(request: Request):
    user_id = session(request)['user_id']
    with db() as c:
        return [{'id': r['card_id'], 'quantity': r['quantity']} for r in c.execute('SELECT * FROM carts WHERE user_id=?', (user_id,))]


@app.put('/shop-api/cart')
def put_cart(body: Cart, request: Request):
    user_id = mutation(request)
    if len({item.id for item in body.items}) != len(body.items):
        raise HTTPException(422, '중복 상품입니다.')
    with db() as c:
        for item in body.items:
            p = c.execute('SELECT stock FROM cards WHERE id=?', (item.id,)).fetchone()
            if not p or item.quantity > p['stock']:
                raise HTTPException(409, '재고가 변경되었습니다. 상품 목록을 새로고침하세요.')
        c.execute('DELETE FROM carts WHERE user_id=?', (user_id,))
        c.executemany('INSERT INTO carts VALUES(?,?,?)', [(user_id, i.id, i.quantity) for i in body.items])
    return {'ok': True}


class Checkout(Cart):
    request_key: str = Field(min_length=16, max_length=80)


def order_data(c, row):
    return {**dict(row), 'items': [dict(r) for r in c.execute('SELECT card_id,name,price,quantity FROM order_items WHERE order_id=?', (row['id'],))]}


@app.get('/shop-api/orders')
def orders(request: Request):
    user_id = session(request)['user_id']
    with db() as c:
        return [order_data(c, r) for r in c.execute('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC', (user_id,)).fetchall()]


@app.post('/shop-api/orders', status_code=201)
def checkout(body: Checkout, request: Request):
    user_id = mutation(request)
    if not body.items or len({i.id for i in body.items}) != len(body.items):
        raise HTTPException(422, '주문 상품을 확인하세요.')
    with db() as c:
        old = c.execute('SELECT * FROM orders WHERE user_id=? AND request_key=?', (user_id, body.request_key)).fetchone()
        if old:
            return order_data(c, old)
        rows = []
        for item in body.items:
            p = c.execute('SELECT * FROM cards WHERE id=?', (item.id,)).fetchone()
            if not p or item.quantity > p['stock']:
                raise HTTPException(409, '재고가 부족합니다. 상품 목록을 새로고침하세요.')
            rows.append((p, item.quantity))
        total = sum(p['price'] * n for p, n in rows)
        order_id = 'SWP-' + secrets.token_hex(6).upper()
        c.execute('INSERT INTO orders VALUES(?,?,?,?,?,?)', (order_id, user_id, body.request_key, '접수', total, int(time.time())))
        for p, n in rows:
            c.execute('UPDATE cards SET stock=stock-? WHERE id=?', (n, p['id']))
            c.execute('INSERT INTO order_items VALUES(?,?,?,?,?)', (order_id, p['id'], p['name'], p['price'], n))
        c.execute('DELETE FROM carts WHERE user_id=?', (user_id,))
        return order_data(c, c.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone())


@app.post('/shop-api/orders/{order_id}/cancel')
def cancel(order_id: str, request: Request):
    user_id = mutation(request)
    with db() as c:
        row = c.execute('SELECT * FROM orders WHERE id=? AND user_id=?', (order_id, user_id)).fetchone()
        if not row:
            raise HTTPException(404, '주문이 없습니다.')
        if row['status'] == '취소':
            return order_data(c, row)
        if row['status'] != '접수':
            raise HTTPException(409, '취소할 수 없는 주문입니다.')
        for item in c.execute('SELECT * FROM order_items WHERE order_id=?', (order_id,)).fetchall():
            c.execute('UPDATE cards SET stock=stock+? WHERE id=?', (item['quantity'], item['card_id']))
        c.execute('UPDATE orders SET status=? WHERE id=?', ('취소', order_id))
        return order_data(c, c.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone())
