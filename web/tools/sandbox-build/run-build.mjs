/**
 * Обёртка для проверки сборки в этой среде:
 *  1) резолв 'esbuild' подменяется на WASM-заглушку (см. esbuild-wasm-shim.mjs);
 *  2) реальный vite.config.ts импортируется напрямую, без бандлинга конфига esbuild'ом
 *     (wasm-сборка не понимает абсолютные Windows-пути), поэтому configFile: false.
 *
 * Конфиг берётся из vite.config.ts — то есть проверяется именно он.
 */
import { registerHooks } from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Vite на Windows один раз вызывает `net use` через child_process.exec (проверка
 * сетевых дисков). В песочнице spawn с pipe'ами запрещён, поэтому подменяем exec
 * безопасной заглушкой: карта сетевых дисков остаётся пустой, а realpath берётся
 * нативный (fs.realpathSync.native) — это корректный путь.
 */
const childProcess = createRequire(import.meta.url)('node:child_process');
childProcess.exec = function patchedExec(...args) {
  const callback = args[args.length - 1];
  if (typeof callback === 'function') process.nextTick(() => callback(null, '', ''));
  return { on() {}, kill() {}, unref() {} };
};

const shimUrl = new URL('./esbuild-wasm-shim.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'esbuild') return { url: shimUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const configUrl = pathToFileURL(resolve(process.cwd(), 'vite.config.ts')).href;
const loaded = await import(configUrl);
const config = typeof loaded.default === 'function'
  ? await loaded.default({ command: 'build', mode: 'production', isSsrBuild: false, isPreview: false })
  : loaded.default;

const { build } = await import('vite');
await build({ ...config, configFile: false, logLevel: 'info' });
