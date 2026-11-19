import React, { useEffect, useRef, useState } from 'react';

const actions = {
  PUBLISH: {
    label: '즉시 공개',
    effect: '선택한 상품을 상점에 즉시 표시합니다. 기존 공개 예약은 해제됩니다.',
  },
  HIDE: {
    label: '즉시 비공개',
    effect: '선택한 상품을 상점에서 즉시 숨깁니다. 기존 공개 예약은 해제됩니다.',
  },
  SCHEDULE: {
    label: '예약 공개',
    effect: '선택한 상품은 지정한 시각까지 상점에서 숨겨집니다. 기존 예약은 새 시각으로 변경되며, 해당 시각부터 상점에 표시됩니다.',
  },
};

export function PublishTime({ value }) {
  return <time dateTime={`${value}+09:00`}>{value.replace('T', ' ')} (한국 시간)</time>;
}

export default function VisibilityControls({ ids, busy, editing, clear, save }) {
  const [mode, setMode] = useState('');
  const [publishAt, setPublishAt] = useState('');
  const [dateError, setDateError] = useState('');
  const confirmation = useRef(null);
  const trigger = useRef(null);
  const unavailable = busy || editing || !ids.length;

  useEffect(() => {
    if (mode) confirmation.current?.focus();
  }, [mode]);

  function open(nextMode, button) {
    trigger.current = button;
    setDateError('');
    setMode(nextMode);
  }

  function cancel() {
    setMode('');
    setPublishAt('');
    setDateError('');
    trigger.current?.focus();
  }

  function submit(event) {
    event.preventDefault();
    if (unavailable || !mode) return;
    if (mode === 'SCHEDULE' && !(Date.parse(`${publishAt}:00+09:00`) > Date.now())) {
      setDateError('한국 시간 기준 현재보다 늦은 시각을 입력해 주세요.');
      return;
    }
    const body = { ids, mode };
    if (mode === 'SCHEDULE') body.publishAt = publishAt;
    save(body, clear);
  }

  return <section className="admin-visibility" aria-label="상품 공개 설정">
    <div className="admin-visibility-toolbar">
      <p role="status"><strong>{ids.length.toLocaleString('ko-KR')}개</strong> 선택</p>
      <div className="admin-visibility-actions">
        {Object.entries(actions).map(([key, action]) => (
          <button key={key} className="admin-control" type="button" disabled={unavailable}
            onClick={event => open(key, event.currentTarget)}>{action.label}</button>
        ))}
        {ids.length > 0 && <button className="admin-control" type="button" onClick={clear} disabled={busy}>선택 해제</button>}
      </div>
    </div>
    {editing && ids.length > 0 && <p className="admin-visibility-hint">상품 편집을 마친 뒤 공개 상태를 변경할 수 있습니다.</p>}
    {mode && <form className="visibility-confirm" ref={confirmation} tabIndex={-1} onSubmit={submit} aria-labelledby="visibility-title">
      <h3 id="visibility-title">상품 {ids.length.toLocaleString('ko-KR')}개 {actions[mode].label}</h3>
      <p>{actions[mode].effect}</p>
      {mode === 'SCHEDULE' && (
        <label>공개 시각 (한국 시간)
          <input type="datetime-local" name="publishAt" step="60" value={publishAt} required disabled={unavailable}
            aria-invalid={Boolean(dateError)} aria-describedby={dateError ? 'visibility-date-error' : undefined}
            onChange={event => { setPublishAt(event.target.value); setDateError(''); }} />
        </label>
      )}
      {dateError && <p className="admin-message" role="alert" id="visibility-date-error">{dateError}</p>}
      <div className="form-actions">
        <button type="submit" disabled={unavailable}>{mode === 'SCHEDULE' ? '예약 저장' : `${actions[mode].label} 실행`}</button>
        <button type="button" onClick={cancel} disabled={busy}>취소</button>
      </div>
    </form>}
  </section>;
}
