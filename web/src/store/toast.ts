/** Всплывающие уведомления об ошибках API/WS. */
import { create } from 'zustand';

export type ToastKind = 'error' | 'info' | 'success';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'> & { ttlMs?: number }) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULT_TTL_MS = 5_000;
/** Защита от спама одинаковыми сообщениями (например, при обрыве WS). */
const DUPLICATE_WINDOW_MS = 6_000;

let seq = 0;
const lastPushedAt = new Map<string, number>();
const timers = new Map<string, number>();

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: ({ kind, title, message, ttlMs }) => {
    const key = `${kind}|${title}|${message ?? ''}`;
    const now = Date.now();
    const previous = lastPushedAt.get(key);
    if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) return;
    lastPushedAt.set(key, now);

    seq += 1;
    const id = `toast-${seq}`;
    set((state) => ({ toasts: [...state.toasts, { id, kind, title, message }] }));

    const timer = window.setTimeout(() => {
      timers.delete(id);
      get().dismiss(id);
    }, ttlMs ?? DEFAULT_TTL_MS);
    timers.set(id, timer);
  },

  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  clear: () => {
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
    set({ toasts: [] });
  },
}));

/** Удобный доступ вне React. */
export const toast = {
  error(title: string, message?: string): void {
    useToastStore.getState().push({ kind: 'error', title, message });
  },
  info(title: string, message?: string): void {
    useToastStore.getState().push({ kind: 'info', title, message });
  },
  success(title: string, message?: string): void {
    useToastStore.getState().push({ kind: 'success', title, message });
  },
};
