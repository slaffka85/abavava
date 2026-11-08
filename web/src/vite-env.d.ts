/// <reference types="vite/client" />

declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}

interface ImportMetaEnv {
  /** Базовый URL backend. Пусто — тот же origin (в dev работает Vite proxy на /api). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
