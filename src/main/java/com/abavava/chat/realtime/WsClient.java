package com.abavava.chat.realtime;

import com.abavava.chat.contract.CallCommands;
import com.abavava.chat.contract.ChatCommands;
import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.Call;
import com.abavava.chat.domain.Events;
import com.abavava.chat.domain.Message;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Одно WebSocket-соединение: исходящая очередь, поток-писатель и разбор
 * клиентских команд. Аналог internal/realtime/client.go.
 *
 * <p>Почему отдельный поток-писатель: {@code session.sendMessage} блокируется на
 * медленном клиенте (TCP/буфер отправки), а рассылка событий идёт из потоков
 * сервисов chat/call. поэтому отправка вынесена в собственную очередь ёмкостью
 * {@code abv.ws.max-send-buffer}; переполнение означает, что клиент не успевает
 * читать, и соединение закрывается (медленный клиент не тормозит остальных).
 *
 * <p>Порядок событий внутри соединения сохраняется: единственный писатель берёт
 * события из FIFO-очереди строго по одному.
 */
public class WsClient {

    /** Ожидание элемента очереди: позволяет быстро заметить закрытие соединения. */
    private static final long POLL_MILLIS = 200L;

    private static final Logger log = LoggerFactory.getLogger(WsClient.class);

    private final Hub hub;
    private final WebSocketSession session;
    private final UUID userId;
    private final String sessionId;
    private final ObjectProvider<ChatCommands> chat;
    private final ObjectProvider<CallCommands> calls;
    private final ObjectMapper mapper;

    private final BlockingQueue<Events.Envelope> outbound;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private volatile ExecutorService writer;

    public WsClient(Hub hub,
                    WebSocketSession session,
                    UUID userId,
                    ObjectProvider<ChatCommands> chat,
                    ObjectProvider<CallCommands> calls,
                    ObjectMapper mapper,
                    int sendBufferSize) {
        this.hub = hub;
        this.session = session;
        this.userId = userId;
        this.sessionId = UUID.randomUUID().toString();
        this.chat = chat;
        this.calls = calls;
        this.mapper = mapper;
        this.outbound = new ArrayBlockingQueue<>(sendBufferSize);
    }

    /** Владелец соединения. */
    public UUID userId() {
        return userId;
    }

    /** Идентификатор соединения (для логов и hello). */
    public String sessionId() {
        return sessionId;
    }

    /** Запускает поток-писатель. */
    public void start() {
        ExecutorService executor = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "ws-writer-" + sessionId);
            thread.setDaemon(true);
            return thread;
        });
        writer = executor;
        executor.execute(this::writeLoop);
    }

    /**
     * Ставит событие в очередь. {@code false} — очередь переполнена либо
     * соединение уже закрывается.
     */
    public boolean enqueue(Events.Envelope event) {
        if (event == null) {
            return true;
        }
        if (closed.get()) {
            return false;
        }
        return outbound.offer(event);
    }

    /** Ставит событие в очередь; при переполнении закрывает соединение. */
    public void sendEvent(Events.Envelope event) {
        if (!enqueue(event)) {
            log.warn("dropping slow websocket client: user_id={} session_id={}", userId, sessionId);
            closeWithReason("client is too slow");
        }
    }

    /** Закрывает соединение медленного клиента. */
    public void closeSlow() {
        closeWithReason("client is too slow");
    }

    /**
     * Закрывает соединение один раз, с кодом 1000 и причиной (клиент видит
     * {@code reason} и решает, показывать ли ошибку). Идемпотентно.
     */
    public void closeWithReason(String reason) {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        synchronized (this) {
            try {
                if (session.isOpen()) {
                    session.close(new CloseStatus(CloseStatus.NORMAL.getCode(), reason));
                }
            } catch (IOException | RuntimeException e) {
                log.debug("websocket close failed: user_id={} session_id={} reason={}",
                        userId, sessionId, e.toString());
            }
        }
        ExecutorService executor = writer;
        if (executor != null) {
            executor.shutdown();
        }
    }

    // ------------------------------------------------------------ поток отправки

    private void writeLoop() {
        try {
            while (!closed.get()) {
                Events.Envelope event;
                try {
                    event = outbound.poll(POLL_MILLIS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                if (event == null) {
                    continue;
                }
                if (!session.isOpen()) {
                    break;
                }
                String json;
                try {
                    json = mapper.writeValueAsString(event);
                } catch (RuntimeException e) {
                    // Сериализация payload'а — ошибка уровня приложения: событие
                    // теряем, но соединение сохраняем (как в Go с WriteJSON).
                    log.warn("websocket serialize failed: user_id={} session_id={} type={} reason={}",
                            userId, sessionId, event.type(), e.toString());
                    continue;
                }
                try {
                    session.sendMessage(new TextMessage(json));
                } catch (IOException | RuntimeException e) {
                    log.warn("websocket write failed: user_id={} session_id={} reason={}",
                            userId, sessionId, e.toString());
                    break;
                }
            }
        } finally {
            // Писатель завершился — соединение больше не обслуживается.
            hub.unregister(this);
            closeWithReason("connection closed");
        }
    }

    // ------------------------------------------------------- разбор входящих

    /**
     * Обрабатывает один входящий текстовый кадр. Битый JSON, неизвестный тип и
     * ошибки команд дают событие {@code error} с {@code ref} = id клиентского
     * события; соединение при этом НЕ закрывается (docs/WS-PROTOCOL.md).
     */
    public void handleMessage(WebSocketSession session, String raw) {
        if (session != null && !session.isOpen()) {
            return;
        }
        String ref = "";
        try {
            Map<String, Object> frame = parseFrame(raw);
            Object id = frame.get("id");
            ref = id instanceof String text ? text : "";
            Object type = frame.get("type");
            String eventType = type instanceof String text ? text : "";
            dispatch(eventType, ref, frame.get("data"));
        } catch (AbvException e) {
            replyError(ref, e);
        } catch (RuntimeException e) {
            replyError(ref, AbvException.internal(e));
        }
    }

    /**
     * Конверт входящего события как есть. Значения читаются из JSON без
     * «строгого» связывания: важна только форма конверта, а тип data
     * проверяется в {@link #requireData(Object)}.
     */
    private Map<String, Object> parseFrame(String raw) {
        if (raw == null || raw.isBlank()) {
            throw AbvException.invalid("malformed_frame: event must be a json object");
        }
        Object parsed;
        try {
            parsed = mapper.readValue(raw, Map.class);
        } catch (RuntimeException e) {
            throw AbvException.invalid("malformed_frame: event must be a json object");
        }
        if (!(parsed instanceof Map<?, ?> map)) {
            throw AbvException.invalid("malformed_frame: event must be a json object");
        }
        return asObjectMap(map);
    }

    /** Обработка события по типу; неизвестный тип — invalid_request. */
    private void dispatch(String type, String ref, Object rawData) {
        switch (type) {
            case Events.PING -> sendEvent(Events.newEventWithId(Events.PONG, ref, Map.of("ts", Instant.now())));
            case Events.MESSAGE_SEND -> handleMessageSend(ref, rawData);
            case Events.MESSAGE_READ -> handleMessageRead(ref, rawData);
            case Events.TYPING -> handleTyping(ref, rawData);
            case Events.CALL_ACCEPT -> handleCallAccept(ref, rawData);
            case Events.CALL_REJECT -> handleCallReject(ref, rawData);
            case Events.CALL_END -> handleCallEnd(ref, rawData);
            case Events.CALL_SIGNAL -> handleCallSignal(ref, rawData);
            default -> throw AbvException.invalid("unsupported event type: " + type);
        }
    }

    /**
     * Фаза отправки сообщения. ack с созданным сообщением приходит клиенту
     * дополнительно к {@code message.new}, который сервис чата уже разослал
     * участникам: клиент помечает оптимистично отрисованное сообщение
     * доставленным по {@code client_id}.
     */
    private void handleMessageSend(String ref, Object rawData) {
        Map<String, Object> data = requireData(rawData);
        UUID conversationId = uuid(data, "conversation_id");
        if (conversationId == null) {
            throw AbvException.invalidField("conversation_id", "conversation_id is required");
        }
        ChatCommands.SendResult result = chatCommands()
                .sendMessage(userId, conversationId, string(data, "body"), string(data, "client_id"));
        Message message = result == null ? null : result.message();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("message", message);
        ack(ref, payload);
    }

    private void handleMessageRead(String ref, Object rawData) {
        Map<String, Object> data = requireData(rawData);
        UUID conversationId = uuid(data, "conversation_id");
        UUID messageId = uuid(data, "message_id");
        if (conversationId == null || messageId == null) {
            throw AbvException.invalid("conversation_id and message_id are required");
        }
        chatCommands().markRead(userId, conversationId, messageId);
        ack(ref, null);
    }

    /**
     * Индикатор набора — некритичное событие: ошибку только логируем и НЕ
     * отвечаем error-событием, чтобы не засорять поток клиента (как в Go).
     */
    private void handleTyping(String ref, Object rawData) {
        Map<String, Object> data = requireData(rawData);
        UUID conversationId = uuid(data, "conversation_id");
        if (conversationId == null) {
            throw AbvException.invalidField("conversation_id", "conversation_id is required");
        }
        ChatCommands commands = chat.getIfAvailable();
        if (commands == null) {
            log.debug("typing ignored, chat service is not available: user_id={} ref={}", userId, ref);
            return;
        }
        try {
            commands.typing(userId, conversationId, string(data, "state"));
        } catch (RuntimeException e) {
            log.debug("typing command failed: user_id={} reason={}", userId, e.toString());
        }
    }

    private void handleCallAccept(String ref, Object rawData) {
        Call call = callCommands().accept(userId, requiredCallId(rawData));
        ackCall(ref, call);
    }

    private void handleCallReject(String ref, Object rawData) {
        Map<String, Object> data = requireData(rawData);
        Call call = callCommands().reject(userId, requiredCallId(data), string(data, "reason"));
        ackCall(ref, call);
    }

    private void handleCallEnd(String ref, Object rawData) {
        Map<String, Object> data = requireData(rawData);
        Call call = callCommands().end(userId, requiredCallId(data), string(data, "reason"));
        ackCall(ref, call);
    }

    /** Транзит SDP/ICE второму участнику; payload сервер не интерпретирует. */
    private void handleCallSignal(String ref, Object rawData) {
        Map<String, Object> data = requireData(rawData);
        UUID callId = requiredCallId(data);
        Object raw = data.get("payload");
        Map<String, Object> signal;
        if (raw == null) {
            signal = null;
        } else if (raw instanceof Map<?, ?> map) {
            signal = asObjectMap(map);
        } else {
            throw AbvException.invalid("event data is malformed");
        }
        callCommands().signal(userId, callId, signal);
        ack(ref, null);
    }

    private UUID requiredCallId(Object rawData) {
        return requiredCallId(requireData(rawData));
    }

    private static UUID requiredCallId(Map<String, Object> data) {
        UUID callId = uuid(data, "call_id");
        if (callId == null) {
            throw AbvException.invalidField("call_id", "call_id is required");
        }
        return callId;
    }

    private void ackCall(String ref, Call call) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("call", call);
        ack(ref, payload);
    }

    /** ack: подтверждение обработки команды, ref = id клиентского события. */
    private void ack(String ref, Object data) {
        sendEvent(Events.newEventWithId(Events.ACK, ref, new Events.AckPayload(ref, true, data)));
    }

    /** error: код и безопасный для клиента текст; внутренние детали не отдаём. */
    private void replyError(String ref, AbvException e) {
        if (e.code() == AbvException.Code.INTERNAL) {
            log.error("websocket command failed: user_id={} ref={}", userId, ref, e);
            sendEvent(Events.newEventWithId(Events.ERROR, ref,
                    new Events.ErrorPayload(ref, e.code().json(), "internal error")));
            return;
        }
        sendEvent(Events.newEventWithId(Events.ERROR, ref,
                new Events.ErrorPayload(ref, e.code().json(), e.getMessage())));
    }

    // ------------------------------------------------------------- помощники

    /** data обязана быть JSON-объектом; null — поля нет (как json.RawMessage в Go). */
    private static Map<String, Object> requireData(Object rawData) {
        if (rawData == null) {
            throw AbvException.invalid("event data is required");
        }
        if (!(rawData instanceof Map<?, ?> map)) {
            throw AbvException.invalid("event data is malformed");
        }
        return asObjectMap(map);
    }

    /** UUID из data: null — поле отсутствует; иначе значение обязано быть UUID. */
    private static UUID uuid(Map<String, Object> data, String field) {
        Object value = data.get(field);
        if (value == null) {
            return null;
        }
        if (!(value instanceof String text)) {
            throw AbvException.invalid("event data is malformed");
        }
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            throw AbvException.invalid("event data is malformed");
        }
        try {
            return UUID.fromString(trimmed);
        } catch (IllegalArgumentException e) {
            throw AbvException.invalid("event data is malformed");
        }
    }

    /** Строковое поле data; отсутствующее или не строковое значение → null. */
    private static String string(Map<String, Object> data, String field) {
        Object value = data.get(field);
        return value instanceof String text ? text : null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asObjectMap(Map<?, ?> map) {
        return (Map<String, Object>) map;
    }

    /** Сервис чата; отсутствует только в unit-сценариях без chat-слоя. */
    private ChatCommands chatCommands() {
        ChatCommands commands = chat.getIfAvailable();
        if (commands == null) {
            throw AbvException.internal(new IllegalStateException("chat service is not available"));
        }
        return commands;
    }

    /** Сервис звонков; отсутствует только в unit-сценариях без call-слоя. */
    private CallCommands callCommands() {
        CallCommands commands = calls.getIfAvailable();
        if (commands == null) {
            throw AbvException.internal(new IllegalStateException("call service is not available"));
        }
        return commands;
    }
}
