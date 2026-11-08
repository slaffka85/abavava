import { Avatar } from '../Avatar';
import { callKindLabel, formatDuration } from '../../lib/format';
import { useCallStore } from '../../store/call';
import type { CallQuality } from '../../lib/webrtc';
import { IconMic, IconMicOff, IconPhoneOff, IconVideo, IconVideoOff } from '../Icons';
import { AudioSurface, VideoSurface } from './VideoSurface';
import { VadBadge } from './VadBadge';

const QUALITY_LABEL: Record<CallQuality, string> = {
  good: 'хорошее качество',
  fair: 'среднее качество',
  poor: 'плохое качество',
  unknown: 'оценка качества…',
};

/** Сколько секунд разговора ждём, прежде чем судить о тишине у собеседника. */
const SILENCE_CHECK_SECONDS = 6;
/** Порог «звук не идёт»: за 6 секунд разговора должно прийти заметно больше. */
const SILENCE_THRESHOLD_BYTES = 1000;

function connectionLabel(state: RTCPeerConnectionState | null, quality: CallQuality): string {
  switch (state) {
    case 'connected':
      return `Соединение установлено, ${QUALITY_LABEL[quality]}`;
    case 'connecting':
      return 'Устанавливаем соединение…';
    case 'new':
      return 'Готовим соединение…';
    case 'disconnected':
      return 'Проблема с соединением, восстанавливаем…';
    case 'failed':
      return 'Соединение потеряно';
    case 'closed':
      return 'Соединение закрыто';
    default:
      return 'Соединение…';
  }
}

/** Компактный формат объёма трафика для диагностики звука. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

/** Полноэкранный оверлей звонка: видео, таймер, статус, mute/камера/завершить. */
export function CallOverlay() {
  const phase = useCallStore((state) => state.phase);
  const call = useCallStore((state) => state.call);
  const localStream = useCallStore((state) => state.localStream);
  const remoteStream = useCallStore((state) => state.remoteStream);
  const muted = useCallStore((state) => state.muted);
  const cameraEnabled = useCallStore((state) => state.cameraEnabled);
  const durationSeconds = useCallStore((state) => state.durationSeconds);
  const connectionState = useCallStore((state) => state.connectionState);
  const quality = useCallStore((state) => state.quality);
  const stats = useCallStore((state) => state.stats);
  const audioBlocked = useCallStore((state) => state.audioBlocked);
  const localAudioLevel = useCallStore((state) => state.localAudioLevel);
  const remoteAudioLevel = useCallStore((state) => state.remoteAudioLevel);
  const localSpeaking = useCallStore((state) => state.localSpeaking);
  const remoteSpeaking = useCallStore((state) => state.remoteSpeaking);
  const micDevices = useCallStore((state) => state.micDevices);
  const micId = useCallStore((state) => state.micId);
  const micBusy = useCallStore((state) => state.micBusy);
  const switchMicrophone = useCallStore((state) => state.switchMicrophone);
  const retryAudioPlayback = useCallStore((state) => state.retryAudioPlayback);
  const setAudioBlocked = useCallStore((state) => state.setAudioBlocked);
  const setAudioRetry = useCallStore((state) => state.setAudioRetry);
  const error = useCallStore((state) => state.error);
  const notice = useCallStore((state) => state.notice);
  const toggleMute = useCallStore((state) => state.toggleMute);
  const toggleCamera = useCallStore((state) => state.toggleCamera);
  const hangup = useCallStore((state) => state.hangup);

  if (phase !== 'outgoing' && phase !== 'active' && phase !== 'ended') return null;
  if (!call) return null;

  const peer = call.peer;
  const peerName = peer?.display_name ?? 'Собеседник';
  const hasRemoteVideo = Boolean(remoteStream?.getVideoTracks().length);
  const hasLocalVideo = Boolean(localStream?.getVideoTracks().length) && cameraEnabled;
  const showVideoLayout = call.kind === 'video' || hasRemoteVideo;
  // Видео собеседника показываем, только если оно реально есть. Во всех
  // остальных случаях звук идёт через отдельный аудиоплеер: без него в
  // аудиозвонке и при выключенной камере собеседника звука не было вообще.
  const showRemoteVideo = showVideoLayout && hasRemoteVideo;

  const audioInBytes = stats?.audioInBytes ?? 0;
  const audioOutBytes = stats?.audioOutBytes ?? 0;
  const audioInLevel = stats?.audioInLevel ?? null;
  const peerSilent =
    phase === 'active' &&
    durationSeconds >= SILENCE_CHECK_SECONDS &&
    audioInBytes < SILENCE_THRESHOLD_BYTES &&
    !audioBlocked;
  // Свой микрофон молчит: уровень нулевой, хотя микрофон не выключен вручную.
  // По опыту это самая частая причина «меня не слышно»: выбрано не то устройство
  // ввода, устройство заглушено в системе или занято другим приложением.
  const localSilent =
    phase === 'active' &&
    !muted &&
    durationSeconds >= SILENCE_CHECK_SECONDS &&
    localAudioLevel < 0.02 &&
    !localSpeaking;

  if (phase === 'ended') {
    return (
      <div className="call-overlay">
        <div className="call-overlay__ended">
          <Avatar id={peer?.id ?? call.id} name={peerName} size={92} />
          <h2 className="call-overlay__name">{peerName}</h2>
          <p className="call-overlay__notice">{notice ?? 'Звонок завершён'}</p>
          {durationSeconds > 0 ? <p className="call-overlay__timer">Длительность: {formatDuration(durationSeconds)}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="call-overlay">
      <div className="call-overlay__stage">
        {/* Индикаторы активности голоса: видно, говорит собеседник или вы */}
        <span className="call-overlay__vad call-overlay__vad--peer">
          <VadBadge name={peerName} level={remoteAudioLevel} speaking={remoteSpeaking} />
        </span>
        <span className="call-overlay__vad call-overlay__vad--self">
          <VadBadge name="Вы" level={localAudioLevel} speaking={localSpeaking} muted={muted} />
        </span>

        {showRemoteVideo ? (
          <VideoSurface
            stream={remoteStream}
            className={`call-overlay__remote${remoteSpeaking ? ' is-speaking' : ''}`}
            onPlaybackBlocked={setAudioBlocked}
            onRetryReady={setAudioRetry}
          />
        ) : (
          <>
            <AudioSurface
              stream={remoteStream}
              className="call-overlay__remote-audio"
              onPlaybackBlocked={setAudioBlocked}
              onRetryReady={setAudioRetry}
            />
            <div className="call-overlay__audio">
              <div className={`vad-avatar${remoteSpeaking ? ' is-speaking' : ''}`}>
                <Avatar id={peer?.id ?? call.id} name={peerName} size={132} />
              </div>
              <h2 className="call-overlay__name">{peerName}</h2>
              <p className="call-overlay__kind">{callKindLabel(call.kind)}</p>
            </div>
          </>
        )}

        {showVideoLayout && hasLocalVideo ? (
          <div className={`call-overlay__pip${localSpeaking && !muted ? ' is-speaking' : ''}`}>
            <VideoSurface stream={localStream} muted mirror className="call-overlay__local" />
          </div>
        ) : null}
      </div>

      <div className="call-overlay__info">
        <span className="call-overlay__timer">
          {phase === 'outgoing' ? 'Вызываем…' : formatDuration(durationSeconds)}
        </span>
        <span className="call-overlay__state">{connectionLabel(connectionState, quality)}</span>

        {phase === 'active' ? (
          <span className="call-overlay__diag">
            звук: вход {formatBytes(audioInBytes)}
            {audioInLevel !== null ? ` (уровень ${audioInLevel.toFixed(2)})` : ''} · выход{' '}
            {formatBytes(audioOutBytes)}
          </span>
        ) : null}

        {audioBlocked ? (
          <button
            type="button"
            className="call-overlay__unlock"
            onClick={() => retryAudioPlayback?.()}
          >
            Включить звук — браузер заблокировал воспроизведение
          </button>
        ) : null}

        {peerSilent ? (
          <span className="call-overlay__hint">
            Звук от собеседника не идёт: возможно, у него выключен микрофон или занят другим приложением
          </span>
        ) : null}

        {localSilent ? (
          <span className="call-overlay__hint call-overlay__hint--warn">
            Ваш микрофон не передаёт звук
            {micDevices.length > 1 ? ' — выберите другое устройство ввода ниже' : ''}. Возможные причины:
            устройство заглушено в системе, занято другим приложением или выбрано не то
          </span>
        ) : null}

        {micDevices.length > 1 ? (
          <label className="call-overlay__mic">
            <span className="call-overlay__mic-label">Микрофон</span>
            <select
              value={micId ?? ''}
              disabled={micBusy}
              onChange={(event) => void switchMicrophone(event.target.value)}
            >
              <option value="">Системный по умолчанию</option>
              {micDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {phase === 'active' && audioInBytes > 0 && !audioBlocked ? (
          <span className="call-overlay__hint">
            Не слышно собеседника? Проверьте беззвучный режим и громкость медиа на устройстве
          </span>
        ) : null}

        {error ? <span className="call-overlay__error">{error}</span> : null}
      </div>

      <div className="call-overlay__controls">
        <button
          type="button"
          className={`call-btn call-btn--round${muted ? ' call-btn--on' : ''}`}
          title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
          aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'}
          onClick={toggleMute}
        >
          {muted ? <IconMicOff size={22} /> : <IconMic size={22} />}
        </button>

        <button
          type="button"
          className={`call-btn call-btn--round${cameraEnabled ? ' call-btn--on' : ''}`}
          title={cameraEnabled ? 'Выключить камеру' : 'Включить камеру'}
          aria-label={cameraEnabled ? 'Выключить камеру' : 'Включить камеру'}
          onClick={toggleCamera}
        >
          {cameraEnabled ? <IconVideo size={22} /> : <IconVideoOff size={22} />}
        </button>

        <button
          type="button"
          className="call-btn call-btn--round call-btn--hangup"
          title="Завершить"
          aria-label="Завершить"
          onClick={hangup}
        >
          <IconPhoneOff size={22} />
        </button>
      </div>
    </div>
  );
}
