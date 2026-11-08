/** Форматирование дат/длительностей и вычисляемые подписи для UI. */
import type { Call, CallKind, ConversationView, User, UUID } from './types';

const TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const DAY_MONTH_FORMATTER = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? TIME_FORMATTER.format(date) : '';
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** «Сегодня» / «Вчера» / «31 января» / «31 января 2024 г.» */
export function formatDayLabel(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '';
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  if (date.getFullYear() === now.getFullYear()) return DAY_MONTH_FORMATTER.format(date);
  return FULL_DATE_FORMATTER.format(date);
}

/** Короткий штамп для списка диалогов: время сегодня, «вчера», иначе дата. */
export function formatListTimestamp(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '';
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return TIME_FORMATTER.format(date);
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) return new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date);
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date);
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  const seconds = Math.max(0, Math.floor(totalSeconds ?? 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Длительность для истории звонков: «5 мин 12 с». */
export function formatDurationHuman(totalSeconds: number | null | undefined): string {
  const seconds = Math.max(0, Math.floor(totalSeconds ?? 0));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes} мин ${rest} с` : `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '';
  return `${formatDayLabel(value)}, ${TIME_FORMATTER.format(date)}`;
}

export function getInitials(name: string | null | undefined): string {
  const source = (name ?? '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  const visible = parts.slice(0, 2);
  const letters = visible.map((part) => part[0]?.toUpperCase() ?? '').join('');
  return letters || source[0]!.toUpperCase();
}

/** Детерминированный цвет аватара по id — без внешних ассетов. */
export function avatarHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }
  return hash;
}

export function avatarStyle(seed: string): { background: string } {
  const hue = avatarHue(seed);
  return {
    background: `linear-gradient(135deg, hsl(${hue} 62% 42%), hsl(${(hue + 38) % 360} 58% 30%))`,
  };
}

/** Второй участник direct-диалога (сам пользователь исключается). */
export function directPeer(view: ConversationView, myUserId: UUID | null): User | null {
  const others = view.members.filter((member) => member.id !== myUserId);
  return others[0] ?? view.members[0] ?? null;
}

export function conversationTitle(view: ConversationView, myUserId: UUID | null): string {
  if (view.conversation.title) return view.conversation.title;
  const peer = directPeer(view, myUserId);
  return peer?.display_name ?? 'Диалог';
}

export function isGroupConversation(view: ConversationView): boolean {
  return view.conversation.kind === 'group';
}

export function callKindLabel(kind: CallKind): string {
  return kind === 'video' ? 'Видеозвонок' : 'Аудиозвонок';
}

export type CallHistoryOutcome = 'missed' | 'rejected' | 'canceled' | 'failed' | 'ended' | 'ongoing';

export function callOutcome(call: Call): CallHistoryOutcome {
  switch (call.status) {
    case 'missed':
      return 'missed';
    case 'rejected':
      return 'rejected';
    case 'canceled':
      return 'canceled';
    case 'failed':
      return 'failed';
    case 'ended':
      return 'ended';
    default:
      return 'ongoing';
  }
}

export function callOutcomeLabel(outcome: CallHistoryOutcome): string {
  switch (outcome) {
    case 'missed':
      return 'Пропущен';
    case 'rejected':
      return 'Отклонён';
    case 'canceled':
      return 'Отменён';
    case 'failed':
      return 'Не удался';
    case 'ended':
      return 'Завершён';
    default:
      return 'Идёт';
  }
}

/** Компактная подпись превью последнего сообщения. */
export function messagePreview(body: string | null | undefined, maxLength = 80): string {
  const source = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  return source.length > maxLength ? `${source.slice(0, maxLength - 1)}…` : source;
}

export function pluralize(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
