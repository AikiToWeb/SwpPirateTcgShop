import React, { useEffect, useRef, useState } from 'react';

const sources = { ROLLING_DICE: '롤링다이스', CARDNYANG: '카드냥', NAVER_SMARTSTORE: '네이버 스마트스토어' };
const statuses = {
  READY: '조회 완료', NO_MATCH: '일치 상품 없음', NOT_FOUND: '미취급 직접 확인', UNAVAILABLE: '조회 실패',
  CONFIG_REQUIRED: '연동 설정 필요', NEEDS_MAPPING: '상품 매핑 필요', NEEDS_REVIEW: '직접 확인 필요',
};
const money = value => `${Number(value).toLocaleString('ko-KR')}원`;
const positivePrice = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(value);
const stores = { cardnyang: '카드냥', cardbean: '카드빈', ckmr: '카드킹덤 마린포드' };
function sourceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
function sellerName(value) {
  try { const url = new URL(value); if (url.hostname !== 'smartstore.naver.com') return null; const slug = url.pathname.split('/').filter(Boolean)[0]; return slug ? stores[slug] || slug : null; } catch { return null; }
}
const emptyReference = id => ({ id, url: '', price: '', checkedAt: '', confirmed: false });
const resetConfirmations = references => references.map(row => row.confirmed || row.checkedAt ? { ...row, confirmed: false, checkedAt: '' } : row);

export default function PricingReference({ api, product, onApply, disabled }) {
  const [inputs, setInputs] = useState({ rollingUrl: '', cardnyangUrl: '', rollingAbsent: false, cardnyangAbsent: false, productType: 'SINGLE', unitCount: 1, naverReferences: [emptyReference(0)] });
  const [result, setResult] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0), controller = useRef(null), pending = useRef(false), referenceId = useRef(1);
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
  useEffect(() => { setInputs(current => current.naverReferences.some(row => row.confirmed || row.checkedAt) ? { ...current, naverReferences: resetConfirmations(current.naverReferences) } : current); }, [productSignature]);

  function update(changes) { invalidate(); setInputs(current => ({ ...current, naverReferences: resetConfirmations(current.naverReferences), ...changes })); }
  function updateReference(id, changes) {
    invalidate();
    setInputs(current => ({ ...current, naverReferences: current.naverReferences.map(row => row.id === id ? { ...row, confirmed: false, checkedAt: '', ...changes } : row) }));
  }
  function addReference() {
    if (disabled) return;
    invalidate();
    const id = referenceId.current++;
    setInputs(current => current.naverReferences.length >= 10 ? current : { ...current, naverReferences: [...current.naverReferences, emptyReference(id)] });
  }
  function removeReference(id) {
    invalidate(); setInputs(current => ({ ...current, naverReferences: current.naverReferences.filter(row => row.id !== id) }));
  }
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
        productType: inputs.productType, unitCount: Number(inputs.unitCount),
        naverReferences: inputs.naverReferences.filter(row => row.url.trim() || row.price !== '' || row.confirmed || row.checkedAt).map(row => ({
          url: row.url.trim(), price: row.price === '' ? null : Number(row.price), checkedAt: row.checkedAt || null, confirmed: row.confirmed,
        })),
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
  const selectedHref = sourceUrl(quote?.selectedUrl);
  const selectedSeller = sellerName(selectedHref);
  const selectedCandidateIndex = quote?.selectedUrl ? candidates.findIndex(candidate => candidate.url === quote.selectedUrl && candidate.source === quote.selectedSource) : -1;
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
      <div className="pricing-naver-references">
        <p className="pricing-store-links">참조 스토어: {Object.entries(stores).map(([slug, name]) => <a key={slug} href={`https://smartstore.naver.com/${slug}`} target="_blank" rel="noopener noreferrer">{name} ↗</a>)}</p>
        {inputs.naverReferences.map((row, index) => <fieldset className="pricing-naver-row" key={row.id}>
          <legend>네이버 참조 {index + 1}</legend><div className="pricing-inputs">
            <label className="pricing-query">네이버 스마트스토어 상품 URL {index + 1}<input type="url" placeholder="https://smartstore.naver.com/…" value={row.url} onChange={e => updateReference(row.id, { url: e.target.value })} /></label>
            <label>직접 확인 가격 (원) {index + 1}<input type="number" min="1" step="1" value={row.price} onChange={e => updateReference(row.id, { price: e.target.value })} /></label>
            <label className="checkbox"><input type="checkbox" aria-label={`네이버 참조 ${index + 1} 동일 상품과 가격 직접 확인`} checked={row.confirmed} onChange={e => updateReference(row.id, { confirmed: e.target.checked, checkedAt: e.target.checked ? new Date().toISOString() : '' })} />동일 상품과 가격 직접 확인</label>
            {row.checkedAt && <p className="pricing-note pricing-query">직접 확인 시각: {new Date(row.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>}
          </div><button type="button" aria-label={`네이버 참조 ${index + 1} 삭제`} onClick={() => removeReference(row.id)}>참조 삭제</button>
        </fieldset>)}
        <button type="button" disabled={disabled || inputs.naverReferences.length >= 10} onClick={addReference}>네이버 참조 추가 ({inputs.naverReferences.length}/10)</button>
      </div>
    </div>
    {!inputs.rollingAbsent || !inputs.cardnyangAbsent ? <p className="pricing-note">두 사이트의 상품 없음이 확인되기 전에는 네이버 대체 가격을 확정하지 않습니다.</p> : <p className="pricing-note">네이버 가격은 관리자가 직접 확인한 값이며 자동 조회한 시세가 아닙니다.</p>}
    <button type="button" className="pricing-lookup" disabled={disabled || loading} onClick={lookup}>{loading ? '조회 중' : '참조 기본값 조회'}</button>
    {error && <p className="pricing-error" role="alert">{error}</p>}
    {quote && <div className="pricing-result" aria-live="polite">
      <p><strong>{statuses[quote.status] || quote.status || '조회 결과 확인 필요'}</strong>{quote.selectedSource && ` · ${sources[quote.selectedSource] || quote.selectedSource}`}</p>
      {quote.checkedAt && <p className="pricing-note">조회 시각: {Number.isNaN(Date.parse(quote.checkedAt)) ? quote.checkedAt : new Date(quote.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>}
      {positivePrice(quote.recommendedPrice) && <p>참조 가격 <strong>{money(quote.recommendedPrice)}</strong></p>}
      {selectedHref && <p className="pricing-note">선택된 출처{selectedSeller && ` · ${selectedSeller}`}<br /><a href={selectedHref} target="_blank" rel="noopener noreferrer">{selectedHref} ↗</a></p>}
      {warnings.length > 0 && <ul className="pricing-warnings">{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      {quote.status === 'CONFIG_REQUIRED' && <p className="pricing-error">서버 연동 설정을 확인하세요. 수동 판매가는 그대로 유지됩니다.</p>}
      {quote.selectedSource === 'NAVER_SMARTSTORE' && <p className="pricing-note">네이버 참조 가격: 관리자 수동 확인 값</p>}
      {candidates.length > 0 && <ul className="pricing-candidates">{candidates.map((candidate, i) => {
        const href = sourceUrl(candidate.url);
        const seller = sellerName(href);
        return <li key={`${candidate.source}-${candidate.url || ''}-${i}`}><strong>{sources[candidate.source] || candidate.source || '출처'}{seller && ` · ${seller}`}</strong> · {statuses[candidate.status] || candidate.status || '확인 필요'}
          {i === selectedCandidateIndex && <span><strong>선택된 가격</strong></span>}
          {candidate.title && <span>{candidate.title}</span>}
          {positivePrice(candidate.price) && <span>{money(candidate.price)}</span>}
          {href && <a href={href} target="_blank" rel="noopener noreferrer">{href} ↗</a>}
          {candidate.reason && <p>{candidate.reason}</p>}
        </li>;
      })}</ul>}
      <button type="button" className="pricing-apply" disabled={!canApply} onClick={apply}>기본가격 적용</button>
    </div>}
  </fieldset>;
}
