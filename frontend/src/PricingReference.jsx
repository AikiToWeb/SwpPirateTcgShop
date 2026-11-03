import React, { useEffect, useRef, useState } from 'react';

const sources = { ROLLING_DICE: '롤링다이스', CARDNYANG: '카드냥', NAVER_SMARTSTORE: '네이버 스마트스토어' };
const statuses = {
  READY: '조회 완료', NO_MATCH: '일치 상품 없음', NOT_FOUND: '미취급 직접 확인', UNAVAILABLE: '조회 실패',
  CONFIG_REQUIRED: '연동 설정 필요', NEEDS_MAPPING: '상품 매핑 필요', NEEDS_REVIEW: '직접 확인 필요',
};
const money = value => `${Number(value).toLocaleString('ko-KR')}원`;
const positivePrice = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(value);
function sourceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}

export default function PricingReference({ api, product, onApply, disabled }) {
  const [inputs, setInputs] = useState({ rollingUrl: '', cardnyangUrl: '', rollingAbsent: false, cardnyangAbsent: false, productType: 'SINGLE', unitCount: 1, naverUrl: '', naverManualPrice: '', naverCheckedAt: '', naverConfirmed: false });
  const [result, setResult] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0), controller = useRef(null), pending = useRef(false);
  const metadata = { name: product.name || '', en: product.en || '', set: product.set || '', game: product.game || '', condition: product.condition || '', language: product.language || '' };
  const signature = JSON.stringify({ id: product.id || '', ...metadata, ...inputs });
  const productSignature = JSON.stringify({ id: product.id || '', ...metadata });
  const currentSignature = useRef(signature);
  currentSignature.current = signature;

  function invalidate() {
    sequence.current += 1; controller.current?.abort(); controller.current = null;
    pending.current = false; setLoading(false); setResult(null); setError('');
  }
  useEffect(() => {
    invalidate();
    return () => { sequence.current += 1; controller.current?.abort(); pending.current = false; };
  }, [signature]);
  useEffect(() => { setInputs(current => current.naverConfirmed ? { ...current, naverConfirmed: false, naverCheckedAt: '' } : current); }, [productSignature]);

  function update(changes) { invalidate(); setInputs(current => ({ ...current, naverConfirmed: false, naverCheckedAt: '', ...changes })); }
  async function lookup() {
    if (pending.current || disabled) return;
    if (!Number.isInteger(Number(inputs.unitCount)) || Number(inputs.unitCount) < 1) { setError('판매 묶음 수는 1 이상의 정수로 입력하세요.'); return; }
    pending.current = true; setLoading(true); setError(''); setResult(null);
    const request = ++sequence.current, requestedSignature = signature;
    const abort = new AbortController(); controller.current = abort;
    try {
      const data = await api('/admin/pricing/quote', { method: 'POST', signal: abort.signal, body: {
        ...metadata, rollingUrl: inputs.rollingAbsent ? '' : inputs.rollingUrl.trim(), cardnyangUrl: inputs.cardnyangAbsent ? '' : inputs.cardnyangUrl.trim(),
        rollingAbsent: inputs.rollingAbsent, cardnyangAbsent: inputs.cardnyangAbsent,
        productType: inputs.productType, unitCount: Number(inputs.unitCount), naverUrl: inputs.naverUrl.trim(),
        naverManualPrice: inputs.naverManualPrice === '' ? null : Number(inputs.naverManualPrice), naverCheckedAt: inputs.naverCheckedAt || null, naverConfirmed: inputs.naverConfirmed,
      } });
      if (sequence.current !== request || currentSignature.current !== requestedSignature) return;
      setResult({ data, signature: requestedSignature });
    } catch (e) {
      if (sequence.current === request && currentSignature.current === requestedSignature && e.name !== 'AbortError') setError(e.message || '가격을 조회할 수 없습니다.');
    } finally {
      if (sequence.current === request) { pending.current = false; controller.current = null; setLoading(false); }
    }
  }
  const quote = result?.signature === signature ? result.data : null;
  const canApply = !disabled && !loading && quote?.status === 'READY' && positivePrice(quote.recommendedPrice);
  const warnings = Array.isArray(quote?.warnings) ? quote.warnings : [];
  const candidates = Array.isArray(quote?.quotes) ? quote.quotes : [];
  function apply() {
    if (!canApply || currentSignature.current !== result.signature) return;
    onApply(quote.recommendedPrice);
  }

  return <fieldset className="pricing-reference" disabled={disabled}>
    <legend>참조 기본가격</legend>
    <p className="pricing-note">조회 결과는 적용 버튼을 눌러야 판매가에 반영됩니다. 판매가는 직접 수정할 수 있습니다.</p>
    <div className="pricing-inputs">
      <label>롤링다이스 상품 링크<input type="url" placeholder="https://…" value={inputs.rollingUrl} disabled={disabled || inputs.rollingAbsent} onChange={e => update({ rollingUrl: e.target.value })} /></label>
      <label className="checkbox"><input type="checkbox" checked={inputs.rollingAbsent} onChange={e => update({ rollingAbsent: e.target.checked, ...(e.target.checked ? { rollingUrl: '' } : {}) })} />롤링다이스 상품 없음 확인</label>
      <label>카드냥 상품 링크<input type="url" placeholder="https://…" value={inputs.cardnyangUrl} disabled={disabled || inputs.cardnyangAbsent} onChange={e => update({ cardnyangUrl: e.target.value })} /></label>
      <label className="checkbox"><input type="checkbox" checked={inputs.cardnyangAbsent} onChange={e => update({ cardnyangAbsent: e.target.checked, ...(e.target.checked ? { cardnyangUrl: '' } : {}) })} />카드냥 상품 없음 확인</label>
      <label>상품 형태<select value={inputs.productType} onChange={e => update({ productType: e.target.value })}><option value="SINGLE">싱글 카드</option><option value="PACK">팩</option><option value="BOX">박스</option><option value="DECK">덱</option><option value="CASE">케이스</option></select></label>
      <label>판매 묶음 수<input type="number" min="1" step="1" value={inputs.unitCount} onChange={e => update({ unitCount: e.target.value })} /></label>
      <p className="pricing-note pricing-query">1덱·1박스는 판매 묶음 1개입니다. 내부 카드 수나 팩 수로 환산하지 않습니다.</p>
      <p className="pricing-note pricing-query">네이버 쇼핑 검색 API가 종료되어 스마트스토어 상품 URL과 직접 확인한 가격을 입력해야 합니다.</p>
      <label className="pricing-query">네이버 스마트스토어 상품 URL<input type="url" placeholder="https://smartstore.naver.com/…" value={inputs.naverUrl} onChange={e => update({ naverUrl: e.target.value })} /></label>
      <label>직접 확인한 네이버 가격 (원)<input type="number" min="1" step="1" value={inputs.naverManualPrice} onChange={e => update({ naverManualPrice: e.target.value })} /></label>
      <label className="checkbox"><input type="checkbox" checked={inputs.naverConfirmed} onChange={e => update({ naverConfirmed: e.target.checked, naverCheckedAt: e.target.checked ? new Date().toISOString() : '' })} />네이버 상품과 가격을 직접 확인했습니다</label>
      {inputs.naverCheckedAt && <p className="pricing-note pricing-query">직접 확인 시각: {new Date(inputs.naverCheckedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>}
    </div>
    {!inputs.rollingAbsent || !inputs.cardnyangAbsent ? <p className="pricing-note">두 사이트의 상품 없음이 확인되기 전에는 네이버 대체 가격을 확정하지 않습니다.</p> : <p className="pricing-note">네이버 가격은 관리자가 직접 확인한 값이며 자동 조회한 시세가 아닙니다.</p>}
    <button type="button" className="pricing-lookup" disabled={disabled || loading} onClick={lookup}>{loading ? '조회 중' : '참조 기본값 조회'}</button>
    {error && <p className="pricing-error" role="alert">{error}</p>}
    {quote && <div className="pricing-result" aria-live="polite">
      <p><strong>{statuses[quote.status] || quote.status || '조회 결과 확인 필요'}</strong>{quote.selectedSource && ` · ${sources[quote.selectedSource] || quote.selectedSource}`}</p>
      {quote.checkedAt && <p className="pricing-note">조회 시각: {Number.isNaN(Date.parse(quote.checkedAt)) ? quote.checkedAt : new Date(quote.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>}
      {positivePrice(quote.recommendedPrice) && <p>참조 가격 <strong>{money(quote.recommendedPrice)}</strong></p>}
      {warnings.length > 0 && <ul className="pricing-warnings">{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      {quote.status === 'CONFIG_REQUIRED' && <p className="pricing-error">서버 연동 설정을 확인하세요. 수동 판매가는 그대로 유지됩니다.</p>}
      {quote.selectedSource === 'NAVER_SMARTSTORE' && <p className="pricing-note">네이버 참조 가격: 관리자 수동 확인 값</p>}
      {candidates.length > 0 && <ul className="pricing-candidates">{candidates.map((candidate, i) => {
        const href = sourceUrl(candidate.url);
        return <li key={`${candidate.source}-${i}`}><strong>{sources[candidate.source] || candidate.source || '출처'}</strong> · {statuses[candidate.status] || candidate.status || '확인 필요'}
          {candidate.title && <span>{candidate.title}</span>}
          {positivePrice(candidate.price) && <span>{money(candidate.price)}</span>}
          {href && <a href={href} target="_blank" rel="noopener noreferrer">상품 출처 확인 ↗</a>}
          {candidate.reason && <p>{candidate.reason}</p>}
        </li>;
      })}</ul>}
      <button type="button" className="pricing-apply" disabled={!canApply} onClick={apply}>기본가격 적용</button>
    </div>}
  </fieldset>;
}
