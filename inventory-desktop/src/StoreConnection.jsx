import React, { useEffect, useRef, useState } from 'react';

function displayTime(value) {
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric == null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? '시각 확인 필요' : date.toLocaleString('ko-KR');
}

export default function StoreConnection({ connection, ready, busy, onAction }) {
  const [serverUrl, setServerUrl] = useState(connection?.serverUrl || '');
  const [deviceName, setDeviceName] = useState(connection?.deviceName || '매장 PC');
  const [pairCode, setPairCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const lock = useRef(false);
  const storeMode = connection?.mode === 'store';
  const connectionError = connection?.error || '';
  useEffect(() => {
    setServerUrl(connection?.serverUrl || '');
    if (connection?.deviceName) setDeviceName(connection.deviceName);
  }, [connection?.serverUrl, connection?.deviceName]);

  async function run(method, args) {
    if (lock.current || busy) return;
    lock.current = true; setError(''); setNotice('');
    try {
      await onAction(method, args);
      setPairCode(''); setConfirmDisconnect(false);
      setNotice(method === 'disconnectStore' ? '이 PC의 연결을 해제했습니다. 서버에서 해제가 처리되지 않은 경우 관리자 화면에서 기기 권한을 해제해 주세요.' : method === 'useLocalTest' ? '로컬 테스트 DB로 전환했습니다. 매장 상품은 복사되지 않습니다.' : '매장 모드로 전환했습니다. 표시된 서버 주소와 재고를 확인하세요.');
    } catch (failure) { setError(failure.message); }
    finally { lock.current = false; }
  }

  function connect(event) {
    event.preventDefault();
    let url;
    try { url = new URL(serverUrl.trim()); }
    catch { setError('올바른 SWP 백엔드 서버 주소를 입력해 주세요.'); return; }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
      setError('HTTPS 서버 주소를 입력하세요. HTTP는 이 PC의 localhost 주소만 사용할 수 있습니다.'); return;
    }
    if (!pairCode.trim() || !deviceName.trim()) { setError('기기 이름과 일회성 연결 코드를 입력하세요.'); return; }
    run('connectStore', { serverUrl: serverUrl.trim(), pairCode: pairCode.trim(), deviceName: deviceName.trim() });
  }

  return <div className="connection-layout">
    {connectionError && <div className="notice error connection-error" role="alert"><span>{connectionError} 매장 연결을 다시 설정하거나 로컬 테스트 전환을 직접 선택해 주세요. 기존 테스트 DB의 재고는 매장 재고로 표시하지 않습니다.</span></div>}
    <section className="panel connection-panel"><div className="panel-heading"><h2>사용 모드</h2><span className={storeMode ? 'live-badge' : 'test-badge'}>{storeMode ? '매장 모드' : '로컬 테스트'}</span></div><div className="connection-body"><dl className="connection-details"><div><dt>현재 저장소</dt><dd>{storeMode ? 'SWP 서버의 실제 상품·재고 원장' : '이 PC의 분리된 테스트 DB'}</dd></div><div><dt>서버 주소</dt><dd>{connection?.serverUrl || '연결된 서버 없음'}</dd></div><div><dt>기기 이름</dt><dd>{connection?.deviceName || '미등록'}</dd></div><div><dt>연결 상태</dt><dd>{!ready ? '확인 필요' : connection?.connected ? '인증된 매장 연결' : storeMode ? '연결 확인 필요' : '매장 미연결'}</dd></div>{connection?.expiresAt && <div><dt>기기 권한 만료</dt><dd>{displayTime(connection.expiresAt)}</dd></div>}</dl><p className="mode-note">모드를 바꿔도 테스트 DB의 상품과 이력을 매장 서버로 복사하지 않습니다. 매장 모드에서 저장하면 서버의 실제 재고가 변경됩니다.</p><div className="connection-actions"><button className="button secondary" disabled={busy || !ready || !storeMode} onClick={() => run('useLocalTest')}>로컬 테스트로 전환</button><button className="button primary" disabled={busy || !ready || storeMode || !connection?.serverUrl} onClick={() => run('useStore')}>저장된 매장 연결 사용</button></div>{connection?.serverUrl && <div className="disconnect-area">{confirmDisconnect ? <><p>이 PC의 저장된 매장 연결을 해제할까요?</p><div className="connection-actions"><button className="button danger" disabled={busy} onClick={() => run('disconnectStore')}>기기 연결 해제</button><button className="button secondary" disabled={busy} onClick={() => setConfirmDisconnect(false)}>취소</button></div></> : <button className="text-button danger-text" disabled={busy} onClick={() => setConfirmDisconnect(true)}>이 PC의 매장 연결 해제</button>}</div>}</div></section>
    <section className="panel connection-panel"><div className="panel-heading"><h2>매장 서버 연결</h2></div><div className="connection-body"><ol className="connection-guide"><li>SWP 상점 관리의 <b>재고관리 앱</b>에서 기기 이름을 입력하고 연결 코드를 발급합니다.</li><li>실행 중인 SWP 백엔드 주소와 일회성 코드를 아래에 입력합니다.</li><li>연결 후 매장 모드 표시와 서버 주소를 확인합니다.</li></ol><p className="mode-note">서버가 아직 배포되지 않았다면 먼저 SWP 백엔드 실행 주소가 필요합니다. 스마트스토어 개설이나 API 키 발급과는 별개의 연결입니다.</p><form onSubmit={connect}><fieldset disabled={busy}><legend className="sr-only">매장 서버 연결 정보</legend><label className="field"><span>SWP 백엔드 서버 주소 <b>*</b></span><input type="url" required maxLength={500} placeholder="https://상점주소/shop-api" autoComplete="off" value={serverUrl} onChange={event => setServerUrl(event.target.value)} /><small>관리자 화면에 안내되는 주소를 입력하세요.</small></label><label className="field"><span>기기 이름 <b>*</b></span><input required maxLength={80} value={deviceName} onChange={event => setDeviceName(event.target.value)} autoComplete="off" /></label><label className="field"><span>일회성 연결 코드 <b>*</b></span><input type="password" required maxLength={200} autoComplete="off" spellCheck={false} value={pairCode} onChange={event => setPairCode(event.target.value)} /><small>연결 코드는 한 번만 사용하며 성공 후 입력란에서 지웁니다.</small></label><button className="button primary full-width" disabled={busy || !serverUrl.trim() || !deviceName.trim() || !pairCode.trim()}>{busy ? '연결 처리 중…' : '매장 서버 연결'}</button></fieldset></form>{error && <div className="form-error connection-feedback" role="alert">{error}</div>}{notice && <div className="notice success connection-feedback" role="status">{notice}</div>}</div></section>
  </div>;
}
