import React, { useEffect, useRef, useState } from 'react';
import { request } from './bridge.js';

// The renderer receives image bytes through IPC; it never requests a remote URL.
const imageData = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=\r\n]+$/;

export default function CardImage({ url, alt, className = '', emptyLabel = '이미지 없음', onStateChange }) {
  const [dataUrl, setDataUrl] = useState('');
  const [dataRequest, setDataRequest] = useState(0);
  const [state, setState] = useState(url ? 'loading' : 'empty');
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const sequence = useRef(0);
  const currentUrl = useRef(url);
  const callback = useRef(onStateChange);
  currentUrl.current = url;
  callback.current = onStateChange;

  function updateState(next) { setState(next); callback.current?.(next); }
  useEffect(() => {
    const current = ++sequence.current;
    setDataUrl(''); setError('');
    if (!url) { updateState('empty'); return; }
    updateState('loading');
    request('loadCardImage', { url }).then(data => {
      if (current !== sequence.current) return;
      if (!imageData.test(data?.dataUrl || '')) throw new Error('지원하지 않는 이미지 응답입니다.');
      setDataRequest(current); setDataUrl(data.dataUrl);
    }).catch(failure => {
      if (current !== sequence.current) return;
      setError(failure.message || '이미지를 불러오지 못했습니다.'); updateState('failed');
    });
    return () => { sequence.current++; };
  }, [url, retryKey]);

  function retry(event) {
    event.preventDefault(); event.stopPropagation();
    sequence.current++; setDataUrl(''); setError(''); updateState('loading');
    setRetryKey(current => current + 1);
  }

  return <div className={`desktop-card-image ${className}`} data-image-state={state}>
    {dataUrl && <img key={`${dataRequest}-${url}`} src={dataUrl} alt={alt} onLoad={() => { if (currentUrl.current === url && sequence.current === dataRequest) updateState('loaded'); }} onError={() => { if (currentUrl.current === url && sequence.current === dataRequest) { setError('이미지 파일을 표시하지 못했습니다.'); updateState('failed'); } }} />}
    {state === 'empty' && <span className="desktop-image-placeholder">{emptyLabel}</span>}
    {state === 'loading' && <span className="desktop-image-placeholder" role="status">이미지 로딩 중</span>}
    {state === 'failed' && <div className="desktop-image-failure"><span className="desktop-image-placeholder image-failed" title={error} role="status">이미지 로드 실패</span><button type="button" className="desktop-image-retry" aria-label={`${alt || '카드 이미지'} 이미지 다시 불러오기`} title="이미지 다시 불러오기" onClick={retry}>이미지 다시 불러오기</button></div>}
  </div>;
}
