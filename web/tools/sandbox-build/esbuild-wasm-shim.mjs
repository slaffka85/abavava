/**
 * Транспорт-заглушка: реализует API пакета `esbuild` поверх `esbuild-wasm`,
 * запуская WASM-сборку esbuild прямо в текущем процессе.
 *
 * Зачем: в этой среде запрещено создание pipe'ов для дочерних процессов
 * (spawn со stdio:'pipe' → EPERM), а нативный esbuild и Node-сборка
 * esbuild-wasm общаются со своим сервисом именно через stdin/stdout.
 * Браузерная сборка esbuild-wasm исполняет Go/WASM inline, без процессов,
 * и даёт идентичный результат трансформации и minify.
 *
 * В обычной среде этот файл не нужен: `npm run build` работает на нативном esbuild.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// esbuild-wasm/lib/browser.js ожидает браузерные глобалы.
globalThis.self = globalThis;
if (typeof globalThis.postMessage !== 'function') {
  globalThis.postMessage = () => undefined;
}

const wasm = require('esbuild-wasm/lib/browser.js');

let ready = null;

function ensureReady() {
  if (!ready) {
    const wasmPath = require.resolve('esbuild-wasm/esbuild.wasm');
    const wasmModule = new WebAssembly.Module(readFileSync(wasmPath));
    ready = wasm.initialize({ wasmModule, worker: false });
  }
  return ready;
}

export const version = wasm.version;

export async function initialize() {
  await ensureReady();
}

export async function transform(input, options) {
  await ensureReady();
  return wasm.transform(input, options);
}

export async function build(options) {
  await ensureReady();
  return wasm.build(options);
}

export async function formatMessages(messages, options) {
  await ensureReady();
  return wasm.formatMessages(messages, options);
}

export async function analyzeMetafile(metafile, options) {
  await ensureReady();
  return wasm.analyzeMetafile(metafile, options);
}

export function transformSync() {
  throw new Error('esbuild-wasm shim: transformSync недоступен');
}

export function buildSync() {
  throw new Error('esbuild-wasm shim: buildSync недоступен');
}

const api = { version, initialize, transform, build, formatMessages, analyzeMetafile };
export default api;
