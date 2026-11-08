import { useCallback, useEffect, useRef } from 'react';

interface SurfaceProps {
  stream: MediaStream | null;
  className?: string;
  /**
   * Сообщает наружу, что браузер заблокировал воспроизведение, и отдаёт функцию
   * повторной попытки (её вызывает кнопка «Включить звук» в оверлее).
   * Мобильные браузеры разрешают воспроизведение со звуком только после жеста
   * пользователя, поэтому одной попытки play() недостаточно.
   */
  onPlaybackBlocked?: (blocked: boolean) => void;
  onRetryReady?: (retry: (() => void) | null) => void;
}

/**
 * Привязывает MediaStream к медиаэлементу и следит за воспроизведением.
 * srcObject нельзя задать через JSX, поэтому работаем через ref.
 */
function useStreamPlayback(stream: MediaStream | null, onPlaybackBlocked?: (blocked: boolean) => void, onRetryReady?: (retry: (() => void) | null) => void) {
  const elementRef = useRef<HTMLMediaElement | null>(null);

  const tryPlay = useCallback(async () => {
    const element = elementRef.current;
    if (!element || !element.srcObject) return;
    try {
      element.volume = 1; // громкость могла быть унаследована от предыдущего звонка
      await element.play();
      onPlaybackBlocked?.(false);
    } catch {
      onPlaybackBlocked?.(true);
    }
  }, [onPlaybackBlocked]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    element.srcObject = stream;
    if (!stream) {
      onRetryReady?.(null);
      return;
    }

    void tryPlay();
    onRetryReady?.(() => {
      void tryPlay();
    });

    // Первое касание экрана снимает блокировку автоплея — самый частый сценарий
    // на телефоне: звук включается сразу после тапа.
    const unlock = () => {
      void tryPlay();
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);

    // Элемент не должен стоять на паузе: живой поток всегда играет.
    const resume = () => {
      void tryPlay();
    };
    element.addEventListener('pause', resume);

    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
      element.removeEventListener('pause', resume);
      element.srcObject = null;
      onRetryReady?.(null);
    };
  }, [stream, tryPlay, onRetryReady]);

  return elementRef;
}

interface VideoSurfaceProps extends SurfaceProps {
  muted?: boolean;
  /** Зеркалим локальное видео — привычнее для пользователя. */
  mirror?: boolean;
}

/** Видео: удалённое (со звуком) или локальное (без звука, зеркальное). */
export function VideoSurface({ stream, muted, mirror, className, onPlaybackBlocked, onRetryReady }: VideoSurfaceProps) {
  const ref = useStreamPlayback(stream, onPlaybackBlocked, onRetryReady);

  return (
    <video
      ref={ref as React.RefObject<HTMLVideoElement>}
      className={className}
      autoPlay
      playsInline
      // Без muted локальное видео давало бы эхо собственного микрофона.
      muted={muted}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}

/**
 * Скрытый аудиоплеер. Нужен для аудиозвонков и для случая, когда собеседник
 * отключил камеру: раньше в этих режимах удалённый поток не привязывался ни к
 * одному элементу, и звука не было вообще.
 */
export function AudioSurface({ stream, className, onPlaybackBlocked, onRetryReady }: SurfaceProps) {
  const ref = useStreamPlayback(stream, onPlaybackBlocked, onRetryReady);
  return <audio ref={ref as React.RefObject<HTMLAudioElement>} className={className} autoPlay playsInline />;
}
