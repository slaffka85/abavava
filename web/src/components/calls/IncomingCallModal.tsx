import { useEffect } from 'react';
import { Avatar } from '../Avatar';
import { callKindLabel } from '../../lib/format';
import { ringtone } from '../../lib/ringtone';
import { useCallStore } from '../../store/call';
import { IconPhone, IconPhoneOff, IconVideo } from '../Icons';

/** Входящий звонок: имя, тип, принять/отклонить. */
export function IncomingCallModal() {
  const phase = useCallStore((state) => state.phase);
  const call = useCallStore((state) => state.call);
  const acceptIncoming = useCallStore((state) => state.acceptIncoming);
  const rejectIncoming = useCallStore((state) => state.rejectIncoming);

  // Страховка: если модалку убрали другим путём — рингтон не должен остаться играть.
  useEffect(() => () => ringtone.stop(), []);

  if (phase !== 'incoming' || !call) return null;

  const peer = call.peer;
  const isVideo = call.kind === 'video';

  return (
    <div className="call-modal" role="dialog" aria-modal="true" aria-label="Входящий звонок">
      <div className="call-modal__card">
        <p className="call-modal__kind">
          {isVideo ? <IconVideo size={16} /> : <IconPhone size={16} />}
          {callKindLabel(call.kind)}
        </p>

        <Avatar id={peer?.id ?? call.id} name={peer?.display_name ?? 'Собеседник'} size={92} />
        <h2 className="call-modal__name">{peer?.display_name ?? 'Собеседник'}</h2>
        <p className="call-modal__hint">Входящий звонок</p>

        <div className="call-modal__actions">
          <button type="button" className="call-btn call-btn--reject" onClick={rejectIncoming}>
            <IconPhoneOff size={24} />
            <span>Отклонить</span>
          </button>
          <button type="button" className="call-btn call-btn--accept" onClick={() => void acceptIncoming()}>
            <IconPhone size={24} />
            <span>Принять</span>
          </button>
        </div>
      </div>
    </div>
  );
}
