import { useEffect, useState } from 'react';
import { subscribeWsStatus } from '../app/realtime';
import type { WsStatus } from '../lib/ws';
import { IconWifiOff } from './Icons';

export function useWsStatus(): WsStatus {
  const [status, setStatus] = useState<WsStatus>('closed');
  useEffect(() => subscribeWsStatus(setStatus), []);
  return status;
}

/** Баннер «нет соединения, переподключаемся». */
export function ConnectionBanner() {
  const status = useWsStatus();
  if (status === 'open') return null;

  const text =
    status === 'connecting'
      ? 'Подключаемся к серверу…'
      : status === 'reconnecting'
        ? 'Нет соединения, переподключаемся…'
        : 'Соединение потеряно';

  return (
    <div className="conn-banner" role="status">
      <IconWifiOff size={16} />
      <span>{text}</span>
    </div>
  );
}

/** Компактный индикатор состояния WS для шапки. */
export function WsIndicator() {
  const status = useWsStatus();
  const label =
    status === 'open'
      ? 'На связи'
      : status === 'connecting'
        ? 'Подключение…'
        : status === 'reconnecting'
          ? 'Переподключение…'
          : 'Нет соединения';

  return (
    <span className={`ws-indicator ws-indicator--${status}`} title={label} aria-label={label}>
      <span className="ws-indicator__dot" />
      <span className="ws-indicator__label">{label}</span>
    </span>
  );
}
