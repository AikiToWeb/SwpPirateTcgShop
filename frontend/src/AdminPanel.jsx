import React, { useCallback, useEffect, useRef, useState } from 'react';
import PricingReference from './PricingReference.jsx';
import InventoryDevices from './InventoryDevices.jsx';
import CardImageSearch from './CardImageSearch.jsx';
import ProductInventory from './ProductInventory.jsx';
import { PublishTime } from './VisibilityControls.jsx';

const blank = { id: '', name: '', en: '', set: '', game: '', condition: 'NM', language: '한국어', price: 0, stock: 0, purchaseLimit: 0, image: '', active: false };
export default function AdminPanel({ api, tab, label, busy, setBusy, cardId }) {
  const [data, setData] = useState(null);
  const [games, setGames] = useState([]);
  const [editor, setEditor] = useState(null), [stock, setStock] = useState(null), [event, setEvent] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [editorSession, setEditorSession] = useState(0);
  const lock = useRef(false);
  const editorForm = useRef(null);

  const load = useCallback(async signal => {
    const endpoint = tab === 'database' ? 'summary' : tab;
    const needsGames = tab === 'products' || tab === 'events';
    const query = tab === 'movements' && cardId ? `?cardId=${encodeURIComponent(cardId)}` : '';
    const [records, classifications] = await Promise.all([
      api(`/admin/${endpoint}${query}`, { signal }),
      needsGames ? api('/games', { signal }) : [],
    ]);
    if (!signal?.aborted) {
      setData(records);
      setGames(classifications);
    }
  }, [api, tab, cardId]);

  useEffect(() => {
    if (tab === 'inventory') return;
    const request = new AbortController();
    load(request.signal).catch(error => {
      if (!request.signal.aborted) {
        setFeedback({ error: true, retry: true, text: `관리 정보를 불러오지 못했습니다. ${error.message}` });
      }
    });
    return () => request.abort();
  }, [load, tab]);

  async function perform(task) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await task();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function run(task, onConflict) {
    return perform(async () => {
      let saved = false;
      try {
        let message = '새로고침 완료';
        if (task) {
          const result = await task();
          saved = true;
          message = typeof result === 'string' ? result : '저장 완료';
        }
        await load();
        setFeedback({ text: message });
      } catch (error) {
        if (!saved && onConflict && error.status === 409) {
          await onConflict();
          return;
        }
        const retry = saved || !task;
        if (retry && (!stock || saved)) setData(null);
        const text = saved ? `저장은 완료됐지만 목록을 불러오지 못했습니다. ${error.message}`
          : retry ? `관리 정보를 불러오지 못했습니다. ${error.message}` : error.message;
        setFeedback({ error: true, retry, text });
      }
    });
  }

  useEffect(() => { if (editorSession) editorForm.current?.focus(); }, [editorSession]);

  function openEditor(value) {
    setEditorSession(current => current + 1);
    setStock(null);
    setEditor({ ...value, initialActive: value.active, purchaseLimit: value.purchaseLimit ?? 0 });
  }

  function openStock(product) {
    setEditor(null);
    setStock(product);
  }

  function saveStock(id, adjustment, onConflict) {
    return run(async () => {
      await api(`/admin/products/${encodeURIComponent(id)}/stock`, { method: 'POST', body: adjustment });
      setStock(null);
    }, onConflict);
  }

  function saveVisibility(body, onSaved) {
    return run(async () => {
      const result = await api('/admin/products/visibility', { method: 'POST', body });
      onSaved();
      return `상품 ${result.updated.toLocaleString('ko-KR')}개의 공개 상태를 변경했습니다.`;
    });
  }

  function field(label, key, type = 'text', required = true) { return <label>{label}<input type={type} name={key} aria-label={key === 'purchaseLimit' ? '계정당 구매 한도' : undefined} required={required} min={type === 'number' ? 0 : undefined} max={key === 'purchaseLimit' ? 1000000 : undefined} step={type === 'number' ? 1 : undefined} value={editor[key] ?? ''} disabled={key === 'id' && editor.edit} maxLength={key === 'id' ? 40 : key === 'image' ? 1000 : 200} onChange={e => setEditor({ ...editor, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} /></label>; }
  function saveProduct(e) { e.preventDefault(); run(async () => {
    const { edit, stock: initialStock, sample, publishAt, initialActive, ...product } = editor;
    if (edit && (publishAt || product.active === initialActive)) delete product.active;
    product.purchaseLimit = Number(editor.purchaseLimit ?? 0);
    if (!Number.isSafeInteger(product.purchaseLimit) || product.purchaseLimit < 0 || product.purchaseLimit > 1000000) throw new Error('구매 한도는 0~1,000,000의 정수로 입력하세요.');
    if (sample) product.confirmedStock = Number(initialStock);
    if (edit) await api(`/admin/products/${product.id}`, { method: 'PUT', body: product });
    else await api('/admin/products', { method: 'POST', body: { product, stock: Number(initialStock) } });
    setEditor(null);
  }); }
  return <section className="admin-panel" aria-labelledby="admin-section-title">
    <div className="admin-section-heading">
      <h2 id="admin-section-title">{label}</h2>
      {tab !== 'inventory' && <button className="admin-control" type="button" disabled={busy || (!data && !feedback)} onClick={() => run()}>{feedback?.retry ? '다시 불러오기' : '새로고침'}</button>}
    </div>
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'admin-message' : 'admin-success'}>{feedback.text}</p>}
    {tab !== 'inventory' && !data && !feedback && <p role="status">불러오는 중…</p>}
    {tab === 'products' && data && <>
      <button className="solid" disabled={busy} onClick={() => openEditor({ ...blank, game: games[0] || '' })}>상품 등록</button>
      {editor && <><form className="admin-form" ref={editorForm} tabIndex={-1} onSubmit={saveProduct}><h3>{editor.edit ? '상품 수정' : '상품 등록'}</h3>{editor.sample && <p>이전 예시 상품입니다. 실제 판매 정보로 확인해 저장하면 일반 상품으로 전환됩니다.</p>}
        {field('상품 코드', 'id')}{field('상품명', 'name')}{field('영문명', 'en', 'text', false)}{field('세트명', 'set')}
        <label>게임<select value={editor.game} onChange={e => setEditor({ ...editor, game: e.target.value })}>{games.map(g => <option key={g}>{g}</option>)}</select></label>
        <label>컨디션<select value={editor.condition} onChange={e => setEditor({ ...editor, condition: e.target.value })}>{['NM', 'EX', 'VG', 'G'].map(g => <option key={g}>{g}</option>)}</select></label>{field('언어', 'language')}{field('판매가 (원)', 'price', 'number')}{field('계정당 구매 한도 (0=무제한)', 'purchaseLimit', 'number')}<p className="purchase-limit-note">SWP 계정당 누적 구매 수량입니다. 0은 무제한이며 취소 주문은 제외하고 수령 완료 주문은 포함합니다. 네이버 계정의 구매 수량은 합산하지 않습니다.</p>{(!editor.edit || editor.sample) && field('실물 확인 재고', 'stock', 'number')}{field('이미지 HTTPS 주소 또는 파일명', 'image', 'text', false)}
        <CardImageSearch key={editorSession} api={api} product={editor} disabled={busy} onApplyImage={(image, identity) => setEditor(current => current && identity && ['id', 'name', 'game', 'language'].every(key => (current[key] || '') === identity[key]) ? { ...current, image } : current)} />
        {editor.publishAt
          ? <p className="admin-schedule-note">공개 예약: <PublishTime value={editor.publishAt} />. 예약 변경은 상품 목록의 공개 설정에서 진행하세요.</p>
          : <label className="checkbox"><input type="checkbox" checked={editor.active} onChange={e => setEditor({ ...editor, active: e.target.checked })} />판매 공개</label>}
        <div className="form-actions"><button type="submit" disabled={busy}>저장</button><button type="button" onClick={() => setEditor(null)}>닫기</button></div>
      </form><PricingReference key={editorSession} api={api} product={editor} disabled={busy} onApply={price => setEditor(current => current ? { ...current, price } : current)} /></>}
      <ProductInventory products={data} games={games} busy={busy} selected={stock} onSelect={openStock}
        onEdit={product => openEditor({ ...product, stock: product.sample ? '' : product.stock, edit: true })}
        closeStock={() => setStock(null)} saveStock={saveStock} reload={load} perform={perform}
        editing={Boolean(editor)} saveVisibility={saveVisibility} />
    </>}
    {tab === 'orders' && data && <div>{data.map(order => (
      <article className="order-item" key={order.id}>
        <h3>{order.id} {order.sample && '· 이전 예시 주문'}</h3>
        <p>주문자: {order.nickname || '닉네임 없음'} · 회원번호 {order.userId ?? '확인 불가'}</p>
        <p>{new Date(order.created * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · {order.status} · {order.total.toLocaleString()}원</p>
        <p>{order.items.map(item => `${item.name} ${item.quantity}장`).join(', ')}</p>
        {order.status === '접수' && !order.sample && (
          <button className="cancel-order" disabled={busy} onClick={() => run(() => api(`/admin/orders/${order.id}/complete`, { method: 'POST' }))}>수령 완료 처리</button>
        )}
      </article>
    ))}{!data.length && <p>주문이 없습니다.</p>}</div>}
    {tab === 'events' && data && <><button className="solid" disabled={busy} onClick={() => setEvent({ game: games[0] || '', title: '', startsAt: '', description: '', active: true })}>일정 등록</button>
      {event && <form className="admin-form" onSubmit={e => { e.preventDefault(); run(async () => { const { id, ...body } = event; await api(id ? `/admin/events/${id}` : '/admin/events', { method: id ? 'PUT' : 'POST', body }); setEvent(null); }); }}><label>게임<select required value={event.game} onChange={e => setEvent({ ...event, game: e.target.value })}>{games.map(g => <option key={g}>{g}</option>)}</select></label><label>제목<input required maxLength={200} value={event.title} onChange={e => setEvent({ ...event, title: e.target.value })} /></label><label>일시 (한국 시간)<input type="datetime-local" required value={event.startsAt} onChange={e => setEvent({ ...event, startsAt: e.target.value })} /></label><label>안내<input maxLength={1000} value={event.description} onChange={e => setEvent({ ...event, description: e.target.value })} /></label><label className="checkbox"><input type="checkbox" checked={event.active} onChange={e => setEvent({ ...event, active: e.target.checked })} />공개</label><div className="form-actions"><button disabled={busy}>저장</button><button type="button" onClick={() => setEvent(null)}>닫기</button></div></form>}
      {data.map(e => <article className="order-item" key={e.ID}><strong>{e.TITLE} · {e.IS_SAMPLE ? '보관된 예시' : e.ACTIVE ? '공개' : '비공개'}</strong><p>{e.STARTS_AT}</p><button className="admin-control" type="button" disabled={busy} onClick={() => setEvent({ id: e.ID, game: e.GAME, title: e.TITLE, startsAt: String(e.STARTS_AT).replace(' ', 'T').slice(0, 16), description: e.DESCRIPTION, active: e.ACTIVE })}>수정</button></article>)}{!data.length && <p>등록된 일정이 없습니다.</p>}</>}
    {tab === 'movements' && <>
      {cardId && <div className="admin-movement-context">
        <p>상품 코드 <strong>{cardId}</strong></p>
        <a className="admin-control" href="/admin.html?section=movements">전체 재고 이력</a>
      </div>}
      {data && <div className="admin-table-scroll" role="region" tabIndex={0} aria-label="재고 이력 목록">
        <table>
          <thead><tr><th scope="col">상품</th><th scope="col">증감</th><th scope="col">잔고</th><th scope="col">사유</th><th scope="col">일시</th></tr></thead>
          <tbody>{data.map((movement, index) => <tr key={index}>
            <td>{movement.CARD_ID}</td>
            <td>{movement.DELTA > 0 ? '+' : ''}{Number(movement.DELTA).toLocaleString('ko-KR')}</td>
            <td>{Number(movement.BALANCE).toLocaleString('ko-KR')}</td>
            <td>{movement.REASON}{movement.ORDER_ID && <><br />{movement.ORDER_ID}</>}</td>
            <td>{new Date(movement.CREATED * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td>
          </tr>)}</tbody>
        </table>
        {!data.length && <p>{cardId ? '이 상품의 입출고 이력이 없습니다.' : '입출고 이력이 없습니다.'}</p>}
      </div>}
    </>}
    {tab === 'database' && data && <div className="admin-table-scroll"><p>운영 상품 {data.products}개 · 보관된 예시 {data.sampleProducts}개</p><table><thead><tr><th>DB 테이블</th><th>저장 건수</th></tr></thead><tbody>{Object.entries(data.tables).map(([name, n]) => <tr key={name}><td>{name}</td><td>{n}</td></tr>)}</tbody></table></div>}
    {tab === 'inventory' && <InventoryDevices api={api} />}
  </section>;
}
