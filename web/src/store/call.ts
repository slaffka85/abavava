/**
 * Состояние звонка: idle | outgoing | incoming | active | ended.
 *
 * Обрабатывает WS-события call.created / call.incoming / call.updated / call.signal
 * и управляет жизненным циклом CallSession (медиа, сигналинг, таймеры).
 */
import { create } from 'zustand';
import { api, humanizeApiError } from '../lib/api';
import { TERMINAL_CALL_STATUSES } from '../lib/types';
import type { Call, CallKind, SignalPayload, User, UUID } from '../lib/types';
import { createAudioMeter, speakingFromStatsLevel } from '../lib/audio-meter';
import type { AudioMeterHandle } from '../lib/audio-meter';
import { listMicrophones, onDeviceChange, rememberedMicId, rememberMicId } from '../lib/media-devices';
import type { MicDevice } from '../lib/media-devices';
import { CallSession } from '../lib/webrtc';
import type { CallQuality, CallStatsSummary } from '../lib/webrtc';
import { ringtone } from '../lib/ringtone';
import { wsClient } from '../lib/ws';
import { useAuthStore } from './auth';
import { toast } from './toast';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'active' | 'ended';

/** Локальный страховочный таймаут дольше серверного ABV_CALL_RING_TIMEOUT (45 с). */
const RING_WATCHDOG_MS = 50_000;
/** Сколько держим оверлей «звонок завершён» перед закрытием. */
const ENDED_OVERLAY_MS = 3_500;
/** Сколько ждём восстановления медиа после реконнекта, прежде чем ругаться. */
const QUALITY_POLL_NOTE = 8_000;

let session: CallSession | null = null;
/** Сигналы, пришедшие до готовности CallSession (для вызываемого — до accept). */
let bufferedSignals: Array<{ callId: UUID; payload: SignalPayload }> = [];
/**
 * Идёт accept: сессия уже создана, но getUserMedia ещё не завершился.
 * Сигналы в этот момент буферизуем, иначе offer применится к соединению без
 * локальных треков и вторая сторона не получит наш звук/видео.
 */
let sessionPendingMedia = false;
let durationTimer: number | null = null;
let watchdogTimer: number | null = null;
let dismissTimer: number | null = null;
let qualityNoteTimer: number | null = null;

/**
 * Измерители уровня звука (voice activity). Держим их вне стора: это ресурсы
 * Web Audio, а не состояние интерфейса. В стор публикуем только итоговые
 * уровень и флаг речи.
 */
let localMeter: AudioMeterHandle | null = null;
let remoteMeter: AudioMeterHandle | null = null;
let localMeterTrackId: string | null = null;
let remoteMeterTrackId: string | null = null;
/** Подписка на подключение/отключение устройств ввода. */
let deviceChangeUnsubscribe: (() => void) | null = null;

/** Следит за появлением новых микрофонов (например, подключили гарнитуру). */
function armDeviceChangeListener(): void {
  if (deviceChangeUnsubscribe) return;
  deviceChangeUnsubscribe = onDeviceChange(() => {
    if (useCallStore.getState().phase === 'idle') return;
    void useCallStore.getState().refreshMicDevices();
  });
}

interface CallState {
  phase: CallPhase;
  call: Call | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraEnabled: boolean;
  durationSeconds: number;
  connectionState: RTCPeerConnectionState | null;
  quality: CallQuality;
  /** Последний замер WebRTC: качество и диагностика звука (см. CallStatsSummary). */
  stats: CallStatsSummary | null;
  /** Браузер заблокировал воспроизведение звука (мобильная политика автоплея). */
  audioBlocked: boolean;
  /** Уровень звука своего микрофона, 0..1 (для индикатора активности голоса). */
  localAudioLevel: number;
  /** Уровень звука собеседника, 0..1. */
  remoteAudioLevel: number;
  localSpeaking: boolean;
  remoteSpeaking: boolean;
  /** Микрофоны, доступные в системе (список появляется после выдачи доступа). */
  micDevices: MicDevice[];
  /** Выбранный микрофон; null — системный по умолчанию. */
  micId: string | null;
  micBusy: boolean;
  /** Повторная попытка запустить воспроизведение — вызывается кнопкой в оверлее. */
  retryAudioPlayback: (() => void) | null;
  error: string | null;
  /** Подсказка после завершения: «нет ответа», «звонок отклонён» и т.п. */
  notice: string | null;

  startCall: (peer: User, kind: CallKind, conversationId?: UUID) => Promise<void>;
  acceptIncoming: () => Promise<void>;
  rejectIncoming: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  setAudioBlocked: (blocked: boolean) => void;
  setAudioRetry: (retry: (() => void) | null) => void;
  /** Обновить список микрофонов (нужно вызывать после получения доступа к медиа). */
  refreshMicDevices: () => Promise<void>;
  /** Переключить микрофон: пустая строка — системный по умолчанию. */
  switchMicrophone: (deviceId: string) => Promise<void>;
  handleCallCreated: (call: Call) => void;
  handleCallIncoming: (call: Call) => void;
  handleCallUpdated: (call: Call) => void;
  handleCallSignal: (callId: UUID, payload: SignalPayload) => void;
  /** После реконнекта WS: подхватить ringing/accepted звонок и пересобрать соединение. */
  resyncActiveCall: () => Promise<void>;
  /** Закрыть оверлей «завершено». */
  dismiss: () => void;
  reset: () => void;
}

function isTerminal(status: Call['status']): boolean {
  return TERMINAL_CALL_STATUSES.includes(status);
}

function currentUserId(): UUID | null {
  return useAuthStore.getState().user?.id ?? null;
}

function answeredAtMs(call: Call | null): number | null {
  if (!call) return null;
  const source = call.answered_at ?? (call.status === 'accepted' ? call.created_at : null);
  if (!source) return null;
  const parsed = new Date(source).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export const useCallStore = create<CallState>((set, get) => ({
  phase: 'idle',
  call: null,
  localStream: null,
  remoteStream: null,
  muted: false,
  cameraEnabled: false,
  durationSeconds: 0,
  connectionState: null,
  quality: 'unknown',
  stats: null,
  audioBlocked: false,
  localAudioLevel: 0,
  remoteAudioLevel: 0,
  localSpeaking: false,
  remoteSpeaking: false,
  micDevices: [],
  micId: rememberedMicId(),
  micBusy: false,
  retryAudioPlayback: null,
  error: null,
  notice: null,

  startCall: async (peer, kind, conversationId) => {
    const myUserId = currentUserId();
    if (!myUserId) return;
    if (get().phase === 'outgoing' || get().phase === 'active' || get().phase === 'incoming') {
      toast.info('Уже есть активный звонок');
      return;
    }

    set({ phase: 'outgoing', call: null, error: null, notice: null, durationSeconds: 0, muted: false });

    let call: Call;
    try {
      const response = await api.calls.create({
        callee_id: peer.id,
        kind,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      });
      call = response.call;
    } catch (error) {
      set({ phase: 'idle', call: null });
      toast.error('Не удалось позвонить', humanizeApiError(error));
      return;
    }

    set({ call });
    armWatchdog(() => {
      // Сервер сам переведёт звонок в missed; это лишь подстраховка при потере WS.
      finishLocally('Нет ответа');
    });

    try {
      await createSession({
        call,
        myUserId,
        onError: (message) => set({ error: message }),
      });
      await session?.startAsCaller();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось получить доступ к медиа';
      toast.error('Звонок не начат', message);
      void endCallOnServer(call.id, 'failed');
      finishLocally(message);
    }
  },

  acceptIncoming: async () => {
    const call = get().call;
    const myUserId = currentUserId();
    if (!call || !myUserId || get().phase !== 'incoming') return;

    ringtone.stop();
    clearWatchdog();

    sessionPendingMedia = true;
    try {
      // Медиа запрашиваем до accept: если пользователь запретил доступ — звонок не принимаем.
      await createSession({
        call,
        myUserId,
        onError: (message) => set({ error: message }),
      });
      await session?.prepareAsAnswerer();
    } catch (error) {
      sessionPendingMedia = false;
      const message = error instanceof Error ? error.message : 'Нет доступа к медиа';
      toast.error('Не удалось принять звонок', message);
      void endCallOnServer(call.id, 'failed');
      finishLocally(message);
      return;
    }
    sessionPendingMedia = false;

    set({ phase: 'active', error: null });
    startDurationTimer();
    sendCallEvent('call.accept', { call_id: call.id }, () => api.calls.accept(call.id));

    // Треки добавляются внутри обработки offer'а — здесь лишь прогоняем то,
    // что успело прийти, пока пользователь решал.
    await flushBufferedSignals();
  },

  rejectIncoming: () => {
    const call = get().call;
    ringtone.stop();
    if (call) {
      sendCallEvent('call.reject', { call_id: call.id, reason: 'rejected' }, () =>
        api.calls.reject(call.id, 'rejected'),
      );
    }
    finishLocally('Звонок отклонён');
  },

  hangup: () => {
    const call = get().call;
    if (call && get().phase !== 'ended') {
      sendCallEvent('call.end', { call_id: call.id, reason: 'hangup' }, () =>
        api.calls.end(call.id, 'hangup'),
      );
    }
    finishLocally(get().phase === 'outgoing' ? 'Звонок отменён' : 'Звонок завершён');
  },

  toggleMute: () => {
    const muted = !get().muted;
    if (muted) session?.mute();
    else session?.unmute();
    set({ muted });
  },

  toggleCamera: () => {
    if (!session) return;
    void session.toggleCamera();
  },

  setAudioBlocked: (blocked) => {
    set({ audioBlocked: blocked });
  },

  setAudioRetry: (retry) => {
    set({ retryAudioPlayback: retry });
  },

  refreshMicDevices: async () => {
    const devices = await listMicrophones();
    set({ micDevices: devices, micId: rememberedMicId() });
  },

  switchMicrophone: async (deviceId) => {
    if (get().micBusy) return;
    const target = deviceId ? deviceId : null;
    set({ micBusy: true, error: null });
    try {
      if (session) {
        await session.switchMicrophone(target);
        const stream = session.getLocalStream();
        if (stream) {
          set({ localStream: stream });
          // Дорожка сменилась — измеритель уровня нужно пересоздать.
          ensureLocalMeter(stream);
        }
      } else {
        rememberMicId(target);
      }
      set({ micId: rememberedMicId() });
      toast.info(target ? 'Микрофон переключён' : 'Используется микрофон по умолчанию');
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Не удалось переключить микрофон' });
    } finally {
      set({ micBusy: false });
    }
  },

  handleCallCreated: (call) => {
    // Идемпотентно: тот же звонок уже инициирован этим клиентом.
    if (get().call?.id === call.id) {
      set({ call });
      return;
    }
    if (call.caller_id !== currentUserId()) return;
    set({ call, phase: get().phase === 'idle' ? 'outgoing' : get().phase });
  },

  handleCallIncoming: (call) => {
    const myUserId = currentUserId();
    if (!myUserId || call.callee_id !== myUserId) return;

    const phase = get().phase;
    if (phase === 'outgoing' || phase === 'active' || phase === 'incoming') {
      if (get().call?.id === call.id) return;
      // Уже заняты — сразу отклоняем второй звонок.
      sendCallEvent('call.reject', { call_id: call.id, reason: 'busy' }, () =>
        api.calls.reject(call.id, 'busy'),
      );
      return;
    }

    set({ phase: 'incoming', call, error: null, notice: null, durationSeconds: 0 });
    ringtone.start();
    armWatchdog(() => {
      // Если сервер так и не прислал missed — закрываем модалку сами.
      finishLocally('Пропущенный звонок');
    });
  },

  handleCallUpdated: (call) => {
    const myUserId = currentUserId();
    const current = get().call;

    // Отслеживаем один звонок: обновления чужого игнорируем.
    if (current && current.id !== call.id) return;

    set({ call });

    if (call.status === 'accepted') {
      ringtone.stop();
      clearWatchdog();
      set({ phase: 'active', error: null });
      startDurationTimer();
      // Пересобираем сессию, если приняли звонок с другого устройства.
      if (!session || session.isClosed) {
        void (async () => {
          try {
            const userId = myUserId ?? '';
            await createSession({ call, myUserId: userId, onError: (m) => set({ error: m }) });
            await session?.startAsCaller();
          } catch {
            // уже показали ошибку в createSession
          }
        })();
      } else if (call.caller_id === myUserId) {
        // Когда вызываемый был офлайн (push/cold start), первый offer и ICE
        // могли потеряться. После принятия ждём обычный ответ, а если его нет,
        // откатываем неотвеченный offer и запускаем согласование повторно.
        const acceptedCallId = call.id;
        window.setTimeout(() => {
          const current = useCallStore.getState();
          if (current.phase === 'active' && current.call?.id === acceptedCallId) {
            void session?.recoverUnansweredOffer();
          }
        }, 1_500);
      }
      return;
    }

    if (call.status === 'ringing') return;
    if (!isTerminal(call.status)) return;
    // Локально уже завершили (например, по watchdog) — не переигрываем сценарий.
    if (get().phase === 'ended') return;

    const iAmCaller = call.caller_id === myUserId;
    let notice: string;
    switch (call.status) {
      case 'missed':
        notice = iAmCaller ? 'Нет ответа' : 'Пропущенный звонок';
        break;
      case 'rejected':
        notice = iAmCaller ? 'Звонок отклонён' : 'Вы отклонили звонок';
        break;
      case 'canceled':
        notice = iAmCaller ? 'Вы отменили звонок' : 'Звонок отменён';
        break;
      case 'failed':
        notice = 'Звонок не удался';
        break;
      default:
        notice = 'Звонок завершён';
        break;
    }
    finishLocally(notice, call.duration_seconds);
  },

  handleCallSignal: (callId, payload) => {
    // Сигнал для другого звонка игнорируем (WS-события идемпотентны по call_id).
    if (get().call?.id !== callId) return;

    if (!session || session.isClosed || sessionPendingMedia) {
      // Вызываемый ещё не нажал «принять» (или ещё нет медиа) — копим сигналы.
      bufferedSignals.push({ callId, payload });
      return;
    }
    void session.handleSignal(payload);
  },

  resyncActiveCall: async () => {
    try {
      const { items } = await api.calls.list(1);
      const call = items[0];
      const myUserId = currentUserId();
      if (!call || !myUserId) {
        if (get().phase !== 'idle') get().reset();
        return;
      }

      if (isTerminal(call.status)) {
        if (get().phase !== 'idle') get().reset();
        return;
      }

      if (call.status === 'ringing') {
        if (call.callee_id === myUserId && get().phase !== 'incoming') {
          get().handleCallIncoming(call);
        } else if (call.caller_id === myUserId && get().phase === 'idle') {
          set({ phase: 'outgoing', call });
          armWatchdog(() => finishLocally('Нет ответа'));
        }
        return;
      }

      if (call.status === 'accepted') {
        set({ phase: 'active', call });
        startDurationTimer();
        if (session && !session.isClosed) {
          // Соединение могло развалиться, пока WS отсутствовал — ICE restart.
          session.renegotiate();
        } else {
          try {
            await createSession({ call, myUserId, onError: (m) => set({ error: m }) });
            await session?.startAsCaller();
          } catch {
            // ошибка уже показана тостом
          }
        }
        await flushBufferedSignals();
      }
    } catch {
      // Нет сети — оставляем как есть, следующий resync попробует снова.
    }
  },

  dismiss: () => {
    clearDismissTimer();
    get().reset();
  },

  reset: () => {
    clearAllTimers();
    ringtone.stop();
    bufferedSignals = [];
    sessionPendingMedia = false;
    session = null;
    set({
      phase: 'idle',
      call: null,
      localStream: null,
      remoteStream: null,
      muted: false,
      cameraEnabled: false,
      durationSeconds: 0,
      connectionState: null,
      quality: 'unknown',
      error: null,
      notice: null,
    });
  },
}));

/* ------------------------------------------------------------------ */
/* Вспомогательные функции (вне стора, чтобы не плодить ре-рендеры)     */
/* ------------------------------------------------------------------ */

interface CreateSessionParams {
  call: Call;
  myUserId: UUID;
  onError: (message: string) => void;
}

/** peerUserId: для звонящего это callee_id, для вызываемого — caller_id. */
function peerOf(call: Call, myUserId: UUID): UUID {
  return call.caller_id === myUserId ? call.callee_id : call.caller_id;
}

async function createSession({ call, myUserId, onError }: CreateSessionParams): Promise<CallSession> {
  const set = useCallStore.setState;
  const peerUserId = peerOf(call, myUserId);

  const created = await CallSession.create({
    callId: call.id,
    kind: call.kind,
    myUserId,
    peerUserId,
    // Каждый сигнал уходит отдельным событием call.signal.
    sendSignal: (payload) => {
      if (!wsClient.isOpen()) {
        // Без WS сигналинг невозможен; соединение пересоберём после реконнекта (resync).
        console.warn('[call] WS закрыт, signal не отправлен:', payload.type);
        return;
      }
      try {
        wsClient.send('call.signal', { call_id: call.id, payload });
      } catch (error) {
        console.warn('[call] не удалось отправить signal', error);
      }
    },
    onRemoteStream: (stream) => {
      set({ remoteStream: stream });
      ensureRemoteMeter(stream);
    },
    onLocalStream: (stream) => {
      set({ localStream: stream });
      ensureLocalMeter(stream);
      // Только после выдачи доступа браузер раскрывает названия устройств ввода.
      void useCallStore.getState().refreshMicDevices();
    },
    onConnectionState: (state) => {
      set({ connectionState: state });
      if (state === 'failed' || state === 'disconnected') {
        set({ error: 'Проблема с соединением' });
        armQualityNote();
      } else if (state === 'connected') {
        clearQualityNote();
        set({ error: null });
      }
    },
    onError: (message) => {
      set({ error: message });
      onError(message);
    },
    onCameraEnabledChange: (enabled) => set({ cameraEnabled: enabled }),
  });

  session = created;
  armDeviceChangeListener();
  created.startStatsPolling((stats) => {
    set({ quality: stats.quality, stats });
    // Резервный путь для индикатора речи: если Web Audio недоступен (например,
    // контекст не разрешён политикой автоплея), берём audioLevel из getStats.
    if (!remoteMeter) {
      publishVad('remote', stats.audioInLevel ?? 0, speakingFromStatsLevel(stats.audioInLevel));
    }
  });
  return created;
}

/** Обновляет состояние индикатора речи, сглаживая частоту перерисовок. */
function publishVad(side: 'local' | 'remote', level: number, speaking: boolean): void {
  const state = useCallStore.getState();
  const levelKey = side === 'local' ? 'localAudioLevel' : 'remoteAudioLevel';
  const flagKey = side === 'local' ? 'localSpeaking' : 'remoteSpeaking';

  const changed = Math.abs(state[levelKey] - level) > 0.03 || state[flagKey] !== speaking;
  if (!changed) return;

  useCallStore.setState(
    side === 'local'
      ? { localAudioLevel: level, localSpeaking: speaking }
      : { remoteAudioLevel: level, remoteSpeaking: speaking },
  );
}

/** Создаёт измеритель для своего микрофона (пересоздаёт при смене трека). */
function ensureLocalMeter(stream: MediaStream | null): void {
  const track = stream?.getAudioTracks()[0] ?? null;
  if (track?.id === localMeterTrackId) return;

  localMeter?.stop();
  localMeter = null;
  localMeterTrackId = null;

  if (!stream || !track) {
    publishVad('local', 0, false);
    return;
  }
  localMeterTrackId = track.id;
  localMeter = createAudioMeter(stream, (level, speaking) => publishVad('local', level, speaking));
}

/**
 * Создаёт измеритель для звука собеседника. MediaStreamAudioSourceNode
 * фиксирует дорожки в момент создания, поэтому при появлении аудиодорожки
 * (треки приходят по одному: сначала видео, затем звук) измеритель пересоздаём.
 */
function ensureRemoteMeter(stream: MediaStream | null): void {
  const track = stream?.getAudioTracks()[0] ?? null;
  if (track?.id === remoteMeterTrackId) return;

  remoteMeter?.stop();
  remoteMeter = null;
  remoteMeterTrackId = null;

  if (!stream || !track) {
    publishVad('remote', 0, false);
    return;
  }
  remoteMeterTrackId = track.id;
  remoteMeter = createAudioMeter(stream, (level, speaking) => publishVad('remote', level, speaking));
}

/** Останавливает измерители и обнуляет индикаторы. */
function disposeMeters(): void {
  localMeter?.stop();
  remoteMeter?.stop();
  localMeter = null;
  remoteMeter = null;
  localMeterTrackId = null;
  remoteMeterTrackId = null;
  publishVad('local', 0, false);
  publishVad('remote', 0, false);
}

function clearAllTimers(): void {
  clearDurationTimer();
  clearWatchdog();
  clearDismissTimer();
  clearQualityNote();
}

function clearDurationTimer(): void {
  if (durationTimer !== null) {
    window.clearInterval(durationTimer);
    durationTimer = null;
  }
}

function clearWatchdog(): void {
  if (watchdogTimer !== null) {
    window.clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function clearDismissTimer(): void {
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

function clearQualityNote(): void {
  if (qualityNoteTimer !== null) {
    window.clearTimeout(qualityNoteTimer);
    qualityNoteTimer = null;
  }
}

/** Если соединение не восстановилось за N секунд — говорим об этом явно. */
function armQualityNote(): void {
  if (qualityNoteTimer !== null) return;
  qualityNoteTimer = window.setTimeout(() => {
    qualityNoteTimer = null;
    useCallStore.setState({ error: 'Соединение нестабильно' });
  }, QUALITY_POLL_NOTE);
}

/** Таймер длительности — считается от answered_at. */
function startDurationTimer(): void {
  clearDurationTimer();
  const tick = (): void => {
    const { call, phase } = useCallStore.getState();
    if (phase !== 'active') return;
    const started = answeredAtMs(call);
    const seconds = started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    useCallStore.setState({ durationSeconds: seconds });
  };
  tick();
  durationTimer = window.setInterval(tick, 1_000);
}

function armWatchdog(onTimeout: () => void): void {
  clearWatchdog();
  watchdogTimer = window.setTimeout(() => {
    watchdogTimer = null;
    onTimeout();
  }, RING_WATCHDOG_MS);
}

async function flushBufferedSignals(): Promise<void> {
  if (bufferedSignals.length === 0 || !session || session.isClosed) return;
  const queued = bufferedSignals;
  bufferedSignals = [];
  for (const item of queued) {
    await session.handleSignal(item.payload);
  }
}

/**
 * Управляющее событие звонка: WS, при отсутствии соединения — REST-дубль
 * (/calls/{id}/accept|reject|end).
 */
function sendCallEvent(
  type: 'call.accept' | 'call.reject' | 'call.end',
  data: { call_id: UUID; reason?: string },
  restFallback: () => Promise<unknown>,
): void {
  if (wsClient.isOpen()) {
    try {
      wsClient.send(type, data);
      return;
    } catch {
      // упадём в REST
    }
  }
  void restFallback().catch((error) => {
    toast.error('Не удалось обновить состояние звонка', humanizeApiError(error));
  });
}

async function endCallOnServer(callId: UUID, reason: string): Promise<void> {
  try {
    await api.calls.end(callId, reason);
  } catch {
    // звонок мог уже завершиться
  }
}

/** Локальное завершение: гасим медиа, показываем подсказку и закрываем оверлей. */
function finishLocally(notice: string, durationOverride?: number): void {
  const set = useCallStore.setState;
  const state = useCallStore.getState();

  ringtone.stop();
  clearDurationTimer();
  clearWatchdog();
  clearQualityNote();
  disposeMeters();
  bufferedSignals = [];
  sessionPendingMedia = false;

  session?.hangup();
  session = null;

  const duration =
    durationOverride ?? (state.phase === 'active' ? Math.max(state.durationSeconds, 0) : 0);

  set({
    phase: 'ended',
    notice,
    durationSeconds: duration,
    localStream: null,
    remoteStream: null,
    muted: false,
    cameraEnabled: false,
    connectionState: null,
    quality: 'unknown',
    stats: null,
    audioBlocked: false,
    localAudioLevel: 0,
    remoteAudioLevel: 0,
    localSpeaking: false,
    remoteSpeaking: false,
    retryAudioPlayback: null,
  });

  clearDismissTimer();
  dismissTimer = window.setTimeout(() => {
    dismissTimer = null;
    useCallStore.getState().reset();
  }, ENDED_OVERLAY_MS);
}
