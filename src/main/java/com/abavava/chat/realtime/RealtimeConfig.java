package com.abavava.chat.realtime;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.contract.UserLookup;
import com.abavava.chat.http.Httpx;
import com.abavava.chat.security.JwtService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

/**
 * Сборка WebSocket-транспорта: эндпоинт /api/v1/ws, лимиты кадров и фильтр
 * авторизации рукопожатия.
 *
 * <p>Проверка Origin выполняется в {@link WsAuthFilter} (правила общие с CORS),
 * поэтому на уровне реестра origin не ограничивается — иначе Spring отклонил бы
 * запрос раньше и клиент получил бы не REST-ошибку, а пустой 403.
 */
@Configuration
@EnableWebSocket
public class RealtimeConfig implements WebSocketConfigurer {

    static final String WS_PATH = "/api/v1/ws";

    /** Порядок фильтра: после rate limit (30) и до AccessTokenFilter (40). */
    static final int WS_AUTH_FILTER_ORDER = 35;

    private static final Logger log = LoggerFactory.getLogger(RealtimeConfig.class);

    private final WsEndpointHandler endpointHandler;
    private final JwtService jwtService;
    private final UserLookup users;
    private final AbvProperties props;

    public RealtimeConfig(WsEndpointHandler endpointHandler,
                          JwtService jwtService,
                          UserLookup users,
                          AbvProperties props) {
        this.endpointHandler = endpointHandler;
        this.jwtService = jwtService;
        this.users = users;
        this.props = props;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(endpointHandler, WS_PATH)
                .setAllowedOrigins("*")
                .addInterceptors(new UserHandshakeInterceptor(jwtService, users));
    }

    /**
     * Пределы буферов контейнера: abv.ws.max-frame-size на текстовый и бинарный
     * кадр. Без этого Tomcat режет большие кадры по умолчанию мельче ожидаемого
     * клиентами размера.
     */
    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        int maxFrameSize = props.ws().maxFrameSize();
        container.setMaxTextMessageBufferSize(maxFrameSize);
        container.setMaxBinaryMessageBufferSize(maxFrameSize);
        return container;
    }

    /**
     * Авторизация рукопожатия. Фильтр зарегистрирован только на /api/v1/ws:
     * остальные пути защищает AccessTokenFilter.
     */
    @Bean
    public FilterRegistrationBean<WsAuthFilter> wsAuthFilter(JwtService jwtService,
                                                            UserLookup users,
                                                            AbvProperties props,
                                                            ObjectMapper mapper) {
        FilterRegistrationBean<WsAuthFilter> bean =
                new FilterRegistrationBean<>(new WsAuthFilter(jwtService, users, props, mapper));
        bean.addUrlPatterns(WS_PATH);
        bean.setOrder(WS_AUTH_FILTER_ORDER);
        return bean;
    }

    /**
     * Повторная проверка токена на этапе рукопожатия: id пользователя попадает в
     * атрибуты сессии, откуда его читает {@link WsEndpointHandler}.
     *
     * <p>Токен берётся из query (браузерный WebSocket) с запасным вариантом —
     * заголовок Authorization (мобильные SDK). {@code false} — рукопожатие
     * отклоняется; штатные отказы с телом ошибки отдаёт {@link WsAuthFilter}.
     */
    static final class UserHandshakeInterceptor implements HandshakeInterceptor {

        private final JwtService jwtService;
        private final UserLookup users;

        UserHandshakeInterceptor(JwtService jwtService, UserLookup users) {
            this.jwtService = jwtService;
            this.users = users;
        }

        @Override
        public boolean beforeHandshake(ServerHttpRequest request,
                                       ServerHttpResponse response,
                                       WebSocketHandler wsHandler,
                                       Map<String, Object> attributes) {
            String token = tokenOf(request);
            if (token == null) {
                return false;
            }
            UUID userId;
            try {
                userId = jwtService.verifyAccessToken(token);
                users.byId(userId);
            } catch (RuntimeException e) {
                log.debug("websocket handshake rejected: reason={}", e.toString());
                return false;
            }
            attributes.put(Httpx.USER_ID_ATTRIBUTE, userId);
            return true;
        }

        @Override
        public void afterHandshake(ServerHttpRequest request,
                                   ServerHttpResponse response,
                                   WebSocketHandler wsHandler,
                                   Exception exception) {
            // Ничего: соединение уже проверено в beforeHandshake.
        }

        /** query-параметр token, иначе Bearer из заголовка. */
        private static String tokenOf(ServerHttpRequest request) {
            String queryToken = queryToken(request.getURI());
            if (queryToken != null) {
                return queryToken;
            }
            String header = request.getHeaders().getFirst("Authorization");
            if (header == null || header.isBlank()) {
                return null;
            }
            String[] parts = header.split(" ", 2);
            if (parts.length != 2 || !parts[0].equalsIgnoreCase("bearer")) {
                return null;
            }
            String token = parts[1].trim();
            return token.isEmpty() ? null : token;
        }

        private static String queryToken(URI uri) {
            String query = uri == null ? null : uri.getRawQuery();
            if (query == null || query.isBlank()) {
                return null;
            }
            for (String pair : query.split("&")) {
                if (pair.isEmpty()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                String name = eq >= 0 ? pair.substring(0, eq) : pair;
                if (!"token".equals(name)) {
                    continue;
                }
                String rawValue = eq >= 0 ? pair.substring(eq + 1) : "";
                String value;
                try {
                    value = URLDecoder.decode(rawValue, StandardCharsets.UTF_8).trim();
                } catch (IllegalArgumentException e) {
                    // Некорректная percent-кодировка: считаем, что токена нет.
                    return null;
                }
                return value.isEmpty() ? null : value;
            }
            return null;
        }
    }
}
