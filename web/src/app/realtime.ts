/** Роутинг WS-событий в сторы. Никакого React — только подписки. */
import { wsClient } from '../lib/ws';
import type { WsStatus } from '../lib/ws';
import { useAuthStore } from '../store/auth';
import { useCallStore } from '../store/call';
import { useChatStore } from '../store/chat';
import { toast } from '../store/toast';

let started = false;
let unsubscribers: Array<() => void> = [];
const statusListeners = new Set<(status: WsStatus) => void>();

function myUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

/** После реконнекта пропущенные события не «догоняются» — перезагружаем состояние. */
async function resyncAll(): Promise<void> {
  const chat = useChatStore.getState();
  const activeId = chat.activeConversationId;

  await Promise.allSettled([
    chat.loadConversations(),
    activeId ? chat.refreshConversation(activeId) : Promise.resolve(),
    activeId ? chat.loadMessages(activeId) : Promise.resolve(),
    useCallStore.getState().resyncActiveCall(),
  ]);
}

function handleWsError(code: string, message: string): void {
  switch (code) {
    case 'rate_limited':
      toast.error('Слишком много запросов', message || 'Попробуйте немного позже');
      break;
    case 'validation_failed':
      toast.error('Сервер отклонил данные', message);
      break;
    case 'forbidden':
      toast.error('Нет доступа', message);
      break;
    case 'internal':
      toast.error('Ошибка на сервере', message);
      break;
    default:
      // unsupported_type / malformed_frame — обычно следствие бага в клиенте.
      console.warn('[ws] error', code, message);
      break;
  }
}

export function subscribeWsStatus(listener: (status: WsStatus) => void): () => void {
  statusListeners.add(listener);
  listener(wsClient.getStatus());
  return () => {
    statusListeners.delete(listener);
  };
}

export function startRealtime(): void {
  if (started) return;
  started = true;

  unsubscribers = [
    wsClient.on('message.new', ({ message }) => {
      useChatStore.getState().receiveMessage(message);
    }),

    wsClient.on('message.read', ({ conversation_id, user_id, read_at }) => {
      if (user_id === myUserId()) return;
      useChatStore.getState().applyPeerRead(conversation_id, read_at);
    }),

    wsClient.on('typing', ({ conversation_id, user_id, state }) => {
      if (user_id === myUserId()) return;
      useChatStore.getState().applyTyping(conversation_id, user_id, state);
    }),

    wsClient.on('presence', (presence) => {
      useChatStore.getState().applyPresence(presence);
    }),

    wsClient.on('call.created', ({ call }) => {
      useCallStore.getState().handleCallCreated(call);
    }),

    wsClient.on('call.incoming', ({ call }) => {
      useCallStore.getState().handleCallIncoming(call);
    }),

    wsClient.on('call.updated', ({ call }) => {
      useCallStore.getState().handleCallUpdated(call);
    }),

    wsClient.on('call.signal', ({ call_id, payload }) => {
      useCallStore.getState().handleCallSignal(call_id, payload);
    }),

    wsClient.on('error', (data) => {
      handleWsError(data.code, data.message);
    }),

    wsClient.onTransportError((error) => {
      toast.error('Связь с сервером', error.message);
    }),

    wsClient.onResync(() => {
      void resyncAll();
    }),

    wsClient.onStatus((status) => {
      for (const listener of [...statusListeners]) listener(status);
    }),
  ];
}

export function stopRealtime(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  started = false;
  wsClient.disconnect();
}
