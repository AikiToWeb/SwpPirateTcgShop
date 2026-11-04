import React, { useEffect, useRef, useState } from 'react';
import { request } from './bridge.js';

const MAX_LIMIT = 1000000;

export default function PurchaseLimitEditor({ product, isStore, disabled, onBusyChange, onChanged, onConflict }) {
  const currentLimit = product.purchaseLimit ?? 0;
  const [value, setValue] = useState(String(currentLimit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const lock = useRef(false);
  useEffect(() => { setValue(String(currentLimit)); }, [product.id, product.version, currentLimit]);
  const numeric = value.trim() === '' ? NaN : Number(value);
  const valid = Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= MAX_LIMIT;

  async function save(event) {
    event.preventDefault();
    if (lock.current || disabled || needsReview) return;
    if (!valid) { setError('구매 한도는 0~1,000,000의 정수로 입력하세요.'); return; }
    if (numeric === currentLimit) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const result = await request('setPurchaseLimit', { productId: product.id, purchaseLimit: numeric, expectedVersion: product.version });
      setNeedsReview(false); onChanged(result);
    } catch (failure) {
      setError(failure.message);
      if (failure.code === 'CONFLICT') { setNeedsReview(true); onConflict(); }
    } finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }

  return <form className="purchase-limit-form" onSubmit={save} aria-label="구매 한도 설정"><fieldset disabled={disabled || busy}><legend>계정당 구매 한도</legend><div className="current-purchase-limit"><span>현재 설정</span><strong>{currentLimit > 0 ? `누적 ${Number(currentLimit).toLocaleString('ko-KR')} ${product.unit}` : '무제한'}</strong></div><label className="field"><span>변경할 한도 · 0은 무제한</span><input type="number" name="purchaseLimit" aria-label="계정당 구매 한도" required min="0" max={MAX_LIMIT} step="1" value={value} onChange={event => setValue(event.target.value)} /></label><p className="purchase-limit-description">{isStore ? 'SWP 계정당 누적 주문 수량에 적용합니다. 취소 주문은 제외하고 수령 완료 주문은 포함합니다. 네이버 계정의 구매 수량은 합산하지 않습니다.' : '로컬 모드는 한도 설정만 저장합니다. 계정별 주문 차단은 제공하지 않습니다. 매장 모드에서는 SWP 계정의 누적 주문에 적용합니다.'}</p>{error && <div className="form-error" role="alert">{error}</div>}{needsReview && <div className="conflict-review"><p>최신 한도와 재고를 확인한 후 다시 저장하세요.</p><button className="button secondary small" type="button" onClick={() => { setNeedsReview(false); setError(''); }}>최신 한도 확인 완료</button></div>}<button type="submit" className="button secondary full-width" disabled={disabled || busy || !valid || numeric === currentLimit || needsReview}>{busy ? '한도 저장 중…' : '구매 한도 저장'}</button></fieldset></form>;
}
