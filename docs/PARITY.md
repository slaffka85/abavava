# Паритет реализаций abavava и abavava-go

Матрица соответствия `chat-abavava` (Go, эталон) ↔ `chat-abavava-java`.
Обе реализации должны быть взаимозаменяемы для клиента: одинаковые пути,
HTTP-коды, формы JSON, коды ошибок и WS-события.

Статусы: ✅ реализовано и подтверждено смоуком, 🟡 в работе, ⛔ не реализовано.

## Контракт

| Что | Go-источник | Java | Статус |
|---|---|---|---|
| REST-пути и коды | `internal/app/app.go`, `docs/API.md` | `http`, модули | ✅ |
| Ошибки: коды/формат | `internal/httpx/json.go`, `internal/domain/errors.go` | `http/Httpx`, `domain/AbvException` | ✅ |
| WS-конверт/события | `internal/domain/events.go`, `docs/WS-PROTOCOL.md` | `domain/Events.java` | ✅ |
| Схема БД | `migrations/0001_init.sql` | `resources/migrations/0001_init.sql` (копия) | ✅ |
| Origin/CORS | `internal/httpx/origin.go` | `http/Httpx.originAllowed` | ✅ |

## Эндпоинты

| Метод/путь | Статус | Примечание |
|---|---|---|
| GET /healthz, /readyz (+ /api/v1) | ✅ | /readyz пингует БД |
| POST /api/v1/auth/register | ✅ | bcrypt cost 12, 201 |
| POST /api/v1/auth/login | ✅ | единый ответ на неверные данные, 200 |
| POST /api/v1/auth/refresh | ✅ | ротация + обнаружение кражи (revoke all) |
| POST /api/v1/auth/logout | ✅ | 204, идемпотентно |
| GET /api/v1/me, PATCH /api/v1/me | ✅ | |
| GET /api/v1/users, /users/{id} | ✅ | |
| GET /api/v1/conversations (+cursor) | ✅ | keyset-пагинация, next_cursor |
| POST /api/v1/conversations | ✅ | direct 200/201, group 201 |
| GET /api/v1/conversations/{id} | ✅ | |
| GET .../messages | ✅ | keyset before, has_more |
| POST .../messages | ✅ | 201/200, идемпотентность client_id |
| POST .../read, .../typing | ✅ | 204 |
| POST .../members, DELETE .../members/{id} | ✅ | owner-only |
| POST /api/v1/calls | ✅ | 201, call.created/call.incoming |
| GET /api/v1/calls, /calls/{id} | ✅ | peer в модели |
| POST /calls/{id}/accept|reject|end | ✅ | compare-and-set переходы |
| GET /api/v1/config/ice | ✅ | STUN + опциональный TURN |
| GET /api/v1/status | ✅ | online_users/connections |
| GET /api/v1/ws | ✅ | token в query, origin-проверка |

## WebSocket-события

| type | Направление | Статус |
|---|---|---|
| hello, ping/pong, ack, error | сервер↔клиент | ✅ |
| presence (только собеседникам) | сервер→клиент | ✅ |
| message.new / message.read / typing | сервер→клиент и команды | ✅ |
| call.created / incoming / updated / signal | сервер→клиент и команды | ✅ |
| message.send/read, typing, call.accept/reject/end/signal | клиент→сервер | ✅ |

## Семантика, которую нельзя терять

- **Идемпотентность direct-диалога** — уникальный `direct_key` + `ON CONFLICT`.
- **Идемпотентность сообщений** — частичный уникальный индекс по `client_id`.
- **MarkRead двигается только вперёд** — `GREATEST`.
- **Один активный звонок** — частичные индексы `calls_one_active_as_*` и
  проверка ActiveForUser (любая роль).
- **Переходы звонков** — compare-and-set `WHERE id=? AND status=?`;
  проигравший получает 409 conflict.
- **Таймаут дозвона** — 45 с (ABV_CALL_RING_TIMEOUT), при рестарте зависшие
  ringing → missed (Reconcile).
- **Офлайн-вызываемый** — звонок сразу missed/reason=timeout, звонящему
  приходит call.updated.
- **Ошибки WS не рвут соединение** — malformed_frame/unsupported type → error.
- **Присутствие** — только для собеседников по общим диалогам (PeersOf).

## Особенности, выявленные паритетным тестом

- **hello — первый кадр соединения.** В Go handler отправляет hello сразу
  после апгрейда, а presence-события о собеседниках приходят позже; в Java
  при регистрации в хабе до hello presence мог «обогнать» hello и быть
  отброшенным клиентом, ждущим hello. Исправлено порядком: hello ставится в
  очередь до регистрации в хабе; смоук 15/15 подтверждает.
- **Снимок присутствия при подключении.** Если собеседник был онлайн до
  подключения клиента, Java дополнительно присылает ему presence(peer, online)
  на этапе подключения (Go полагается на пере-запрос контактов после коннекта).
  Для клиента это аддитивное событие; контракт presence не меняется.
- **Смоук Go-трека** прогнан против Java-API на реальном PostgreSQL:
  **15 из 15 проверок** (включая полный цикл звонка), exit code 0.

## Допустимые расхождения

- Сериализация времени: RFC3339 (Java `Instant.toString()`), как Go `time.Time`.
- Реализация таймеров/очередей WS (Spring WebSocket vs gorilla) — внутреннее.
- Идемпотентные повторы refresh: Java и Go выдают новую пару — контракт один.
- `details` в ошибках — только там, где Go их заполняет (field).

## Как проверяется

1. `build.ps1 check` — офлайн: компиляция + unit-тесты Java.
2. Поднятая PostgreSQL (`docker compose up -d postgres`), запущенный Java-API.
3. `go run ./cmd/smoke -base http://127.0.0.1:8082` из `chat-abavava`:
   регистрация, два WS, presence, message.new+ack, идемпотентность, read,
   typing, полный цикл звонка (created→accept→signal→end→history).
4. Статус выставляется ✅ только после зелёного smoke (сейчас — зелёный).
