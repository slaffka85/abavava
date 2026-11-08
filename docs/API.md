# abavava — REST API (v1)

Базовый URL: `http://localhost:8080/api/v1`
Формат: JSON, `snake_case`. Даты — RFC3339 UTC (`2025-01-31T12:00:00Z`).
Все защищённые эндпоинты требуют заголовок `Authorization: Bearer <access_token>`.

## Формат ошибок

```json
{ "error": { "code": "invalid_request", "message": "email is required", "details": { "field": "email" } } }
```

| code | HTTP | Когда |
|---|---|---|
| `invalid_request` | 400 | битый JSON, отсутствуют поля |
| `validation_failed` | 422 | поля есть, но не проходят валидацию |
| `unauthorized` | 401 | нет/просрочен/битый access-токен, неверный пароль |
| `forbidden` | 403 | нет доступа к ресурсу |
| `not_found` | 404 | ресурс не существует |
| `conflict` | 409 | email занят, звонок уже завершён |
| `rate_limited` | 429 | превышен лимит |
| `internal` | 500 | внутренняя ошибка |

## Модели

```jsonc
// User
{ "id": "uuid", "email": "a@b.c", "display_name": "Аня", "avatar_url": null,
  "created_at": "2025-01-31T12:00:00Z", "last_seen_at": "2025-01-31T12:05:00Z" }

// Message
{ "id": "uuid", "conversation_id": "uuid", "sender_id": "uuid",
  "kind": "text",                    // text | system | call
  "body": "привет", "client_id": "c-1",
  "created_at": "2025-01-31T12:00:00Z", "edited_at": null, "deleted_at": null }

// ConversationView
{ "conversation": { "id": "uuid", "kind": "direct",  // direct | group
                    "title": null, "created_by": "uuid",
                    "created_at": "...", "updated_at": "...", "last_message_at": "..." },
  "members": [ /* User */ ],
  "last_message": { /* Message */ } | null,
  "unread_count": 3 }

// Call
{ "id": "uuid", "conversation_id": "uuid", "caller_id": "uuid", "callee_id": "uuid",
  "kind": "video",                   // audio | video
  "status": "ringing",               // ringing | accepted | rejected | missed | ended | failed | canceled
  "created_at": "...", "answered_at": null, "ended_at": null,
  "ended_by": null, "end_reason": null,
  "duration_seconds": 0,
  "peer": { /* User — собеседник относительно запросившего */ } }
```

## Health

| Метод | Путь | Описание |
|---|---|---|
| GET | `/healthz` | liveness, `{"status":"ok"}` (также доступен как `/api/v1/healthz`) |
| GET | `/readyz` | readiness + пинг БД, `{"status":"ok","db":"ok"}` |
| GET | `/status` | 🔒 диагностика транспорта: `{"online_users":2,"connections":3,"server_time":"..."}` |

## Auth

### POST `/auth/register`
```json
{ "email": "a@b.c", "display_name": "Аня", "password": "secret123" }
```
`201` → `{ "user": User, "access_token": "...", "refresh_token": "...", "expires_in": 900 }`
Ошибки: `422` (пароль < 8 символов, email невалиден), `409` (email занят).

### POST `/auth/login`
```json
{ "email": "a@b.c", "password": "secret123" }
```
`200` → как у register. `401` при неверных данных (сообщение общее, без раскрытия).

### POST `/auth/refresh`
```json
{ "refresh_token": "..." }
```
`200` → новая пара токенов (refresh ротируется: старый становится недействительным).
`401`, если токен неизвестен, просрочен или отозван.

### POST `/auth/logout`
```json
{ "refresh_token": "..." }
```
`204`. Отзывает refresh-токен. Идемпотентно.

### GET `/me`
`200` → `{ "user": User }`

### PATCH `/me`
```json
{ "display_name": "Аня П.", "avatar_url": "https://..." }
```
`200` → `{ "user": User }`

## Пользователи

| Метод | Путь | Описание |
|---|---|---|
| GET | `/users?q=<подстрока>&limit=20` | поиск по `display_name`/`email`, исключая себя |
| GET | `/users/{id}` | профиль; `404`, если нет |

## Диалоги

### GET `/conversations?limit=50&cursor=<last_message_at>`
`200` → `{ "items": [ConversationView], "next_cursor": "..." | null }`, отсортировано по `last_message_at desc nulls last`.

### POST `/conversations`
Direct (идемпотентно — повторный запрос возвращает тот же диалог, `200` вместо `201`):
```json
{ "kind": "direct", "peer_id": "uuid" }
```
Группа:
```json
{ "kind": "group", "title": "Команда", "member_ids": ["uuid", "uuid"] }
```
`201` → `ConversationView`. Ошибки: `404` (peer не существует), `422`.

### GET `/conversations/{id}`
`200` → `ConversationView`. `403`, если пользователь не участник.

### POST `/conversations/{id}/members` (только группа, владелец)
```json
{ "user_ids": ["uuid"] }
```
`200` → `ConversationView`

### DELETE `/conversations/{id}/members/{user_id}`
`204`. Владелец может удалить любого, участник — только себя (выход). В UI участник видит «выйти», владелец — «удалить».

### GET `/conversations/{id}/messages?limit=50&before=<message_id>`
Keyset-пагинация назад по времени. `200` → `{ "items": [Message], "has_more": true }`
`items` — от старых к новым внутри страницы.

### POST `/conversations/{id}/messages`
```json
{ "body": "привет", "client_id": "c-1" }
```
`201` → `{ "message": Message }`. Сервер также шлёт `message.new` всем участникам по WS.
`client_id` обеспечивает идемпотентность: повтор с тем же `client_id` возвращает `200` и уже созданное сообщение.

### POST `/conversations/{id}/read`
```json
{ "message_id": "uuid" }
```
`204`. Обновляет `last_read`, рассылает `message.read` по WS.

### POST `/conversations/{id}/typing`
```json
{ "state": "start" }
```
`204`. REST-дубль WS-события `typing` (для клиентов без WS).

## Звонки

Состояния: `ringing → accepted → ended`; из `ringing` возможны `rejected`, `canceled` (звонящий отменил), `missed` (таймаут 45 с).
Терминальные: `ended`, `rejected`, `missed`, `failed`, `canceled`.

### POST `/calls`
```json
{ "callee_id": "uuid", "kind": "video", "conversation_id": "uuid" }
```
`conversation_id` опционален: если не указан, создаётся/находится direct-диалог с `callee_id`.
`201` → `{ "call": Call }`. Калильщик получает `call.created`, вызываемый — `call.incoming` по WS.
`409`, если у участника уже есть активный звонок.

### GET `/calls?limit=50`
История (и входящие, и исходящие), сортировка по `created_at desc`.
`200` → `{ "items": [Call] }`

### GET `/calls/{id}`
`200` → `{ "call": Call }` (только участники).

### POST `/calls/{id}/accept` · `/reject` · `/end`
Тело опционально: `{ "reason": "hangup" }`.
`200` → `{ "call": Call }`. Оба участника получают `call.updated` по WS.
`409`, если переход состояния недопустим (например, `end` уже завершённого звонка).

## WebSocket

Описание протокола и WebRTC-сигналинга: см. `docs/WS-PROTOCOL.md`.
Эндпоинт: `GET /api/v1/ws?token=<access_token>` (тот же origin, что и REST).

## Переменные окружения (backend)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `ABV_HTTP_ADDR` | `:8080` | адрес прослушивания |
| `ABV_DATABASE_URL` | `postgres://abv:abv@localhost:5432/abv?sslmode=disable` | DSN PostgreSQL |
| `ABV_JWT_SECRET` | `dev-insecure-secret-change-me` | ключ подписи HS256 |
| `ABV_ACCESS_TTL` | `15m` | время жизни access-токена |
| `ABV_REFRESH_TTL` | `720h` | время жизни refresh-токена |
| `ABV_CALL_RING_TIMEOUT` | `45s` | до перевода в `missed` |
| `ABV_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174` | CORS и Origin у WebSocket (список через запятую) |
| `ABV_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
