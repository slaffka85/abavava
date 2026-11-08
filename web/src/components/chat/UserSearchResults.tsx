import { Avatar } from '../Avatar';
import { api, humanizeApiError } from '../../lib/api';
import type { User } from '../../lib/types';
import { useChatStore } from '../../store/chat';
import { toast } from '../../store/toast';
import { IconSpinner } from '../Icons';

interface UserSearchResultsProps {
  results: User[];
  loading: boolean;
  error: string | null;
  /** Успешно открыли/создали диалог — можно очистить поиск. */
  onOpened: () => void;
}

/** Открывает (создаёт идемпотентно) direct-диалог с найденным пользователем. */
export async function openDirectConversation(peer: User, onOpened: () => void): Promise<void> {
  try {
    const view = await api.conversations.createDirect(peer.id);
    const chat = useChatStore.getState();
    chat.upsertConversation(view);
    chat.setActiveConversation(view.conversation.id);
    onOpened();
  } catch (error) {
    toast.error('Не удалось открыть диалог', humanizeApiError(error));
  }
}

export function UserSearchResults({ results, loading, error, onOpened }: UserSearchResultsProps) {
  if (error) {
    return (
      <div className="sidebar__placeholder sidebar__placeholder--error">
        <p>{error}</p>
      </div>
    );
  }

  if (loading && results.length === 0) {
    return (
      <div className="sidebar__placeholder">
        <IconSpinner size={20} />
        <p>Ищем…</p>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="sidebar__placeholder">
        <p>Никого не нашли</p>
        <p className="muted">Попробуйте другое имя или email</p>
      </div>
    );
  }

  return (
    <div className="conv-list">
      {results.map((user) => (
        <button
          key={user.id}
          type="button"
          className="conv conv--user"
          onClick={() => void openDirectConversation(user, onOpened)}
        >
          <Avatar id={user.id} name={user.display_name} />
          <span className="conv__main">
            <span className="conv__row">
              <span className="conv__title">{user.display_name}</span>
            </span>
            <span className="conv__row">
              <span className="conv__preview">{user.email}</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
