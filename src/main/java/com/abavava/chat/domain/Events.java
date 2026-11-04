package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * WebSocket-конверт и полезные нагрузки (docs/WS-PROTOCOL.md, v1).
 * JSON-имена полей — snake_case, как в Go-реализации.
 */
public final class Events {

    public static final int PROTOCOL_VERSION = 1;

    // Сервер → клиент, служебные
    public static final String HELLO = "hello";
    public static final String PONG = "pong";
    public static final String ACK = "ack";
    public static final String ERROR = "error";

    // Присутствие и индикаторы
    public static final String PRESENCE = "presence";
    public static final String TYPING = "typing";

    // Сообщения
    public static final String MESSAGE_NEW = "message.new";
    public static final String MESSAGE_READ = "message.read";

    // Звонки
    public static final String CALL_CREATED = "call.created";
    public static final String CALL_INCOMING = "call.incoming";
    public static final String CALL_UPDATED = "call.updated";
    public static final String CALL_SIGNAL = "call.signal";

    // Клиент → сервер
    public static final String PING = "ping";
    public static final String MESSAGE_SEND = "message.send";
    public static final String CALL_ACCEPT = "call.accept";
    public static final String CALL_REJECT = "call.reject";
    public static final String CALL_END = "call.end";

    private Events() {
    }

    /** Конверт события. Значение data — Object (payload-запись или Map). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Envelope(
            @JsonProperty("v") int v,
            @JsonProperty("type") String type,
            @JsonProperty("id") String id,
            @JsonProperty("ts") Instant ts,
            @JsonProperty("data") Object data
    ) {
    }

    public static Envelope newEvent(String type, Object data) {
        return new Envelope(PROTOCOL_VERSION, type, UUID.randomUUID().toString(), Instant.now(), data);
    }

    public static Envelope newEventWithId(String type, String id, Object data) {
        return new Envelope(PROTOCOL_VERSION, type, id, Instant.now(), data);
    }

    /** hello: после апгрейда. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record HelloPayload(
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("user_id") UUID userId,
            @JsonProperty("server_time") Instant serverTime,
            @JsonProperty("heartbeat_interval_seconds") int heartbeatIntervalSeconds
    ) {
    }

    /** ack: подтверждение обработки команды (ref = id клиентского события). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AckPayload(
            @JsonProperty("ref") String ref,
            @JsonProperty("ok") boolean ok,
            @JsonProperty("data") Object data
    ) {
    }

    /** error: ошибка обработки события. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ErrorPayload(
            @JsonProperty("ref") String ref,
            @JsonProperty("code") String code,
            @JsonProperty("message") String message
    ) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PresencePayload(
            @JsonProperty("user_id") UUID userId,
            @JsonProperty("status") String status,
            @JsonProperty("last_seen_at") Instant lastSeenAt
    ) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record TypingPayload(
            @JsonProperty("conversation_id") UUID conversationId,
            @JsonProperty("user_id") UUID userId,
            @JsonProperty("state") String state
    ) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MessageNewPayload(
            @JsonProperty("message") Message message
    ) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MessageReadPayload(
            @JsonProperty("conversation_id") UUID conversationId,
            @JsonProperty("user_id") UUID userId,
            @JsonProperty("message_id") UUID messageId,
            @JsonProperty("read_at") Instant readAt
    ) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CallPayload(
            @JsonProperty("call") Call call
    ) {
    }

    /** signal: транзит SDP/ICE между участниками звонка. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SignalPayload(
            @JsonProperty("call_id") UUID callId,
            @JsonProperty("from") UUID from,
            @JsonProperty("payload") Map<String, Object> payload
    ) {
    }
}
