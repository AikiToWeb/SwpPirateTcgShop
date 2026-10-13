from concurrent.futures import ThreadPoolExecutor
import time

from fastapi.testclient import TestClient
import pytest

import app.shop as shop


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(shop, 'DB_PATH', str(tmp_path / 'shop.db'))
    shop.initialize()
    with shop.db() as c:
        for user in ('one', 'two'):
            c.execute('INSERT INTO users VALUES(?,?)', (user, user))
            c.execute('INSERT INTO sessions VALUES(?,?,?,?)', (shop.digest(user), user, 'csrf-'+user, int(time.time())+1000))
    result=[]
    for user in ('one','two'):
        client=TestClient(shop.app)
        client.cookies.set(shop.COOKIE,user,path='/shop-api')
        client.headers.update({'Origin':shop.ORIGIN,'X-CSRF-Token':'csrf-'+user})
        result.append(client)
    return result


def test_auth_and_csrf(clients):
    one,_=clients
    assert one.get('/shop-api/me').json()['user']['id']=='one'
    assert TestClient(shop.app).get('/shop-api/orders').status_code==401
    assert one.put('/shop-api/cart',json={'items':[]},headers={'Origin':'https://evil.example'}).status_code==403
    assert one.put('/shop-api/cart',json={'items':[]},headers={'X-CSRF-Token':'bad'}).status_code==403
    assert one.get('/shop-api/auth/callback?state=fake&code=fake').status_code==400


def test_binder_and_cart_isolation(clients):
    one,two=clients
    assert one.put('/shop-api/binder/M13-224',json={'saved':True}).status_code==200
    assert one.get('/shop-api/binder').json()==['M13-224']
    assert two.get('/shop-api/binder').json()==[]
    assert one.put('/shop-api/cart',json={'items':[{'id':'M13-224','quantity':2}]}).status_code==200
    assert two.get('/shop-api/cart').json()==[]
    assert one.put('/shop-api/cart',json={'items':[{'id':'M13-224','quantity':4}]}).status_code==409
    assert one.put('/shop-api/cart',json={'items':[{'id':'M13-224','quantity':True}]}).status_code==422


def test_checkout_snapshot_idempotency_and_cancel(clients):
    one,two=clients
    body={'items':[{'id':'M13-224','quantity':2}],'request_key':'test-order-12345678','total':1}
    first=one.post('/shop-api/orders',json=body)
    assert first.status_code==201
    order=first.json()
    assert order['total']==1000  # Client-supplied prices/totals cannot override server pricing.
    assert one.post('/shop-api/orders',json=body).json()['id']==order['id']
    assert one.get('/shop-api/cards').json()[0]['stock']==1
    assert two.post('/shop-api/orders/'+order['id']+'/cancel').status_code==404
    assert two.get('/shop-api/orders').json()==[]
    assert one.post('/shop-api/orders/'+order['id']+'/cancel').status_code==200
    assert one.post('/shop-api/orders/'+order['id']+'/cancel').status_code==200
    assert one.get('/shop-api/cards').json()[0]['stock']==3


def test_checkout_atomic_and_concurrent_stock(clients):
    one,two=clients
    invalid={'items':[{'id':'M13-224','quantity':1},{'id':'missing','quantity':1}],'request_key':'invalid-order-123456'}
    assert one.post('/shop-api/orders',json=invalid).status_code==409
    assert one.get('/shop-api/cards').json()[0]['stock']==3
    def buy(pair):
        client,key=pair
        return client.post('/shop-api/orders',json={'items':[{'id':'M13-224','quantity':3}],'request_key':key}).status_code
    with ThreadPoolExecutor(2) as executor:
        statuses=list(executor.map(buy,[(one,'concurrent-one-12345'),(two,'concurrent-two-12345')]))
    assert sorted(statuses)==[201,409]
    assert one.get('/shop-api/cards').json()[0]['stock']==0


def test_oauth_callback_and_session_rotation(clients, monkeypatch):
    monkeypatch.setattr(shop,'CLIENT_ID','test-client')
    monkeypatch.setattr(shop,'CLIENT_SECRET','test-secret')
    class Kakao:
        def __init__(self, **kw):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,url,data):
            assert data['client_secret']=='test-secret'
            import httpx
            return httpx.Response(200,json={'access_token':'provider-token'},request=httpx.Request('POST',url))
        def get(self,url,headers):
            import httpx
            return httpx.Response(200,json={'id':123,'properties':{'nickname':'사용자'}},request=httpx.Request('GET',url))
    monkeypatch.setattr(shop.httpx,'Client',Kakao)
    one,_=clients
    start=one.get('/shop-api/auth/kakao',follow_redirects=False)
    from urllib.parse import parse_qs,urlparse
    state=parse_qs(urlparse(start.headers['location']).query)['state'][0]
    callback=one.get('/shop-api/auth/callback',params={'state':state,'code':'code'},follow_redirects=False)
    assert callback.status_code==303
    assert 'httponly' in callback.headers['set-cookie'].lower()
    assert one.get('/shop-api/me').json()['user']['id']=='123'
    assert one.get('/shop-api/auth/callback',params={'state':state,'code':'code'}).status_code==400
    with shop.db() as c:
        assert c.execute('SELECT token FROM sessions WHERE token=?',(shop.digest('one'),)).fetchone() is None


def test_logout_invalidates_session(clients):
    one,_=clients
    assert one.post('/shop-api/auth/logout').status_code==200
    assert one.get('/shop-api/me').json()['user'] is None
