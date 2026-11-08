# abavava — WebSocket протокол и WebRTC-сигналинг

## Подключение

```
GET ws://localhost:8080/api/v1/ws?token=<access_token>
```

* Токен передаётся query-параметром: браузерный `WebSocket` не умеет ставить заголовки. Токен — короткоживущий access-токен.
* `401` до апгрейда, если токен отсутствует/просрочен. Клиент обязан обновить токен через `/auth/refresh` и переподключиться.
* Одно соединение на устройство; несколько соединений одного пользователя допускаются (мультидевайс) — события доставляются во все.
* Сразу после апгрейда сервер отправляет `hello`.

## Конверт сообщения

```jsonc
{
  "v": 1,
  "type": "message.send",
  "id": "8f2b...",          // id события, генерирует отправитель (uuid); сервер тоже заполняет
  "ts": "2025-01-31T12:00:00Z",
  "data": { }
}
```

* Неизвестный `type` → ответ `error` с кодом `invalid_request` и текстом `unsupported event type: <тип>`; соединение сохраняется.
* Лимит входящего фрейма — 64 KiB (текст сообщения ≤ 4000 символов).
* Битый JSON → `error` `invalid_request` с текстом `malformed_frame: ...`, соединение сохраняется.

## Heartbeat

Клиент шлёт `ping` каждые 25 с; сервер отвечает `pong`. Сервер считает соединение мёртвым, если не получал ни одного фрейма 60 с, и закрывает его (`close 1000`, `reason: heartbeat timeout`). Клиент переподключается с экспоненциальной задержкой (0.5 s → 15 s, с jitter).

## Клиент → сервер

| `type` | `data` | Назначение |
|---|---|---|
| `ping` | `{}` | heartbeat |
| `message.send` | `{ conversation_id, body, client_id, kind? }` | отправка сообщения |
| `message.read` | `{ conversation_id, message_id }` | отметка прочтения |
| `typing` | `{ conversation_id, state: "start"\|"stop" }` | индикатор набора |
| `call.accept` | `{ call_id }` | принять входящий |
| `call.reject` | `{ call_id, reason? }` | отклонить |
| `call.end` | `{ call_id, reason? }` | завершить |
| `call.signal` | `{ call_id, payload }` | SDP/ICE для WebRTC (см. ниже) |

## Сервер → клиент

| `type` | `data` | Когда |
|---|---|---|
| `hello` | `{ session_id, user_id, server_time, heartbeat_interval_seconds }` | после апгрейда |
| `pong` | `{ ts }` | ответ на `ping` |
| `ack` | `{ ref, ok: true, data? }` | подтверждение обработки события (`ref` = `id` клиента) |
| `error` | `{ ref?, code, message }` | ошибка обработки; коды: `invalid_request`, `validation_failed`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `internal` |
| `presence` | `{ user_id, status: "online"\|"offline", last_seen_at }` | смена статуса (рассылается тем, с кем есть общий диалог) |
| `message.new` | `{ message: Message }` | новое сообщение в диалоге пользователя |
| `message.read` | `{ conversation_id, user_id, message_id, read_at }` | собеседник прочитал |
| `typing` | `{ conversation_id, user_id, state }` | набор текста (не эхо отправителю) |
| `call.created` | `{ call: Call }` | звонящему после `POST /calls` |
| `call.incoming` | `{ call: Call }` | вызываемому при `ringing` |
| `call.updated` | `{ call: Call }` | смена состояния (accepted/rejected/ended/missed/canceled) обоим |
| `call.signal` | `{ call_id, from, payload }` | транзит SDP/ICE между участниками |

`ack` приходит и на `message.send` с созданным сообщением:
```json
{ "v":1, "type":"ack", "data": { "ref":"c-1", "ok": true, "data": { "message": { } } } }
```
Клиент помечает оптимистично отрисованное сообщение (`client_id`) как доставленное; при `error` с тем же `ref` — как ошибочное (кнопка «повторить»).

## WebRTC-сигналинг (аудио/видео 1:1)

Медиа идёт peer-to-peer, сервер только транзитом передаёт SDP/ICE (никакого медиатрафика через backend).

1. **Инициатор**: `POST /api/v1/calls {callee_id, kind}` → `call.id`, статус `ringing`. Создаётся `RTCPeerConnection`, добавляются локальные треки (`getUserMedia({audio:true, video: kind === "video"})`), создаётся offer, отправляется:
   ```json
   { "type":"call.signal", "data": { "call_id":"...", "payload": { "type":"offer", "sdp":"v=0..." } } }
   ```
2. **Вызываемый** получает `call.incoming`; при нажатии «Принять» шлёт `call.accept`, сервер переводит звонок в `accepted` и рассылает `call.updated`. Затем вызываемый создаёт свой `RTCPeerConnection`, ставит треки, применяет offer, отправляет `answer` через `call.signal`.
3. **ICE**: обе стороны шлют кандидатов:
   ```json
   { "payload": { "type":"candidate", "candidate":"candidate:...", "sdp_mid":"0", "sdp_mline_index":0 } }
   ```
   Непустые кандидаты буферизуются до установки remote description. Пустой `candidate` (end-of-candidates) не пересылается.
4. **Роль polite/impolite (perfect negotiation)**: `polite = (myUserID > peerUserID)` — сравнение строк UUID. Формула симметрична, поэтому обе стороны независимо приходят к согласию: ровно один участник polite, второй impolite. Звонящий обычно оказывается impolite, но **роль определяется только формулой**, а не тем, кто инициировал звонок: именно от неё зависит разрешение коллизии offer'ов. При коллизии impolite-сторона игнорирует входящий offer (её собственный побеждает), polite-сторона откатывает свой локальный offer (`setLocalDescription({type:"rollback"})`) и принимает входящий. Это позволяет добавлять треки на лету (включение камеры во время аудиозвонка) без пересборки соединения.
5. **Завершение**: `call.end` → сервер фиксирует `ended_at`, `duration_seconds`, `end_reason` (`hangup`/`canceled`/`rejected`/`timeout`/`failed`) и рассылает `call.updated`; клиенты закрывают `RTCPeerConnection` и останавливают локальные треки.
6. **Недоступен**: если вызываемый не имеет активного WS-соединения, сервер всё равно создаёт `ringing`-запись (история сохраняется) и через `ABV_CALL_RING_TIMEOUT` помечает её `missed` с `end_reason=timeout`. Инициатор сразу получает `call.updated {status:"missed"}` — UI показывает «нет ответа».

### ICE-серверы

Клиент получает конфиг из `GET /api/v1/config/ice` (или встроенный дефолт):
```json
{ "ice_servers": [ { "urls": ["stun:stun.l.google.com:19302"] } ] }
```
Для работы через NAT/симметричные фаерволы нужен TURN — задаётся переменными `ABV_TURN_URL`, `ABV_TURN_USERNAME`, `ABV_TURN_CREDENTIAL` и подмешивается в тот же ответ. Без TURN возможны отказы соединения в мобильных сетях — известное ограничение v1.

## Порядок и надёжность

* Сервер гарантирует порядок событий внутри одного соединения; порядок между соединениями одного пользователя не гарантирован — клиент сортирует сообщения по `created_at`, `id`.
* Пропущенные во время разрыва события не «догоняются» по WS: клиент после реконнекта вызывает `GET /conversations` и `GET /conversations/{id}/messages?before=` для актуализации.
* Активные звонки: после реконнекта клиент вызывает `GET /calls?limit=1` и, если звонок в статусе `ringing`/`accepted`, продолжает его (WS-события идемпотентны по `call_id`).
