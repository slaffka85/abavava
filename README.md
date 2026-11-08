# abavava

Основной backend мессенджера и видеозвонков: Java 26, Spring Boot 4.1 и PostgreSQL 16.
В этом репозитории также находятся React web-клиент (`web/`) и Android-приложение на Java (`android/`).

REST API `/api/v1` и WebSocket-протокол v1 описаны в `docs/`. Альтернативная Go-реализация backend поддерживается отдельно в [`abavava-go`](https://github.com/slaffka85/abavava-go).

**Стек:** Java 26 · Spring Boot 4.1 · Spring MVC · Spring Data JDBC/JdbcClient · Spring WebSocket · PostgreSQL 16 · React 19 · TypeScript · Vite · Android Gradle Plugin.

## Быстрый старт

```powershell
# 1. Создайте локальный файл конфигурации (он исключён из Git)
Copy-Item .env.example .env
$secret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$lines = (Get-Content .env) -replace '^ABV_JWT_SECRET=.*$', "ABV_JWT_SECRET=$secret"
[IO.File]::WriteAllLines((Resolve-Path .env), $lines, [Text.UTF8Encoding]::new($false))
Remove-Variable secret
# Задайте ABV_DATABASE_USERNAME и ABV_DATABASE_PASSWORD в .env.

# 2. PostgreSQL (своя БД, чтобы не мешать Go-треку)
docker compose up -d postgres            # порт 5433

# 3. Проверка компиляции и unit-тестов (офлайн)
powershell -ExecutionPolicy Bypass -File build.ps1 check

# 4. Исполняемый jar (первая сборка скачивает зависимости плагинов
#    с Maven Central; дальше работает кэш)
powershell -ExecutionPolicy Bypass -File build.ps1 package

# 5. Запуск API (:8082)
powershell -ExecutionPolicy Bypass -File build.ps1 run

# 6. Паритетный smoke-тест Go-трека против Java-API
powershell -ExecutionPolicy Bypass -File build.ps1 smoke
```

`build.ps1 run` запускает `target\abavava-0.1.0-SNAPSHOT.jar`, а если
jar ещё не собран — стартует с classpath из локального Maven-кэша (без упаковки).

Демо-данные: `ABV_SEED=true powershell -File build.ps1 run` создаст тех же трёх пользователей, что Go-реализация.

## Клиенты

### Web

```powershell
cd web
npm ci
npm run dev
```

Vite проксирует `/api` и WebSocket на Java API `localhost:8082`. Для подключения телефона в одной сети используйте режим `npm run local` и адрес компьютера, указанный в клиенте.

### Android

Откройте папку `android/` в Android Studio, дождитесь Gradle Sync и соберите APK через **Build → Build APK(s)** либо:

```powershell
cd android
.\gradlew.bat assembleDebug
```

Для Android-сборки нужен JDK 17+ и Android SDK Platform 36. Backend отдельно собирается и запускается на Java 26. APK находится в `android/app/build/outputs/apk/debug/app-debug.apk`.

Для FCM Android-сборке нужен `android/app/google-services.json`. Серверу нужен Firebase service-account JSON, заданный через `ABV_FCM_SERVICE_ACCOUNT_FILE`; этот приватный ключ храните вне репозитория.

Проверить совместимость Java API Go-смоук-клиентом можно из соседнего проекта:

```powershell
cd ..\abavava-go
go run ./cmd/smoke -base http://127.0.0.1:8082
```
## Конфигурация

Все значения по умолчанию заданы в
[`src/main/resources/application.yml`](src/main/resources/application.yml)
(секция `abv:`) — в Java-коде параметров не зашито. Прикладные значения
переопределяются переменной окружения `ABV_*` (relaxed binding Spring Boot):
`abv.http-addr` ← `ABV_HTTP_ADDR` и т.д. Данные БД — стандартные свойства
Spring Boot `spring.datasource.*` / `spring.datasource.hikari.*`, которые
собираются штатной автоконфигурацией (своих `DataSource`-бинов нет).

Переменные окружения имеют приоритет над yml; если свойства нет ни в yml, ни в
окружении, приложение падает на старте (BindException), а не работает на
скрытом дефолте.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `ABV_ENV` | `development` | окружение; `production` включает строгие проверки |
| `ABV_HTTP_ADDR` | `:8082` | адрес/порт прослушивания |
| `ABV_DATABASE_URL` | нет, задайте в `.env` | JDBC-URL PostgreSQL (формат `postgres://...` понимает только Go-трек) |
| `ABV_DATABASE_USERNAME` | нет, задайте в `.env` | пользователь БД |
| `ABV_DATABASE_PASSWORD` | нет, задайте в `.env` | пароль БД; используйте отдельный секрет в production |
| `ABV_JWT_SECRET` | нет, обязателен | Случайный HS256-ключ минимум 32 символа; задавайте через secret manager в production |
| `ABV_ACCESS_TTL` | `15m` | время жизни access-токена |
| `ABV_REFRESH_TTL` | `720h` | время жизни refresh-токена |
| `ABV_CALL_RING_TIMEOUT` | `45s` | таймаут дозвона |
| `ABV_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | CORS и Origin WebSocket |
| `ABV_MAX_MESSAGE_LENGTH` | `4000` | лимит длины сообщения |
| `ABV_LOG_LEVEL` | `info` | уровень логирования |
| `ABV_MIGRATE_ON_START` | `true` | применять миграции при старте |
| `ABV_SEED` | `false` | демо-данные (или аргумент `--seed`) |
| `ABV_MIGRATION_WAIT_ATTEMPTS` | `30` | попытки подключения к БД при старте |
| `ABV_MIGRATION_WAIT_INTERVAL` | `1s` | пауза между попытками |
| `ABV_AUTH_RATE_LIMIT_LIMIT` | `30` | запросов на окно для `/auth/*` |
| `ABV_AUTH_RATE_LIMIT_WINDOW` | `60s` | размер окна rate limit |
| `ABV_CORS_MAX_AGE` | `600` | `Access-Control-Max-Age` |
| `ABV_WS_MAX_FRAME_SIZE` | `65536` | предел кадра WebSocket |
| `ABV_WS_MAX_SEND_BUFFER` | `256` | очередь событий на соединение |
| `ABV_WS_HEARTBEAT_INTERVAL` | `60s` | heartbeat в `hello` |
| `ABV_WS_IDLE_TIMEOUT` | `70s` | idle timeout соединения |
| `ABV_CHAT_MAX_GROUP_MEMBERS` | `64` | участников в группе |
| `ABV_CHAT_MAX_TITLE_LENGTH` | `128` | длина названия группы |
| `ABV_STUN_URLS`, `ABV_TURN_URL`, `ABV_TURN_USERNAME`, `ABV_TURN_CREDENTIAL` | STUN по умолчанию | ICE-конфигурация |

Параметры пула соединений — `spring.datasource.hikari.*` (maximum-pool-size,
min-idle, max-lifetime в мс и т.д.), их можно переопределить и стандартными
переменными `SPRING_DATASOURCE_HIKARI_*`.

## Структура

```
src/main/java/com/abavava/chat/
  config/    ABV_*-конфигурация, миграции, порт (DataSource/Hikari — стандартная
             автоконфигурация Spring Boot)
  domain/    модели, ошибки, WS-конверт и payload-записи
  security/  JWT HS256, bcrypt, refresh-токены
  http/      фильтры (request-id, CORS, rate limit, auth), единый формат ошибок,
             health/ready/status, чтение JSON-тела
  contract/  интерфейсы между модулями (Broadcaster, ChatCommands, CallCommands,
             UserLookup, RealtimeStats)
  auth/      регистрация/вход/refresh/logout + refresh_tokens
  user/      профили, поиск, last_seen
  chat/      диалоги, сообщения, прочтения, набор текста (команда A)
  call/      звонки: состояния, таймеры, история, ICE (команда B)
  realtime/  WebSocket-хаб, presence, протокол v1 (команда C)
```

## Проверки

- `build.ps1 check` — офлайн: компиляция + unit-тесты (JWT, bcrypt,
  Origin/CORS).
- `build.ps1 package` — исполняемый jar (первый запуск требует Maven Central:
  недостающие артефакты плагинов упаковки). В этом run'е упаковка проверена.
- `build.ps1 smoke` — паритетный Go-смоук против Java-API: 15/15 проверок
  (health, регистрация, direct-диалог, два WS, presence, message.new+ack,
  идемпотентность, read, typing, полный цикл звонка, история, peer).
- Дальше: Java-тесты модулей на Testcontainers/локальной PostgreSQL и
  сравнение ответов двух бэкендов по общему сценарию — бэклог трека.

## Известные ограничения

### Android push для звонков и сообщений

Java backend поддерживает регистрацию FCM-токенов через защищённые эндпоинты
`POST` и `DELETE /api/v1/push/devices` с JSON `{ "token": "..." }`.
Для отправки push задайте `ABV_FCM_SERVICE_ACCOUNT_FILE` — путь к Firebase
service-account JSON с доступом к Firebase Cloud Messaging. Секретный JSON
храните вне репозитория. Если FCM настроен и у вызываемого есть устройство,
сервер оставит звонок в `ringing` и отправит Android data push. Новое сообщение
также отправляет push получателям, кроме отправителя. В push сообщения передаётся
только тип события, без текста и имени отправителя; приложение показывает
нейтральное уведомление. Без настроенного FCM для звонков действует прежнее
поведение, а уведомления о сообщениях не отправляются.

Android-клиент находится в папке `android/` этого репозитория. Для push используйте
`google-services.json`, разрешение на уведомления и обработчик входящего FCM.

- Хаб в памяти процесса (как в Go-треке): при нескольких инстансах нужны
  sticky sessions или Redis Pub/Sub.
- TURN по умолчанию не настроен — звонки через симметричный NAT не
  устанавливаются (общее ограничение продукта v1).
- Docker-образ Java-API не поставляется: API запускается локально jar'ом,
  PostgreSQL — из `docker compose`. Для полной контейнеризации нужен сетевой
  доступ к Maven Central при сборке образа (multi-stage).
- Упаковка jar требует однократной загрузки артефактов плагинов с Maven
  Central: локальный кэш Maven по умолчанию не содержит их (в отличие от
  рантайм-зависимостей). Дальше — офлайн.
- Реализация v0.1: паритет по контракту подтверждён смоук-тестом Go-трека;
  отдельные Java-тесты добавляются по мере стабилизации модулей.
