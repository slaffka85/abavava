import { memo } from 'react';
import { Avatar } from '../Avatar';
import { formatTime } from '../../lib/format';
import type { ChatMessage } from '../../store/chat';
import { IconAlert, IconCheck, IconCheckDouble, IconClock } from '../Icons';

interface MessageBubbleProps {
  message: ChatMessage;
  isMine: boolean;
  showAuthor: boolean;
  authorName: string;
  readByPeer: boolean;
  onRetry: (messageId: string) => void;
}

function DeliveryStatus({ message, readByPeer }: { message: ChatMessage; readByPeer: boolean }) {
  if (message.status === 'pending') {
    return (
      <span className="msg__status" title="Отправляется">
        <IconClock size={14} />
      </span>
    );
  }
  if (message.status === 'failed') {
    return (
      <span className="msg__status msg__status--failed" title="Не отправлено">
        <IconAlert size={14} />
      </span>
    );
  }
  return (
    <span className={`msg__status${readByPeer ? ' msg__status--read' : ''}`} title={readByPeer ? 'Прочитано' : 'Доставлено'}>
      {readByPeer ? <IconCheckDouble size={15} /> : <IconCheck size={14} />}
    </span>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isMine,
  showAuthor,
  authorName,
  readByPeer,
  onRetry,
}: MessageBubbleProps) {
  // Системные сообщения и записи о звонках показываем по центру.
  if (message.kind === 'system' || message.kind === 'call') {
    return (
      <div className="msg-system">
        <span>{message.body}</span>
      </div>
    );
  }

  return (
    <div className={`msg${isMine ? ' msg--mine' : ' msg--theirs'}${showAuthor ? ' msg--start' : ''}`}>
      <div className="msg__gutter">
        {!isMine && showAuthor ? <Avatar id={message.sender_id} name={authorName} size={32} /> : null}
      </div>

      <div className="msg__column">
        {!isMine && showAuthor ? <span className="msg__author">{authorName}</span> : null}
        <div className={`msg__bubble${message.status === 'failed' ? ' msg__bubble--failed' : ''}`}>
          {message.body}
        </div>
        <div className="msg__meta">
          <span className="msg__time">{formatTime(message.created_at)}</span>
          {isMine ? <DeliveryStatus message={message} readByPeer={readByPeer} /> : null}
          {isMine && message.status === 'failed' ? (
            <button type="button" className="msg__retry" onClick={() => onRetry(message.id)}>
              Повторить
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
});
