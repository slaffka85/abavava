import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../Avatar';
import { api, humanizeApiError } from '../../lib/api';
import type { Call, CallKind } from '../../lib/types';
import { callKindLabel, callOutcome, callOutcomeLabel, formatDateTime, formatDurationHuman } from '../../lib/format';
import { useAuthStore } from '../../store/auth';
import { useCallStore } from '../../store/call';
import { useChatStore } from '../../store/chat';
import { toast } from '../../store/toast';
import {
  IconClose,
  IconPhone,
  IconPhoneIncoming,
  IconPhoneOutgoing,
  IconSpinner,
  IconVideo,
} from '../Icons';

interface CallHistoryPanelProps {
  open: boolean;
  onClose: () => void;
}

/** История звонков: статус, длительность, кто звонил, перезвонить. */
export function CallHistoryPanel({ open, onClose }: CallHistoryPanelProps) {
  const myUserId = useAuthStore((state) => state.user?.id ?? null);
  const startCall = useCallStore((state) => state.startCall);
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.calls.list(50);
      setCalls(response.items);
    } catch (cause) {
      setError(humanizeApiError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const redial = async (call: Call, kind: CallKind): Promise<void> => {
    const peer = call.peer;
    if (!peer) return;
    // Открываем диалог, чтобы звонок был в контексте переписки.
    try {
      const view = await api.conversations.createDirect(peer.id);
      useChatStore.getState().upsertConversation(view);
      useChatStore.getState().setActiveConversation(view.conversation.id);
      await startCall(peer, kind, view.conversation.id);
    } catch (cause) {
      toast.error('Не удалось позвонить', humanizeApiError(cause));
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="История звонков">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 className="modal__title">История звонков</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>

        <div className="modal__body">
          {loading && calls.length === 0 ? (
            <div className="sidebar__placeholder">
              <IconSpinner size={20} />
              <p>Загружаем…</p>
            </div>
          ) : null}

          {error ? <p className="modal__error">{error}</p> : null}

          {!loading && !error && calls.length === 0 ? (
            <div className="sidebar__placeholder">
              <p>Звонков пока не было</p>
            </div>
          ) : null}

          {calls.map((call) => {
            const outgoing = call.caller_id === myUserId;
            const outcome = callOutcome(call);
            const peerName = call.peer?.display_name ?? 'Неизвестный';
            return (
              <div key={call.id} className={`call-row call-row--${outcome}`}>
                <Avatar id={call.peer?.id ?? call.id} name={peerName} size={38} />
                <div className="call-row__text">
                  <span className="call-row__name">
                    <span className={`call-row__dir call-row__dir--${outgoing ? 'out' : 'in'}`}>
                      {outgoing ? <IconPhoneOutgoing size={14} /> : <IconPhoneIncoming size={14} />}
                    </span>
                    {peerName}
                    <span className="call-row__kind" title={callKindLabel(call.kind)}>
                      {call.kind === 'video' ? <IconVideo size={14} /> : <IconPhone size={14} />}
                    </span>
                  </span>
                  <span className={`call-row__status call-row__status--${outcome}`}>
                    {callOutcomeLabel(outcome)}
                    {call.status === 'ended' && call.duration_seconds > 0
                      ? ` · ${formatDurationHuman(call.duration_seconds)}`
                      : ''}
                  </span>
                </div>
                <div className="call-row__meta">
                  <span className="call-row__time">{formatDateTime(call.created_at)}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--tiny"
                    onClick={() => void redial(call, call.kind)}
                  >
                    Перезвонить
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
