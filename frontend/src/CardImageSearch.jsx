import React, { useEffect, useRef, useState } from 'react';

const statusLabels = {
  OK: '이미지 후보',
  NO_RESULTS: '일치하는 카드 없음',
  UNSUPPORTED_LANGUAGE: '지원하지 않는 언어',
  UNSUPPORTED_GAME: '지원하지 않는 게임',
  SOURCE_UNAVAILABLE: '공식 출처 조회 실패',
};

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function previewUrl(value) {
  const image = String(value || '').trim();
  if (!image) return null;
  const remote = httpsUrl(image);
  if (remote) return remote;
  return /^[a-zA-Z0-9_./-]+$/.test(image) && !image.startsWith('//') && !image.includes('..') ? `/rolling-assets/${image}` : null;
}

function displayTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function CurrentPreview({ image }) {
  const [loadState, setLoadState] = useState('loading');
  const src = previewUrl(image);
  if (!image) return <div className="card-image-current-empty">설정된 이미지가 없습니다.</div>;
  if (!src) return <p className="card-image-error" role="alert">이미지 미리보기는 HTTPS 주소 또는 파일명을 사용하세요.</p>;
  return <div className="card-image-current"><img src={src} alt="저장 전 상품 이미지 미리보기" referrerPolicy="no-referrer" onLoad={() => setLoadState('loaded')} onError={() => setLoadState('failed')} /><div><strong>저장 전 이미지 미리보기</strong><p>{loadState === 'failed' ? '이미지를 불러오지 못했습니다. 주소와 접근 권한을 확인하세요.' : loadState === 'loading' ? '이미지 불러오는 중…' : '아래 후보를 선택하면 현재 이미지가 교체됩니다.'}</p><span className="card-image-url">{image}</span></div></div>;
}

function Candidate({ candidate, disabled, onSelect }) {
  const [loadState, setLoadState] = useState('loading');
  const imageState = useRef('loading');
  const imageUrl = httpsUrl(candidate.imageUrl);
  const src = imageUrl && imageUrl.length <= 1000 ? imageUrl : null;
  const source = httpsUrl(candidate.sourceUrl);
  function mark(state) { imageState.current = state; setLoadState(state); }
  function select() {
    if (disabled || !src || imageState.current !== 'loaded') return;
    onSelect(candidate);
  }
  const metadata = [
    ['카드번호', candidate.cardNumber], ['세트', candidate.setName], ['언어', candidate.language],
    ['판본', candidate.variant], ['피치', candidate.pitch],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  return <article className="card-image-candidate"><div className="card-image-thumbnail">{src ? <img src={src} alt={candidate.name || '공식 카드 이미지 후보'} referrerPolicy="no-referrer" loading="lazy" onLoad={() => mark('loaded')} onError={() => mark('failed')} /> : <span>이미지 주소 확인 필요</span>}</div><div className="card-image-candidate-details"><strong>{candidate.name || '이름 정보 없음'}</strong><dl>{metadata.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>{source && <a href={source} target="_blank" rel="noopener noreferrer">공식 출처 확인 ↗</a>}{(!src || loadState === 'failed') && <p className="card-image-error" role="alert">이미지를 불러올 수 없어 선택할 수 없습니다.</p>}{src && loadState === 'loading' && <p className="card-image-note">이미지 불러오는 중…</p>}<button type="button" aria-label={`${candidate.cardNumber || candidate.name || "후보"} 이미지 선택`} disabled={disabled || !src || loadState !== 'loaded'} onClick={select}>이 이미지 선택</button></div></article>;
}

export default function CardImageSearch({ api, product, disabled, onApplyImage }) {
  const [query, setQuery] = useState(product.name || '');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const controller = useRef(null);
  const pending = useRef(false);
  const productSignature = JSON.stringify({ id: product.id || '', name: product.name || '', game: product.game || '', language: product.language || '' });
  const signature = JSON.stringify({ productSignature, query: query.trim() });
  const currentSignature = useRef(signature);
  const currentlyDisabled = useRef(disabled);
  currentSignature.current = signature;
  currentlyDisabled.current = disabled;

  function invalidate() {
    sequence.current++; controller.current?.abort(); controller.current = null;
    pending.current = false; setLoading(false); setResult(null); setError(''); setNotice('');
  }
  useEffect(() => {
    invalidate(); setQuery(product.name || '');
    return () => { sequence.current++; controller.current?.abort(); pending.current = false; };
  }, [productSignature]);

  function updateQuery(value) { invalidate(); setQuery(value); }
  async function lookup(page = 0) {
    if (pending.current || currentlyDisabled.current) return;
    if (!query.trim()) { setError('카드명 또는 카드번호를 입력하세요.'); return; }
    if (query.trim().length > 120) { setError('검색어는 120자 이내로 입력하세요.'); return; }
    pending.current = true; setLoading(true); setError(''); setNotice(''); setResult(null);
    const requestedSignature = signature;
    const request = ++sequence.current;
    const abort = new AbortController(); controller.current = abort;
    try {
      const data = await api('/admin/images/search', { method: 'POST', signal: abort.signal, body: { game: product.game, query: query.trim(), language: product.language, page } });
      if (request !== sequence.current || currentSignature.current !== requestedSignature) return;
      setResult({ data, signature: requestedSignature, request, page });
    } catch (failure) {
      if (request === sequence.current && currentSignature.current === requestedSignature && failure.name !== 'AbortError') setError(failure.message || '공식 카드 이미지를 조회하지 못했습니다.');
    } finally {
      if (request === sequence.current) { pending.current = false; controller.current = null; setLoading(false); }
    }
  }
  const active = result?.signature === signature && result?.request === sequence.current ? result : null;
  const data = active?.data;
  const candidates = data?.status === 'OK' && Array.isArray(data.items) ? data.items : [];
  const source = httpsUrl(data?.sourceUrl);
  const checkedAt = displayTime(data?.checkedAt);
  function apply(candidate) {
    const image = httpsUrl(candidate.imageUrl);
    if (currentlyDisabled.current || loading || !image || image.length > 1000 || !active || active.request !== sequence.current || currentSignature.current !== active.signature || data?.status !== 'OK') return;
    if (!candidates.includes(candidate)) return;
    onApplyImage(image, { id: product.id || '', name: product.name || '', game: product.game || '', language: product.language || '' });
    setNotice('이미지 입력값을 변경했습니다. 상품·언어·판본을 확인한 뒤 상품 저장을 눌러 반영하세요.');
  }

  return <fieldset className="card-image-search" disabled={disabled}><legend>공식 카드 이미지 찾기</legend><p className="card-image-note">게임·언어·카드번호·세트·판본을 확인하고 이미지를 직접 선택하세요. 검색만으로 이미지를 바꾸지 않습니다.</p><CurrentPreview key={product.image || 'empty'} image={product.image} /><div className="card-image-search-context"><span>게임: {product.game || '미선택'}</span><span>상품 언어: {product.language || '미입력'}</span></div><div className="card-image-search-input"><label>카드명 또는 카드번호<input aria-label="공식 카드 이미지 검색어" value={query} maxLength={120} onChange={event => updateQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); lookup(0); } }} placeholder="카드명 또는 카드번호 입력" /></label><button type="button" disabled={disabled || loading || !query.trim()} onClick={() => lookup(0)}>{loading ? '공식 이미지 조회 중…' : '공식 이미지 검색'}</button></div>{loading && <p role="status" className="card-image-note">공식 출처를 조회하고 있습니다.</p>}{error && <div className="card-image-error" role="alert"><p>{error}</p><button type="button" disabled={disabled || loading} onClick={() => lookup(0)}>다시 조회</button></div>}{notice && <p className="card-image-selected-notice" role="status">{notice}</p>}{data && <div className="card-image-results"><div className="card-image-results-heading"><strong>{statusLabels[data.status] || '조회 결과 확인 필요'}{candidates.length ? ` · ${candidates.length}개` : ''}</strong>{source ? <a href={source} target="_blank" rel="noopener noreferrer">{data.sourceName || '공식 출처'} ↗</a> : data.sourceName && <span>{data.sourceName}</span>}</div>{data.message && <p className={data.status === 'SOURCE_UNAVAILABLE' ? 'card-image-error' : 'card-image-note'} role={data.status === 'SOURCE_UNAVAILABLE' ? 'alert' : 'status'}>{data.message}</p>}{checkedAt && <p className="card-image-note">조회 시각: {checkedAt}</p>}{data.status === 'UNSUPPORTED_LANGUAGE' && <p className="card-image-note">다른 언어의 이미지를 자동 적용하지 않습니다. 판매할 상품의 언어를 확인해 위 상품 정보를 수정한 뒤 다시 검색하세요.</p>}{data.status === 'UNSUPPORTED_GAME' && <p className="card-image-note">지원 게임을 확인하거나 기존 이미지 주소 입력을 사용하세요.</p>}{data.status === 'NO_RESULTS' && <p className="card-image-note">카드번호 또는 공식 카드명으로 다시 검색해 주세요.</p>}{data.status === 'SOURCE_UNAVAILABLE' && <button type="button" disabled={disabled || loading} onClick={() => lookup(active.page)}>다시 조회</button>}{candidates.length > 0 && <div className="card-image-candidate-grid">{candidates.map((candidate, index) => <Candidate key={`${active.request}-${candidate.id || index}-${candidate.imageUrl}`} candidate={candidate} disabled={disabled || loading || !active} onSelect={apply} />)}</div>}{(['OK', 'NO_RESULTS'].includes(data.status) || active.page > 0) && <div className="card-image-pagination"><span>{active.page + 1}쪽</span><button type="button" disabled={disabled || loading || active.page <= 0} onClick={() => lookup(active.page - 1)}>이전</button><button type="button" disabled={disabled || loading || !data.hasMore} onClick={() => lookup(active.page + 1)}>다음</button></div>}</div>}</fieldset>;
}
