import React, { useEffect, useRef, useState } from 'react';

const statuses = {
  all: '전체',
  selling: '판매 중',
  soldOut: '품절',
  hidden: '비공개',
  archived: '보관된 예시',
};
const maxAdjustment = 1_000_000;
const maxStock = 99_999_999;

function productStatus(product) {
  if (product.sample) return 'archived';
  if (!product.active) return 'hidden';
  return product.stock > 0 ? 'selling' : 'soldOut';
}

function movementUrl(id) {
  return `/admin.html?section=movements&cardId=${encodeURIComponent(id)}`;
}

function StockAdjustment({ initialProduct, product, busy, saveStock, reload, perform, close }) {
  const [direction, setDirection] = useState('in');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [expectedStock, setExpectedStock] = useState(initialProduct.stock);
  const [review, setReview] = useState('');
  const form = useRef(null);
  useEffect(() => { form.current?.focus(); }, []);

  const currentStock = product?.stock ?? expectedStock;
  const amount = Number(quantity);
  const validAmount = /^[0-9]+$/.test(quantity) && Number.isSafeInteger(amount) && amount >= 1 && amount <= maxAdjustment;
  const delta = direction === 'in' ? amount : -amount;
  const nextStock = validAmount ? currentStock + delta : null;
  const validStock = nextStock !== null && nextStock >= 0 && nextStock <= maxStock;
  const needsReview = Boolean(review) || currentStock !== expectedStock;
  const unavailable = !product || product.sample;
  const submitDisabled = busy || unavailable || needsReview || !validStock || !reason.trim();

  async function refreshLatest() {
    setReview('loading');
    try {
      await reload();
      setReview('required');
    } catch {
      setReview('failed');
    }
  }

  function submit(event) {
    event.preventDefault();
    if (submitDisabled) return;
    saveStock(initialProduct.id, { delta, expectedStock, reason: reason.trim() }, refreshLatest);
  }

  return (
    <form ref={form} tabIndex={-1} className="admin-form stock-adjustment" aria-labelledby="adjustment-title" onSubmit={submit}>
      <div className="stock-adjustment-heading">
        <h3 id="adjustment-title">입출고</h3>
        <a href={movementUrl(initialProduct.id)} onClick={event => { if (busy) event.preventDefault(); }}
          aria-disabled={busy || undefined}>이 상품의 재고 이력</a>
      </div>
      <p className="stock-adjustment-product"><strong>{initialProduct.name}</strong><span>{initialProduct.id}</span></p>
      <dl className="stock-balance">
        <div><dt>현재 재고</dt><dd>{currentStock.toLocaleString('ko-KR')}장</dd></div>
        <div><dt>변경 후 재고</dt><dd>{nextStock === null ? '—' : `${nextStock.toLocaleString('ko-KR')}장`}</dd></div>
      </dl>
      {unavailable && <p className="admin-message" role="alert">이 상품은 현재 입출고할 수 없습니다.</p>}
      {review === 'loading' && <p role="status">최신 재고를 불러오는 중…</p>}
      {review === 'failed' && <div className="stock-review">
        <p role="alert">최신 재고를 확인하지 못했습니다. 입력한 수량과 사유는 보관했습니다.</p>
        <button type="button" className="admin-control" disabled={busy} onClick={() => perform(refreshLatest)}>최신 재고 다시 불러오기</button>
      </div>}
      {needsReview && review !== 'loading' && review !== 'failed' && !unavailable && <div className="stock-review">
        <p role="alert">처음 확인한 재고는 {expectedStock.toLocaleString('ko-KR')}장이었습니다. 현재 재고와 변경 후 수량을 다시 확인해 주세요.</p>
        <button type="button" className="admin-control" disabled={busy} onClick={() => {
          setExpectedStock(currentStock);
          setReview('');
        }}>최신 재고 확인</button>
      </div>}
      <fieldset className="stock-directions" disabled={busy || unavailable}>
        <legend>처리 유형</legend>
        <label><input type="radio" name="direction" value="in" checked={direction === 'in'} onChange={() => setDirection('in')} />입고</label>
        <label><input type="radio" name="direction" value="out" checked={direction === 'out'} onChange={() => setDirection('out')} />출고</label>
      </fieldset>
      <label>수량
        <input type="number" inputMode="numeric" name="quantity" min="1" max={maxAdjustment} step="1"
          required disabled={busy || unavailable} value={quantity} onChange={event => setQuantity(event.target.value)} />
      </label>
      {quantity && !validAmount && <p className="admin-message">수량은 1~1,000,000 사이의 정수로 입력해 주세요.</p>}
      {validAmount && !validStock && <p className="admin-message">변경 후 재고는 0~99,999,999장이어야 합니다.</p>}
      <label>사유
        <input type="text" name="reason" maxLength={300} required disabled={busy || unavailable}
          value={reason} onChange={event => setReason(event.target.value)} />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={submitDisabled}>재고 반영</button>
        <button type="button" disabled={busy} onClick={close}>닫기</button>
      </div>
    </form>
  );
}

export default function ProductInventory({ products, games, busy, onEdit, selected, onSelect, closeStock, saveStock, reload, perform }) {
  const [query, setQuery] = useState('');
  const [game, setGame] = useState('');
  const [status, setStatus] = useState('all');
  const term = query.trim().toLowerCase();
  const counts = { all: 0, selling: 0, soldOut: 0, hidden: 0, archived: 0 };
  const matching = products.filter(product =>
    (!game || product.game === game) && (!term || [product.name, product.id].some(value => value.toLowerCase().includes(term)))
  );
  const visible = matching.filter(product => {
    const state = productStatus(product);
    counts.all += 1;
    counts[state] += 1;
    return status === 'all' || status === state;
  });

  function resetFilters() {
    setQuery('');
    setGame('');
    setStatus('all');
  }

  return <>
    <div className="admin-product-filters">
      <label>상품 검색
        <input type="search" value={query} placeholder="상품명 또는 상품 코드" aria-label="상품명 또는 상품 코드 검색"
          onChange={event => setQuery(event.target.value)} />
      </label>
      <label>게임
        <select value={game} aria-label="게임 필터" onChange={event => setGame(event.target.value)}>
          <option value="">전체 게임</option>
          {games.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <div className="admin-stock-statuses" role="group" aria-label="상품 상태">
        {Object.entries(statuses).map(([key, title]) => (
          <button key={key} className="admin-control" type="button" aria-pressed={status === key}
            onClick={() => setStatus(key)}>{title} <span>{counts[key].toLocaleString('ko-KR')}</span></button>
        ))}
      </div>
    </div>
    <div className={selected ? 'admin-product-layout has-adjustment' : 'admin-product-layout'}>
      <div className="admin-product-list">
        {visible.length > 0 ? (
          <div className="admin-table-scroll" role="region" tabIndex={0} aria-label="상품 목록">
            <table><thead><tr><th scope="col">상품</th><th scope="col">가격</th><th scope="col">재고</th><th scope="col">구매 한도</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead>
              <tbody>{visible.map(product => {
                const state = productStatus(product);
                return <tr key={product.id} className={selected?.id === product.id ? 'stock-selected-row' : undefined}>
                  <td><strong>{product.name}</strong><span className="admin-product-code">{product.id}</span></td>
                  <td>{product.price.toLocaleString('ko-KR')}원</td>
                  <td>{product.stock.toLocaleString('ko-KR')}장</td>
                  <td>{product.purchaseLimit > 0 ? `계정당 누적 ${product.purchaseLimit.toLocaleString('ko-KR')}장` : '무제한'}</td>
                  <td><span className={`stock-status stock-status-${state}`}>{statuses[state]}</span></td>
                  <td><div className="admin-product-actions">
                    <button type="button" disabled={busy} onClick={() => onEdit(product)}>수정</button>
                    {!product.sample && <button type="button" disabled={busy} aria-pressed={selected?.id === product.id}
                      onClick={() => onSelect(product)}>입출고</button>}
                    <a href={movementUrl(product.id)} onClick={event => { if (busy) event.preventDefault(); }}
                      aria-disabled={busy || undefined} aria-label={`${product.name} 재고 이력`}>이력</a>
                  </div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : (
          <div className="admin-product-empty">
            <p>{products.length ? '검색 조건에 맞는 상품이 없습니다.' : '등록된 상품이 없습니다.'}</p>
            {products.length > 0 && <button type="button" className="admin-control" onClick={resetFilters}>필터 초기화</button>}
          </div>
        )}
      </div>
      {selected && <StockAdjustment key={selected.id} initialProduct={selected}
        product={products.find(product => product.id === selected.id)} busy={busy}
        saveStock={saveStock} reload={reload} perform={perform} close={closeStock} />}
    </div>
  </>;
}
