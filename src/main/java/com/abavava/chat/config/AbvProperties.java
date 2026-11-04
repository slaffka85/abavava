package com.abavava.chat.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Прикладная конфигурация приложения. Значения по умолчанию заданы в
 * application.yml (секция {@code abv:}); переменные окружения с префиксом ABV_
 * их переопределяют (relaxed binding: {@code ABV_HTTP_ADDR} → {@code abv.http-addr}).
 *
 * <p>Стандартные вещи Spring Boot (DataSource/Hikari, логирование, сервер)
 * настраиваются его собственными свойствами в application.yml — их здесь нет.
 *
 * <p>Если свойство не задано ни в yml, ни в окружении, приложение падает на
 * старте с BindException: скрытых дефолтов в коде нет.
 */
@ConfigurationProperties(prefix = "abv")
public record AbvProperties(
        String env,
        String httpAddr,
        String jwtSecret,
        Duration accessTtl,
        Duration refreshTtl,
        Duration callRingTimeout,
        String allowedOrigins,
        String logLevel,
        boolean migrateOnStart,
        boolean seed,
        int maxMessageLength,
        String stunUrls,
        String turnUrl,
        String turnUsername,
        String turnCredential,
        Migration migration,
        RateLimit authRateLimit,
        Cors cors,
        Ws ws,
        Chat chat
) {

    /** Ожидание доступности БД при старте. */
    public record Migration(int waitAttempts, Duration waitInterval) {
    }

    /** Скользящее окно для /api/v1/auth/*. */
    public record RateLimit(int limit, Duration window) {
    }

    /** CORS: Access-Control-Max-Age. */
    public record Cors(int maxAge) {
    }

    /** WebSocket-транспорт: пределы кадров, очередь и heartbeat. */
    public record Ws(
            int maxFrameSize,
            int maxSendBuffer,
            Duration heartbeatInterval,
            Duration idleTimeout) {
    }

    /** Ограничения групповых диалогов. */
    public record Chat(int maxGroupMembers, int maxTitleLength) {
    }

    public boolean isProduction() {
        return "production".equalsIgnoreCase(env.trim());
    }

    /** Порт из abv.http-addr (":8082", "0.0.0.0:8082" или "8082"). */
    public int serverPort() {
        String addr = httpAddr == null ? "" : httpAddr.trim();
        if (addr.isEmpty()) {
            return 8082;
        }
        int idx = addr.lastIndexOf(':');
        String port = idx >= 0 ? addr.substring(idx + 1) : addr;
        try {
            return Integer.parseInt(port);
        } catch (NumberFormatException e) {
            return 8082;
        }
    }

    public List<String> allowedOriginList() {
        return splitCsv(allowedOrigins);
    }

    public List<String> stunUrlList() {
        return splitCsv(stunUrls);
    }

    /** Та же проверка, что в config.Load(): дефолтный/короткий секрет ловим явно. */
    public void validate() {
        if (jwtSecret == null || jwtSecret.length() < 16) {
            throw new IllegalStateException("ABV_JWT_SECRET is too short (min 16 characters)");
        }
        if (isProduction()) {
            // Дефолтный секрет из application.yml (29 символов) не пройдёт эту
            // проверку: в продакшене нужен случайный минимум 32 символа.
            if (jwtSecret.length() < 32) {
                throw new IllegalStateException(
                        "ABV_JWT_SECRET must be set to a random value of at least 32 characters in production");
            }
            if (allowedOriginList().isEmpty()) {
                throw new IllegalStateException("ABV_ALLOWED_ORIGINS must be set in production");
            }
        }
        requirePositive("ACCESS_TTL", accessTtl);
        requirePositive("REFRESH_TTL", refreshTtl);
        requirePositive("CALL_RING_TIMEOUT", callRingTimeout);
        requirePositive("MAX_MESSAGE_LENGTH", maxMessageLength);

        requirePositive("MIGRATION_WAIT_ATTEMPTS", migration.waitAttempts());
        requireNonNegative("MIGRATION_WAIT_INTERVAL", migration.waitInterval());

        requirePositive("AUTH_RATE_LIMIT_LIMIT", authRateLimit.limit());
        requirePositive("AUTH_RATE_LIMIT_WINDOW", authRateLimit.window());

        requireNonNegative("CORS_MAX_AGE", cors.maxAge());

        requirePositive("WS_MAX_FRAME_SIZE", ws.maxFrameSize());
        requirePositive("WS_MAX_SEND_BUFFER", ws.maxSendBuffer());
        requirePositive("WS_HEARTBEAT_INTERVAL", ws.heartbeatInterval());
        requirePositive("WS_IDLE_TIMEOUT", ws.idleTimeout());

        requirePositive("CHAT_MAX_GROUP_MEMBERS", chat.maxGroupMembers() - 1L);
        requirePositive("CHAT_MAX_TITLE_LENGTH", chat.maxTitleLength());
    }

    private static void requirePositive(String name, long value) {
        if (value <= 0) {
            throw new IllegalStateException("ABV_" + name + " must be positive");
        }
    }

    private static void requirePositive(String name, Duration value) {
        if (value == null || value.isZero() || value.isNegative()) {
            throw new IllegalStateException("ABV_" + name + " must be positive");
        }
    }

    private static void requireNonNegative(String name, long value) {
        if (value < 0) {
            throw new IllegalStateException("ABV_" + name + " must be non-negative");
        }
    }

    private static void requireNonNegative(String name, Duration value) {
        if (value == null || value.isNegative()) {
            throw new IllegalStateException("ABV_" + name + " must be non-negative");
        }
    }

    private static List<String> splitCsv(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null) {
            return out;
        }
        for (String part : Arrays.asList(raw.split(","))) {
            String p = part.trim();
            if (!p.isEmpty()) {
                out.add(p);
            }
        }
        return out;
    }
}
