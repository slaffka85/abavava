-- 0001_init.sql — базовая схема chat-abavava
-- Пользователи, refresh-токены, диалоги, сообщения, звонки.

-- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Универсальный триггер обновления updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL,
    display_name  TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    avatar_url    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ
);

-- email уникален без учёта регистра
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_display_name_idx ON users (lower(display_name));

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------- refresh_tokens
-- Хранится только SHA-256 хеш токена: утечка БД не даёт возможности войти.
CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    user_agent TEXT,
    ip         TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- --------------------------------------------------------- conversations
CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            TEXT        NOT NULL CHECK (kind IN ('direct', 'group')),
    title           TEXT,
    -- для direct: '<uuid_меньший>:<uuid_больший>' — гарантирует один диалог на пару
    direct_key      TEXT UNIQUE,
    created_by      UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ,
    CONSTRAINT conversations_direct_key_required
        CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);

CREATE INDEX conversations_last_message_idx
    ON conversations (last_message_at DESC NULLS LAST, id DESC);

CREATE TRIGGER conversations_set_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE conversation_members (
    conversation_id      UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    user_id              UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role                 TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id UUID,
    last_read_at         TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);

-- --------------------------------------------------------------- messages
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    sender_id       UUID REFERENCES users (id) ON DELETE SET NULL,
    kind            TEXT        NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system', 'call')),
    body            TEXT        NOT NULL DEFAULT '',
    client_id       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at       TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ
);

-- keyset-пагинация "назад во времени" внутри диалога
CREATE INDEX messages_conversation_created_idx
    ON messages (conversation_id, created_at DESC, id DESC);

-- идемпотентность повторной отправки с тем же client_id
CREATE UNIQUE INDEX messages_idempotency_key
    ON messages (conversation_id, sender_id, client_id)
    WHERE client_id IS NOT NULL;

-- новое сообщение обновляет активность диалога
CREATE OR REPLACE FUNCTION touch_conversation_on_message() RETURNS trigger AS $$
BEGIN
    UPDATE conversations
       SET last_message_at = NEW.created_at,
           updated_at      = now()
     WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_touch_conversation
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION touch_conversation_on_message();

-- ------------------------------------------------------------------ calls
CREATE TABLE calls (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID REFERENCES conversations (id) ON DELETE SET NULL,
    caller_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    callee_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind             TEXT        NOT NULL CHECK (kind IN ('audio', 'video')),
    status           TEXT        NOT NULL CHECK (
        status IN ('ringing', 'accepted', 'rejected', 'missed', 'ended', 'failed', 'canceled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at      TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ,
    ended_by         UUID REFERENCES users (id) ON DELETE SET NULL,
    end_reason       TEXT,
    duration_seconds INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT calls_distinct_parties CHECK (caller_id <> callee_id)
);

CREATE INDEX calls_caller_idx ON calls (caller_id, created_at DESC);
CREATE INDEX calls_callee_idx ON calls (callee_id, created_at DESC);

-- Не более одного активного звонка в роли звонящего и в роли вызываемого.
-- (Пользователь не может быть одновременно участником двух активных звонков:
--  комбинация обоих индексов + проверка в сервисном слое.)
CREATE UNIQUE INDEX calls_one_active_as_caller_idx
    ON calls (caller_id) WHERE status IN ('ringing', 'accepted');
CREATE UNIQUE INDEX calls_one_active_as_callee_idx
    ON calls (callee_id) WHERE status IN ('ringing', 'accepted');

-- Журнал событий звонка: диагностика сигналинга и разбор спорных ситуаций.
CREATE TABLE call_events (
    id         BIGSERIAL PRIMARY KEY,
    call_id    UUID        NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    actor_id   UUID REFERENCES users (id) ON DELETE SET NULL,
    type       TEXT        NOT NULL,
    payload    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX call_events_call_idx ON call_events (call_id, created_at);
