import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Окружения dev-сервера. Ключ — режим Vite (`--mode`), который выставляет
 * npm-скрипт: `npm run dev` → development, `npm run local` → localdev.
 *
 * Имя режима `local` использовать нельзя: Vite его запрещает из-за конфликта
 * с суффиксом `.env.local` («"local" cannot be used as a mode name»).
 * На имя npm-скрипта ограничение не распространяется.
 */
const ENVS = {
  development: { target: 'http://localhost:8080', port: 5173 },
  localdev: { target: 'http://localhost:8082', port: 5174 },
  localhttps: { target: 'http://localhost:8082', port: 5174 },
} as const;

export default defineConfig(({ command, mode }) => {
  const env = ENVS[mode as keyof typeof ENVS] ?? ENVS.development;
  if (command === 'serve') {
    console.log(`[vite] mode=${mode}  /api → ${env.target}  (порт ${env.port})`);
  }

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: env.port,
      ...(mode === 'localhttps'
        ? {
            https: {
              key: readFileSync(new URL('../dev-certs/server.key', import.meta.url), 'utf8'),
              cert: readFileSync(new URL('../dev-certs/server.crt', import.meta.url), 'utf8'),
            },
          }
        : {}),
      // Явная ошибка вместо тихого переноса на соседний порт: другой origin
      // не попадёт в ABV_ALLOWED_ORIGINS бэкенда и запросы отобьются.
      strictPort: true,
      proxy: {
        // В dev REST и WS идут через прокси на backend.
        // ws: true обязателен — иначе апгрейд /api/v1/ws не проксируется и WS не подключится.
        '/api': {
          target: env.target,
          // changeOrigin намеренно выключен: backend проверяет Origin рукопожатия
          // WS, и правило «тот же узел» (httpx.OriginAllowed, шаг 4) сравнивает
          // hostname из Origin с hostname из Host. При changeOrigin: true прокси
          // подменяет Host на localhost:<порт backend>, поэтому страница,
          // открытая как http://127.0.0.1:5174, получает 403 «origin is not
          // allowed» на /api/v1/ws — фронт навсегда зависает на «Нет соединения,
          // переподключаемся…», а Vite сыплет ECONNABORTED. Без подмены Host
          // страница на 127.0.0.1 и на localhost одинаково проходит проверку.
          changeOrigin: false,
          ws: true,
        },
      },
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
