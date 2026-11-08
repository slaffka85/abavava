import type { UUID } from '../../lib/types';
import { useChatStore } from '../../store/chat';
import { IconSpinner } from '../Icons';
import { ConversationItem } from './ConversationItem';

interface ConversationListProps {
  myUserId: UUID;
  onSelect: (conversationId: UUID) => void;
}

export function ConversationList({ myUserId, onSelect }: ConversationListProps) {
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeConversationId);
  const loading = useChatStore((state) => state.conversationsLoading);
  const error = useChatStore((state) => state.conversationsError);

  if (loading && conversations.length === 0) {
    return (
      <div className="sidebar__placeholder">
        <IconSpinner size={22} />
        <p>Загружаем диалоги…</p>
      </div>
    );
  }

  if (error && conversations.length === 0) {
    return (
      <div className="sidebar__placeholder sidebar__placeholder--error">
        <p>{error}</p>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="sidebar__placeholder">
        <p>Пока нет диалогов</p>
        <p className="muted">Найдите собеседника через поиск сверху</p>
      </div>
    );
  }

  return (
    <div className="conv-list">
      {conversations.map((view) => (
        <ConversationItem
          key={view.conversation.id}
          view={view}
          myUserId={myUserId}
          active={view.conversation.id === activeId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
