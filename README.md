# chat-abavava-java

Второй бэкенд **chat-abavava** — параллельный трек: тот же продукт и тот же
контракт, что у Go-реализации, но на **Java 26 + Spring Boot 4.1 + Spring
Data JDBC**.

Клиент (React SPA из `chat-abavava/web`) работает с любым из двух бэкендов:
REST `/api/v1` и WebSocket-протокол v1 идентичны. Параллельная работа команд
описана в [docs/TEAM.md](docs/TEAM.md), матрица паритета — в
[docs/PARITY.md](docs/PARITY.md).

**Стек:** Java 26 · Spring Boot 4.1.0 · Spring MVC · Spring Data JDBC /
JdbcClient · Spring WebSocket · PostgreSQL 16 · Maven (проверка и тесты —
офлайн на локальном кэше; упаковка jar — с однократной загрузкой артефактов
плагинов из Maven Central).

Паритет подтверждён: Go-смоук (`cmd/smoke`) против Java-API — **15/15**.

## Быстрый старт

```powershell
# 1. Задайте секрет JWT в текущей PowerShell-сессии
$env:ABV_JWT_SECRET = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))

# 2. PostgreSQL (своя БД, чтобы не мешать Go-треку)
docker compose up -d postgres            # порт 5433

# 2. Проверка компиляции и unit-тестов (офлайн)
powershell -ExecutionPolicy Bypass -File build.ps1 check

# 3. Исполняемый jar (первая сборка скачивает зависимости плагинов
#    с Maven Central; дальше работает кэш)
powershell -ExecutionPolicy Bypass -File build.ps1 package

# 4. Запуск API (:8082)
powershell -ExecutionPolicy Bypass -File build.ps1 run

# 5. Паритетный smoke-тест Go-трека против Java-API
powershell -ExecutionPolicy Bypass -File build.ps1 smoke
```

`build.ps1 run` запускает `target\chat-abavava-java-0.1.0-SNAPSHOT.jar`, а если
jar ещё не собран — стартует с classpath из локального Maven-кэша (без упаковки).

Демо-данные: `ABV_SEED=true powershell -File build.ps1 run` создаст тех же
трёх пользователей, что `cmd/seed` в Go-треке. Полноценная веб-часть — из
Go-трека (`chat-abavava`, `:8081`); открыть её против Java-API:

```bash
cd chat-abavava/web
VITE_API_BASE=http://127.0.0.1:8082 npm run dev
```

Проверка контракта Go-смоук-тестом (из соседнего проекта):

```powershell
cd ..\chat-abavava
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
| `ABV_DATABASE_URL` | `jdbc:postgresql://localhost:5433/abavava?sslmode=disable` | JDBC-URL PostgreSQL (формат `postgres://...` понимает только Go-трек) |
| `ABV_DATABASE_USERNAME` | `abavava` | пользователь БД |
| `ABV_DATABASE_PASSWORD` | `abavava` (только локальная БД Compose) | пароль БД; задайте отдельный секрет в production |
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
