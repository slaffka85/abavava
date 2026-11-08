# abavava — структура проекта

Основной репозиторий содержит Java 26 backend, React web-клиент и Android-приложение на Java. Альтернативный Go backend находится в отдельном репозитории `abavava-go` и реализует совместимый API.

## Где что находится

- `src/` — Spring Boot API, WebSocket, push-уведомления и миграции PostgreSQL.
- `web/` — React + TypeScript + Vite, чат и WebRTC UI.
- `android/` — Android WebView клиент, написанный на Java; FCM включается при наличии `google-services.json`.
- `docs/API.md`, `docs/WS-PROTOCOL.md` — общие контракты REST и WebSocket.
- `docs/DEPLOYMENT.md` — запуск Java backend за Nginx на VPS.

## Версии Java

Backend собирается и запускается на Java 26 (`maven.compiler.release=26`). Android Gradle Plugin требует отдельный JDK 17 или новее для Android сборки; используйте Android Studio Embedded JDK либо заданный в Gradle JDK.

## Порядок изменений

Сначала обновляйте общий API/WS-контракт и затем согласованно меняйте Java и Go реализации. Схема PostgreSQL должна оставаться совместимой, поскольку обе реализации используют те же миграции. Не коммитьте `.env`, Firebase service-account JSON, локальные TLS private keys, Android `local.properties` и build-кэши.