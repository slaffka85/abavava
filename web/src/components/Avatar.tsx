import { avatarStyle, getInitials } from '../lib/format';

interface AvatarProps {
  id: string;
  name: string;
  size?: number;
  /** Зелёная точка presence (только для собеседников). */
  online?: boolean;
  className?: string;
}

export function Avatar({ id, name, size = 44, online, className }: AvatarProps) {
  return (
    <span
      className={className ? `avatar ${className}` : 'avatar'}
      style={{ ...avatarStyle(id), width: size, height: size, fontSize: Math.max(12, Math.round(size / 2.6)) }}
      aria-hidden="true"
    >
      {getInitials(name)}
      {online ? <span className="avatar__dot" /> : null}
    </span>
  );
}
