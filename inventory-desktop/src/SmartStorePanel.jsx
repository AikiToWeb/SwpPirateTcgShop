import React, { useEffect, useRef, useState } from 'react';
import { request } from './bridge.js';

const fmt = value => value == null ? '—' : new Intl.NumberFormat('ko-KR').format(value);
const REMOTE_PAGE_SIZE = 20;
const time = value => {
  if (!value) return '—';
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric == null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? '시각 확인 필요' : date.toLocaleString('ko-KR');
};
const statusLabels = {
  SYNCED: '반영 완료', SUCCESS: '반영 완료', COMPLETED: '반영 완료', OK: '반영 완료',
  PENDING: '반영 대기', FAILED: '실패', ERROR: '실패', BLOCKED: '차단', DISABLED: '송신 중지',
  NOT_CONFIGURED: '미설정', UNCONFIGURED: '미설정', NOT_CONNECTED: '미연결',
  NEEDS_REVIEW: '확인 필요', REVIEW_REQUIRED: '확인 필요', CONFLICT: '충돌', UNKNOWN: '반영 확인 필요',
  MAPPED: '매핑됨', READY: '준비됨', BASELINE_REQUIRED: '기준 재고 준비 필요',
};
function ResultStatus({ value }) {
  const normalized = String(value || 'NEEDS_REVIEW').toUpperCase();
  const success = ['SYNCED', 'SUCCESS', 'COMPLETED', 'OK'].includes(normalized);
  return <span className={`sync-result-badge ${success ? 'success' : ''}`}>{statusLabels[normalized] || `확인 필요 (${value || '상태 없음'})`}</span>;
}

export default function SmartStorePanel({ onBusyChange, onStatus, refreshKey }) {
  const [status, setStatus] = useState(null);
  const [storeInfo, setStoreInfo] = useState(null);
  const [mappings, setMappings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [localProducts, setLocalProducts] = useState([]);
  const [localTotal, setLocalTotal] = useState(0);
  const [localPage, setLocalPage] = useState(0);
  const [localQuery, setLocalQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [originProductNo, setOriginProductNo] = useState('');
  const [optionId, setOptionId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [remoteQuery, setRemoteQuery] = useState('');
  const [remoteAppliedQuery, setRemoteAppliedQuery] = useState('');
  const [remotePage, setRemotePage] = useState(1);
  const [remoteProducts, setRemoteProducts] = useState([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteMessage, setRemoteMessage] = useState('');
  const [remoteHasNext, setRemoteHasNext] = useState(false);
  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [checked, setChecked] = useState([]);
  const [syncResults, setSyncResults] = useState(null);
  const [baselineReview, setBaselineReview] = useState(null);
  const [baselineConfirmed, setBaselineConfirmed] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusyChange(false); }; }, []);
  function markBusy(value) { if (alive.current) { setBusy(value); onBusyChange(value); } }
  async function loadStatus() {
    const [nextStatus, info, mappingData] = await Promise.all([request('getSmartStoreStatus'), request('getStoreInfo'), request('getSmartStoreMappings')]);
    if (!alive.current) return;
    setStatus(nextStatus); setStoreInfo(info); setMappings(mappingData.items || []); onStatus(nextStatus);
    setChecked(current => current.filter(id => (mappingData.items || []).some(item => String(item.productId) === String(id))));
    return mappingData;
  }
  async function loadLocal(search = localQuery, page = localPage) {
    const data = await request('listProducts', { query: search, limit: 20, offset: page * 20 });
    if (!alive.current) return;
    setLocalProducts(data.items); setLocalTotal(data.total); setLocalPage(page); setLocalQuery(search);
  }
  async function task(action) {
    if (lock.current) return;
    lock.current = true; markBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { lock.current = false; markBusy(false); }
  }
  useEffect(() => { task(() => Promise.all([loadStatus(), loadLocal('', 0)])); }, [refreshKey]);

  function chooseLocal(product) {
    setSelected(product); setConfirmed(false); setNotice(''); setError('');
    const mapping = mappings.find(item => String(item.productId) === String(product.id));
    setOriginProductNo(mapping?.originProductNo == null ? '' : String(mapping.originProductNo));
    setOptionId(mapping?.optionId == null ? '' : String(mapping.optionId));
  }
  async function saveMapping(event) {
    event.preventDefault();
    if (!selected || !confirmed || !/^\d+$/.test(originProductNo.trim()) || (optionId.trim() && !/^\d+$/.test(optionId.trim()))) { setError('상품과 원상품번호·옵션번호를 확인하고 동일 상품 확인에 체크하세요.'); return; }
    await task(async () => {
      try {
        await request('saveSmartStoreMapping', { productId: selected.id, originProductNo: originProductNo.trim(), optionId: optionId.trim() || null, expectedVersion: selected.version, confirmIdentity: true });
      } catch (failure) {
        if (failure.code === 'CONFLICT' && alive.current) { setSelected(null); setConfirmed(false); await loadLocal(); }
        throw failure;
      }
      if (!alive.current) return;
      setConfirmed(false); await loadStatus(); setNotice('상품 매핑을 저장했습니다. 재고 송신은 별도 동기화 작업에서 실행합니다.');
    });
  }
  async function searchRemote(page = 1, search = remoteAppliedQuery) {
    await task(async () => {
      const data = await request('listSmartStoreProducts', { query: search, page });
      if (!alive.current) return;
      const total = data.total || 0;
      const pageSize = Number.isSafeInteger(data.pageSize) && data.pageSize > 0 ? data.pageSize : REMOTE_PAGE_SIZE;
      setRemoteProducts(data.items || []); setRemoteTotal(total); setRemotePage(page); setRemoteLoaded(true); setRemoteAppliedQuery(search);
      setRemoteHasNext(typeof data.hasNext === 'boolean' ? data.hasNext : page * pageSize < total);
      setRemoteMessage(typeof data.message === 'string' ? data.message : '');
    });
  }
  async function sync(ids) {
    if (!ids.length) return;
    await task(async () => {
      setSyncResults(null);
      const data = await request('syncSmartStore', { productIds: ids });
      if (!alive.current) return;
      setSyncResults(data);
      await loadStatus();
      setNotice('동기화 요청을 처리했습니다. 아래 상품별 결과를 확인하세요.');
    });
  }
  async function reviewBaseline(mapping) {
    await task(async () => {
      const list = await request('listProducts', { query: String(mapping.productId), limit: 100, offset: 0 });
      const product = list.items.find(item => String(item.id) === String(mapping.productId));
      if (!product) throw new Error('최신 매장 상품을 찾을 수 없습니다. 상품 목록과 매핑을 새로 조회하세요.');
      if (!alive.current) return;
      setBaselineReview({ mapping, product }); setBaselineConfirmed(false);
    });
  }
  async function confirmBaseline() {
    if (!baselineReview || !baselineConfirmed) return;
    const { product, mapping } = baselineReview;
    if (mapping.remoteStock == null || Number(mapping.remoteStock) !== product.stock) { setError('매장과 네이버 재고가 같아야 기준 재고를 확인할 수 있습니다.'); return; }
    await task(async () => {
      const result = await request('confirmSmartStoreBaseline', { productId: product.id, expectedVersion: product.version, confirmedStock: product.stock, confirmOutstandingOrdersIncluded: true });
      if (!alive.current) return;
      setBaselineConfirmed(false);
      if (result?.baselineVerified === true) {
        await loadStatus();
        if (!alive.current) return;
        setBaselineReview(null); setNotice('초기 재고 기준 확인을 저장했습니다. 실제 송신은 상품별 동기화 결과로 확인하세요.');
        return;
      }
      const resultStatus = String(result?.status || 'UNKNOWN').toUpperCase();
      setError(`${statusLabels[resultStatus] || '확인 필요'}: ${result?.message || '초기 재고 기준 확인이 완료되지 않았습니다. 최신 수량과 주문 반영 여부를 다시 확인하세요.'}`);
      const latestMappings = await loadStatus();
      const latestProducts = await request('listProducts', { query: String(product.id), limit: 100, offset: 0 });
      if (!alive.current) return;
      const latestProduct = latestProducts.items.find(item => String(item.id) === String(product.id));
      const latestMapping = latestMappings?.items?.find(item => String(item.productId) === String(product.id));
      setBaselineReview(current => current ? { product: latestProduct || current.product, mapping: latestMapping || current.mapping } : current);
    });
  }
  const canSend = Boolean(status?.configured && status?.connected && status?.syncEnabled);

  return <div className="smartstore-workspace">
    <section className="panel"><div className="panel-heading"><h2>스마트스토어 연결 상태</h2><button className="button secondary small" disabled={busy} onClick={() => task(loadStatus)}>{busy ? '처리 중…' : '상태 새로고침'}</button></div><div className="smartstore-body"><div className="integration-status-grid"><div><span>서버 설정</span><strong>{status ? status.configured ? '설정됨' : '미설정' : '확인 중'}</strong></div><div><span>네이버 API 연결</span><strong>{status ? status.connected ? '연결 확인됨' : '연결 안 됨' : '확인 중'}</strong></div><div><span>재고 송신 허용</span><strong>{status ? status.syncEnabled ? '사용' : '중지' : '확인 중'}</strong></div><div><span>자동 동기화</span><strong>{status?.autoSyncEnabled === true ? "사용" : "중지"}</strong></div><div><span>마지막 동기화</span><strong>{time(status?.lastSyncAt)}</strong></div></div><p className="mode-note">{status?.message || storeInfo?.message || '서버가 반환하는 실제 연결 상태를 확인합니다.'}</p>{status && !status.configured && <p className="integration-help">스마트스토어 개설과 커머스API센터 애플리케이션 등록 후 서버 담당자가 API 키·호출 IP를 설정해야 합니다. 이 프로그램에는 API 키를 입력하지 않습니다.</p>}{status && status.autoSyncEnabled !== true && <p className="integration-help">자동 동기화가 중지되어 있습니다. 연결과 송신이 허용되면 선택한 상품을 수동으로 동기화할 수 있습니다.</p>}{status && !canSend && <p className="integration-help">연결 확인과 서버의 기준 재고 준비·송신 허용이 완료되어야 재고를 보낼 수 있습니다. 미설정·차단 상태에서는 반영 완료로 표시하지 않습니다.</p>}</div></section>
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status">{notice}</div>}
    <div className="mapping-layout"><section className="panel"><div className="panel-heading"><h2>매장 상품 선택</h2><span className="subtle-text">이름으로 자동 연결하지 않습니다</span></div><div className="smartstore-body"><form className="mapping-search" onSubmit={event => { event.preventDefault(); task(() => loadLocal(query.trim(), 0)); }}><input aria-label="매핑할 매장 상품 검색" maxLength={200} placeholder="상품명 또는 상품 코드" value={query} onChange={event => setQuery(event.target.value)} /><button className="button secondary" disabled={busy}>검색</button></form><div className="local-product-options" role="group" aria-label="매핑할 매장 상품">{localProducts.map(product => <button type="button" disabled={busy} key={product.id} className={String(selected?.id) === String(product.id) ? 'active' : ''} aria-pressed={String(selected?.id) === String(product.id)} onClick={() => chooseLocal(product)}><strong>{product.name}</strong><span>{product.sku} · {[product.language, product.condition, product.unit].filter(Boolean).join(' · ')}</span><span>현재 재고 {fmt(product.stock)} {product.unit}</span></button>)}{!busy && localProducts.length === 0 && <p className="integration-help">조회된 매장 상품이 없습니다. 상품 등록은 SWP 상점 관리에서 진행하세요.</p>}</div><div className="compact-pagination"><span>{fmt(localTotal)}건 · {localPage + 1}쪽</span><button className="button secondary small" disabled={busy || localPage === 0} onClick={() => task(() => loadLocal(localQuery, localPage - 1))}>이전</button><button className="button secondary small" disabled={busy || (localPage + 1) * 20 >= localTotal} onClick={() => task(() => loadLocal(localQuery, localPage + 1))}>다음</button></div></div></section>
    <section className="panel"><div className="panel-heading"><h2>원상품·옵션 매핑</h2></div><div className="smartstore-body">{selected ? <><div className="mapping-selected"><strong>{selected.name}</strong><span>{selected.sku} · {selected.setName || '세트 정보 없음'}</span><span>{[selected.language, selected.condition, selected.unit].filter(Boolean).join(' · ')}</span></div><form onSubmit={saveMapping}><fieldset disabled={busy}><label className="field"><span>네이버 원상품번호 <b>*</b></span><input required inputMode="numeric" pattern="[0-9]+" maxLength={20} value={originProductNo} onChange={event => { setOriginProductNo(event.target.value); setConfirmed(false); }} /></label><label className="field"><span>네이버 옵션번호</span><input inputMode="numeric" pattern="[0-9]*" maxLength={20} value={optionId} onChange={event => { setOptionId(event.target.value); setConfirmed(false); }} /><small>옵션이 없는 상품만 비워 두세요.</small></label><label className="identity-confirmation"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>상품·세트·언어·컨디션·판매 단위와 옵션이 같은지 직접 확인했습니다.</span></label><button className="button primary full-width" disabled={busy || !confirmed || !originProductNo.trim()}>매핑 저장</button></fieldset></form></> : <p className="integration-help">왼쪽에서 매장 상품을 선택하세요. 이름이 같아도 언어·컨디션·판매 단위가 다르면 다른 상품입니다.</p>}</div></section></div>
    <section className="panel"><div className="panel-heading"><h2>스마트스토어 상품 조회</h2><span className="subtle-text">조회만으로 매핑·재고가 변경되지 않습니다</span></div><div className="smartstore-body"><form className="mapping-search" onSubmit={event => { event.preventDefault(); searchRemote(1, remoteQuery.trim()); }}><input aria-label="스마트스토어 상품 검색" maxLength={200} value={remoteQuery} onChange={event => setRemoteQuery(event.target.value)} placeholder="스마트스토어 상품명 검색" /><button className="button secondary" disabled={busy || !status?.configured || !status?.connected}>상품 조회</button></form>{remoteLoaded && <>{remoteMessage && <p className="integration-help" role="status">{remoteMessage}</p>}<div className="remote-product-list">{remoteProducts.map(product => <article key={product.originProductNo}><strong>{product.name}</strong><p>원상품번호 {String(product.originProductNo)} · 채널상품번호 {String(product.channelProductNo ?? '—')} · 재고 {fmt(product.stock)} · {product.status}</p><button className="button secondary small" disabled={busy || !selected} onClick={() => { setOriginProductNo(String(product.originProductNo)); setOptionId(''); setConfirmed(false); }}>원상품번호 입력</button>{product.options?.length > 0 && <ul>{product.options.map(option => <li key={option.optionId}><span>{option.name} · 옵션 {String(option.optionId)} · 재고 {fmt(option.stock)}</span><button className="text-button" disabled={busy || !selected} onClick={() => { setOriginProductNo(String(product.originProductNo)); setOptionId(String(option.optionId)); setConfirmed(false); }}>이 옵션 번호 입력</button></li>)}</ul>}</article>)}{remoteProducts.length === 0 && <p className="integration-help">조회 결과가 없습니다.</p>}</div><div className="compact-pagination"><span>총 {fmt(remoteTotal)}건 · {remotePage}쪽</span><button className="button secondary small" disabled={busy || remotePage <= 1} onClick={() => searchRemote(remotePage - 1)}>이전</button><button className="button secondary small" disabled={busy || !remoteHasNext} onClick={() => searchRemote(remotePage + 1)}>다음</button></div></>}</div></section>
    <section className="panel"><div className="panel-heading"><h2>매핑된 상품과 재고 동기화</h2><button className="button primary small" disabled={busy || !canSend || checked.length === 0} onClick={() => sync(checked)}>선택 {checked.length}건 동기화</button></div><div className="smartstore-body"><p className="integration-help">선택한 상품의 매장 판매가능 재고를 전송합니다. 온라인 주문 수집·기준 재고 검증이 완료되지 않았으면 서버가 송신을 차단할 수 있습니다.</p></div><div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="매핑된 상품 전체 선택" disabled={busy || mappings.length === 0} checked={mappings.length > 0 && checked.length === mappings.length} onChange={event => setChecked(event.target.checked ? mappings.map(item => item.productId) : [])} /></th><th>매장 상품</th><th>네이버 상품 / 옵션</th><th>매장 / 네이버 재고</th><th>상태 / 마지막 반영</th><th>동기화</th></tr></thead><tbody>{mappings.map(mapping => <tr key={mapping.productId}><td><input type="checkbox" aria-label={`${mapping.productId} 동기화 선택`} disabled={busy} checked={checked.some(id => String(id) === String(mapping.productId))} onChange={event => setChecked(current => event.target.checked ? [...current, mapping.productId] : current.filter(id => String(id) !== String(mapping.productId)))} /></td><td>{String(mapping.productId)}</td><td>{String(mapping.originProductNo)}<span className="product-code">옵션 {mapping.optionId == null ? '없음' : String(mapping.optionId)}</span></td><td>{fmt(mapping.localStock)} / {fmt(mapping.remoteStock)}</td><td><ResultStatus value={mapping.status} /><span className="product-code">{time(mapping.lastSyncedAt)}</span>{mapping.message && <p className="mapping-message">{mapping.message}</p>}</td><td><div className="mapping-row-actions"><button className="button secondary small" disabled={busy || !canSend} onClick={() => sync([mapping.productId])}>동기화</button><button className="text-button" disabled={busy || !status?.configured || !status?.connected} onClick={() => reviewBaseline(mapping)}>{mapping.baselineVerified ? "초기 기준 다시 확인" : "초기 재고 기준 확인"}</button><span className="product-code">{mapping.baselineVerified ? "초기 기준 확인됨" : "초기 기준 미확인"}</span></div></td></tr>)}</tbody></table></div>{mappings.length === 0 && <p className="empty-integration">저장된 상품 매핑이 없습니다.</p>}</section>
    {baselineReview && <section className="panel" aria-label="초기 재고 기준 확인"><div className="panel-heading"><h2>초기 재고 기준 확인</h2><button className="text-button" disabled={busy} onClick={() => setBaselineReview(null)}>닫기</button></div><div className="smartstore-body"><div className="mapping-selected"><strong>{baselineReview.product.name}</strong><span>{baselineReview.product.sku} · {baselineReview.product.language} · {baselineReview.product.condition} · {baselineReview.product.unit}</span><span>매장 판매가능 수량 {fmt(baselineReview.product.stock)} / 네이버 수량 {fmt(baselineReview.mapping.remoteStock)}</span></div><p className="integration-help">네이버 상품·옵션의 현재 수량과 매장 재고가 일치하는지 확인합니다. 기존 미출고 주문이 매장 판매가능 수량에 반영되지 않았다면 먼저 주문·재고를 점검하세요.</p><label className="identity-confirmation"><input type="checkbox" checked={baselineConfirmed} disabled={busy} onChange={event => setBaselineConfirmed(event.target.checked)} /><span>현재 판매가능 수량에 기존 스마트스토어 미출고 주문 차감이 포함된 것을 확인했습니다.</span></label>{(baselineReview.mapping.remoteStock == null || Number(baselineReview.mapping.remoteStock) !== baselineReview.product.stock) && <p className="form-error">매장과 네이버 수량이 같지 않거나 네이버 수량이 조회되지 않았습니다. 현재 재고를 먼저 확인하세요.</p>}<button className="button primary" disabled={busy || !baselineConfirmed || baselineReview.mapping.remoteStock == null || Number(baselineReview.mapping.remoteStock) !== baselineReview.product.stock} onClick={confirmBaseline}>기준 재고 확인 저장</button></div></section>}
    {syncResults && <section className="panel"><div className="panel-heading"><h2>최근 동기화 요청 결과</h2><span className="subtle-text">{time(syncResults.lastSyncAt)}</span></div><div className="table-scroll"><table><thead><tr><th>매장 상품</th><th>처리 결과</th><th>안내</th></tr></thead><tbody>{(syncResults.items || []).map((item, index) => <tr key={`${item.productId}-${index}`}><td>{String(item.productId)}</td><td><ResultStatus value={item.status} /></td><td className="reason-cell">{item.message || '—'}</td></tr>)}</tbody></table></div>{!syncResults.items?.length && <p className="empty-integration">상품별 처리 결과가 없습니다. 반영 여부를 확인해 주세요.</p>}</section>}
  </div>;
}
