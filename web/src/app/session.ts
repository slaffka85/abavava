/** Жизненный цикл сессии: восстановление, запуск realtime, выход, потеря сессии. */
import { onAuthFailure } from '../lib/api';
import { wsClient } from '../lib/ws';
import { useAuthStore } from '../store/auth';
import { useCallStore } from '../store/call';
import { useChatStore } from '../store/chat';
import { toast } from '../store/toast';
import { startRealtime, stopRealtime } from './realtime';

/** Загружаем пользователя. Поднятие realtime делает App по появлению user. */
export async function bootstrapApp(): Promise<void> {
  await useAuthStore.getState().bootstrap();
}

export function startSession(userId: string): void {
  const chat = useChatStore.getState();
  chat.setMyUserId(userId);
  startRealtime();
  void wsClient.connect();
  void chat.loadConversations();
  // Активный звонок мог продолжаться, пока приложение было закрыто.
  void useCallStore.getState().resyncActiveCall();
}

export function stopSession(): void {
  stopRealtime();
  useChatStore.getState().reset();
  useCallStore.getState().reset();
}

/** Выход по кнопке. */
export async function logoutSession(): Promise<void> {
  await useAuthStore.getState().logout();
  stopSession();
}

/**
 * Сессию восстановить нельзя (refresh отозван/просрочен).
 * Статус становится anonymous — RequireAuth уводит на /login.
 */
export function handleAuthFailure(): void {
  stopSession();
  useAuthStore.getState().forceSignOut('Сессия истекла, войдите снова');
  toast.error('Сессия истекла', 'Войдите в систему заново');
}

/** Единая точка регистрации обработчика из api.ts. */
export function registerAuthFailureHandler(): () => void {
  return onAuthFailure(handleAuthFailure);
}
