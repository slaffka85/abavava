import { api } from './api';

const TOKEN_KEY = 'abv.push.token';

export function rememberPushToken(token: string): void {
  try { window.localStorage.setItem(TOKEN_KEY, token); } catch { /* WebView storage can be unavailable */ }
  void syncPushToken();
}

export async function syncPushToken(): Promise<void> {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (token) await api.push.registerDevice(token);
  } catch { /* Retry at the next authenticated bootstrap */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('abv-fcm-token', (event) => {
    const token = (event as CustomEvent<string>).detail;
    if (typeof token === 'string' && token.length > 20) rememberPushToken(token);
  });
}
