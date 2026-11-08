import { IconMicOff } from '../Icons';

interface LevelMeterProps {
  /** Уровень 0..1 (см. lib/audio-meter.ts). */
  level: number;
  speaking: boolean;
}

/**
 * Полоски-эквалайзер: высота столбиков пропорциональна уровню звука.
 * Набор коэффициентов даёт «живую» неравномерность, как у индикаторов в
 * нативных звонилках.
 */
const BAR_SHAPE = [0.45, 0.85, 1, 0.7, 0.5];

export function LevelMeter({ level, speaking }: LevelMeterProps) {
  return (
    <span className={`vad${speaking ? ' vad--speaking' : ''}`} aria-hidden="true">
      {BAR_SHAPE.map((shape, index) => {
        const height = 14 + Math.min(1, level * shape * 1.7) * 86;
        return <span key={index} className="vad__bar" style={{ height: `${height}%` }} />;
      })}
    </span>
  );
}

interface VadBadgeProps {
  name: string;
  level: number;
  speaking: boolean;
  /** Микрофон выключен — показываем это явно. */
  muted?: boolean;
  className?: string;
}

/**
 * Плашка участника с индикатором речи. Висит поверх видео (или рядом с аватаром
 * в аудиозвонке), поэтому её видно в любом раскладе.
 */
export function VadBadge({ name, level, speaking, muted, className }: VadBadgeProps) {
  const active = speaking && !muted;
  const state = muted ? 'микрофон выключен' : active ? 'говорит' : '';

  return (
    <span className={`vad-badge${active ? ' vad-badge--speaking' : ''}${className ? ` ${className}` : ''}`}>
      <span className="vad-badge__name">{name}</span>
      {muted ? <IconMicOff size={14} /> : <LevelMeter level={level} speaking={active} />}
      {state ? <span className="vad-badge__state">{state}</span> : null}
    </span>
  );
}
