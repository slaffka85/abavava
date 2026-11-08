import { useEffect, useState } from 'react';
import { Avatar } from '../Avatar';
import { api, humanizeApiError } from '../../lib/api';
import type { User } from '../../lib/types';
import { useUserSearch } from '../../hooks/useUserSearch';
import { useChatStore } from '../../store/chat';
import { toast } from '../../store/toast';
import { IconCheck, IconClose, IconSearch, IconSpinner } from '../Icons';

interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
}

/** «Новый чат»: 1 участник → direct-диалог, 2+ → группа с названием. */
export function NewChatModal({ open, onClose }: NewChatModalProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<User[]>([]);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { results, loading, error } = useUserSearch(query);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected([]);
      setTitle('');
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isGroup = selected.length > 1;

  const toggle = (user: User): void => {
    setSelected((current) =>
      current.some((item) => item.id === user.id)
        ? current.filter((item) => item.id !== user.id)
        : [...current, user],
    );
  };

  const submit = async (): Promise<void> => {
    if (selected.length === 0) return;
    setSubmitting(true);
    try {
      const chat = useChatStore.getState();
      if (isGroup) {
        const groupTitle = title.trim() || selected.map((user) => user.display_name).join(', ');
        const view = await api.conversations.createGroup(
          groupTitle,
          selected.map((user) => user.id),
        );
        chat.upsertConversation(view);
        chat.setActiveConversation(view.conversation.id);
      } else {
        const peer = selected[0]!;
        const view = await api.conversations.createDirect(peer.id);
        chat.upsertConversation(view);
        chat.setActiveConversation(view.conversation.id);
      }
      onClose();
    } catch (cause) {
      toast.error('Не удалось создать диалог', humanizeApiError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Новый чат">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">Новый чат</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>

        {selected.length > 0 ? (
          <div className="chips">
            {selected.map((user) => (
              <button key={user.id} type="button" className="chip" onClick={() => toggle(user)}>
                {user.display_name}
                <IconClose size={13} />
              </button>
            ))}
          </div>
        ) : null}

        {isGroup ? (
          <label className="field field--compact">
            <span className="field__label">Название группы</span>
            <input
              className="field__input"
              type="text"
              value={title}
              placeholder="Например, Команда"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        ) : null}

        <div className="sidebar__search sidebar__search--modal">
          <span className="sidebar__search-icon">
            <IconSearch size={17} />
          </span>
          <input
            className="sidebar__search-input"
            type="search"
            value={query}
            autoFocus
            placeholder="Имя или email"
            aria-label="Поиск пользователей"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="modal__body">
          {error ? <p className="modal__error">{error}</p> : null}
          {loading && results.length === 0 ? (
            <div className="sidebar__placeholder">
              <IconSpinner size={20} />
              <p>Ищем…</p>
            </div>
          ) : null}
          {!loading && query.trim() && results.length === 0 && !error ? (
            <div className="sidebar__placeholder">
              <p>Никого не нашли</p>
            </div>
          ) : null}
          {results.map((user) => {
            const isSelected = selected.some((item) => item.id === user.id);
            return (
              <button
                key={user.id}
                type="button"
                className={`conv conv--user${isSelected ? ' conv--selected' : ''}`}
                onClick={() => toggle(user)}
              >
                <Avatar id={user.id} name={user.display_name} size={38} />
                <span className="conv__main">
                  <span className="conv__row">
                    <span className="conv__title">{user.display_name}</span>
                  </span>
                  <span className="conv__row">
                    <span className="conv__preview">{user.email}</span>
                  </span>
                </span>
                {isSelected ? (
                  <span className="conv__check">
                    <IconCheck size={16} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <footer className="modal__foot">
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={selected.length === 0 || submitting}
            onClick={() => void submit()}
          >
            {submitting ? <IconSpinner size={17} /> : null}
            {isGroup ? `Создать группу (${selected.length})` : 'Открыть диалог'}
          </button>
        </footer>
      </div>
    </div>
  );
}
