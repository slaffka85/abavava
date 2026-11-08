/**
 * Индикатор активности голоса (VAD) на Web Audio API.
 *
 * getStats() даёт audioLevel, но обновляется раз в ~2 секунды — для живого
 * индикатора речи этого мало. AnalyserNode читает поток 10–12 раз в секунду,
 * поэтому кольцо вокруг аватара реагирует мгновенно.
 *
 * Важно: анализатор НЕ подключается к destination. Звук по-прежнему выводит
 * <video>/<audio> с srcObject; если подключить источник к выходу аудиоконтекста,
 * получится эхо собственного микрофона.
 */

/** Порог RMS, выше которого считаем, что человек говорит. */
const SPEAK_ENTER = 0.12;
/** Ниже этого уровня речь считается законченной. */
const SPEAK_EXIT = 0.06;
/** Сколько держим индикатор после последнего громкого сэмпла (гасит мерцание). */
const SPEAK_HOLD_MS = 350;
/** Период опроса анализатора. */
const SAMPLE_MS = 90;

export interface AudioMeterHandle {
  stop(): void;
}

export interface AudioMeterCallbacks {
  /** level — 0..1 (сглаженный), speaking — грубая бинарная оценка речи. */
  (level: number, speaking: boolean): void;
}

type AudioContextCtor = typeof AudioContext;

function resolveAudioContext(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  // webkitAudioContext — префикс Safari; в типах DOM его нет, поэтому приводим явно.
  const globalWindow = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return globalWindow.AudioContext ?? globalWindow.webkitAudioContext ?? null;
}

/**
 * Создаёт измеритель уровня для потока. Возвращает no-op, если поток без
 * аудиодорожки или браузер не поддерживает Web Audio: индикатор просто не
 * появится, а звонок продолжит работать.
 */
export function createAudioMeter(stream: MediaStream, onSample: AudioMeterCallbacks): AudioMeterHandle {
  const Ctor = resolveAudioContext();
  if (!Ctor || stream.getAudioTracks().length === 0) {
    return { stop: () => undefined };
  }

  let context: AudioContext;
  try {
    context = new Ctor();
  } catch {
    return { stop: () => undefined };
  }

  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
  } catch {
    void context.close().catch(() => undefined);
    return { stop: () => undefined };
  }

  const buffer = new Float32Array(analyser.fftSize);
  let smoothed = 0;
  let speaking = false;
  let lastLoudAt = 0;
  let stopped = false;

  // Safari и мобильные браузеры создают контекст в состоянии suspended и
  // включают его только после жеста пользователя. Пробуем сразу и на касание.
  const resume = () => {
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
  };
  resume();
  document.addEventListener('pointerdown', resume);
  document.addEventListener('keydown', resume);

  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buffer);

    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      sum += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sum / buffer.length);

    // Логарифмическое сжатие: тихая речь уже заметна, а крик не упирается в 1.
    const level = Math.min(1, Math.pow(rms * 8, 0.7));
    smoothed = smoothed * 0.55 + level * 0.45;

    const now = performance.now();
    if (smoothed > SPEAK_ENTER) lastLoudAt = now;
    const nextSpeaking =
      smoothed > SPEAK_ENTER || (speaking && smoothed > SPEAK_EXIT && now - lastLoudAt < SPEAK_HOLD_MS);
    speaking = nextSpeaking;

    onSample(smoothed, speaking);
  };

  const timer = window.setInterval(tick, SAMPLE_MS);

  return {
    stop() {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // узлы могли быть уже отключены при закрытии контекста
      }
      void context.close().catch(() => undefined);
    },
  };
}

/**
 * Оценка речи по значению audioLevel из getStats — резервный путь, если
 * анализатор недоступен (контекст не разрешён, экзотический браузер).
 */
export function speakingFromStatsLevel(level: number | null | undefined): boolean {
  return typeof level === 'number' && level > 0.02;
}
