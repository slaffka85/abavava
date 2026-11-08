# Инструменты проверки медиа в звонке 1:1

Два независимых скрипта. Первый — единственный, который проверяет **медиа**;
второй проверяет только серверный путь сигналинга и **не является** доказательством
передачи медиа.

| Файл | Что делает | Нужен браузер |
|---|---|---|
| `media-check.mjs` | Полный сквозной сценарий видеозвонка между двумя пользователями в двух независимых браузерных контекстах с фейковыми медиаустройствами; сбор `getStats()` и состояния `<video>` | **да** |
| `signaling-check.mjs` | REST + два WebSocket-клиента: создание звонка, приём, транзит `call.signal` (offer/answer/candidate) в обе стороны, завершение, история | нет |

## Запуск

Из каталога `web/`:

```powershell
# только сигналинг (работает всегда)
npm run signaling:check

# медиа в браузере
$env:PLAYWRIGHT_BROWSERS_PATH='C:\Users\slaff\projects\chat-abavava\web\.pw-browsers'
cmd /c npx playwright install chromium
npm run media:check        # или: node tools/media-check.mjs
```

Переменные окружения: `ABV_BASE_URL` (по умолчанию `http://localhost:8081`),
`ABV_CHROME_PATH` (путь к `chrome.exe`/`msedge.exe` для резервного запуска),
`ABV_SKIP_SYSTEM_BROWSER=1`.

Код выхода: `0` — все проверки прошли, `1` — любая проверка провалилась или
браузер не поднялся. Артефакты (скриншоты, JSON-отчёты, логи браузера) складываются
в `tools/media-check-artifacts/`.

## Как `media-check.mjs` проверяет именно медиа

0. Pre-flight: скачивает отданный по `ABV_BASE_URL` JS-бандл и убеждается, что в нём
   есть `RTCPeerConnection`, `getUserMedia`, ключи `abv.access`/`abv.refresh` и все
   aria-метки, по которым работает сценарий (защита от устаревшего бандла).
1. Регистрация двух пользователей через `POST /api/v1/auth/register` и direct-диалог
   через `POST /api/v1/conversations` — сценарий не зависит от UI авторизации.
2. Два **независимых** браузерных контекста (разные процессы/профили, разный
   `localStorage`) с флагами фейковых медиаустройств:
   `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
   --autoplay-policy=no-user-gesture-required` (+
   `--disable-features=WebRtcHideLocalIpsWithMdns`, чтобы ICE не полагался на mDNS
   между двумя отдельными процессами браузера на одном стенде).
3. Токены `abv.access` / `abv.refresh` кладутся в `localStorage` **до** загрузки
   приложения через `context.addInitScript`.
4. `context.addInitScript` оборачивает `window.RTCPeerConnection` и
   `navigator.mediaDevices.getUserMedia` — это тестовая инъекция, **код приложения
   (`web/src`) не меняется**. Она нужна, потому что `CallSession` держит
   `RTCPeerConnection` в замыкании модуля и наружу его не отдаёт.
5. UI-шаги по реальным селекторам приложения:
   `.conv` (элемент диалога) → `button[aria-label="Видеозвонок"]` →
   `[aria-label="Входящий звонок"]` → `button.call-btn--accept` →
   `.call-overlay__state` с текстом «Соединение установлено» →
   `button[aria-label="Завершить"]`.
6. Доказательства медиа — два замера `getStats()` с интервалом 3 с:
   * `inbound-rtp` **video**: `bytesReceived > 0` и рост `framesDecoded`, ненулевые
     `frameWidth/frameHeight`;
   * `inbound-rtp` **audio**: `bytesReceived > 0`, `packetsReceived`, `audioLevel`;
   * `outbound-rtp` video/audio: `bytesSent`, `framesEncoded`;
   * `candidate-pair` (succeeded+nominated): тип/адрес/порт кандидатов, RTT;
   * независимая от статистики проверка узла `<video>`: `readyState >= 2`,
     `videoWidth > 0`, `currentTime > 0` для удалённого видеопотока;
   * двусторонность: обе стороны получают видео собеседника.
7. Скриншоты обоих участников, завершение звонка UI-кнопкой, проверка закрытия
   оверлея и терминального звонка в `GET /api/v1/calls` для обоих участников.

## Известное ограничение этого окружения

В песочнице DSH (режим `workspace-write`) **любой Chromium-браузер падает на
старте**: его межпроцессный канал Mojo требует named pipe, а песочница запрещает
открывать named pipe.

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: . : Access is denied. (0x5)
```

Проверено: `chrome.exe` (Google Chrome) и `msedge.exe` (Edge), с `--headless=new`,
старый `--headless`, с `--no-sandbox`, `--single-process`, `--in-process-gpu`,
`--no-zygote`, `--disable-gpu` — результат одинаковый, процесс завершается сразу.
Штатный запуск Playwright дополнительно невозможен: установка браузера падает с
`Error: spawn EPERM` (Playwright качает браузер через `child_process.fork`, а
порождение процессов с pipe'ами в песочнице запрещено).

Полный текст ошибок — в `tools/media-check-artifacts/browser-launch-blocker.log`
и `report.json`.

Чтобы реально прогнать `media-check.mjs`, нужен запуск **вне этой песочницы**
(обычный терминал пользователя) либо сессия с полным доступом
(`danger-full-access`). Никаких изменений в коде приложения для этого не требуется.

## Отчёты

* `media-check-artifacts/report.json` — результат последнего запуска
  `media-check.mjs` (в заблокированном окружении — `status: "blocked"`).
* `media-check-artifacts/report-<run>.json` — успешный прогон (создаётся при
  работающем браузере).
* `media-check-artifacts/signaling-report-<run>.json` — результаты
  `signaling-check.mjs` (проверка сигналинга, не медиа).
