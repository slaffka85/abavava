import { Avatar } from '../Avatar';
import { api, humanizeApiError } from '../../lib/api';
import type { ConversationView, UUID } from '../../lib/types';
import { useChatStore } from '../../store/chat';
import { toast } from '../../store/toast';
import { IconClose, IconPhone, IconVideo } from '../Icons';

interface GroupMembersPanelProps {
  view: ConversationView;
  myUserId: UUID;
  onClose: () => void;
  onCall: (peerId: UUID, kind: 'audio' | 'video') => void;
}

/** Участники группы: владелец может удалять, участник — выйти. */
export function GroupMembersPanel({ view, myUserId, onClose, onCall }: GroupMembersPanelProps) {
  const conversationId = view.conversation.id;
  const isOwner = view.conversation.created_by === myUserId;

  const removeMember = async (userId: UUID): Promise<void> => {
    try {
      await api.conversations.removeMember(conversationId, userId);
      const chat = useChatStore.getState();
      if (userId === myUserId) {
        chat.removeConversation(conversationId);
        onClose();
        return;
      }
      await chat.refreshConversation(conversationId);
    } catch (error) {
      toast.error('Не удалось изменить состав участников', humanizeApiError(error));
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Участники">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__panel modal__panel--narrow">
        <header className="modal__head">
          <h2 className="modal__title">Участники</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>

        <div className="modal__body">
          {view.members.map((member) => (
            <div key={member.id} className="member-row">
              <Avatar id={member.id} name={member.display_name} size={36} />
              <div className="member-row__text">
                <span className="member-row__name">
                  {member.display_name}
                  {member.id === myUserId ? ' — это вы' : ''}
                </span>
                <span className="member-row__email">{member.email}</span>
              </div>
              {member.id !== myUserId ? (
                <>
                  <button
                    type="button"
                    className="icon-btn icon-btn--tiny"
                    title="Аудиозвонок"
                    aria-label="Аудиозвонок"
                    onClick={() => onCall(member.id, 'audio')}
                  >
                    <IconPhone size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--tiny"
                    title="Видеозвонок"
                    aria-label="Видеозвонок"
                    onClick={() => onCall(member.id, 'video')}
                  >
                    <IconVideo size={17} />
                  </button>
                </>
              ) : null}
              {isOwner || member.id === myUserId ? (
                <button
                  type="button"
                  className="btn btn--danger-ghost btn--tiny"
                  onClick={() => void removeMember(member.id)}
                >
                  {member.id === myUserId ? 'Выйти' : 'Удалить'}
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <footer className="modal__foot">
          <p className="muted">Позвонить можно только один на один — выберите участника.</p>
        </footer>
      </div>
    </div>
  );
}
