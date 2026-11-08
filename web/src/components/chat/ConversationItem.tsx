import { memo } from 'react';
import { Avatar } from '../Avatar';
import type { ConversationView, UUID } from '../../lib/types';
import {
  conversationTitle,
  directPeer,
  formatListTimestamp,
  messagePreview,
} from '../../lib/format';
import { useChatStore } from '../../store/chat';

interface ConversationItemProps {
  view: ConversationView;
  myUserId: UUID;
  active: boolean;
  onSelect: (conversationId: UUID) => void;
}

export const ConversationItem = memo(function ConversationItem({
  view,
  myUserId,
  active,
  onSelect,
}: ConversationItemProps) {
  const conversationId = view.conversation.id;
  const peer = directPeer(view, myUserId);
  const title = conversationTitle(view, myUserId);
  const isGroup = view.conversation.kind === 'group';
  const online = useChatStore((state) => (peer ? state.presence[peer.id]?.status === 'online' : false));
  const typingUsers = useChatStore((state) => state.typing[conversationId]);

  const someoneTyping = Object.keys(typingUsers ?? {}).length > 0;
  const lastMessage = view.last_message;

  let preview: string;
  if (someoneTyping) {
    preview = 'печатает…';
  } else if (!lastMessage) {
    preview = 'Нет сообщений';
  } else if (lastMessage.kind === 'call') {
    preview = 'Звонок';
  } else {
    const author = lastMessage.sender_id === myUserId ? 'Вы' : isGroup
      ? view.members.find((member) => member.id === lastMessage.sender_id)?.display_name ?? 'Участник'
      : '';
    preview = author ? `${author}: ${messagePreview(lastMessage.body)}` : messagePreview(lastMessage.body);
  }

  const unread = view.unread_count;

  return (
    <button
      type="button"
      className={`conv${active ? ' conv--active' : ''}${unread > 0 ? ' conv--unread' : ''}`}
      onClick={() => onSelect(conversationId)}
    >
      <Avatar id={peer?.id ?? conversationId} name={title} online={isGroup ? undefined : online} />
      <span className="conv__main">
        <span className="conv__row">
          <span className="conv__title">{title}</span>
          <span className="conv__time">
            {formatListTimestamp(lastMessage?.created_at ?? view.conversation.last_message_at)}
          </span>
        </span>
        <span className="conv__row">
          <span className={`conv__preview${someoneTyping ? ' conv__preview--typing' : ''}`}>{preview}</span>
          {unread > 0 ? <span className="conv__badge">{unread > 99 ? '99+' : unread}</span> : null}
        </span>
      </span>
    </button>
  );
});
