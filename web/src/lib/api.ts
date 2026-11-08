/**
 * Обёртка над fetch для REST API v1 (docs/API.md).
 *
 * Особенности:
 *  - токены: access — в памяти + localStorage (`abv.access`), refresh — в localStorage (`abv.refresh`);
 *  - на 401 один раз обновляем access через /auth/refresh и повторяем исходный запрос;
 *  - параллельные 401 не порождают лавину refresh: все ждут один in-flight promise;
 *  - ошибки сервера `{ error: { code, message } }` превращаются в типизированный ApiError.
 */
import type {
  AuthResponse,
  Call,
  CallEnvelope,
  CallKind,
  CallListResponse,
  ConversationListResponse,
  ConversationView,
  HealthResponse,
  IceConfigResponse,
  Message,
  MessageEnvelope,
  MessagePageResponse,
  TypingState,
  User,
  UserEnvelope,
  UUID,
} from './types';

const ACCESS_KEY = 'abv.access';
const REFRESH_KEY = 'abv.refresh';

/** Токен считаем протухшим заранее, чтобы не ловить 401 на середине запроса. */
const EXPIRY_SKEW_MS = 30_000;

/** Пустая строка = тот же origin (в dev работает Vite proxy на /api). */
const ENV_BASE = (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '');

/** Корень API v1, например `/api/v1` или `http://localhost:8080/api/v1`. */
export const API_ROOT = `${ENV_BASE}/api/v1`;

/* ------------------------------------------------------------------ */
/* Ошибки                                                              */
/* ------------------------------------------------------------------ */

export interface ApiErrorInit {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === 'unauthorized';
  }
}

/** Человекочитаемые сообщения для типовых кодов контракта. */
export function humanizeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_request':
        return error.message || 'Некорректный запрос';
      case 'validation_failed':
        return error.message || 'Проверьте заполненные поля';
      case 'unauthorized':
        return error.message || 'Неверный email или пароль';
      case 'forbidden':
        return error.message || 'Нет доступа';
      case 'not_found':
        return error.message || 'Не найдено';
      case 'conflict':
        return error.message || 'Конфликт: объект уже существует';
      case 'rate_limited':
        return error.message || 'Слишком много запросов, попробуйте позже';
      case 'internal':
        return error.message || 'Внутренняя ошибка сервера';
      case 'network_error':
        return error.message || 'Нет соединения с сервером';
      default:
        return error.message || 'Неизвестная ошибка';
    }
  }
  if (error instanceof Error) return error.message;
  return 'Неизвестная ошибка';
}

/* ------------------------------------------------------------------ */
/* Хранилище токенов                                                   */
/* ------------------------------------------------------------------ */

let accessToken: string | null = null;
/** 0 = срок неизвестен (тогда полагаемся на ответ сервера). */
let accessExpiresAt = 0;

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Пытаемся достать exp из JWT, чтобы не хранить отдельный ключ. */
function readJwtExpiryMs(token: string): number {
  const payload = token.split('.')[1];
  if (!payload) return 0;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function loadStoredTokens(): void {
  const storage = safeStorage();
  if (!storage) return;
  accessToken = storage.getItem(ACCESS_KEY);
  if (accessToken) accessExpiresAt = readJwtExpiryMs(accessToken);
}

loadStoredTokens();

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return safeStorage()?.getItem(REFRESH_KEY) ?? null;
}

export function hasRefreshToken(): boolean {
  return Boolean(getRefreshToken());
}

export function setTokens(access: string, refresh: string, expiresInSeconds?: number): void {
  const storage = safeStorage();
  accessToken = access;
  accessExpiresAt = readJwtExpiryMs(access) || (expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : 0);
  storage?.setItem(ACCESS_KEY, access);
  storage?.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  const storage = safeStorage();
  accessToken = null;
  accessExpiresAt = 0;
  storage?.removeItem(ACCESS_KEY);
  storage?.removeItem(REFRESH_KEY);
}

export function isAccessExpired(): boolean {
  if (!accessToken) return true;
  if (!accessExpiresAt) return false;
  return Date.now() >= accessExpiresAt - EXPIRY_SKEW_MS;
}

/* ------------------------------------------------------------------ */
/* Реакция на потерю сессии                                            */
/* ------------------------------------------------------------------ */

type AuthFailureListener = () => void;
const authFailureListeners = new Set<AuthFailureListener>();

/** Подписка на «сессию не восстановить» — стор делает logout + редирект на /login. */
export function onAuthFailure(listener: AuthFailureListener): () => void {
  authFailureListeners.add(listener);
  return () => authFailureListeners.delete(listener);
}

function notifyAuthFailure(): void {
  clearTokens();
  for (const listener of [...authFailureListeners]) listener();
}

/**
 * Сообщить api-слою, что сессия недействительна (например, refresh-токен отозван
 * и WebSocket не может пройти handshake). Инициирует logout + редирект на /login.
 */
export function reportSessionInvalid(): void {
  notifyAuthFailure();
}

/* ------------------------------------------------------------------ */
/* Refresh без лавины                                                  */
/* ------------------------------------------------------------------ */

let refreshInFlight: Promise<string> | null = null;

/** Единая точка обновления access-токена: параллельные вызовы ждут один промис. */
export function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function performRefresh(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new ApiError({ code: 'unauthorized', message: 'Нет refresh-токена', status: 401 });
  }

  // Намеренно сырой fetch: refresh не должен попадать в обработчик 401 (иначе рекурсия).
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    throw new ApiError({ code: 'network_error', message: 'Нет соединения с сервером', status: 0 });
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  const data = (await response.json()) as AuthResponse;
  setTokens(data.access_token, data.refresh_token, data.expires_in);
  return data.access_token;
}

/**
 * Гарантирует валидный access-токен: если он протух — обновляем.
 * Используется при подключении WS (иначе handshake отвалится по 401).
 */
export async function ensureFreshAccessToken(): Promise<string> {
  if (accessToken && !isAccessExpired()) return accessToken;
  if (!accessToken && !hasRefreshToken()) {
    throw new ApiError({ code: 'unauthorized', message: 'Сессия отсутствует', status: 401 });
  }
  return refreshAccessToken();
}

/* ------------------------------------------------------------------ */
/* Базовый request                                                     */
/* ------------------------------------------------------------------ */

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  /** Нужен ли заголовок Authorization (по умолчанию — да). */
  auth?: boolean;
  query?: Record<string, QueryValue>;
  /** Повторять ли запрос после refresh (внутренний повтор — ровно один). */
  retryOnUnauthorized?: boolean;
  signal?: AbortSignal;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'internal';
  let message = `Ошибка запроса (${response.status})`;
  let details: Record<string, unknown> | undefined;

  try {
    const text = await response.text();
    if (text) {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
      if (parsed.error) {
        if (typeof parsed.error.code === 'string') code = parsed.error.code;
        if (typeof parsed.error.message === 'string') message = parsed.error.message;
        details = parsed.error.details;
      }
    }
  } catch {
    // тело не JSON — оставляем сообщение по умолчанию
  }

  return new ApiError({ code, message, status: response.status, details });
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_ROOT}${path}`;
  if (!query) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    auth = true,
    query,
    retryOnUnauthorized = true,
    signal,
  } = options;

  const url = buildUrl(path, query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const payload = body === undefined ? undefined : JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: payload, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError({ code: 'network_error', message: 'Нет соединения с сервером', status: 0 });
  }

  // 401 → один раз обновляем токен (единственным общим refresh-промисом) и повторяем запрос.
  if (response.status === 401 && auth && retryOnUnauthorized) {
    let freshToken: string;
    try {
      freshToken = await refreshAccessToken();
    } catch (error) {
      notifyAuthFailure();
      throw error instanceof ApiError
        ? error
        : new ApiError({ code: 'unauthorized', message: 'Сессия истекла, войдите снова', status: 401 });
    }

    headers.Authorization = `Bearer ${freshToken}`;
    try {
      response = await fetch(url, { method, headers, body: payload, signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError({ code: 'network_error', message: 'Нет соединения с сервером', status: 0 });
    }
  }

  if (!response.ok) {
    const apiError = await toApiError(response);
    // Сессия недействительна даже после успешного refresh — сбрасываем и уходим на /login.
    if (apiError.isUnauthorized && auth && retryOnUnauthorized) notifyAuthFailure();
    throw apiError;
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({ code: 'internal', message: 'Некорректный ответ сервера', status: response.status });
  }
}

/* ------------------------------------------------------------------ */
/* Эндпоинты                                                           */
/* ------------------------------------------------------------------ */

export const authApi = {
  register(input: { email: string; display_name: string; password: string }): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/register', { method: 'POST', body: input, auth: false });
  },

  login(input: { email: string; password: string }): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/login', { method: 'POST', body: input, auth: false });
  },

  /** Прямой вызов refresh (обычно достаточно refreshAccessToken()). */
  refresh(refreshToken: string): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
      auth: false,
      retryOnUnauthorized: false,
    });
  },

  /** Идемпотентно; ошибки игнорируем — токен всё равно удаляем локально. */
  async logout(refreshToken: string): Promise<void> {
    try {
      await request<void>('/auth/logout', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        auth: false,
        retryOnUnauthorized: false,
      });
    } catch {
      // logout идемпотентен и не должен блокировать выход из UI
    }
  },

  me(): Promise<UserEnvelope> {
    return request<UserEnvelope>('/me');
  },

  patchMe(patch: { display_name?: string; avatar_url?: string | null }): Promise<UserEnvelope> {
    return request<UserEnvelope>('/me', { method: 'PATCH', body: patch });
  },
};

export const usersApi = {
  /**
   * Поиск по display_name/email, исключая себя.
   * Форма ответа в API.md не зафиксирована: принимаем и `{ items: [...] }`, и голый массив.
   */
  async search(query: string, limit = 20, signal?: AbortSignal): Promise<{ items: User[] }> {
    const response = await request<User[] | { items: User[] }>('/users', {
      query: { q: query, limit },
      signal,
    });
    if (Array.isArray(response)) return { items: response };
    return { items: response?.items ?? [] };
  },

  async get(userId: UUID): Promise<User> {
    const response = await request<User | { user: User }>(`/users/${encodeURIComponent(userId)}`);
    if (response && typeof response === 'object' && 'user' in response) return response.user;
    return response as User;
  },
};

export const conversationsApi = {
  list(params: { limit?: number; cursor?: string } = {}): Promise<ConversationListResponse> {
    return request<ConversationListResponse>('/conversations', {
      query: { limit: params.limit ?? 50, cursor: params.cursor },
    });
  },

  /** Идемпотентно: повторный запрос вернёт тот же диалог (200 вместо 201). */
  createDirect(peerId: UUID): Promise<ConversationView> {
    return request<ConversationView>('/conversations', {
      method: 'POST',
      body: { kind: 'direct', peer_id: peerId },
    });
  },

  createGroup(title: string, memberIds: UUID[]): Promise<ConversationView> {
    return request<ConversationView>('/conversations', {
      method: 'POST',
      body: { kind: 'group', title, member_ids: memberIds },
    });
  },

  get(conversationId: UUID): Promise<ConversationView> {
    return request<ConversationView>(`/conversations/${encodeURIComponent(conversationId)}`);
  },

  addMembers(conversationId: UUID, userIds: UUID[]): Promise<ConversationView> {
    return request<ConversationView>(`/conversations/${encodeURIComponent(conversationId)}/members`, {
      method: 'POST',
      body: { user_ids: userIds },
    });
  },

  removeMember(conversationId: UUID, userId: UUID): Promise<void> {
    return request<void>(
      `/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  },

  /** Keyset-пагинация назад по времени: `before` — id самого старого сообщения страницы. */
  messages(
    conversationId: UUID,
    params: { limit?: number; before?: UUID } = {},
  ): Promise<MessagePageResponse> {
    return request<MessagePageResponse>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      query: { limit: params.limit ?? 50, before: params.before },
    });
  },

  sendMessage(conversationId: UUID, body: string, clientId: string): Promise<MessageEnvelope> {
    return request<MessageEnvelope>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: { body, client_id: clientId },
    });
  },

  markRead(conversationId: UUID, messageId: UUID): Promise<void> {
    return request<void>(`/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: 'POST',
      body: { message_id: messageId },
    });
  },

  /** REST-дубль WS-события `typing` (для клиентов без WS). */
  sendTyping(conversationId: UUID, state: TypingState): Promise<void> {
    return request<void>(`/conversations/${encodeURIComponent(conversationId)}/typing`, {
      method: 'POST',
      body: { state },
    });
  },
};

export const callsApi = {
  /** conversation_id опционален: без него backend найдёт/создаст direct-диалог. */
  create(input: { callee_id: UUID; kind: CallKind; conversation_id?: UUID }): Promise<CallEnvelope> {
    return request<CallEnvelope>('/calls', { method: 'POST', body: input });
  },

  list(limit = 50): Promise<CallListResponse> {
    return request<CallListResponse>('/calls', { query: { limit } });
  },

  get(callId: UUID): Promise<CallEnvelope> {
    return request<CallEnvelope>(`/calls/${encodeURIComponent(callId)}`);
  },

  accept(callId: UUID): Promise<CallEnvelope> {
    return request<CallEnvelope>(`/calls/${encodeURIComponent(callId)}/accept`, { method: 'POST', body: {} });
  },

  reject(callId: UUID, reason?: string): Promise<CallEnvelope> {
    return request<CallEnvelope>(`/calls/${encodeURIComponent(callId)}/reject`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  },

  end(callId: UUID, reason?: string): Promise<CallEnvelope> {
    return request<CallEnvelope>(`/calls/${encodeURIComponent(callId)}/end`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  },
};

export const configApi = {
  /** ICE-серверы; при недоступности используем встроенный STUN-дефолт. */
  ice(): Promise<IceConfigResponse> {
    return request<IceConfigResponse>('/config/ice');
  },
};

export const healthApi = {
  healthz(): Promise<HealthResponse> {
    return request<HealthResponse>('/healthz', { auth: false });
  },
  readyz(): Promise<HealthResponse> {
    return request<HealthResponse>('/readyz', { auth: false });
  },
};

export const pushApi = {
  registerDevice(token: string): Promise<void> {
    return request<void>('/push/devices', { method: 'POST', body: { token } });
  },
};

export const api = {
  auth: authApi,
  users: usersApi,
  conversations: conversationsApi,
  calls: callsApi,
  config: configApi,
  health: healthApi,
  push: pushApi,
};

export type { Message, ConversationView, Call, User };
