# HTTP Client

IntelliJ IDEA HTTP Client для вызова API chat-abavava-java.

## Быстрый старт

1. Открой `http-client.http`
2. Переключи окружение: **Ctrl+Shift+P** (Mac: **Cmd+Shift+P**)
   - `local` — `http://localhost:8082`
   - `dev` — `http://dev.abavava.example.com:8082`
3. Нажми **Send Request** (зелёная стрелка) рядом с нужным запросом

## Демо-данные

Запусти с `ABV_SEED=true` или `--seed`:

| Email | Password |
|---|---|
| `anya@example.com` | `password123` |
| `pavel@example.com` | `password123` |
| `test` | `test` |

## Структура

| Файл | Назначение |
|---|---|
| `http-client.http` | 26 запросов: auth, users, chat, calls, config |
| `.http-env.json` | Переменные окружений (local, dev) |

## Переменные

| Переменная | Описание |
|---|---|
| `{{base_url}}` | Базовый URL API (автоматически из `.http-env.json`) |
| `{{access_token}}` | Access-токен (сохраняется после login) |
| `{{refresh_token}}` | Refresh-токен (сохраняется после login) |

Токены сохраняются автоматически после успешного login/refresh — все последующие запросы с `Authorization: Bearer {{access_token}}` подставят их сами.

## Список запросов

- **Auth**: register, login, refresh, logout
- **Users**: me, patch, list, get by ID
- **Chat**: conversations (list/create), messages (send/read/typing/history), typing
- **Calls**: create, list, accept, end
- **Config**: ICE, health, ready, status
- **Members**: add/remove
