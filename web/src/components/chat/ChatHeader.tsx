import { Avatar } from '../Avatar';
import type { ConversationView, UUID } from '../../lib/types';
import { conversationTitle, directPeer, formatListTimestamp, pluralize } from '../../lib/format';
import { useChatStore } from '../../store/chat';
import { IconArrowLeft, IconPhone, IconUsers, IconVideo } from '../Icons';

interface ChatHeaderProps {
  view: ConversationView;
  myUserId: UUID;
  onBack: () => void;
  onToggleMembers: () => void;
  onCall: (kind: 'audio' | 'video') => void;
}

export function ChatHeader({ view, myUserId, onBack, onToggleMembers, onCall }: ChatHeaderProps) {
  const conversationId = view.conversation.id;
  const isGroup = view.conversation.kind === 'group';
  const peer = directPeer(view, myUserId);
  const title = conversationTitle(view, myUserId);

  const online = useChatStore((state) => (peer ? state.presence[peer.id]?.status === 'online' : false));
  const typingUsers = useChatStore((state) => state.typing[conversationId]);

  let subtitle: string;
  if (Object.keys(typingUsers ?? {}).length > 0) {
    subtitle = 'печатает…';
  } else if (isGroup) {
    const count = view.members.length;
    subtitle = `${count} ${pluralize(count, 'участник', 'участника', 'участников')}`;
  } else if (online) {
    subtitle = 'в сети';
  } else if (peer?.last_seen_at) {
    subtitle = `был(а) ${formatListTimestamp(peer.last_seen_at)}`;
  } else {
    subtitle = 'не в сети';
  }

  return (
    <header className="chat-head">
      <button type="button" className="icon-btn chat-head__back" aria-label="К списку" onClick={onBack}>
        <IconArrowLeft size={20} />
      </button>

      <Avatar id={peer?.id ?? conversationId} name={title} size={40} online={isGroup ? undefined : online} />

      <div className="chat-head__text">
        <span className="chat-head__title">{title}</span>
        <span className={`chat-head__subtitle${subtitle === 'печатает…' ? ' chat-head__subtitle--typing' : ''}`}>
          {subtitle}
        </span>
      </div>

      <div className="chat-head__actions">
        {isGroup ? (
          <button type="button" className="icon-btn" title="Участники" aria-label="Участники" onClick={onToggleMembers}>
            <IconUsers size={20} />
          </button>
        ) : (
          <>
            <button
              type="button"
              className="icon-btn"
              title="Аудиозвонок"
              aria-label="Аудиозвонок"
              onClick={() => onCall('audio')}
            >
              <IconPhone size={19} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Видеозвонок"
              aria-label="Видеозвонок"
              onClick={() => onCall('video')}
            >
              <IconVideo size={20} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
