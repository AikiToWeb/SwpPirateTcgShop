let products = [];
const app = document.querySelector('#rolling-app');
const state = { game: '매직 더 개더링', search: '', sort: 'recent', available: false, binder: false, saved: new Set(), cart: new Map(), user: null, csrf: null, ready: false, kakaoConfigured: false };
try { state.saved = new Set(JSON.parse(localStorage.getItem('rolling-binder') || '[]')); } catch { /* Private browsers still support the mockup. */ }
const won = n => `${n.toLocaleString('ko-KR')}원`;
const asset = p => `/rolling-assets/${p.image}`;

app.innerHTML = `
  <div class="swp-masthead">
    <a href="/rolling.html" aria-label="SWP shop 홈"><img src="/swp-assets/swp-shop-banner.png" alt="SWP shop" width="2172" height="724" fetchpriority="high"></a>
  </div>
  <header class="header wrap">
    <nav aria-label="주 메뉴"><a href="#shop" class="current">카드 찾기</a><a href="#table">매장 소식</a><button id="orders-open">주문 내역</button><button id="binder">내 바인더 <span id="saved-count">0</span></button></nav>
    <button class="kakao-login" id="login-button">카카오 로그인</button><button class="bag" id="cart-open" aria-label="장바구니 열기">장바구니 <span id="cart-count">0</span><span aria-hidden="true">↗</span></button>
  </header>
  <main>
    <section class="shop wrap" id="shop" aria-labelledby="shop-title">
      <div class="section-heading"><div><h2 id="shop-title">최신 등록 카드 <span class="count" id="result-count">04</span></h2></div></div>
      <div class="game-tabs" role="group" aria-label="게임 선택">${['매직 더 개더링','리프트바운드','플레시 앤 블러드','로카나'].map((g,i)=>`<button data-game="${g}" aria-pressed="${i===0}"><span class="game-mark">${['✳','◈','✥','✧'][i]}</span>${g}</button>`).join('')}</div>
      <div class="tools"><label class="search"><span aria-hidden="true">⌕</span><input id="search" type="search" aria-label="카드 검색" placeholder="카드명 · 세트 코드 검색"><kbd>/</kbd></label><div class="filters"><label class="checkbox"><input type="checkbox" id="available"> 재고 있는 카드</label><select id="sort" aria-label="정렬"><option value="recent">최근 등록순</option><option value="low">낮은 가격순</option><option value="high">높은 가격순</option><option value="name">이름순</option></select></div></div>
      <div class="product-grid" id="products"></div>
      <div class="shelf-foot"><button id="condition-guide">카드 컨디션 안내 ↗</button></div>
    </section>
    <section class="table wrap" id="table" aria-labelledby="table-title"><div class="table-intro"><h2 id="table-title">오늘의 매장 이벤트</h2><span class="date-stamp">10.13 <small>화요일</small></span></div><div class="events"><article><div class="event-time">19:30</div><div><span class="event-label">섀도우버스 이볼브</span><h3>먼슬리 토너먼트</h3></div><button data-event="먼슬리 토너먼트" aria-label="먼슬리 토너먼트 안내">↗</button></article><article><div class="event-time">19:30</div><div><span class="event-label">리프트바운드</span><h3>초보자 설명회</h3></div><button data-event="초보자 설명회" aria-label="초보자 설명회 안내">↗</button></article><p class="event-source">참고 사이트의 2026.10.13 일정 · 참여 안내는 매장에 문의해 주세요.</p></div></section>
  </main>
  <footer class="footer wrap"><div><a class="footer-brand" href="/rolling.html">SWP shop</a><p>서울 마포구 동교로 193, 3·4층<br><a href="tel:023237455">02-323-7455</a></p></div><div class="footer-links"><a href="https://tcgrollingdice.com/index.php?mode=map" target="_blank" rel="noopener">찾아오시는 길 ↗</a><a href="https://tcgrollingdice.com/index.php?mode=kc" target="_blank" rel="noopener">카카오톡 문의 ↗</a><a href="https://smartstore.naver.com/tcgrollingdice" target="_blank" rel="noopener">네이버 스토어 ↗</a></div><div class="footer-bottom"><span>개발용 상점 · 샘플 상품 · 매장 수령 주문</span><span>상품 이미지의 권리는 각 저작권자에게 있습니다.</span></div></footer>
  <dialog id="detail-dialog" aria-label="상품 상세"></dialog>
  <dialog id="cart-dialog" aria-label="장바구니"></dialog>
  <dialog id="orders-dialog" aria-label="주문 내역"></dialog>
  <dialog id="info-dialog" aria-label="안내"></dialog>
  <div class="toast" role="status" aria-live="polite"></div>
`;

function filtered() {
  let list = state.game === '매직 더 개더링' ? products.filter(p => `${p.name} ${p.en} ${p.set} ${p.id}`.toLowerCase().includes(state.search.toLowerCase()) && (!state.available || p.stock > 0) && (!state.binder || state.saved.has(p.id))) : [];
  return list.toSorted((a,b) => state.sort==='low' ? a.price-b.price : state.sort==='high' ? b.price-a.price : state.sort==='name' ? a.name.localeCompare(b.name,'ko') : 0);
}
function renderProducts() {
  const list = filtered();
  document.querySelector('#result-count').textContent = String(list.length).padStart(2,'0');
  document.querySelector('#shop-title').firstChild.textContent = state.binder ? '내 바인더 ' : '최신 등록 카드 ';
  document.querySelector('#products').innerHTML = list.length ? list.map((p,i)=>`<article class="product"><div class="product-photo"><span class="photo-index">${String(products.indexOf(p)+1).padStart(2,'0')}</span><button class="save ${state.saved.has(p.id)?'is-saved':''}" data-save="${p.id}" aria-label="${p.name} 바인더 저장" aria-pressed="${state.saved.has(p.id)}">${state.saved.has(p.id)?'♥':'♡'}</button><button class="image-button" data-detail="${p.id}" aria-label="${p.name} 상세 보기"><img src="${asset(p)}" alt="${p.name} 카드 앞면" loading="lazy"></button><span class="condition">${p.condition} · 한국어</span></div><div class="product-meta"><span>${p.set}</span><span>${p.id}</span></div><button class="product-title" data-detail="${p.id}">${p.name} <span>↗</span></button><div class="product-bottom"><div><strong>${won(p.price)}</strong><span class="stock">재고 ${p.stock}장</span></div><button class="add" data-add="${p.id}" aria-label="${p.name} 장바구니 담기">+</button></div></article>`).join('') : `<div class="empty"><span>표시할 카드가 없습니다.</span><p>${state.binder ? '저장된 카드가 없습니다.' : state.game !== '매직 더 개더링' ? '이 게임의 샘플 상품이 없습니다.' : '검색 결과가 없습니다.'}</p><button id="reset">전체 카드 보기 ↗</button></div>`;
}
function counts() {
  document.querySelector('#saved-count').textContent=state.saved.size;
  document.querySelector('#cart-count').textContent=[...state.cart.values()].reduce((a,b)=>a+b,0);
  document.querySelector('#binder').setAttribute('aria-pressed',state.binder);
}
let toastTimer;
function toast(message) { const t=document.querySelector('.toast');t.textContent=message;t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),2400); }
function add(id,quantity=1) {
  const p=products.find(p=>p.id===id), current=state.cart.get(id)||0;
  if(current+quantity>p.stock) { toast(`재고 한도: ${p.stock}장`);return; }
  state.cart.set(id,current+quantity);persistCart();counts();toast(`${p.name} ${quantity}장 담기 완료`);
}
function openInfo(title, text) {const d=document.querySelector('#info-dialog');d.innerHTML=`<button class="close" data-close aria-label="닫기">×</button><h2>${title}</h2><p>${text}</p><button class="solid" data-close>확인</button>`;d.showModal();}
function renderCart() {
  const d=document.querySelector('#cart-dialog');
  const total=[...state.cart].reduce((sum,[id,n])=>sum+products.find(p=>p.id===id).price*n,0);
  d.innerHTML=`<button class="close" data-close aria-label="닫기">×</button><h2>장바구니</h2>${state.cart.size ? `<div class="cart-lines">${[...state.cart].map(([id,n])=>{const p=products.find(p=>p.id===id);return `<div class="cart-line"><img src="${asset(p)}" alt="${p.name}"><div><strong>${p.name}</strong><small>NM · 한국어</small><div class="quantity"><button data-qty="${id}" data-delta="-1" aria-label="${p.name} 수량 줄이기">−</button><span>${n}</span><button data-qty="${id}" data-delta="1" aria-label="${p.name} 수량 늘리기">+</button></div></div><div><strong>${won(p.price*n)}</strong><button class="remove" data-remove="${id}">삭제</button></div></div>`}).join('')}</div><div class="cart-total"><span>상품 합계</span><strong>${won(total)}</strong></div><p class="dialog-note">매장 수령 주문 · 온라인 결제 없음 · 샘플 상품 재고를 예약합니다.</p><button class="solid" id="checkout">${state.user ? '매장 수령 주문 접수' : '카카오 로그인 후 주문'}</button>` : '<p>장바구니가 비어 있습니다.</p><button class="solid" data-close>카드 둘러보기 ↗</button>'}`;
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.game){state.game=b.dataset.game;document.querySelectorAll('[data-game]').forEach(t=>t.setAttribute('aria-pressed',t===b));renderProducts();}
  if(b.dataset.save){const id=b.dataset.save;if(state.user){try{await api('/binder/'+id,{method:'PUT',body:{saved:!state.saved.has(id)}});}catch(error){toast(error.message);return;}}state.saved.has(id)?state.saved.delete(id):state.saved.add(id);if(!state.user){try{localStorage.setItem('rolling-binder',JSON.stringify([...state.saved]));}catch{}}renderProducts();counts();}
  if(b.dataset.add)add(b.dataset.add);
  if(b.dataset.detail){const p=products.find(p=>p.id===b.dataset.detail),d=document.querySelector('#detail-dialog');d.innerHTML=`<button class="close" data-close aria-label="닫기">×</button><div class="detail-layout"><div class="detail-photo"><img src="${asset(p)}" alt="${p.name} 카드 앞면"></div><div><span class="eyebrow">${p.set} · ${p.id}</span><h2>${p.name}</h2><p class="english-name">${p.en}</p><dl><div><dt>컨디션</dt><dd>NM · Near Mint</dd></div><div><dt>언어</dt><dd>한국어</dd></div><div><dt>재고</dt><dd>${p.stock}장</dd></div></dl><strong class="detail-price">${won(p.price)}</strong><button class="solid" data-add="${p.id}">장바구니 담기 +</button><p class="dialog-note">샘플 상품 · 주문 시 서버 재고를 예약합니다.</p></div></div>`;d.showModal();}
  if(b.hasAttribute('data-close'))b.closest('dialog').close();
  if(b.id==='cart-open'){renderCart();document.querySelector('#cart-dialog').showModal();}
  if(b.dataset.qty){const id=b.dataset.qty,n=state.cart.get(id)+Number(b.dataset.delta),p=products.find(p=>p.id===id);if(n>p.stock){toast(`준비된 재고는 ${p.stock}장입니다.`);return;}n<=0?state.cart.delete(id):state.cart.set(id,n);persistCart();counts();renderCart();}
  if(b.dataset.remove){state.cart.delete(b.dataset.remove);counts();renderCart();}
  if(b.id==='binder'){state.binder=!state.binder;counts();renderProducts();document.querySelector('#shop').scrollIntoView({behavior:'smooth'});}
  if(b.id==='reset'){state.search='';state.game='매직 더 개더링';state.binder=false;state.available=false;document.querySelector('#search').value='';document.querySelector('#available').checked=false;document.querySelectorAll('[data-game]').forEach(t=>t.setAttribute('aria-pressed',t.dataset.game===state.game));counts();renderProducts();}
  if(b.id==='condition-guide')openInfo('NM · Near Mint','표면과 모서리의 손상이 매우 적은 상태입니다. 실제 판매 기준은 롤링다이스 카드 컨디션 가이드를 참고하세요.');
  if(b.dataset.event)openInfo(b.dataset.event,'2026년 10월 13일 19:30 · 참고 사이트에 표시된 일정입니다. 참가 접수는 지원하지 않습니다. 참가 가능 여부와 준비물은 매장(02-323-7455)에 문의해 주세요.');
});
document.querySelector('#search').addEventListener('input',e=>{state.search=e.target.value.trim();renderProducts();});
document.querySelector('#sort').addEventListener('change',e=>{state.sort=e.target.value;renderProducts();});
document.querySelector('#available').addEventListener('change',e=>{state.available=e.target.checked;renderProducts();});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)&&!document.querySelector('dialog[open]')){e.preventDefault();document.querySelector('#search').focus();}});
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
renderProducts();counts();

async function api(path, options = {}) {
  const response = await fetch('/shop-api' + path, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof result.detail === 'string' ? result.detail : `요청 실패 (${response.status})`;
    throw new Error(message);
  }
  return result;
}
let cartQueue = Promise.resolve();
let orderKey = null;
let cartFailure = null;
function cartItems() { return [...state.cart].map(([id,quantity]) => ({id,quantity})); }
function persistCart() {
  orderKey = null;
  const items = cartItems();
  if (!state.user) {
    try { localStorage.setItem('swp-guest-cart',JSON.stringify(items)); } catch {}
    return;
  }
  cartQueue = cartQueue.then(async () => {
    try { await api('/cart',{method:'PUT',body:{items}});cartFailure=null; }
    catch(error) { cartFailure=error;toast(error.message); }
  });
}
function updateAccount() {
  const button = document.querySelector('#login-button');
  button.textContent = state.user ? '로그아웃' : '카카오 로그인';
  button.title = state.user ? `${state.user.nickname}님 · 로그아웃` : '카카오 계정으로 로그인';
  button.disabled = !state.ready;
}
async function refreshCards() { products = await api('/cards');renderProducts(); }
async function startLogin() {
  if (!state.ready) return;
  if (!state.kakaoConfigured) { toast('카카오 앱 설정을 진행 중입니다.');return; }
  location.assign('/shop-api/auth/kakao');
}
async function loadShop() {
  try {
    const [cards,me] = await Promise.all([api('/cards'),api('/me')]);
    products=cards;state.user=me.user;state.csrf=me.csrf;state.kakaoConfigured=me.kakao_configured;
    if (state.user) {
      const [saved,cart] = await Promise.all([api('/binder'),api('/cart')]);
      state.saved=new Set(saved);state.cart=new Map(cart.map(i=>[i.id,i.quantity]));
      // Only merge the guest cart once after explicit sign-in, without replacing account data.
      if(new URLSearchParams(location.search).get('login')==='success') {
        let guest=[];try{guest=JSON.parse(localStorage.getItem('swp-guest-cart')||'[]');}catch{}
        for(const item of guest){const p=products.find(p=>p.id===item.id);if(p&&Number.isInteger(item.quantity)&&item.quantity>0){const n=Math.min(p.stock,(state.cart.get(item.id)||0)+item.quantity);if(n)state.cart.set(item.id,n);}}
        await api('/cart',{method:'PUT',body:{items:cartItems()}});
        try{localStorage.removeItem('swp-guest-cart');}catch{}
      }
    } else {
      let guest=[];try{guest=JSON.parse(localStorage.getItem('swp-guest-cart')||'[]');}catch{}
      state.cart=new Map(guest.filter(i=>products.some(p=>p.id===i.id)&&Number.isInteger(i.quantity)&&i.quantity>0).map(i=>[i.id,i.quantity]));
    }
    state.ready=true;renderProducts();counts();updateAccount();
    const status=new URLSearchParams(location.search).get('login');
    if(status){toast(status==='success'?'로그인 완료':'로그인이 취소되었거나 실패했습니다.');history.replaceState(null,'',location.pathname+location.hash);}
  } catch(error) {
    document.querySelector('#products').innerHTML='<div class="empty"><p>상점 서버에 연결할 수 없습니다.</p><button id="retry-shop">다시 연결</button></div>';
    toast(error.message);
  }
}
async function showOrders() {
  if(!state.user){await startLogin();return;}
  const d=document.querySelector('#orders-dialog');
  const list=await api('/orders');
  d.replaceChildren();
  const close=document.createElement('button');close.className='close';close.dataset.close='';close.setAttribute('aria-label','닫기');close.textContent='×';d.append(close);
  const title=document.createElement('h2');title.textContent='주문 내역';d.append(title);
  if(!list.length){const p=document.createElement('p');p.textContent='주문 내역이 없습니다.';d.append(p);}
  for(const order of list){
    const item=document.createElement('article');item.className='order-item';
    const heading=document.createElement('h3');heading.textContent=order.id;item.append(heading);
    const meta=document.createElement('p');meta.textContent=`${new Date(order.created*1000).toLocaleString('ko-KR')} · ${order.status} · ${won(order.total)}`;item.append(meta);
    const details=document.createElement('p');details.textContent=order.items.map(i=>`${i.name} ${i.quantity}장`).join(', ');item.append(details);
    if(order.status==='접수'){const button=document.createElement('button');button.className='cancel-order';button.dataset.cancelOrder=order.id;button.textContent='주문 취소';item.append(button);}
    d.append(item);
  }
  if(!d.open)d.showModal();
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  try {
    if(b.id==='retry-shop')await loadShop();
    if(b.id==='login-button') {
      if(state.user){await cartQueue;await api('/auth/logout',{method:'POST'});state.user=null;state.csrf=null;state.saved=new Set();state.cart.clear();counts();renderProducts();updateAccount();toast('로그아웃 완료');}
      else await startLogin();
    }
    if(b.id==='orders-open')await showOrders();
    if(b.id==='checkout'){
      if(!state.user){await startLogin();return;}
      b.disabled=true;
      await cartQueue;
      if(cartFailure)throw cartFailure;
      orderKey ||= crypto.randomUUID();
      const order=await api('/orders',{method:'POST',body:{items:cartItems(),request_key:orderKey}});
      state.cart.clear();orderKey=null;counts();document.querySelector('#cart-dialog').close();
      await refreshCards();toast(`주문 접수 완료 · ${order.id}`);await showOrders();
    }
    if(b.dataset.cancelOrder){b.disabled=true;await api('/orders/'+b.dataset.cancelOrder+'/cancel',{method:'POST'});await refreshCards();await showOrders();toast('주문 취소 완료');}
  } catch(error){toast(error.message);if(b.isConnected)b.disabled=false;}
});
updateAccount();
loadShop();

