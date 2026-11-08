/** Состояние аутентификации: пользователь, токены, bootstrap сессии. */
import { create } from 'zustand';
import {
  ApiError,
  api,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  hasRefreshToken,
  humanizeApiError,
  setTokens,
} from '../lib/api';
import type { User } from '../lib/types';
import { syncPushToken } from '../lib/push';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  user: User | null;
  status: AuthStatus;
  error: string | null;
  /** Восстановление сессии при загрузке: /me по сохранённым токенам. */
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, displayName: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  patchMe: (patch: { display_name?: string; avatar_url?: string | null }) => Promise<void>;
  setUser: (user: User) => void;
  forceSignOut: (reason?: string) => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  status: 'idle',
  error: null,

  bootstrap: async () => {
    if (get().status === 'loading') return;

    // Токенов нет вообще — сразу аноним, без сетевого запроса.
    if (!hasRefreshToken() && !getAccessToken()) {
      set({ status: 'anonymous', user: null, error: null });
      return;
    }

    set({ status: 'loading', error: null });
    try {
      const { user } = await api.auth.me();
      set({ user, status: 'authenticated', error: null });
      void syncPushToken();
    } catch (error) {
      // 401 уже обработан в api (refresh + notifyAuthFailure), остальное — просто нет сессии.
      if (error instanceof ApiError && error.code === 'network_error') {
        // Сеть недоступна: не выкидываем пользователя, покажем экран логина с ошибкой.
        set({ status: 'anonymous', user: null, error: 'Нет соединения с сервером' });
        return;
      }
      clearTokens();
      set({ status: 'anonymous', user: null, error: null });
    }
  },

  login: async (email, password) => {
    set({ error: null });
    try {
      const response = await api.auth.login({ email: email.trim(), password });
      setTokens(response.access_token, response.refresh_token, response.expires_in);
      set({ user: response.user, status: 'authenticated', error: null });
      void syncPushToken();
      return true;
    } catch (error) {
      set({ error: humanizeApiError(error) });
      return false;
    }
  },

  register: async (email, displayName, password) => {
    set({ error: null });
    try {
      const response = await api.auth.register({
        email: email.trim(),
        display_name: displayName.trim(),
        password,
      });
      setTokens(response.access_token, response.refresh_token, response.expires_in);
      set({ user: response.user, status: 'authenticated', error: null });
      void syncPushToken();
      return true;
    } catch (error) {
      set({ error: humanizeApiError(error) });
      return false;
    }
  },

  logout: async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) await api.auth.logout(refreshToken);
    clearTokens();
    set({ user: null, status: 'anonymous', error: null });
  },

  patchMe: async (patch) => {
    try {
      const { user } = await api.auth.patchMe(patch);
      set({ user });
    } catch (error) {
      set({ error: humanizeApiError(error) });
    }
  },

  setUser: (user) => set({ user }),

  /** Вызывается извне (невалидный refresh, logout по 401). */
  forceSignOut: (reason) => {
    clearTokens();
    set({ user: null, status: 'anonymous', error: reason ?? null });
  },

  clearError: () => set({ error: null }),
}));
