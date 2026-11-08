# tools/sandbox-build — проверка сборки при запрете child-process pipe'ов

**Это не часть приложения.** Каталог нужен только для окружений, где узлу запрещено
создавать pipe'ы для дочерних процессов (spawn со `stdio: 'pipe'` → `EPERM`).
В обычной среде он не используется и на `npm run build` не влияет.

## Проблема

`vite build` транспилирует TS/TSX и минифицирует бандл через `esbuild`, а `esbuild`
общается со своим бинарным сервисом по stdin/stdout, то есть через pipe'ы.
Если создание pipe'ов запрещено, вызов падает:

```
Error: spawn EPERM
    at Object.spawn (node:child_process:796:9)
    at ensureServiceIsRunning (.../esbuild/lib/main.js:2272:29)
```

Дополнительно Vite на Windows один раз вызывает `net use` через `child_process.exec`
(`optimizeSafeRealPathSync`) — это то же ограничение.

## Что делает обёртка

`run-build.mjs`:

1. подменяет резолв модуля `esbuild` на `esbuild-wasm-shim.mjs`
   (через `module.registerHooks` — работает и для ESM-чанков Vite, и для `require`);
2. глушит `child_process.exec` заглушкой (проверка сетевых дисков не нужна,
   `realpath` берётся нативный);
3. импортирует реальный `vite.config.ts` напрямую и запускает `vite.build()`
   с `configFile: false` — wasm-сборка esbuild не понимает абсолютные Windows-пути
   при бандлинге конфига.

`esbuild-wasm-shim.mjs` исполняет Go/WASM-сборку esbuild **в текущем процессе**
(браузерная сборка пакета `esbuild-wasm`, без воркеров и без процессов),
поэтому результат трансформации и минификации идентичен нативному esbuild.
Роль Vite и Rollup не меняется — проверяется настоящий production-бандл.

## Запуск

```powershell
$env:npm_config_cache = 'C:\Users\slaff\projects\chat-abavava\web\.npm-cache'  # глобальный npm-кэш вне web/ недоступен
cmd /c npm install --ignore-scripts          # postinstall esbuild тоже падает (spawn EPERM)
cmd /c npm install --no-save --ignore-scripts esbuild-wasm
cmd /c npm run build:sandbox
```

Важно: `esbuild-wasm` ставится **после** обычного `npm install` и только с `--no-save`.
Любой последующий `npm install` без `--no-save` вычистит его как «лишний» пакет
(`removed 1 package`) — тогда команду установки esbuild-wasm нужно повторить.
В `package.json` он не попадает: на обычной машине достаточно `npm run build`.
