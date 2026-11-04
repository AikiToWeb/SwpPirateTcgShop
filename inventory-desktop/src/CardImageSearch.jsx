import React, { useEffect, useRef, useState } from 'react';
import CardImage from './CardImage.jsx';
import { request } from './bridge.js';

const labels = { OK: '이미지 후보', NO_RESULTS: '일치하는 카드 없음', UNSUPPORTED_GAME: '지원하지 않는 게임', UNSUPPORTED_LANGUAGE: '지원하지 않는 언어', SOURCE_UNAVAILABLE: '공식 출처 조회 실패' };

function Candidate({ item, disabled, onSelect }) {
  const [imageState, setImageState] = useState('loading');
  const stateRef = useRef('loading');
  const metadata = [['카드번호', item.cardNumber], ['세트', item.setName], ['언어', item.language], ['판본', item.variant], ['피치', item.pitch]].filter(([, value]) => value !== '' && value !== null && value !== undefined);
  function imageChanged(state) { stateRef.current = state; setImageState(state); }
  function choose() { if (!disabled && stateRef.current === 'loaded') onSelect(item); }
  return <article className="desktop-image-candidate card-image-candidate"><CardImage url={item.imageUrl} alt={`${item.name || item.cardNumber || '카드'} 후보 이미지`} className="candidate-card-image" onStateChange={imageChanged} /><div><strong>{item.name || '이름 정보 없음'}</strong><dl>{metadata.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{String(value)}</dd></div>)}</dl>{item.sourceUrl && <span className="official-source-url" title={item.sourceUrl}>공식 출처: {item.sourceUrl}</span>}{imageState === 'failed' && <p className="inline-error">이미지를 불러오지 못해 선택할 수 없습니다.</p>}<button className="button secondary small" type="button" aria-label={`${item.cardNumber || item.name || '후보'} 이미지 선택`} disabled={disabled || imageState !== 'loaded'} onClick={choose}>이 이미지 선택</button></div></article>;
}

export default function CardImageSearch({ product, disabled, onApplyImage }) {
  const [query, setQuery] = useState(product.name || '');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const pending = useRef(false);
  const identity = { sku: product.sku || '', name: product.name || '', game: product.game || '', language: product.language || '' };
  const identitySignature = JSON.stringify(identity);
  const signature = JSON.stringify({ identitySignature, query: query.trim() });
  const currentSignature = useRef(signature);
  const currentDisabled = useRef(disabled);
  currentSignature.current = signature;
  currentDisabled.current = disabled;

  function invalidate() {
    sequence.current++; pending.current = false;
    setLoading(false); setResult(null); setError(''); setNotice('');
  }
  useEffect(() => {
    invalidate(); setQuery(product.name || '');
    return () => { sequence.current++; pending.current = false; };
  }, [identitySignature]);
  function updateQuery(value) { invalidate(); setQuery(value); }
  async function lookup(page = 0) {
    if (pending.current || currentDisabled.current) return;
    if (!product.game || !product.language.trim()) { setError('상품의 게임과 언어를 먼저 입력하세요.'); return; }
    if (!query.trim() || query.trim().length > 120) { setError('검색어를 1~120자로 입력하세요.'); return; }
    pending.current = true; setLoading(true); setError(''); setNotice(''); setResult(null);
    const current = ++sequence.current;
    const requestedSignature = signature;
    try {
      const data = await request('searchCardImages', { game: product.game, language: product.language.trim(), query: query.trim(), page });
      if (current !== sequence.current || currentSignature.current !== requestedSignature) return;
      setResult({ data, page, signature: requestedSignature, request: current });
    } catch (failure) {
      if (current === sequence.current && currentSignature.current === requestedSignature) setError(failure.message || '공식 카드 이미지를 조회하지 못했습니다.');
    } finally { if (current === sequence.current) { pending.current = false; setLoading(false); } }
  }
  const active = result?.signature === signature && result?.request === sequence.current ? result : null;
  const data = active?.data;
  const items = data?.status === 'OK' && Array.isArray(data.items) ? data.items : [];
  function apply(item) {
    if (currentDisabled.current || loading || !active || currentSignature.current !== active.signature || active.request !== sequence.current || !items.includes(item)) return;
    if (typeof item.imageUrl !== 'string' || item.imageUrl.length > 1000) return;
    onApplyImage(item.imageUrl, identity);
    setNotice('이미지를 선택했습니다. 미리보기를 확인한 뒤 상품 등록을 눌러 저장하세요.');
  }

  return <fieldset className="desktop-image-search" disabled={disabled}><legend>공식 카드 이미지 찾기</legend><p className="image-search-note">검색 후 카드번호·세트·언어·판본을 확인하고 이미지를 선택하세요. 선택하면 기존 이미지가 교체됩니다.</p><div className="desktop-image-query"><label className="field"><span>카드명 또는 카드번호</span><input aria-label="공식 카드 이미지 검색어" maxLength={120} value={query} onChange={event => updateQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); lookup(0); } }} /></label><button className="button secondary small" type="button" disabled={disabled || loading || !query.trim()} onClick={() => lookup(0)}>{loading ? '공식 이미지 조회 중…' : '공식 이미지 검색'}</button></div>{loading && <p className="image-search-note" role="status">공식 카드 목록을 조회하고 있습니다.</p>}{error && <div className="form-error" role="alert">{error}<button className="text-button" type="button" disabled={disabled || loading} onClick={() => lookup(0)}>다시 조회</button></div>}{notice && <p className="desktop-image-notice" role="status">{notice}</p>}{data && <div className="desktop-image-result card-image-results"><div className="desktop-image-result-heading"><strong>{labels[data.status] || '조회 결과 확인 필요'}</strong><span>{data.sourceName}</span></div>{data.message && <p className="image-search-note" role={data.status === 'SOURCE_UNAVAILABLE' ? 'alert' : 'status'}>{data.message}</p>}{data.sourceUrl && <p className="official-source-url" title={data.sourceUrl}>공식 출처: {data.sourceUrl}</p>}{data.status === 'UNSUPPORTED_LANGUAGE' && <p className="image-search-note">다른 언어의 이미지를 자동 적용하지 않습니다. 상품 언어를 확인한 뒤 다시 검색하세요.</p>}{data.status === 'SOURCE_UNAVAILABLE' && <button type="button" className="button secondary small" disabled={disabled || loading} onClick={() => lookup(active.page)}>다시 조회</button>}{items.map((item, index) => <Candidate key={`${active.request}-${item.id || index}-${item.imageUrl}`} item={item} disabled={disabled || loading} onSelect={apply} />)}{(['OK', 'NO_RESULTS'].includes(data.status) || active.page > 0) && <div className="compact-pagination"><span>{active.page + 1}쪽</span><button className="button secondary small" type="button" disabled={disabled || loading || active.page <= 0} onClick={() => lookup(active.page - 1)}>이전</button><button className="button secondary small" type="button" disabled={disabled || loading || !data.hasMore} onClick={() => lookup(active.page + 1)}>다음</button></div>}</div>}<div className="desktop-registration-preview"><CardImage key={product.image || 'empty'} url={product.image} alt="저장 전 상품 이미지 미리보기" className="registration-card-image" /><div><strong>저장 전 이미지 미리보기</strong><p className="image-search-note">상품 등록 전 선택한 이미지를 확인하세요.</p>{product.image && <span className="official-source-url">{product.image}</span>}</div></div></fieldset>;
}
