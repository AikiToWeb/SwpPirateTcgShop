import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './rolling.css';
import AdminPanel from './AdminPanel.jsx';

const won = n => `${Number(n).toLocaleString('ko-KR')}원`;
const image = p => p.image ? (p.image.startsWith('https://') ? p.image : `/rolling-assets/${p.image}`) : '/swp-assets/card-placeholder.svg';
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

function Modal({ title, children, close }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onClick={e => {
    if (e.target !== ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  }}><button className="close" onClick={close} aria-label="닫기">×</button>{children}</dialog>;
}

function ProductCard({ product: p, number, saved, busy, save, add, detail }) {
  return <article className="product">
    <div className="product-photo"><span className="photo-index">{String(number).padStart(2, '0')}</span>
      <button className={`save ${saved ? 'is-saved' : ''}`} aria-label={`${p.name} 바인더 저장`} aria-pressed={saved} disabled={busy} onClick={save}>{saved ? '♥' : '♡'}</button>
      <button className="image-button" aria-label={`${p.name} 상세 보기`} onClick={detail}><img src={image(p)} alt={`${p.name} 카드 앞면`} loading="lazy" /></button>
      <span className="condition">{p.condition} · {p.language}</span>
    </div>
    <div className="product-meta"><span>{p.set}</span><span>{p.id}</span></div>
    <button className="product-title" onClick={detail}>{p.name} <span>↗</span></button>
    <div className="product-bottom"><div><strong>{won(p.price)}</strong><span className="stock">{p.stock ? `재고 ${p.stock}장` : '품절'}</span></div>
      <button className="add" disabled={busy || !p.stock} aria-label={`${p.name} 장바구니 담기`} onClick={add}>+</button>
    </div>
  </article>;
}

function App() {
  const [games, setGames] = useState([]);
  const [cards, setCards] = useState([]), [events, setEvents] = useState([]);
  const [account, setAccount] = useState({ user: null, csrf: null, kakao_configured: false });
  const [cart, setCart] = useState([]), [saved, setSaved] = useState([]), [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [game, setGame] = useState(''), [search, setSearch] = useState(''), [sort, setSort] = useState('recent');
  const [available, setAvailable] = useState(false), [binder, setBinder] = useState(false);
  const [modal, setModal] = useState(null), [toast, setToast] = useState('');
  const csrf = useRef(null), lock = useRef(false), orderKey = useRef(null), searchRef = useRef(null);

  async function api(path, options = {}) {
    const r = await fetch(`/shop-api${path}`, {
      ...options, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current || '', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const value = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof value.detail === 'string' ? value.detail : `요청 실패 (${r.status})`);
    return value;
  }
  async function action(task) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await task(); } catch (e) { setToast(e.message); } finally { lock.current = false; setBusy(false); }
  }
  function validGuest(items, products) {
    if (!Array.isArray(items)) return [];
    const quantities = new Map();
    for (const i of items) {
      const p = products.find(p => p.id === i?.id);
      if (p && Number.isInteger(i.quantity) && i.quantity > 0 && p.stock > 0) quantities.set(i.id, Math.min(p.stock, i.quantity));
    }
    return [...quantities].map(([id, quantity]) => ({ id, quantity }));
  }
  async function initialize() {
    setLoading(true); setError('');
    try {
      const [products, me, schedule, classifications] = await Promise.all([api('/cards'), api('/me'), api('/events'), api('/games')]);
      setGames(classifications); setGame(g => classifications.includes(g) ? g : classifications[0] || '');
      csrf.current = me.csrf; setCards(products); setAccount(me); setEvents(schedule);
      if (me.user) {
        const [collection, basket] = await Promise.all([api('/binder'), api('/cart')]);
        let next = basket;
        if (new URLSearchParams(location.search).get('login') === 'success') {
          const merged = new Map(basket.map(i => [i.id, i.quantity]));
          for (const i of validGuest(stored('swp-guest-cart', []), products)) merged.set(i.id, (merged.get(i.id) || 0) + i.quantity);
          next = validGuest([...merged].map(([id, quantity]) => ({ id, quantity })), products);
          await api('/cart', { method: 'PUT', body: { items: next } });
          store('swp-guest-cart', []);
        }
        setSaved(collection); setCart(next.filter(i => products.some(p => p.id === i.id)));
      } else {
        const collection = stored('rolling-binder', []);
        setSaved(Array.isArray(collection) ? collection.filter(id => products.some(p => p.id === id)) : []);
        setCart(validGuest(stored('swp-guest-cart', []), products));
      }
      const login = new URLSearchParams(location.search).get('login');
      if (login) { setToast(login === 'success' ? '로그인 완료' : '로그인이 취소되었거나 실패했습니다.'); history.replaceState(null, '', location.pathname + location.hash); }
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { initialize(); }, []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 3000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => {
    const shortcut = e => { if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && !modal) { e.preventDefault(); searchRef.current?.focus(); } };
    document.addEventListener('keydown', shortcut); return () => document.removeEventListener('keydown', shortcut);
  }, [modal]);

  const visible = useMemo(() => {
    const result = cards.filter(p => p.game === game && (!binder || saved.includes(p.id)) && (!available || p.stock > 0) && `${p.name} ${p.en} ${p.set} ${p.id}`.toLowerCase().includes(search.trim().toLowerCase()));
    return result.toSorted((a, b) => sort === 'low' ? a.price - b.price : sort === 'high' ? b.price - a.price : sort === 'name' ? a.name.localeCompare(b.name, 'ko') : 0);
  }, [cards, game, binder, saved, available, search, sort]);
  const cartLines = cart.map(i => ({ ...i, product: cards.find(p => p.id === i.id) })).filter(i => i.product);
  const total = cartLines.reduce((n, i) => n + i.product.price * i.quantity, 0);
  const detail = modal?.type === 'detail' ? cards.find(p => p.id === modal.id) : null;
  const cartCount = cart.reduce((n, i) => n + i.quantity, 0);

  function login() { if (!account.kakao_configured) setToast('카카오 앱 설정이 필요합니다.'); else location.assign('/shop-api/auth/kakao'); }
  async function changeCart(next) {
    if (account.user) await api('/cart', { method: 'PUT', body: { items: next } });
    else store('swp-guest-cart', next);
    setCart(next); orderKey.current = null;
  }
  function add(p) { action(async () => {
    const n = (cart.find(i => i.id === p.id)?.quantity || 0) + 1;
    if (n > p.stock) throw new Error(`재고 한도: ${p.stock}장`);
    await changeCart([...cart.filter(i => i.id !== p.id), { id: p.id, quantity: n }]); setToast(`${p.name} 담기 완료`);
  }); }
  function quantity(p, n) { action(async () => {
    if (n > p.stock) throw new Error(`재고 한도: ${p.stock}장`);
    await changeCart(n <= 0 ? cart.filter(i => i.id !== p.id) : cart.map(i => i.id === p.id ? { ...i, quantity: n } : i));
  }); }
  function save(p) { action(async () => {
    const next = saved.includes(p.id) ? saved.filter(id => id !== p.id) : [...saved, p.id];
    if (account.user) await api(`/binder/${p.id}`, { method: 'PUT', body: { saved: next.includes(p.id) } }); else store('rolling-binder', next);
    setSaved(next);
  }); }
  async function showOrders() { if (!account.user) { login(); return; } setOrders(await api('/orders')); setModal({ type: 'orders' }); }
  function checkout() { if (!account.user) { login(); return; } action(async () => {
    orderKey.current ||= crypto.randomUUID();
    const order = await api('/orders', { method: 'POST', body: { items: cart, request_key: orderKey.current } });
    setCart([]); orderKey.current = null; setModal(null); setToast(`주문 접수 완료 · ${order.id}`);
    setCards(await api('/cards')); await showOrders();
  }); }
  function cancel(order) { action(async () => { await api(`/orders/${order.id}/cancel`, { method: 'POST' }); setCards(await api('/cards')); setOrders(await api('/orders')); setToast('주문 취소 완료'); }); }
  function logout() { action(async () => { await api('/auth/logout', { method: 'POST' }); csrf.current = null; setAccount(a => ({ ...a, user: null, csrf: null })); setCart([]); setSaved([]); setBinder(false); setModal(null); setToast('로그아웃 완료'); }); }
  function reset() { setGame(games[0]); setBinder(false); setSearch(''); setAvailable(false); }

  return <>
    <div className="swp-masthead"><a href="/rolling.html" aria-label="SWP shop 홈"><img src="/swp-assets/swp-shop-banner.png" alt="SWP shop" width="2172" height="724" fetchPriority="high" /></a></div>
    <header className="header wrap"><nav aria-label="주 메뉴"><a className="current" href="#shop">카드 찾기</a><a href="#table">매장 소식</a><button onClick={() => action(showOrders)} disabled={loading || busy}>주문 내역</button><button aria-pressed={binder} onClick={() => { setBinder(!binder); document.querySelector('#shop')?.scrollIntoView({ behavior: 'smooth' }); }}>내 바인더 <span id="saved-count">{saved.length}</span></button></nav>
      {account.user?.role === 'ADMIN' && <button className="admin-open" onClick={() => setModal({ type: 'admin' })}>상점 관리</button>}
      <button className="kakao-login" disabled={loading || busy} onClick={account.user ? logout : login}>{account.user ? '로그아웃' : '카카오 로그인'}</button>
      <button className="bag" aria-label="장바구니 열기" disabled={loading} onClick={() => setModal({ type: 'cart' })}>장바구니 <span id="cart-count">{cartCount}</span><span>↗</span></button>
    </header>
    <main><section className="shop wrap" id="shop" aria-labelledby="shop-title">
      <div className="section-heading"><h1 id="shop-title">{binder ? '내 바인더' : '최신 등록 카드'} <span className="count">{String(visible.length).padStart(2, '0')}</span></h1><button className="refresh" disabled={busy || loading} onClick={() => action(async () => { setCards(await api('/cards')); setToast('상품 정보 갱신 완료'); })}>새로고침 ↻</button></div>
      <div className="game-tabs" role="group" aria-label="게임 선택">{games.map(g => <button key={g} aria-pressed={g === game} onClick={() => setGame(g)}>{g}</button>)}</div>
      <div className="tools"><label className="search"><span aria-hidden="true">⌕</span><input ref={searchRef} type="search" aria-label="카드 검색" placeholder="카드명 · 세트 코드 검색" value={search} onChange={e => setSearch(e.target.value)} /><kbd>/</kbd></label><div className="filters"><label className="checkbox"><input type="checkbox" checked={available} onChange={e => setAvailable(e.target.checked)} />재고 있는 카드</label><select aria-label="정렬" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">최근 등록순</option><option value="low">낮은 가격순</option><option value="high">높은 가격순</option><option value="name">이름순</option></select></div></div>
      <div className="product-grid">{loading ? <div className="empty" role="status">상품 불러오는 중</div> : error ? <div className="empty" role="alert"><p>{error}</p><button onClick={initialize}>다시 연결</button></div> : visible.length ? visible.map((p, i) => <ProductCard key={p.id} product={p} number={i + 1} saved={saved.includes(p.id)} busy={busy} save={() => save(p)} add={() => add(p)} detail={() => setModal({ type: 'detail', id: p.id })} />) : <div className="empty"><p>{binder ? '저장된 카드가 없습니다.' : cards.length ? '조건에 맞는 상품이 없습니다.' : '등록된 상품이 없습니다.'}</p>{cards.length > 0 && <button onClick={reset}>전체 카드 보기 ↗</button>}</div>}</div>
      <div className="shelf-foot"><button onClick={() => setModal({ type: 'info', title: 'NM · Near Mint', text: '표면과 모서리의 손상이 매우 적은 상태입니다. 상품별 컨디션을 확인하세요.' })}>카드 컨디션 안내 ↗</button></div>
    </section>
      <section className="table wrap" id="table" aria-labelledby="table-title"><div className="table-intro"><h2 id="table-title">매장 이벤트</h2></div><div className="events">{events.map(event => <article key={event.id}><div className="event-time">{new Date(event.startsAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' })}<br />{new Date(event.startsAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })}</div><div><span className="event-label">{event.game}</span><h3>{event.title}</h3></div><button aria-label={`${event.title} 안내`} onClick={() => setModal({ type: 'info', title: event.title, text: `${new Date(event.startsAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · ${event.description}` })}>↗</button></article>)}{!loading && !events.length && <p>등록된 일정이 없습니다.</p>}{events.some(e => e.sample) && <p className="event-source">참고 사이트에서 등록한 예시 일정 · 참가 접수 미지원</p>}</div></section>
    </main>
    <footer className="footer wrap"><div><a className="footer-brand" href="/rolling.html">SWP shop</a></div><div className="footer-bottom"><span>매장 수령 주문 · 온라인 결제 없음</span><span>상품 이미지의 권리는 각 저작권자에게 있습니다.</span></div></footer>
    {modal && <Modal key={modal.type} title={modal.type === 'admin' ? '상점 관리' : modal.type === 'cart' ? '장바구니' : modal.type === 'orders' ? '주문 내역' : detail?.name || modal.title || '안내'} close={() => setModal(null)}>
      {modal.type === 'admin' && <AdminPanel api={api} games={games} changed={async () => { setCards(await api('/cards')); setEvents(await api('/events')); }} />}
      {detail && <div className="detail-layout"><div className="detail-photo"><img src={image(detail)} alt={`${detail.name} 카드 앞면`} /></div><div><span className="eyebrow">{detail.set} · {detail.id}</span><h2>{detail.name}</h2><p className="english-name">{detail.en}</p><dl><div><dt>컨디션</dt><dd>{detail.condition}</dd></div><div><dt>언어</dt><dd>{detail.language}</dd></div><div><dt>재고</dt><dd>{detail.stock}장</dd></div></dl><strong className="detail-price">{won(detail.price)}</strong><button className="solid" disabled={busy || !detail.stock} onClick={() => add(detail)}>장바구니 담기 +</button></div></div>}
      {modal.type === 'cart' && <><h2>장바구니</h2>{cartLines.length ? <><div className="cart-lines">{cartLines.map(i => <div className="cart-line" key={i.id}><img src={image(i.product)} alt={i.product.name} /><div><strong>{i.product.name}</strong><small>{i.product.condition} · {i.product.language}</small><div className="quantity"><button disabled={busy} aria-label={`${i.product.name} 수량 줄이기`} onClick={() => quantity(i.product, i.quantity - 1)}>−</button><span>{i.quantity}</span><button disabled={busy || i.quantity >= i.product.stock} aria-label={`${i.product.name} 수량 늘리기`} onClick={() => quantity(i.product, i.quantity + 1)}>+</button></div></div><div><strong>{won(i.product.price * i.quantity)}</strong><button className="remove" disabled={busy} onClick={() => quantity(i.product, 0)}>삭제</button></div></div>)}</div><div className="cart-total"><span>상품 합계</span><strong>{won(total)}</strong></div><p className="dialog-note">매장 수령 주문 · 온라인 결제 없음 · 주문 시 서버에서 재고와 가격을 확인합니다.</p><button className="solid" disabled={busy} onClick={checkout}>{busy ? '처리 중' : account.user ? '매장 수령 주문 접수' : '카카오 로그인 후 주문'}</button></> : <p>장바구니가 비어 있습니다.</p>}</>}
      {modal.type === 'orders' && <><h2>주문 내역</h2>{orders.length ? orders.map(o => <article className="order-item" key={o.id}><h3>{o.id}</h3><p>{new Date(o.created * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · {o.status} · {won(o.total)}</p><p>{o.items.map(i => `${i.name} ${i.quantity}장`).join(', ')}</p>{o.status === '접수' && <button className="cancel-order" disabled={busy} onClick={() => cancel(o)}>주문 취소</button>}</article>) : <p>주문 내역이 없습니다.</p>}</>}
      {modal.type === 'info' && <><h2>{modal.title}</h2><p>{modal.text}</p><button className="solid" onClick={() => setModal(null)}>확인</button></>}
      {toast && <p className="dialog-feedback" role="status">{toast}</p>}
    </Modal>}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast}</div>
  </>;
}

createRoot(document.querySelector('#rolling-app')).render(<App />);
