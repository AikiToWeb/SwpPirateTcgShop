import React, { useEffect, useRef, useState } from 'react';

function dateValue(value) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
  return new Date(numeric == null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
}
function displayTime(value) {
  if (!value) return '—';
  const date = dateValue(value);
  return Number.isNaN(date.getTime()) ? '만료 시각 확인 필요' : date.toLocaleString('ko-KR');
}

export default function InventoryDevices({ api, refreshKey = 0 }) {
  const [deviceName, setDeviceName] = useState('매장 PC');
  const [devices, setDevices] = useState([]);
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const lock = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const serverUrl = `${window.location.origin}/shop-api`;
  const expiresAt = pairing?.expiresAt ? dateValue(pairing.expiresAt).getTime() : 0;
  const expired = pairing && (!Number.isFinite(expiresAt) || now >= expiresAt);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!expired) return;
    setPairing(null); setMessage('연결 코드가 만료되었습니다. 새로 발급해 주세요.');
  }, [expired]);

  async function load() {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const data = await api('/admin/inventory/devices');
      if (mounted.current && request === sequence.current) setDevices(data.items || []);
    } catch (failure) { if (mounted.current && request === sequence.current) setError(failure.message); }
    finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }
  useEffect(() => { setError(''); load(); }, [refreshKey]);

  async function run(action) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (failure) { if (mounted.current) setError(failure.message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function createPairing(event) {
    event.preventDefault();
    if (!deviceName.trim()) return;
    run(async () => {
      setPairing(null);
      const data = await api('/admin/inventory/pairings', { method: 'POST', body: { deviceName: deviceName.trim() } });
      if (mounted.current) { setNow(Date.now()); setPairing({ pairCode: data.pairCode, expiresAt: data.expiresAt }); setMessage('일회성 연결 코드를 발급했습니다. 재고관리 프로그램에 입력하세요.'); }
    });
  }
  async function copyCode() {
    if (!pairing || expired) return;
    try { await navigator.clipboard.writeText(pairing.pairCode); if (mounted.current) setMessage('연결 코드를 복사했습니다.'); }
    catch { if (mounted.current) setMessage('복사할 수 없습니다. 표시된 코드를 직접 선택해서 복사하세요.'); }
  }
  function revoke(device) {
    run(async () => {
      await api(`/admin/inventory/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      if (!mounted.current) return;
      setConfirmId(null); setMessage(`${device.name} 기기의 권한을 해제했습니다.`); await load();
    });
  }

  return <section className="inventory-devices" aria-label="재고관리 앱 기기 연결"><h3>재고관리 프로그램 연결</h3><p>설치형 프로그램을 이 상점의 실제 상품·재고 원장에 연결합니다. 연결된 기기는 재고를 조회하고 변경할 수 있습니다.</p><div className="inventory-server-address"><span>SWP 백엔드 주소</span><code>{serverUrl}</code></div><p className="inventory-device-hint">개발용 화면을 사용 중이면 프로그램을 실행하는 PC에서 접근 가능한 백엔드 주소를 확인하세요. 외부 접속은 HTTPS 서버가 필요합니다.</p><form className="inventory-pairing-form" onSubmit={createPairing}><label>기기 이름<input required maxLength={80} value={deviceName} onChange={event => setDeviceName(event.target.value)} disabled={busy} autoComplete="off" /></label><button type="submit" className="solid" disabled={busy || !deviceName.trim()}>{busy ? '처리 중…' : pairing ? '새 연결 코드 발급' : '연결 코드 발급'}</button></form>{pairing && !expired && <div className="inventory-pair-code" role="status"><strong>일회성 연결 코드</strong><output aria-label="일회성 연결 코드">{pairing.pairCode}</output><p>{displayTime(pairing.expiresAt)}까지 사용 가능 · 이 화면을 닫으면 코드가 숨겨집니다.</p><div><button type="button" disabled={busy} onClick={copyCode}>코드 복사</button><button type="button" disabled={busy} onClick={() => setPairing(null)}>코드 숨기기</button></div></div>}{error && <p className="admin-message" role="alert">{error}</p>}{message && <p role="status" className="inventory-device-message">{message}</p>}<div className="inventory-device-heading"><h3>등록된 기기</h3><button type="button" disabled={busy || loading} onClick={() => { setError(''); load(); }}>기기 새로고침</button></div>{loading ? <p role="status">기기 목록을 불러오는 중…</p> : <div className="admin-table-scroll"><table><thead><tr><th>기기 이름</th><th>등록 일시</th><th>권한 만료</th><th>상태</th><th>관리</th></tr></thead><tbody>{devices.map(device => { const inactive = Boolean(device.revoked) || (device.expiresAt && dateValue(device.expiresAt).getTime() <= now); return <tr key={device.id}><td>{device.name}</td><td>{displayTime(device.createdAt)}</td><td>{displayTime(device.expiresAt)}</td><td>{device.revoked ? '권한 해제됨' : inactive ? '만료됨' : '등록됨'}</td><td>{!inactive && (confirmId === device.id ? <div className="inventory-revoke-confirm"><span>이 기기의 재고 접근을 해제할까요?</span><button disabled={busy} onClick={() => revoke(device)}>권한 해제</button><button disabled={busy} onClick={() => setConfirmId(null)}>취소</button></div> : <button disabled={busy} onClick={() => setConfirmId(device.id)}>연결 해제</button>)}</td></tr>; })}</tbody></table>{!devices.length && <p>등록된 재고관리 기기가 없습니다.</p>}</div>}<p className="inventory-device-hint">API 키와 기기 인증 토큰은 이 화면에 표시하지 않습니다. 사용하지 않는 기기는 권한을 해제해 주세요.</p></section>;
}
