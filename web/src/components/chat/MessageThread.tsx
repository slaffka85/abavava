import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { User, UUID } from '../../lib/types';
import { formatDayLabel, isSameDay } from '../../lib/format';
import { isReadByPeer, useChatStore } from '../../store/chat';
import type { ChatMessage } from '../../store/chat';
import { IconArrowDown, IconSpinner } from '../Icons';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

const EMPTY: ChatMessage[] = [];
/** Разрыв во времени, после которого начинаем «новую группу» сообщений. */
const GROUP_GAP_MS = 5 * 60 * 1000;
const BOTTOM_THRESHOLD_PX = 80;
const LOAD_OLDER_THRESHOLD_PX = 140;

type RenderItem =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'message';
      key: string;
      message: ChatMessage;
      isMine: boolean;
      showAuthor: boolean;
      authorName: string;
    };

/** Разбивка на дни + склейка подряд идущих сообщений одного автора. */
function buildItems(messages: ChatMessage[], members: User[], myUserId: UUID): RenderItem[] {
  const items: RenderItem[] = [];
  let previous: ChatMessage | null = null;
  let previousDay: Date | null = null;

  for (const message of messages) {
    const date = new Date(message.created_at);
    const dayChanged = !previousDay || !isSameDay(previousDay, date);

    if (dayChanged) {
      items.push({
        kind: 'day',
        key: `day-${message.created_at}-${message.id}`,
        label: formatDayLabel(message.created_at),
      });
      previousDay = date;
    }

    const isMine = message.sender_id === myUserId;
    const author = members.find((member) => member.id === message.sender_id);
    const gap = previous ? date.getTime() - new Date(previous.created_at).getTime() : Number.POSITIVE_INFINITY;
    const showAuthor =
      !isMine && (dayChanged || !previous || previous.sender_id !== message.sender_id || gap > GROUP_GAP_MS);

    items.push({
      kind: 'message',
      key: message.id,
      message,
      isMine,
      showAuthor,
      authorName: author?.display_name ?? 'Неизвестный',
    });
    previous = message;
  }

  return items;
}

interface MessageThreadProps {
  conversationId: UUID;
  members: User[];
  myUserId: UUID;
}

export function MessageThread({ conversationId, members, myUserId }: MessageThreadProps) {
  const messages = useChatStore((state) => state.messages.get(conversationId) ?? EMPTY);
  const loadingMessages = useChatStore((state) => state.loadingMessages[conversationId] ?? false);
  const loadingOlder = useChatStore((state) => state.loadingOlder[conversationId] ?? false);
  const hasMore = useChatStore((state) => state.hasMore[conversationId] ?? false);
  const peerReadAt = useChatStore((state) => state.peerReadAt[conversationId]);
  const typing = useChatStore((state) => state.typing[conversationId]);
  const retryMessage = useChatStore((state) => state.retryMessage);
  const markRead = useChatStore((state) => state.markRead);
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);

  const containerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lastMessageIdRef = useRef<string | null>(null);
  /** Якорь для сохранения позиции при подгрузке истории. */
  const anchorRef = useRef<{ count: number; scrollHeight: number } | null>(null);

  const someoneTyping = Object.keys(typing ?? {}).length > 0;

  const items = useMemo(() => buildItems(messages, members, myUserId), [messages, members, myUserId]);

  const scrollToBottom = (behavior: ScrollBehavior): void => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  };

  // Автопрокрутка вниз при новых сообщениях, если пользователь не отлистал вверх.
  useEffect(() => {
    const last = messages.length > 0 ? messages[messages.length - 1]! : null;
    const lastId = last?.id ?? null;
    const changed = lastId !== lastMessageIdRef.current;
    const isFirst = lastMessageIdRef.current === null;
    lastMessageIdRef.current = lastId;
    if (!changed) return;
    if (isFirst || atBottom) {
      const behavior: ScrollBehavior = isFirst ? 'auto' : 'smooth';
      requestAnimationFrame(() => scrollToBottom(behavior));
    }
  }, [messages, atBottom]);

  // Подгрузка истории вверх: сохраняем позицию скролла по «якорю».
  useLayoutEffect(() => {
    const element = containerRef.current;
    const anchor = anchorRef.current;
    if (!element || !anchor) return;
    if (messages.length <= anchor.count) return;
    anchorRef.current = null;
    const delta = element.scrollHeight - anchor.scrollHeight;
    if (delta > 0) element.scrollTop += delta;
  }, [messages]);

  // Отметка прочтения, когда последнее сообщение видно (мы внизу).
  useEffect(() => {
    if (!atBottom) return;
    const last = messages.length > 0 ? messages[messages.length - 1]! : null;
    if (!last) return;
    if (last.sender_id === myUserId) return;
    if (last.id.startsWith('local:')) return;
    markRead(conversationId, last.id);
  }, [messages, atBottom, myUserId, conversationId, markRead]);

  const handleScroll = (): void => {
    const element = containerRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance < BOTTOM_THRESHOLD_PX);

    if (element.scrollTop < LOAD_OLDER_THRESHOLD_PX && hasMore && !loadingOlder && messages.length > 0) {
      anchorRef.current = { count: messages.length, scrollHeight: element.scrollHeight };
      void loadOlderMessages(conversationId);
    }
  };

  return (
    <div className="thread-wrap">
      <div className="thread" ref={containerRef} onScroll={handleScroll}>
        {loadingOlder ? (
          <div className="thread__loading">
            <IconSpinner size={18} />
          </div>
        ) : null}

        {loadingMessages && messages.length === 0 ? (
          <div className="thread__empty">
            <IconSpinner size={22} />
            <p>Загружаем сообщения…</p>
          </div>
        ) : null}

        {!loadingMessages && messages.length === 0 ? (
          <div className="thread__empty">
            <p>Здесь пока пусто</p>
            <p className="muted">Напишите первое сообщение</p>
          </div>
        ) : null}

        {items.map((item) =>
          item.kind === 'day' ? (
            <div key={item.key} className="thread__day">
              <span>{item.label}</span>
            </div>
          ) : (
            <MessageBubble
              key={item.key}
              message={item.message}
              isMine={item.isMine}
              showAuthor={item.showAuthor}
              authorName={item.authorName}
              readByPeer={item.isMine && isReadByPeer(peerReadAt, item.message.created_at)}
              onRetry={(messageId) => void retryMessage(conversationId, messageId)}
            />
          ),
        )}

        {someoneTyping ? <TypingIndicator /> : null}
      </div>

      {!atBottom ? (
        <button
          type="button"
          className="thread__to-bottom"
          aria-label="Вниз"
          onClick={() => {
            setAtBottom(true);
            scrollToBottom('smooth');
          }}
        >
          <IconArrowDown size={18} />
        </button>
      ) : null}
    </div>
  );
}
