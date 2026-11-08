/**
 * WebRTC 1:1 с perfect negotiation (docs/WS-PROTOCOL.md, раздел «WebRTC-сигналинг»).
 *
 * Роли: `polite = (myUserId > peerUserId)` — формула симметрична, поэтому обе
 * стороны вычисляют её независимо и получают ровно одного polite и одного impolite.
 * Инициатор звонка обычно impolite, но при коллизии offer'ов решает именно формула.
 *
 * Схема установления соединения (детерминированная, без лишней glare):
 *  - звонящий: getUserMedia → addTrack → negotiationneeded → offer;
 *  - вызываемый: getUserMedia → ждёт offer → setRemoteDescription(offer) →
 *    addTrack (переиспользует transceiver'ы из offer'а) → answer.
 *    Треки добавляются строго после setRemoteDescription, иначе addTrack породил бы
 *    собственный offer и встречный offer-коллизию на ровном месте.
 */
import { configApi } from './api';
import { audioTrackConstraints, rememberedMicId, rememberMicId, shouldFallbackToDefaultMic } from './media-devices';
import type { CallKind, IceServer, SignalPayload } from './types';

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function toRtcIceServer(server: IceServer): RTCIceServer | null {
  const urls = Array.isArray(server.urls) ? server.urls.filter(Boolean) : server.urls;
  if (!urls || (Array.isArray(urls) && urls.length === 0)) return null;
  const result: RTCIceServer = { urls };
  if (server.username) result.username = server.username;
  if (server.credential) result.credential = server.credential;
  return result;
}

let cachedIceServers: RTCIceServer[] | null = null;

/** ICE-серверы из GET /config/ice; при любой ошибке — встроенный STUN-дефолт. */
export async function loadIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers) return cachedIceServers;
  try {
    const config = await configApi.ice();
    const servers = (config.ice_servers ?? [])
      .map(toRtcIceServer)
      .filter((item): item is RTCIceServer => item !== null);
    cachedIceServers = servers.length > 0 ? servers : DEFAULT_ICE_SERVERS;
  } catch {
    cachedIceServers = DEFAULT_ICE_SERVERS;
  }
  return cachedIceServers;
}

export type CallQuality = 'good' | 'fair' | 'poor' | 'unknown';

export interface CallStatsSummary {
  rttMs: number | null;
  packetsLost: number;
  packetsReceived: number;
  lossPercent: number;
  quality: CallQuality;
  /**
   * Диагностика звука. Нужна, чтобы различить две неисправности, которые
   * выглядят одинаково («не слышно собеседника»):
   *  - audioInBytes === 0 — звук от собеседника вообще не приходит (проблема
   *    у него: микрофон выключен, устройство занято, трек не отправляется);
   *  - audioInBytes растёт, но звука нет — звук приходит, но не воспроизводится
   *    (политика автоплея, беззвучный режим, громкость медиа на устройстве).
   */
  audioInBytes: number;
  audioOutBytes: number;
  audioInLevel: number | null;
}

export interface CallSessionOptions {
  callId: string;
  kind: CallKind;
  myUserId: string;
  peerUserId: string;
  /** Отправка call.signal с payload. */
  sendSignal: (payload: SignalPayload) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onLocalStream: (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onError: (message: string) => void;
  /** Камера физически включена/выключена (для индикатора и кнопки). */
  onCameraEnabledChange?: (enabled: boolean) => void;
}

const STATS_POLL_MS = 2_000;
/** Сколько ждём восстановления ICE при 'disconnected', прежде чем сделать ICE restart. */
const DISCONNECTED_GRACE_MS = 5_000;

interface CandidatePairStat {
  type: string;
  state?: string;
  nominated?: boolean;
  currentRoundTripTime?: number;
}

interface InboundRtpStat {
  type: string;
  kind?: string;
  packetsLost?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  audioLevel?: number;
}

interface OutboundRtpStat {
  type: string;
  kind?: string;
  bytesSent?: number;
}

function describeMediaError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Доступ к микрофону или камере запрещён';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Устройство не найдено';
    case 'NotReadableError':
      return 'Устройство занято другим приложением';
    default:
      return error instanceof Error ? error.message : 'Не удалось получить доступ к медиа';
  }
}

export class CallSession {
  readonly callId: string;
  readonly kind: CallKind;
  readonly polite: boolean;
  readonly remoteStream = new MediaStream();

  private readonly pc: RTCPeerConnection;
  private readonly options: CallSessionOptions;
  private localStream: MediaStream | null = null;

  /** Perfect negotiation: защита от встречных offer'ов. */
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;

  /** Кандидаты, пришедшие до remote description. */
  private pendingCandidates: RTCIceCandidateInit[] = [];

  private closed = false;
  private iceRestartUsed = false;
  private disconnectedTimer: number | null = null;
  private statsTimer: number | null = null;
  private cameraEnabled = false;

  constructor(options: CallSessionOptions, iceServers: RTCIceServer[]) {
    this.callId = options.callId;
    this.kind = options.kind;
    this.options = options;
    // Строковое сравнение UUID: одинаковый результат на обеих сторонах.
    this.polite = options.myUserId > options.peerUserId;

    this.pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 2,
    });

    this.pc.onicecandidate = (event) => {
      // Пустой candidate (end-of-candidates) не пересылаем — так требует контракт.
      if (!event.candidate || !event.candidate.candidate) return;
      this.options.sendSignal({
        type: 'candidate',
        candidate: event.candidate.candidate,
        sdp_mid: event.candidate.sdpMid ?? null,
        sdp_mline_index: event.candidate.sdpMLineIndex ?? null,
      });
    };

    this.pc.ontrack = (event) => {
      const isNewTrack = !this.remoteStream.getTracks().some((track) => track.id === event.track.id);
      if (isNewTrack) {
        this.remoteStream.addTrack(event.track);
        // MediaStream остаётся тем же объектом, когда браузер добавляет в него
        // вторую дорожку (часто видео после аудио). Публикуем новый wrapper,
        // иначе React/Zustand могут не перерисовать VideoSurface из-за той же
        // ссылки, и видео проявится только после следующего нажатия в UI.
        this.options.onRemoteStream(new MediaStream(this.remoteStream.getTracks()));
      }
    };

    this.pc.onnegotiationneeded = () => {
      void this.onNegotiationNeeded();
    };

    this.pc.onconnectionstatechange = () => {
      this.handleConnectionState(this.pc.connectionState);
    };
  }

  static async create(options: CallSessionOptions): Promise<CallSession> {
    const iceServers = await loadIceServers();
    return new CallSession(options, iceServers);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  isCameraEnabled(): boolean {
    return this.cameraEnabled;
  }

  isMuted(): boolean {
    return (this.localStream?.getAudioTracks() ?? []).every((track) => !track.enabled);
  }

  /** Роль звонящего: получаем медиа, добавляем треки — offer уйдёт сам по negotiationneeded. */
  async startAsCaller(): Promise<void> {
    this.localStream = await this.acquireMedia(this.kind === 'video');
    this.cameraEnabled = this.localStream.getVideoTracks().length > 0;
    this.options.onLocalStream(this.localStream);
    this.options.onCameraEnabledChange?.(this.cameraEnabled);
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
  }

  /**
   * Роль вызываемого: получаем медиа, но треки добавляем позже — внутри обработки
   * входящего offer'а (см. applyOffer), чтобы переиспользовать его transceiver'ы.
   */
  async prepareAsAnswerer(): Promise<void> {
    this.localStream = await this.acquireMedia(this.kind === 'video');
    this.cameraEnabled = this.localStream.getVideoTracks().length > 0;
    this.options.onLocalStream(this.localStream);
    this.options.onCameraEnabledChange?.(this.cameraEnabled);
  }

  /** Обработка call.signal: offer/answer/candidate по правилам perfect negotiation. */
  async handleSignal(payload: SignalPayload): Promise<void> {
    if (this.closed) return;

    if (payload.type === 'candidate') {
      const candidate: RTCIceCandidateInit = {
        candidate: payload.candidate,
        sdpMid: payload.sdp_mid ?? undefined,
        sdpMLineIndex: payload.sdp_mline_index ?? undefined,
      };
      if (!this.pc.remoteDescription) {
        // Буферизуем до установки remote description.
        this.pendingCandidates.push(candidate);
        return;
      }
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        // Ошибку кандидата из «игнорируемого» offer'а глушим — это ожидаемо при glare.
        if (!this.ignoreOffer) {
          console.warn('[webrtc] addIceCandidate failed', error);
        }
      }
      return;
    }

    const description: RTCSessionDescriptionInit = { type: payload.type, sdp: payload.sdp };
    const readyForOffer =
      !this.makingOffer && (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) {
      // Impolite-сторона игнорирует встречный offer: её собственный offer побеждает.
      return;
    }

    if (offerCollision && this.polite && this.pc.signalingState === 'have-local-offer') {
      // Polite-сторона откатывает свой локальный offer и принимает входящий.
      await this.pc.setLocalDescription({ type: 'rollback' });
    }

    this.isSettingRemoteAnswerPending = description.type === 'answer';
    try {
      await this.pc.setRemoteDescription(description);
    } catch (error) {
      this.isSettingRemoteAnswerPending = false;
      this.options.onError(describeMediaError(error));
      return;
    }
    this.isSettingRemoteAnswerPending = false;

    if (description.type === 'offer') {
      // Только теперь добавляем свои треки — они «сядут» в transceiver'ы из offer'а.
      await this.attachPreparedTracks();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      const local = this.pc.localDescription;
      if (local?.sdp) this.options.sendSignal({ type: 'answer', sdp: local.sdp });
    }

    await this.flushPendingCandidates();
  }

  /** Включить камеру: новый трек → renegotiation (offer/answer), соединение не пересобираем. */
  async enableCamera(): Promise<void> {
    if (this.closed) return;
    if (this.localStream?.getVideoTracks().length) {
      for (const track of this.localStream.getVideoTracks()) track.enabled = true;
      this.cameraEnabled = true;
      this.options.onCameraEnabledChange?.(true);
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: true });
      const [videoTrack] = media.getVideoTracks();
      if (!videoTrack) return;
      const stream = this.ensureLocalStream();
      stream.addTrack(videoTrack);
      this.pc.addTrack(videoTrack, stream);
      this.cameraEnabled = true;
      this.options.onLocalStream(stream);
      this.options.onCameraEnabledChange?.(true);
      // Дальше negotiationneeded сам отправит новый offer — соединение не пересобирается.
    } catch (error) {
      this.options.onError(describeMediaError(error));
    }
  }

  /**
   * Выключить камеру. Трек именно останавливаем (а не просто enabled=false),
   * чтобы погас аппаратный индикатор камеры.
   */
  disableCamera(): void {
    const stream = this.localStream;
    if (stream) {
      for (const track of stream.getVideoTracks()) {
        const sender = this.pc.getSenders().find((item) => item.track === track);
        if (sender) {
          try {
            this.pc.removeTrack(sender);
          } catch {
            // соединение могло уже закрыться
          }
        }
        track.stop();
        stream.removeTrack(track);
      }
    }
    this.cameraEnabled = false;
    this.options.onCameraEnabledChange?.(false);
    if (stream) this.options.onLocalStream(stream);
  }

  toggleCamera(): Promise<void> | void {
    if (this.cameraEnabled) {
      this.disableCamera();
      return;
    }
    return this.enableCamera();
  }

  mute(): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = false;
  }

  unmute(): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = true;
  }

  /** Полное завершение: останавливаем все локальные треки и закрываем peer connection. */
  hangup(): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.stopStatsPolling();
    if (this.disconnectedTimer !== null) {
      window.clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }

    for (const track of this.localStream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // трек мог быть уже остановлен
      }
    }
    this.localStream = null;
    this.cameraEnabled = false;
    this.options.onCameraEnabledChange?.(false);

    for (const track of this.remoteStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // игнорируем
      }
    }

    if (!wasClosed) {
      try {
        this.pc.close();
      } catch {
        // peer connection мог быть уже закрыт
      }
    }
    this.pendingCandidates = [];
  }

  /** Простая сводка качества: RTT по выбранной паре и потери по inbound-rtp. */
  async stats(): Promise<CallStatsSummary> {
    const empty: CallStatsSummary = {
      rttMs: null,
      packetsLost: 0,
      packetsReceived: 0,
      lossPercent: 0,
      quality: 'unknown',
      audioInBytes: 0,
      audioOutBytes: 0,
      audioInLevel: null,
    };
    if (this.closed) return empty;

    let rttMs: number | null = null;
    let packetsLost = 0;
    let packetsReceived = 0;
    let audioInBytes = 0;
    let audioOutBytes = 0;
    let audioInLevel: number | null = null;

    try {
      const report = await this.pc.getStats();
      report.forEach((raw) => {
        const stat = raw as CandidatePairStat & InboundRtpStat & OutboundRtpStat;
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
          if (typeof stat.currentRoundTripTime === 'number') rttMs = Math.round(stat.currentRoundTripTime * 1000);
          return;
        }
        if (stat.type === 'inbound-rtp') {
          packetsLost += stat.packetsLost ?? 0;
          packetsReceived += stat.packetsReceived ?? 0;
          if (stat.kind === 'audio') {
            audioInBytes += stat.bytesReceived ?? 0;
            if (typeof stat.audioLevel === 'number') audioInLevel = stat.audioLevel;
          }
          return;
        }
        if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
          audioOutBytes += stat.bytesSent ?? 0;
        }
      });
    } catch {
      return empty;
    }

    const total = packetsLost + packetsReceived;
    const lossPercent = total > 0 ? (packetsLost / total) * 100 : 0;

    let quality: CallQuality = 'unknown';
    if (rttMs !== null || total > 0) {
      const rtt = rttMs ?? 0;
      if (rtt < 150 && lossPercent < 2) quality = 'good';
      else if (rtt < 400 && lossPercent < 5) quality = 'fair';
      else quality = 'poor';
    }

    return {
      rttMs,
      packetsLost,
      packetsReceived,
      lossPercent,
      quality,
      audioInBytes,
      audioOutBytes,
      audioInLevel,
    };
  }

  /** Периодический опрос getStats для индикатора качества. */
  startStatsPolling(onStats: (stats: CallStatsSummary) => void): void {
    this.stopStatsPolling();
    this.statsTimer = window.setInterval(() => {
      void this.stats().then(onStats);
    }, STATS_POLL_MS);
  }

  /**
   * Принудительная реnegotiation с ICE restart. Используется после реконнекта WS:
   * сигналинг мог потерять кандидатов, и соединение нужно пересобрать.
   */
  renegotiate(): void {
    if (this.closed) return;
    this.iceRestartUsed = false;
    try {
      this.pc.restartIce();
    } catch (error) {
      this.options.onError(describeMediaError(error));
    }
  }

  /**
   * Восстановить первый offer вызывающего, если он был отправлен, пока второй
   * участник был офлайн (например, приложение запустили по FCM уведомлению).
   * Без rollback RTCPeerConnection остаётся в have-local-offer и не создаёт
   * новый negotiationneeded после того, как адресат подключился.
   */
  async recoverUnansweredOffer(): Promise<void> {
    if (this.closed || this.pc.remoteDescription) return;
    try {
      if (this.pc.signalingState === 'have-local-offer') {
        await this.pc.setLocalDescription({ type: 'rollback' });
      }
      if (this.closed || this.pc.remoteDescription) return;
      this.iceRestartUsed = false;
      this.pc.restartIce();
    } catch (error) {
      this.options.onError(describeMediaError(error));
    }
  }

  stopStatsPolling(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /* ---------------- внутреннее ---------------- */

  private ensureLocalStream(): MediaStream {
    if (!this.localStream) this.localStream = new MediaStream();
    return this.localStream;
  }

  /**
   * Почему недоступен захват медиа. Браузеры отдают navigator.mediaDevices
   * только в защищённом контексте: https, localhost или 127.0.0.1. По адресу
   * http://<локальный IP> (например, с телефона в той же сети) API отсутствует —
   * это самая частая причина «звонок не работает с мобильного».
   */
  private static describeMediaUnavailable(): string {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return 'Звонки доступны только по HTTPS: по http://<адрес> браузер не даёт доступ к камере и микрофону. Откройте приложение по https (см. docs/DEPLOYMENT.md) или через localhost';
    }
    return 'Браузер не поддерживает захват медиа (getUserMedia). Если это встроенный браузер приложения, откройте ссылку в Chrome или Safari';
  }

  private async acquireMedia(withVideo: boolean): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(CallSession.describeMediaUnavailable());
    }

    const audio = await this.openAudio();

    if (!withVideo) {
      return new MediaStream(audio.getAudioTracks());
    }

    try {
      const video = await navigator.mediaDevices.getUserMedia({ video: true });
      const stream = new MediaStream();
      for (const track of audio.getTracks()) stream.addTrack(track);
      for (const track of video.getTracks()) stream.addTrack(track);
      return stream;
    } catch (error) {
      // Видеозвонок деградируем до аудио, если камеры нет или она запрещена.
      this.options.onError('Камера недоступна — продолжаем с аудио');
      void error;
      return new MediaStream(audio.getAudioTracks());
    }
  }

  /**
   * Открывает микрофон с учётом выбранного пользователем устройства.
   * Если сохранённое устройство исчезло (отключили гарнитуру), забываем выбор и
   * берём системный микрофон по умолчанию — звонок не должен падать из-за этого.
   */
  private async openAudio(micId: string | null = rememberedMicId()): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioTrackConstraints(micId) });
    } catch (error) {
      if (micId && shouldFallbackToDefaultMic(error)) {
        rememberMicId(null);
        this.options.onError('Выбранный микрофон недоступен — пробуем системный микрофон');
        return navigator.mediaDevices.getUserMedia({ audio: audioTrackConstraints(null) });
      }
      throw new Error(describeMediaError(error));
    }
  }

  /**
   * Переключает микрофон прямо во время звонка. Используется RTCRtpSender.
   * replaceTrack: он меняет дорожку без повторного согласования SDP, поэтому
   * собеседник не слышит разрыва.
   */
  async switchMicrophone(deviceId: string | null): Promise<void> {
    if (this.closed) return;

    const audio = await this.openAudio(deviceId);
    const [newTrack] = audio.getAudioTracks();
    if (!newTrack) throw new Error('Не удалось получить доступ к выбранному микрофону');

    const sender = this.pc.getSenders().find((item) => item.track?.kind === 'audio');
    if (sender) {
      await sender.replaceTrack(newTrack);
    } else {
      // Аудиодорожки ещё не было (например, звонок начали без микрофона) —
      // addTrack вызовет renegotiation, perfect negotiation её обработает.
      const stream = this.ensureLocalStream();
      stream.addTrack(newTrack);
      this.pc.addTrack(newTrack, stream);
      this.options.onLocalStream(stream);
      rememberMicId(deviceId);
      return;
    }

    const stream = this.ensureLocalStream();
    for (const oldTrack of stream.getAudioTracks()) {
      stream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    stream.addTrack(newTrack);
    rememberMicId(deviceId);

    this.options.onLocalStream(stream);
  }

  private async attachPreparedTracks(): Promise<void> {
    const stream = this.localStream;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      const alreadyAdded = this.pc.getSenders().some((sender) => sender.track === track);
      if (alreadyAdded) continue;
      this.pc.addTrack(track, stream);
    }
  }

  private async onNegotiationNeeded(): Promise<void> {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const local = this.pc.localDescription;
      if (local?.sdp) this.options.sendSignal({ type: 'offer', sdp: local.sdp });
    } catch (error) {
      this.options.onError(describeMediaError(error));
    } finally {
      this.makingOffer = false;
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (this.pendingCandidates.length === 0) return;
    const queued = [...this.pendingCandidates];
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        if (!this.ignoreOffer) console.warn('[webrtc] buffered addIceCandidate failed', error);
      }
    }
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    this.options.onConnectionState(state);

    if (state === 'connected') {
      this.iceRestartUsed = false;
      if (this.disconnectedTimer !== null) {
        window.clearTimeout(this.disconnectedTimer);
        this.disconnectedTimer = null;
      }
      return;
    }

    if (state === 'disconnected') {
      // ICE часто восстанавливается сам; даём шанс, потом пробуем ICE restart.
      if (this.disconnectedTimer === null) {
        this.disconnectedTimer = window.setTimeout(() => {
          this.disconnectedTimer = null;
          if (!this.closed && this.pc.connectionState !== 'connected') {
            this.tryIceRestart('проблема с соединением');
          }
        }, DISCONNECTED_GRACE_MS);
      }
      return;
    }

    if (state === 'failed') {
      this.tryIceRestart('соединение разорвано');
    }
  }

  /** Автоматический ICE restart — ровно один раз на инцидент. */
  private tryIceRestart(reason: string): void {
    if (this.closed) return;
    if (this.iceRestartUsed) {
      this.options.onError(`Не удалось восстановить соединение (${reason})`);
      return;
    }
    this.iceRestartUsed = true;
    try {
      // restartIce() поднимает negotiationneeded → новый offer с новыми ICE-кредами.
      this.pc.restartIce();
    } catch (error) {
      this.options.onError(describeMediaError(error));
    }
  }
}
