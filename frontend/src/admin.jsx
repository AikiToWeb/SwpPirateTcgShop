import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './rolling.css';
import AdminPanel from './AdminPanel.jsx';
import { shopApi } from './shopApi.js';

const sections = [
  ['products', '상품'],
  ['orders', '주문'],
  ['events', '일정'],
  ['movements', '재고 이력'],
  ['database', 'DB 테이블'],
  ['inventory', '재고관리 앱'],
];

function AdminApp() {
  const requestedSection = new URLSearchParams(window.location.search).get('section');
  const [tab, label] = sections.find(([id]) => requestedSection === id) || sections[0];
  const [access, setAccess] = useState({});
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const { account, error } = access;
  const csrfToken = account?.csrf;
  const api = useCallback((path, options) => shopApi(path, options, csrfToken), [csrfToken]);

  function checkAccess() {
    setAccess({});
    setBusy(false);
    setAttempt(current => current + 1);
  }

  useEffect(() => {
    const request = new AbortController();
    shopApi('/me', { signal: request.signal }).then(account => {
      if (!request.signal.aborted) setAccess({ account });
    }).catch(failure => {
      if (!request.signal.aborted) setAccess({ error: failure.message });
    });
    return () => request.abort();
  }, [attempt]);

  useEffect(() => {
    const restore = event => { if (event.persisted) checkAccess(); };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  return <>
    <header className="admin-page-header">
      <div className="admin-page-wrap admin-page-heading">
        <a className="admin-brand" href="/rolling.html" aria-label="SWP shop 홈">
          <img src="/swp-assets/swp-shop-banner.png" alt="SWP shop" width="2172" height="724" />
        </a>
        <a className="admin-control" href="/rolling.html">상점으로 돌아가기</a>
      </div>
    </header>
    <main className="admin-page-wrap admin-page">
      <h1>상점 관리</h1>
      {error ? (
        <section className="admin-access">
          <p role="alert">계정 정보를 불러오지 못했습니다. {error}</p>
          <button className="admin-control" type="button" onClick={checkAccess}>다시 시도</button>
        </section>
      ) : !account ? (
        <p className="admin-access" role="status">계정 확인 중…</p>
      ) : account.user?.role === 'ADMIN' ? (
        <>
          <nav className="admin-tabs" aria-label="상점 관리 메뉴">
            {sections.map(([id, title]) => (
              <a key={id} href={id === 'products' ? '/admin.html' : `/admin.html?section=${id}`}
                aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined}
                onClick={event => { if (busy) event.preventDefault(); }}
                aria-current={tab === id ? 'page' : undefined}>{title}</a>
            ))}
          </nav>
          <AdminPanel api={api} tab={tab} label={label} busy={busy} setBusy={setBusy} />
        </>
      ) : account.user ? (
        <p className="admin-access">관리자 권한이 필요합니다.</p>
      ) : (
        <section className="admin-access">
          <p>상점 관리는 관리자 로그인이 필요합니다.</p>
          {account.kakao_configured
            ? <a className="admin-control admin-login" href="/shop-api/auth/kakao">카카오 로그인</a>
            : <p>카카오 앱 설정이 필요합니다.</p>}
        </section>
      )}
    </main>
  </>;
}

createRoot(document.querySelector('#admin-app')).render(<AdminApp />);
