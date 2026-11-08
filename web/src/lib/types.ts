/**
 * Модели и события, объявленные в docs/API.md и docs/WS-PROTOCOL.md.
 * Поля — строго snake_case, как в контракте.
 */

export type UUID = string;
/** RFC3339 UTC, например "2025-01-31T12:00:00Z" */
export type Timestamp = string;

/* ------------------------------------------------------------------ */
/* Модели                                                              */
/* ------------------------------------------------------------------ */

export interface User {
  id: UUID;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Timestamp;
  last_seen_at: Timestamp | null;
}

export type MessageKind = 'text' | 'system' | 'call';

export interface Message {
  id: UUID;
  conversation_id: UUID;
  sender_id: UUID;
  kind: MessageKind;
  body: string;
  client_id: string | null;
  created_at: Timestamp;
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export type ConversationKind = 'direct' | 'group';

export interface Conversation {
  id: UUID;
  kind: ConversationKind;
  /** null для direct-диалогов — заголовок берётся из участника */
  title: string | null;
  created_by: UUID;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_message_at: Timestamp | null;
}

export interface ConversationView {
  conversation: Conversation;
  members: User[];
  last_message: Message | null;
  unread_count: number;
}

export type CallKind = 'audio' | 'video';

export type CallStatus =
  | 'ringing'
  | 'accepted'
  | 'rejected'
  | 'missed'
  | 'ended'
  | 'failed'
  | 'canceled';

/** Терминальные статусы — после них звонок живёт только в истории. */
export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = [
  'rejected',
  'missed',
  'ended',
  'failed',
  'canceled',
];

export type CallEndReason =
  | 'hangup'
  | 'canceled'
  | 'rejected'
  | 'timeout'
  | 'failed'
  | string;

export interface Call {
  id: UUID;
  conversation_id: UUID;
  caller_id: UUID;
  callee_id: UUID;
  kind: CallKind;
  status: CallStatus;
  created_at: Timestamp;
  answered_at: Timestamp | null;
  ended_at: Timestamp | null;
  ended_by: UUID | null;
  end_reason: CallEndReason | null;
  duration_seconds: number;
  /** Собеседник относительно запросившего. */
  peer: User;
}

/* ------------------------------------------------------------------ */
/* Конверты REST                                                       */
/* ------------------------------------------------------------------ */

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface AuthResponse {
  user: User;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface UserEnvelope {
  user: User;
}

export interface MessageEnvelope {
  message: Message;
}

export interface ConversationListResponse {
  items: ConversationView[];
  next_cursor: string | null;
}

export interface MessagePageResponse {
  items: Message[];
  has_more: boolean;
}

export interface CallEnvelope {
  call: Call;
}

export interface CallListResponse {
  items: Call[];
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigResponse {
  ice_servers: IceServer[];
}

export interface HealthResponse {
  status: string;
  db?: string;
}

/* ------------------------------------------------------------------ */
/* WebSocket: клиент → сервер                                          */
/* ------------------------------------------------------------------ */

export interface OutMessageSend {
  conversation_id: UUID;
  body: string;
  client_id: string;
  kind?: MessageKind;
}

export interface OutMessageRead {
  conversation_id: UUID;
  message_id: UUID;
}

export type TypingState = 'start' | 'stop';

export interface OutTyping {
  conversation_id: UUID;
  state: TypingState;
}

export interface OutCallAccept {
  call_id: UUID;
}

export interface OutCallReject {
  call_id: UUID;
  reason?: string;
}

export interface OutCallEnd {
  call_id: UUID;
  reason?: string;
}

/** SDP/ICE, который backend транзитом передаёт второму участнику. */
export type SignalPayload =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | {
      type: 'candidate';
      candidate: string;
      sdp_mid: string | null;
      sdp_mline_index: number | null;
    };

export interface OutCallSignal {
  call_id: UUID;
  payload: SignalPayload;
}

export interface ClientEventDataMap {
  ping: Record<string, never>;
  'message.send': OutMessageSend;
  'message.read': OutMessageRead;
  typing: OutTyping;
  'call.accept': OutCallAccept;
  'call.reject': OutCallReject;
  'call.end': OutCallEnd;
  'call.signal': OutCallSignal;
}

export type ClientEventType = keyof ClientEventDataMap;

/* ------------------------------------------------------------------ */
/* WebSocket: сервер → клиент                                          */
/* ------------------------------------------------------------------ */

export interface WsHello {
  session_id: string;
  user_id: UUID;
  server_time: Timestamp;
  heartbeat_interval_seconds: number;
}

export interface WsPong {
  ts: Timestamp;
}

export interface WsAck {
  ref?: string;
  ok: true;
  data?: {
    message?: Message;
  };
}

export type WsErrorCode =
  | 'unsupported_type'
  | 'malformed_frame'
  | 'validation_failed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

export interface WsErrorData {
  ref?: string;
  code: WsErrorCode | string;
  message: string;
}

export interface WsPresence {
  user_id: UUID;
  status: 'online' | 'offline';
  last_seen_at: Timestamp | null;
}

export interface WsMessageNew {
  message: Message;
}

export interface WsMessageRead {
  conversation_id: UUID;
  user_id: UUID;
  message_id: UUID;
  read_at: Timestamp;
}

export interface WsTyping {
  conversation_id: UUID;
  user_id: UUID;
  state: TypingState;
}

export interface WsCallCreated {
  call: Call;
}

export interface WsCallIncoming {
  call: Call;
}

export interface WsCallUpdated {
  call: Call;
}

export interface WsCallSignal {
  call_id: UUID;
  from?: UUID;
  payload: SignalPayload;
}

/** Конверт серверного события. */
export interface WsEnvelope<T extends string, D> {
  v: number;
  type: T;
  id: string;
  ts: Timestamp;
  data: D;
}

export type WsEvent =
  | WsEnvelope<'hello', WsHello>
  | WsEnvelope<'pong', WsPong>
  | WsEnvelope<'ack', WsAck>
  | WsEnvelope<'error', WsErrorData>
  | WsEnvelope<'presence', WsPresence>
  | WsEnvelope<'message.new', WsMessageNew>
  | WsEnvelope<'message.read', WsMessageRead>
  | WsEnvelope<'typing', WsTyping>
  | WsEnvelope<'call.created', WsCallCreated>
  | WsEnvelope<'call.incoming', WsCallIncoming>
  | WsEnvelope<'call.updated', WsCallUpdated>
  | WsEnvelope<'call.signal', WsCallSignal>;

export type WsEventType = WsEvent['type'];

/** Данные события по его типу — используется в типизированных подписках. */
export type WsDataOf<T extends WsEventType> = Extract<WsEvent, { type: T }>['data'];
