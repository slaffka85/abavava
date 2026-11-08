/**
 * Состояние переписки: диалоги, сообщения по диалогам (Map), unread, typing,
 * presence, оптимистичная отправка.
 */
import { create } from 'zustand';
import { api, humanizeApiError } from '../lib/api';
import type { ConversationView, Message, TypingState, UUID, WsPresence } from '../lib/types';
import { WsError, wsClient } from '../lib/ws';
import { toast } from './toast';

export type MessageStatus = 'pending' | 'sent' | 'failed';
/** Сообщение из API + локальный статус доставки. */
export type ChatMessage = Message & { status: MessageStatus };

export type PresenceState = 'online' | 'offline';
export interface PresenceInfo {
  status: PresenceState;
  last_seen_at: string | null;
}

const PAGE_SIZE = 50;
/** Через сколько «печатает…» гаснет, если новых событий нет. */
const TYPING_TTL_MS = 4_000;
/** Не чаще одного typing.start в 2 секунды. */
const TYPING_THROTTLE_MS = 2_000;
/** Через сколько после последнего ввода отправляем typing.stop. */
const TYPING_STOP_IDLE_MS = 4_000;

const EMPTY_MESSAGES: ChatMessage[] = [];

/* Таймеры живут вне состояния: они не должны вызывать ре-рендер. */
const typingExpiryTimers = new Map<string, number>();
const localTypingStopTimers = new Map<string, number>();
const localTypingLastSentAt = new Map<string, number>();
const lastReadSent = new Map<string, UUID>();

function makeClientId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function timeOf(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Сортировка по created_at, затем по id (порядок между устройствами не гарантирован). */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const delta = timeOf(a.created_at) - timeOf(b.created_at);
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort(compareMessages);
}

function isOptimistic(message: ChatMessage): boolean {
  return message.id.startsWith('local:');
}

function toChatMessage(message: Message): ChatMessage {
  return { ...message, status: 'sent' };
}

/** Слияние с дедупликацией по id и client_id. Изменяет переданный массив (копию). */
function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const byClientId = new Map<string, ChatMessage>();

  for (const message of current) {
    byId.set(message.id, message);
    if (message.client_id) byClientId.set(message.client_id, message);
  }

  for (const message of incoming) {
    if (byId.has(message.id)) continue;

    if (message.client_id) {
      const optimistic = byClientId.get(message.client_id);
      if (optimistic && isOptimistic(optimistic)) {
        // Оптимистичное сообщение заменяем серверным (id, created_at — серверные).
        const index = current.findIndex((item) => item.id === optimistic.id);
        if (index >= 0) current[index] = { ...message, status: 'sent' };
        byId.set(message.id, message);
        byClientId.set(message.client_id, message);
        continue;
      }
      byClientId.set(message.client_id, message);
    }

    current.push(message);
    byId.set(message.id, message);
  }

  return sortMessages(current);
}

/** Диалоги: last_message_at desc, nulls last. */
function sortConversations(list: ConversationView[]): ConversationView[] {
  return [...list].sort((a, b) => {
    const left = a.conversation.last_message_at;
    const right = b.conversation.last_message_at;
    if (!left && !right) return a.conversation.id < b.conversation.id ? -1 : 1;
    if (!left) return 1;
    if (!right) return -1;
    const delta = timeOf(right) - timeOf(left);
    if (delta !== 0) return delta;
    return a.conversation.id < b.conversation.id ? -1 : 1;
  });
}

function replaceConversation(list: ConversationView[], view: ConversationView): ConversationView[] {
  const index = list.findIndex((item) => item.conversation.id === view.conversation.id);
  if (index < 0) return sortConversations([...list, view]);
  const next = [...list];
  next[index] = view;
  return sortConversations(next);
}

interface ChatState {
  myUserId: UUID | null;
  conversations: ConversationView[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  /** Сообщения по диалогам. */
  messages: Map<UUID, ChatMessage[]>;
  hasMore: Record<UUID, boolean>;
  /** История диалога уже загружена (иначе первый открытый тред подтянет страницу). */
  historyLoaded: Record<UUID, boolean>;
  loadingMessages: Record<UUID, boolean>;
  loadingOlder: Record<UUID, boolean>;
  activeConversationId: UUID | null;
  /** conversation_id → user_id → момент, когда индикатор «печатает» гаснет. */
  typing: Record<UUID, Record<UUID, number>>;
  presence: Record<UUID, PresenceInfo>;
  /** conversation_id → read_at собеседника (для галочек «прочитано»). */
  peerReadAt: Record<UUID, string>;

  setMyUserId: (userId: UUID | null) => void;
  loadConversations: () => Promise<void>;
  refreshConversation: (conversationId: UUID) => Promise<void>;
  upsertConversation: (view: ConversationView) => void;
  removeConversation: (conversationId: UUID) => void;
  setActiveConversation: (conversationId: UUID | null) => void;
  loadMessages: (conversationId: UUID) => Promise<void>;
  loadOlderMessages: (conversationId: UUID) => Promise<void>;
  sendMessage: (conversationId: UUID, body: string) => Promise<void>;
  retryMessage: (conversationId: UUID, messageId: string) => Promise<void>;
  receiveMessage: (message: Message) => void;
  /** Оптимистичное сообщение помечается доставленным (ack или message.new). */
  confirmMessage: (conversationId: UUID, clientId: string, message?: Message) => void;
  markMessageFailed: (conversationId: UUID, clientId: string) => void;
  applyPeerRead: (conversationId: UUID, readAt: string) => void;
  markRead: (conversationId: UUID, messageId: UUID) => void;
  applyPresence: (presence: WsPresence) => void;
  applyTyping: (conversationId: UUID, userId: UUID, state: TypingState) => void;
  /** Локальный набор: троттлинг typing.start + отложенный typing.stop. */
  noteLocalTyping: (conversationId: UUID) => void;
  flushLocalTyping: (conversationId: UUID) => void;
  clearUnread: (conversationId: UUID) => void;
  reset: () => void;
}

function emptyState() {
  return {
    myUserId: null as UUID | null,
    conversations: [] as ConversationView[],
    conversationsLoading: false,
    conversationsError: null as string | null,
    messages: new Map<UUID, ChatMessage[]>(),
    hasMore: {} as Record<UUID, boolean>,
    historyLoaded: {} as Record<UUID, boolean>,
    loadingMessages: {} as Record<UUID, boolean>,
    loadingOlder: {} as Record<UUID, boolean>,
    activeConversationId: null as UUID | null,
    typing: {} as Record<UUID, Record<UUID, number>>,
    presence: {} as Record<UUID, PresenceInfo>,
    peerReadAt: {} as Record<UUID, string>,
  };
}

function resetTimers(): void {
  for (const timer of typingExpiryTimers.values()) window.clearTimeout(timer);
  typingExpiryTimers.clear();
  for (const timer of localTypingStopTimers.values()) window.clearTimeout(timer);
  localTypingStopTimers.clear();
  localTypingLastSentAt.clear();
  lastReadSent.clear();
}

export const useChatStore = create<ChatState>((set, get) => ({
  ...emptyState(),

  setMyUserId: (userId) => set({ myUserId: userId }),

  loadConversations: async () => {
    set({ conversationsLoading: true, conversationsError: null });
    try {
      const response = await api.conversations.list({ limit: 50 });
      set({ conversations: sortConversations(response.items), conversationsLoading: false });
    } catch (error) {
      set({ conversationsLoading: false, conversationsError: humanizeApiError(error) });
    }
  },

  refreshConversation: async (conversationId) => {
    try {
      const view = await api.conversations.get(conversationId);
      set((state) => ({ conversations: replaceConversation(state.conversations, view) }));
    } catch {
      // Диалог мог стать недоступен — интерфейс не ломаем.
    }
  },

  upsertConversation: (view) =>
    set((state) => ({ conversations: replaceConversation(state.conversations, view) })),

  removeConversation: (conversationId) =>
    set((state) => {
      const messages = new Map(state.messages);
      messages.delete(conversationId);
      return {
        conversations: state.conversations.filter((item) => item.conversation.id !== conversationId),
        activeConversationId:
          state.activeConversationId === conversationId ? null : state.activeConversationId,
        messages,
      };
    }),

  setActiveConversation: (conversationId) => {
    set({ activeConversationId: conversationId });
    if (!conversationId) return;
    get().clearUnread(conversationId);
    if (!get().historyLoaded[conversationId] && !get().loadingMessages[conversationId]) {
      void get().loadMessages(conversationId);
    }
  },

  loadMessages: async (conversationId) => {
    set((state) => ({ loadingMessages: { ...state.loadingMessages, [conversationId]: true } }));
    try {
      const page = await api.conversations.messages(conversationId, { limit: PAGE_SIZE });
      set((state) => {
        const messages = new Map(state.messages);
        const existing = messages.get(conversationId) ?? EMPTY_MESSAGES;
        messages.set(conversationId, mergeMessages([...existing], page.items.map(toChatMessage)));
        return {
          messages,
          hasMore: { ...state.hasMore, [conversationId]: page.has_more },
          historyLoaded: { ...state.historyLoaded, [conversationId]: true },
          loadingMessages: { ...state.loadingMessages, [conversationId]: false },
        };
      });
    } catch (error) {
      set((state) => ({ loadingMessages: { ...state.loadingMessages, [conversationId]: false } }));
      toast.error('Не удалось загрузить сообщения', humanizeApiError(error));
    }
  },

  loadOlderMessages: async (conversationId) => {
    const state = get();
    if (state.loadingOlder[conversationId]) return;
    if (state.hasMore[conversationId] === false) return;

    const current = state.messages.get(conversationId) ?? EMPTY_MESSAGES;
    // `before` — id самого старого серверного сообщения (оптимистичные id не подходят).
    const oldestReal = current.find((message) => !isOptimistic(message));
    if (!oldestReal) return;

    set((s) => ({ loadingOlder: { ...s.loadingOlder, [conversationId]: true } }));
    try {
      const page = await api.conversations.messages(conversationId, {
        limit: PAGE_SIZE,
        before: oldestReal.id,
      });
      set((s) => {
        const messages = new Map(s.messages);
        const existing = messages.get(conversationId) ?? EMPTY_MESSAGES;
        messages.set(conversationId, mergeMessages([...existing], page.items.map(toChatMessage)));
        return {
          messages,
          hasMore: { ...s.hasMore, [conversationId]: page.has_more },
          loadingOlder: { ...s.loadingOlder, [conversationId]: false },
        };
      });
    } catch (error) {
      set((s) => ({ loadingOlder: { ...s.loadingOlder, [conversationId]: false } }));
      toast.error('Не удалось загрузить историю', humanizeApiError(error));
    }
  },

  sendMessage: async (conversationId, body) => {
    const text = body.trim();
    if (!text) return;

    const clientId = makeClientId();
    const myUserId = get().myUserId ?? '';
    const optimistic: ChatMessage = {
      id: `local:${clientId}`,
      conversation_id: conversationId,
      sender_id: myUserId,
      kind: 'text',
      body: text,
      client_id: clientId,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      status: 'pending',
    };

    appendOptimistic(set, conversationId, optimistic);
    get().flushLocalTyping(conversationId);

    try {
      if (wsClient.isOpen()) {
        // Основной путь — WS с ожиданием ack по ref (= client_id).
        const ack = await wsClient.request(
          'message.send',
          { conversation_id: conversationId, body: text, client_id: clientId, kind: 'text' },
          { altRefs: [clientId] },
        );
        get().confirmMessage(conversationId, clientId, ack?.message);
      } else {
        // WS недоступен — REST-дубль (идемпотентность обеспечивает client_id).
        const response = await api.conversations.sendMessage(conversationId, text, clientId);
        get().confirmMessage(conversationId, clientId, response.message);
      }
    } catch (error) {
      get().markMessageFailed(conversationId, clientId);
      // На таймаут не показываем тост: статус сообщения уже виден, а «повторить» доступен.
      if (!(error instanceof WsError && error.code === 'timeout')) {
        toast.error('Сообщение не отправлено', humanizeApiError(error));
      }
    }
  },

  retryMessage: async (conversationId, messageId) => {
    const current = get().messages.get(conversationId) ?? EMPTY_MESSAGES;
    const failed = current.find((message) => message.id === messageId);
    if (!failed) return;

    // Убираем «ошибочное» сообщение и отправляем заново (client_id сохраняем — идемпотентность).
    set((state) => {
      const messages = new Map(state.messages);
      messages.set(
        conversationId,
        (messages.get(conversationId) ?? EMPTY_MESSAGES).filter((item) => item.id !== messageId),
      );
      return { messages };
    });

    const clientId = failed.client_id ?? makeClientId();
    appendOptimistic(set, conversationId, { ...failed, id: `local:${clientId}`, status: 'pending' });

    try {
      if (wsClient.isOpen()) {
        const ack = await wsClient.request(
          'message.send',
          { conversation_id: conversationId, body: failed.body, client_id: clientId, kind: 'text' },
          { altRefs: [clientId] },
        );
        get().confirmMessage(conversationId, clientId, ack?.message);
      } else {
        const response = await api.conversations.sendMessage(conversationId, failed.body, clientId);
        get().confirmMessage(conversationId, clientId, response.message);
      }
    } catch {
      get().markMessageFailed(conversationId, clientId);
    }
  },

  receiveMessage: (message) => {
    const state = get();
    const conversationId = message.conversation_id;
    const isMine = message.sender_id === state.myUserId;
    const isActive = state.activeConversationId === conversationId;
    const knownConversation = state.conversations.some((item) => item.conversation.id === conversationId);

    set((s) => {
      const messages = new Map(s.messages);
      // В тред кладём только если история уже загружена или диалог открыт:
      // иначе превью в списке достаточно, а историю подтянет открытие треда.
      if (s.historyLoaded[conversationId] || isActive) {
        const existing = messages.get(conversationId) ?? EMPTY_MESSAGES;
        messages.set(conversationId, mergeMessages([...existing], [toChatMessage(message)]));
      }

      const conversations = s.conversations.map((item) => {
        if (item.conversation.id !== conversationId) return item;
        return {
          ...item,
          last_message: message,
          conversation: { ...item.conversation, last_message_at: message.created_at },
          unread_count: !isMine && !isActive ? item.unread_count + 1 : item.unread_count,
        };
      });

      return { messages, conversations: sortConversations(conversations) };
    });

    // Незнакомый диалог (например, первое сообщение от нового собеседника) — обновим список.
    if (!knownConversation) void get().loadConversations();
  },

  confirmMessage: (conversationId, clientId, message) => {
    set((state) => {
      const messages = new Map(state.messages);
      const existing = messages.get(conversationId) ?? EMPTY_MESSAGES;
      if (message) {
        // Серверное сообщение вытесняет оптимистичное (дедуп по client_id).
        messages.set(conversationId, mergeMessages([...existing], [toChatMessage(message)]));
      } else {
        // ack без тела сообщения: считаем доставленным, ждём message.new.
        messages.set(
          conversationId,
          existing.map((item) =>
            item.client_id === clientId && item.status !== 'sent' ? { ...item, status: 'sent' } : item,
          ),
        );
      }
      return { messages };
    });
  },

  markMessageFailed: (conversationId, clientId) => {
    set((state) => {
      const messages = new Map(state.messages);
      const existing = messages.get(conversationId) ?? EMPTY_MESSAGES;
      messages.set(
        conversationId,
        existing.map((item) =>
          item.client_id === clientId ? { ...item, status: 'failed' as MessageStatus } : item,
        ),
      );
      return { messages };
    });
  },

  applyPeerRead: (conversationId, readAt) =>
    set((state) => {
      const previous = state.peerReadAt[conversationId];
      if (previous && timeOf(previous) >= timeOf(readAt)) return {};
      return { peerReadAt: { ...state.peerReadAt, [conversationId]: readAt } };
    }),

  markRead: (conversationId, messageId) => {
    get().clearUnread(conversationId);
    if (lastReadSent.get(conversationId) === messageId) return;
    lastReadSent.set(conversationId, messageId);

    if (wsClient.isOpen()) {
      try {
        wsClient.send('message.read', { conversation_id: conversationId, message_id: messageId });
        return;
      } catch {
        // упадём в REST-дубль
      }
    }
    void api.conversations.markRead(conversationId, messageId).catch(() => undefined);
  },

  applyPresence: (presence) =>
    set((state) => ({
      presence: {
        ...state.presence,
        [presence.user_id]: { status: presence.status, last_seen_at: presence.last_seen_at },
      },
      conversations: state.conversations.map((item) => ({
        ...item,
        members: item.members.map((member) =>
          member.id === presence.user_id ? { ...member, last_seen_at: presence.last_seen_at } : member,
        ),
      })),
    })),

  applyTyping: (conversationId, userId, state) => {
    const key = `${conversationId}:${userId}`;
    const timer = typingExpiryTimers.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      typingExpiryTimers.delete(key);
    }

    if (state === 'stop') {
      set((s) => {
        const forConversation = { ...(s.typing[conversationId] ?? {}) };
        delete forConversation[userId];
        return { typing: { ...s.typing, [conversationId]: forConversation } };
      });
      return;
    }

    // «печатает…» гаснет через 4 с, если новых событий не пришло
    const expiresAt = Date.now() + TYPING_TTL_MS;
    set((s) => ({
      typing: {
        ...s.typing,
        [conversationId]: { ...(s.typing[conversationId] ?? {}), [userId]: expiresAt },
      },
    }));

    typingExpiryTimers.set(
      key,
      window.setTimeout(() => {
        typingExpiryTimers.delete(key);
        set((s) => {
          const forConversation = { ...(s.typing[conversationId] ?? {}) };
          delete forConversation[userId];
          return { typing: { ...s.typing, [conversationId]: forConversation } };
        });
      }, TYPING_TTL_MS),
    );
  },

  noteLocalTyping: (conversationId) => {
    const now = Date.now();
    const last = localTypingLastSentAt.get(conversationId) ?? 0;
    if (now - last >= TYPING_THROTTLE_MS) {
      localTypingLastSentAt.set(conversationId, now);
      sendTyping(conversationId, 'start');
    }

    const existingStop = localTypingStopTimers.get(conversationId);
    if (existingStop !== undefined) window.clearTimeout(existingStop);
    localTypingStopTimers.set(
      conversationId,
      window.setTimeout(() => {
        localTypingStopTimers.delete(conversationId);
        get().flushLocalTyping(conversationId);
      }, TYPING_STOP_IDLE_MS),
    );
  },

  flushLocalTyping: (conversationId) => {
    const existingStop = localTypingStopTimers.get(conversationId);
    if (existingStop !== undefined) {
      window.clearTimeout(existingStop);
      localTypingStopTimers.delete(conversationId);
    }
    if ((localTypingLastSentAt.get(conversationId) ?? 0) === 0) return;
    localTypingLastSentAt.delete(conversationId);
    sendTyping(conversationId, 'stop');
  },

  clearUnread: (conversationId) =>
    set((state) => ({
      conversations: state.conversations.map((item) =>
        item.conversation.id === conversationId ? { ...item, unread_count: 0 } : item,
      ),
    })),

  reset: () => {
    resetTimers();
    set({ ...emptyState() });
  },
}));

type SetState = (updater: (state: ChatState) => Partial<ChatState>) => void;

/** Добавить оптимистичное сообщение (с сохранением сортировки). */
function appendOptimistic(set: SetState, conversationId: UUID, message: ChatMessage): void {
  set((state) => {
    const messages = new Map(state.messages);
    const existing = messages.get(conversationId) ?? EMPTY_MESSAGES;
    messages.set(conversationId, sortMessages([...existing, message]));
    return { messages };
  });
}

/** typing: WS, а при отсутствии соединения — REST-дубль. */
function sendTyping(conversationId: UUID, state: TypingState): void {
  if (wsClient.isOpen()) {
    try {
      wsClient.send('typing', { conversation_id: conversationId, state });
      return;
    } catch {
      // упадём в REST
    }
  }
  void api.conversations.sendTyping(conversationId, state).catch(() => undefined);
}

/** Сообщение считается прочитанным собеседником (для галочек). */
export function isReadByPeer(peerReadAt: string | undefined, createdAt: string): boolean {
  if (!peerReadAt) return false;
  return timeOf(createdAt) <= timeOf(peerReadAt);
}
