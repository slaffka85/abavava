package com.abavava.chat.realtime;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.contract.CallCommands;
import com.abavava.chat.contract.ChatCommands;
import com.abavava.chat.domain.Events;
import com.abavava.chat.http.Httpx;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.adapter.standard.StandardWebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.UUID;

/**
 * Точка входа WebSocket: GET /api/v1/ws?token=... (аналог
 * internal/realtime/handler.go).
 *
 * <p>Аутентификация выполняется ДО апгрейда: {@link WsAuthFilter} отдаёт 401/403
 * в формате REST-ошибки, а {@link RealtimeConfig.UserHandshakeInterceptor}
 * повторно проверяет токен и кладёт id пользователя в атрибуты сессии
 * ({@link Httpx#USER_ID_ATTRIBUTE}). Если атрибута нет (например, соединение
 * пришло в обход цепочки фильтров) — соединение закрывается кодом 1008.
 *
 * <p>Одно соединение на устройство; несколько соединений одного пользователя
 * допускаются (мультидевайс) — {@link Hub} рассылает события во все.
 */
@Component
public class WsEndpointHandler extends TextWebSocketHandler {

    /** Ключ, под которым WsClient хранится в атрибутах сессии. */
    static final String CLIENT_ATTRIBUTE = "abv.ws_client";

    private static final Logger log = LoggerFactory.getLogger(WsEndpointHandler.class);

    private final Hub hub;
    private final ObjectProvider<ChatCommands> chat;
    private final ObjectProvider<CallCommands> calls;
    private final ObjectMapper mapper;
    private final AbvProperties props;

    public WsEndpointHandler(Hub hub,
                             ObjectProvider<ChatCommands> chat,
                             ObjectProvider<CallCommands> calls,
                             ObjectMapper mapper,
                             AbvProperties props) {
        this.hub = hub;
        this.chat = chat;
        this.calls = calls;
        this.mapper = mapper;
        this.props = props;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        session.setTextMessageSizeLimit(props.ws().maxFrameSize());
        applyIdleTimeout(session);

        UUID userId = userIdOf(session);
        if (userId == null) {
            log.warn("websocket session without authenticated user: session_id={}", session.getId());
            session.close(new CloseStatus(CloseStatus.POLICY_VIOLATION.getCode(), "unauthorized"));
            return;
        }

        WsClient client = new WsClient(hub, session, userId, chat, calls, mapper,
                props.ws().maxSendBuffer());
        session.getAttributes().put(CLIENT_ATTRIBUTE, client);
        // hello должен уйти первым кадром соединения (после него по этой же
        // очереди пойдут presence и остальные события). Поэтому регистрация в
        // хабе — после постановки hello в очередь: presence собеседникам
        // рассылается уже поверх установленного клиента.
        client.start();
        client.sendEvent(Events.newEvent(Events.HELLO, new Events.HelloPayload(
                client.sessionId(), userId, Instant.now(), heartbeatIntervalSeconds())));
        hub.register(client);
        log.info("websocket connected: user_id={} session_id={} connections={}",
                userId, client.sessionId(), hub.connections());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        WsClient client = clientOf(session);
        if (client == null) {
            return;
        }
        client.handleMessage(session, message.getPayload());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        WsClient client = clientOf(session);
        if (client == null) {
            return;
        }
        session.getAttributes().remove(CLIENT_ATTRIBUTE);
        hub.unregister(client);
        client.closeWithReason("connection closed");
        log.info("websocket disconnected: user_id={} session_id={} status={} connections={}",
                client.userId(), client.sessionId(), status, hub.connections());
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("websocket transport error: session_id={} reason={}", session.getId(), exception.toString());
        WsClient client = clientOf(session);
        if (client == null) {
            return;
        }
        hub.unregister(client);
        client.closeWithReason("transport error");
    }

    /**
     * Idle timeout нативного соединения (abv.ws.idle-timeout). Умолчание
     * контейнера (Tomcat) меньше прикладного heartbeat, поэтому выставляем
     * явно: клиент шлёт ping каждые abv.ws.heartbeat-interval, сервер терпит
     * до idle-timeout тишины.
     */
    private void applyIdleTimeout(WebSocketSession session) {
        if (!(session instanceof StandardWebSocketSession standard)) {
            return;
        }
        try {
            jakarta.websocket.Session nativeSession = standard.getNativeSession();
            if (nativeSession != null) {
                nativeSession.setMaxIdleTimeout(props.ws().idleTimeout().toMillis());
            }
        } catch (RuntimeException e) {
            log.debug("cannot set websocket idle timeout: session_id={} reason={}",
                    session.getId(), e.toString());
        }
    }

    /** Значение heartbeat_interval_seconds для hello (секунды из abv.ws). */
    private int heartbeatIntervalSeconds() {
        return (int) props.ws().heartbeatInterval().getSeconds();
    }

    private static UUID userIdOf(WebSocketSession session) {
        Object raw = session.getAttributes().get(Httpx.USER_ID_ATTRIBUTE);
        return raw instanceof UUID id ? id : null;
    }

    private static WsClient clientOf(WebSocketSession session) {
        Object raw = session.getAttributes().get(CLIENT_ATTRIBUTE);
        return raw instanceof WsClient client ? client : null;
    }
}
