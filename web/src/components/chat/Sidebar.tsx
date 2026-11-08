import { useState } from 'react';
import { Avatar } from '../Avatar';
import type { UUID } from '../../lib/types';
import { logoutSession } from '../../app/session';
import { useAuthStore } from '../../store/auth';
import { useUserSearch } from '../../hooks/useUserSearch';
import { WsIndicator } from '../ConnectionBanner';
import { IconClose, IconHistory, IconLogout, IconPlus, IconSearch } from '../Icons';
import { ConversationList } from './ConversationList';
import { UserSearchResults } from './UserSearchResults';

interface SidebarProps {
  myUserId: UUID;
  onSelectConversation: (conversationId: UUID) => void;
  onOpenCallHistory: () => void;
  onOpenNewChat: () => void;
}

export function Sidebar({ myUserId, onSelectConversation, onOpenCallHistory, onOpenNewChat }: SidebarProps) {
  const user = useAuthStore((state) => state.user);
  const [query, setQuery] = useState('');
  const { results, loading, error } = useUserSearch(query);
  const searching = query.trim().length > 0;

  return (
    <aside className="sidebar">
      <header className="sidebar__profile">
        <Avatar id={myUserId} name={user?.display_name ?? 'Я'} size={38} />
        <div className="sidebar__profile-text">
          <span className="sidebar__name">{user?.display_name ?? ''}</span>
          <WsIndicator />
        </div>
        <button
          type="button"
          className="icon-btn"
          title="Выйти"
          aria-label="Выйти"
          onClick={() => void logoutSession()}
        >
          <IconLogout size={18} />
        </button>
      </header>

      <div className="sidebar__search">
        <span className="sidebar__search-icon">
          <IconSearch size={17} />
        </span>
        <input
          className="sidebar__search-input"
          type="search"
          value={query}
          placeholder="Поиск пользователей"
          aria-label="Поиск пользователей"
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching ? (
          <button type="button" className="icon-btn icon-btn--tiny" aria-label="Очистить" onClick={() => setQuery('')}>
            <IconClose size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn icon-btn--accent"
          title="Новый чат"
          aria-label="Новый чат"
          onClick={onOpenNewChat}
        >
          <IconPlus size={18} />
        </button>
      </div>

      <div className="sidebar__body">
        {searching ? (
          <UserSearchResults
            results={results}
            loading={loading}
            error={error}
            onOpened={() => setQuery('')}
          />
        ) : (
          <ConversationList myUserId={myUserId} onSelect={onSelectConversation} />
        )}
      </div>

      <footer className="sidebar__footer">
        <button type="button" className="btn btn--ghost btn--block" onClick={onOpenCallHistory}>
          <IconHistory size={17} />
          История звонков
        </button>
      </footer>
    </aside>
  );
}
