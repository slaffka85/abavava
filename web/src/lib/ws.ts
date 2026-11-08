/**
 * WebSocket-клиент (docs/WS-PROTOCOL.md).
 *
 *  - подключение на ws(s)://<host>/api/v1/ws?token=<access>;
 *  - авто-reconnect с экспоненциальной задержкой 0.5s → 15s и jitter;
 *    перед переподключением обновляем access-токен, если он протух
 *    (а если handshake не удался ни разу — обновляем принудительно, т.к. это
 *    единственный способ узнать, что токен отозван);
 *  - heartbeat: ping каждые 25 с, ответ pong ожидаем 10 с, иначе — принудительный reconnect;
 *  - типизированные подписки и send() с генерацией id/ts;
 *  - для message.send ожидаем ack/error по ref с таймаутом 10 с;
 *  - после успешного реконнекта эмитим resync.
 */
import { ApiError, ensureFreshAccessToken, getAccessToken, refreshAccessToken, reportSessionInvalid } from './api';
import type {
  ClientEventDataMap,
  ClientEventType,
  WsAck,
  WsDataOf,
  WsErrorData,
  WsEvent,
  WsEventType,
} from './types';

export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

const HEARTBEAT_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 10_000;
const BASE_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 15_000;
const JITTER_RATIO = 0.3;
/** Если сокет не открылся за это время — считаем попытку провалившейся. */
const CONNECT_TIMEOUT_MS = 12_000;

/** Ошибка транспорта/протокола (не путать с ApiError для REST). */
export class WsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WsError';
    this.code = code;
  }
}

function makeId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** ws:// или wss:// в зависимости от текущей схемы; при абсолютном VITE_API_BASE — его хост. */
function buildWsUrl(token: string): string {
  const envBase = (import.meta.env.VITE_API_BASE ?? '').trim();
  const base = new URL(envBase || window.location.href, window.location.href);
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${base.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
}

interface PendingAck {
  keys: string[];
  resolve: (data: WsAck['data'] | undefined) => void;
  reject: (error: WsError) => void;
  timer: number;
}

export type WsListener<T extends WsEventType> = (
  data: WsDataOf<T>,
  envelope: Extract<WsEvent, { type: T }>,
) => void;

export interface RequestAckOptions {
  timeoutMs?: number;
  /**
   * Дополнительные ключи, под которыми сервер может прислать `ref`.
   * Для message.send backend кладёт в `ref` значение `client_id`, поэтому
   * регистрируем ожидание и по id конверта, и по client_id.
   */
  altRefs?: string[];
}

export class WsClient {
  private socket: WebSocket | null = null;
  private status: WsStatus = 'closed';
  private manualClose = false;
  private everConnected = false;
  private attempt = 0;
  private forceRefreshOnNextConnect = false;

  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private pongTimer: number | null = null;
  private connectTimer: number | null = null;

  private pending = new Map<string, PendingAck>();

  private listeners = new Map<string, Set<(data: unknown, envelope: unknown) => void>>();
  private statusListeners = new Set<(status: WsStatus) => void>();
  private resyncListeners = new Set<() => void>();
  private transportErrorListeners = new Set<(error: WsError) => void>();

  /* ---------------- публичное API ---------------- */

  getStatus(): WsStatus {
    return this.status;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manualClose = false;
    this.clearReconnectTimer();
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');

    let token: string | null = null;
    try {
      // Перед подключением убеждаемся, что access жив: иначе handshake отвалится по 401.
      token = this.forceRefreshOnNextConnect
        ? await refreshAccessToken()
        : await ensureFreshAccessToken();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        // Refresh-токен отозван или просрочен: переподключаться бессмысленно,
        // иначе получим бесконечный цикл 401 → reconnect.
        this.setStatus('closed');
        reportSessionInvalid();
        return;
      }
      // Сетевая ошибка — попробуем с текущим токеном, дальше сработает backoff.
      token = getAccessToken();
    }
    this.forceRefreshOnNextConnect = false;

    if (!token) {
      // Нет сессии — переподключаться бессмысленно.
      this.setStatus('closed');
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildWsUrl(token));
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    this.armConnectTimeout(socket);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.clearConnectTimeout();
      const isReconnect = this.everConnected;
      this.everConnected = true;
      this.attempt = 0;
      this.setStatus('open');
      this.startHeartbeat();
      // Пропущенные во время разрыва события не «догоняются» — стор сам перезагрузит
      // диалоги, открытый тред и активный звонок по этому сигналу.
      if (isReconnect) this.emitResync();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.handleFrame(String(event.data));
    };

    socket.onerror = () => {
      // Детали ошибки браузер не отдаёт; реакция будет в onclose.
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearConnectTimeout();
      this.stopHeartbeat();
      this.rejectPending(new WsError('connection_closed', 'Соединение закрыто'));
      if (this.manualClose) {
        this.setStatus('closed');
        return;
      }
      // Если соединение ни разу не открылось — вероятная причина 401 на handshake:
      // следующий connect() принудительно обновит access-токен.
      if (!this.everConnected) this.forceRefreshOnNextConnect = true;
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    };
  }

  /** Осознанное закрытие (logout): без переподключений. */
  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.clearConnectTimeout();
    this.stopHeartbeat();
    this.rejectPending(new WsError('closed', 'Соединение закрыто'));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, 'client shutdown');
      } catch {
        // сокет уже мог быть закрыт
      }
    }
    this.attempt = 0;
    this.everConnected = false;
    this.setStatus('closed');
  }

  /** Подписка на серверное событие. Возвращает функцию отписки. */
  on<T extends WsEventType>(type: T, listener: WsListener<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const wrapped = listener as unknown as (data: unknown, envelope: unknown) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  onStatus(listener: (status: WsStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  onTransportError(listener: (error: WsError) => void): () => void {
    this.transportErrorListeners.add(listener);
    return () => this.transportErrorListeners.delete(listener);
  }

  /** Отправка события с генерацией `id` и `ts`. Возвращает id конверта. */
  send<T extends ClientEventType>(type: T, data: ClientEventDataMap[T]): string {
    return this.sendEnvelope(type, data);
  }

  /**
   * Отправка с ожиданием `ack`/`error` (реальный сценарий — message.send).
   * Резолвится данными ack (например `{ message }`), реджектится WsError при
   * `error`, таймауте, разрыве соединения.
   */
  request<T extends ClientEventType>(
    type: T,
    data: ClientEventDataMap[T],
    options: RequestAckOptions = {},
  ): Promise<WsAck['data'] | undefined> {
    const timeoutMs = options.timeoutMs ?? ACK_TIMEOUT_MS;
    const id = this.sendEnvelope(type, data);
    const keys = [id, ...(options.altRefs ?? [])];

    return new Promise<WsAck['data'] | undefined>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        for (const key of keys) this.pending.delete(key);
        reject(new WsError('timeout', 'Сервер не подтвердил событие'));
      }, timeoutMs);

      const entry: PendingAck = { keys, resolve, reject, timer };
      for (const key of keys) this.pending.set(key, entry);
    });
  }

  /* ---------------- внутреннее ---------------- */

  private sendEnvelope<T extends ClientEventType>(type: T, data: ClientEventDataMap[T]): string {
    const id = makeId();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new WsError('not_connected', 'Нет соединения с сервером');
    }
    this.socket.send(
      JSON.stringify({
        v: 1,
        type,
        id,
        ts: new Date().toISOString(),
        data,
      }),
    );
    return id;
  }

  private handleFrame(raw: string): void {
    let envelope: WsEvent;
    try {
      envelope = JSON.parse(raw) as WsEvent;
    } catch {
      return;
    }
    if (!envelope || typeof envelope.type !== 'string') return;

    if (envelope.type === 'pong') this.clearPongTimer();
    if (envelope.type === 'ack') this.settle(envelope.data.ref, undefined, envelope.data);
    if (envelope.type === 'error') this.settle(envelope.data.ref, envelope.data);

    const set = this.listeners.get(envelope.type);
    if (set) {
      for (const listener of [...set]) listener(envelope.data, envelope);
    }
  }

  private settle(ref: string | undefined, error?: WsErrorData, ack?: WsAck): void {
    if (!ref) return;
    const entry = this.pending.get(ref);
    if (!entry) return;
    for (const key of entry.keys) this.pending.delete(key);
    window.clearTimeout(entry.timer);
    if (error) entry.reject(new WsError(error.code, error.message));
    else entry.resolve(ack?.data);
  }

  private rejectPending(error: WsError): void {
    const entries = new Set(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      window.clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private setStatus(status: WsStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private emitResync(): void {
    for (const listener of [...this.resyncListeners]) {
      try {
        listener();
      } catch {
        // подписчик не должен ломать клиент
      }
    }
  }

  private emitTransportError(error: WsError): void {
    for (const listener of [...this.transportErrorListeners]) listener(error);
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer !== null) return;
    const exponential = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** this.attempt);
    // jitter, чтобы несколько вкладок не переподключались синхронно
    const jitter = exponential * JITTER_RATIO * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.round(exponential + jitter));
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private armConnectTimeout(socket: WebSocket): void {
    this.clearConnectTimeout();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket || socket.readyState === WebSocket.OPEN) return;
      this.forceReconnect(socket, 'connect timeout');
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      try {
        this.sendEnvelope('ping', {});
      } catch {
        return;
      }
      // Ждём pong; если не пришёл — соединение мертво (сервер тоже рвёт по 60 с тишины).
      this.clearPongTimer();
      this.pongTimer = window.setTimeout(() => {
        this.pongTimer = null;
        this.emitTransportError(new WsError('heartbeat_timeout', 'Сервер не отвечает, переподключаемся'));
        if (this.socket) this.forceReconnect(this.socket, 'heartbeat timeout');
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      window.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** Полный разрыв с последующим переподключением (heartbeat/timeout). */
  private forceReconnect(socket: WebSocket, reason: string): void {
    this.socket = null;
    this.clearConnectTimeout();
    this.stopHeartbeat();
    this.rejectPending(new WsError('reconnect', `Разрыв соединения: ${reason}`));
    try {
      socket.close(4000, reason);
    } catch {
      // игнорируем: сокет мог быть уже закрыт
    }
    if (this.manualClose) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  }
}

/** Единственный экземпляр на приложение. */
export const wsClient = new WsClient();
