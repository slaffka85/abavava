/**
 * Рингтон входящего звонка без внешних файлов: два OscillatorNode.
 * Автозапуск может быть заблокирован политикой autoplay (звонок приходит без
 * жеста пользователя), поэтому глушим ошибку и повторяем попытку `resume()` на
 * первом взаимодействии со страницей.
 */

const RING_DURATION_MS = 1_100;
const RING_PAUSE_MS = 1_800;
/** Принудительный автостоп — чтобы тон не тянулся, если звонок завис. */
const AUTO_STOP_MS = 45_000;

export interface RingtoneOptions {
  /** Частоты пары тонов (Гц). */
  frequencies?: [number, number];
  volume?: number;
}

export class Ringtone {
  private context: AudioContext | null = null;
  private loopTimer: number | null = null;
  private autoStopTimer: number | null = null;
  private stopTimer: number | null = null;
  private master: GainNode | null = null;
  private playing = false;
  private resumeHandler: (() => void) | null = null;

  start(options: RingtoneOptions = {}): void {
    if (this.playing) return;
    const AudioContextCtor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      this.context = new AudioContextCtor();
      this.master = this.context.createGain();
      this.master.gain.value = options.volume ?? 0.14;
      this.master.connect(this.context.destination);
    } catch {
      this.context = null;
      return;
    }

    this.playing = true;
    void this.context.resume().catch(() => undefined);

    const frequencies = options.frequencies ?? [660, 520];
    this.ring(frequencies);
    this.loopTimer = window.setInterval(() => this.ring(frequencies), RING_DURATION_MS + RING_PAUSE_MS);
    this.autoStopTimer = window.setTimeout(() => this.stop(), AUTO_STOP_MS);

    // Если контекст был suspended — включаем звук при первом действии пользователя.
    const resume = (): void => {
      void this.context?.resume().catch(() => undefined);
      this.detachResumeHandler();
    };
    this.resumeHandler = resume;
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
  }

  stop(): void {
    this.detachResumeHandler();
    if (this.loopTimer !== null) {
      window.clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.autoStopTimer !== null) {
      window.clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.playing = false;

    const context = this.context;
    this.context = null;
    this.master = null;
    if (context) {
      // Небольшая задержка, чтобы короткий тон не оборвался на середине.
      window.setTimeout(() => {
        void context.close().catch(() => undefined);
      }, 60);
    }
  }

  private detachResumeHandler(): void {
    if (this.resumeHandler) {
      window.removeEventListener('pointerdown', this.resumeHandler);
      window.removeEventListener('keydown', this.resumeHandler);
      this.resumeHandler = null;
    }
  }

  /** Одна «посылка»: два коротких тона подряд. */
  private ring([first, second]: [number, number]): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.tone(first, now, 0.35);
    this.tone(second, now + 0.45, 0.35);
  }

  private tone(frequency: number, startAt: number, duration: number): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;

    // Плавные фронты, иначе слышны щелчки.
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + 0.03);
    gain.gain.setValueAtTime(1, startAt + duration - 0.05);
    gain.gain.linearRampToValueAtTime(0, startAt + duration);

    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }
}

export const ringtone = new Ringtone();
