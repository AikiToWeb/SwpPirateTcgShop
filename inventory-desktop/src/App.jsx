import React, { useEffect, useRef, useState } from 'react';
import StoreConnection from './StoreConnection.jsx';
import SmartStorePanel from './SmartStorePanel.jsx';
import { request as call } from './bridge.js';
import CardImage from './CardImage.jsx';
import CardImageSearch from './CardImageSearch.jsx';

const MAX_STOCK = 99999999;
const PAGE_SIZE = 25;
const GAME_OPTIONS = ['원피스 카드게임', '플래시 앤 블러드', '리프트바운드'];
const formatNumber = value => new Intl.NumberFormat('ko-KR').format(value ?? 0);
const formatDate = value => {
  if (!value) return '—';
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric == null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? '시각 확인 필요' : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
const typeLabels = { INITIAL: '초기 등록', IN: '입고', OUT: '출고', ADJUST: '실사 조정', ORDER: '주문 차감', CANCEL: '주문 취소' };
const freshProduct = () => ({ sku: '', name: '', setName: '', game: '', language: '', condition: '', unit: '개', initialStock: '0', image: '' });


function Icon({ name, size = 20 }) {
  const paths = {
    box: <><path d="m3 7 9-4 9 4-9 4z" /><path d="M3 7v10l9 4 9-4V7M12 11v10M7.5 5l9 4" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2" /></>,
    backup: <><path d="M5 4h12l3 3v13H4V4zM8 4v6h8V4M8 20v-7h8v7" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.box}</svg>;
}

function Pagination({ total, page, onChange, busy }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return <div className="pagination"><span>총 {formatNumber(total)}건{total > 0 && ` · ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)}건`}</span><div><button className="button small secondary" disabled={busy || page === 0} onClick={() => onChange(page - 1)}>이전</button><span className="page-label">{page + 1} / {pages}</span><button className="button small secondary" disabled={busy || page + 1 >= pages} onClick={() => onChange(page + 1)}>다음</button></div></div>;
}

function EmptyState({ title, description, children, icon = 'box' }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={28} /></div><strong>{title}</strong><p>{description}</p>{children}</div>;
}

export default function App() {
  const [view, setView] = useState('inventory');
  const [appInfo, setAppInfo] = useState(null);
  const [overview, setOverview] = useState(null);
  const [connection, setConnection] = useState(null);
  const [connectionReady, setConnectionReady] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [products, setProducts] = useState([]);
  const [productTotal, setProductTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState(null);
  const [historyProduct, setHistoryProduct] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [stockBusy, setStockBusy] = useState(false);
  const [showRegistration, setShowRegistration] = useState(false);
  const listRequest = useRef(0);
  const historyRequest = useRef(0);
  const connectionLock = useRef(false);
  const isStore = connection?.mode === 'store';
  const workspaceBusy = stockBusy || backupBusy || connectionBusy || integrationBusy;
  const canMutate = connectionReady && !connectionBusy;
  const viewTitles = { inventory: '상품 재고', history: '입출고 이력', connection: '매장 서버 연결', smartstore: '스마트스토어' };

  const refresh = () => setRefreshKey(key => key + 1);

  useEffect(() => {
    let active = true;
    Promise.all([call('getAppInfo'), call('getConnection')]).then(([info, current]) => { if (active) { setAppInfo(info); setConnection(current); setConnectionReady(true); } }).catch(error => { if (active) setNotice({ kind: 'error', text: error.message }); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!connectionReady || connectionBusy) return;
    const request = ++listRequest.current;
    setLoading(true);
    setLoadError('');
    Promise.all([call('listProducts', { query, limit: PAGE_SIZE, offset: page * PAGE_SIZE }), call('getOverview')])
      .then(([list, summary]) => {
        if (request !== listRequest.current) return;
        if (page > 0 && list.items.length === 0) { setPage(0); return; }
        setProducts(list.items);
        setProductTotal(list.total);
        setOverview(summary);
        setSelected(current => current ? list.items.find(product => product.id === current.id) || null : null);
      })
      .catch(error => { if (request === listRequest.current) setLoadError(error.message); })
      .finally(() => { if (request === listRequest.current) setLoading(false); });
    return () => { listRequest.current++; };
  }, [query, page, refreshKey, connectionReady, connectionBusy]);

  useEffect(() => {
    if (view !== 'history' || !connectionReady || connectionBusy) {
      setHistoryLoading(false);
      return;
    }
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError('');
    call('getHistory', { ...(historyProduct ? { productId: historyProduct.id } : {}), limit: PAGE_SIZE, offset: historyPage * PAGE_SIZE })
      .then(data => {
        if (request !== historyRequest.current) return;
        if (historyPage > 0 && data.items.length === 0) { setHistoryPage(0); return; }
        setHistory(data.items); setHistoryTotal(data.total);
      })
      .catch(error => { if (request === historyRequest.current) setHistoryError(error.message); })
      .finally(() => { if (request === historyRequest.current) setHistoryLoading(false); });
    return () => { historyRequest.current++; };
  }, [view, historyProduct?.id, historyPage, refreshKey, connectionReady, connectionBusy]);

  function openHistory(product = null) {
    setHistoryProduct(product); setHistoryPage(0); setView('history');
  }

  async function backup() {
    if (workspaceBusy || !canMutate || isStore) return;
    setBackupBusy(true);
    try {
      const result = await call('backupDatabase');
      if (!result.canceled) setNotice({ kind: 'success', text: `DB 백업을 저장했습니다. ${result.path || ''}` });
    } catch (error) { setNotice({ kind: 'error', text: error.message }); }
    finally { setBackupBusy(false); }
  }

  async function changeConnection(method, args) {
    if (connectionLock.current || workspaceBusy || showRegistration) throw new Error('현재 작업이 끝난 후 모드를 전환해 주세요.');
    connectionLock.current = true; setConnectionBusy(true); setConnectionReady(false);
    listRequest.current++; historyRequest.current++;
    try {
      const result = await call(method, args);
      setProducts([]); setProductTotal(0); setOverview(null); setSelected(null);
      setHistory([]); setHistoryTotal(0); setHistoryProduct(null); setHistoryPage(0);
      setSearchInput(''); setQuery(''); setPage(0); setNotice(null); setLoadError(''); setHistoryError('');
      setConnection(result);
      const info = await call('getAppInfo');
      setAppInfo(info); setConnectionReady(true); refresh();
      return result;
    } catch (failure) {
      try {
        const [current, info] = await Promise.all([call('getConnection'), call('getAppInfo')]);
        setConnection(current); setAppInfo(info); setConnectionReady(true);
        setProducts([]); setProductTotal(0); setOverview(null); setSelected(null);
        setHistory([]); setHistoryTotal(0); setHistoryProduct(null); setHistoryPage(0);
        setSearchInput(''); setQuery(''); setPage(0); refresh();
      } catch { setConnectionReady(false); }
      throw failure;
    } finally { connectionLock.current = false; setConnectionBusy(false); }
  }

  function registered(product) {
    setShowRegistration(false); setView('inventory'); setSearchInput(product.sku); setQuery(product.sku); setPage(0); setSelected(product); refresh();
    setNotice({ kind: 'success', text: `${product.name} 상품을 등록했습니다.` });
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">SWP</span><span>재고관리</span></div>
      <div className="store-label">{isStore ? '매장 서버 · 실제 재고' : '매장 PC · 로컬 테스트'}</div>
      <nav aria-label="주 메뉴">
        <button className={`nav-item ${view === 'inventory' ? 'active' : ''}`} disabled={workspaceBusy} onClick={() => setView('inventory')}><Icon name="box" />상품 재고<Icon name="arrow" size={15} /></button>
        <button className={`nav-item ${view === 'history' ? 'active' : ''}`} disabled={workspaceBusy} onClick={() => openHistory()}><Icon name="history" />입출고 이력<Icon name="arrow" size={15} /></button>
        <button className={`nav-item ${view === 'smartstore' ? 'active' : ''}`} disabled={workspaceBusy || !isStore || !connectionReady} onClick={() => setView('smartstore')}><Icon name="refresh" />스마트스토어<Icon name="arrow" size={15} /></button>
        <button className={`nav-item ${view === 'connection' ? 'active' : ''}`} disabled={workspaceBusy} onClick={() => setView('connection')}><Icon name="info" />매장 서버 연결<Icon name="arrow" size={15} /></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="connection"><span className="connection-dot" /><div><strong>{isStore ? '매장 서버 모드' : '로컬 테스트 DB'}</strong><span>{isStore ? appInfo?.smartStoreConnected ? '스마트스토어 연결 확인됨' : '스마트스토어 연결 확인 필요' : '스마트스토어 미연동'}</span></div></div>
        <button className="backup-button" onClick={backup} disabled={workspaceBusy || isStore || !canMutate}><Icon name="backup" size={18} />{isStore ? '서버 백업은 서버에서 관리' : backupBusy ? '백업 저장 중…' : 'DB 백업 저장'}</button>
        <span className="app-version">버전 {appInfo?.version || '—'}</span>
      </div>
    </aside>

    <main className="main-content">
      <header className="page-header"><div><div className="eyebrow">매장 재고</div><h1>{viewTitles[view]}</h1></div><div className="header-actions"><span className={isStore ? "live-badge" : "test-badge"}>{!connectionReady ? "연결 확인 필요" : isStore ? "매장 · 실제 재고" : "테스트 DB"}</span><button className="button secondary icon-button" aria-label="데이터 새로고침" title="새로고침" onClick={() => !connectionReady ? changeConnection("getConnection").catch(error => setNotice({ kind: "error", text: error.message })) : refresh()} disabled={workspaceBusy || (connectionReady && (view === "history" ? historyLoading : (view === "inventory" ? loading : false)))}><Icon name="refresh" /></button><button className="button primary" title={isStore ? "매장 상품 등록은 SWP 상점 관리에서 진행하세요" : undefined} disabled={workspaceBusy || isStore || !canMutate} onClick={() => setShowRegistration(true)}><Icon name="plus" size={18} />상품 등록</button></div></header>

      <div className="environment-note"><Icon name="info" size={17} /><span>{!connectionReady ? '저장소 연결 상태를 확인하지 못했습니다. 새로고침하거나 매장 서버 연결 화면을 확인하세요.' : isStore ? '매장 모드입니다. 재고 변경은 SWP 서버의 실제 상품 원장에 저장됩니다. 스마트스토어 반영 여부는 동기화 결과에서 확인하세요.' : '기존 SWP store와 분리된 테스트 DB입니다. 변경한 수량은 스마트스토어에 전송되지 않습니다.'}</span></div>

      {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label="알림 닫기" onClick={() => setNotice(null)}><Icon name="close" size={17} /></button></div>}

      {(view === 'inventory' || view === 'history') && <section className="stats-grid" aria-label="전체 재고 요약"><Stat label="등록 상품" value={overview?.productCount} suffix="종" /><Stat label="전체 재고 수량" value={overview?.totalStock} suffix="단위" hint="각 상품의 판매 단위 수량 합계" /><Stat label="재고 없음" value={overview?.outOfStockCount} suffix="종" warning /><Stat label="재고 변경 이력" value={overview?.movementCount} suffix="건" /></section>}

      {view === 'connection' && <StoreConnection connection={connection} ready={connectionReady} busy={workspaceBusy} onAction={changeConnection} />}
      {view === 'smartstore' && isStore && connectionReady && <SmartStorePanel refreshKey={refreshKey} key={connection?.serverUrl} onBusyChange={setIntegrationBusy} onStatus={status => setAppInfo(current => current ? { ...current, smartStoreConnected: Boolean(status.connected) } : current)} />}
      {view === 'inventory' ? <div className={`inventory-layout ${selected ? 'with-detail' : ''}`}>
        <section className="panel catalogue-panel" aria-label="상품 목록">
          <div className="panel-heading"><h2>상품 목록 <span>{formatNumber(productTotal)}</span></h2>{query && <button className="text-button" onClick={() => { if (workspaceBusy || !canMutate) return; setSearchInput(''); setQuery(''); setPage(0); }}>검색 초기화</button>}</div>
          <form className="search-form" role="search" onSubmit={event => { event.preventDefault(); if (workspaceBusy || !canMutate) return; setPage(0); setQuery(searchInput.trim()); }}><div className="search-input"><Icon name="search" size={19} /><input aria-label="상품명, 상품 코드 또는 세트 검색" placeholder="상품명, 상품 코드, 세트 검색" maxLength={200} value={searchInput} onChange={event => setSearchInput(event.target.value)} /><kbd>Enter</kbd></div><button className="button secondary" type="submit" disabled={loading || workspaceBusy || !canMutate}>검색</button></form>
          {loadError ? <div className="section-error" role="alert"><p>{loadError}</p><button className="button secondary" onClick={refresh}>다시 시도</button></div> : loading ? <div className="loading-state" role="status">상품을 불러오는 중…</div> : products.length === 0 ? <EmptyState title={query ? '검색 결과가 없습니다' : '등록된 상품이 없습니다'} description={query ? '상품명, 상품 코드 또는 세트를 확인해 주세요.' : isStore ? '매장 상품 등록은 SWP 상점 관리에서 진행하세요.' : '상품을 등록하면 재고와 입출고 이력을 관리할 수 있습니다.'}>{!query && !isStore && <button className="button primary" disabled={workspaceBusy} onClick={() => setShowRegistration(true)}><Icon name="plus" size={17} />첫 상품 등록</button>}</EmptyState> : <div className="table-scroll"><table className="product-table"><thead><tr><th scope="col">상품</th><th scope="col">구분</th><th scope="col" className="number-cell">재고</th><th scope="col" className="action-cell">관리</th></tr></thead><tbody>{products.map(product => <tr key={product.id} className={selected?.id === product.id ? 'selected-row' : ''}><td><div className="desktop-product-identity"><CardImage url={product.image} alt={`${product.name} 카드 이미지`} className="list-card-image" /><div><button className="product-name" disabled={workspaceBusy} onClick={() => setSelected(product)}>{product.name}</button><span className="product-code">{product.sku}{product.setName ? ` · ${product.setName}` : ''}</span></div></div></td><td><div className="product-meta">{[product.language, product.condition].filter(Boolean).join(' · ') || '—'}</div><span className={`stock-badge ${product.stock === 0 ? 'empty' : ''}`}>{product.stock === 0 ? '재고 없음' : '재고 있음'}</span></td><td className="number-cell"><strong>{formatNumber(product.stock)}</strong><span className="unit">{product.unit}</span></td><td className="action-cell"><button className={`button small ${selected?.id === product.id ? 'selected-button' : 'secondary'}`} aria-label={`${product.name} 재고 관리`} aria-pressed={selected?.id === product.id} disabled={workspaceBusy} onClick={() => setSelected(product)}>관리</button></td></tr>)}</tbody></table></div>}
          {!loadError && <Pagination total={productTotal} page={page} onChange={next => { setPage(next); setSelected(null); }} busy={loading || workspaceBusy || !canMutate} />}
        </section>

        {selected ? <StockPanel key={`${connection?.mode}-${selected.id}`} disabled={!canMutate || connectionBusy} product={selected} onBusyChange={setStockBusy} onClose={() => setSelected(null)} onHistory={() => openHistory(selected)} onChanged={result => { setSelected(result.product); refresh(); setNotice({ kind: 'success', text: `재고를 ${formatNumber(result.product.stock)}${result.product.unit}(으)로 저장했습니다.` }); }} onConflict={() => { refresh(); }} /> : <aside className="panel selection-placeholder"><div className="selection-illustration"><Icon name="box" size={34} /></div><h2>상품을 선택해 주세요</h2><p>목록에서 상품을 선택하면<br />입고·출고·실사 조정을 할 수 있습니다.</p><div className="selection-steps"><span><b>1</b>상품 검색</span><span><b>2</b>재고 변경 및 사유 입력</span><span><b>3</b>이력 자동 저장</span></div></aside>}
      </div> : view === 'history' ? <section className="panel history-panel" aria-label="재고 변경 이력"><div className="panel-heading"><h2>{historyProduct ? `${historyProduct.name} 이력` : '전체 이력'} <span>{formatNumber(historyTotal)}</span></h2>{historyProduct && <button className="text-button" onClick={() => { setHistoryProduct(null); setHistoryPage(0); }}>전체 이력 보기</button>}</div><div className="history-description">입고·출고·실사 조정은 변경 전후 수량과 사유가 함께 기록됩니다.</div>{historyError ? <div className="section-error" role="alert"><p>{historyError}</p><button className="button secondary" onClick={refresh}>다시 시도</button></div> : historyLoading ? <div className="loading-state" role="status">이력을 불러오는 중…</div> : history.length === 0 ? <EmptyState icon="history" title="재고 변경 이력이 없습니다" description="상품을 등록하거나 재고를 변경하면 이곳에 기록됩니다." /> : <div className="table-scroll"><table className="history-table"><thead><tr><th scope="col">일시</th><th scope="col">상품</th><th scope="col">유형</th><th scope="col" className="number-cell">증감</th><th scope="col" className="number-cell">변경 전 → 후</th><th scope="col">사유</th></tr></thead><tbody>{history.map(item => <tr key={item.id}><td className="date-cell">{formatDate(item.createdAt)}</td><td><strong className="history-product-name">{item.name}</strong><span className="product-code">{item.sku}</span></td><td><span className={`movement-type type-${item.type}`}>{typeLabels[item.type] || item.type}</span></td><td className={`number-cell delta ${item.delta > 0 ? 'positive' : item.delta < 0 ? 'negative' : ''}`}>{item.delta > 0 ? '+' : ''}{formatNumber(item.delta)}</td><td className="number-cell quantity-change"><span>{formatNumber(item.beforeStock)}</span><span aria-hidden="true"> → </span><strong>{formatNumber(item.afterStock)}</strong></td><td className="reason-cell">{item.reason}</td></tr>)}</tbody></table></div>}{!historyError && <Pagination total={historyTotal} page={historyPage} onChange={setHistoryPage} busy={historyLoading || workspaceBusy} />}</section> : null}

      <footer className="workspace-footer"><span><span className="local-dot" />{isStore ? '매장 서버 저장' : '로컬 저장'}{appInfo ? ` · ${appInfo.name}` : ''}</span>{(isStore ? connection?.serverUrl : appInfo?.databasePath) && <span className="database-path" title={isStore ? connection.serverUrl : appInfo.databasePath}>{isStore ? `서버: ${connection.serverUrl}` : `DB 위치: ${appInfo.databasePath}`}</span>}</footer>
    </main>
    {showRegistration && !isStore && <RegistrationModal onClose={() => setShowRegistration(false)} onRegistered={registered} />}
  </div>;
}

function Stat({ label, value, suffix, warning, hint }) {
  return <div className={`stat-card ${warning ? 'warning-stat' : ''}`} title={hint}><span className="stat-label">{label}</span><div><strong>{value === undefined ? '—' : formatNumber(value)}</strong><span>{suffix}</span></div></div>;
}

function StockPanel({ disabled, product, onClose, onHistory, onChanged, onConflict, onBusyChange }) {
  const [type, setType] = useState('IN');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const operation = useRef(null);
  const submitting = useRef(false);
  const quantityNumber = quantity === '' ? NaN : Number(quantity);
  const validQuantity = Number.isSafeInteger(quantityNumber) && quantityNumber >= (type === 'ADJUST' ? 0 : 1) && quantityNumber <= MAX_STOCK;
  const nextStock = validQuantity ? (type === 'ADJUST' ? quantityNumber : product.stock + (type === 'IN' ? quantityNumber : -quantityNumber)) : null;
  const validNextStock = nextStock !== null && nextStock >= 0 && nextStock <= MAX_STOCK;
  const noChange = type === 'ADJUST' && nextStock === product.stock;

  async function submit(event) {
    event.preventDefault();
    if (submitting.current || disabled) return;
    if (!validQuantity || !validNextStock || noChange || !reason.trim()) { setError('수량과 변경 사유를 확인해 주세요.'); return; }
    submitting.current = true; setBusy(true); onBusyChange?.(true); setError('');
    const payload = { productId: product.id, type, quantity: quantityNumber, reason: reason.trim(), expectedVersion: product.version };
    const key = JSON.stringify(payload);
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    try {
      const result = await call('adjustStock', { ...payload, operationId: operation.current.id });
      operation.current = null; setQuantity(''); setReason(''); setNeedsReview(false); onChanged(result);
    } catch (failure) {
      setError(failure.message);
      if (failure.code === 'CONFLICT') { setNeedsReview(true); onConflict(); }
    } finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  }

  return <aside className="panel stock-panel" aria-label={`${product.name} 재고 관리`}><div className="panel-heading"><h2>재고 관리</h2><button className="plain-icon" aria-label="상품 선택 닫기" onClick={onClose} disabled={busy}><Icon name="close" size={18} /></button></div><div className="selected-product"><CardImage url={product.image} alt={`${product.name} 카드 이미지`} className="selected-product-image" /><span className="product-code">{product.sku}</span><h3>{product.name}</h3><p>{[product.game, product.setName, product.language, product.condition].filter(Boolean).join(' · ') || '추가 구분 정보 없음'}</p><div className="current-stock"><span>현재 재고</span><div><strong>{formatNumber(product.stock)}</strong><span>{product.unit}</span></div></div></div><form className="stock-form" onSubmit={submit}><fieldset disabled={busy || disabled}><legend className="sr-only">재고 변경</legend><div className="segmented-control" role="group" aria-label="재고 변경 유형">{['IN', 'OUT', 'ADJUST'].map(value => <button key={value} type="button" aria-pressed={type === value} className={type === value ? 'active' : ''} onClick={() => { setType(value); setError(''); }}>{typeLabels[value]}</button>)}</div><label className="field"><span>{type === 'ADJUST' ? '실사 후 실제 수량' : `${typeLabels[type]} 수량`} <b>*</b></span><div className="input-with-unit"><input type="number" min={type === 'ADJUST' ? 0 : 1} max={MAX_STOCK} step="1" required placeholder="수량 입력" value={quantity} onChange={event => { setQuantity(event.target.value); }} /><span>{product.unit}</span></div></label>{type === 'ADJUST' && <p className="field-hint">증감량 대신 확인한 실제 재고 수량을 입력합니다.</p>}<label className="field"><span>변경 사유 <b>*</b></span><textarea rows={3} required maxLength={300} placeholder={type === 'IN' ? '입고 사유를 입력하세요' : type === 'OUT' ? '오프라인 판매 등 출고 사유를 입력하세요' : '실사 조정 사유를 입력하세요'} value={reason} onChange={event => { setReason(event.target.value); }} /></label><div className="stock-preview"><span>변경 후 재고</span><strong className={nextStock !== null && !validNextStock ? 'invalid-stock' : ''}>{nextStock === null ? '—' : `${formatNumber(nextStock)} ${product.unit}`}</strong></div>{nextStock !== null && !validNextStock && <p className="inline-error" role="alert">{nextStock < 0 ? '현재 재고보다 많이 출고할 수 없습니다.' : '최대 재고 수량을 초과합니다.'}</p>}{noChange && <p className="field-hint">현재 재고와 같은 수량입니다.</p>}{error && <div className="form-error" role="alert">{error}</div>}{needsReview && <div className="conflict-review"><p>최신 재고를 확인한 후 다시 저장해 주세요.</p><button type="button" className="button small secondary" onClick={() => { setNeedsReview(false); setError(''); }}>최신 수량 확인 완료</button></div>}<button className="button primary full-width" type="submit" disabled={busy || !validQuantity || !validNextStock || noChange || !reason.trim() || needsReview}>{busy ? '저장 중…' : '재고 변경 저장'}</button></fieldset></form><button className="history-link" onClick={onHistory} disabled={busy}><Icon name="history" size={17} />이 상품의 재고 이력<Icon name="arrow" size={15} /></button><div className="updated-at">최종 변경 {formatDate(product.updatedAt)}</div></aside>;
}

function RegistrationModal({ onClose, onRegistered }) {
  const dialogRef = useRef(null);
  const [form, setForm] = useState(freshProduct);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const operation = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); previousFocus?.focus?.(); };
  }, []);
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    const initialStock = form.initialStock === '' ? NaN : Number(form.initialStock);
    if (!form.sku.trim() || !form.name.trim() || !form.unit.trim() || !Number.isSafeInteger(initialStock) || initialStock < 0 || initialStock > MAX_STOCK) { setError('필수 항목과 초기 재고 수량을 확인해 주세요.'); return; }
    submitting.current = true; setBusy(true); setError('');
    const payload = { ...Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])), initialStock };
    const key = JSON.stringify(payload);
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    try { const product = await call('createProduct', { ...payload, operationId: operation.current.id }); operation.current = null; onRegistered(product); }
    catch (failure) { setError(failure.message); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <dialog ref={dialogRef} className="registration-dialog" aria-labelledby="registration-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><div className="dialog-heading"><div><h2 id="registration-title">상품 등록</h2><p>상품 코드로 상품과 재고를 구분합니다.</p></div><button type="button" className="plain-icon" aria-label="상품 등록 닫기" disabled={busy} onClick={onClose}><Icon name="close" /></button></div><form onSubmit={submit}><fieldset disabled={busy}><legend className="sr-only">상품 정보</legend><div className="form-grid"><label className="field"><span>상품 코드 <b>*</b></span><input autoFocus name="sku" required maxLength={64} value={form.sku} onChange={update} placeholder="고유 상품 코드" /></label><label className="field"><span>판매 단위 <b>*</b></span><input name="unit" required maxLength={20} value={form.unit} onChange={update} /></label><label className="field span-2"><span>상품명 <b>*</b></span><input name="name" required maxLength={200} value={form.name} onChange={update} placeholder="상품명을 입력하세요" /></label><label className="field span-2"><span>게임</span><select name="game" aria-label="상품 게임" value={form.game} onChange={update}><option value="">게임 선택</option>{GAME_OPTIONS.map(game => <option key={game} value={game}>{game}</option>)}</select></label><label className="field span-2"><span>세트 / 분류</span><input name="setName" maxLength={100} value={form.setName} onChange={update} /></label><label className="field"><span>언어</span><input name="language" maxLength={40} value={form.language} onChange={update} /></label><label className="field"><span>컨디션</span><input name="condition" maxLength={40} value={form.condition} onChange={update} /></label><label className="field span-2"><span>이미지 HTTPS 주소</span><input type="url" name="image" aria-label="상품 이미지 HTTPS 주소" maxLength={1000} value={form.image} onChange={update} placeholder="공식 카드 이미지 주소" /></label><label className="field span-2"><span>초기 재고 <b>*</b></span><input type="number" name="initialStock" min="0" max={MAX_STOCK} step="1" required value={form.initialStock} onChange={update} /><small>확인한 수량을 입력하세요. 등록 시 초기 재고 이력이 남습니다.</small></label></div><CardImageSearch product={form} disabled={busy} onApplyImage={(image, identity) => setForm(current => ["sku", "name", "game", "language"].every(key => (current[key] || "") === identity[key]) ? { ...current, image } : current)} />{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>취소</button><button className="button primary" type="submit" disabled={busy}>{busy ? '등록 중…' : '상품 등록'}</button></div></fieldset></form></dialog>;
}
